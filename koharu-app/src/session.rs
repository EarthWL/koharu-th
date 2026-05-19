//! `ProjectSession` — owner of the canonical in-memory `Scene` +
//! history + event bus for one open project.
//!
//! Phase 5.1 (this commit) ships the **type surface** — struct,
//! signatures, error type, public API shape. `apply` / `undo` /
//! `redo` bodies are `todo!()` placeholders to be filled in
//! Phase 5.2.
//!
//! The design intent (locked, see `docs/v2-arch.md` §6):
//!
//! - Every mutation goes through `apply(op)`. The bridge that
//!   currently writes to `Document` directly will be rewired in
//!   Phase 5.3 so engine-emitted Ops route through here first.
//! - `apply` computes the **inverse Op** from the current Scene
//!   state BEFORE mutating, stores `(op, inverse)` on the
//!   history entry, then runs the forward mutation. Undo replays
//!   the inverse against the now-mutated Scene; redo replays the
//!   forward op against the post-undo Scene.
//! - All ops emit `SessionEvent::OpsApplied { page, op_count }`
//!   so subscribers (autosave, frontend, etc.) can react.

use serde::Serialize;
use thiserror::Error;

use koharu_core::{Op, Scene};

use crate::event::{EventBus, SessionEvent};
use crate::history::{History, HistoryState};

/// Configuration knobs for [`ProjectSession`]. Sized so default
/// = production behaviour; tests override capacity to exercise
/// the ring buffer edges without burning 100 ops.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    /// History ring buffer capacity — 100 per locked decision.
    pub history_capacity: usize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            history_capacity: 100,
        }
    }
}

/// Things that can go wrong inside the session. Most apply paths
/// fail cleanly (engine emits a bad Op → apply returns Err →
/// driver surfaces in the ActivityBubble; history is unchanged
/// since we record AFTER successful mutation).
#[derive(Debug, Error)]
pub enum SessionError {
    /// `Op::UpdateTextBlock` / `RemoveTextBlock` targeted a node
    /// that doesn't exist on the page (caller bug — engine drift
    /// or stale id from a previous apply).
    #[error("node {0:?} not found on page {1:?}")]
    NodeNotFound(koharu_core::NodeId, koharu_core::PageId),

    /// Op targeted a page id that's not in the Scene.
    #[error("page {0:?} not found in scene")]
    PageNotFound(koharu_core::PageId),

    /// Nothing to undo — the undo stack is empty.
    #[error("nothing to undo")]
    NothingToUndo,

    /// Nothing to redo — the redo stack is empty (or was cleared
    /// by a new apply after the undo).
    #[error("nothing to redo")]
    NothingToRedo,

    /// Op variant not yet covered by `apply` / `compute_inverse`.
    /// Phase 5.2 will cover every variant; this exists so a
    /// future Op variant added without an apply arm fails loudly
    /// instead of silently no-op.
    #[error("op variant not yet implemented: {0}")]
    Unimplemented(&'static str),
}

/// The session — owner of `Scene`, `History`, and the broadcast
/// `EventBus`.
///
/// Constructed once per open project (or once per open chapter,
/// since the locked decision is per-chapter session — Phase 5.5
/// wires the autosave coordinator + per-chapter lifecycle).
///
/// `Scene` is `pub(crate)` for now — Phase 5.3 will expose
/// read-only accessors (`page(id)`, `pages_iter()`) instead of
/// raw access so external readers can't accidentally mutate
/// around the apply pipeline.
#[derive(Debug)]
pub struct ProjectSession {
    scene: Scene,
    history: History,
    bus: EventBus,
    config: SessionConfig,
}

impl ProjectSession {
    /// Start a fresh session over the given Scene. Common case:
    /// chapter open → build Scene from disk → wrap in
    /// ProjectSession.
    pub fn new(scene: Scene, config: SessionConfig) -> Self {
        Self {
            scene,
            history: History::new(config.history_capacity),
            bus: EventBus::new(),
            config,
        }
    }

    /// Read-only access to the current Scene. Phase 5.3 will
    /// migrate the bridge + engines to use this instead of a
    /// separately-owned Scene reference.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Subscribe to session events. Caller owns the returned
    /// receiver; dropping it unsubscribes.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<SessionEvent> {
        self.bus.subscribe()
    }

    /// Snapshot of history state — for the frontend toolbar
    /// (undo/redo enabled flags + op count badge).
    pub fn history_state(&self) -> HistoryState {
        self.history.state()
    }

    /// Apply one `Op` (or a `Batch` of Ops). Phase 5.2 fills the
    /// body:
    ///
    /// 1. Compute inverse Op from current Scene.
    /// 2. Mutate Scene.
    /// 3. Push `HistoryEntry { op, inverse }` onto undo stack
    ///    (clears redo).
    /// 4. Emit `SessionEvent::OpsApplied` on the bus.
    ///
    /// Returns `Err` (without touching history) when the Op
    /// targets a missing page/node — caller surfaces the error.
    pub fn apply(&mut self, _op: Op) -> Result<(), SessionError> {
        todo!("Phase 5.2 — apply + inverse computation")
    }

    /// Undo the most recent applied Op. Phase 5.2 fills the body:
    ///
    /// 1. Pop the top history entry.
    /// 2. Apply `entry.inverse` to the Scene (using the same
    ///    internal mutation path as `apply`, but WITHOUT pushing
    ///    a new history entry — we're walking the stack, not
    ///    branching).
    /// 3. Push the popped entry onto the redo stack.
    /// 4. Emit `SessionEvent::OpsUndone`.
    pub fn undo(&mut self) -> Result<(), SessionError> {
        todo!("Phase 5.2 — undo")
    }

    /// Redo the most recently undone Op. Mirror of `undo` —
    /// applies `entry.op` then pushes back onto undo via
    /// `History::push_replay` (which preserves the redo stack
    /// below this one, in case the user redoes multiple steps).
    pub fn redo(&mut self) -> Result<(), SessionError> {
        todo!("Phase 5.2 — redo")
    }

    /// Wipe history — used on chapter close (per-chapter session
    /// means undo doesn't survive chapter switches).
    pub fn clear_history(&mut self) {
        self.history.clear();
        self.bus.emit(SessionEvent::HistoryCleared);
    }

    /// Expose the configured cap for tests + future tuning.
    pub fn config(&self) -> SessionConfig {
        self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_core::Scene;

    #[test]
    fn new_session_starts_with_empty_history() {
        let session = ProjectSession::new(Scene::default(), SessionConfig::default());
        let state = session.history_state();
        assert_eq!(state.undo_len, 0);
        assert_eq!(state.redo_len, 0);
        assert_eq!(state.capacity, 100);
    }

    #[test]
    fn config_drives_capacity() {
        let session = ProjectSession::new(
            Scene::default(),
            SessionConfig {
                history_capacity: 3,
            },
        );
        assert_eq!(session.history_state().capacity, 3);
    }

    #[test]
    fn clear_history_emits_event() {
        let session = ProjectSession::new(Scene::default(), SessionConfig::default());
        let mut rx = session.subscribe();
        // Apply some history first… wait, apply is todo!() until
        // 5.2. For 5.1, just exercise clear_history directly.
        let mut session = session; // mut binding
        session.clear_history();
        match rx.try_recv() {
            Ok(SessionEvent::HistoryCleared) => {}
            other => panic!("expected HistoryCleared, got {other:?}"),
        }
    }
}
