//! Hardware probe — produces a [`DetectedHardware`] snapshot.
//!
//! Replaces `DetectedHardware::stub()` for real launches. The driver
//! calls [`probe`] once at app startup (after splash, before the
//! engine registry is queried) and caches the result in shared
//! state. Re-probe is exposed on Settings → Engines → Re-probe (the
//! UI route doesn't poll continuously — hardware is assumed stable
//! for the session).
//!
//! ## Probe strategy
//!
//! - **CUDA** (feature `cuda`): try to initialise the first CUDA
//!   device via `cudarc::driver`. Success = `cuda_available: true`.
//!   Detail fields (compute cap, VRAM, GPU name) are best-effort —
//!   anything that fails to query falls back to `None` (UI shows
//!   "unknown" rather than crashing). The dynamic-loading patch
//!   from `mayocream/candle` means we don't crash if `cuda*.dll`
//!   isn't installed; the loader returns an init error which we
//!   treat as "no CUDA".
//! - **Metal** (feature `metal`, macOS only): `MTLCreateSystemDefault
//!   Device()` returning non-null = `metal_available: true`. GPU
//!   name from `device.name()`.
//! - **Vulkan**: not yet implemented. Phase 3.2 sets
//!   `vulkan_available: false` always. A future commit can add `ash`
//!   probe under a `vulkan` feature.
//!
//! ## Failure handling
//!
//! The whole probe is wrapped to never panic. Every probe arm
//! returns `Option<…>` and unwraps via `unwrap_or(default)`. Worst
//! case: probe returns the stub snapshot. UI degrades gracefully
//! (everything shows "unknown" chip).
//!
//! ## Why not in `koharu-core`
//!
//! `koharu-core` is intentionally light (no candle, no GPU deps).
//! `koharu-engines` already pulls in `koharu-ml` (candle, cudarc on
//! feature `cuda`) so adding the probe here adds no new heavy deps.
//! The probe returns a `DetectedHardware` (which IS in `koharu-core`)
//! so consumers handle one common type.

use koharu_core::{DetectedHardware, GpuVendor};

/// Probe the host hardware. Never panics; falls back to "nothing
/// detected" if every backend probe fails.
///
/// Called once at app startup by the driver. The returned snapshot
/// is cached and pushed into the Engine Profile UI for compatibility
/// chip rendering.
pub fn probe() -> DetectedHardware {
    let mut hw = DetectedHardware::stub();

    if let Some(cuda) = probe_cuda() {
        hw.cuda_available = true;
        hw.gpu_vendor = Some(GpuVendor::Nvidia);
        if let Some(name) = cuda.gpu_name {
            hw.gpu_name = Some(name);
        }
        if let Some(cc) = cuda.compute_cap {
            hw.compute_cap = Some(cc);
        }
        if let Some(vram) = cuda.vram_mb {
            hw.vram_mb = Some(vram);
        }
    }

    if let Some(metal) = probe_metal() {
        hw.metal_available = true;
        // Don't overwrite NVIDIA vendor if user has both an
        // NVIDIA GPU (eGPU on Mac, dual-GPU systems) AND Metal —
        // CUDA wins because it's the heavier-perf path most engines
        // prefer. If only Metal is present, mark as Apple.
        if hw.gpu_vendor.is_none() || hw.gpu_vendor == Some(GpuVendor::Unknown) {
            hw.gpu_vendor = Some(GpuVendor::Apple);
        }
        if hw.gpu_name.is_none() {
            hw.gpu_name = metal.gpu_name;
        }
    }

    // Vulkan probe goes here once `ash` lands as a feature.
    // hw.vulkan_available stays false in Phase 3.2.

    hw
}

#[derive(Debug, Default)]
struct CudaInfo {
    gpu_name: Option<String>,
    compute_cap: Option<f32>,
    vram_mb: Option<u32>,
}

#[cfg(feature = "cuda")]
fn probe_cuda() -> Option<CudaInfo> {
    use cudarc::driver::{CudaContext, sys};

    // CudaContext::new dynamically loads `cuda*.dll` / `libcuda.so`
    // and initialises device ordinal 0. Returns Err if no NVIDIA
    // driver is installed, the runtime libs aren't on PATH, or no
    // CUDA-capable GPU is present. All of those mean "no CUDA" —
    // map to `None` so the higher-level probe records
    // `cuda_available: false` and moves on.
    let ctx = CudaContext::new(0).ok()?;

    // Anything below this point is "extra detail" — if a getter
    // fails, we fall back to `None` for that field but keep
    // `cuda_available: true` because we proved the device exists.
    let mut info = CudaInfo::default();

    let cu_device = ctx.cu_device();

    // Compute capability — major + minor as separate device
    // attributes. Convert to single float (e.g. 8.9 for Ada).
    let cap_major = unsafe {
        cudarc::driver::result::device::get_attribute(
            cu_device,
            sys::CUdevice_attribute::CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR,
        )
    }
    .ok();
    let cap_minor = unsafe {
        cudarc::driver::result::device::get_attribute(
            cu_device,
            sys::CUdevice_attribute::CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR,
        )
    }
    .ok();
    if let (Some(maj), Some(min)) = (cap_major, cap_minor) {
        // Encode as e.g. 7.5 for Turing, 8.6 for Ampere, 8.9 for
        // Ada, 12.0 for Blackwell. Matches the CUDA_COMPUTE_CAP
        // env var format used by the build.yml workflow.
        info.compute_cap = Some(maj as f32 + (min as f32) / 10.0);
    }

    // Total VRAM. `total_mem` returns bytes; we want MB (round
    // down since we display as an integer in the UI).
    if let Ok(bytes) = unsafe { cudarc::driver::result::device::total_mem(cu_device) } {
        info.vram_mb = Some((bytes / (1024 * 1024)) as u32);
    }

    // GPU name. cudarc 0.19 takes the device handle as the sole
    // argument and the wrapper hides the buffer-sizing FFI.
    if let Ok(name) = cudarc::driver::result::device::get_name(cu_device) {
        info.gpu_name = Some(name);
    }

    Some(info)
}

#[cfg(not(feature = "cuda"))]
fn probe_cuda() -> Option<CudaInfo> {
    None
}

#[derive(Debug, Default)]
struct MetalInfo {
    gpu_name: Option<String>,
}

#[cfg(all(feature = "metal", target_os = "macos"))]
fn probe_metal() -> Option<MetalInfo> {
    use objc2_foundation::NSString;
    use objc2_metal::MTLCreateSystemDefaultDevice;

    // SAFETY: MTLCreateSystemDefaultDevice is safe to call on the
    // main thread. Returns nullable; `None` means "no Metal-capable
    // GPU" which on modern Apple Silicon is essentially impossible
    // but we honor the API contract.
    let device = unsafe { MTLCreateSystemDefaultDevice() }?;
    let name: &NSString = unsafe { msg_send![&*device, name] };
    Some(MetalInfo {
        gpu_name: Some(name.to_string()),
    })
}

#[cfg(not(all(feature = "metal", target_os = "macos")))]
fn probe_metal() -> Option<MetalInfo> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Probe never panics + always returns a `DetectedHardware`.
    /// When neither `cuda` nor `metal` features are enabled (default
    /// in test builds), the result equals the stub snapshot.
    #[test]
    fn probe_never_panics() {
        let hw = probe();
        // At minimum, the result is well-formed (no required fields
        // missing). The actual content depends on the host + which
        // features are compiled in.
        let _ = hw;
    }

    /// Default-feature build: no CUDA, no Metal compiled in. Probe
    /// returns essentially the stub. Documenting this so a future
    /// reader who notices "the probe returns stub on CI" knows it's
    /// because the CI runner doesn't enable any GPU feature.
    #[cfg(not(any(feature = "cuda", feature = "metal")))]
    #[test]
    fn no_gpu_features_yields_stub_shape() {
        let hw = probe();
        assert!(!hw.cuda_available);
        assert!(!hw.metal_available);
        assert!(!hw.vulkan_available);
    }
}
