//! Project lifecycle operations (Phase 1).
//!
//! Translates between the wire-format payloads in `koharu_api` and the
//! `koharu_project::Project` handle held in `AppResources::project`.

use std::path::{Path, PathBuf};

use anyhow::Context;
use koharu_api::commands::{
    ChapterAddPayload, ChapterDto, ChapterIdPayload, ChapterUpdatePayload, ProjectCreatePayload,
    ProjectCreatePickerPayload, ProjectInfo, ProjectOpenPayload, SeriesMetaDto,
    SeriesMetaUpdatePayload,
};
use koharu_project::{
    chapter::{self as chapter_ops, ChapterInsert, ChapterPatch},
    series::{self as series_ops, SeriesMetaPatch},
    Chapter, ChapterStatus, Project, SeriesMeta, MANIFEST_FILENAME,
};
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

// ---------------------------------------------------------------
// series_meta + chapters (Phase 2)
// ---------------------------------------------------------------

pub async fn series_meta_get(state: AppResources) -> anyhow::Result<SeriesMetaDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<SeriesMetaDto> {
        let conn = project.pool().get()?;
        Ok(series_meta_to_dto(series_ops::get(&conn)?))
    })
    .await??;
    Ok(dto)
}

pub async fn series_meta_update(
    state: AppResources,
    payload: SeriesMetaUpdatePayload,
) -> anyhow::Result<SeriesMetaDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<SeriesMetaDto> {
        let patch = SeriesMetaPatch {
            title: payload.title,
            title_original: payload.title_original.map(Some),
            synopsis: payload.synopsis.map(Some),
            genre: payload.genre,
            target_audience: payload.target_audience.map(Some),
            source_language: payload.source_language,
            target_language: payload.target_language,
            tone: payload.tone.map(Some),
            formality_level: payload.formality_level.map(Some),
            style_notes: payload.style_notes.map(Some),
            cover_image: payload.cover_image.map(Some),
        };
        let conn = project.pool().get()?;
        Ok(series_meta_to_dto(series_ops::update(&conn, patch)?))
    })
    .await??;
    Ok(dto)
}

pub async fn chapters_list(state: AppResources) -> anyhow::Result<Vec<ChapterDto>> {
    let project = require_project(&state).await?;
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ChapterDto>> {
        let conn = project.pool().get()?;
        Ok(chapter_ops::list(&conn)?
            .into_iter()
            .map(chapter_to_dto)
            .collect())
    })
    .await??;
    Ok(list)
}

pub async fn chapter_add(
    state: AppResources,
    payload: ChapterAddPayload,
) -> anyhow::Result<ChapterDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<ChapterDto> {
        let conn = project.pool().get()?;
        let inserted = chapter_ops::insert(
            &conn,
            ChapterInsert {
                file_path: payload.file_path,
                chapter_number: payload.chapter_number,
                title: payload.title,
                volume: payload.volume,
            },
        )?;
        Ok(chapter_to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

pub async fn chapter_update(
    state: AppResources,
    payload: ChapterUpdatePayload,
) -> anyhow::Result<Option<ChapterDto>> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ChapterDto>> {
        let conn = project.pool().get()?;
        let patch = ChapterPatch {
            chapter_number: payload.chapter_number,
            title: payload.title.map(Some),
            volume: payload.volume.map(Some),
            status: payload
                .status
                .as_deref()
                .and_then(ChapterStatus::parse),
            summary: payload.summary.map(Some),
            notes: payload.notes.map(Some),
            page_count: payload.page_count,
        };
        Ok(chapter_ops::update(&conn, payload.id, patch)?.map(chapter_to_dto))
    })
    .await??;
    Ok(dto)
}

pub async fn chapter_remove(
    state: AppResources,
    payload: ChapterIdPayload,
) -> anyhow::Result<bool> {
    let project = require_project(&state).await?;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = project.pool().get()?;
        Ok(chapter_ops::remove(&conn, payload.id)?)
    })
    .await??;
    Ok(removed)
}

async fn require_project(state: &AppResources) -> anyhow::Result<Project> {
    state
        .project
        .read()
        .await
        .clone()
        .context("No project is currently open")
}

fn series_meta_to_dto(m: SeriesMeta) -> SeriesMetaDto {
    SeriesMetaDto {
        title: m.title,
        title_original: m.title_original,
        synopsis: m.synopsis,
        genre: m.genre,
        target_audience: m.target_audience,
        source_language: m.source_language,
        target_language: m.target_language,
        tone: m.tone,
        formality_level: m.formality_level,
        style_notes: m.style_notes,
        cover_image: m.cover_image,
        created_at: m.created_at.to_rfc3339(),
        updated_at: m.updated_at.to_rfc3339(),
    }
}

fn chapter_to_dto(c: Chapter) -> ChapterDto {
    ChapterDto {
        id: c.id,
        file_path: c.file_path,
        chapter_number: c.chapter_number,
        title: c.title,
        volume: c.volume,
        status: c.status.as_str().to_string(),
        summary: c.summary,
        notes: c.notes,
        page_count: c.page_count,
        created_at: c.created_at.to_rfc3339(),
        updated_at: c.updated_at.to_rfc3339(),
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
