//! Storage management ops backing Settings → Storage and the NSIS
//! uninstaller's optional "clean leftover data" prompt.
//!
//! These are the only ops that intentionally TOUCH koharu's own
//! on-disk state outside the user's project folders. All paths are
//! resolved at app startup and held on `AppResources` so this module
//! doesn't have to re-derive them (and can't get them wrong).

use std::path::Path;

use koharu_api::commands::{
    AppStorageClearPayload, AppStorageClearResult, AppStorageStats, StorageClearError,
    StorageClearTarget, StorageEntry,
};
use tracing::instrument;
use walkdir::WalkDir;

use crate::AppResources;

/// Compute size + file count of a path. Folders are walked; single
/// files report `1`. Missing path returns `(false, 0, 0)` so the UI
/// can still display the would-be location greyed out.
fn measure(path: &Path) -> (bool, u64, u64) {
    if !path.exists() {
        return (false, 0, 0);
    }
    if path.is_file() {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        return (true, size, 1);
    }
    let mut bytes = 0u64;
    let mut files = 0u64;
    // walkdir handles symlinks safely by default (doesn't follow) so
    // we won't double-count or wander into HF cache outside our root.
    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            files += 1;
            if let Ok(md) = entry.metadata() {
                bytes += md.len();
            }
        }
    }
    (true, bytes, files)
}

fn entry_for(path: &Path) -> StorageEntry {
    let (exists, size_bytes, file_count) = measure(path);
    StorageEntry {
        path: path.display().to_string(),
        exists,
        size_bytes,
        file_count,
    }
}

fn entry_for_orphan_cache(model_root: &Path) -> StorageEntry {
    let (exists, size_bytes, file_count) = measure_orphan_cache(model_root);
    StorageEntry {
        path: model_root.display().to_string(),
        exists,
        size_bytes,
        file_count,
    }
}

fn measure_orphan_cache(model_root: &Path) -> (bool, u64, u64) {
    if !model_root.exists() {
        return (false, 0, 0);
    }
    let mut bytes = 0u64;
    let mut files = 0u64;
    for entry in WalkDir::new(model_root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if ext_str == "part" || ext_str == "download" || ext_str == "tmp" {
                    files += 1;
                    if let Ok(md) = entry.metadata() {
                        bytes += md.len();
                    }
                }
            }
        }
    }
    (true, bytes, files)
}

#[instrument(level = "info", skip_all)]
pub async fn app_storage_stats(state: AppResources) -> anyhow::Result<AppStorageStats> {
    // Sizing runs blocking syscalls — keep the executor free.
    let lib_root = state.lib_root.clone();
    let model_root = state.model_root.clone();
    let font_root = state.font_root.clone();
    let recent = state.recent_projects_path.clone();
    let stats = tokio::task::spawn_blocking(move || AppStorageStats {
        libs_cuda: entry_for(&lib_root),
        models_hf: entry_for(&model_root),
        fonts_custom: entry_for(&font_root),
        recent_projects: entry_for(&recent),
        orphan_cache: entry_for_orphan_cache(&model_root),
    })
    .await?;
    Ok(stats)
}

/// Delete the artefact for a target. Returns `(target, bytes_freed)`
/// on success or `(target, error)` on failure. Missing paths count as
/// success with `0` bytes freed (nothing to clean is a no-op, not an
/// error).
fn clear_one(target: StorageClearTarget, path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let (_, bytes_before, _) = measure(path);
    let result = if path.is_file() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    };
    match result {
        Ok(()) => {
            tracing::info!(
                ?target,
                path = %path.display(),
                bytes_freed = bytes_before,
                "cleared storage target"
            );
            Ok(bytes_before)
        }
        Err(err) => {
            tracing::warn!(
                ?target,
                path = %path.display(),
                ?err,
                "failed to clear storage target"
            );
            Err(format!("{err}"))
        }
    }
}

/// Delete only incomplete download files (.part, .download, .tmp) in the model cache.
fn clear_orphan_cache(model_root: &Path) -> Result<u64, String> {
    if !model_root.exists() {
        return Ok(0);
    }
    let mut bytes_freed = 0u64;
    let mut errors = 0;

    for entry in WalkDir::new(model_root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if ext_str == "part" || ext_str == "download" || ext_str == "tmp" {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    match std::fs::remove_file(path) {
                        Ok(()) => {
                            bytes_freed += size;
                            tracing::debug!(?path, size, "removed orphan cache file");
                        }
                        Err(err) => {
                            errors += 1;
                            tracing::warn!(?path, ?err, "failed to remove orphan cache file");
                        }
                    }
                }
            }
        }
    }

    if errors > 0 {
        Err(format!(
            "Successfully freed {} bytes, but failed to remove {} temporary file(s) due to permissions or lock",
            bytes_freed, errors
        ))
    } else {
        Ok(bytes_freed)
    }
}

#[instrument(level = "info", skip_all)]
pub async fn app_storage_clear(
    state: AppResources,
    payload: AppStorageClearPayload,
) -> anyhow::Result<AppStorageClearResult> {
    let lib_root = state.lib_root.clone();
    let model_root = state.model_root.clone();
    let font_root = state.font_root.clone();
    let recent = state.recent_projects_path.clone();
    let targets = payload.targets;

    let result = tokio::task::spawn_blocking(move || {
        let mut cleared = Vec::new();
        let mut freed_bytes = 0u64;
        let mut errors = Vec::new();
        // De-dup so the user can't accidentally double-count by sending
        // the same target twice; preserve first-seen order for the
        // response.
        let mut seen = std::collections::HashSet::new();
        for target in targets.into_iter().filter(|t| seen.insert(*t)) {
            let path = match target {
                StorageClearTarget::LibsCuda => &lib_root,
                StorageClearTarget::ModelsHf => &model_root,
                StorageClearTarget::FontsCustom => &font_root,
                StorageClearTarget::RecentProjects => &recent,
                StorageClearTarget::OrphanCache => &model_root,
            };
            let clear_res = match target {
                StorageClearTarget::OrphanCache => clear_orphan_cache(path),
                _ => clear_one(target, path),
            };
            match clear_res {
                Ok(bytes) => {
                    cleared.push(target);
                    freed_bytes += bytes;
                }
                Err(message) => {
                    errors.push(StorageClearError { target, message });
                }
            }
        }
        AppStorageClearResult {
            cleared,
            freed_bytes,
            errors,
        }
    })
    .await?;

    Ok(result)
}
