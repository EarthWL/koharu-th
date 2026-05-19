//! `Op` — the unit of Scene state change.
//!
//! Every mutation of a `Scene` goes through an `Op`. Engines emit
//! `Vec<Op>` via the channel passed in `EngineCtx` (Phase 3); manual
//! UI actions (user types in a translation field) also produce `Op`s.
//! The driver wraps each batch as `Op::Batch` and hands to
//! `ProjectSession::apply` (in `koharu-app`, Phase 5).
//!
//! ## Inversion
//!
//! Every Op must be reversible to support undo, but inverses are
//! computed **inline at apply time** by `ProjectSession::apply()` —
//! NOT through a trait. The original design had an `OpInverse` trait
//! with signature `fn inverse(&self, before: &Scene) -> Op`, but that
//! breaks for `Op::Batch`: the middle Op of `Batch([A, B, C])`'s
//! inverse depends on the Scene state AFTER A applied, not the
//! original pre-batch snapshot. See [`docs/v2-arch.md`] §12
//! "Design changelog — issue A" on `main`.
//!
//! Apply-time computation walks the Scene as it mutates each Op,
//! captures the per-Op inverse against the just-mutated state, and
//! stores `(forward_op, captured_inverse)` pairs in
//! `ProjectSession::history`. Single computation, correct for Batch,
//! no trait gymnastics.
//!
//! ## Project-side mutations
//!
//! `Op` covers Scene-layer state only — pages, text blocks, pipeline
//! artifacts. Mutations to project entities (characters, glossary,
//! prompt templates, series meta) go through [`ProjectOp`] in a
//! sibling module. Engines return `EngineResult { scene_ops,
//! project_ops }`; the driver applies both inside one SQLite
//! transaction so undo of e.g. "extract entities" reverses both the
//! Scene side (added text-block translations) and the Project side
//! (added character / glossary rows) atomically.

use serde::{Deserialize, Serialize};

use crate::blob::BlobId;
use crate::id::{NodeId, PageId};
use crate::scene::{Region, TextBlock, TextStyle};

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
    // NOTE: `NoteTmHit` previously lived here. Removed in Phase 1.1
    // after the post-#33 re-review (see docs/v2-arch.md §12 — issue
    // B). Pure annotation doesn't fit the "Op = state mutation"
    // model — moved to the event bus as `SessionEvent::TmHit { … }`
    // so cost-dashboard / UI subscribers can react without
    // polluting the undo log.
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

// NOTE: An `OpInverse` trait previously lived here with signature
// `fn inverse(&self, before: &Scene) -> Op`. Removed in Phase 1.1
// after the post-#33 re-review (see docs/v2-arch.md §12 — issue A).
//
// The trait was broken for `Op::Batch`: a Batch's middle Op needs
// the Scene state AFTER prior Ops applied, not the original `before`
// snapshot the signature provides. The fix is to compute inverses
// **inline at apply time** in `ProjectSession::apply` (Phase 5) —
// walk the Scene as you apply each Op, capture per-Op inverse
// against the just-mutated state, store `(forward, inverse)` pairs
// in history. No trait needed.

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
