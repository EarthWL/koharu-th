//! Project lifecycle operations (Phase 1).
//!
//! Translates between the wire-format payloads in `koharu_api` and the
//! `koharu_project::Project` handle held in `AppResources::project`.

use std::path::{Path, PathBuf};

use anyhow::Context;
use koharu_api::commands::{
    ProjectCreatePayload, ProjectCreatePickerPayload, ProjectInfo, ProjectOpenPayload,
};
use koharu_project::{Project, MANIFEST_FILENAME};
use rfd::FileDialog;

use crate::AppResources;

const KOHARU_VERSION: &str = env!("CARGO_PKG_VERSION");

pub async fn project_create(
    state: AppResources,
    payload: ProjectCreatePayload,
) -> anyhow::Result<ProjectInfo> {
    let path = PathBuf::from(payload.path);
    let name = payload.name;
    let project = tokio::task::spawn_blocking(move || {
        Project::create(&path, name, KOHARU_VERSION)
            .with_context(|| format!("creating project at {}", path.display()))
    })
    .await??;

    let info = build_info(&project)?;
    *state.project.write().await = Some(project);
    Ok(info)
}

pub async fn project_create_picker(
    state: AppResources,
    payload: ProjectCreatePickerPayload,
) -> anyhow::Result<Option<ProjectInfo>> {
    let chosen = tokio::task::spawn_blocking(|| FileDialog::new().pick_folder()).await?;
    let Some(folder) = chosen else {
        return Ok(None);
    };

    // Folder picker lands on the *parent* — we make a sub-folder named
    // after the project so users don't accidentally co-mingle siblings.
    let name = payload.name;
    let root = folder.join(sanitize_folder_name(&name));
    let project = tokio::task::spawn_blocking({
        let root = root.clone();
        let name = name.clone();
        move || {
            Project::create(&root, name, KOHARU_VERSION)
                .with_context(|| format!("creating project at {}", root.display()))
        }
    })
    .await??;

    let info = build_info(&project)?;
    *state.project.write().await = Some(project);
    Ok(Some(info))
}

pub async fn project_open(
    state: AppResources,
    payload: ProjectOpenPayload,
) -> anyhow::Result<ProjectInfo> {
    let root = resolve_root(&PathBuf::from(payload.path));
    let project = tokio::task::spawn_blocking(move || {
        Project::open(&root).with_context(|| format!("opening project at {}", root.display()))
    })
    .await??;

    let info = build_info(&project)?;
    *state.project.write().await = Some(project);
    Ok(info)
}

pub async fn project_open_picker(state: AppResources) -> anyhow::Result<Option<ProjectInfo>> {
    let chosen = tokio::task::spawn_blocking(|| {
        FileDialog::new()
            .add_filter("Koharu project", &["koharuproj"])
            .pick_file()
    })
    .await?;
    let Some(file) = chosen else {
        return Ok(None);
    };

    let root = resolve_root(&file);
    let project = tokio::task::spawn_blocking(move || {
        Project::open(&root).with_context(|| format!("opening project at {}", root.display()))
    })
    .await??;

    let info = build_info(&project)?;
    *state.project.write().await = Some(project);
    Ok(Some(info))
}

pub async fn project_close(state: AppResources) -> anyhow::Result<()> {
    *state.project.write().await = None;
    Ok(())
}

pub async fn project_current(state: AppResources) -> anyhow::Result<Option<ProjectInfo>> {
    let guard = state.project.read().await;
    match guard.as_ref() {
        Some(project) => Ok(Some(build_info(project)?)),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

/// If `path` is the manifest file, return its parent directory;
/// otherwise assume `path` is already the project root.
fn resolve_root(path: &Path) -> PathBuf {
    if path.is_file() && path.file_name().and_then(|n| n.to_str()) == Some(MANIFEST_FILENAME) {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

/// Strip path separators and reserved characters from a project name so
/// it's safe to use as a folder name.
fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build a `ProjectInfo` snapshot from an open project. Counts come from
/// quick `SELECT COUNT(*)` queries against the project DB.
fn build_info(project: &Project) -> anyhow::Result<ProjectInfo> {
    let m = project.manifest();

    let conn = project.pool().get()?;
    let chapter_count: u32 = conn
        .query_row("SELECT COUNT(*) FROM chapters", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as u32;
    let character_count: u32 = conn
        .query_row("SELECT COUNT(*) FROM characters", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as u32;
    let glossary_count: u32 = conn
        .query_row("SELECT COUNT(*) FROM glossary", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as u32;

    Ok(ProjectInfo {
        root: project.root().to_string_lossy().into_owned(),
        id: m.id.to_string(),
        name: m.name.clone(),
        name_original: m.name_original.clone(),
        schema_version: m.schema_version,
        created_at: m.created_at.to_rfc3339(),
        updated_at: m.updated_at.to_rfc3339(),
        tags: m.tags.clone(),
        chapter_count,
        character_count,
        glossary_count,
    })
}
