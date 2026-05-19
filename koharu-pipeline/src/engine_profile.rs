//! Machine-wide engine profile storage.
//!
//! Two pieces of state, both per-machine (not per-project):
//!
//! 1. **Active engine per artifact slot** — which engine the user
//!    has picked for each ambiguous-producer slot (e.g.
//!    `ArtifactKind::OcrText` → `"manga_ocr"`). The bridge reads
//!    this when call-sites stop hardcoding the engine id (F4.D).
//! 2. **Per-engine setting overrides** — flat key-value map of
//!    saved [`StoredValue`](koharu_core::StoredValue) per engine,
//!    keyed by the engine's `SettingDescriptor.id`. EngineCtx
//!    threads these through `PipelineRunOptions` so engines read
//!    them via `ctx.setting::<T>(...)`.
//!
//! Both pieces live in a single JSON file at
//! `<APP_ROOT>/engine_profile.json`. Path is configurable via
//! `EngineProfileStore::with_path` for tests + headless mode.
//!
//! ## Locked decision (docs/v2-arch.md §2): machine-wide
//!
//! Per-project profile overrides were considered + dropped — they
//! pull every chapter into "which engine ran which page" state
//! that breaks `ProjectSession` undo + bloats project archives.
//! Per-machine keeps the engine choice orthogonal to project
//! data, matching how upstream + every other multi-engine tool
//! handles it (Photoshop's "current document units" vs "saved
//! file pixel grid").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::RwLock;

use koharu_core::{ArtifactKind, StoredValue};

/// On-disk shape — same as the in-memory shape so load/save is a
/// straight serde round-trip with no projection.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EngineProfile {
    /// `artifact slot → engine id`. Missing key = caller falls
    /// back to its hardcoded default (so existing call-sites keep
    /// working through F4.C → F4.D transition).
    #[serde(default)]
    pub active: HashMap<ArtifactKind, String>,

    /// `engine id → (setting id → StoredValue)`. Missing engine
    /// or missing setting key = engine uses its `SettingDescriptor`
    /// default via `ctx.setting::<T>(..., default)` fallback.
    #[serde(default)]
    pub settings: HashMap<String, HashMap<String, StoredValue>>,
}

/// Thread-safe handle around the on-disk profile. Cloneable Arc
/// inside so `AppResources` can hand copies to ops without
/// re-reading the file per RPC call.
#[derive(Clone, Debug)]
pub struct EngineProfileStore {
    inner: Arc<RwLock<EngineProfile>>,
    path: PathBuf,
}

impl EngineProfileStore {
    /// Load from `path`. Missing file = empty profile (not an
    /// error — fresh installs have nothing to load).
    pub fn load(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let profile = if path.exists() {
            let bytes = std::fs::read(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing engine profile at {}", path.display()))?
        } else {
            EngineProfile::default()
        };
        Ok(Self {
            inner: Arc::new(RwLock::new(profile)),
            path,
        })
    }

    /// Construct from an in-memory profile — used in tests.
    pub fn with_initial(profile: EngineProfile, path: PathBuf) -> Self {
        Self {
            inner: Arc::new(RwLock::new(profile)),
            path,
        }
    }

    /// Snapshot of the profile for RPC responses.
    pub fn snapshot(&self) -> EngineProfile {
        self.inner.read().unwrap().clone()
    }

    /// Replace the entire profile + persist to disk. Kept for
    /// edge cases (import/export, full-profile reset) but the
    /// frontend's per-control mutations should use the granular
    /// `set_active` / `set_setting` paths instead so concurrent
    /// edits don't trample (audit #6 P2).
    pub fn replace(&self, profile: EngineProfile) -> Result<()> {
        self.persist(&profile)?;
        *self.inner.write().unwrap() = profile;
        Ok(())
    }

    /// Look up the active engine id for a given artifact slot.
    /// `None` = no override saved; caller falls back to its own
    /// default.
    pub fn active_engine(&self, artifact: ArtifactKind) -> Option<String> {
        self.inner.read().unwrap().active.get(&artifact).cloned()
    }

    /// Read all setting overrides for `engine_id`. Empty map =
    /// engine uses schema defaults via `ctx.setting` fallback.
    pub fn settings_for(&self, engine_id: &str) -> HashMap<String, StoredValue> {
        self.inner
            .read()
            .unwrap()
            .settings
            .get(engine_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Granular "set the active engine for one artifact slot"
    /// mutation.
    ///
    /// Audit #7/P2 fix: holds the write lock THROUGH persist()
    /// instead of dropping after the in-memory mutation. Without
    /// this, two concurrent set_* calls could see a memory-
    /// correct interleave (T1 mutates {X}, T2 sees {X} then
    /// mutates to {X,Y}) but the persist order could be inverted
    /// (T1's snapshot {X} writes to disk AFTER T2's {X,Y}),
    /// silently dropping Y. Holding the lock during the temp-
    /// file + rename (~ms) costs a few ms of write contention
    /// in exchange for serialised disk writes.
    pub fn set_active(
        &self,
        artifact: ArtifactKind,
        engine_id: String,
    ) -> Result<EngineProfile> {
        let mut guard = self.inner.write().unwrap();
        guard.active.insert(artifact, engine_id);
        let snapshot = guard.clone();
        // Persist while still holding the write lock — see method
        // doc for the race rationale.
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Granular "set one setting for one engine" mutation. Same
    /// atomicity contract as `set_active` — persist runs under
    /// the write lock to prevent disk-write reordering.
    pub fn set_setting(
        &self,
        engine_id: String,
        setting_id: String,
        value: StoredValue,
    ) -> Result<EngineProfile> {
        let mut guard = self.inner.write().unwrap();
        let engine_settings = guard.settings.entry(engine_id).or_default();
        engine_settings.insert(setting_id, value);
        let snapshot = guard.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Internal atomic-write helper extracted from `replace`. Same
    /// temp-file + rename pattern; doesn't touch the in-memory
    /// state (caller has already updated it under the lock).
    fn persist(&self, profile: &EngineProfile) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(profile)
            .context("serializing engine profile")?;
        let tmp = self.path.with_extension("json.tmp");
        if let Some(parent) = tmp.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("ensuring {}", parent.display()))?;
        }
        std::fs::write(&tmp, &bytes)
            .with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("renaming {} → {}", tmp.display(), self.path.display()))?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_store() -> (TempDir, EngineProfileStore) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("engine_profile.json");
        let store = EngineProfileStore::load(&path).unwrap();
        (dir, store)
    }

    #[test]
    fn missing_file_loads_as_empty_profile() {
        let (_dir, store) = tmp_store();
        let snap = store.snapshot();
        assert!(snap.active.is_empty());
        assert!(snap.settings.is_empty());
        assert!(store.active_engine(ArtifactKind::OcrText).is_none());
        assert!(store.settings_for("any_engine").is_empty());
    }

    #[test]
    fn replace_round_trips_through_disk() {
        let (_dir, store) = tmp_store();
        let mut profile = EngineProfile::default();
        profile
            .active
            .insert(ArtifactKind::OcrText, "manga_ocr".into());
        let mut yolo_settings = HashMap::new();
        yolo_settings.insert("variant".into(), StoredValue::String("s".into()));
        yolo_settings.insert("confidence_threshold".into(), StoredValue::Number(0.30));
        profile
            .settings
            .insert("anime_yolo_detector".into(), yolo_settings);
        store.replace(profile.clone()).unwrap();

        // Re-load from the same path — should see the persisted
        // shape.
        let reloaded = EngineProfileStore::load(store.path()).unwrap();
        let snap = reloaded.snapshot();
        assert_eq!(
            snap.active.get(&ArtifactKind::OcrText),
            Some(&"manga_ocr".to_string())
        );
        let yolo = snap.settings.get("anime_yolo_detector").unwrap();
        assert_eq!(
            yolo.get("variant"),
            Some(&StoredValue::String("s".into()))
        );
        assert_eq!(
            yolo.get("confidence_threshold"),
            Some(&StoredValue::Number(0.30))
        );
    }

    /// Audit #6/P2 regression: two concurrent set_* calls land on
    /// different keys (active vs setting) and BOTH survive — the
    /// store's internal RwLock serialises the writes, no stale
    /// snapshot trampling.
    #[test]
    fn granular_mutations_do_not_trample_each_other() {
        let (_dir, store) = tmp_store();
        let snap_a = store
            .set_active(ArtifactKind::OcrText, "manga_ocr".into())
            .unwrap();
        assert_eq!(
            snap_a.active.get(&ArtifactKind::OcrText),
            Some(&"manga_ocr".to_string()),
        );

        let snap_b = store
            .set_setting(
                "anime_yolo_detector".into(),
                "variant".into(),
                StoredValue::String("s".into()),
            )
            .unwrap();
        assert_eq!(
            snap_b.active.get(&ArtifactKind::OcrText),
            Some(&"manga_ocr".to_string()),
            "active engine from set_a survives set_b",
        );
        assert_eq!(
            snap_b
                .settings
                .get("anime_yolo_detector")
                .and_then(|s| s.get("variant")),
            Some(&StoredValue::String("s".into())),
            "new setting from set_b is present",
        );

        // Reload from disk — both writes persisted atomically.
        let reloaded = EngineProfileStore::load(store.path()).unwrap();
        let final_snap = reloaded.snapshot();
        assert_eq!(
            final_snap.active.get(&ArtifactKind::OcrText),
            Some(&"manga_ocr".to_string()),
        );
        assert_eq!(
            final_snap
                .settings
                .get("anime_yolo_detector")
                .and_then(|s| s.get("variant")),
            Some(&StoredValue::String("s".into())),
        );
    }

    #[test]
    fn active_engine_and_settings_for_helpers_read_through() {
        let (_dir, store) = tmp_store();
        let mut profile = EngineProfile::default();
        profile
            .active
            .insert(ArtifactKind::DetectionBoxes, "anime_yolo_detector".into());
        let mut lama = HashMap::new();
        lama.insert("max_crop_size_px".into(), StoredValue::Number(768.0));
        profile.settings.insert("lama_inpaint".into(), lama);
        store.replace(profile).unwrap();

        assert_eq!(
            store.active_engine(ArtifactKind::DetectionBoxes),
            Some("anime_yolo_detector".to_string())
        );
        assert_eq!(store.active_engine(ArtifactKind::OcrText), None);

        let lama_settings = store.settings_for("lama_inpaint");
        assert_eq!(
            lama_settings.get("max_crop_size_px"),
            Some(&StoredValue::Number(768.0))
        );
        assert!(store.settings_for("unknown_engine").is_empty());
    }
}
