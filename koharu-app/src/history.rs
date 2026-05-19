//! History ring buffer for the `ProjectSession`.
//!
//! Two stacks under one cap: an undo stack of applied entries +
//! a redo stack that grows when the user hits undo. Standard
//! "every new apply clears redo" semantics.
//!
//! Cap is enforced by dropping the oldest UNDO entry when a new
//! one would exceed it — by intent, dropping the oldest is
//! preferable to dropping the newest because the user almost
//! always wants to undo what they just did, not what they did 99
//! ops ago. Tests cover the cap behaviour explicitly.

use koharu_core::Op;
use serde::Serialize;

/// One entry on the undo/redo stack: the `op` that was applied +
/// the `inverse` that would undo it (computed at apply time
/// against the pre-apply Scene state).
///
/// Both fields are `Op`s. The inverse for `AddTextBlock` is a
/// `RemoveTextBlock`; for `UpdateTextBlock` it's another
/// `UpdateTextBlock` carrying the prior field values; for
/// `SetSegmentationMask(_, Some(new))` it's
/// `SetSegmentationMask(_, prior)`. `Op::Batch` recurses: the
/// inverse is `Op::Batch` of reversed inverses.
#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub op: Op,
    pub inverse: Op,
}

/// Snapshot of history state for the frontend toolbar (undo/redo
/// enabled flags, op count badge in dev mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub undo_len: usize,
    pub redo_len: usize,
    pub capacity: usize,
}

/// The history ring buffer.
///
/// Bounded by `capacity`. New applies drop the oldest undo entry
/// when full. Pushing to undo clears redo (standard semantic).
#[derive(Debug)]
pub struct History {
    undo: std::collections::VecDeque<HistoryEntry>,
    redo: std::collections::VecDeque<HistoryEntry>,
    capacity: usize,
}

impl History {
    /// New empty history with the requested cap.
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            undo: std::collections::VecDeque::with_capacity(capacity),
            redo: std::collections::VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    /// Push a new entry on undo, clear redo. Drops the oldest undo
    /// entry if at cap.
    pub fn push(&mut self, entry: HistoryEntry) {
        if self.undo.len() >= self.capacity {
            self.undo.pop_front();
        }
        self.undo.push_back(entry);
        self.redo.clear();
    }

    /// Pop the most-recent undo entry. Returns `None` if there's
    /// nothing to undo. Caller is responsible for applying the
    /// `entry.inverse` to the Scene before calling
    /// [`push_redo`].
    pub fn pop_undo(&mut self) -> Option<HistoryEntry> {
        self.undo.pop_back()
    }

    /// Push an entry onto the redo stack after the caller has
    /// applied the inverse to the Scene. The redo stack is also
    /// bounded — when capped, drop the oldest redo. (Far less
    /// likely than undo to hit cap, but bounded for safety.)
    pub fn push_redo(&mut self, entry: HistoryEntry) {
        if self.redo.len() >= self.capacity {
            self.redo.pop_front();
        }
        self.redo.push_back(entry);
    }

    /// Pop the most-recent redo entry. Returns `None` if there's
    /// nothing to redo. Caller applies `entry.op` to the Scene
    /// then pushes the entry back to undo via [`push_replay`].
    pub fn pop_redo(&mut self) -> Option<HistoryEntry> {
        self.redo.pop_back()
    }

    /// Re-push an entry onto undo WITHOUT clearing redo — used by
    /// `redo()` flow after popping from redo + re-applying the
    /// forward op. (Distinct from [`push`] which clears redo.)
    pub fn push_replay(&mut self, entry: HistoryEntry) {
        if self.undo.len() >= self.capacity {
            self.undo.pop_front();
        }
        self.undo.push_back(entry);
    }

    /// State snapshot for the frontend.
    pub fn state(&self) -> HistoryState {
        HistoryState {
            undo_len: self.undo.len(),
            redo_len: self.redo.len(),
            capacity: self.capacity,
        }
    }

    /// Wipe everything. Used on chapter close — per-chapter
    /// session means undo doesn't survive chapter switches (locked
    /// decision).
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_core::{NodeId, Op, PageId};

    fn entry(node: u64) -> HistoryEntry {
        HistoryEntry {
            op: Op::RemoveTextBlock {
                page: PageId(1),
                id: NodeId(node),
            },
            inverse: Op::RemoveTextBlock {
                page: PageId(1),
                id: NodeId(node),
            },
        }
    }

    #[test]
    fn push_clears_redo() {
        let mut h = History::new(10);
        h.push(entry(1));
        h.push(entry(2));
        let e1 = h.pop_undo().unwrap();
        h.push_redo(e1);
        assert_eq!(h.state().redo_len, 1);

        // A new apply clears redo — user branched off the timeline.
        h.push(entry(3));
        assert_eq!(h.state().redo_len, 0);
    }

    #[test]
    fn cap_drops_oldest_undo() {
        let mut h = History::new(3);
        h.push(entry(1));
        h.push(entry(2));
        h.push(entry(3));
        h.push(entry(4)); // pushes out entry(1)
        assert_eq!(h.state().undo_len, 3);

        // Top is most recent.
        let top = h.pop_undo().unwrap();
        match top.op {
            Op::RemoveTextBlock { id, .. } => assert_eq!(id, NodeId(4)),
            _ => panic!(),
        }
        // Oldest survivor is entry(2).
        let _e3 = h.pop_undo().unwrap();
        let oldest = h.pop_undo().unwrap();
        match oldest.op {
            Op::RemoveTextBlock { id, .. } => assert_eq!(id, NodeId(2)),
            _ => panic!(),
        }
    }

    #[test]
    fn replay_does_not_clear_redo() {
        let mut h = History::new(10);
        h.push(entry(1));
        h.push(entry(2));
        let popped = h.pop_undo().unwrap();
        h.push_redo(popped);
        let redo = h.pop_redo().unwrap();
        // Replay re-pushes to undo without clearing the (now-empty)
        // redo. Important so the user can keep redoing forward.
        h.push_replay(redo);
        assert_eq!(h.state().undo_len, 2);
        assert_eq!(h.state().redo_len, 0);
    }

    #[test]
    fn clear_wipes_both_stacks() {
        let mut h = History::new(10);
        h.push(entry(1));
        h.push(entry(2));
        let e = h.pop_undo().unwrap();
        h.push_redo(e);
        h.clear();
        assert_eq!(h.state().undo_len, 0);
        assert_eq!(h.state().redo_len, 0);
    }

    #[test]
    fn capacity_zero_clamped_to_one() {
        // A zero-cap ring buffer would discard every apply
        // immediately — useless. Clamp to 1 so at least the most
        // recent op is undo-able.
        let mut h = History::new(0);
        assert_eq!(h.state().capacity, 1);
        h.push(entry(1));
        assert_eq!(h.state().undo_len, 1);
    }
}
