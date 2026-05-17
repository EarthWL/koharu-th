pub mod operations;
pub mod ops;
pub mod pipeline;
pub mod state_tx;

use std::sync::Arc;

use koharu_ml::Device;
use koharu_project::Project;
use koharu_renderer::facade::Renderer;
use koharu_types::AppState;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppResources {
    pub state: AppState,
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
    pub version: &'static str,
}
