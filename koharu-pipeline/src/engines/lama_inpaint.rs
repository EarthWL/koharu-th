//! `lama_inpaint` — Phase 4.4's first inpaint engine.
//!
//! Wraps `koharu_ml::facade::Model::inpaint` behind the v2 [`Engine`]
//! trait. Same inference path as `ops::vision::inpaint`; reads the
//! page image + segmentation mask + text-block bboxes from the
//! Scene, produces an `InpaintedImage` artifact.
//!
//! ## Settings (TODO, blocked by #18)
//!
//! LaMa has a `max_crop_size` knob that the upstream issue
//! ([`#18`](https://github.com/EarthWL/koharu-th/issues/18)) asked
//! for: smaller values speed up inference + reduce VRAM but can
//! produce visible seams at chunk boundaries on large pages.
//! Exposing this as a `Slider` setting requires `koharu_ml` to
//! accept the override at the call site. The plumbing change is
//! a follow-up — Phase 4.4 just keeps the existing default + lands
//! the engine wrapper.
//!
//! Once the override threads through, this engine's
//! `settings_schema` becomes:
//!
//! ```ignore
//! const SETTINGS: &[SettingDescriptor] = &[
//!     SettingDescriptor::Slider {
//!         id: "max_crop_size_px",
//!         label_i18n_key: "engineSettings.lama.maxCropSize",
//!         min: 256.0, max: 2048.0, step: 64.0, default: 512.0,
//!     },
//! ];
//! ```
//!
//! and `run` reads via `ctx.setting::<f64>("max_crop_size_px",
//! 512.0)` before passing to the underlying inpaint call.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use futures::future::BoxFuture;
use image::ImageFormat;
use tokio::sync::mpsc;

use koharu_core::{
    ArtifactKind, BackendSupport, EngineCost, EngineResult, HardwareReq, Op, SettingDescriptor,
};
use koharu_engines::{Engine, EngineCtx, EngineInfo, inventory};
use koharu_types::{Document, SerializableDynamicImage, TextBlock as V1TextBlock};

pub const ENGINE_ID: &str = "lama_inpaint";

const SETTINGS: &[SettingDescriptor] = &[];

const CONSUMES: &[ArtifactKind] = &[
    ArtifactKind::SourceImage,
    ArtifactKind::SegmentationMask,
    ArtifactKind::DetectionBoxes,
];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::InpaintedImage];

pub struct LamaInpaintEngine;

#[async_trait]
impl Engine for LamaInpaintEngine {
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

        // Inpaint without a mask is a no-op (the legacy facade has
        // a similar guard internally). Bail early so we don't waste
        // a model load + image decode on a page with no detections.
        let Some(mask_id) = page.segmentation_mask else {
            return Ok(());
        };

        let image_bytes = ctx
            .blobs
            .get(page.source_image)
            .ok_or_else(|| anyhow!("source image blob {} missing", page.source_image.to_hex()))?;
        let image = image::load_from_memory(&image_bytes)
            .context("decoding source image")?;

        let mask_bytes = ctx
            .blobs
            .get(mask_id)
            .ok_or_else(|| anyhow!("mask blob {} missing", mask_id.to_hex()))?;
        let mask = image::load_from_memory(&mask_bytes)
            .context("decoding segmentation mask")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Build a tmp Document with image + mask + text blocks for
        // bbox-aware inpainting (the legacy facade reads bboxes to
        // bias the crop windows).
        let mut tmp_doc = build_tmp_document(image, mask, page);

        ctx.ml
            .inpaint(&mut tmp_doc)
            .await
            .context("ml.inpaint failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Harvest the inpainted result, encode as WebP-lossless,
        // register in BlobStore, emit Op::SetInpaintedImage.
        let inpainted = tmp_doc
            .inpainted
            .ok_or_else(|| anyhow!("ml.inpaint returned without setting doc.inpainted"))?;
        let inpainted_dyn: image::DynamicImage = inpainted.into();
        let mut buf: Vec<u8> = Vec::new();
        // PNG instead of WebP-lossless for parity with the segment
        // mask path; both are intermediate artifacts not user-
        // facing files.
        inpainted_dyn
            .write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png)
            .context("encoding inpainted image to PNG")?;
        let inpainted_id = ctx.blobs.put(buf);

        ops_tx
            .send(EngineResult {
                scene_ops: vec![Op::SetInpaintedImage {
                    page: ctx.page,
                    image: Some(inpainted_id),
                }],
                project_ops: Vec::new(),
            })
            .await
            .map_err(|_| anyhow!("driver hung up on engine result channel"))?;

        Ok(())
    }
}

fn build_tmp_document(
    image: image::DynamicImage,
    mask: image::DynamicImage,
    page: &koharu_core::scene::Page,
) -> Document {
    let (width, height) = (page.width, page.height);
    let mut text_blocks: Vec<V1TextBlock> = Vec::with_capacity(page.text_blocks.len());
    for block in page.text_blocks.values() {
        text_blocks.push(V1TextBlock {
            node_id: block.id.0,
            x: block.region.x as f32,
            y: block.region.y as f32,
            width: block.region.width as f32,
            height: block.region.height as f32,
            confidence: 1.0,
            line_polygons: None,
            source_direction: None,
            source_language: block.source_lang.clone(),
            rotation_deg: None,
            detected_font_size_px: None,
            detector: None,
            text: block.source_text.clone(),
            translation: block.translation.clone(),
            style: None,
            font_prediction: None,
            rendered: None,
            lock_layout_box: false,
            layout_seed_x: None,
            layout_seed_y: None,
            layout_seed_width: None,
            layout_seed_height: None,
        });
    }
    Document {
        id: String::new(),
        path: PathBuf::new(),
        name: String::new(),
        image: SerializableDynamicImage::from(image),
        width,
        height,
        text_blocks,
        segment: Some(SerializableDynamicImage::from(mask)),
        inpainted: None,
        rendered: None,
        brush_layer: None,
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(LamaInpaintEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "LaMa Inpaint",
        description: "Default inpaint — large-mask in-context-conditioned model. Reads bubble mask + text bboxes, produces a clean page background ready for translated text overlay.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: Some(2048),
            prefers_compute_cap: Some(7.5),
            backends: BackendSupport::any(),
            weights_size_mb: 200,
        },
        cost: EngineCost::local(),
        is_default: true,
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
        assert!(info.consumes.contains(&ArtifactKind::SegmentationMask));
        assert!(info.produces.contains(&ArtifactKind::InpaintedImage));
        assert_eq!(info.hardware.min_vram_mb, Some(2048));
        assert_eq!(info.hardware.prefers_compute_cap, Some(7.5));
    }
}
