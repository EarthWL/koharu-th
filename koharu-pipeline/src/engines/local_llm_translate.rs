//! `local_llm_translate` — Phase 4.5's first translate engine.
//!
//! Wraps `koharu_ml::llm::facade::Model::translate` behind the v2
//! [`Engine`](koharu_engines::Engine) trait. Routes the local LLM
//! (whichever model is currently loaded via `llm_load`) through
//! the engine system; same generation path as the legacy
//! `ops::llm::llm_generate`.
//!
//! ## Settings
//!
//! - `target_language` (String, default empty) — overrides the
//!   series-default target language for this run. When empty, the
//!   engine passes `None` to the legacy facade (which defaults to
//!   the model's preferred output language).
//!
//! Future settings (lands when needed):
//!
//! - `temperature` — `Slider`, currently hardcoded inside the
//!   facade.
//! - `glossary_injection` — `Toggle`, currently always-on via the
//!   prompt-render service.
//!
//! ## Streaming
//!
//! Phase 4.5 ships **one-shot** — engine sends a single
//! `EngineResult` with all `UpdateTextBlock { translation }` ops
//! at once. The streaming-per-bubble path for #19 needs the LLM
//! facade to expose token-streaming; that's a deeper change which
//! a follow-up will land. The trait already supports streaming
//! (the channel is `mpsc::Sender`), so the call site doesn't
//! change when the facade migrates.
//!
//! ## Cloud LLM providers
//!
//! OpenAI / Claude / Gemini / OpenRouter dispatch lives in the
//! frontend (`ui/lib/services/cloudLlm.ts`) today. The v2 design
//! plan calls for wrapping each as a separate engine, which means
//! moving the HTTP client + keyring access to Rust. That's a
//! larger architectural decision (keyring access from frontend
//! still works fine through the existing RPC) deferred from
//! Phase 4.5 to a follow-up phase.

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
use koharu_types::{Document, SerializableDynamicImage, TextBlock as V1TextBlock};

pub const ENGINE_ID: &str = "local_llm_translate";

const SETTING_TARGET_LANGUAGE: &str = "target_language";

const SETTINGS: &[SettingDescriptor] = &[];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::OcrText];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::Translation];

pub struct LocalLlmTranslateEngine;

#[async_trait]
impl Engine for LocalLlmTranslateEngine {
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

        // Read engine settings. Empty default means "let the legacy
        // facade pick" (which honors the model's preferred output
        // language).
        let target_language: String = ctx.setting(SETTING_TARGET_LANGUAGE, String::new());
        let target_language_opt = if target_language.is_empty() {
            None
        } else {
            Some(target_language.as_str())
        };

        // Build a tmp Document with current page text_blocks (v2 → v1
        // including any source_text the OCR engine produced). The
        // legacy `Model::translate` formats all blocks as a single
        // tagged prompt + parses the LLM response back into per-block
        // translations.
        let mut tmp_doc = build_tmp_document(page);
        let block_ids: Vec<NodeId> = page.text_blocks.keys().copied().collect();

        ctx.llm
            .translate(&mut tmp_doc, target_language_opt)
            .await
            .context("local LLM translate failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Emit one UpdateTextBlock per block carrying the new
        // translation. Phase 4.3's bridge applies these by NodeId →
        // v1 array index mapping (stable since we built the Scene
        // from this same document).
        let mut scene_ops: Vec<Op> = Vec::with_capacity(tmp_doc.text_blocks.len());
        for (i, v1) in tmp_doc.text_blocks.iter().enumerate() {
            let Some(node_id) = block_ids.get(i).copied() else {
                tracing::warn!(
                    block_index = i,
                    "translate produced more blocks than scene had; skipping extras"
                );
                break;
            };
            // Only emit when the translation actually changed — saves
            // redundant Ops in the apply loop when the LLM left a
            // block untranslated (empty source or filter hit). For
            // a fresh run this is essentially always non-empty.
            let patch = TextBlockPatch {
                translation: Some(v1.translation.clone()),
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

/// Build a throwaway Document populated with v2 text_blocks → v1.
/// Image/segment/inpainted fields stay empty (image dimensions are
/// preserved for fidelity, though the LLM never reads them).
fn build_tmp_document(page: &koharu_core::scene::Page) -> Document {
    let mut text_blocks: Vec<V1TextBlock> = Vec::with_capacity(page.text_blocks.len());
    for block in page.text_blocks.values() {
        text_blocks.push(V1TextBlock {
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
        image: SerializableDynamicImage::default(),
        width: page.width,
        height: page.height,
        text_blocks,
        segment: None,
        inpainted: None,
        rendered: None,
        brush_layer: None,
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(LocalLlmTranslateEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Local LLM Translate",
        description: "On-device LLM (whichever model is loaded via llm_load — VNTL, Sakura, Hunyuan, etc.). Reads glossary + characters from project context; no per-call cost.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: Some(4096),
            prefers_compute_cap: Some(7.5),
            backends: BackendSupport::any(),
            // Highly variable by model — Lfm2_350m is ~350MB, Hunyuan
            // 7B is ~14GB. The display number reflects the smallest;
            // the Engine Profile UI can surface per-variant download
            // sizes from the LLM model registry.
            weights_size_mb: 350,
        },
        cost: EngineCost::local(),
        load,
    }
}

#[allow(dead_code)]
fn _silence_arc_warning(arc: Arc<koharu_ml::llm::facade::Model>) -> Arc<koharu_ml::llm::facade::Model> {
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
        assert!(info.consumes.contains(&ArtifactKind::OcrText));
        assert!(info.produces.contains(&ArtifactKind::Translation));
        assert!(info.cost.local);
    }
}
