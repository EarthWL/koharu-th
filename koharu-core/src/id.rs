//! Strongly-typed id newtypes.
//!
//! Using newtypes (instead of bare `u64`) catches "page id used where
//! a node id was expected" at compile time — bug class that's easy to
//! introduce when you have multiple integer-keyed entities.

use serde::{Deserialize, Serialize};

/// Identifier for a page within a `Scene`.
///
/// `0` is reserved as a sentinel "no page" value; legitimate pages
/// start at `1`. This matches the convention in `koharu-project`'s
/// chapter-page table.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct PageId(pub u64);

/// Identifier for a node (text block) within a `Page`.
///
/// Stable across re-detections — assigning a new id when a block is
/// re-detected at the same location would break undo. The engine that
/// regenerates blocks should preserve existing ids where geometry
/// overlap exceeds a threshold (defined in `koharu-engines`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct NodeId(pub u64);

/// Identifier for a translation-memory entry. Cross-cuts `Op` so a
/// `NoteTmHit` op can reference which TM row was used.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct TmEntryId(pub u64);

impl PageId {
    pub const NONE: Self = Self(0);

    pub fn is_set(self) -> bool {
        self.0 != 0
    }
}

impl NodeId {
    pub const NONE: Self = Self(0);

    pub fn is_set(self) -> bool {
        self.0 != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_distinct_types() {
        // This test exists to confirm the newtype intent — if you
        // delete it because "duh", that's fine.
        let _p: PageId = PageId(1);
        let _n: NodeId = NodeId(1);
        // The following line would NOT compile, by design:
        //     let _: PageId = NodeId(1);
    }

    #[test]
    fn none_sentinel() {
        assert!(!PageId::NONE.is_set());
        assert!(PageId(1).is_set());
        assert!(!NodeId::NONE.is_set());
        assert!(NodeId(1).is_set());
    }

    #[test]
    fn round_trip_serde() {
        let p = PageId(42);
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(s, "42"); // transparent → bare number on the wire
        let p2: PageId = serde_json::from_str(&s).unwrap();
        assert_eq!(p, p2);
    }
}
