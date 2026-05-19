use koharu_api::commands::{DetectPayload, IndexPayload, OcrPayload, RenderPayload};
use koharu_core::{PipelineRunOptions, StoredValue};
use koharu_types::{DetectorEngine, OcrEngine};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::{AppResources, engine_bridge, engines, state_tx};

#[instrument(level = "info", skip_all)]
pub async fn detect(state: AppResources, payload: DetectPayload) -> anyhow::Result<()> {
    // Phase 4.2: Default detector goes through the new Engine system
    // via the engine_bridge; AnimeYolo still uses the legacy direct
    // call (will be ported in Phase 4.3). The split is by detector
    // engine choice — same external API surface (DetectPayload) so
    // no RPC churn.
    let detector = payload.detector_engine.unwrap_or_default();
    let (engine_id, options) = match detector {
        DetectorEngine::Default => (engines::COMIC_TEXT_DETECTOR_ID, PipelineRunOptions::new()),
        DetectorEngine::AnimeYolo => {
            // Bundle the per-call variant + confidence as engine
            // settings. PipelineRunOptions carries them through the
            // bridge → EngineCtx → `ctx.setting::<T>` chain so the
            // engine reads the same shape it would from a saved
            // profile.
            let mut opts = PipelineRunOptions::new();
            if let Some(variant) = payload.anime_yolo_variant {
                opts = opts.with(
                    "variant",
                    StoredValue::String(variant.as_str().to_string()),
                );
            }
            if let Some(confidence) = payload.anime_yolo_confidence {
                opts = opts.with(
                    "confidence_threshold",
                    StoredValue::Number(confidence as f64),
                );
            }
            (engines::ANIME_YOLO_DETECTOR_ID, opts)
        }
    };
    engine_bridge::run_engine_on_document(
        &state,
        payload.index,
        engine_id,
        options,
        engine_bridge::RunPolicy {
            clear_text_blocks_first: true,
        },
        CancellationToken::new(),
    )
    .await
}

#[instrument(level = "info", skip_all)]
pub async fn ocr(state: AppResources, payload: OcrPayload) -> anyhow::Result<()> {
    // Phase 4.3: both OCR variants go through the engine system.
    // Per-block UpdateTextBlock ops keep the bbox positions stable
    // (no clear_text_blocks_first — OCR augments existing blocks,
    // doesn't add new ones).
    let engine_id = match payload.ocr_engine.unwrap_or_default() {
        OcrEngine::Mit48px => engines::MIT48PX_OCR_ID,
        OcrEngine::Manga => engines::MANGA_OCR_ID,
    };
    engine_bridge::run_engine_on_document(
        &state,
        payload.index,
        engine_id,
        PipelineRunOptions::new(),
        engine_bridge::RunPolicy::default(),
        CancellationToken::new(),
    )
    .await
}

#[instrument(level = "info", skip_all)]
pub async fn inpaint(state: AppResources, payload: IndexPayload) -> anyhow::Result<()> {
    // Phase 4.4: LaMa inpaint goes through the engine system.
    // Same single-engine choice as before (no alternative inpaint
    // engine yet). AOT / Flux.2 Klein alternatives land in a
    // follow-up under the same `produces: [InpaintedImage]` slot.
    engine_bridge::run_engine_on_document(
        &state,
        payload.index,
        engines::LAMA_INPAINT_ID,
        PipelineRunOptions::new(),
        engine_bridge::RunPolicy::default(),
        CancellationToken::new(),
    )
    .await
}

#[instrument(level = "info", skip_all)]
pub async fn render(state: AppResources, payload: RenderPayload) -> anyhow::Result<()> {
    let mut updated = state_tx::read_doc(&state.state, payload.index).await?;

    state.renderer.render(
        &mut updated,
        payload.text_block_index,
        payload.shader_effect.unwrap_or_default(),
        payload.shader_stroke,
        payload.font_family.as_deref(),
    )?;

    state_tx::update_doc(&state.state, payload.index, updated).await
}

pub async fn list_font_families(state: AppResources) -> anyhow::Result<Vec<String>> {
    state.renderer.available_fonts()
}
