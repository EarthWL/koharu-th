use koharu_api::commands::{DetectPayload, IndexPayload, OcrPayload, RenderPayload};
use koharu_core::{ArtifactKind, PipelineRunOptions, StoredValue};
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
    // F4.D: the user's saved active-engine choice drives this when
    // the payload doesn't override it. `payload.detector_engine`
    // (set by the legacy "select detector" UI knob) still wins for
    // backward compatibility — that path lets a caller force a
    // detector for one-off runs. When the payload leaves it unset
    // (e.g. the new Engine Profile UI dispatches a plain detect),
    // we let `run_engine_for_artifact` resolve via the profile.
    let (engine_id_opt, options) = match payload.detector_engine {
        Some(DetectorEngine::Default) => {
            (Some(engines::COMIC_TEXT_DETECTOR_ID), PipelineRunOptions::new())
        }
        Some(DetectorEngine::AnimeYolo) => {
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
            (Some(engines::ANIME_YOLO_DETECTOR_ID), opts)
        }
        None => (None, PipelineRunOptions::new()),
    };
    let policy = engine_bridge::RunPolicy {
        clear_text_blocks_first: true,
    };
    match engine_id_opt {
        Some(forced_id) => {
            engine_bridge::run_engine_on_document(
                &state,
                payload.index,
                forced_id,
                options,
                policy,
                CancellationToken::new(),
            )
            .await
        }
        None => {
            engine_bridge::run_engine_for_artifact(
                &state,
                payload.index,
                ArtifactKind::DetectionBoxes,
                engines::COMIC_TEXT_DETECTOR_ID,
                options,
                policy,
                CancellationToken::new(),
            )
            .await
        }
    }
}

#[instrument(level = "info", skip_all)]
pub async fn ocr(state: AppResources, payload: OcrPayload) -> anyhow::Result<()> {
    // F4.D: payload-forced choice overrides the profile (backward
    // compat with the "select OCR engine" UI knob); otherwise the
    // active OcrText engine from the saved profile drives.
    match payload.ocr_engine {
        Some(forced) => {
            let engine_id = match forced {
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
        None => {
            engine_bridge::run_engine_for_artifact(
                &state,
                payload.index,
                ArtifactKind::OcrText,
                engines::MIT48PX_OCR_ID,
                PipelineRunOptions::new(),
                engine_bridge::RunPolicy::default(),
                CancellationToken::new(),
            )
            .await
        }
    }
}

#[instrument(level = "info", skip_all)]
pub async fn inpaint(state: AppResources, payload: IndexPayload) -> anyhow::Result<()> {
    // F4.D: routes through profile-aware artifact resolution.
    // LaMa stays the default when no override exists; AOT /
    // Flux.2 Klein alternatives will be picked via the profile
    // once they're ported.
    engine_bridge::run_engine_for_artifact(
        &state,
        payload.index,
        ArtifactKind::InpaintedImage,
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
