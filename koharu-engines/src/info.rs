//! `EngineInfo` — static descriptor + compile-time registry.
//!
//! Each engine submits exactly one `EngineInfo` via
//! [`inventory::submit!`] at crate-init time. The driver in
//! `koharu-app` walks the registry (`inventory::iter::<EngineInfo>`)
//! at launch to build the Engine Profile UI and at run-time to look
//! up the active engine per stage.
//!
//! ## Why `inventory`
//!
//! - **No init-order issues.** Submissions are linker-collected;
//!   they don't depend on any one crate's startup code running first.
//! - **Plugin-friendly.** A third-party engine crate just needs to
//!   submit its own `EngineInfo` — no central registration list to
//!   patch, no feature flag to coordinate.
//! - **Static lifetimes everywhere.** `EngineInfo` fields are
//!   `&'static`, so the schema can be referenced from the UI
//!   without copying and from the driver without a registry
//!   lookup per call.
//!
//! Caveat: `inventory` relies on a known set of linker tricks; on
//! some platforms (notably Windows MSVC + lib-only crates) you need
//! to ensure the engine crate is _linked_ even if no symbol is
//! referenced. The standard pattern is for the consumer (driver) to
//! depend on each engine crate at the workspace level so the linker
//! pulls it in. Phase 3.3 lands the first engine; the driver wiring
//! that ensures linkage comes with it.

use serde::Serialize;

use koharu_core::{ArtifactKind, EngineCost, HardwareReq, SettingDescriptor};

/// Compile-time descriptor for one engine.
///
/// Submitted via [`inventory::submit!`] at crate-init time; collected
/// via [`inventory::iter::<EngineInfo>`] at runtime.
///
/// ## Field invariants
///
/// - `id`, `display_name`, `description` are `&'static str` — they
///   end up in static binary data and must outlive every reference
///   to them.
/// - `id` is the stable key used by saved-profile + Engine Profile
///   UI selection. Rename = breaking change. Keep snake_case, no
///   spaces.
/// - `consumes` + `produces` declare the artifact-flow contract
///   used by the DAG resolver (Phase 4). An engine that produces an
///   artifact MUST emit a corresponding `Op::Set*` variant on its
///   first non-error completion send (otherwise the resolver hangs
///   downstream engines that consume it).
/// - `settings_schema` declares the engine's tunable knobs. The
///   Engine Profile UI auto-generates form controls from this
///   schema; engines read typed values via `EngineCtx::setting`.
/// - `hardware` declares minimum + preferred hardware. Engines that
///   *can* fall back to CPU set `cpu_fallback: true`; the
///   `CompatibilityCheck` machinery in `koharu-core::hardware`
///   handles the fit-vs-warn-vs-block logic.
/// - `cost` is metadata for the Profile UI — quick (<1s),
///   moderate (1-10s), slow (>10s), or cloud (USD per call). Lets
///   the user pick informed tradeoffs.
/// - `load` is a function pointer (not a closure) so it sits in
///   read-only memory. Returns a boxed engine on a boxed future
///   (loading may be async — model downloads, GPU init).
#[derive(Debug)]
pub struct EngineInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,

    pub consumes: &'static [ArtifactKind],
    pub produces: &'static [ArtifactKind],

    pub settings_schema: &'static [SettingDescriptor],

    pub hardware: HardwareReq,
    pub cost: EngineCost,

    /// True for the engine the pipeline falls back to when no profile
    /// override is saved for an artifact it produces (e.g.
    /// comic_text_detector for DetectionBoxes, mit48px_ocr for OcrText).
    /// The Engine Profile UI highlights this one as "using default" so
    /// the displayed default matches what `run_engine_for_artifact`
    /// actually resolves. Exactly one engine per artifact should set it.
    pub is_default: bool,

    /// Async constructor. Driver calls this once at first-use and
    /// caches the resulting `Box<dyn Engine>`. Returning a `Box`
    /// gives us dyn-compat for the inventory registry; the boxed
    /// future is heap-allocated but happens once per process so the
    /// cost is irrelevant.
    pub load: LoadFn,
}

/// Function pointer used by [`EngineInfo::load`]. Defined as a type
/// alias so the signature is documented in one place and engines
/// don't have to write the full `for<'a> fn() -> …` shape.
///
/// `Result<Box<dyn Engine>>` because model loading can fail
/// (network errors during weight download, GPU init failures, etc.).
/// The driver propagates the error to the activity bubble.
pub type LoadFn = fn() -> futures::future::BoxFuture<'static, anyhow::Result<Box<dyn crate::Engine>>>;

/// Serializable projection of [`EngineInfo`] for the Engine Profile
/// UI. Stripped of the `load` function (can't serialize a fn ptr) +
/// uses owned strings on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfoView {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub consumes: Vec<ArtifactKind>,
    pub produces: Vec<ArtifactKind>,
    pub settings_schema: Vec<SettingDescriptor>,
    pub hardware: HardwareReq,
    pub cost: EngineCost,
    pub is_default: bool,
}

impl EngineInfo {
    /// Project to the wire-friendly [`EngineInfoView`]. Used by the
    /// RPC layer when the Profile UI requests the engine list.
    pub fn to_view(&self) -> EngineInfoView {
        EngineInfoView {
            id: self.id.to_string(),
            display_name: self.display_name.to_string(),
            description: self.description.to_string(),
            consumes: self.consumes.to_vec(),
            produces: self.produces.to_vec(),
            // `SettingDescriptor` variants hold only `&'static` data
            // (no allocations) so `.to_vec()` simply copies the
            // discriminants + ref-fat-pointers — cheap.
            settings_schema: self.settings_schema.to_vec(),
            hardware: self.hardware.clone(),
            cost: self.cost.clone(),
            is_default: self.is_default,
        }
    }
}

inventory::collect!(EngineInfo);

/// Iterate every engine registered in the binary. Convenience wrapper
/// around `inventory::iter::<EngineInfo>` — keeps callers from
/// importing the `inventory` crate just for the iterator type.
pub fn all_engines() -> impl Iterator<Item = &'static EngineInfo> {
    inventory::iter::<EngineInfo>().into_iter()
}

/// Look up an engine by id. Returns `None` if no engine with that id
/// is registered (typo, stale profile referencing a removed engine,
/// etc.). Driver falls back to the per-stage default.
pub fn find_engine(id: &str) -> Option<&'static EngineInfo> {
    all_engines().find(|info| info.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_core::BackendSupport;

    /// Empty-registry assertion. Phase 3.1 ships no engines; the
    /// first one lands in Phase 3.3 (detector). When this test
    /// starts failing because an engine got registered, update it
    /// to the new count + assert on `find_engine`.
    #[test]
    fn no_engines_registered_yet_in_phase_3_1() {
        assert_eq!(all_engines().count(), 0);
        assert!(find_engine("comic_text_detector").is_none());
    }

    #[test]
    fn engine_info_view_serializes_camelcase() {
        let view = EngineInfoView {
            id: "test".into(),
            display_name: "Test".into(),
            description: "for serde test".into(),
            consumes: vec![ArtifactKind::SourceImage],
            produces: vec![ArtifactKind::DetectionBoxes],
            settings_schema: vec![],
            hardware: HardwareReq {
                min_vram_mb: None,
                prefers_compute_cap: None,
                backends: BackendSupport::any(),
                weights_size_mb: 0,
            },
            cost: EngineCost::local(),
            is_default: true,
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("\"displayName\""));
        assert!(json.contains("\"settingsSchema\""));
        assert!(json.contains("\"isDefault\""));
        // Nested structs must ALSO be camelCase — serde rename_all is
        // per-struct, not recursive. These snake_case leaks made the
        // frontend read `backends.cpuFallback` / `weightsSizeMb` /
        // `perCallUsd` as undefined → every engine showed "No backend".
        assert!(json.contains("\"cpuFallback\""), "BackendSupport leaked snake_case: {json}");
        assert!(json.contains("\"weightsSizeMb\""), "HardwareReq leaked snake_case: {json}");
        assert!(json.contains("\"perCallUsd\""), "EngineCost leaked snake_case: {json}");
        assert!(!json.contains("cpu_fallback"));
        assert!(!json.contains("weights_size_mb"));
        assert!(!json.contains("per_call_usd"));
    }
}
