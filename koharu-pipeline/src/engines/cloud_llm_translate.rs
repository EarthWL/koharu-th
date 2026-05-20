//! `cloud_llm_translate` — a *pseudo* translate engine.
//!
//! Cloud LLM translation (sending OCR'd text to a hosted provider) is
//! orchestrated on the frontend (`ui/lib/services/cloudLlm.ts`) and keyed
//! off the active provider profile (`preferencesStore.cloudProvider` /
//! `activeProfileId`), which is *also* used by chat / embeddings /
//! summaries — it's the app-wide "active cloud LLM", not a translate-only
//! setting. So unlike the local translate engine this isn't a real backend
//! engine; we register it ONLY so the Engines tab's Translation group can
//! show "Cloud LLM translate + which profile" alongside the local engine.
//!
//! The Engines tab Translation group is special-cased to read/write the
//! shared `cloudProvider` / `activeProfileId` prefs (the same state the
//! canvas toolbar's profile dropdown uses), so both UIs stay in sync and
//! the translate dispatch (which already reads `cloudProvider`) needs no
//! change. `run` bails if the bridge ever dispatches it server-side.

use anyhow::Result;
use async_trait::async_trait;
use futures::future::BoxFuture;
use tokio::sync::mpsc;

use koharu_core::{
    ArtifactKind, BackendSupport, EngineCost, EngineResult, HardwareReq, SettingDescriptor,
};
use koharu_engines::{Engine, EngineCtx, EngineInfo, inventory};

/// Stable id used by the engine profile UI + saved profiles.
pub const ENGINE_ID: &str = "cloud_llm_translate";

const SETTINGS: &[SettingDescriptor] = &[SettingDescriptor::ProfileSelect {
    id: "translate_profile",
    label_i18n_key: "engineSettings.cloudLlm.profile.label",
    vision_only: false,
    default: "active",
    help_i18n_key: Some("engineSettings.cloudLlm.profile.help"),
}];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::OcrText];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::Translation];

pub struct CloudLlmTranslateEngine;

#[async_trait]
impl Engine for CloudLlmTranslateEngine {
    async fn run(&self, _ctx: EngineCtx<'_>, _ops_tx: mpsc::Sender<EngineResult>) -> Result<()> {
        anyhow::bail!(
            "cloud_llm_translate is frontend-orchestrated (cloudLlm.ts) via the active \
             provider profile and must not be dispatched to the backend engine bridge"
        )
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(CloudLlmTranslateEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Cloud LLM Translate",
        description: "Translate via a hosted LLM (OpenAI / Claude / Gemini / OpenRouter) using the chosen provider profile. Higher quality on nuanced dialogue; costs tokens per page. The profile is shared with AI Chat and other cloud features.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            min_vram_mb: None,
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            weights_size_mb: 0,
        },
        cost: EngineCost::cloud(0.02),
        is_default: false,
        load,
    }
}
