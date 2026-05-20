//! Project lifecycle operations (Phase 1).
//!
//! Translates between the wire-format payloads in `koharu_api` and the
//! `koharu_project::Project` handle held in `AppResources::project`.

use std::path::{Path, PathBuf};

use anyhow::Context;
use koharu_api::commands::{
    ChapterAddPagesPayload, ChapterCreatePayload, ChapterDto, ChapterIdPayload,
    ChapterImportResult, ChapterUpdatePayload,
    CharacterAddPayload,
    CharacterDto, CharacterIdPayload, CharacterUpdatePayload, GlossaryAddPayload,
    GlossaryBumpUsagePayload, GlossaryDto, GlossaryIdPayload, GlossaryUpdatePayload,
    GlossaryBulkAddPayload, GlossaryBulkAddResult, LlmCallLogPayload, LlmCostStats,
    NameAliasDto, ProjectBackupResult, ProjectCreatePayload, RecentProjectDto,
    RecentProjectRemovePayload,
    ProjectCreatePickerPayload, ProjectInfo, ProjectOpenPayload, PromptRenderPayload,
    PromptRenderResult, PromptTemplateAddPayload, PromptTemplateDto, PromptTemplateIdPayload,
    PromptTemplateUpdatePayload, ProviderProfileAddPayload, ProviderProfileDto,
    ProviderProfileIdPayload, ProviderProfileSecret, ProviderProfileUpdatePayload,
    SeriesMetaDto, SeriesMetaUpdatePayload, TmEntryDto, TmFuzzyHit, TmInsertPayload,
    TmLookupFuzzyPayload, TmLookupPayload,
};
use koharu_project::{
    backup as backup_ops,
    chapter::{self as chapter_ops, ChapterInsert, ChapterPatch},
    character::{self as character_ops, CharacterInsert, CharacterPatch},
    glossary::{self as glossary_ops, GlossaryInsert, GlossaryPatch},
    profile::{self as profile_ops, ProfileInsert, ProfilePatch},
    prompt::{self as prompt_ops, PromptTemplateInsert, PromptTemplatePatch},
    recent::{self as recent_ops, RecentProject},
    secret as secret_ops,
    series::{self as series_ops, SeriesMetaPatch},
    tm::{self as tm_ops, TmEntry, TmInsert as TmInsertItem},
    Chapter, ChapterStatus, Character, Confidence, GlossaryCategory, GlossaryEntry, NameAlias,
    Project, PromptTemplate, PromptUseCase, Provider, ProviderProfile, SeriesMeta,
    MANIFEST_FILENAME,
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
    push_recent_safe(&state, &project);
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
    push_recent_safe(&state, &project);
    *state.project.write().await = Some(project);
    Ok(Some(info))
}

pub async fn project_open(
    state: AppResources,
    payload: ProjectOpenPayload,
) -> anyhow::Result<ProjectInfo> {
    let root = resolve_root(&PathBuf::from(payload.path));
    let project = open_with_migration_gate(root).await?;
    let info = build_info(&project)?;
    push_recent_safe(&state, &project);
    *state.project.write().await = Some(project);
    after_project_open(state).await;
    Ok(info)
}

/// Phase 6.2 + audit #8/P2 — wraps `Project::open` with the v1→v2
/// migration confirm dialog. Both the path-based `project_open`
/// and the file-picker `project_open_picker` route through this
/// so the consent gate can't be bypassed by which entry point the
/// frontend calls.
///
/// 1. `peek_migration` looks at the manifest without opening anything.
/// 2. If v1 detected → rfd::MessageDialog confirm; reject bails.
/// 3. `Project::open` runs the actual migration in its pre/post hooks.
async fn open_with_migration_gate(root: PathBuf) -> anyhow::Result<Project> {
    let preview = {
        let root = root.clone();
        tokio::task::spawn_blocking(move || koharu_project::migration::peek_migration(&root))
            .await??
    };
    if let Some(preview) = preview {
        let approved = ask_confirm_migration(&preview).await;
        if !approved {
            anyhow::bail!(
                "v1 → v2 migration cancelled by user (project '{}' kept at v1; \
                 reopen with v2 binary when ready to migrate)",
                preview.project_name,
            );
        }
    }
    tokio::task::spawn_blocking(move || {
        Project::open(&root).with_context(|| format!("opening project at {}", root.display()))
    })
    .await?
}

/// Phase 6.2 — show the v1→v2 confirm dialog. Returns `true` if
/// the user clicked "Migrate", `false` if they cancelled or
/// dismissed the dialog. rfd's MessageDialog is sync + blocking
/// so we wrap in `spawn_blocking`.
async fn ask_confirm_migration(preview: &koharu_project::migration::MigrationPreview) -> bool {
    let preview = preview.clone();
    tokio::task::spawn_blocking(move || {
        let message = format!(
            "Upgrading \"{name}\" to project format v2\n\n\
             A backup of the current database will be saved to:\n  {backup}\n\n\
             This migration is reversible — opening this project with v1.x \
             binary will use the .bak file. The new format unlocks the v2 \
             engine system + undo/redo.\n\n\
             Migrate and open?",
            name = preview.project_name,
            backup = preview.backup_path.display(),
        );
        match rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Info)
            .set_title("Koharu — Project format upgrade")
            .set_description(&message)
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
        {
            rfd::MessageDialogResult::Yes => true,
            _ => false,
        }
    })
    .await
    .unwrap_or(false)
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
    let project = open_with_migration_gate(root).await?;

    let info = build_info(&project)?;
    push_recent_safe(&state, &project);
    *state.project.write().await = Some(project);
    after_project_open(state).await;
    Ok(Some(info))
}

/// Recovery hook fired whenever a project opens: reset any queue entry
/// stuck in `running` (we crashed mid-pipeline last session) and kick
/// the worker if there are pending entries left over.
async fn after_project_open(state: AppResources) {
    let project = match state.project.read().await.clone() {
        Some(p) => p,
        None => return,
    };
    // Reset orphaned 'running' rows back to 'pending' so the worker
    // will pick them up. Best-effort — log and continue on failure.
    let p = project.clone();
    let reset = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        let conn = p.pool().get()?;
        Ok(koharu_project::queue::reset_orphan_running(&conn)?)
    })
    .await;
    match reset {
        Ok(Ok(n)) if n > 0 => {
            tracing::info!(reset_count = n, "queue: re-queued orphaned running entries");
        }
        Ok(Ok(_)) => {}
        Ok(Err(err)) => {
            tracing::warn!("queue: failed to reset orphan running entries: {err:#}");
        }
        Err(err) => {
            tracing::warn!("queue: orphan-reset task panicked: {err}");
        }
    }
    if let Err(err) = super::queue_ensure_running(state).await {
        tracing::warn!("queue: ensure_running on project open failed: {err:#}");
    }
}

/// Push the now-open project to the top of the recent-projects list.
/// Best-effort: a write failure is logged but never aborts the open.
fn push_recent_safe(state: &AppResources, project: &Project) {
    let entry = RecentProject {
        path: project.root().to_path_buf(),
        name: project.manifest().name.clone(),
        last_opened_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    };
    if let Err(err) = recent_ops::push(&state.recent_projects_path, entry) {
        tracing::warn!(?err, "recent_projects push failed");
    }
}

pub async fn recent_projects_list(
    state: AppResources,
) -> anyhow::Result<Vec<RecentProjectDto>> {
    let path = state.recent_projects_path.clone();
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<RecentProjectDto>> {
        Ok(recent_ops::list(&path)?
            .into_iter()
            .map(|r| RecentProjectDto {
                path: r.path.to_string_lossy().into_owned(),
                name: r.name,
                last_opened_at: r.last_opened_at,
            })
            .collect())
    })
    .await??;
    Ok(list)
}

pub async fn recent_projects_remove(
    state: AppResources,
    payload: RecentProjectRemovePayload,
) -> anyhow::Result<bool> {
    let store = state.recent_projects_path.clone();
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        Ok(recent_ops::remove(&store, std::path::Path::new(&payload.path))?)
    })
    .await??;
    Ok(removed)
}

pub async fn project_backup_picker(
    state: AppResources,
) -> anyhow::Result<ProjectBackupResult> {
    let project = require_project(&state).await?;
    let manifest_name = project.manifest().name.clone();

    let suggested = sanitize_folder_name(&format!(
        "{}-backup-{}",
        manifest_name,
        chrono_like_yyyymmdd_hhmm()
    ));

    let chosen = tokio::task::spawn_blocking(move || {
        FileDialog::new()
            .add_filter("Zip archive", &["zip"])
            .set_file_name(&format!("{suggested}.zip"))
            .save_file()
    })
    .await?;
    let Some(out_zip) = chosen else {
        return Ok(ProjectBackupResult {
            path: None,
            file_count: 0,
        });
    };

    let project2 = project.clone();
    let out_zip2 = out_zip.clone();
    let count = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        Ok(backup_ops::backup_to(project2.root(), &out_zip2)?)
    })
    .await??;

    Ok(ProjectBackupResult {
        path: Some(out_zip.to_string_lossy().into_owned()),
        file_count: count as u32,
    })
}

/// Tiny standalone timestamp formatter (yyyymmdd_HHMM in local time)
/// — avoids pulling chrono into koharu-pipeline just for this.
fn chrono_like_yyyymmdd_hhmm() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Local-time approximation: just use UTC. Filenames don't need to
    // be perfectly local-time accurate.
    let days = secs / 86_400;
    let mut year = 1970i64;
    let mut remaining = days;
    loop {
        let leap = is_leap(year);
        let dy = if leap { 366 } else { 365 };
        if remaining < dy {
            break;
        }
        remaining -= dy;
        year += 1;
    }
    let month_days = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 0usize;
    let mut day = remaining;
    while month < 12 && day >= month_days[month] as i64 {
        day -= month_days[month] as i64;
        month += 1;
    }
    let h = (secs % 86_400) / 3600;
    let m = (secs % 3600) / 60;
    format!("{:04}{:02}{:02}-{:02}{:02}", year, month + 1, day + 1, h, m)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

pub async fn project_close(state: AppResources) -> anyhow::Result<()> {
    *state.project.write().await = None;
    // Phase 5.5: closing the project also wipes the v2 session
    // (history doesn't survive project close; per-chapter scope).
    state.session.write().await.clear();
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

/// Create a chapter: mint a folder name, make `<chapters>/<name>/source`
/// + `.../render` subfolders, and insert a DB row pointing at the
/// folder. No page files are copied here — `chapter_add_pages` does that.
pub async fn chapter_create(
    state: AppResources,
    payload: ChapterCreatePayload,
) -> anyhow::Result<ChapterDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<ChapterDto> {
        let chapters_dir = project.chapters_dir();
        std::fs::create_dir_all(&chapters_dir).ok();

        let base = chapter_ops::folder_name_for(payload.chapter_number, payload.title.as_deref());
        let dedup = chapter_ops::dedupe_folder_name(&chapters_dir, &base);
        chapter_ops::create_chapter_folder(&chapters_dir, &dedup)?;
        let rel = format!("chapters/{dedup}");

        let conn = project.pool().get()?;
        let inserted = chapter_ops::insert(
            &conn,
            ChapterInsert {
                folder_path: rel,
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

/// Open a file picker, let the user pick page image / .khr files, and
/// copy them into the given chapter's `source/` subfolder. Refreshes
/// `page_count` afterwards.
pub async fn chapter_add_pages(
    state: AppResources,
    payload: ChapterAddPagesPayload,
) -> anyhow::Result<ChapterImportResult> {
    let project = require_project(&state).await?;

    let chosen = tokio::task::spawn_blocking(|| {
        FileDialog::new()
            .add_filter("Page files", chapter_ops::PAGE_EXTENSIONS)
            .pick_files()
    })
    .await?;
    let Some(files) = chosen else {
        return Ok(ChapterImportResult {
            added: 0,
            skipped: 0,
        });
    };

    let chapter_id = payload.chapter_id;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<ChapterImportResult> {
        let conn = project.pool().get()?;
        let chapter = chapter_ops::get(&conn, chapter_id)?
            .ok_or_else(|| anyhow::anyhow!("chapter {chapter_id} not found"))?;
        let source_dir = project
            .root()
            .join(&chapter.folder_path)
            .join(chapter_ops::SOURCE_SUBDIR);
        std::fs::create_dir_all(&source_dir).ok();

        let mut added = 0u32;
        let mut skipped = 0u32;
        for src in files {
            let Some(name) = src.file_name().and_then(|s| s.to_str()) else {
                skipped += 1;
                continue;
            };
            let dest_name = dedupe_in_dir(&source_dir, name);
            let dest = source_dir.join(&dest_name);
            if let Err(err) = std::fs::copy(&src, &dest) {
                tracing::warn!(?err, ?src, ?dest, "page copy failed");
                skipped += 1;
                continue;
            }
            added += 1;
        }

        let _ = chapter_ops::refresh_page_count(&conn, project.root(), chapter_id);

        Ok(ChapterImportResult { added, skipped })
    })
    .await??;
    Ok(result)
}

/// Programmatic variant of `chapter_add_pages` for callers (MCP /
/// scripts) that can't drive the file picker. Takes absolute source
/// paths, copies each into the chapter's `source/` subfolder, and
/// refreshes `page_count`.
pub async fn chapter_add_pages_from_paths(
    state: AppResources,
    chapter_id: i64,
    paths: Vec<PathBuf>,
) -> anyhow::Result<ChapterImportResult> {
    let project = require_project(&state).await?;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<ChapterImportResult> {
        let conn = project.pool().get()?;
        let chapter = chapter_ops::get(&conn, chapter_id)?
            .ok_or_else(|| anyhow::anyhow!("chapter {chapter_id} not found"))?;
        let source_dir = project
            .root()
            .join(&chapter.folder_path)
            .join(chapter_ops::SOURCE_SUBDIR);
        std::fs::create_dir_all(&source_dir).ok();

        let mut added = 0u32;
        let mut skipped = 0u32;
        for src in paths {
            let Some(name) = src.file_name().and_then(|s| s.to_str()) else {
                skipped += 1;
                continue;
            };
            let dest_name = dedupe_in_dir(&source_dir, name);
            let dest = source_dir.join(&dest_name);
            if let Err(err) = std::fs::copy(&src, &dest) {
                tracing::warn!(?err, ?src, ?dest, "page copy failed");
                skipped += 1;
                continue;
            }
            added += 1;
        }

        let _ = chapter_ops::refresh_page_count(&conn, project.root(), chapter_id);
        Ok(ChapterImportResult { added, skipped })
    })
    .await??;
    Ok(result)
}

/// Pick a filename that doesn't collide with anything already in
/// `dir`. Appends "-2", "-3", ... before the extension.
fn dedupe_in_dir(dir: &std::path::Path, name: &str) -> String {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    for n in 2..=9999 {
        let cand = format!("{stem}-{n}{ext}");
        if !dir.join(&cand).exists() {
            return cand;
        }
    }
    // Astronomically unlikely fallback when 9998 dedupe attempts collide.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{stem}-{ts}{ext}")
}

/// Read a single page from a chapter's `source/` subfolder, by index
/// in the sorted-by-filename order. Does NOT mutate any state — useful
/// for the AI Chat's vision tools that need to look at any page of any
/// chapter without disturbing what the human is currently editing.
pub async fn chapter_get_page_bytes(
    state: AppResources,
    payload: koharu_api::commands::ChapterPagePayload,
) -> anyhow::Result<koharu_api::commands::ChapterPageBytes> {
    let project = require_project(&state).await?;
    let result = tokio::task::spawn_blocking(
        move || -> anyhow::Result<koharu_api::commands::ChapterPageBytes> {
            let conn = project.pool().get()?;
            let chapter = chapter_ops::get(&conn, payload.chapter_id)?.ok_or_else(|| {
                anyhow::anyhow!("chapter {} not found", payload.chapter_id)
            })?;
            let pages = chapter_ops::list_source_pages(project.root(), &chapter)?;
            let total = pages.len();
            if payload.page_index >= total {
                anyhow::bail!(
                    "page index {} out of range (chapter {} has {} pages)",
                    payload.page_index,
                    payload.chapter_id,
                    total
                );
            }
            let path = &pages[payload.page_index];
            let data = std::fs::read(path)
                .map_err(|e| anyhow::anyhow!("read {}: {}", path.display(), e))?;
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("page")
                .to_string();
            Ok(koharu_api::commands::ChapterPageBytes {
                data,
                filename,
                page_index: payload.page_index,
                total_pages: total,
            })
        },
    )
    .await??;
    Ok(result)
}

/// Open all pages from a chapter's `source/` subfolder into the editor.
/// Replaces the currently-loaded documents.
pub async fn chapter_open(
    state: AppResources,
    payload: ChapterIdPayload,
) -> anyhow::Result<usize> {
    let project = require_project(&state).await?;

    let loaded = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<(PathBuf, Vec<u8>)>> {
        let conn = project.pool().get()?;
        let chapter = chapter_ops::get(&conn, payload.id)?
            .ok_or_else(|| anyhow::anyhow!("chapter {} not found", payload.id))?;
        let pages = chapter_ops::list_source_pages(project.root(), &chapter)?;
        if pages.is_empty() {
            anyhow::bail!(
                "chapter {} has no pages — add pages to source/ first",
                payload.id
            );
        }
        let mut out = Vec::with_capacity(pages.len());
        for abs in pages {
            let bytes = std::fs::read(&abs)
                .map_err(|e| anyhow::anyhow!("read {}: {}", abs.display(), e))?;
            out.push((abs, bytes));
        }
        Ok(out)
    })
    .await??;

    let docs = crate::ops::load_documents(loaded)?;
    let count = docs.len();
    let mut guard = state.state.write().await;
    guard.documents = docs;
    drop(guard);
    // Phase 5.5: chapter switch drops the v2 ProjectSession so
    // history doesn't carry across chapters (locked decision: per-
    // chapter session). The engine_bridge re-inits on the next
    // engine run against the new chapter's Scene.
    state.session.write().await.clear();
    Ok(count)
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

/// Pop a save-file dialog and export the given chapter as a `.cbz`
/// (Comic Book ZIP). Pages come from the chapter's `render/` folder
/// if present, else from `source/`. Includes ComicInfo.xml sidecar.
pub async fn chapter_export_cbz(
    state: AppResources,
    payload: ChapterIdPayload,
) -> anyhow::Result<koharu_api::commands::ChapterExportCbzResult> {
    use koharu_api::commands::ChapterExportCbzResult;
    use koharu_project::cbz;

    let project = require_project(&state).await?;

    // Look up chapter to suggest a sensible default filename.
    let (chapter, series) = {
        let conn = project.pool().get()?;
        let chapter = chapter_ops::get(&conn, payload.id)?
            .ok_or_else(|| anyhow::anyhow!("chapter {} not found", payload.id))?;
        let series = series_ops::get(&conn)?;
        (chapter, series)
    };

    let default_name = format!(
        "{} - ch{}.cbz",
        sanitize_folder_name(&series.title),
        format_chapter_for_filename(chapter.chapter_number),
    );

    let chosen = tokio::task::spawn_blocking(move || {
        FileDialog::new()
            .add_filter("Comic Book Zip", &["cbz"])
            .set_file_name(&default_name)
            .save_file()
    })
    .await?;
    let Some(out_path) = chosen else {
        return Ok(ChapterExportCbzResult {
            path: None,
            page_count: 0,
            used_render: false,
        });
    };

    let project_root = project.root().to_path_buf();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        Ok(cbz::export_chapter(&project_root, &chapter, &series, &out_path)?)
    })
    .await??;

    Ok(ChapterExportCbzResult {
        path: Some(result.path.to_string_lossy().into_owned()),
        page_count: result.page_count as u32,
        used_render: result.used_render,
    })
}

fn format_chapter_for_filename(n: f64) -> String {
    if (n.fract()).abs() < f64::EPSILON {
        format!("{:03}", n as i64)
    } else {
        format!("{:0>5.2}", n)
    }
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

/// Delete every file in the chapter's `source/` folder. Used by the
/// UI's "Clear pages" button — typically when the user accidentally
/// uploaded duplicates and wants to start over without removing the
/// chapter row itself (keeps characters / glossary / TM intact).
/// Does NOT touch `render/` or any other subfolder.
pub async fn chapter_clear_pages(
    state: AppResources,
    payload: ChapterIdPayload,
) -> anyhow::Result<koharu_api::commands::ChapterClearPagesResult> {
    let project = require_project(&state).await?;
    let result = tokio::task::spawn_blocking(
        move || -> anyhow::Result<koharu_api::commands::ChapterClearPagesResult> {
            let conn = project.pool().get()?;
            let chapter = chapter_ops::get(&conn, payload.id)?.ok_or_else(|| {
                anyhow::anyhow!("chapter {} not found", payload.id)
            })?;
            let pages = chapter_ops::list_source_pages(project.root(), &chapter)?;
            let mut removed = 0usize;
            let mut failures: Vec<String> = Vec::new();
            for path in &pages {
                match std::fs::remove_file(path) {
                    Ok(()) => removed += 1,
                    Err(e) => {
                        tracing::warn!(?path, "chapter_clear_pages: remove failed: {e}");
                        failures.push(format!("{}: {e}", path.display()));
                    }
                }
            }
            // Refresh page_count whether everything succeeded or not —
            // some files may have been deleted, the count should reflect
            // disk reality.
            chapter_ops::refresh_page_count(&conn, project.root(), payload.id)?;
            Ok(koharu_api::commands::ChapterClearPagesResult {
                removed: removed as u32,
                failed: failures.len() as u32,
            })
        },
    )
    .await??;
    Ok(result)
}

// ---------------------------------------------------------------
// characters + glossary (Phase 3)
// ---------------------------------------------------------------

pub async fn characters_list(state: AppResources) -> anyhow::Result<Vec<CharacterDto>> {
    let project = require_project(&state).await?;
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<CharacterDto>> {
        let conn = project.pool().get()?;
        Ok(character_ops::list(&conn)?
            .into_iter()
            .map(character_to_dto)
            .collect())
    })
    .await??;
    Ok(list)
}

pub async fn character_add(
    state: AppResources,
    payload: CharacterAddPayload,
) -> anyhow::Result<CharacterDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<CharacterDto> {
        let conn = project.pool().get()?;
        let inserted = character_ops::insert(
            &conn,
            CharacterInsert {
                original_name: payload.original_name,
                translated_name: payload.translated_name,
                aliases: payload
                    .aliases
                    .into_iter()
                    .map(|a| NameAlias { src: a.src, tgt: a.tgt })
                    .collect(),
                role: payload.role,
                gender: payload.gender,
                age: payload.age,
                speech_style: payload.speech_style,
                personality: payload.personality,
                notes: payload.notes,
                is_main: payload.is_main,
                sort_order: payload.sort_order,
                first_appearance_chapter_id: payload.first_appearance_chapter_id,
            },
        )?;
        Ok(character_to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

pub async fn character_update(
    state: AppResources,
    payload: CharacterUpdatePayload,
) -> anyhow::Result<Option<CharacterDto>> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<CharacterDto>> {
        let conn = project.pool().get()?;
        let patch = CharacterPatch {
            original_name: payload.original_name,
            translated_name: payload.translated_name,
            aliases: payload.aliases.map(|v| {
                v.into_iter()
                    .map(|a| NameAlias { src: a.src, tgt: a.tgt })
                    .collect()
            }),
            role: payload.role.map(Some),
            gender: payload.gender.map(Some),
            age: payload.age.map(Some),
            speech_style: payload.speech_style.map(Some),
            personality: payload.personality.map(Some),
            notes: payload.notes.map(Some),
            is_main: payload.is_main,
            sort_order: payload.sort_order,
            first_appearance_chapter_id: payload.first_appearance_chapter_id.map(Some),
        };
        Ok(character_ops::update(&conn, payload.id, patch)?.map(character_to_dto))
    })
    .await??;
    Ok(dto)
}

pub async fn character_remove(
    state: AppResources,
    payload: CharacterIdPayload,
) -> anyhow::Result<bool> {
    let project = require_project(&state).await?;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = project.pool().get()?;
        Ok(character_ops::remove(&conn, payload.id)?)
    })
    .await??;
    Ok(removed)
}

pub async fn glossary_list(state: AppResources) -> anyhow::Result<Vec<GlossaryDto>> {
    let project = require_project(&state).await?;
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<GlossaryDto>> {
        let conn = project.pool().get()?;
        Ok(glossary_ops::list(&conn)?
            .into_iter()
            .map(glossary_to_dto)
            .collect())
    })
    .await??;
    Ok(list)
}

pub async fn glossary_add(
    state: AppResources,
    payload: GlossaryAddPayload,
) -> anyhow::Result<GlossaryDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<GlossaryDto> {
        let conn = project.pool().get()?;
        let category = GlossaryCategory::parse(&payload.category)
            .ok_or_else(|| anyhow::anyhow!("invalid category: {}", payload.category))?;
        let confidence = payload
            .confidence
            .as_deref()
            .map(parse_confidence)
            .unwrap_or(Confidence::Manual);
        let inserted = glossary_ops::insert(
            &conn,
            GlossaryInsert {
                source_text: payload.source_text,
                target_text: payload.target_text,
                category,
                aliases: payload.aliases,
                context_note: payload.context_note,
                first_appearance_chapter_id: payload.first_appearance_chapter_id,
                confidence,
                approved: payload.approved.unwrap_or(true),
            },
        )?;
        Ok(glossary_to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

pub async fn glossary_bulk_add(
    state: AppResources,
    payload: GlossaryBulkAddPayload,
) -> anyhow::Result<GlossaryBulkAddResult> {
    let project = require_project(&state).await?;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<GlossaryBulkAddResult> {
        let mut conn = project.pool().get()?;
        let items: Vec<GlossaryInsert> = payload
            .items
            .into_iter()
            .filter_map(|p| {
                let category = GlossaryCategory::parse(&p.category)?;
                let confidence = p
                    .confidence
                    .as_deref()
                    .map(parse_confidence)
                    .unwrap_or(Confidence::Manual);
                Some(GlossaryInsert {
                    source_text: p.source_text,
                    target_text: p.target_text,
                    category,
                    aliases: p.aliases,
                    context_note: p.context_note,
                    first_appearance_chapter_id: p.first_appearance_chapter_id,
                    confidence,
                    approved: p.approved.unwrap_or(true),
                })
            })
            .collect();
        let (inserted, skipped) = glossary_ops::bulk_insert(&mut conn, items)?;
        Ok(GlossaryBulkAddResult {
            inserted: inserted as u32,
            skipped: skipped as u32,
        })
    })
    .await??;
    Ok(result)
}

pub async fn glossary_update(
    state: AppResources,
    payload: GlossaryUpdatePayload,
) -> anyhow::Result<Option<GlossaryDto>> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<GlossaryDto>> {
        let conn = project.pool().get()?;
        let patch = GlossaryPatch {
            source_text: payload.source_text,
            target_text: payload.target_text,
            category: payload.category.as_deref().and_then(GlossaryCategory::parse),
            aliases: payload.aliases,
            context_note: payload.context_note.map(Some),
            first_appearance_chapter_id: payload.first_appearance_chapter_id.map(Some),
            confidence: payload.confidence.as_deref().map(parse_confidence),
            approved: payload.approved,
        };
        Ok(glossary_ops::update(&conn, payload.id, patch)?.map(glossary_to_dto))
    })
    .await??;
    Ok(dto)
}

pub async fn glossary_remove(
    state: AppResources,
    payload: GlossaryIdPayload,
) -> anyhow::Result<bool> {
    let project = require_project(&state).await?;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = project.pool().get()?;
        Ok(glossary_ops::remove(&conn, payload.id)?)
    })
    .await??;
    Ok(removed)
}

pub async fn glossary_bump_usage(
    state: AppResources,
    payload: GlossaryBumpUsagePayload,
) -> anyhow::Result<()> {
    let project = require_project(&state).await?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = project.pool().get()?;
        glossary_ops::bump_usage(&conn, &payload.ids)?;
        Ok(())
    })
    .await??;
    Ok(())
}

// ---------------------------------------------------------------
// prompt templates + render (Phase 4 / 5)
// ---------------------------------------------------------------

pub async fn prompt_templates_list(state: AppResources) -> anyhow::Result<Vec<PromptTemplateDto>> {
    let project = require_project(&state).await?;
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<PromptTemplateDto>> {
        let conn = project.pool().get()?;
        Ok(prompt_ops::list(&conn)?
            .into_iter()
            .map(prompt_to_dto)
            .collect())
    })
    .await??;
    Ok(list)
}

pub async fn prompt_template_add(
    state: AppResources,
    payload: PromptTemplateAddPayload,
) -> anyhow::Result<PromptTemplateDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<PromptTemplateDto> {
        let conn = project.pool().get()?;
        let use_case = parse_use_case(&payload.use_case)?;
        let inserted = prompt_ops::insert(
            &conn,
            PromptTemplateInsert {
                name: payload.name,
                description: payload.description,
                use_case,
                template: payload.template,
                is_default: payload.is_default,
            },
        )?;
        Ok(prompt_to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

pub async fn prompt_template_update(
    state: AppResources,
    payload: PromptTemplateUpdatePayload,
) -> anyhow::Result<Option<PromptTemplateDto>> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<PromptTemplateDto>> {
        let conn = project.pool().get()?;
        let patch = PromptTemplatePatch {
            name: payload.name,
            description: payload.description.map(Some),
            use_case: match payload.use_case.as_deref() {
                Some(s) => Some(parse_use_case(s)?),
                None => None,
            },
            template: payload.template,
            is_default: payload.is_default,
        };
        Ok(prompt_ops::update(&conn, payload.id, patch)?.map(prompt_to_dto))
    })
    .await??;
    Ok(dto)
}

pub async fn prompt_template_remove(
    state: AppResources,
    payload: PromptTemplateIdPayload,
) -> anyhow::Result<bool> {
    let project = require_project(&state).await?;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = project.pool().get()?;
        Ok(prompt_ops::remove(&conn, payload.id)?)
    })
    .await??;
    Ok(removed)
}

/// Render a prompt for the open project. Resolves the template (by name
/// or by use-case default), assembles the 3-layer context (series meta +
/// main characters + smart-filtered glossary + rolling summary), and
/// returns the rendered string plus the glossary entry IDs that matched.
pub async fn prompt_render(
    state: AppResources,
    payload: PromptRenderPayload,
) -> anyhow::Result<PromptRenderResult> {
    let project = require_project(&state).await?;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<PromptRenderResult> {
        let conn = project.pool().get()?;

        let use_case = parse_use_case(&payload.use_case)?;
        let template: PromptTemplate = match payload.template_name.as_deref() {
            Some(name) => prompt_ops::get_by_name(&conn, name)?
                .ok_or_else(|| anyhow::anyhow!("template '{name}' not found"))?,
            None => prompt_ops::default_for(&conn, use_case)?
                .ok_or_else(|| anyhow::anyhow!("no template available for use case"))?,
        };

        let series = series_ops::get(&conn)?;
        let main_chars: Vec<Character> = character_ops::list(&conn)?
            .into_iter()
            .filter(|c| c.is_main)
            .collect();
        let glossary_entries = glossary_ops::list(&conn)?;

        // Resolve the rolling summary: explicit string wins; otherwise
        // auto-fetch from the chapter index when chapter_id is given.
        let rolling_summary: String = if !payload.rolling_summary.is_empty() {
            payload.rolling_summary.clone()
        } else if let Some(cid) = payload.chapter_id {
            let n = payload.rolling_chapter_count.unwrap_or(2);
            chapter_ops::rolling_summary(&conn, cid, n)?
        } else {
            String::new()
        };

        let ctx = prompt_ops::build_context(
            &series,
            &main_chars,
            &glossary_entries,
            &rolling_summary,
            &payload.source_text,
        );
        let prompt = prompt_ops::render_template(&template.template, &ctx)?;

        Ok(PromptRenderResult {
            prompt,
            template_name: template.name,
            glossary_hit_ids: ctx.glossary_hit_ids,
        })
    })
    .await??;
    Ok(result)
}

// ---------------------------------------------------------------
// translation memory (Phase 6)
// ---------------------------------------------------------------

pub async fn tm_lookup(
    state: AppResources,
    payload: TmLookupPayload,
) -> anyhow::Result<Option<TmEntryDto>> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<TmEntryDto>> {
        let conn = project.pool().get()?;
        Ok(tm_ops::lookup_exact(&conn, &payload.source_text, &payload.target_lang)?
            .map(tm_to_dto))
    })
    .await??;
    Ok(dto)
}

pub async fn tm_lookup_fuzzy(
    state: AppResources,
    payload: TmLookupFuzzyPayload,
) -> anyhow::Result<Option<TmFuzzyHit>> {
    let project = require_project(&state).await?;
    let hit = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<TmFuzzyHit>> {
        let conn = project.pool().get()?;
        Ok(tm_ops::lookup_fuzzy(
            &conn,
            &payload.source_text,
            &payload.target_lang,
            payload.min_similarity,
        )?
        .map(|(entry, similarity)| TmFuzzyHit {
            entry: tm_to_dto(entry),
            similarity,
        }))
    })
    .await??;
    Ok(hit)
}

pub async fn tm_insert(
    state: AppResources,
    payload: TmInsertPayload,
) -> anyhow::Result<TmEntryDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<TmEntryDto> {
        let conn = project.pool().get()?;
        let inserted = tm_ops::insert(
            &conn,
            TmInsertItem {
                source_text: payload.source_text,
                target_text: payload.target_text,
                source_lang: payload.source_lang,
                target_lang: payload.target_lang,
                chapter_id: payload.chapter_id,
                page_index: payload.page_index,
                text_block_index: payload.text_block_index,
                provider: payload.provider,
                model: payload.model,
                prompt_template_id: None,
            },
        )?;
        Ok(tm_to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

// ---------------------------------------------------------------
// TM embeddings (semantic search backfill + lookup)
// ---------------------------------------------------------------

pub async fn tm_pending_embeddings(
    state: AppResources,
    payload: koharu_api::commands::TmPendingEmbeddingsPayload,
) -> anyhow::Result<Vec<koharu_api::commands::TmPendingEmbeddingItem>> {
    use koharu_api::commands::TmPendingEmbeddingItem;
    let project = require_project(&state).await?;
    let list = tokio::task::spawn_blocking(
        move || -> anyhow::Result<Vec<TmPendingEmbeddingItem>> {
            let conn = project.pool().get()?;
            let rows = koharu_project::tm_vector::list_pending_embeddings(
                &conn,
                &payload.model,
                payload.limit.unwrap_or(64),
            )?;
            Ok(rows
                .into_iter()
                .map(|(id, source_text)| TmPendingEmbeddingItem {
                    id,
                    source_text,
                })
                .collect())
        },
    )
    .await??;
    Ok(list)
}

pub async fn tm_pending_count(
    state: AppResources,
    payload: koharu_api::commands::TmPendingCountPayload,
) -> anyhow::Result<i64> {
    let project = require_project(&state).await?;
    let n = tokio::task::spawn_blocking(move || -> anyhow::Result<i64> {
        let conn = project.pool().get()?;
        Ok(koharu_project::tm_vector::count_pending_embeddings(
            &conn,
            &payload.model,
        )?)
    })
    .await??;
    Ok(n)
}

pub async fn tm_set_embedding(
    state: AppResources,
    payload: koharu_api::commands::TmSetEmbeddingPayload,
) -> anyhow::Result<()> {
    let project = require_project(&state).await?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = project.pool().get()?;
        koharu_project::tm_vector::set_embedding(
            &conn,
            payload.id,
            &payload.embedding,
            &payload.model,
        )?;
        Ok(())
    })
    .await??;
    Ok(())
}

pub async fn tm_lookup_semantic(
    state: AppResources,
    payload: koharu_api::commands::TmLookupSemanticPayload,
) -> anyhow::Result<Vec<koharu_api::commands::TmSemanticHit>> {
    use koharu_api::commands::{TmEntryDto, TmSemanticHit};
    let project = require_project(&state).await?;
    let hits = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<TmSemanticHit>> {
        let conn = project.pool().get()?;
        let rows = koharu_project::tm_vector::lookup_semantic(
            &conn,
            &payload.embedding,
            &payload.model,
            &payload.target_lang,
            payload.top_k.unwrap_or(5) as usize,
            payload.min_similarity.unwrap_or(0.75),
        )?;
        Ok(rows
            .into_iter()
            .map(|(e, sim)| TmSemanticHit {
                entry: TmEntryDto {
                    id: e.id,
                    source_text: e.source_text,
                    target_text: e.target_text,
                    source_lang: e.source_lang,
                    target_lang: e.target_lang,
                    chapter_id: e.chapter_id,
                    page_index: e.page_index,
                    text_block_index: e.text_block_index,
                    provider: e.provider,
                    model: e.model,
                    is_approved: e.is_approved,
                    created_at: e.created_at.to_rfc3339(),
                },
                similarity: sim,
            })
            .collect())
    })
    .await??;
    Ok(hits)
}

// ---------------------------------------------------------------
// TMX import/export (CAT-tool interchange)
// ---------------------------------------------------------------

pub async fn tm_export_tmx(
    state: AppResources,
) -> anyhow::Result<koharu_api::commands::TmxExportResult> {
    use koharu_api::commands::TmxExportResult;
    let project = require_project(&state).await?;

    let chosen = tokio::task::spawn_blocking(|| {
        FileDialog::new()
            .add_filter("Translation Memory eXchange", &["tmx"])
            .set_file_name("translation_memory.tmx")
            .save_file()
    })
    .await?;
    let Some(out_path) = chosen else {
        return Ok(TmxExportResult {
            path: None,
            entries: 0,
        });
    };

    let (src_lang, tgt_lang) = {
        let conn = project.pool().get()?;
        let series = series_ops::get(&conn)?;
        (series.source_language, series.target_language)
    };

    let project2 = project.clone();
    let out_path2 = out_path.clone();
    let count = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        let conn = project2.pool().get()?;
        Ok(koharu_project::tm_tmx::export_to_tmx(
            &conn,
            &out_path2,
            Some(&tgt_lang),
            &src_lang,
        )?)
    })
    .await??;

    Ok(TmxExportResult {
        path: Some(out_path.to_string_lossy().into_owned()),
        entries: count as u32,
    })
}

pub async fn tm_import_tmx(
    state: AppResources,
) -> anyhow::Result<koharu_api::commands::TmxImportResult> {
    use koharu_api::commands::TmxImportResult;
    let project = require_project(&state).await?;

    let chosen = tokio::task::spawn_blocking(|| {
        FileDialog::new()
            .add_filter("Translation Memory eXchange", &["tmx"])
            .pick_file()
    })
    .await?;
    let Some(in_path) = chosen else {
        return Ok(TmxImportResult {
            inserted: 0,
            skipped: 0,
        });
    };

    let (src_lang, tgt_lang) = {
        let conn = project.pool().get()?;
        let series = series_ops::get(&conn)?;
        (series.source_language, series.target_language)
    };

    let project2 = project.clone();
    let in_path2 = in_path.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(usize, usize)> {
        let mut conn = project2.pool().get()?;
        let r = koharu_project::tm_tmx::import_from_tmx(
            &mut conn,
            &in_path2,
            &src_lang,
            &tgt_lang,
        )?;
        Ok((r.inserted, r.skipped))
    })
    .await??;

    Ok(TmxImportResult {
        inserted: result.0 as u32,
        skipped: result.1 as u32,
    })
}

// ---------------------------------------------------------------
// provider profiles (Phase 9) + cost log/stats (Phase 10)
// ---------------------------------------------------------------

/// One-time auto-migration: when the machine-wide profile store is
/// empty and a project with provider profiles is open, copy them into
/// the machine store. Runs the first time the user views profiles after
/// upgrading (guarded by "machine store empty", so it copies once from
/// the first project opened that has profiles). API keys live in the OS
/// keyring (already machine-wide) — we copy only the row + the keyring
/// ref, so keys are preserved.
async fn maybe_migrate_profiles_from_project(state: &AppResources) -> anyhow::Result<()> {
    let pool = state.profiles.clone();
    let machine_empty = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool.get()?;
        Ok(profile_ops::list(&conn)?.is_empty())
    })
    .await??;
    if !machine_empty {
        return Ok(());
    }
    let Some(project) = state.project.read().await.clone() else {
        return Ok(());
    };
    let machine = state.profiles.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let pconn = project.pool().get()?;
        let existing = profile_ops::list(&pconn)?;
        if existing.is_empty() {
            return Ok(());
        }
        let mconn = machine.get()?;
        for p in existing {
            // Re-check emptiness inside the lock isn't needed — this fn
            // is only reached when machine_empty was true, and the UI
            // serialises profile RPCs.
            profile_ops::insert(
                &mconn,
                ProfileInsert {
                    name: p.name,
                    provider: p.provider,
                    api_url: p.api_url,
                    model_name: p.model_name,
                    api_key_ref: p.api_key_ref,
                    extra_headers: p.extra_headers,
                    extra_params: p.extra_params,
                    is_default: p.is_default,
                    cost_input_per_1m: p.cost_input_per_1m,
                    cost_output_per_1m: p.cost_output_per_1m,
                },
            )?;
        }
        tracing::info!("migrated provider profiles from project DB into the machine-wide store");
        Ok(())
    })
    .await??;
    Ok(())
}

pub async fn provider_profiles_list(
    state: AppResources,
) -> anyhow::Result<Vec<ProviderProfileDto>> {
    maybe_migrate_profiles_from_project(&state).await?;
    let pool = state.profiles.clone();
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProviderProfileDto>> {
        let conn = pool.get()?;
        Ok(profile_ops::list(&conn)?.into_iter().map(profile_to_dto).collect())
    })
    .await??;
    Ok(list)
}

pub async fn provider_profile_add(
    state: AppResources,
    payload: ProviderProfileAddPayload,
) -> anyhow::Result<ProviderProfileDto> {
    let pool = state.profiles.clone();
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<ProviderProfileDto> {
        let conn = pool.get()?;
        // Mint a stable keyring reference and stash the plaintext key
        // there. Only the reference ID lives in the DB.
        let key_ref = if payload
            .api_key
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
        {
            let r = secret_ops::new_ref();
            if let Err(err) = secret_ops::put(&r, payload.api_key.as_deref().unwrap()) {
                tracing::warn!(?err, "keyring put failed; storing without secret");
                None
            } else {
                Some(r)
            }
        } else {
            None
        };
        let inserted = profile_ops::insert(
            &conn,
            ProfileInsert {
                name: payload.name,
                provider: parse_provider(&payload.provider)?,
                api_url: payload.api_url,
                model_name: payload.model_name,
                api_key_ref: key_ref,
                extra_headers: serde_json::json!({}),
                extra_params: serde_json::json!({}),
                is_default: payload.is_default,
                cost_input_per_1m: payload.cost_input_per_1m,
                cost_output_per_1m: payload.cost_output_per_1m,
            },
        )?;
        Ok(profile_to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

pub async fn provider_profile_update(
    state: AppResources,
    payload: ProviderProfileUpdatePayload,
) -> anyhow::Result<Option<ProviderProfileDto>> {
    let pool = state.profiles.clone();
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProviderProfileDto>> {
        let conn = pool.get()?;

        // Resolve api_key handling first: None = leave alone; Some("")
        // = clear; Some(value) = (re)write keyring entry.
        let key_ref_change: Option<Option<String>> = match payload.api_key {
            None => None,
            Some(ref s) if s.is_empty() => {
                // Clear: delete existing keyring entry (if any) and null the ref.
                let existing = profile_ops::get(&conn, payload.id)?;
                if let Some(p) = existing {
                    if let Some(r) = p.api_key_ref.as_deref() {
                        let _ = secret_ops::delete(r);
                    }
                }
                Some(None)
            }
            Some(plaintext) => {
                let existing = profile_ops::get(&conn, payload.id)?;
                let r = existing
                    .as_ref()
                    .and_then(|p| p.api_key_ref.clone())
                    .unwrap_or_else(secret_ops::new_ref);
                if let Err(err) = secret_ops::put(&r, &plaintext) {
                    tracing::warn!(?err, "keyring put failed; leaving ref unchanged");
                    None
                } else {
                    Some(Some(r))
                }
            }
        };

        let patch = ProfilePatch {
            name: payload.name,
            provider: match payload.provider.as_deref() {
                Some(s) => Some(parse_provider(s)?),
                None => None,
            },
            api_url: payload.api_url.map(Some),
            model_name: payload.model_name,
            api_key_ref: key_ref_change,
            extra_headers: None,
            extra_params: None,
            is_default: payload.is_default,
            cost_input_per_1m: payload.cost_input_per_1m.map(Some),
            cost_output_per_1m: payload.cost_output_per_1m.map(Some),
        };
        Ok(profile_ops::update(&conn, payload.id, patch)?.map(profile_to_dto))
    })
    .await??;
    Ok(dto)
}

pub async fn provider_profile_secret_get(
    state: AppResources,
    payload: ProviderProfileIdPayload,
) -> anyhow::Result<ProviderProfileSecret> {
    let pool = state.profiles.clone();
    let secret = tokio::task::spawn_blocking(move || -> anyhow::Result<ProviderProfileSecret> {
        let conn = pool.get()?;
        let profile = profile_ops::get(&conn, payload.id)?
            .ok_or_else(|| anyhow::anyhow!("profile {} not found", payload.id))?;
        let api_key = match profile.api_key_ref.as_deref() {
            Some(r) => secret_ops::get(r).ok().flatten(),
            None => None,
        };
        Ok(ProviderProfileSecret { api_key })
    })
    .await??;
    Ok(secret)
}

pub async fn provider_profile_remove(
    state: AppResources,
    payload: ProviderProfileIdPayload,
) -> anyhow::Result<bool> {
    let pool = state.profiles.clone();
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool.get()?;
        // Clean up the keyring entry too so we don't leak secrets after delete.
        if let Some(p) = profile_ops::get(&conn, payload.id)? {
            if let Some(r) = p.api_key_ref.as_deref() {
                let _ = secret_ops::delete(r);
            }
        }
        Ok(profile_ops::remove(&conn, payload.id)?)
    })
    .await??;
    Ok(removed)
}

pub async fn llm_call_log(
    state: AppResources,
    payload: LlmCallLogPayload,
) -> anyhow::Result<()> {
    let project = require_project(&state).await?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = project.pool().get()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO llm_call_log
                (profile_id, use_case, chapter_id, prompt_tokens,
                 completion_tokens, estimated_cost_usd, duration_ms,
                 success, error_message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                payload.profile_id,
                payload.use_case,
                payload.chapter_id,
                payload.prompt_tokens,
                payload.completion_tokens,
                payload.estimated_cost_usd,
                payload.duration_ms,
                if payload.success { 1 } else { 0 },
                payload.error_message,
                now,
            ],
        )?;
        Ok(())
    })
    .await??;
    Ok(())
}

pub async fn llm_cost_breakdown(
    state: AppResources,
) -> anyhow::Result<koharu_api::commands::LlmCostBreakdown> {
    use koharu_api::commands::{
        LlmCostBreakdown, LlmCostByChapter, LlmCostByDay, LlmCostByProfile,
        LlmCostByUseCase,
    };
    let project = require_project(&state).await?;
    let profiles_pool = state.profiles.clone();
    let breakdown = tokio::task::spawn_blocking(move || -> anyhow::Result<LlmCostBreakdown> {
        let conn = project.pool().get()?;
        // Provider profiles now live in the machine-wide store, not the
        // project DB — so resolve profile_id → name/provider from there
        // (a cross-DB SQL join is no longer possible / meaningful).
        let profile_meta: std::collections::HashMap<i64, (String, String)> =
            profile_ops::list(&profiles_pool.get()?)?
                .into_iter()
                .map(profile_to_dto)
                .map(|d| (d.id, (d.name, d.provider)))
                .collect();

        // By provider profile — group by id in the per-project call log,
        // enrich name/provider from the machine-wide profile store.
        let by_profile = {
            let mut stmt = conn.prepare(
                "SELECT
                    l.profile_id,
                    COUNT(l.id),
                    COALESCE(SUM(l.success), 0),
                    COALESCE(SUM(l.prompt_tokens), 0),
                    COALESCE(SUM(l.completion_tokens), 0),
                    COALESCE(SUM(l.estimated_cost_usd), 0)
                 FROM llm_call_log l
                 WHERE l.profile_id IS NOT NULL
                 GROUP BY l.profile_id
                 ORDER BY SUM(l.estimated_cost_usd) DESC",
            )?;
            stmt.query_map([], |r| {
                let id: i64 = r.get(0)?;
                let (name, provider) = profile_meta
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| ("(deleted)".into(), String::new()));
                Ok(LlmCostByProfile {
                    profile_id: id,
                    profile_name: name,
                    provider,
                    total_calls: r.get(1)?,
                    successful_calls: r.get(2)?,
                    total_prompt_tokens: r.get(3)?,
                    total_completion_tokens: r.get(4)?,
                    total_cost_usd: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        // By chapter — join with chapters for the name.
        let by_chapter = {
            let mut stmt = conn.prepare(
                "SELECT
                    c.id, COALESCE(c.title, ''), c.chapter_number,
                    COUNT(l.id),
                    COALESCE(SUM(l.prompt_tokens), 0),
                    COALESCE(SUM(l.completion_tokens), 0),
                    COALESCE(SUM(l.estimated_cost_usd), 0)
                 FROM llm_call_log l
                 INNER JOIN chapters c ON c.id = l.chapter_id
                 GROUP BY l.chapter_id
                 ORDER BY c.chapter_number ASC",
            )?;
            stmt.query_map([], |r| {
                Ok(LlmCostByChapter {
                    chapter_id: r.get(0)?,
                    chapter_title: r.get(1)?,
                    chapter_number: r.get(2)?,
                    total_calls: r.get(3)?,
                    total_prompt_tokens: r.get(4)?,
                    total_completion_tokens: r.get(5)?,
                    total_cost_usd: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        // By day (UTC) — last 30 days for spark/line chart.
        let by_day = {
            let mut stmt = conn.prepare(
                "SELECT
                    strftime('%Y-%m-%d', created_at, 'unixepoch'),
                    COUNT(*),
                    COALESCE(SUM(prompt_tokens), 0),
                    COALESCE(SUM(completion_tokens), 0),
                    COALESCE(SUM(estimated_cost_usd), 0)
                 FROM llm_call_log
                 WHERE created_at >= strftime('%s', 'now', '-30 days')
                 GROUP BY 1
                 ORDER BY 1 ASC",
            )?;
            stmt.query_map([], |r| {
                Ok(LlmCostByDay {
                    day: r.get(0)?,
                    total_calls: r.get(1)?,
                    total_prompt_tokens: r.get(2)?,
                    total_completion_tokens: r.get(3)?,
                    total_cost_usd: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let by_use_case = {
            let mut stmt = conn.prepare(
                "SELECT
                    use_case,
                    COUNT(*),
                    COALESCE(SUM(prompt_tokens), 0),
                    COALESCE(SUM(completion_tokens), 0),
                    COALESCE(SUM(estimated_cost_usd), 0)
                 FROM llm_call_log
                 GROUP BY use_case
                 ORDER BY SUM(estimated_cost_usd) DESC",
            )?;
            stmt.query_map([], |r| {
                Ok(LlmCostByUseCase {
                    use_case: r.get(0)?,
                    total_calls: r.get(1)?,
                    total_prompt_tokens: r.get(2)?,
                    total_completion_tokens: r.get(3)?,
                    total_cost_usd: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        Ok(LlmCostBreakdown {
            by_profile,
            by_chapter,
            by_day,
            by_use_case,
        })
    })
    .await??;
    Ok(breakdown)
}

pub async fn llm_cost_stats(state: AppResources) -> anyhow::Result<LlmCostStats> {
    let project = require_project(&state).await?;
    let stats = tokio::task::spawn_blocking(move || -> anyhow::Result<LlmCostStats> {
        let conn = project.pool().get()?;
        let row = conn
            .query_row(
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(success), 0),
                    COALESCE(SUM(prompt_tokens), 0),
                    COALESCE(SUM(completion_tokens), 0),
                    COALESCE(SUM(estimated_cost_usd), 0)
                 FROM llm_call_log",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, f64>(4)?,
                    ))
                },
            )
            .unwrap_or((0, 0, 0, 0, 0.0));
        Ok(LlmCostStats {
            total_calls: row.0,
            successful_calls: row.1,
            total_prompt_tokens: row.2,
            total_completion_tokens: row.3,
            total_cost_usd: row.4,
        })
    })
    .await??;
    Ok(stats)
}

fn parse_provider(s: &str) -> anyhow::Result<Provider> {
    match s {
        "openai" => Ok(Provider::Openai),
        // Distinct variant since v1.0.0 — previously collapsed into
        // Openai, but the UI treats OpenRouter as a first-class
        // provider with its own model list / dispatch path. Round-trip
        // bug: saved "openrouter" round-tripped as "openai" causing
        // the edit modal to open the wrong tile + the wrong dispatcher
        // to handle calls.
        "openrouter" => Ok(Provider::Openrouter),
        "gemini" => Ok(Provider::Gemini),
        "anthropic" => Ok(Provider::Anthropic),
        other => anyhow::bail!("unknown provider: {other}"),
    }
}

fn profile_to_dto(p: ProviderProfile) -> ProviderProfileDto {
    ProviderProfileDto {
        id: p.id,
        name: p.name,
        provider: p.provider.as_str().to_string(),
        api_url: p.api_url,
        model_name: p.model_name,
        api_key_ref: p.api_key_ref,
        is_default: p.is_default,
        cost_input_per_1m: p.cost_input_per_1m,
        cost_output_per_1m: p.cost_output_per_1m,
        created_at: p.created_at.to_rfc3339(),
        updated_at: p.updated_at.to_rfc3339(),
    }
}

fn tm_to_dto(e: TmEntry) -> TmEntryDto {
    TmEntryDto {
        id: e.id,
        source_text: e.source_text,
        target_text: e.target_text,
        source_lang: e.source_lang,
        target_lang: e.target_lang,
        chapter_id: e.chapter_id,
        page_index: e.page_index,
        text_block_index: e.text_block_index,
        provider: e.provider,
        model: e.model,
        is_approved: e.is_approved,
        created_at: e.created_at.to_rfc3339(),
    }
}

fn parse_use_case(s: &str) -> anyhow::Result<PromptUseCase> {
    Ok(match s {
        "translate" => PromptUseCase::Translate,
        "extract_entities" => PromptUseCase::ExtractEntities,
        "summarize_chapter" => PromptUseCase::SummarizeChapter,
        other => anyhow::bail!("unknown prompt use case: {other}"),
    })
}

fn prompt_to_dto(t: PromptTemplate) -> PromptTemplateDto {
    PromptTemplateDto {
        id: t.id,
        name: t.name,
        description: t.description,
        is_default: t.is_default,
        use_case: t.use_case.as_str().to_string(),
        template: t.template,
        created_at: t.created_at.to_rfc3339(),
        updated_at: t.updated_at.to_rfc3339(),
    }
}

fn parse_confidence(s: &str) -> Confidence {
    match s {
        "extracted" => Confidence::Extracted,
        "auto" => Confidence::Auto,
        _ => Confidence::Manual,
    }
}

fn character_to_dto(c: Character) -> CharacterDto {
    CharacterDto {
        id: c.id,
        original_name: c.original_name,
        translated_name: c.translated_name,
        aliases: c
            .aliases
            .into_iter()
            .map(|a| NameAliasDto { src: a.src, tgt: a.tgt })
            .collect(),
        role: c.role,
        gender: c.gender,
        age: c.age,
        speech_style: c.speech_style,
        personality: c.personality,
        notes: c.notes,
        is_main: c.is_main,
        sort_order: c.sort_order,
        first_appearance_chapter_id: c.first_appearance_chapter_id,
        created_at: c.created_at.to_rfc3339(),
        updated_at: c.updated_at.to_rfc3339(),
    }
}

fn glossary_to_dto(g: GlossaryEntry) -> GlossaryDto {
    GlossaryDto {
        id: g.id,
        source_text: g.source_text,
        target_text: g.target_text,
        category: g.category.as_str().to_string(),
        aliases: g.aliases,
        context_note: g.context_note,
        first_appearance_chapter_id: g.first_appearance_chapter_id,
        usage_count: g.usage_count,
        confidence: g.confidence.as_str().to_string(),
        approved: g.approved,
        created_at: g.created_at.to_rfc3339(),
        updated_at: g.updated_at.to_rfc3339(),
    }
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
        folder_path: c.folder_path,
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
