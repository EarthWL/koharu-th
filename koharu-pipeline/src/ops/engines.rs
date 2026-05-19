//! RPC ops for the Engine Profile UI (Phase 4.7).
//!
//! Surfaces the v2 engine system to the frontend so the sidebar
//! "Engines" tab can render:
//!
//! - The list of registered engines (`engines_list`).
//! - The probed hardware snapshot for compatibility chips
//!   (`hardware_detected`).
//!
//! Settings persistence + active-engine-per-slot saving land in
//! Phase 4.7b/c — this op module ships the read-only foundation.

use anyhow::Result;
use koharu_core::DetectedHardware;
use koharu_engines::info::{EngineInfoView, all_engines};

use crate::AppResources;

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
/// initial load. A future cache (Phase 4.7b) can store the probe
/// result in `AppResources` if it becomes hot.
pub async fn hardware_detected(_state: AppResources) -> Result<DetectedHardware> {
    Ok(koharu_engines::probe())
}
