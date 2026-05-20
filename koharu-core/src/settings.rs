//! `SettingDescriptor` + `SettingValue` — engine-declared
//! user-configurable settings schema.
//!
//! Solves issue J from the post-#33 re-review. Every engine declares
//! its tunable parameters on `EngineInfo`; the Engine Profile UI
//! auto-generates form controls from the schema; engine reads typed
//! values via `ctx.setting::<T>(key)` at run time. Plugin engines
//! work for free — no per-engine UI code needed.
//!
//! ## Design constraints
//!
//! - **Schema is `&'static`** so it can be declared in an inventory
//!   submission (the engine registry uses compile-time registration).
//!   No allocation, no init-order issues.
//! - **Values are simple primitives** so they can be persisted in
//!   the preferences store (key-value map) without per-type
//!   schemas. `f64` covers numeric settings; bool covers toggles;
//!   string covers selects.
//! - **Labels are i18n keys**, not literal strings. UI resolves at
//!   render time via the existing `t()` flow. Lets each engine ship
//!   English-source labels that translators backfill into the locale
//!   JSON files.
//!
//! ## What's NOT here
//!
//! - Per-block (text-block-specific) settings. Those go on
//!   `TextBlock.style` in `Scene`, mutated via `Op::UpdateTextBlock`.
//! - Per-project settings. Those go on `series_meta` in
//!   `koharu-project`, mutated via `ProjectOp::UpdateSeriesMeta`.
//! - Machine-wide engine profile selection (which engine is active
//!   per stage). That's a `koharu-app`-level concern; settings here
//!   are PER ENGINE, applying when that engine is the active pick.

use serde::{Deserialize, Serialize};

// Note on Serialize/Deserialize asymmetry below:
// `SettingDescriptor` only travels backend → frontend (the engine
// declares its schema with `&'static` data, the RPC layer serializes
// it for the Engine Profile UI to render the form). The wire is
// strictly outbound, so we derive only `Serialize`. Trying to derive
// `Deserialize` on `&'static [...]` fields would fail anyway —
// borrowed-from-arbitrary-input strings can't outlive the
// deserializer.
//
// `StoredValue` IS deserialized — user-saved setting values come
// back from the preferences store at engine-load time. Owned String
// makes that safe.

/// A single user-tunable setting on an engine. The variant tells the
/// UI what control to render; the inner fields describe the control's
/// constraints + default.
///
/// `id` is the persistence key — it's how the engine reads its
/// value via `ctx.setting::<T>(id)`. Must be stable across engine
/// versions; renaming = settings reset for users.
///
/// `label_i18n_key` is the i18n key for the human-visible label.
/// The actual translation lives in `ui/public/locales/*/translation.json`
/// under the namespace the engine picks (convention:
/// `engineSettings.<engine_id>.<setting_id>`).
#[derive(Debug, Clone, Serialize)]
// `rename_all` renames the variant names for the `kind` tag
// (Slider → "slider", NumberInput → "number_input", …). It does NOT
// touch fields — `rename_all_fields` does that, so `label_i18n_key` /
// `help_i18n_key` go out as `labelI18nKey` / `helpI18nKey` to match the
// TS SettingDescriptor. Without the latter the frontend read those as
// undefined → labels fell back to the raw id and help never rendered.
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SettingDescriptor {
    /// A continuous numeric value with min/max/step bounds. Renders
    /// as a slider (with the current value displayed next to it).
    /// Good for confidence thresholds, opacity, blur radius, etc.
    Slider {
        id: &'static str,
        label_i18n_key: &'static str,
        min: f64,
        max: f64,
        step: f64,
        default: f64,
        /// Optional i18n key for a longer tooltip explaining what
        /// the setting does. `None` = no tooltip.
        help_i18n_key: Option<&'static str>,
    },

    /// A numeric value entered via keyboard, with min/max validation
    /// but no slider track. Good for pixel sizes, token counts —
    /// values where typing a specific number matters more than
    /// dragging.
    NumberInput {
        id: &'static str,
        label_i18n_key: &'static str,
        min: f64,
        max: f64,
        step: f64,
        default: f64,
        help_i18n_key: Option<&'static str>,
    },

    /// Boolean toggle. Renders as a switch / checkbox.
    Toggle {
        id: &'static str,
        label_i18n_key: &'static str,
        default: bool,
        help_i18n_key: Option<&'static str>,
    },

    /// Pick one from a fixed list. Each option has a stable string
    /// value (the persisted setting) and an i18n key for its label.
    Select {
        id: &'static str,
        label_i18n_key: &'static str,
        /// `(value, label_i18n_key)` pairs.
        options: &'static [(&'static str, &'static str)],
        default: &'static str,
        help_i18n_key: Option<&'static str>,
    },
}

impl SettingDescriptor {
    /// The persistence key — same for every variant. Used by the
    /// preferences store to read / write the setting's value.
    pub fn id(&self) -> &'static str {
        match self {
            SettingDescriptor::Slider { id, .. }
            | SettingDescriptor::NumberInput { id, .. }
            | SettingDescriptor::Toggle { id, .. }
            | SettingDescriptor::Select { id, .. } => id,
        }
    }

    /// The i18n key for the label.
    pub fn label_i18n_key(&self) -> &'static str {
        match self {
            SettingDescriptor::Slider { label_i18n_key, .. }
            | SettingDescriptor::NumberInput { label_i18n_key, .. }
            | SettingDescriptor::Toggle { label_i18n_key, .. }
            | SettingDescriptor::Select { label_i18n_key, .. } => label_i18n_key,
        }
    }
}

/// Trait bound for typed setting reads. Engines call
/// `ctx.setting::<f64>("max_crop_size_px")` or
/// `ctx.setting::<bool>("enable_post_process")` etc. The driver
/// looks up the value in the preferences store and parses it via
/// this trait.
///
/// Implementations live alongside the value types they support; the
/// concrete `impl SettingValue for f64 / bool / String` are in this
/// module since they cover the only legal variant payloads.
pub trait SettingValue: Sized {
    /// Coerce the raw stored value (always a JSON-ish primitive) to
    /// the typed value the engine expects. Returns `None` on type
    /// mismatch — driver logs + falls back to the schema default.
    fn from_stored(raw: &StoredValue) -> Option<Self>;
}

/// The wire-friendly union of legal stored values. Matches the
/// shapes that `SettingDescriptor` variants produce.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StoredValue {
    Number(f64),
    Bool(bool),
    String(String),
}

impl SettingValue for f64 {
    fn from_stored(raw: &StoredValue) -> Option<Self> {
        match raw {
            StoredValue::Number(n) => Some(*n),
            _ => None,
        }
    }
}

impl SettingValue for bool {
    fn from_stored(raw: &StoredValue) -> Option<Self> {
        match raw {
            StoredValue::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

impl SettingValue for String {
    fn from_stored(raw: &StoredValue) -> Option<Self> {
        match raw {
            StoredValue::String(s) => Some(s.clone()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLIDER_DEMO: SettingDescriptor = SettingDescriptor::Slider {
        id: "max_crop_size_px",
        label_i18n_key: "engineSettings.lama.maxCropSize",
        min: 256.0,
        max: 2048.0,
        step: 64.0,
        default: 512.0,
        help_i18n_key: Some("engineSettings.lama.maxCropSizeHelp"),
    };

    #[test]
    fn descriptor_id_extracts_uniformly() {
        assert_eq!(SLIDER_DEMO.id(), "max_crop_size_px");
        let toggle = SettingDescriptor::Toggle {
            id: "enabled",
            label_i18n_key: "engineSettings.x.enabled",
            default: true,
            help_i18n_key: None,
        };
        assert_eq!(toggle.id(), "enabled");
    }

    #[test]
    fn descriptor_serializes_with_kind_tag() {
        // Serialize-only (no Deserialize impl) — the schema goes
        // backend → frontend over RPC; frontend reads the JSON
        // directly, doesn't reconstitute a Rust `SettingDescriptor`.
        let s = serde_json::to_string(&SLIDER_DEMO).unwrap();
        // tag = "kind" + rename_all = snake_case → "slider"
        assert!(s.contains("\"kind\":\"slider\""));
        assert!(s.contains("\"id\":\"max_crop_size_px\""));
        assert!(s.contains("\"min\":256"));
        assert!(s.contains("\"default\":512"));
        // rename_all_fields = camelCase → the frontend reads labelI18nKey /
        // helpI18nKey, not the raw snake_case. Without this, labels fell
        // back to the id and help never rendered in the Engines tab.
        assert!(s.contains("\"labelI18nKey\""), "{s}");
        assert!(s.contains("\"helpI18nKey\""), "{s}");
        assert!(!s.contains("label_i18n_key"));
        assert!(!s.contains("help_i18n_key"));
    }

    #[test]
    fn stored_value_typed_read_happy_path() {
        let n = StoredValue::Number(0.45);
        let b = StoredValue::Bool(true);
        let s = StoredValue::String("manual".into());
        assert_eq!(f64::from_stored(&n), Some(0.45));
        assert_eq!(bool::from_stored(&b), Some(true));
        assert_eq!(String::from_stored(&s), Some("manual".into()));
    }

    #[test]
    fn stored_value_type_mismatch_returns_none() {
        // Asking for a bool out of a Number → None (driver falls back
        // to the schema default).
        assert_eq!(bool::from_stored(&StoredValue::Number(1.0)), None);
        assert_eq!(f64::from_stored(&StoredValue::Bool(true)), None);
        assert_eq!(String::from_stored(&StoredValue::Number(42.0)), None);
    }
}
