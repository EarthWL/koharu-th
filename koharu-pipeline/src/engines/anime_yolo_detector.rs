//! `anime_yolo_detector` — Phase 4 follow-up: AnimeText YOLO ported
//! as a 2nd detector engine alongside [`super::comic_text_detector`].
//!
//! Wraps `koharu_ml::facade::Model::detect_with(DetectorEngine::
//! AnimeYolo, variant, confidence)` through the v2 [`Engine`] trait.
//! Same inference path as the legacy `vision::detect::AnimeYolo`
//! branch — drops the call-site split now that both detectors live
//! behind the same surface.
//!
//! ## Settings — first engine with a non-empty schema
//!
//! - **variant** (Select n/s/m/l/x): YOLO12 size variant. N is the
//!   nano model (~10 MB weights, faster); X is xlarge (~250 MB,
//!   accurate). Default `n`.
//! - **confidence_threshold** (Slider 0.05–0.95, step 0.01):
//!   Per-detection confidence floor before NMS. Default 0.25 —
//!   matches `koharu_ml::anime_text::DEFAULT_CONFIDENCE_THRESHOLD`.
//!   Lower catches more SFX but more false positives; higher misses
//!   subtle text but cleaner output.
//!
//! ## Behaviour relative to comic_text_detector
//!
//! AnimeText YOLO is text-DETECTION-only (better at SFX, titles,
//! out-of-bubble text than comic_text_detector). It does NOT
//! produce a bubble mask — the underlying `ml.detect_with` path
//! ALSO calls the default detector to harvest the mask for the
//! `SegmentationMask` artifact. The engine declaration mirrors
//! that: `produces: [DetectionBoxes, SegmentationMask]` so the DAG
//! resolver treats it as a drop-in alternative to
//! comic_text_detector.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use futures::future::BoxFuture;
use image::ImageFormat;
use tokio::sync::mpsc;

use koharu_core::{
    ArtifactKind, BackendSupport, EngineCost, EngineResult, HardwareReq, Op, Region,
    SettingDescriptor,
};
use koharu_core::scene::TextBlock as SceneTextBlock;
use koharu_engines::{Engine, EngineCtx, EngineInfo, inventory};
use koharu_types::{AnimeYoloVariant, DetectorEngine, Document, SerializableDynamicImage};

use crate::engine_bridge::index_to_node_id;

pub const ENGINE_ID: &str = "anime_yolo_detector";

const SETTING_VARIANT: &str = "variant";
const SETTING_CONFIDENCE: &str = "confidence_threshold";
const SETTING_NMS: &str = "nms_threshold";
const SETTING_CONTAINMENT: &str = "merge_contained_pct";

const SETTINGS: &[SettingDescriptor] = &[
    SettingDescriptor::Select {
        id: SETTING_VARIANT,
        label_i18n_key: "engineSettings.animeYolo.variant",
        options: &[
            ("n", "engineSettings.animeYolo.variant.n"),
            ("s", "engineSettings.animeYolo.variant.s"),
            ("m", "engineSettings.animeYolo.variant.m"),
            ("l", "engineSettings.animeYolo.variant.l"),
            ("x", "engineSettings.animeYolo.variant.x"),
        ],
        default: "n",
        help_i18n_key: Some("engineSettings.animeYolo.variant.help"),
    },
    SettingDescriptor::Slider {
        id: SETTING_CONFIDENCE,
        label_i18n_key: "engineSettings.animeYolo.confidence",
        min: 0.05,
        max: 0.95,
        step: 0.01,
        default: 0.25,
        help_i18n_key: Some("engineSettings.animeYolo.confidence.help"),
    },
    // NMS IoU threshold — overlapping detections with IoU above
    // this value are suppressed by YOLO's built-in NMS. Lower =
    // more aggressive suppression. 0.50 default matches upstream;
    // 0.35-0.40 helps when partial+full detections of the same
    // text stack.
    SettingDescriptor::Slider {
        id: SETTING_NMS,
        label_i18n_key: "engineSettings.animeYolo.nms",
        min: 0.30,
        max: 0.70,
        step: 0.01,
        default: 0.50,
        help_i18n_key: Some("engineSettings.animeYolo.nms.help"),
    },
    // Containment merge — runs AFTER NMS. If box A is at least
    // this fraction inside box B (intersection.area / a.area),
    // drop A. Catches the "partial-text inside full-text" pattern
    // that IoU NMS misses because IoU of nested boxes can stay
    // below the NMS threshold. Set to 1.0 to disable (no boxes
    // are ≥100% contained except identical ones, which NMS
    // already handles).
    SettingDescriptor::Slider {
        id: SETTING_CONTAINMENT,
        label_i18n_key: "engineSettings.animeYolo.containment",
        min: 0.50,
        max: 1.0,
        step: 0.05,
        default: 0.80,
        help_i18n_key: Some("engineSettings.animeYolo.containment.help"),
    },
];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::SourceImage];
const PRODUCES: &[ArtifactKind] = &[
    ArtifactKind::DetectionBoxes,
    ArtifactKind::SegmentationMask,
];

pub struct AnimeYoloDetectorEngine;

#[async_trait]
impl Engine for AnimeYoloDetectorEngine {
    async fn run(
        &self,
        ctx: EngineCtx<'_>,
        ops_tx: mpsc::Sender<EngineResult>,
    ) -> Result<()> {
        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        let page = ctx
            .scene
            .pages
            .get(&ctx.page)
            .ok_or_else(|| anyhow!("page {:?} not present in scene", ctx.page))?;

        let bytes = ctx
            .blobs
            .get(page.source_image)
            .ok_or_else(|| anyhow!("source image blob {} missing", page.source_image.to_hex()))?;
        let image = image::load_from_memory(&bytes)
            .with_context(|| format!("decoding source image for page {:?}", ctx.page))?;
        let (width, height) = (image.width(), image.height());

        // Settings: variant (n/s/m/l/x) + confidence (0.05-0.95)
        // + NMS IoU + containment merge percentage. Driver builds
        // PipelineRunOptions from saved prefs; engine reads via
        // ctx.setting with the schema default as fallback.
        let variant_str: String = ctx.setting(SETTING_VARIANT, "n".to_string());
        let variant = parse_variant(&variant_str);
        let confidence: f64 = ctx.setting(SETTING_CONFIDENCE, 0.25);
        let nms: f64 = ctx.setting(SETTING_NMS, 0.50);
        let containment_pct: f64 = ctx.setting(SETTING_CONTAINMENT, 0.80);

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        let mut tmp_doc = empty_document_with_image(image, width, height);
        ctx.ml
            .detect_with(
                &mut tmp_doc,
                DetectorEngine::AnimeYolo,
                Some(variant),
                Some(confidence as f32),
                Some(nms as f32),
            )
            .await
            .context("ml.detect_with(AnimeYolo) failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Tier 3: post-NMS containment merge. YOLO's IoU NMS keeps
        // BOTH partial-text box A and full-text box B when A is
        // mostly INSIDE B (IoU(A, B) = |A| / |B| which can stay
        // below the NMS threshold for nested boxes). User sees
        // two stacked detections of the same text — classic
        // multi-scale feature pyramid artifact. Drop A when
        // intersection-over-A reaches `containment_pct`.
        if containment_pct < 1.0 {
            let before = tmp_doc.text_blocks.len();
            tmp_doc.text_blocks =
                drop_contained_boxes(&tmp_doc.text_blocks, containment_pct as f32);
            let dropped = before - tmp_doc.text_blocks.len();
            if dropped > 0 {
                tracing::info!(
                    dropped,
                    before,
                    after = tmp_doc.text_blocks.len(),
                    containment_pct,
                    "containment merge dropped nested detections"
                );
            }
        }

        let mut scene_ops: Vec<Op> = Vec::with_capacity(tmp_doc.text_blocks.len() + 1);

        for (idx, v1) in tmp_doc.text_blocks.iter().enumerate() {
            let block = SceneTextBlock {
                id: index_to_node_id(idx),
                region: Region {
                    x: v1.x.max(0.0) as u32,
                    y: v1.y.max(0.0) as u32,
                    width: v1.width.max(0.0) as u32,
                    height: v1.height.max(0.0) as u32,
                },
                source_text: v1.text.clone(),
                translation: v1.translation.clone(),
                style: None,
                source_lang: v1.source_language.clone(),
                font_prediction: None,
                rotation_deg: None,
            };
            scene_ops.push(Op::AddTextBlock {
                page: ctx.page,
                block,
            });
        }

        // Bubble mask comes from the default detector path inside
        // `detect_with(AnimeYolo)` — Anime YOLO itself has no bubble
        // branch. So we still get a segment image to register.
        if let Some(seg) = tmp_doc.segment {
            let mask_img: image::DynamicImage = seg.into();
            let mut buf: Vec<u8> = Vec::new();
            mask_img
                .write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png)
                .context("encoding segmentation mask to PNG")?;
            let mask_id = ctx.blobs.put(buf);
            scene_ops.push(Op::SetSegmentationMask {
                page: ctx.page,
                mask: Some(mask_id),
            });
        }

        ops_tx
            .send(EngineResult {
                scene_ops,
                project_ops: Vec::new(),
            })
            .await
            .map_err(|_| anyhow!("driver hung up on engine result channel"))?;

        Ok(())
    }
}

fn parse_variant(s: &str) -> AnimeYoloVariant {
    match s {
        "s" => AnimeYoloVariant::S,
        "m" => AnimeYoloVariant::M,
        "l" => AnimeYoloVariant::L,
        "x" => AnimeYoloVariant::X,
        _ => AnimeYoloVariant::N, // covers "n" + any unknown
    }
}

/// Drop boxes that are mostly contained inside another box from
/// the same list. "Mostly" = `intersection.area / box.area >=
/// containment_pct`. For each box A, if any OTHER box B in the
/// list contains A by ≥`containment_pct`, A is dropped.
///
/// O(n²) — fine for typical page detections (< 200 boxes); skip
/// the work entirely when `containment_pct >= 1.0` (caller gates).
///
/// Symmetric ambiguity: if A and B are mutually contained (e.g.,
/// identical boxes), we keep the FIRST occurrence and drop later
/// duplicates. NMS already removes near-identical boxes by IoU so
/// this case is rare in practice.
fn drop_contained_boxes(
    blocks: &[koharu_types::TextBlock],
    containment_pct: f32,
) -> Vec<koharu_types::TextBlock> {
    let mut keep = vec![true; blocks.len()];
    for (i, a) in blocks.iter().enumerate() {
        if !keep[i] {
            continue;
        }
        let a_area = (a.width.max(0.0)) * (a.height.max(0.0));
        if a_area <= 0.0 {
            keep[i] = false; // degenerate box — drop
            continue;
        }
        for (j, b) in blocks.iter().enumerate() {
            if i == j || !keep[j] {
                continue;
            }
            let b_area = (b.width.max(0.0)) * (b.height.max(0.0));
            // If b is smaller-or-equal to a, b can't contain a by
            // ≥containment_pct without a being a near-duplicate.
            // Skip the bigger-than-self check for performance.
            if b_area < a_area {
                continue;
            }
            let inter = intersection_area(a, b);
            if inter / a_area >= containment_pct {
                keep[i] = false;
                break;
            }
        }
    }
    blocks
        .iter()
        .zip(keep.iter())
        .filter_map(|(b, &k)| if k { Some(b.clone()) } else { None })
        .collect()
}

fn intersection_area(a: &koharu_types::TextBlock, b: &koharu_types::TextBlock) -> f32 {
    let ax0 = a.x;
    let ay0 = a.y;
    let ax1 = a.x + a.width;
    let ay1 = a.y + a.height;
    let bx0 = b.x;
    let by0 = b.y;
    let bx1 = b.x + b.width;
    let by1 = b.y + b.height;
    let ix0 = ax0.max(bx0);
    let iy0 = ay0.max(by0);
    let ix1 = ax1.min(bx1);
    let iy1 = ay1.min(by1);
    if ix1 <= ix0 || iy1 <= iy0 {
        0.0
    } else {
        (ix1 - ix0) * (iy1 - iy0)
    }
}

fn empty_document_with_image(
    image: image::DynamicImage,
    width: u32,
    height: u32,
) -> Document {
    Document {
        id: String::new(),
        path: PathBuf::new(),
        name: String::new(),
        image: SerializableDynamicImage::from(image),
        width,
        height,
        text_blocks: Vec::new(),
        segment: None,
        inpainted: None,
        rendered: None,
        brush_layer: None,
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(AnimeYoloDetectorEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Anime Text YOLO",
        description: "Alternative detector — YOLO12-based. Stronger on SFX, out-of-bubble text, and stylised titles than the default detector. Lazy-downloads weights on first use (10-250 MB depending on variant).",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: Some(1024),
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            // N variant ~10MB; X variant ~250MB. Display the worst-
            // case so the Profile UI's "weights size" hint doesn't
            // surprise users who switch to X.
            weights_size_mb: 250,
        },
        cost: EngineCost::local(),
        load,
    }
}

#[allow(dead_code)]
fn _silence_arc_warning(arc: Arc<koharu_ml::facade::Model>) -> Arc<koharu_ml::facade::Model> {
    arc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_registers_in_inventory() {
        let found = inventory::iter::<EngineInfo>()
            .into_iter()
            .find(|info| info.id == ENGINE_ID);
        assert!(found.is_some(), "{} should self-register", ENGINE_ID);
        let info = found.unwrap();
        assert_eq!(info.produces.len(), 2);
        assert!(info.produces.contains(&ArtifactKind::DetectionBoxes));
        assert!(info.produces.contains(&ArtifactKind::SegmentationMask));
        assert_eq!(
            info.settings_schema.len(),
            4,
            "variant + confidence + NMS + containment"
        );
    }

    #[test]
    fn drop_contained_boxes_drops_partial_inside_full() {
        // Realistic case: full text bbox (50,50)-(250,150), and a
        // partial detection covering just the first character at
        // (50,50)-(120,150). Partial is 100% inside full → drop.
        let full = koharu_types::TextBlock {
            x: 50.0, y: 50.0, width: 200.0, height: 100.0,
            ..Default::default()
        };
        let partial = koharu_types::TextBlock {
            x: 50.0, y: 50.0, width: 70.0, height: 100.0,
            ..Default::default()
        };
        let kept = drop_contained_boxes(&[partial, full.clone()], 0.80);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].width, 200.0, "kept full box, dropped partial");
    }

    #[test]
    fn drop_contained_boxes_keeps_separate_bubbles() {
        // Two non-overlapping bubbles must both survive.
        let a = koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 100.0, height: 100.0,
            ..Default::default()
        };
        let b = koharu_types::TextBlock {
            x: 200.0, y: 0.0, width: 100.0, height: 100.0,
            ..Default::default()
        };
        let kept = drop_contained_boxes(&[a, b], 0.80);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn drop_contained_boxes_threshold_below_one_keeps_majority_overlap_only() {
        // Box A is 70% inside box B (30% sticks out). At 0.80
        // threshold A survives; at 0.65 A is dropped.
        let inner = koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 100.0, height: 100.0,
            ..Default::default()
        };
        let outer = koharu_types::TextBlock {
            x: -30.0, y: 0.0, width: 100.0, height: 100.0,
            ..Default::default()
        };
        // overlap = 70x100 = 7000; inner area = 100x100 = 10000.
        // ratio = 0.70.
        let kept_strict = drop_contained_boxes(&[inner.clone(), outer.clone()], 0.80);
        assert_eq!(kept_strict.len(), 2, "0.70 < 0.80 → keep both");
        let kept_relaxed = drop_contained_boxes(&[inner, outer], 0.65);
        assert_eq!(kept_relaxed.len(), 1, "0.70 >= 0.65 → drop inner");
    }

    #[test]
    fn drop_contained_boxes_drops_degenerate_zero_area() {
        let degen = koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 0.0, height: 50.0,
            ..Default::default()
        };
        let real = koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 50.0, height: 50.0,
            ..Default::default()
        };
        let kept = drop_contained_boxes(&[degen, real], 0.80);
        assert_eq!(kept.len(), 1, "zero-area box dropped");
        assert_eq!(kept[0].width, 50.0);
    }

    #[test]
    fn variant_parser_round_trips_known_values() {
        assert!(matches!(parse_variant("n"), AnimeYoloVariant::N));
        assert!(matches!(parse_variant("s"), AnimeYoloVariant::S));
        assert!(matches!(parse_variant("m"), AnimeYoloVariant::M));
        assert!(matches!(parse_variant("l"), AnimeYoloVariant::L));
        assert!(matches!(parse_variant("x"), AnimeYoloVariant::X));
        // Unknown values fall back to N (matches the saved-pref
        // recovery story — if a profile carries an invalid variant
        // string, run the safe smallest model).
        assert!(matches!(parse_variant("bogus"), AnimeYoloVariant::N));
        assert!(matches!(parse_variant(""), AnimeYoloVariant::N));
    }
}
