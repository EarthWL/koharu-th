//! v1 → v2 project format migration helpers (Phase 6.1).
//!
//! See `docs/v2-arch.md` §6 (on `main`) for the full migration
//! story. This module ships the **host-process side** of the
//! migration: the SQL part (table additions) is owned by the
//! existing `db::open` migration runner via
//! `migrations/V007__v2_blob_index.sql`.
//!
//! ## Sequence at `Project::open` time
//!
//! 1. Manifest is read, manifest.schema_version is detected.
//! 2. **If v1** → [`pre_open_v1_to_v2`] runs:
//!    - Copy `series.db` → `series.db.bak.v1` (idempotent —
//!      skip if backup already exists; covers re-open after a
//!      successful prior migration).
//! 3. `db::open` runs the SQL migration runner (which applies
//!    V007 alongside any prior pending migrations).
//! 4. If the SQL migration succeeded **and** the manifest is
//!    still v1 → [`post_open_v1_to_v2`] runs:
//!    - Create `blobs/` directory at the project root (empty;
//!      on-disk BlobStore backing turns it active later).
//!    - Bump manifest `schema_version` 1 → 2 + atomic write.
//!
//! On any step's failure the backup file persists; the user can
//! manually downgrade per `docs/migration.md` (Phase 6 doc).
//!
//! No `app_meta` table — schema_version lives in the manifest
//! JSON. No `op_log` table — history is in-memory only (locked
//! decisions §2). Both calls are no-ops when manifest is already
//! v2, so re-opens stay fast.

use std::path::Path;

use crate::error::{Error, Result};
use crate::manifest::{MANIFEST_FILENAME, Manifest};

/// Suffix appended to the v1 db file when backing it up before
/// the SQL migration runs. Lives in the project root alongside
/// the original db. Kept indefinitely; the user can delete it
/// from Settings → Storage or via the manual downgrade flow.
pub const V1_BACKUP_SUFFIX: &str = ".bak.v1";

/// Summary of what a v1→v2 migration would do — used by the
/// frontend dialog (Phase 6.2) to compose the confirm message
/// + the post-fail recovery hint.
#[derive(Debug, Clone)]
pub struct MigrationPreview {
    /// Display name from the manifest (`Manifest.name`). Used in
    /// the dialog heading: "Upgrading 'MyManga' to v2…".
    pub project_name: String,
    /// Path to the SQLite db that will be backed up.
    pub db_path: std::path::PathBuf,
    /// Path of the `.bak.v1` file the backup will create. Same
    /// helper as `pre_open_v1_to_v2` uses internally.
    pub backup_path: std::path::PathBuf,
}

/// Peek at the manifest without running any migration steps.
/// Returns `Some(...)` when a v1→v2 migration is needed (caller
/// shows the confirm dialog), `None` when the manifest is already
/// at the supported version.
///
/// Errors on missing/corrupt manifest — same shape as
/// `Manifest::read`. Caller surfaces those as "this isn't a
/// koharu project" / "manifest unreadable" rather than as a
/// migration question.
pub fn peek_migration(root: &Path) -> Result<Option<MigrationPreview>> {
    let manifest_path = root.join(MANIFEST_FILENAME);
    if !manifest_path.exists() {
        return Err(Error::NotAProject(root.into()));
    }
    let manifest = Manifest::read(&manifest_path)?;
    if manifest.schema_version >= 2 {
        return Ok(None);
    }
    let db_path = root.join(&manifest.paths.db);
    let backup_path = backup_path_for(&db_path);
    Ok(Some(MigrationPreview {
        project_name: manifest.name,
        db_path,
        backup_path,
    }))
}

/// Pre-open: idempotent backup of the v1 SQLite db so a failed
/// migration is recoverable. No-op when manifest is already v2.
pub fn pre_open_v1_to_v2(root: &Path, manifest: &Manifest) -> Result<()> {
    if manifest.schema_version >= 2 {
        return Ok(());
    }
    let db_path = root.join(&manifest.paths.db);
    if !db_path.exists() {
        // Fresh project with no db file yet — nothing to back up.
        // Shouldn't happen in practice (Project::open guards
        // against missing manifest, db is created alongside) but
        // defensive: empty backup is meaningless, skip.
        return Ok(());
    }
    let backup_path = backup_path_for(&db_path);
    if backup_path.exists() {
        // Already backed up by a prior open. Don't overwrite —
        // the existing .bak is the user's known-good v1 state.
        tracing::debug!(
            backup = %backup_path.display(),
            "v1→v2 backup already exists; skipping",
        );
        return Ok(());
    }
    std::fs::copy(&db_path, &backup_path).map_err(|e| Error::io(&backup_path, e))?;
    tracing::info!(
        from = %db_path.display(),
        to = %backup_path.display(),
        "v1→v2 migration: backed up series.db",
    );
    Ok(())
}

/// Post-open: runs after `db::open` succeeded. Creates the
/// `blobs/` directory and bumps the manifest schema_version
/// atomically (temp+rename). No-op when manifest is already v2.
pub fn post_open_v1_to_v2(root: &Path, manifest: &mut Manifest) -> Result<()> {
    if manifest.schema_version >= 2 {
        return Ok(());
    }
    // 1. Create blobs/ directory (empty; on-disk BlobStore
    //    backing flips it active in a post-v2.0 phase). `create_
    //    dir_all` is idempotent → safe on re-open if we crashed
    //    between dir creation and manifest bump on a prior pass.
    let blobs_dir = root.join("blobs");
    std::fs::create_dir_all(&blobs_dir).map_err(|e| Error::io(&blobs_dir, e))?;

    // 2. Bump manifest + atomic write. `write_atomic` shadows
    //    the existing `Manifest::write` (which is plain
    //    `fs::write`) so a crash mid-migration doesn't leave a
    //    truncated manifest on disk.
    manifest.schema_version = 2;
    let manifest_path = root.join(MANIFEST_FILENAME);
    write_manifest_atomic(manifest, &manifest_path)?;
    tracing::info!(
        path = %manifest_path.display(),
        "v1→v2 migration: bumped manifest schema_version to 2",
    );
    Ok(())
}

/// Atomic manifest write — temp file + fsync + rename so a crash mid-
/// migration leaves either the old manifest intact OR the new one in
/// place, never a torn write. Shares the crash-safe writer with
/// `Manifest::write` / recent-projects (#49).
fn write_manifest_atomic(manifest: &Manifest, path: &Path) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(manifest)?;
    crate::fs_atomic::atomic_write(path, &bytes).map_err(|e| crate::error::Error::io(path, e))
}

/// Compute the backup path for a given db file. Internal helper
/// + exported so the future "Restore v1 backup" UI button can
/// locate the file without re-implementing the suffix logic.
pub fn backup_path_for(db_path: &Path) -> std::path::PathBuf {
    // Append the suffix to the FULL path (including extension)
    // so `series.db` → `series.db.bak.v1`. `with_extension`
    // would replace `.db` with the new suffix — wrong.
    let mut s = db_path.as_os_str().to_owned();
    s.push(V1_BACKUP_SUFFIX);
    std::path::PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn backup_path_appends_suffix_keeps_extension() {
        let p = std::path::Path::new("series.db");
        assert_eq!(backup_path_for(p), std::path::Path::new("series.db.bak.v1"));
        let p2 = std::path::Path::new("/tmp/p/series.db");
        assert_eq!(
            backup_path_for(p2),
            std::path::Path::new("/tmp/p/series.db.bak.v1"),
        );
    }

    #[test]
    fn pre_open_noop_for_v2_manifest() {
        let dir = TempDir::new().unwrap();
        let manifest = Manifest {
            schema_version: 2,
            ..test_manifest()
        };
        // No db file present + no backup attempt — pre_open just
        // returns Ok when manifest is already v2.
        pre_open_v1_to_v2(dir.path(), &manifest).unwrap();
        assert!(!dir.path().join("series.db.bak.v1").exists());
    }

    #[test]
    fn pre_open_creates_backup_when_v1_and_db_exists() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("series.db"), b"v1 db bytes").unwrap();
        let manifest = test_manifest();
        pre_open_v1_to_v2(dir.path(), &manifest).unwrap();
        let backup = dir.path().join("series.db.bak.v1");
        assert!(backup.exists());
        assert_eq!(std::fs::read(&backup).unwrap(), b"v1 db bytes");
    }

    #[test]
    fn pre_open_skips_if_backup_already_exists() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("series.db"), b"new db bytes").unwrap();
        std::fs::write(dir.path().join("series.db.bak.v1"), b"old backup").unwrap();
        let manifest = test_manifest();
        pre_open_v1_to_v2(dir.path(), &manifest).unwrap();
        // Backup is unchanged — we never overwrite an existing
        // v1 backup, even if the db has moved on.
        assert_eq!(
            std::fs::read(dir.path().join("series.db.bak.v1")).unwrap(),
            b"old backup",
        );
    }

    #[test]
    fn post_open_creates_blobs_dir_and_bumps_manifest() {
        let dir = TempDir::new().unwrap();
        // Seed a v1 manifest on disk so post_open's atomic write
        // has somewhere to rename onto.
        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        let mut manifest = test_manifest();
        write_manifest_atomic(&manifest, &manifest_path).unwrap();

        post_open_v1_to_v2(dir.path(), &mut manifest).unwrap();
        assert!(dir.path().join("blobs").is_dir());
        assert_eq!(manifest.schema_version, 2);

        // On-disk manifest reflects the bump.
        let on_disk = Manifest::read(&manifest_path).unwrap();
        assert_eq!(on_disk.schema_version, 2);
    }

    #[test]
    fn peek_returns_some_for_v1_manifest() {
        let dir = TempDir::new().unwrap();
        let mut manifest = test_manifest();
        manifest.name = "My V1 Project".into();
        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        write_manifest_atomic(&manifest, &manifest_path).unwrap();
        let preview = peek_migration(dir.path()).unwrap().unwrap();
        assert_eq!(preview.project_name, "My V1 Project");
        assert_eq!(preview.db_path, dir.path().join("series.db"));
        assert_eq!(
            preview.backup_path,
            dir.path().join("series.db.bak.v1"),
        );
    }

    #[test]
    fn peek_returns_none_for_v2_manifest() {
        let dir = TempDir::new().unwrap();
        let manifest = Manifest {
            schema_version: 2,
            ..test_manifest()
        };
        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        write_manifest_atomic(&manifest, &manifest_path).unwrap();
        assert!(peek_migration(dir.path()).unwrap().is_none());
    }

    #[test]
    fn peek_errors_for_missing_manifest() {
        let dir = TempDir::new().unwrap();
        let err = peek_migration(dir.path()).unwrap_err();
        assert!(matches!(err, Error::NotAProject(_)));
    }

    #[test]
    fn post_open_noop_for_v2_manifest() {
        let dir = TempDir::new().unwrap();
        let mut manifest = Manifest {
            schema_version: 2,
            ..test_manifest()
        };
        post_open_v1_to_v2(dir.path(), &mut manifest).unwrap();
        // No blobs/ dir attempt — early return.
        assert!(!dir.path().join("blobs").exists());
        assert_eq!(manifest.schema_version, 2);
    }

    fn test_manifest() -> Manifest {
        use chrono::Utc;
        use uuid::Uuid;
        Manifest {
            schema_version: 1,
            format: "koharu-project".into(),
            id: Uuid::new_v4(),
            name: "test".into(),
            name_original: None,
            koharu_version: "1.2.2".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            paths: crate::manifest::ManifestPaths::default(),
            default_provider_profile: None,
            default_prompt_template: None,
            tags: Vec::new(),
        }
    }
}
