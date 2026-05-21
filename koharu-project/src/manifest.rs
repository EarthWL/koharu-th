//! `series.koharuproj` — the manifest file at the project root.
//!
//! Manifest is intentionally thin (~1KB JSON). Heavy data lives in the
//! sibling SQLite file. The manifest exists so the OS can recognize a
//! koharu project folder without opening the DB.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{Error, Result};

/// Highest manifest schema version this build understands.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Filename of the manifest inside a project root.
pub const MANIFEST_FILENAME: &str = "series.koharuproj";

/// Magic value for the `format` field.
const FORMAT_TAG: &str = "koharu-project";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub format: String,
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub name_original: Option<String>,
    pub koharu_version: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub paths: ManifestPaths,
    #[serde(default)]
    pub default_provider_profile: Option<String>,
    #[serde(default)]
    pub default_prompt_template: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPaths {
    pub db: String,
    pub chapters_dir: String,
    pub reference_dir: String,
    pub assets_dir: String,
    pub export_dir: String,
}

impl Default for ManifestPaths {
    fn default() -> Self {
        Self {
            db: "series.db".into(),
            chapters_dir: "chapters".into(),
            reference_dir: "reference".into(),
            assets_dir: "assets".into(),
            export_dir: "export".into(),
        }
    }
}

impl Manifest {
    /// Build a fresh manifest for a new project.
    pub fn new(name: impl Into<String>, koharu_version: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            schema_version: SUPPORTED_SCHEMA_VERSION,
            format: FORMAT_TAG.into(),
            id: Uuid::new_v4(),
            name: name.into(),
            name_original: None,
            koharu_version: koharu_version.into(),
            created_at: now,
            updated_at: now,
            paths: ManifestPaths::default(),
            default_provider_profile: None,
            default_prompt_template: None,
            tags: Vec::new(),
        }
    }

    /// Read a manifest from disk and validate its shape.
    pub fn read(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let bytes = std::fs::read(path).map_err(|e| Error::io(path, e))?;
        let manifest: Self = serde_json::from_slice(&bytes)?;

        if manifest.format != FORMAT_TAG {
            return Err(Error::InvalidManifest {
                path: path.into(),
                reason: format!("expected format='{FORMAT_TAG}', got '{}'", manifest.format),
            });
        }
        if manifest.schema_version > SUPPORTED_SCHEMA_VERSION {
            return Err(Error::UnsupportedSchema {
                found: manifest.schema_version,
                supported: SUPPORTED_SCHEMA_VERSION,
            });
        }
        Ok(manifest)
    }

    /// Write the manifest to disk, pretty-printed for human readability.
    pub fn write(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        let bytes = serde_json::to_vec_pretty(self)?;

        // Write to temporary file first (Defensive Programming: Atomic Write Pattern)
        let tmp_path = path.with_extension("koharuproj.tmp");
        std::fs::write(&tmp_path, &bytes).map_err(|e| Error::io(&tmp_path, e))?;

        // Atomically rename temporary file to target path
        std::fs::rename(&tmp_path, path).map_err(|e| Error::io(path, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trip_preserves_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(MANIFEST_FILENAME);

        let mut m = Manifest::new("Onmyouji Tales", "0.37.0-th.1");
        m.name_original = Some("陰陽師物語".into());
        m.tags = vec!["fantasy".into(), "shounen".into()];
        m.write(&path).unwrap();

        let loaded = Manifest::read(&path).unwrap();
        assert_eq!(loaded.id, m.id);
        assert_eq!(loaded.name, "Onmyouji Tales");
        assert_eq!(loaded.name_original.as_deref(), Some("陰陽師物語"));
        assert_eq!(loaded.tags, vec!["fantasy", "shounen"]);
        assert_eq!(loaded.paths.db, "series.db");
    }

    #[test]
    fn rejects_wrong_format_tag() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(MANIFEST_FILENAME);
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"format":"not-koharu","id":"00000000-0000-0000-0000-000000000000","name":"x","koharuVersion":"0","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","paths":{"db":"series.db","chaptersDir":"chapters","referenceDir":"reference","assetsDir":"assets","exportDir":"export"}}"#,
        )
        .unwrap();
        assert!(matches!(
            Manifest::read(&path),
            Err(Error::InvalidManifest { .. })
        ));
    }

    #[test]
    fn rejects_future_schema_version() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(MANIFEST_FILENAME);
        std::fs::write(
            &path,
            r#"{"schemaVersion":999,"format":"koharu-project","id":"00000000-0000-0000-0000-000000000000","name":"x","koharuVersion":"0","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","paths":{"db":"series.db","chaptersDir":"chapters","referenceDir":"reference","assetsDir":"assets","exportDir":"export"}}"#,
        )
        .unwrap();
        assert!(matches!(
            Manifest::read(&path),
            Err(Error::UnsupportedSchema { .. })
        ));
    }
}
