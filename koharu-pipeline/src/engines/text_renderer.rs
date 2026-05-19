//! `text_renderer` — Phase 4.D's final engine port.
//!
//! Wraps `koharu_renderer::facade::Renderer::render` through the v2
//! Engine trait. Produces `RenderedImage` from a page that already
//! has `Translation` (i.e. `text_blocks[*].translation` populated).
//! The legacy `vision::render` call-site goes through the bridge
//! after this commit.
//!
//! ## Settings
//!
//! Two kinds of inputs cross this boundary:
//!
//! 1. **User-tunable defaults** exposed via `settingsSchema` for the
//!    Engine Profile UI:
//!    - `font_family` (String) — preferred font family; empty falls
//!      back to the renderer's auto-pick. SettingDescriptor uses
//!      a Select but the option list is dynamic per host (depends on
//!      installed fonts) so we ship it as a free-form String with
//!      an empty default; the renderer ignores unknown families.
//!    - `effect_bold` (Toggle) — apply bold to translated text.
//!    - `effect_italic` (Toggle) — apply italic.
//!
//! 2. **Per-call inputs** sent through `PipelineRunOptions` but NOT
//!    exposed in `settingsSchema` (they're invoke-time arguments,
//!    not user preferences). These ride the same options bag for
//!    plumbing convenience:
//!    - `target_block_index` (Number, optional) — render only this
//!      block. Missing = render all. Used by the canvas right-click
//!      "render this bubble" flow.
//!    - `stroke_json` (String, optional) — serialized
//!      `TextStrokeStyle`. Missing = no stroke. Encoded as JSON
//!      because the type has 4 RGBA bytes + an optional float
//!      width — doesn't fit a single `StoredValue` primitive.
//!
//! The hybrid approach (schema keys + internal keys) keeps the UI
//! simple while letting the existing render call-site pass complex
//! per-invocation data without a new sidecar parameter on the bridge.

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
use koharu_types::{
    Document, SerializableDynamicImage, TextBlock as V1TextBlock, TextShaderEffect,
    TextStrokeStyle,
};

pub const ENGINE_ID: &str = "text_renderer";

const SETTING_FONT_FAMILY: &str = "font_family";
const SETTING_EFFECT_BOLD: &str = "effect_bold";
const SETTING_EFFECT_ITALIC: &str = "effect_italic";
const SETTING_TARGET_BLOCK_INDEX: &str = "target_block_index";
const SETTING_STROKE_JSON: &str = "stroke_json";

const SETTINGS: &[SettingDescriptor] = &[
    SettingDescriptor::Toggle {
        id: SETTING_EFFECT_BOLD,
        label_i18n_key: "engineSettings.render.bold",
        default: false,
        help_i18n_key: Some("engineSettings.render.bold.help"),
    },
    SettingDescriptor::Toggle {
        id: SETTING_EFFECT_ITALIC,
        label_i18n_key: "engineSettings.render.italic",
        default: false,
        help_i18n_key: Some("engineSettings.render.italic.help"),
    },
    // `font_family` could be a Select with the dynamic font list
    // from `list_font_families` — but that list is host-specific
    // (depends on installed fonts + custom font drops) so the
    // schema can't carry it as a `&'static` Select. The Engine
    // Profile UI renders this as a free-form String; the user
    // types the family name (e.g. "Noto Sans Thai"). Future
    // work: a dynamic-options SettingDescriptor variant.
];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::Translation, ArtifactKind::InpaintedImage];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::RenderedImage];

pub struct TextRendererEngine;

#[async_trait]
impl Engine for TextRendererEngine {
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

        let image_bytes = ctx
            .blobs
            .get(page.source_image)
            .ok_or_else(|| anyhow!("source image blob {} missing", page.source_image.to_hex()))?;
        let image = image::load_from_memory(&image_bytes)
            .context("decoding source image")?;

        // Optional inpainted background — when present the renderer
        // composites on top of it; when absent it falls through to
        // a white-bubble fill (legacy behaviour).
        let inpainted = if let Some(blob_id) = page.inpainted_image {
            let bytes = ctx
                .blobs
                .get(blob_id)
                .ok_or_else(|| anyhow!("inpainted blob {} missing", blob_id.to_hex()))?;
            Some(image::load_from_memory(&bytes).context("decoding inpainted")?)
        } else {
            None
        };

        // Settings.
        let font_family: String = ctx.setting(SETTING_FONT_FAMILY, String::new());
        let font_family_opt = if font_family.is_empty() {
            None
        } else {
            Some(font_family)
        };
        let effect_bold: bool = ctx.setting(SETTING_EFFECT_BOLD, false);
        let effect_italic: bool = ctx.setting(SETTING_EFFECT_ITALIC, false);
        let effect = TextShaderEffect {
            bold: effect_bold,
            italic: effect_italic,
        };

        // Per-call inputs (not in user-facing schema).
        let target_block_raw: f64 = ctx.setting(SETTING_TARGET_BLOCK_INDEX, -1.0);
        let target_block_index: Option<usize> = if target_block_raw >= 0.0 {
            Some(target_block_raw as usize)
        } else {
            None
        };
        let stroke_json: String = ctx.setting(SETTING_STROKE_JSON, String::new());
        let stroke: Option<TextStrokeStyle> = if stroke_json.is_empty() {
            None
        } else {
            serde_json::from_str(&stroke_json)
                .with_context(|| format!("parsing stroke_json: {stroke_json}"))?
        };

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Build a tmp Document with image + inpainted + v2→v1
        // text_blocks (renderer reads `translation` per block).
        let mut tmp_doc = build_tmp_document(image, inpainted, page);

        ctx.renderer
            .render(
                &mut tmp_doc,
                target_block_index,
                effect,
                stroke,
                font_family_opt.as_deref(),
            )
            .context("renderer.render failed")?;

        if ctx.cancel.is_cancelled() {
            return Ok(());
        }

        // Renderer writes the composite to `doc.rendered`. Encode
        // as PNG, register in BlobStore, emit Op::SetRenderedImage.
        let rendered = tmp_doc
            .rendered
            .ok_or_else(|| anyhow!("renderer returned without setting doc.rendered"))?;
        let rendered_dyn: image::DynamicImage = rendered.into();
        let mut buf: Vec<u8> = Vec::new();
        rendered_dyn
            .write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png)
            .context("encoding rendered image to PNG")?;
        let rendered_id = ctx.blobs.put(buf);

        ops_tx
            .send(EngineResult {
                scene_ops: vec![Op::SetRenderedImage {
                    page: ctx.page,
                    image: Some(rendered_id),
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
    inpainted: Option<image::DynamicImage>,
    page: &koharu_core::scene::Page,
) -> Document {
    let (width, height) = (page.width, page.height);
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
        image: SerializableDynamicImage::from(image),
        width,
        height,
        text_blocks,
        segment: None,
        inpainted: inpainted.map(SerializableDynamicImage::from),
        rendered: None,
        brush_layer: None,
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(TextRendererEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Text Renderer",
        description: "Layout + rasterize translated text over the inpainted page. Reads font_family + bold/italic from settings; canvas right-click + per-call payload override the rest.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: None,
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            weights_size_mb: 0,
        },
        cost: EngineCost::local(),
        load,
    }
}

#[allow(dead_code)]
fn _silence_arc_warning(arc: Arc<koharu_renderer::facade::Renderer>) -> Arc<koharu_renderer::facade::Renderer> {
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
        assert!(info.produces.contains(&ArtifactKind::RenderedImage));
        assert!(info.consumes.contains(&ArtifactKind::Translation));
        assert!(info.cost.local);
        // 3 user-facing settings: bold + italic + (font_family is
        // not in the schema currently — host-specific list). Will
        // grow to 3 once dynamic-options SettingDescriptor lands.
        assert_eq!(info.settings_schema.len(), 2);
    }
}
