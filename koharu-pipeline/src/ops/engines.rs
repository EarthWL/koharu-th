//! RPC ops for the Engine Profile UI (Phase 4.7).
//!
//! Surfaces the v2 engine system to the frontend so the sidebar
//! "Engines" tab can render:
//!
//! - The list of registered engines (`engines_list`).
//! - The probed hardware snapshot for compatibility chips
//!   (`hardware_detected`).
//! - The machine-wide engine profile (`engine_profile_get/set`)
//!   that persists active engine per artifact slot + per-engine
//!   setting overrides.

use anyhow::Result;
use koharu_core::DetectedHardware;
use koharu_engines::info::{EngineInfoView, all_engines};

use crate::AppResources;
use crate::engine_profile::EngineProfile;

/// Return every engine currently registered in the binary via
/// `inventory::submit!`, projected to the wire-friendly
/// `EngineInfoView` (strips the load fn ptr; owned Strings).
///
/// Cheap — `inventory::iter` is a linker-collected static; we just
/// walk it. No state mutation, no async.
pub async fn engines_list(_state: AppResources) -> Result<Vec<EngineInfoView>> {
    Ok(all_engines().map(|info| info.to_view()).collect())
}

/// Return the host hardware snapshot. Currently runs the probe per
/// call — the result is small (one `DetectedHardware`) so the cost
/// is negligible, but the Engine Profile UI is the only consumer
/// and it only refreshes on user-triggered "Re-probe" clicks +
/// initial load. A future cache can store the probe result in
/// `AppResources` if it becomes hot.
pub async fn hardware_detected(state: AppResources) -> Result<DetectedHardware> {
    let mut hw = koharu_engines::probe();

    // Ground truth: the raw cudarc probe (koharu_engines::probe) and
    // candle's device selection (koharu_ml::device → state.device) are
    // two independent CUDA detections that can disagree — e.g. the
    // probe's CudaContext::new fails on some driver / dynamic-loading
    // combos while candle already resolved a working CUDA device at
    // startup. If candle is actually running on the accelerator, it IS
    // available; trust that so the Engine tab can't show "CPU only"
    // (every engine "No backend") while inference runs on the GPU.
    // Detail fields (name/VRAM/compute cap) stay best-effort from the
    // raw probe; only availability is reconciled.
    match state.device {
        koharu_ml::Device::Cuda(_) if !hw.cuda_available => {
            hw.cuda_available = true;
            if hw.gpu_vendor.is_none() {
                hw.gpu_vendor = Some(koharu_core::GpuVendor::Nvidia);
            }
        }
        koharu_ml::Device::Metal(_) if !hw.metal_available => {
            hw.metal_available = true;
            if hw.gpu_vendor.is_none() {
                hw.gpu_vendor = Some(koharu_core::GpuVendor::Apple);
            }
        }
        _ => {}
    }

    Ok(hw)
}

/// Read the saved engine profile. Missing file = empty profile —
/// the store handles that case at load time, so this is a clean
/// `snapshot()` of the in-memory shape.
pub async fn engine_profile_get(state: AppResources) -> Result<EngineProfile> {
    Ok(state.engine_profile.snapshot())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfileSetPayload {
    pub profile: EngineProfile,
}

/// Replace the saved engine profile + persist atomically.
/// Kept for edge cases (import/export, full-profile reset). The
/// frontend's per-control mutations use the granular
/// `engine_profile_set_active` / `engine_profile_set_setting`
/// paths instead — concurrent edits no longer trample each
/// other by sending stale full-profile snapshots (audit #6 P2).
pub async fn engine_profile_set(
    state: AppResources,
    payload: EngineProfileSetPayload,
) -> Result<EngineProfile> {
    state.engine_profile.replace(payload.profile)?;
    Ok(state.engine_profile.snapshot())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfileSetActivePayload {
    pub artifact: koharu_core::ArtifactKind,
    pub engine_id: String,
}

/// Granular mutation: set the active engine for one artifact
/// slot. Atomic under the store's internal RwLock; returns the
/// new full snapshot so the caller can update its query cache
/// without a separate `engine_profile_get` roundtrip.
pub async fn engine_profile_set_active(
    state: AppResources,
    payload: EngineProfileSetActivePayload,
) -> Result<EngineProfile> {
    state
        .engine_profile
        .set_active(payload.artifact, payload.engine_id)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfileSetSettingPayload {
    pub engine_id: String,
    pub setting_id: String,
    pub value: koharu_core::StoredValue,
}

/// Granular mutation: set one setting value for one engine.
/// Same atomicity contract as `engine_profile_set_active`.
pub async fn engine_profile_set_setting(
    state: AppResources,
    payload: EngineProfileSetSettingPayload,
) -> Result<EngineProfile> {
    state
        .engine_profile
        .set_setting(payload.engine_id, payload.setting_id, payload.value)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfileClearSettingPayload {
    pub engine_id: String,
    pub setting_id: String,
}

/// Granular mutation: drop one setting override so the engine
/// falls back to its `SettingDescriptor` default at runtime.
/// Wired to the per-setting "reset to default" button in the
/// Engine Profile UI.
pub async fn engine_profile_clear_setting(
    state: AppResources,
    payload: EngineProfileClearSettingPayload,
) -> Result<EngineProfile> {
    state
        .engine_profile
        .clear_setting(payload.engine_id, payload.setting_id)
}
