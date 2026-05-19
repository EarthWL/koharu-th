use koharu_api::commands::{DetectPayload, IndexPayload, OcrPayload, RenderPayload};
use koharu_core::{ArtifactKind, PipelineRunOptions, StoredValue};
use koharu_types::{DetectorEngine, OcrEngine};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::{AppResources, engine_bridge, engines};

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
    // F4.D: render goes through the engine system. Per-call args
    // (target block index, shader stroke as JSON, full effect)
    // ride PipelineRunOptions — text_renderer engine reads them
    // alongside its user-tunable bold/italic toggles. Profile
    // overrides flow through `run_engine_for_artifact`'s built-in
    // merge.
    let mut options = PipelineRunOptions::new();
    if let Some(idx) = payload.text_block_index {
        options = options.with("target_block_index", StoredValue::Number(idx as f64));
    }
    if let Some(effect) = payload.shader_effect {
        // The schema-level Toggles cover the common case (set via
        // Engine Profile UI). When the payload explicitly carries
        // them — Render dialog passing them per call — they override
        // both the profile + the schema default via merge_profile_
        // settings' "caller wins" rule.
        options = options.with("effect_bold", StoredValue::Bool(effect.bold));
        options = options.with("effect_italic", StoredValue::Bool(effect.italic));
    }
    if let Some(stroke) = payload.shader_stroke {
        let json = serde_json::to_string(&stroke)
            .map_err(|e| anyhow::anyhow!("encoding stroke as JSON: {e}"))?;
        options = options.with("stroke_json", StoredValue::String(json));
    }
    if let Some(family) = payload.font_family {
        options = options.with("font_family", StoredValue::String(family));
    }
    engine_bridge::run_engine_for_artifact(
        &state,
        payload.index,
        ArtifactKind::RenderedImage,
        engines::TEXT_RENDERER_ID,
        options,
        engine_bridge::RunPolicy::default(),
        CancellationToken::new(),
    )
    .await
}

pub async fn list_font_families(state: AppResources) -> anyhow::Result<Vec<String>> {
    state.renderer.available_fonts()
}
