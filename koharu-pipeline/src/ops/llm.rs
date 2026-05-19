use std::str::FromStr;

use koharu_api::commands::{IndexPayload, LlmGeneratePayload, LlmListPayload, LlmLoadPayload};
use koharu_core::{ArtifactKind, PipelineRunOptions, StoredValue};
use koharu_ml::llm::ModelId;
use koharu_ml::llm::facade as llm;
use strum::IntoEnumIterator;
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::{AppResources, engine_bridge, engines, state_tx};

// `state_tx` still used by `get_document_for_llm` below.

pub async fn llm_list(
    state: AppResources,
    payload: LlmListPayload,
) -> anyhow::Result<Vec<llm::ModelInfo>> {
    let mut models: Vec<ModelId> = ModelId::iter().collect();
    let cpu_factor = if state.llm.is_cpu() { 10 } else { 1 };
    let lang = payload.language.as_deref().unwrap_or("en");
    let zh_locale_factor = if lang.starts_with("zh") { 10 } else { 1 };
    let non_zh_en_locale_factor = if lang.starts_with("zh") || lang.starts_with("en") {
        1
    } else {
        100
    };

    models.sort_by_key(|m| match m {
        ModelId::VntlLlama3_8Bv2 => 100,
        ModelId::Lfm2_350mEnjpMt => 200 / cpu_factor,
        ModelId::SakuraGalTransl7Bv3_7 => 300 / zh_locale_factor,
        ModelId::Sakura1_5bQwen2_5v1_0 => 400 / zh_locale_factor / cpu_factor,
        ModelId::HunyuanMT7B => 500 / non_zh_en_locale_factor,
    });

    Ok(models.into_iter().map(llm::ModelInfo::new).collect())
}

#[instrument(level = "info", skip_all)]
pub async fn llm_load(state: AppResources, payload: LlmLoadPayload) -> anyhow::Result<()> {
    let id = ModelId::from_str(&payload.id)?;
    state.llm.load(id).await;
    Ok(())
}

pub async fn llm_offload(state: AppResources) -> anyhow::Result<()> {
    state.llm.offload().await;
    Ok(())
}

pub async fn llm_ready(state: AppResources) -> anyhow::Result<bool> {
    Ok(state.llm.ready().await)
}

#[instrument(level = "info", skip_all)]
pub async fn llm_generate(state: AppResources, payload: LlmGeneratePayload) -> anyhow::Result<()> {
    // F4.D: both whole-page AND single-block translate go through
    // the engine system. The `target_block_index` setting on
    // `local_llm_translate` controls the mode — missing/-1 ⇒
    // whole page, non-negative ⇒ that specific block. Phase 4.5's
    // `legacy_single_block_translate` is gone.
    let mut options = PipelineRunOptions::new();
    if let Some(lang) = payload.language.as_deref() {
        options = options.with("target_language", StoredValue::String(lang.to_string()));
    }
    if let Some(block_index) = payload.text_block_index {
        options = options.with(
            "target_block_index",
            StoredValue::Number(block_index as f64),
        );
    }
    engine_bridge::run_engine_for_artifact(
        &state,
        payload.index,
        ArtifactKind::Translation,
        engines::LOCAL_LLM_TRANSLATE_ID,
        options,
        engine_bridge::RunPolicy::default(),
        CancellationToken::new(),
    )
    .await
}

pub async fn get_document_for_llm(
    state: AppResources,
    payload: IndexPayload,
) -> anyhow::Result<koharu_types::Document> {
    state_tx::read_doc(&state.state, payload.index).await
}
