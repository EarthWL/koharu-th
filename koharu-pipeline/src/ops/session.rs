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
use koharu_app::{HistoryState, RecentHistory};
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
            // Audit #9/B1 root: structural manual edits (add/remove
            // text block, bulk replace) invalidate the session. If
            // the user's frontend cache is stale, they may still
            // see the Undo button enabled when the session is
            // actually gone — surface a message that explains the
            // root cause + how to recover, instead of the
            // misleading "open the document" phrasing.
            anyhow!(
                "Undo history cleared by a manual edit (add/remove/replace text \
                 block, or a different document was loaded). Run detect / OCR / \
                 translate / render again to start fresh history."
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
    let mirror_outcome = engine_bridge::apply_op(&mut doc, inverse_op, &state.blobs);
    match mirror_outcome {
        Ok(engine_bridge::ApplyOutcome::Clean) => {
            state_tx::update_doc(&state.state, payload.index, doc).await?;
        }
        Ok(engine_bridge::ApplyOutcome::DriftSkipped) => {
            // Audit #9/B1 surface: session pop succeeded (so the
            // session's redo stack now has the entry — user could
            // redo to recover), but the Document mirror skipped at
            // least one op because session.scene drifted from
            // Document via a non-engine mutation. Write back what
            // partial state did land so RPC reads reflect any ops
            // that DID succeed, then surface as Err so the frontend
            // toasts the drift instead of silently no-op'ing.
            state_tx::update_doc(&state.state, payload.index, doc).await?;
            anyhow::bail!(
                "Undo applied to history but Document state is out of sync \
                 (some blocks may have been deleted outside undo/redo). \
                 Try refreshing the page; if it persists, re-run detect."
            );
        }
        Err(e) => {
            tracing::warn!(
                error = ?e,
                "mirroring undo to Document failed — RPC reads may show stale state until next refetch"
            );
        }
    }

    Ok(read_history_state_for(&state, payload.index).await)
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
                "Redo history cleared by a manual edit (add/remove/replace text \
                 block, or a different document was loaded). Run detect / OCR / \
                 translate / render again to start fresh history."
            )
        })?;
        session.redo()?
    };

    let mut doc = state_tx::read_doc(&state.state, payload.index).await?;
    let mirror_outcome = engine_bridge::apply_op(&mut doc, forward_op, &state.blobs);
    match mirror_outcome {
        Ok(engine_bridge::ApplyOutcome::Clean) => {
            state_tx::update_doc(&state.state, payload.index, doc).await?;
        }
        Ok(engine_bridge::ApplyOutcome::DriftSkipped) => {
            state_tx::update_doc(&state.state, payload.index, doc).await?;
            anyhow::bail!(
                "Redo applied to history but Document state is out of sync \
                 (some blocks may have been modified outside undo/redo). \
                 Try refreshing the page; if it persists, re-run detect."
            );
        }
        Err(e) => {
            tracing::warn!(
                error = ?e,
                "mirroring redo to Document failed — RPC reads may show stale state until next refetch"
            );
        }
    }

    Ok(read_history_state_for(&state, payload.index).await)
}

/// Read-only snapshot of the session's history pointers — used
/// by the frontend toolbar on mount + after engine mutation
/// invalidations to keep undo/redo button enabled-states + the
/// dev op-count badge in sync.
///
/// Audit #8/P3: the request carries the doc_index the caller is
/// asking about. If the session was built for a DIFFERENT doc,
/// return the empty baseline so the toolbar shows the buttons
/// disabled rather than enabled-then-error-on-click. Pre-audit
/// this op didn't take an index and the toolbar polled it
/// before knowing which doc would be the next mutation target —
/// turning the doc switch into a confusing "click → error" UX.
pub async fn session_history_state(
    state: AppResources,
    payload: SessionMutationPayload,
) -> Result<HistoryState> {
    Ok(read_history_state_for(&state, payload.index).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryRecentPayload {
    /// Document index — only returns data when this matches the
    /// session's active doc (same audit #8/P3 gate as
    /// `session_history_state`).
    pub index: usize,
    /// Cap on entries per stack. Frontend popover defaults to 10.
    pub limit: usize,
}

/// Recent op summaries for the History popover. Mostly self-test
/// polish — lets the user verify "ops I see in the popover match
/// what I just did" without checking the dev op-count badge.
pub async fn session_history_recent(
    state: AppResources,
    payload: SessionHistoryRecentPayload,
) -> Result<RecentHistory> {
    let guard = state.session.read().await;
    if guard.active_doc_index() != Some(payload.index) {
        return Ok(RecentHistory {
            undo: vec![],
            redo: vec![],
        });
    }
    Ok(guard
        .session_ref()
        .map(|s| s.recent_history(payload.limit))
        .unwrap_or(RecentHistory {
            undo: vec![],
            redo: vec![],
        }))
}

/// Internal helper for session_undo / session_redo: read history
/// state for the doc the mutation just ran against. The mutation
/// path has already confirmed the session is for `doc_index` via
/// `session_for_mut`, so the doc_index gate here is essentially a
/// noop — but routing both reads through the same helper keeps
/// undo/redo agreeing with `session_history_state` on the policy
/// (audit #8/P3: history is per-doc, mismatched → empty).
async fn read_history_state_for(state: &AppResources, doc_index: usize) -> HistoryState {
    let guard = state.session.read().await;
    if guard.active_doc_index() != Some(doc_index) {
        return EMPTY_HISTORY;
    }
    guard
        .session_ref()
        .map(|s| s.history_state())
        .unwrap_or(EMPTY_HISTORY)
}
