//! `mit48px_ocr` — Phase 4.3's first OCR engine.
//!
//! Wraps `koharu_ml::facade::Model::ocr_with(OcrEngine::Mit48px)`
//! behind the v2 [`Engine`](koharu_engines::Engine) trait. Same
//! inference path as `ops::vision::ocr`; only the wire shape
//! differs.
//!
//! ## Op emission
//!
//! Reads text blocks from the Scene, runs OCR on each, emits one
//! `Op::UpdateTextBlock { id, patch: { source_text: Some(Some(...)) } }`
//! per block. The bridge maps `NodeId(i)` back to v1
//! `text_blocks[i]` so the existing-block-positions stay stable.
//!
//! No `Op::AddTextBlock` here — OCR augments existing detections;
//! it doesn't add new blocks. Engines that violate this (an OCR
//! pass that re-detects on the fly) should be a detector engine
//! that produces `OcrText` as a secondary artifact in its
//! `produces` list (see Anime Text YOLO's planned shape).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use futures::future::BoxFuture;
use tokio::sync::mpsc;

use koharu_core::{
    ArtifactKind, BackendSupport, EngineCost, EngineResult, HardwareReq, NodeId, Op,
    SettingDescriptor, TextBlockPatch,
};
use koharu_engines::{Engine, EngineCtx, EngineInfo, inventory};
use koharu_types::{Document, OcrEngine as OcrEngineKind, SerializableDynamicImage, TextBlock as V1TextBlock};

/// Stable id used by the engine profile UI + saved profiles.
pub const ENGINE_ID: &str = "mit48px_ocr";

const SETTINGS: &[SettingDescriptor] = &[];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::SourceImage, ArtifactKind::DetectionBoxes];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::OcrText];

pub struct Mit48pxOcrEngine;

#[async_trait]
impl Engine for Mit48pxOcrEngine {
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

        // Nothing to OCR if there are no detected blocks.
        if page.text_blocks.is_empty() {
            return Ok(());
        }

        // Fetch + decode source image.
        let bytes = ctx
            .blobs
            .get(page.source_image)
            .ok_or_else(|| anyhow!("source image blob {} missing", page.source_image.to_hex()))?;
        let image = image::load_from_memory(&bytes)
            .with_context(|| format!("decoding source image for page {:?}", ctx.page))?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Build a tmp Document with the page's existing TextBlocks
        // (v2 → v1 conversion). The legacy ocr_with reads
        // bbox-per-block from the v1 TextBlock vec, crops the source
        // image, and writes back the recognised text. We harvest
        // the post-call text_blocks into UpdateTextBlock ops.
        let mut tmp_doc = build_tmp_document(image, page);
        let block_ids: Vec<NodeId> = page.text_blocks.keys().copied().collect();

        ctx.ml
            .ocr_with(&mut tmp_doc, OcrEngineKind::Mit48px)
            .await
            .context("ml.ocr_with(Mit48px) failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Emit one UpdateTextBlock per block with the recognised
        // text. Even if the recognised text is empty, emit the Op
        // so downstream consumers see the stage ran (UpdateTextBlock
        // with explicit empty-string differs from "OCR not run").
        let mut scene_ops: Vec<Op> = Vec::with_capacity(tmp_doc.text_blocks.len());
        for (i, v1) in tmp_doc.text_blocks.iter().enumerate() {
            let Some(node_id) = block_ids.get(i).copied() else {
                tracing::warn!(
                    block_index = i,
                    "ocr produced more blocks than scene had; skipping extras"
                );
                break;
            };
            let patch = TextBlockPatch {
                source_text: Some(v1.text.clone()),
                ..Default::default()
            };
            scene_ops.push(Op::UpdateTextBlock {
                page: ctx.page,
                id: node_id,
                patch,
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

/// Build a throwaway `koharu_types::Document` populated with the
/// page image + v1 TextBlocks reconstructed from the Scene. Used
/// only to drive the legacy `Model::ocr_with` API; non-image and
/// non-text-block fields stay at empty defaults.
fn build_tmp_document(
    image: image::DynamicImage,
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
        segment: None,
        inpainted: None,
        rendered: None,
        brush_layer: None,
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(Mit48pxOcrEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "MIT-48px OCR",
        description: "Default OCR — lightweight, multi-language recognizer. Handles printed manga text well; less reliable on stylised SFX + handwriting.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: Some(256),
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            weights_size_mb: 12,
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
        assert!(info.consumes.contains(&ArtifactKind::DetectionBoxes));
        assert!(info.produces.contains(&ArtifactKind::OcrText));
        assert!(info.cost.local);
    }
}
