//! koharu-app — `ProjectSession` substrate for the v2 architecture
//! refactor (Phase 5).
//!
//! Owns the canonical in-memory `Scene` for an open project,
//! applies `Op`s + records their inverses so the user can undo,
//! and broadcasts `SessionEvent`s so subscribers (autosave,
//! frontend re-render, ML cache invalidation) can react without
//! polling.
//!
//! See `docs/v2-arch.md` §6 (on `main`) for the locked design:
//!
//! - **Linear history** — no CRDT.
//! - **Per-chapter session** with an in-memory ring buffer cap'd
//!   at ~100 ops. The cap is a `SessionConfig` field so future
//!   tests + memory-pressure work can tune it.
//! - **Inline-inverse computation** — every `apply` computes the
//!   inverse `Op` from the current `Scene` state BEFORE mutating,
//!   and pushes both onto the history entry. No `OpInverse` trait
//!   (dropped in re-review issue A — broken for `Op::Batch`).
//!
//! ## Module map
//!
//! - [`session`] — `ProjectSession` struct + `apply`/`undo`/`redo`
//!   public API. Phase 5.1 ships type-level signatures with
//!   `todo!()` bodies; Phase 5.2 fills in apply + inverse
//!   computation for every `Op` variant.
//! - [`history`] — `History` ring buffer + `HistoryEntry { op,
//!   inverse }` pairs + undo/redo cursor.
//! - [`event`] — `SessionEvent` enum + `EventBus` wrapper around
//!   `tokio::sync::broadcast`. Frontend subscribes via an RPC
//!   notification stream; autosave coordinator subscribes in-
//!   process.
//!
//! ## Scope of Phase 5.1
//!
//! This commit ships the **scaffold only** — types + signatures +
//! the bus wire. No engine_bridge wiring yet (Phase 5.3), no
//! frontend shortcuts (Phase 5.4), no autosave (Phase 5.5).
//! Apply/undo/redo bodies are `todo!()`. Phase 5.2 fills them in
//! once the type surface settles.

pub mod event;
pub mod history;
pub mod session;

pub use event::{EventBus, SessionEvent};
pub use history::{History, HistoryEntry, HistoryEntrySummary, HistoryState, RecentHistory};
pub use session::{ProjectSession, SessionConfig, SessionError};
