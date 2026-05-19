//! `PipelineRunOptions` — per-run engine configuration bag.
//!
//! The driver in `koharu-app` builds this from the user's saved
//! preferences (matching each engine's
//! [`SettingDescriptor`](crate::settings::SettingDescriptor) schema)
//! and threads it through `EngineCtx` at run time. Engines read
//! typed values via `EngineCtx::setting::<T>(key)` (Phase 3); the
//! resolver under that helper looks the key up here and coerces via
//! [`SettingValue::from_stored`](crate::settings::SettingValue).
//!
//! See `docs/v2-arch.md` §4.4 (re-review issue J resolution): every
//! engine declares its own knobs on `EngineInfo::settings_schema`;
//! the Profile UI auto-generates form controls; the driver loads
//! saved values from the prefs store and packages them here.
//!
//! ## Phase 1.2 scope — stub
//!
//! Map shape only. Phase 3 wires the actual `ctx.setting::<T>` call
//! site once `EngineCtx` is defined. Phase 4 connects the prefs
//! store reader that materializes this from a user's saved settings
//! per engine.
//!
//! ## Why a flat key-value bag, not nested per-engine
//!
//! - Engines own their key namespace (`lama.max_crop_size`,
//!   `anime_yolo.confidence`) — no collision risk.
//! - One flat map keeps the driver's plumbing simple: load all keys
//!   for the active engine, drop them in, forward to `run`.
//! - Plugin engines work without the driver knowing about them
//!   ahead of time.
//!
//! ## What's deliberately NOT here
//!
//! - **Cancellation** — lives on `EngineCtx.cancel` as a
//!   `CancellationToken`, not a setting.
//! - **Pipeline-level toggles** (skip detect, skip OCR, etc.) — those
//!   are driver concerns; they decide *whether* to run an engine,
//!   not *how* an engine behaves once running. Stay as
//!   `PipelineRunOptions::skip_*` fields if/when needed; for now
//!   the existing `process()` flow handles them at the dispatch
//!   layer.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::settings::{SettingValue, StoredValue};

/// Per-run engine configuration. One instance is built per pipeline
/// invocation; engines see it through `EngineCtx.options`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PipelineRunOptions {
    /// Engine-scoped setting values, keyed by the
    /// [`SettingDescriptor`]'s `id`. Engines declare their own ids;
    /// the driver merges them all into a single map per run.
    pub settings: HashMap<String, StoredValue>,
}

impl PipelineRunOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a setting value. Returns `&mut Self` for chained
    /// construction in tests.
    pub fn with(mut self, key: impl Into<String>, value: StoredValue) -> Self {
        self.settings.insert(key.into(), value);
        self
    }

    /// Look up the raw stored value for `key`.
    pub fn get_raw(&self, key: &str) -> Option<&StoredValue> {
        self.settings.get(key)
    }

    /// Resolve a typed setting via the [`SettingValue`] trait.
    /// Returns `None` if the key is missing OR the stored value's
    /// type doesn't match the requested `T` — the driver wires
    /// `EngineCtx::setting` to fall back to the engine's schema
    /// default in that case.
    pub fn get<T: SettingValue>(&self, key: &str) -> Option<T> {
        self.settings.get(key).and_then(T::from_stored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_options_has_no_settings() {
        let opts = PipelineRunOptions::new();
        assert!(opts.settings.is_empty());
        assert_eq!(opts.get::<f64>("lama.max_crop_size"), None);
    }

    #[test]
    fn typed_lookup_resolves_correct_type() {
        let opts = PipelineRunOptions::new()
            .with("lama.max_crop_size", StoredValue::Number(768.0))
            .with("translate.streaming", StoredValue::Bool(true))
            .with("translate.model", StoredValue::String("claude-sonnet-4-6".into()));

        assert_eq!(opts.get::<f64>("lama.max_crop_size"), Some(768.0));
        assert_eq!(opts.get::<bool>("translate.streaming"), Some(true));
        assert_eq!(
            opts.get::<String>("translate.model"),
            Some("claude-sonnet-4-6".into())
        );
    }

    #[test]
    fn type_mismatch_yields_none_not_panic() {
        let opts = PipelineRunOptions::new()
            .with("lama.max_crop_size", StoredValue::Number(768.0));

        // Caller asked for bool, stored as number — coerce returns
        // None so the driver can fall back to schema default.
        assert_eq!(opts.get::<bool>("lama.max_crop_size"), None);
        assert_eq!(opts.get::<String>("lama.max_crop_size"), None);
    }

    #[test]
    fn missing_key_returns_none() {
        let opts = PipelineRunOptions::new();
        assert_eq!(opts.get::<f64>("not.present"), None);
        assert!(opts.get_raw("not.present").is_none());
    }

    #[test]
    fn run_options_round_trip_through_json() {
        let opts = PipelineRunOptions::new()
            .with("k_num", StoredValue::Number(1.5))
            .with("k_bool", StoredValue::Bool(false))
            .with("k_str", StoredValue::String("v".into()));

        let json = serde_json::to_string(&opts).unwrap();
        let parsed: PipelineRunOptions = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.get::<f64>("k_num"), Some(1.5));
        assert_eq!(parsed.get::<bool>("k_bool"), Some(false));
        assert_eq!(parsed.get::<String>("k_str"), Some("v".into()));
    }
}
