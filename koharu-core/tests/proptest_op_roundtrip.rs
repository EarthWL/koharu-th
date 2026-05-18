//! Property tests for the Op serialization round-trip.
//!
//! The proper invariant we want to test (apply ∘ undo ∘ apply = apply)
//! requires `Scene::apply(Op)` which lands in Phase 2. For Phase 1
//! we lock down the serde contract — every Op variant must
//! round-trip through JSON and produce an equivalent op. This is the
//! minimum guarantee for sending ops over RPC or persisting them.

use koharu_core::{BlobId, NodeId, Op, PageId, Region, TextBlock, TextBlockPatch};
use proptest::prelude::*;

fn arb_blob_id() -> impl Strategy<Value = BlobId> {
    any::<[u8; 32]>().prop_map(BlobId)
}

fn arb_page_id() -> impl Strategy<Value = PageId> {
    (1u64..1000).prop_map(PageId)
}

fn arb_node_id() -> impl Strategy<Value = NodeId> {
    (1u64..10_000).prop_map(NodeId)
}

fn arb_region() -> impl Strategy<Value = Region> {
    (0u32..5000, 0u32..5000, 1u32..2000, 1u32..2000).prop_map(|(x, y, width, height)| Region {
        x,
        y,
        width,
        height,
    })
}

fn arb_text_block() -> impl Strategy<Value = TextBlock> {
    (arb_node_id(), arb_region()).prop_map(|(id, region)| TextBlock {
        id,
        region,
        source_text: None,
        translation: None,
        style: None,
        source_lang: None,
        font_prediction: None,
    })
}

fn arb_text_block_patch() -> impl Strategy<Value = TextBlockPatch> {
    (
        prop::option::of(arb_region()),
        prop::option::of(prop::option::of(".*")),
        prop::option::of(prop::option::of(".*")),
    )
        .prop_map(|(region, source_text, translation)| TextBlockPatch {
            region,
            source_text,
            translation,
            style: None,
            source_lang: None,
        })
}

/// Generator for a non-Batch Op variant. We pull Batch out so the
/// recursive case can compose Batches of these leaf ops without
/// exponential blowup.
fn arb_leaf_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (arb_page_id(), arb_blob_id(), 100u32..3000, 100u32..3000).prop_map(
            |(id, image, width, height)| Op::AddPage { id, image, width, height }
        ),
        arb_page_id().prop_map(|id| Op::RemovePage { id }),
        (arb_page_id(), arb_blob_id()).prop_map(|(id, image)| Op::UpdatePageImage { id, image }),
        (arb_page_id(), arb_text_block()).prop_map(|(page, block)| Op::AddTextBlock { page, block }),
        (arb_page_id(), arb_node_id(), arb_text_block_patch()).prop_map(
            |(page, id, patch)| Op::UpdateTextBlock { page, id, patch }
        ),
        (arb_page_id(), arb_node_id()).prop_map(|(page, id)| Op::RemoveTextBlock { page, id }),
        (arb_page_id(), prop::option::of(arb_blob_id())).prop_map(
            |(page, mask)| Op::SetSegmentationMask { page, mask }
        ),
        (arb_page_id(), prop::option::of(arb_blob_id())).prop_map(
            |(page, image)| Op::SetInpaintedImage { page, image }
        ),
        (arb_page_id(), prop::option::of(arb_blob_id())).prop_map(
            |(page, image)| Op::SetRenderedImage { page, image }
        ),
    ]
}

fn arb_op() -> impl Strategy<Value = Op> {
    arb_leaf_op().prop_recursive(
        3,  // depth
        20, // size
        5,  // items per Batch
        |inner| prop::collection::vec(inner, 0..5).prop_map(Op::Batch),
    )
}

proptest! {
    /// Round-tripping an Op through JSON must produce a serde-equal
    /// op (compared by re-serializing both, since Op doesn't derive
    /// PartialEq — equality on f32 fields would be fragile).
    #[test]
    fn op_json_round_trip(op in arb_op()) {
        let s1 = serde_json::to_string(&op).unwrap();
        let op2: Op = serde_json::from_str(&s1).unwrap();
        let s2 = serde_json::to_string(&op2).unwrap();
        prop_assert_eq!(s1, s2);
    }

    /// TextBlockPatch must drop None fields from the wire so the
    /// common single-field-update patch stays small.
    #[test]
    fn patch_with_only_translation_serializes_compactly(
        translation in ".*"
    ) {
        let mut patch = TextBlockPatch::default();
        patch.translation = Some(Some(translation));
        let s = serde_json::to_string(&patch).unwrap();
        prop_assert!(!s.contains("\"region\""));
        prop_assert!(!s.contains("\"style\""));
        prop_assert!(!s.contains("\"source_text\""));
        prop_assert!(s.contains("\"translation\""));
    }
}
