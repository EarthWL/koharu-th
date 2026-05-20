//! `manga_ocr` — Japanese-tuned OCR engine (mayocream/manga-ocr).
//!
//! Same `Engine` wrapper pattern as [`super::mit48px_ocr`], routed
//! through `koharu_ml::facade::Model::ocr_with(OcrEngine::Manga)`.
//! Lazy weights download (~100 MB) on first inference.
//!
//! ## ⚠ Inherits the legacy facade fallback (TODO)
//!
//! `Model::ocr_with(OcrEngine::Manga)` falls back to MIT-48px
//! silently if Manga OCR fails to load (e.g. network down for the
//! first-time weights fetch). The fallback is baked into the
//! facade — this engine wrapper invokes the facade and therefore
//! INHERITS that behaviour even though the engine description
//! claims a Manga-specific OCR pass.
//!
//! This is a known wart called out in the post-Phase-4.3 audit
//! (#5/F2). The right fix is a new `ml.ocr_with_strict(...)`
//! facade method that surfaces load failures instead of silently
//! degrading, then this engine calls that instead. Deferred until
//! a real user reports the surprise — for now the fallback is the
//! pre-v2 status quo and the docstring is the only behavioural
//! contract we can keep honest.
//!
//! Better at handwritten + stylised Japanese, sometimes worse at
//! SFX / latin script. Cost-wise still local (no spend), but the
//! first-call download warrants a yellow chip in the Profile UI.

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

pub const ENGINE_ID: &str = "manga_ocr";

const SETTINGS: &[SettingDescriptor] = &[];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::SourceImage, ArtifactKind::DetectionBoxes];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::OcrText];

pub struct MangaOcrEngine;

#[async_trait]
impl Engine for MangaOcrEngine {
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

        if page.text_blocks.is_empty() {
            return Ok(());
        }

        let bytes = ctx
            .blobs
            .get(page.source_image)
            .ok_or_else(|| anyhow!("source image blob {} missing", page.source_image.to_hex()))?;
        let image = image::load_from_memory(&bytes)
            .with_context(|| format!("decoding source image for page {:?}", ctx.page))?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        let mut tmp_doc = build_tmp_document(image, page);
        let block_ids: Vec<NodeId> = page.text_blocks.keys().copied().collect();

        // `OcrEngineKind::Manga` triggers the lazy weights download
        // on first call. ⚠ The legacy `ocr_with` falls back to
        // MIT-48px silently on download failure — and this wrapper
        // INHERITS that fallback because it goes through `ocr_with`
        // (Phase 4.3 audit F2). Surfacing the failure cleanly needs
        // a new `ocr_with_strict` facade method that doesn't degrade;
        // tracked in the module docstring.
        ctx.ml
            .ocr_with(&mut tmp_doc, OcrEngineKind::Manga)
            .await
            .context("ml.ocr_with(Manga) failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        let mut scene_ops: Vec<Op> = Vec::with_capacity(tmp_doc.text_blocks.len());
        for (i, v1) in tmp_doc.text_blocks.iter().enumerate() {
            let Some(node_id) = block_ids.get(i).copied() else {
                tracing::warn!(
                    block_index = i,
                    "manga-ocr produced more blocks than scene had; skipping extras"
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
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(MangaOcrEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Manga OCR (Japanese)",
        description: "Japanese-tuned recognizer (mayocream/manga-ocr). Better at handwritten + stylised JP text; ~100MB weights download on first use.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: Some(512),
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            weights_size_mb: 100,
        },
        cost: EngineCost::local(),
        is_default: false,
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
        assert_eq!(info.hardware.weights_size_mb, 100);
    }
}
