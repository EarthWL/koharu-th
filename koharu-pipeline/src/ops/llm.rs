use std::str::FromStr;

use koharu_api::commands::{IndexPayload, LlmGeneratePayload, LlmListPayload, LlmLoadPayload};
use koharu_core::{ArtifactKind, PipelineRunOptions, StoredValue};
use koharu_ml::llm::ModelId;
use koharu_ml::llm::facade as llm;
use strum::IntoEnumIterator;
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::{AppResources, engine_bridge, engines, state_tx};

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
    // Phase 4.5: whole-page translate goes through the engine
    // system. Single-block translate (`text_block_index` set)
    // stays on the legacy direct call for now — the engine works
    // page-at-a-time (consumes the whole text_blocks vec to format
    // a single tagged prompt), so single-block re-translate is a
    // narrower path that doesn't fit the engine surface yet.
    // Phase 4.6 will land a per-block translate engine variant.
    if payload.text_block_index.is_some() {
        return legacy_single_block_translate(state, payload).await;
    }

    let mut options = PipelineRunOptions::new();
    if let Some(lang) = payload.language.as_deref() {
        options = options.with("target_language", StoredValue::String(lang.to_string()));
    }
    // F4.D: profile picks the Translation-slot engine. Only one
    // translate engine exists today (local_llm_translate) — cloud
    // providers, once moved server-side, will appear here as
    // additional candidates that the profile can switch between.
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

/// Single-block translate kept on the legacy direct call until
/// Phase 4.6 lands a per-block engine variant. Re-translate flow
/// from the canvas right-click menu hits this.
async fn legacy_single_block_translate(
    state: AppResources,
    payload: LlmGeneratePayload,
) -> anyhow::Result<()> {
    let mut updated = state_tx::read_doc(&state.state, payload.index).await?;
    let target_language = payload.language.as_deref();
    let block_index = payload
        .text_block_index
        .expect("caller guard: text_block_index must be Some");
    let text_block = updated
        .text_blocks
        .get_mut(block_index)
        .ok_or_else(|| anyhow::anyhow!("Text block not found"))?;
    state.llm.translate(text_block, target_language).await?;
    state_tx::update_doc(&state.state, payload.index, updated).await
}

pub async fn get_document_for_llm(
    state: AppResources,
    payload: IndexPayload,
) -> anyhow::Result<koharu_types::Document> {
    state_tx::read_doc(&state.state, payload.index).await
}
