//! Session event bus.
//!
//! Thin wrapper around `tokio::sync::broadcast` chosen per the
//! locked decision in docs/v2-arch.md §2 (matches the Tauri
//! ecosystem; multi-producer multi-consumer; lossy on slow
//! subscribers — slow subscribers `recv` get `Lagged(n)` and can
//! recover by re-syncing rather than blocking the producer).
//!
//! Subscribers:
//!
//! - **Autosave coordinator** (Phase 5.5) listens for
//!   [`SessionEvent::DirtyMarked`] + debounces ~2s before writing
//!   a Document snapshot to SQLite.
//! - **Frontend** (Phase 5.4) subscribes via an RPC notification
//!   bridge that forwards selected events over the WebSocket so
//!   the UI knows when to invalidate React Query caches /
//!   re-render the canvas / update the undo button enabled state.
//! - **Future ML cache invalidation** (Phase 6+) — when text
//!   blocks change, cached LLM completions for that block become
//!   stale; the cost-dashboard refresh also rides this bus.

use serde::Serialize;
use tokio::sync::broadcast;

use koharu_core::PageId;

/// Channel capacity — how many events the broadcaster buffers
/// before slow subscribers start seeing `Lagged`. Tuned for the
/// typical "a stroke is 30-50 brush patches in quick succession +
/// each is one Op" worst case. Subscribers that fall behind
/// receive `RecvError::Lagged(N)` from `recv` and should re-sync
/// (refetch state) rather than try to replay missed events.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Events the session emits. `Serialize` derived so the RPC bridge
/// can forward to the frontend without an extra projection layer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    /// One or more Ops were applied to the current page. Carries
    /// the affected page id so subscribers can scope their work —
    /// e.g. the frontend only invalidates the page that changed,
    /// not the whole project.
    ///
    /// `op_count` is included in lieu of the Ops themselves to
    /// keep the broadcast cheap. Subscribers that need the
    /// detailed Op list re-read it from `ProjectSession::history`
    /// or refetch the page state.
    OpsApplied { page: PageId, op_count: usize },

    /// An undo finished; same payload shape as `OpsApplied`.
    /// Frontend toolbar updates its undo-enabled state via
    /// `HistoryState` after this fires.
    OpsUndone { page: PageId, op_count: usize },

    /// A redo finished.
    OpsRedone { page: PageId, op_count: usize },

    /// The session has unsaved changes since the last autosave.
    /// Autosave coordinator listens for this event + debounces
    /// before writing. Frontend can show a "* unsaved" indicator.
    DirtyMarked,

    /// Autosave coordinator finished writing the dirty state to
    /// disk. Resets the "* unsaved" indicator on the frontend.
    Saved,

    /// History was wiped (e.g. on chapter close). Toolbar should
    /// disable undo/redo until the next apply.
    HistoryCleared,
}

impl SessionEvent {
    /// True if this event should bump the "dirty" flag — the
    /// autosave coordinator uses this to know which events to
    /// react to.
    pub fn dirties_state(&self) -> bool {
        matches!(self, SessionEvent::OpsApplied { .. })
    }
}

/// Owned bus handle. The session keeps the `Sender`; subscribers
/// hold `Receiver`s they got from [`EventBus::subscribe`].
#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<SessionEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _initial_receiver) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        // The "initial receiver" is dropped here on purpose —
        // `broadcast::channel` keeps the channel open as long as
        // the sender lives, even with zero receivers. Subsequent
        // `subscribe()` calls produce fresh receivers that see
        // events from the moment they subscribe.
        Self { sender }
    }

    /// Subscribe — call once per consumer task. Each subscriber
    /// sees events sent AFTER it subscribes; events sent while no
    /// subscriber exists are silently dropped (no buffering for
    /// late-bound subscribers, by design).
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.sender.subscribe()
    }

    /// Send an event. Errors only when there are no active
    /// receivers — that's a benign "no one is listening" state,
    /// not a hard failure, so we swallow + log at trace level.
    pub fn emit(&self, event: SessionEvent) {
        match self.sender.send(event) {
            Ok(_n_recv) => {}
            Err(broadcast::error::SendError(dropped)) => {
                tracing::trace!(?dropped, "event dropped; no subscribers");
            }
        }
    }

    /// Number of active subscribers — useful for the future
    /// "is autosave wired up?" debug toolbar.
    pub fn receiver_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribe_receives_emitted_event() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.emit(SessionEvent::DirtyMarked);
        let event = rx.recv().await.unwrap();
        assert!(matches!(event, SessionEvent::DirtyMarked));
    }

    #[tokio::test]
    async fn emit_without_subscribers_is_silent() {
        let bus = EventBus::new();
        // No subscribe()-d receivers. emit() must not panic or
        // block — slow-path subscribers shouldn't be a precondition
        // for the session to apply ops.
        bus.emit(SessionEvent::DirtyMarked);
        bus.emit(SessionEvent::Saved);
        // Subscribe AFTER emits — that subscriber sees nothing.
        let mut rx = bus.subscribe();
        // Race-free check: try_recv returns Empty when nothing is
        // queued.
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn dirties_state_only_for_ops_applied() {
        assert!(SessionEvent::OpsApplied {
            page: koharu_core::PageId(1),
            op_count: 1
        }
        .dirties_state());
        assert!(!SessionEvent::OpsUndone {
            page: koharu_core::PageId(1),
            op_count: 1
        }
        .dirties_state());
        assert!(!SessionEvent::DirtyMarked.dirties_state());
        assert!(!SessionEvent::Saved.dirties_state());
        assert!(!SessionEvent::HistoryCleared.dirties_state());
    }

    #[tokio::test]
    async fn receiver_count_tracks_subscribers() {
        let bus = EventBus::new();
        assert_eq!(bus.receiver_count(), 0);
        let _rx1 = bus.subscribe();
        assert_eq!(bus.receiver_count(), 1);
        let _rx2 = bus.subscribe();
        assert_eq!(bus.receiver_count(), 2);
        drop(_rx1);
        assert_eq!(bus.receiver_count(), 1);
    }

}
