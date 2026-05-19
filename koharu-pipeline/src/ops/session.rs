//! RPC ops for the v2 undo/redo surface (Phase 5.4 + audit #7).
//!
//! Wraps `ProjectSession::{undo, redo}` with the bridge work to
//! mirror the inverse/forward Op onto the legacy `Document` so RPC
//! reads stay consistent. Also exposes the history state for the
//! toolbar's enabled/disabled flags + dev-mode op count badge.
//!
//! ## Open-session precondition
//!
//! `engine_bridge` lazy-initialises the session on the first engine
//! run, tagged with the doc_index it was built against. The
//! `session_undo`/`session_redo` ops here REQUIRE the session was
//! built for the requested `payload.index` (audit #7/P1 — cross-
//! doc undo would mirror the inverse op onto the wrong Document).
//! "No matching session" returns a clean error → toolbar shows
//! disabled buttons.

use anyhow::{Result, anyhow};
use koharu_app::HistoryState;
use serde::Deserialize;
use tracing::instrument;

use crate::{AppResources, engine_bridge, state_tx};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMutationPayload {
    /// Document index to mirror the inverse/forward Op against.
    /// Must match the doc_index the session was built for —
    /// `SessionSlot::session_for_mut` enforces this; we surface
    /// the mismatch as a clean error rather than silently
    /// applying the inverse to the wrong document.
    pub index: usize,
}

const EMPTY_HISTORY: HistoryState = HistoryState {
    undo_len: 0,
    redo_len: 0,
    capacity: 0,
};

/// Pop the most recent applied op from the session's history and
/// reverse it. Returns the resulting [`HistoryState`] so the
/// frontend toolbar's React Query cache can update without a
/// separate `session_history_state` refetch.
#[instrument(level = "info", skip_all)]
pub async fn session_undo(
    state: AppResources,
    payload: SessionMutationPayload,
) -> Result<HistoryState> {
    let inverse_op = {
        let mut guard = state.session.write().await;
        let session = guard.session_for_mut(payload.index).ok_or_else(|| {
            anyhow!(
                "no session for document {} — open the document + run an engine first \
                 (session may have been built for a different document)",
                payload.index,
            )
        })?;
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

    Ok(read_history_state(&state).await)
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
        let session = guard.session_for_mut(payload.index).ok_or_else(|| {
            anyhow!(
                "no session for document {} — open the document + run an engine first",
                payload.index,
            )
        })?;
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

    Ok(read_history_state(&state).await)
}

/// Read-only snapshot of the session's history pointers — used
/// by the frontend toolbar on mount + after engine mutation
/// invalidations to keep undo/redo button enabled-states + the
/// dev op-count badge in sync.
///
/// Returns the EMPTY_HISTORY baseline when the session hasn't
/// been created yet — the toolbar shows the buttons disabled in
/// that state, which is correct. This op doesn't take a
/// doc_index because the toolbar polls it before knowing which
/// doc will be the next mutation target; if the session is for
/// a different doc than the user's currently-viewed doc, the
/// `undo` button STILL shows the count of the doc the session
/// is for (the user will see it disabled after switching docs
/// via the per-doc session_for_mut guard in `session_undo`).
pub async fn session_history_state(state: AppResources) -> Result<HistoryState> {
    Ok(read_history_state(&state).await)
}

async fn read_history_state(state: &AppResources) -> HistoryState {
    let guard = state.session.read().await;
    guard
        .session_ref()
        .map(|s| s.history_state())
        .unwrap_or(EMPTY_HISTORY)
}
