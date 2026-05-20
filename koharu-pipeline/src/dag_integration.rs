//! Integration tests for [`koharu_engines::dag::resolve_plan`].
//!
//! Live in `koharu-pipeline` (not `koharu-engines`) because they
//! need the registered engines from `engines::*` — those submit
//! via `inventory::submit!` at link time, and `cargo test -p
//! koharu-engines` doesn't link them.
//!
//! No production code; this module is `#[cfg(test)]` only. The
//! `engines::*` modules are already pulled in by the parent
//! library via `pub mod engines;` so their submissions are
//! reachable from this test binary.

#![cfg(test)]

use std::collections::HashMap;

use koharu_core::ArtifactKind;
use koharu_engines::dag::{PlanRequest, ResolveError, resolve_plan};
use koharu_engines::info::EngineInfo;

/// Helper: assert returned plan is topologically valid — for every
/// engine in the list, all of its `consumes` inputs come from
/// `SourceImage` (free) OR from an engine that appears earlier in
/// the plan.
fn assert_topological(plan: &[&'static EngineInfo]) {
    for (i, later) in plan.iter().enumerate() {
        for input in later.consumes {
            if input.is_source() {
                continue;
            }
            let producer_idx = plan.iter().position(|e| e.produces.contains(input));
            if let Some(idx) = producer_idx {
                assert!(
                    idx < i,
                    "engine {} consumes {:?} but its producer {} appears later",
                    later.id,
                    input,
                    plan[idx].id
                );
            }
        }
    }
}

#[test]
fn single_target_resolves_to_its_producer() {
    // DetectionBoxes now has two producers (comic_text_detector,
    // anime_yolo_detector) — must disambiguate via `prefer`.
    let plan = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::DetectionBoxes],
        prefer: [(ArtifactKind::DetectionBoxes, "comic_text_detector")]
            .into_iter()
            .collect(),
    })
    .expect("DetectionBoxes resolvable");
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].id, "comic_text_detector");
}

#[test]
fn multi_artifact_from_same_engine_dedupes() {
    // comic_text_detector produces BOTH DetectionBoxes AND
    // SegmentationMask in one pass — must not be added twice.
    // Both anime_yolo + comic_text are candidates for each
    // artifact, so we disambiguate to the default detector.
    let plan = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::DetectionBoxes, ArtifactKind::SegmentationMask],
        prefer: [
            (ArtifactKind::DetectionBoxes, "comic_text_detector"),
            (ArtifactKind::SegmentationMask, "comic_text_detector"),
        ]
        .into_iter()
        .collect(),
    })
    .expect("plan resolvable");
    assert_eq!(plan.len(), 1, "single engine produces both artifacts");
    assert_eq!(plan[0].id, "comic_text_detector");
}

#[test]
fn transitive_deps_walked_in_topological_order() {
    // Translation → OcrText → DetectionBoxes → SourceImage chain.
    // Translation (local vs cloud_llm), OcrText (mit48px vs manga vs
    // cloud_vision) AND DetectionBoxes (comic_text vs anime_yolo) all
    // have multiple producers; pass `prefer` to disambiguate each.
    let plan = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::Translation],
        prefer: [
            (ArtifactKind::Translation, "local_llm_translate"),
            (ArtifactKind::OcrText, "mit48px_ocr"),
            (ArtifactKind::DetectionBoxes, "comic_text_detector"),
        ]
        .into_iter()
        .collect(),
    })
    .expect("Translation resolvable");
    let ids: Vec<&str> = plan.iter().map(|e| e.id).collect();
    assert_eq!(
        ids,
        vec!["comic_text_detector", "mit48px_ocr", "local_llm_translate"]
    );
    assert_topological(&plan);
}

#[test]
fn detection_boxes_now_has_two_producers() {
    // Regression test for the AnimeYolo port — without `prefer`,
    // DetectionBoxes must be reported as ambiguous between the two
    // detector engines, surfacing both candidates to the UI.
    let err = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::DetectionBoxes],
        prefer: HashMap::new(),
    })
    .expect_err("ambiguous");
    match err {
        ResolveError::AmbiguousProducer {
            artifact,
            candidates,
        } => {
            assert_eq!(artifact, ArtifactKind::DetectionBoxes);
            assert!(candidates.contains(&"comic_text_detector"));
            assert!(candidates.contains(&"anime_yolo_detector"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn ambiguous_producer_without_prefer_errors() {
    let err = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::OcrText],
        prefer: HashMap::new(),
    })
    .expect_err("ambiguous");
    match err {
        ResolveError::AmbiguousProducer {
            artifact,
            candidates,
        } => {
            assert_eq!(artifact, ArtifactKind::OcrText);
            assert!(candidates.contains(&"mit48px_ocr"));
            assert!(candidates.contains(&"manga_ocr"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn no_producer_errors_with_artifact_in_payload() {
    // FontPrediction has no producer in the Phase 4.x inventory.
    // (Phase 4.4-followup will add a font_detector engine.)
    let err = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::FontPrediction],
        prefer: HashMap::new(),
    })
    .expect_err("no producer");
    assert!(matches!(
        err,
        ResolveError::NoProducer {
            artifact: ArtifactKind::FontPrediction
        }
    ));
}

#[test]
fn prefer_unknown_engine_errors() {
    let err = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::OcrText],
        prefer: [(ArtifactKind::OcrText, "nonexistent_ocr")]
            .into_iter()
            .collect(),
    })
    .expect_err("unknown");
    assert!(matches!(
        err,
        ResolveError::UnknownPreferredEngine {
            engine_id: "nonexistent_ocr",
            ..
        }
    ));
}

#[test]
fn prefer_wrong_output_errors() {
    // local_llm_translate exists but produces Translation, not
    // OcrText. Asking for OcrText with that engine in `prefer`
    // surfaces a `PreferredEngineWrongOutput` error.
    let err = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::OcrText],
        prefer: [(ArtifactKind::OcrText, "local_llm_translate")]
            .into_iter()
            .collect(),
    })
    .expect_err("wrong output");
    assert!(matches!(
        err,
        ResolveError::PreferredEngineWrongOutput {
            engine_id: "local_llm_translate",
            ..
        }
    ));
}

#[test]
fn multiple_targets_share_upstream_engine() {
    // Both Translation AND InpaintedImage depend on the detector.
    // The detector must appear once + before both downstream
    // engines. With AnimeYolo in the mix the detector slot needs
    // disambiguation (pick comic_text_detector — produces bubble
    // mask which lama_inpaint consumes).
    let plan = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::Translation, ArtifactKind::InpaintedImage],
        prefer: [
            (ArtifactKind::Translation, "local_llm_translate"),
            (ArtifactKind::OcrText, "manga_ocr"),
            (ArtifactKind::DetectionBoxes, "comic_text_detector"),
            (ArtifactKind::SegmentationMask, "comic_text_detector"),
        ]
        .into_iter()
        .collect(),
    })
    .expect("plan resolvable");
    let ids: Vec<&str> = plan.iter().map(|e| e.id).collect();
    assert_eq!(plan.len(), 4, "detector + manga + lama + translate");
    assert_eq!(ids[0], "comic_text_detector");
    assert_topological(&plan);
    assert!(ids.contains(&"manga_ocr"));
    assert!(ids.contains(&"lama_inpaint"));
    assert!(ids.contains(&"local_llm_translate"));
}

#[test]
fn source_image_target_is_no_op() {
    let plan = resolve_plan(PlanRequest {
        targets: vec![ArtifactKind::SourceImage],
        prefer: HashMap::new(),
    })
    .expect("source image is always satisfied");
    assert!(plan.is_empty());
}
