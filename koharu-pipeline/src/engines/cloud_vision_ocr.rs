//! `cloud_vision_ocr` — a *pseudo* OCR engine.
//!
//! Cloud Vision OCR (sending each detected bubble crop to a
//! vision-capable LLM) is orchestrated entirely on the frontend
//! (`ui/lib/services/cloudOcr.ts`) — it isn't a real backend engine
//! yet (porting the 5-provider multimodal request building to Rust is
//! roadmap Tier B #3). We register it here ONLY so it appears in the
//! Engines tab's OCR group with a profile picker, giving the user one
//! place to pick "Cloud Vision OCR + which profile". The frontend reads
//! the engine profile to decide cloud-vs-local and which profile to use,
//! and intercepts BEFORE dispatching OCR to the backend — so `run` here
//! is never reached on the happy path. It bails loudly if it ever is
//! (e.g. a future code path dispatches it server-side by mistake).

use anyhow::Result;
use async_trait::async_trait;
use futures::future::BoxFuture;
use tokio::sync::mpsc;

use koharu_core::{
    ArtifactKind, BackendSupport, EngineCost, EngineResult, HardwareReq, SettingDescriptor,
};
use koharu_engines::{Engine, EngineCtx, EngineInfo, inventory};

/// Stable id used by the engine profile UI + saved profiles.
pub const ENGINE_ID: &str = "cloud_vision_ocr";

const SETTINGS: &[SettingDescriptor] = &[SettingDescriptor::ProfileSelect {
    id: "vision_profile",
    label_i18n_key: "engineSettings.cloudOcr.profile.label",
    vision_only: true,
    default: "active",
    help_i18n_key: Some("engineSettings.cloudOcr.profile.help"),
}];

const CONSUMES: &[ArtifactKind] = &[ArtifactKind::SourceImage, ArtifactKind::DetectionBoxes];
const PRODUCES: &[ArtifactKind] = &[ArtifactKind::OcrText];

pub struct CloudVisionOcrEngine;

#[async_trait]
impl Engine for CloudVisionOcrEngine {
    async fn run(&self, _ctx: EngineCtx<'_>, _ops_tx: mpsc::Sender<EngineResult>) -> Result<()> {
        anyhow::bail!(
            "cloud_vision_ocr is frontend-orchestrated (cloudOcr.ts) and must not be \
             dispatched to the backend engine bridge; the frontend should run the cloud \
             OCR path directly when this engine is the active OcrText engine"
        )
    }
}

fn load() -> BoxFuture<'static, Result<Box<dyn Engine>>> {
    Box::pin(async move { Ok::<Box<dyn Engine>, _>(Box::new(CloudVisionOcrEngine)) })
}

inventory::submit! {
    EngineInfo {
        id: ENGINE_ID,
        display_name: "Cloud Vision OCR",
        description: "Sends each detected bubble to a vision-capable LLM (per the chosen profile). Best quality, but every page costs tokens. Runs per-page from the app — batch falls back to a local OCR engine.",
        consumes: CONSUMES,
        produces: PRODUCES,
        settings_schema: SETTINGS,
        hardware: HardwareReq {
            // Cloud — no local GPU needed; runs anywhere with a network.
            min_vram_mb: None,
            prefers_compute_cap: None,
            backends: BackendSupport::any(),
            weights_size_mb: 0,
        },
        cost: EngineCost::cloud(0.01),
        is_default: false,
        load,
    }
}
