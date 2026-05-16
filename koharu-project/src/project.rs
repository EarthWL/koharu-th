//! A `Project` ties together the manifest, the SQLite DB, and the on-disk
//! folder layout. Lifecycle: `create` for a fresh project, `open` for an
//! existing one.

use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::params;

use crate::db::{self, Pool};
use crate::error::{Error, Result};
use crate::manifest::{Manifest, MANIFEST_FILENAME};

/// Open project handle. Cheap to clone (the pool is internally Arc-shared).
#[derive(Clone, Debug)]
pub struct Project {
    root: PathBuf,
    manifest: Manifest,
    pool: Pool,
}

impl Project {
    /// Create a brand-new project rooted at `root`. The directory must not
    /// already contain a manifest. Sub-directories (`chapters/`, etc.) are
    /// created as needed.
    pub fn create(
        root: impl AsRef<Path>,
        name: impl Into<String>,
        koharu_version: impl Into<String>,
    ) -> Result<Self> {
        let root = root.as_ref();
        let manifest_path = root.join(MANIFEST_FILENAME);
        if manifest_path.exists() {
            return Err(Error::AlreadyExists(root.into()));
        }

        std::fs::create_dir_all(root).map_err(|e| Error::io(root, e))?;

        let manifest = Manifest::new(name, koharu_version);
        for sub in [
            &manifest.paths.chapters_dir,
            &manifest.paths.reference_dir,
            &manifest.paths.assets_dir,
            &manifest.paths.export_dir,
        ] {
            let d = root.join(sub);
            std::fs::create_dir_all(&d).map_err(|e| Error::io(d, e))?;
        }

        let pool = db::open(root.join(&manifest.paths.db))?;
        seed_series_meta(&pool, &manifest)?;
        crate::prompt::seed_defaults(&pool.get()?)?;
        manifest.write(&manifest_path)?;

        Ok(Self {
            root: root.to_path_buf(),
            manifest,
            pool,
        })
    }

    /// Open an existing project rooted at `root`.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let manifest_path = root.join(MANIFEST_FILENAME);
        if !manifest_path.exists() {
            return Err(Error::NotAProject(root.into()));
        }
        let manifest = Manifest::read(&manifest_path)?;
        let pool = db::open(root.join(&manifest.paths.db))?;
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
            pool,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    pub fn chapters_dir(&self) -> PathBuf {
        self.root.join(&self.manifest.paths.chapters_dir)
    }
}

/// Seed the singleton row in `series_meta` for a newly-created project.
fn seed_series_meta(pool: &Pool, manifest: &Manifest) -> Result<()> {
    let now = Utc::now().timestamp();
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO series_meta
            (id, title, source_language, target_language, created_at, updated_at)
         VALUES (1, ?1, 'ja', 'th', ?2, ?2)",
        params![manifest.name, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn create_then_open_round_trip() {
        let dir = tempdir().unwrap();

        let p = Project::create(dir.path(), "Onmyouji Tales", "0.37.0-th.1").unwrap();
        assert!(dir.path().join(MANIFEST_FILENAME).exists());
        assert!(dir.path().join("series.db").exists());
        assert!(dir.path().join("chapters").is_dir());
        let project_id = p.manifest.id;
        drop(p);

        let reopened = Project::open(dir.path()).unwrap();
        assert_eq!(reopened.manifest.id, project_id);
        assert_eq!(reopened.manifest.name, "Onmyouji Tales");

        let title: String = reopened
            .pool()
            .get()
            .unwrap()
            .query_row("SELECT title FROM series_meta WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Onmyouji Tales");
    }

    #[test]
    fn create_refuses_existing_project() {
        let dir = tempdir().unwrap();
        Project::create(dir.path(), "x", "0").unwrap();
        let err = Project::create(dir.path(), "y", "0").unwrap_err();
        assert!(matches!(err, Error::AlreadyExists(_)));
    }

    #[test]
    fn open_refuses_non_project_directory() {
        let dir = tempdir().unwrap();
        let err = Project::open(dir.path()).unwrap_err();
        assert!(matches!(err, Error::NotAProject(_)));
    }
}
