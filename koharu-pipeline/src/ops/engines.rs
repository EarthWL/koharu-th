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
pub async fn hardware_detected(_state: AppResources) -> Result<DetectedHardware> {
    Ok(koharu_engines::probe())
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
/// Returns the new snapshot so the caller can confirm the round-
/// trip — useful when the UI wants to invalidate a query cache.
pub async fn engine_profile_set(
    state: AppResources,
    payload: EngineProfileSetPayload,
) -> Result<EngineProfile> {
    state.engine_profile.replace(payload.profile)?;
    Ok(state.engine_profile.snapshot())
}
