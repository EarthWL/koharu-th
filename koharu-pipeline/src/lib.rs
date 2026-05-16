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
    /// Currently-open series project, if any. None until the user creates
    /// or opens one via the project_* commands.
    pub project: Arc<RwLock<Option<Project>>>,
    /// Path of the recent-projects JSON file. Always inside
    /// <app-data>/Koharu/. Resolved at app startup so tests / headless
    /// runs can override it.
    pub recent_projects_path: std::path::PathBuf,
    pub version: &'static str,
}
