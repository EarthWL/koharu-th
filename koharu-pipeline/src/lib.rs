#[cfg(test)]
mod dag_integration;
pub mod engine_bridge;
pub mod engine_profile;
pub mod engines;
pub mod operations;
pub mod ops;
pub mod pipeline;
pub mod state_tx;

use std::sync::Arc;

use koharu_core::BlobStore;
use koharu_ml::Device;
use koharu_project::Project;
use koharu_renderer::facade::Renderer;
use koharu_types::AppState;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppResources {
    pub state: AppState,
    /// Phase 2: content-addressed binary store. Every binary served
    /// to the frontend (page image, segment mask, inpainted, rendered,
    /// brush layer, future blobs) lands here keyed by its blake3
    /// hash. The HTTP `/blob/:hex` route in `koharu-rpc` reads from
    /// this store so the browser can fetch binaries with native
    /// caching + GPU-accelerated decode (see docs/v2-arch.md §5
    /// Phase 2 on main, credit #33).
    ///
    /// In-memory backing for now. On-disk backing in `<app-data>/
    /// Koharu/blobs/` lands later (probably Phase 4 alongside the
    /// engine system, when blobs need to survive process restart so
    /// re-renders can dedup against prior outputs).
    pub blobs: BlobStore,
    pub ml: Arc<koharu_ml::facade::Model>,
    pub llm: Arc<koharu_ml::llm::facade::Model>,
    pub renderer: Arc<Renderer>,
    pub device: Device,
    pub pipeline: Arc<RwLock<Option<pipeline::PipelineHandle>>>,
    /// Worker driving the persistent translation queue. None when no
    /// queue worker is currently running — `queue_ensure_running` starts
    /// one if needed (e.g. just after the user enqueues a new chapter,
    /// or on app start if there are leftover pending entries).
    pub queue_worker: Arc<RwLock<Option<ops::QueueWorkerHandle>>>,
    /// Currently-open series project, if any. None until the user creates
    /// or opens one via the project_* commands.
    pub project: Arc<RwLock<Option<Project>>>,
    /// Path of the recent-projects JSON file. Always inside
    /// <app-data>/Koharu/. Resolved at app startup so tests / headless
    /// runs can override it.
    pub recent_projects_path: std::path::PathBuf,
    /// `<app-data>/Koharu/libs` — runtime-downloaded CUDA + cuDNN
    /// dylibs. Owned by `ensure_dylibs`; the Storage panel reports
    /// size + offers to clear it. Set at app startup so the storage
    /// op doesn't have to re-derive the path.
    pub lib_root: std::path::PathBuf,
    /// `<app-data>/Koharu/models` — HuggingFace model cache (Anime
    /// YOLO, Manga OCR, etc.). Owned by koharu_ml's set_cache_dir.
    pub model_root: std::path::PathBuf,
    /// `<app-data>/Koharu/fonts` — user-dropped custom fonts. Reported
    /// in Storage panel with an extra-confirm warning since removing
    /// it loses user assets.
    pub font_root: std::path::PathBuf,
    /// Machine-wide engine profile (active engine per artifact slot
    /// + per-engine setting overrides). Persists to
    /// `<app-data>/Koharu/engine_profile.json`. F4.C ships storage +
    /// RPC + UI; F4.D wires the bridge to consume it (currently
    /// engine ids are still hardcoded at call-sites).
    pub engine_profile: engine_profile::EngineProfileStore,
    pub version: &'static str,
}
