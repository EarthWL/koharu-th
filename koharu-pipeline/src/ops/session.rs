//! RPC ops for the v2 undo/redo surface (Phase 5.4).
//!
//! Wraps `ProjectSession::{undo, redo}` with the bridge work to
//! mirror the inverse/forward Op onto the legacy `Document` so RPC
//! reads stay consistent. Also exposes the history state for the
//! toolbar's enabled/disabled flags + dev-mode op count badge.
//!
//! ## Open-session precondition
//!
//! `engine_bridge` lazy-initialises the session on the first engine
//! run. Until then, all four ops here return a "no session yet"
//! error — the toolbar surfaces that as disabled buttons. Phase
//! 5.5 will pre-init the session on chapter open so the user can
//! undo from the first click.

use anyhow::{Result, anyhow};
use koharu_app::HistoryState;
use serde::Deserialize;
use tracing::instrument;

use crate::{AppResources, engine_bridge, state_tx};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMutationPayload {
    /// Document index to mirror the inverse/forward Op against.
    /// The session is currently single-slot (Phase 5.3); when
    /// Phase 5.5 lands per-chapter sessions this stays the same
    /// — the chapter-active doc index.
    pub index: usize,
}

/// Pop the most recent applied op from the session's history and
/// reverse it. Returns the resulting [`HistoryState`] so the
/// frontend toolbar's React Query cache can update without a
/// separate `session_history_state` refetch.
#[instrument(level = "info", skip_all)]
pub async fn session_undo(
    state: AppResources,
    payload: SessionMutationPayload,
) -> Result<HistoryState> {
    // Acquire the session lock + perform the Scene-side undo. The
    // session returns the inverse Op that was applied so we can
    // mirror it onto the legacy Document outside the lock.
    let inverse_op = {
        let mut guard = state.session.write().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| anyhow!("no session — open a chapter + run an engine first"))?;
        session.undo()?
    };

    // Mirror onto Document so RPC reads (DocumentDto, MCP image
    // tools, etc.) see the post-undo state. Errors here mean the
    // doc is out of sync with the session — log + surface but
    // don't try to roll back the session (the session is correct;
    // the doc just lags).
    let mut doc = state_tx::read_doc(&state.state, payload.index).await?;
    if let Err(e) = engine_bridge::apply_op(&mut doc, inverse_op, &state.blobs) {
        tracing::warn!(
            error = ?e,
            "mirroring undo to Document failed — RPC reads may show stale state until next refetch"
        );
    } else {
        state_tx::update_doc(&state.state, payload.index, doc).await?;
    }

    // Return the new history state for the toolbar.
    let guard = state.session.read().await;
    Ok(guard
        .as_ref()
        .map(|s| s.history_state())
        .unwrap_or(HistoryState {
            undo_len: 0,
            redo_len: 0,
            capacity: 0,
        }))
}

/// Mirror of [`session_undo`]: pop from the redo stack + re-apply
/// the forward Op.
#[instrument(level = "info", skip_all)]
pub async fn session_redo(
    state: AppResources,
    payload: SessionMutationPayload,
) -> Result<HistoryState> {
    let forward_op = {
        let mut guard = state.session.write().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| anyhow!("no session — open a chapter + run an engine first"))?;
        session.redo()?
    };

    let mut doc = state_tx::read_doc(&state.state, payload.index).await?;
    if let Err(e) = engine_bridge::apply_op(&mut doc, forward_op, &state.blobs) {
        tracing::warn!(
            error = ?e,
            "mirroring redo to Document failed — RPC reads may show stale state until next refetch"
        );
    } else {
        state_tx::update_doc(&state.state, payload.index, doc).await?;
    }

    let guard = state.session.read().await;
    Ok(guard
        .as_ref()
        .map(|s| s.history_state())
        .unwrap_or(HistoryState {
            undo_len: 0,
            redo_len: 0,
            capacity: 0,
        }))
}

/// Read-only snapshot of the session's history pointers — used
/// by the frontend toolbar on mount + on `OpsApplied` event to
/// keep undo/redo button enabled-states + the dev op-count badge
/// in sync.
///
/// Returns a "no session" baseline (all zeros, capacity 0) when
/// the session hasn't been created yet — the toolbar shows the
/// buttons disabled in that state, which is correct.
pub async fn session_history_state(state: AppResources) -> Result<HistoryState> {
    let guard = state.session.read().await;
    Ok(guard
        .as_ref()
        .map(|s| s.history_state())
        .unwrap_or(HistoryState {
            undo_len: 0,
            redo_len: 0,
            capacity: 0,
        }))
}
