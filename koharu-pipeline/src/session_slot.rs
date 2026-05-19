//! `SessionSlot` — holder for `ProjectSession` + the doc_index it
//! was initialised against.
//!
//! Phase 5.3 stored the session as a bare `Option<ProjectSession>`
//! in `AppResources`. Audit #7/P1 flagged that the session has no
//! awareness of which document its `Scene` reflects: when the
//! user switches docs (within a chapter), the bridge keeps using
//! the stale session.scene, producing two bugs:
//!
//! 1. `apply` against scene-derived state silently mis-targets
//!    (NodeAlreadyExists from blocks that belong to the *other*
//!    doc; inverse computation pulls "prior values" from the
//!    wrong scene).
//! 2. undo/redo on the new doc mirrors ops to `payload.index`
//!    (the new doc) but the inverse was computed against the old
//!    doc's scene — wrong rollback applied.
//!
//! Fix: gate session reuse on a `doc_index` match. The bridge
//! resets the session when the incoming doc differs (or when
//! `RunPolicy::clear_text_blocks_first` is set — same pragmatic
//! reset point, since a re-detect is a destructive boundary
//! after which prior undo no longer makes semantic sense).
//!
//! Both fields share one `RwLock<SessionSlot>` so the `session`/
//! `doc_index` invariant (Some/Some or None/None) can't drift.

use koharu_app::{ProjectSession, SessionConfig};
use koharu_core::Scene;

#[derive(Debug, Default)]
pub struct SessionSlot {
    inner: Option<SessionInner>,
}

#[derive(Debug)]
struct SessionInner {
    session: ProjectSession,
    /// Document index in `AppResources.state.documents` this
    /// session was built against. Engine_bridge compares before
    /// reusing the session; ops::session::undo/redo asserts the
    /// match to refuse cross-doc undo (which would mirror the
    /// inverse op onto the wrong Document).
    doc_index: usize,
}

impl SessionSlot {
    pub fn new() -> Self {
        Self { inner: None }
    }

    /// True if there's an active session at all (regardless of
    /// doc_index). Used for diagnostics + "history available?"
    /// checks where the caller doesn't know the target doc yet.
    pub fn is_active(&self) -> bool {
        self.inner.is_some()
    }

    /// Borrow the session iff it was built for `doc_index`.
    /// Returns `None` if no session OR session was built for a
    /// different doc — caller must initialise via [`reset_with`]
    /// before applying ops to keep `Scene` and `Document` in sync.
    pub fn session_for(&mut self, doc_index: usize) -> Option<&mut ProjectSession> {
        match self.inner.as_mut() {
            Some(inner) if inner.doc_index == doc_index => Some(&mut inner.session),
            _ => None,
        }
    }

    /// Read-only session access (used by `session_history_state`
    /// RPC, doesn't need doc_index match because the caller
    /// already accepts a stale-relative-to-active-doc snapshot
    /// — the UI just shows the disabled state when len == 0).
    pub fn session_ref(&self) -> Option<&ProjectSession> {
        self.inner.as_ref().map(|i| &i.session)
    }

    /// Mutable session access keyed by doc, for the undo/redo
    /// ops. Returns `None` when the session doesn't exist OR was
    /// built for a different doc. The latter case is the audit
    /// #7/P1 fix: undo against doc 1 must NOT mirror an inverse
    /// from a session that was built for doc 0.
    pub fn session_for_mut(&mut self, doc_index: usize) -> Option<&mut ProjectSession> {
        self.session_for(doc_index)
    }

    /// Build a fresh session from `initial_scene` and tag it
    /// with `doc_index`. Replaces any prior session — caller
    /// already decided to reset (mismatched doc, replace policy,
    /// chapter switch, etc.).
    pub fn reset_with(&mut self, initial_scene: Scene, doc_index: usize) {
        self.inner = Some(SessionInner {
            session: ProjectSession::new(initial_scene, SessionConfig::default()),
            doc_index,
        });
    }

    /// Drop the session entirely. Used by chapter_open +
    /// project_close (locked decision: per-chapter session).
    pub fn clear(&mut self) {
        self.inner = None;
    }

    /// Drop the session iff it was built for `doc_index`. Audit
    /// #9/B1 root-cause fix: manual structural edits (UI add /
    /// remove / bulk-replace text blocks) bypass session.apply, so
    /// session.scene's NodeId↔array mapping drifts from Document.
    /// Invalidating here forces the bridge's next engine run to
    /// rebuild the session from the freshly-mutated Document via
    /// `reset_with`, preventing the silent-skip undo bug.
    ///
    /// Content-only edits (translation text, font, etc.) preserve
    /// the mapping so they should NOT call this — undo through
    /// those is still useful and the bridge tolerates "scene region
    /// is slightly stale relative to doc" as a soft drift.
    ///
    /// No-op when the active session is for a different doc — we
    /// don't want a manual edit on doc 2 to wipe history for doc 1.
    pub fn invalidate_if_doc(&mut self, doc_index: usize) {
        if self.active_doc_index() == Some(doc_index) {
            self.inner = None;
        }
    }

    /// The doc_index the session is currently built against,
    /// for diagnostics + tests.
    pub fn active_doc_index(&self) -> Option<usize> {
        self.inner.as_ref().map(|i| i.doc_index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_core::Scene;

    #[test]
    fn empty_slot_has_no_session() {
        let mut slot = SessionSlot::new();
        assert!(!slot.is_active());
        assert!(slot.session_for(0).is_none());
        assert!(slot.session_for_mut(0).is_none());
        assert!(slot.session_ref().is_none());
        assert_eq!(slot.active_doc_index(), None);
    }

    #[test]
    fn reset_with_tags_doc_index() {
        let mut slot = SessionSlot::new();
        slot.reset_with(Scene::default(), 7);
        assert!(slot.is_active());
        assert_eq!(slot.active_doc_index(), Some(7));
        assert!(slot.session_for(7).is_some(), "matching index returns session");
    }

    #[test]
    fn session_for_returns_none_on_doc_index_mismatch() {
        let mut slot = SessionSlot::new();
        slot.reset_with(Scene::default(), 0);
        // Doc 1 sees no session even though one exists — caller
        // must reset_with before applying ops.
        assert!(slot.session_for(1).is_none());
        // Doc 0 (the one it was built for) still gets it.
        assert!(slot.session_for(0).is_some());
    }

    #[test]
    fn clear_drops_session_and_index() {
        let mut slot = SessionSlot::new();
        slot.reset_with(Scene::default(), 3);
        slot.clear();
        assert!(!slot.is_active());
        assert_eq!(slot.active_doc_index(), None);
    }

    #[test]
    fn reset_with_replaces_prior_session() {
        let mut slot = SessionSlot::new();
        slot.reset_with(Scene::default(), 0);
        slot.reset_with(Scene::default(), 5);
        // Old doc's session is gone, new doc's is in.
        assert!(slot.session_for(0).is_none());
        assert!(slot.session_for(5).is_some());
    }

    #[test]
    fn invalidate_if_doc_drops_active_session() {
        let mut slot = SessionSlot::new();
        slot.reset_with(Scene::default(), 3);
        assert!(slot.is_active());
        slot.invalidate_if_doc(3);
        assert!(!slot.is_active(), "manual edit on doc 3 invalidates");
    }

    #[test]
    fn invalidate_if_doc_preserves_other_doc_session() {
        let mut slot = SessionSlot::new();
        slot.reset_with(Scene::default(), 1);
        // User edits doc 2 (different doc). Session for doc 1
        // should survive — undo on doc 1 should still work.
        slot.invalidate_if_doc(2);
        assert!(slot.is_active());
        assert_eq!(slot.active_doc_index(), Some(1));
    }

    #[test]
    fn invalidate_if_doc_on_empty_slot_is_noop() {
        let mut slot = SessionSlot::new();
        slot.invalidate_if_doc(0);
        assert!(!slot.is_active());
    }
}
