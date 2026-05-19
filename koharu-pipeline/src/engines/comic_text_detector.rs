//! `comic_text_detector` — Phase 3.3's first ported engine.
//!
//! Wraps the existing default detector path (`koharu_ml::facade::
//! Model::detect_with(DetectorEngine::Default)`) behind the v2
//! [`Engine`](koharu_engines::Engine) trait. The ML inference is
//! identical to the legacy direct-call path in `ops::vision::detect`;
//! only the wire shape differs (returns `Vec<Op>` through an mpsc
//! channel instead of mutating `&mut Document`).
//!
//! ## Phase 3.3 scope
//!
//! - **Engine impl + inventory registration**: ✅ here.
//! - **Call-site swap** (`vision::detect` invokes this engine
//!   instead of the direct ML call): ❌ deferred to Phase 4. The
//!   call-site swap requires a hybrid Scene-from-Document bridge
//!   that's only worth building once multiple engines need it.
//!
//! The acceptance criterion "test page through new path matches
//! old" is gated behind `#[ignore]` because it needs the comic-
//! text-detector ONNX weights present locally. Run manually with
//! `cargo test --features golden-page-test -- --ignored`.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use futures::future::BoxFuture;
use image::{DynamicImage, ImageFormat};
use tokio::sync::mpsc;

use koharu_core::{
    ArtifactKind, BackendSupport, EngineCost, EngineResult, HardwareReq, NodeId, Op, Region,
    SettingDescriptor,
};
use koharu_core::scene::TextBlock as SceneTextBlock;
use koharu_engines::{Engine, EngineCtx, EngineInfo, inventory};
use koharu_types::{DetectorEngine, Document, SerializableDynamicImage};

/// Stable id used by the engine profile UI + saved profiles.
/// Importing this from `engines/mod.rs` keeps the inventory
/// submission reachable through dead-code elimination on Windows
/// MSVC (see engines/mod.rs docstring).
pub const ENGINE_ID: &str = "comic_text_detector";

/// Empty settings schema — the comic-text-detector has no
/// user-tunable knobs (confidence threshold etc. live on the
/// Anime YOLO variant which will be a separate engine).
const SETTINGS: &[SettingDescriptor] = &[];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::SourceImage];
const PRODUCES: &[ArtifactKind] = &[
    ArtifactKind::DetectionBoxes,
    ArtifactKind::SegmentationMask,
];

pub struct ComicTextDetectorEngine;

#[async_trait]
impl Engine for ComicTextDetectorEngine {
    async fn run(
        &self,
        ctx: EngineCtx<'_>,
        ops_tx: mpsc::Sender<EngineResult>,
    ) -> Result<()> {
        // Bail early if the user cancelled before we even started —
        // saves a model load round-trip.
        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // 1. Locate the page in the scene + grab the source image
        //    blob handle.
        let page = ctx
            .scene
            .pages
            .get(&ctx.page)
            .ok_or_else(|| anyhow!("page {:?} not present in scene", ctx.page))?;
        let source_blob = page.source_image;

        // 2. Fetch the bytes through BlobStore. `get` returns
        //    `bytes::Bytes` — zero-copy reference into the store.
        let bytes = ctx
            .blobs
            .get(source_blob)
            .ok_or_else(|| anyhow!("source image blob {} missing", source_blob.to_hex()))?;

        // 3. Decode. `image::load_from_memory` handles WebP/PNG/JPEG
        //    via the format-from-magic-bytes path.
        let image = image::load_from_memory(&bytes)
            .with_context(|| format!("decoding source image for page {:?}", ctx.page))?;
        let (width, height) = (image.width(), image.height());

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // 4. Adapt to the legacy ML facade. The detector mutates a
        //    `Document` in place; we wrap our image in a throwaway
        //    document, run inference, and harvest the results. This
        //    is the impedance-matching point — Phase 4 lifts the
        //    legacy facade to a Scene-native API.
        let mut tmp_doc = empty_document_with_image(image, width, height);
        ctx.ml
            .detect_with(&mut tmp_doc, DetectorEngine::Default, None, None)
            .await
            .context("ml.detect_with failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // 5. Convert results to v2 Ops.
        let mut scene_ops: Vec<Op> = Vec::with_capacity(tmp_doc.text_blocks.len() + 1);

        // 5a. Text blocks: v1 → v2 conversion. NodeId is synthetic —
        //     ordering matches detector output. Phase 4's driver
        //     bridge can re-key these against the existing scene's
        //     node ids (for merge-vs-replace policy).
        for (idx, v1) in tmp_doc.text_blocks.iter().enumerate() {
            let block = SceneTextBlock {
                id: NodeId(idx as u64),
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
            };
            scene_ops.push(Op::AddTextBlock {
                page: ctx.page,
                block,
            });
        }

        // 5b. Segmentation mask: encode the produced grayscale image
        //     as PNG (lossless, broad browser support) → BlobStore →
        //     emit Op::SetSegmentationMask. PNG instead of WebP-
        //     lossless because masks are tiny + PNG decoding is
        //     universally available without feature flags.
        if let Some(seg) = tmp_doc.segment {
            let mask_img: DynamicImage = seg.into();
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

        // 6. Send the single result. Detector is one-shot — no
        //    streaming. The driver applies all ops atomically.
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

/// Build a minimal `koharu_types::Document` from a decoded image.
/// Used only as a vehicle for the legacy `Model::detect_with` API
/// which mutates a Document in place; the non-image fields stay at
/// their empty defaults because the detector path doesn't read them.
fn empty_document_with_image(
    image: DynamicImage,
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

/// Async constructor for the inventory registry. Returns an `Arc`
/// of the boxed engine — cheap to clone if the driver hands it off
/// to a spawned task.
fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(ComicTextDetectorEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Comic Text Detector",
        description: "Default detector — fast, balanced. Detects text bubbles + emits a pixel mask used by the inpainter.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: Some(512),
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            weights_size_mb: 16,
        },
        cost: EngineCost::local(),
        load,
    }
}

// Need the `Arc` import to live in this module even though we don't
// directly construct one — silences unused-import warnings while
// keeping the symbol available for future engine variants that
// might `Arc::clone(ctx.ml)` for spawned subtasks.
#[allow(dead_code)]
fn _silence_arc_warning(arc: Arc<koharu_ml::facade::Model>) -> Arc<koharu_ml::facade::Model> {
    arc
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_engines::EngineInfo;

    /// Engine should be visible in the inventory once any code path
    /// in the crate is exercised (which loading this test module
    /// does). Phase 3.3 acceptance: detector appears in the
    /// registry.
    #[test]
    fn engine_registers_in_inventory() {
        let found = inventory::iter::<EngineInfo>()
            .into_iter()
            .find(|info| info.id == "comic_text_detector");
        assert!(
            found.is_some(),
            "comic_text_detector should self-register via inventory::submit!"
        );
        let info = found.unwrap();
        assert_eq!(info.produces.len(), 2);
        assert!(info.produces.contains(&ArtifactKind::DetectionBoxes));
        assert!(info.produces.contains(&ArtifactKind::SegmentationMask));
        assert!(info.consumes.contains(&ArtifactKind::SourceImage));
        assert!(info.cost.local);
        assert_eq!(info.hardware.weights_size_mb, 16);
    }

    /// Sanity-check the load fn returns a non-null engine. Doesn't
    /// invoke `run` (would need real ML weights + a populated
    /// EngineCtx). Phase 4 wires the call-site so the engine
    /// actually executes against a real page.
    #[tokio::test]
    async fn load_returns_a_real_engine() {
        let info = inventory::iter::<EngineInfo>()
            .into_iter()
            .find(|info| info.id == "comic_text_detector")
            .expect("registered");
        let engine = (info.load)().await.expect("load to succeed");
        // We can't call `run` here without an EngineCtx (which needs
        // a Model facade — too heavy for a unit test). The fact that
        // the future resolves to a real Box is the assertion.
        let _: Box<dyn Engine> = engine;
    }
}
