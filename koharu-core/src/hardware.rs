//! `HardwareReq`, `DetectedHardware`, `EngineCost`.
//!
//! These types drive the user-facing Engine Profile UI (Phase 4) —
//! every engine declares what hardware it needs; the UI probes the
//! machine on launch and surfaces compatibility chips per engine
//! per pipeline stage.
//!
//! Phase 1 ships the type skeleton + a stub `DetectedHardware`
//! constructor that returns "unknown" for everything. Phase 3
//! replaces the stub with actual probes (`cudarc::driver` on
//! CUDA, `metal::Device::system_default` on macOS, `ash` on
//! Vulkan).

use serde::{Deserialize, Serialize};

/// Hardware requirements declared by an engine.
///
/// All fields use `Option` for "unknown / not relevant" — an engine
/// that runs equally well on CPU and GPU sets `min_vram_mb: None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareReq {
    /// Minimum VRAM in MB to load the model at native precision.
    /// `None` = CPU-only engine, or memory pressure not modeled.
    pub min_vram_mb: Option<u32>,

    /// Preferred CUDA compute capability. Engine will run on lower
    /// caps but with degraded performance (or fall back to CPU).
    /// `None` = no preference.
    pub prefers_compute_cap: Option<f32>,

    /// Which backends the engine can run on. Used to grey-out
    /// engines that can't run on the user's box.
    pub backends: BackendSupport,

    /// Weights download size in MB. Surfaced as a warning when the
    /// user picks an engine whose weights aren't cached yet.
    pub weights_size_mb: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendSupport {
    pub cuda: bool,
    pub metal: bool,
    pub vulkan: bool,
    pub cpu_fallback: bool,
}

impl BackendSupport {
    /// Engine that only runs on CUDA (e.g. CUDA-kernel-only models).
    pub const fn cuda_only() -> Self {
        Self {
            cuda: true,
            metal: false,
            vulkan: false,
            cpu_fallback: false,
        }
    }

    /// Engine that runs on any backend (CPU is acceptable). Most of
    /// our lightweight engines fit this profile.
    pub const fn any() -> Self {
        Self {
            cuda: true,
            metal: true,
            vulkan: true,
            cpu_fallback: true,
        }
    }
}

/// Cost characteristics for the cost-dashboard + engine picker UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineCost {
    /// Approximate USD per call. `Some` for cloud engines (Vision
    /// OCR via Gemini, GPT-4o, etc.). `None` for local engines.
    pub per_call_usd: Option<f64>,

    /// True if the engine runs locally (no network call, no spend).
    pub local: bool,
}

impl EngineCost {
    pub const fn local() -> Self {
        Self {
            per_call_usd: None,
            local: true,
        }
    }

    pub const fn cloud(per_call_usd: f64) -> Self {
        Self {
            per_call_usd: Some(per_call_usd),
            local: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuVendor {
    Nvidia,
    Apple,
    Amd,
    Intel,
    Unknown,
}

/// Snapshot of the host's hardware capabilities at app launch.
///
/// Re-probed on user request via Settings → Engines → Re-probe. We
/// do NOT poll continuously — the UI assumes hardware is stable for
/// the session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedHardware {
    pub gpu_vendor: Option<GpuVendor>,
    pub gpu_name: Option<String>,
    pub vram_mb: Option<u32>,
    pub compute_cap: Option<f32>,
    pub cuda_available: bool,
    pub metal_available: bool,
    pub vulkan_available: bool,
}

impl DetectedHardware {
    /// Stub that returns "nothing detected" — Phase 3 replaces with
    /// real `cudarc::driver` / `metal-rs` / `ash` probes. Tests of
    /// downstream UI code can construct this directly.
    pub fn stub() -> Self {
        Self {
            gpu_vendor: Some(GpuVendor::Unknown),
            gpu_name: None,
            vram_mb: None,
            compute_cap: None,
            cuda_available: false,
            metal_available: false,
            vulkan_available: false,
        }
    }

    /// Check whether an engine's requirements fit this hardware.
    /// Returns a result the UI can display directly (chip colour +
    /// warning text).
    pub fn check_compatibility(&self, req: &HardwareReq) -> CompatibilityCheck {
        // CPU-fallback engines always fit.
        if req.backends.cpu_fallback && req.min_vram_mb.is_none() {
            return CompatibilityCheck::Fits;
        }

        let backend_ok = (req.backends.cuda && self.cuda_available)
            || (req.backends.metal && self.metal_available)
            || (req.backends.vulkan && self.vulkan_available)
            || req.backends.cpu_fallback;
        if !backend_ok {
            return CompatibilityCheck::NoBackend;
        }

        if let (Some(need), Some(have)) = (req.min_vram_mb, self.vram_mb) {
            if need > have {
                return CompatibilityCheck::OverVram { need, have };
            }
        }

        if let (Some(prefers), Some(have)) = (req.prefers_compute_cap, self.compute_cap) {
            if prefers > have {
                return CompatibilityCheck::BelowComputeCap { prefers, have };
            }
        }

        CompatibilityCheck::Fits
    }
}

/// Outcome of `DetectedHardware::check_compatibility`. UI maps each
/// variant to a chip colour + tooltip text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CompatibilityCheck {
    /// Engine runs comfortably on this hardware.
    Fits,
    /// Requested VRAM exceeds detected. User can still proceed with
    /// warning — the engine may fall back to CPU or fail at load.
    OverVram { need: u32, have: u32 },
    /// Engine prefers a higher CUDA compute cap. Will run but at
    /// reduced performance.
    BelowComputeCap { prefers: f32, have: f32 },
    /// No backend overlap — engine can't run on this hardware at all.
    /// UI should grey-out + tooltip "requires CUDA/Metal/Vulkan".
    NoBackend,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rtx_4060() -> DetectedHardware {
        DetectedHardware {
            gpu_vendor: Some(GpuVendor::Nvidia),
            gpu_name: Some("RTX 4060".into()),
            vram_mb: Some(8192),
            compute_cap: Some(8.9),
            cuda_available: true,
            metal_available: false,
            vulkan_available: false,
        }
    }

    #[test]
    fn cpu_engine_always_fits() {
        let hw = DetectedHardware::stub();
        let req = HardwareReq {
            min_vram_mb: None,
            prefers_compute_cap: None,
            backends: BackendSupport {
                cuda: false,
                metal: false,
                vulkan: false,
                cpu_fallback: true,
            },
            weights_size_mb: 10,
        };
        assert_eq!(hw.check_compatibility(&req), CompatibilityCheck::Fits);
    }

    #[test]
    fn over_vram_returns_warning() {
        let hw = rtx_4060(); // 8 GB
        let req = HardwareReq {
            min_vram_mb: Some(12_000), // AOT inpaint hypothetical
            prefers_compute_cap: None,
            backends: BackendSupport::cuda_only(),
            weights_size_mb: 800,
        };
        assert_eq!(
            hw.check_compatibility(&req),
            CompatibilityCheck::OverVram {
                need: 12_000,
                have: 8192
            }
        );
    }

    #[test]
    fn metal_engine_on_nvidia_box_no_backend() {
        let hw = rtx_4060(); // CUDA only, no Metal
        let req = HardwareReq {
            min_vram_mb: Some(2000),
            prefers_compute_cap: None,
            backends: BackendSupport {
                cuda: false,
                metal: true,
                vulkan: false,
                cpu_fallback: false,
            },
            weights_size_mb: 50,
        };
        assert_eq!(hw.check_compatibility(&req), CompatibilityCheck::NoBackend);
    }

    #[test]
    fn comfortable_fit() {
        let hw = rtx_4060();
        let req = HardwareReq {
            min_vram_mb: Some(2000),
            prefers_compute_cap: Some(7.5),
            backends: BackendSupport::cuda_only(),
            weights_size_mb: 80,
        };
        assert_eq!(hw.check_compatibility(&req), CompatibilityCheck::Fits);
    }
}
