//! `Op` — the unit of state change.
//!
//! Every mutation of a `Scene` goes through an `Op`. Engines return
//! `Vec<Op>`; manual UI actions (user types in a translation field)
//! also produce `Op`s. The driver wraps them in `Op::Batch` and hands
//! to `ProjectSession::apply` (in `koharu-app`, Phase 5).
//!
//! ## Inversion
//!
//! Every op must be reversible to support undo. There are two
//! patterns depending on the op:
//!
//! - **Self-inverting**: e.g. `AddPage` ↔ `RemovePage`. The inverse
//!   is derivable from the op itself.
//! - **State-dependent inverse**: e.g. `UpdateTextBlock { patch }`'s
//!   inverse is `UpdateTextBlock { patch: prev_value }`. Computing
//!   the inverse requires reading the pre-state. This is what the
//!   `OpInverse::inverse(&Scene)` signature is for — driver captures
//!   pre-state before applying.
//!
//! The driver stores `(op, inverse)` pairs in the history ring
//! buffer so undo is one pop-and-apply.

use serde::{Deserialize, Serialize};

use crate::blob::BlobId;
use crate::id::{NodeId, PageId, TmEntryId};
use crate::scene::{Region, Scene, TextBlock, TextStyle};

/// Sum type covering every legal mutation of a `Scene`.
///
/// New variants are an additive change — old persisted op logs stay
/// readable. Removing a variant is a breaking change requiring a
/// schema migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Op {
    /// Apply many ops as a single atomic step. Undo of a batch is
    /// the inverse of the batch (each op's inverse, reversed order).
    Batch(Vec<Op>),

    // ── Scene structure ───────────────────────────────────────
    AddPage {
        id: PageId,
        image: BlobId,
        width: u32,
        height: u32,
    },
    RemovePage {
        id: PageId,
    },
    UpdatePageImage {
        id: PageId,
        image: BlobId,
    },

    // ── Text block lifecycle ──────────────────────────────────
    AddTextBlock {
        page: PageId,
        block: TextBlock,
    },
    UpdateTextBlock {
        page: PageId,
        id: NodeId,
        patch: TextBlockPatch,
    },
    RemoveTextBlock {
        page: PageId,
        id: NodeId,
    },

    // ── Pipeline artifacts ────────────────────────────────────
    SetSegmentationMask {
        page: PageId,
        mask: Option<BlobId>,
    },
    SetInpaintedImage {
        page: PageId,
        image: Option<BlobId>,
    },
    SetRenderedImage {
        page: PageId,
        image: Option<BlobId>,
    },
    SetBrushLayer {
        page: PageId,
        brush: Option<BlobId>,
    },

    // ── Translation-memory provenance hint ────────────────────
    /// Not strictly state — records that a TM hit was used so undo
    /// can surface "this came from TM not LLM" in the UI when the
    /// user reverts. Doesn't mutate the Scene; the inverse is a
    /// no-op `NoteTmHit` with no entry.
    NoteTmHit {
        page: PageId,
        node: NodeId,
        tm_entry: Option<TmEntryId>,
    },
}

/// Partial update for a `TextBlock`. Outer `None` = leave field
/// unchanged; outer `Some(None)` = explicitly clear field;
/// outer `Some(Some(v))` = set field to `v`. Three-state semantics
/// in a single field.
///
/// Used by `Op::UpdateTextBlock` so a single op can change one field
/// (the common case: user edits translation) without re-supplying
/// every other field.
///
/// The `#[serde(default, deserialize_with = "double_option")]`
/// attribute on `Option<Option<T>>` fields preserves the difference
/// between "field absent" (no change) and "field present with null
/// value" (explicit clear) on the wire — without it, serde
/// collapses both to outer `None` and the round-trip is lossy.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextBlockPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub source_text: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub translation: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub style: Option<Option<TextStyle>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub source_lang: Option<Option<String>>,
}

/// Deserializer helper for `Option<Option<T>>` fields where we need
/// to distinguish "missing key" from "present with null value".
///
/// - Key missing → `#[serde(default)]` returns outer `None` (no change)
/// - Key present, value null → inner deserializes to `None`, wrapped
///   as outer `Some(None)` (explicit clear)
/// - Key present, value v → inner deserializes to `Some(v)`, wrapped
///   as outer `Some(Some(v))` (set to v)
///
/// The serialize side doesn't need a helper — the default
/// `Serialize` for `Option<Option<T>>` produces the same wire shape
/// (`Some(None)` → null, `Some(Some(v))` → v, outer None skipped via
/// `skip_serializing_if`).
fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

impl TextBlockPatch {
    /// True if every field is `None` — applying a no-op patch is
    /// silently dropped by the driver rather than pushed to history.
    pub fn is_empty(&self) -> bool {
        self.region.is_none()
            && self.source_text.is_none()
            && self.translation.is_none()
            && self.style.is_none()
            && self.source_lang.is_none()
    }
}

/// Compute the inverse of an op against a known pre-state.
///
/// The driver is responsible for snapshotting the relevant
/// pre-state and calling `inverse` BEFORE applying the op. Storing
/// `(op, inverse)` pairs makes undo O(1) at the cost of one extra
/// state read per op apply.
pub trait OpInverse {
    fn inverse(&self, before: &Scene) -> Op;
}

// `OpInverse` impl is intentionally **not** provided in Phase 1 —
// implementing it requires the apply-op-to-scene logic to exist
// first, which Phase 2 adds. Lands in Phase 5 alongside
// `ProjectSession::apply`. The trait is declared here so
// downstream code can already type-bound against it.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_block_patch_is_empty() {
        assert!(TextBlockPatch::default().is_empty());
        let mut p = TextBlockPatch::default();
        p.translation = Some(Some("ทดสอบ".into()));
        assert!(!p.is_empty());
    }

    #[test]
    fn op_round_trip_serde() {
        let op = Op::Batch(vec![
            Op::AddPage {
                id: PageId(1),
                image: BlobId([1; 32]),
                width: 800,
                height: 1200,
            },
            Op::SetSegmentationMask {
                page: PageId(1),
                mask: Some(BlobId([2; 32])),
            },
        ]);
        let s = serde_json::to_string(&op).unwrap();
        let op2: Op = serde_json::from_str(&s).unwrap();
        // Round-trip preserves structure (compare by re-serializing).
        assert_eq!(s, serde_json::to_string(&op2).unwrap());
    }

    #[test]
    fn text_block_patch_serde_skips_none_fields() {
        // `serde(skip_serializing_if)` keeps the wire small for the
        // common "user changed one field" patch.
        let mut p = TextBlockPatch::default();
        p.translation = Some(Some("test".into()));
        let s = serde_json::to_string(&p).unwrap();
        assert!(!s.contains("region"));
        assert!(!s.contains("style"));
        assert!(s.contains("translation"));
    }
}
