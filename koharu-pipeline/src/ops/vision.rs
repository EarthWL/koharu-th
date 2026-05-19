use koharu_api::commands::{DetectPayload, IndexPayload, OcrPayload, RenderPayload};
use koharu_core::PipelineRunOptions;
use koharu_types::DetectorEngine;
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
    match detector {
        DetectorEngine::Default => {
            engine_bridge::run_engine_on_document(
                &state,
                payload.index,
                engines::COMIC_TEXT_DETECTOR_ID,
                PipelineRunOptions::new(),
                engine_bridge::RunPolicy {
                    clear_text_blocks_first: true,
                },
                CancellationToken::new(),
            )
            .await
        }
        DetectorEngine::AnimeYolo => {
            // Legacy direct call kept until Phase 4.3 ports Anime
            // YOLO as its own engine. State_tx round-trip preserves
            // the original mutate-Document shape.
            let mut snapshot = state_tx::read_doc(&state.state, payload.index).await?;
            state
                .ml
                .detect_with(
                    &mut snapshot,
                    DetectorEngine::AnimeYolo,
                    payload.anime_yolo_variant,
                    payload.anime_yolo_confidence,
                )
                .await?;
            state_tx::update_doc(&state.state, payload.index, snapshot).await
        }
    }
}

#[instrument(level = "info", skip_all)]
pub async fn ocr(state: AppResources, payload: OcrPayload) -> anyhow::Result<()> {
    let mut snapshot = state_tx::read_doc(&state.state, payload.index).await?;
    state
        .ml
        .ocr_with(&mut snapshot, payload.ocr_engine.unwrap_or_default())
        .await?;
    state_tx::update_doc(&state.state, payload.index, snapshot).await
}

#[instrument(level = "info", skip_all)]
pub async fn inpaint(state: AppResources, payload: IndexPayload) -> anyhow::Result<()> {
    let mut snapshot = state_tx::read_doc(&state.state, payload.index).await?;
    state.ml.inpaint(&mut snapshot).await?;
    state_tx::update_doc(&state.state, payload.index, snapshot).await
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
