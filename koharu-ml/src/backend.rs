use anyhow::Result;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardwareBackend {
    Cpu,
    Cuda(usize),
    Metal(usize),
    DirectMl(usize),
}

impl HardwareBackend {
    /// Check if this backend represents an accelerator device (GPU/NPU)
    pub fn is_accelerator(&self) -> bool {
        !matches!(self, HardwareBackend::Cpu)
    }

    /// Convert to descriptive label
    pub fn as_str(&self) -> &'static str {
        match self {
            HardwareBackend::Cpu => "CPU",
            HardwareBackend::Cuda(_) => "NVIDIA CUDA",
            HardwareBackend::Metal(_) => "Apple Metal",
            HardwareBackend::DirectMl(_) => "Microsoft DirectML",
        }
    }
}

/// Detect if DirectML is supported on the current platform and build configuration.
/// DirectML is the primary API for accelerating machine learning workloads on
/// Windows systems across all GPU/NPU vendors (AMD, Intel, NVIDIA, Qualcomm).
pub fn dml_is_available() -> bool {
    if !cfg!(feature = "dml") {
        return false;
    }

    if !cfg!(target_os = "windows") {
        return false;
    }

    // Defensively check if we can load ONNX Runtime and detect DirectML support.
    // Under Windows, we check if the directml.dll is present or dynamically loadable.
    #[cfg(all(target_os = "windows", feature = "dml"))]
    {
        // Try checking directml.dll presence in system directory or app path.
        let dml_ok = unsafe { libloading::Library::new("directml.dll").is_ok() };
        dml_ok
    }
    #[cfg(not(all(target_os = "windows", feature = "dml")))]
    {
        false
    }
}

/// Pick the absolute best hardware backend automatically based on availability.
/// Order of priority:
/// 1. NVIDIA CUDA (via Candle CUDA)
/// 2. Apple Metal (via Candle Metal)
/// 3. Microsoft DirectML (via ONNX Runtime for AMD/Intel/NVIDIA/Qualcomm)
/// 4. CPU (Safe Fallback)
pub fn detect_best_backend() -> HardwareBackend {
    // 1. Check NVIDIA CUDA
    if crate::cuda_is_available() {
        info!("NVIDIA CUDA accelerator detected. Primary GPU set to CUDA:0.");
        return HardwareBackend::Cuda(0);
    }

    // 2. Check Apple Metal
    #[cfg(target_os = "macos")]
    {
        if candle_core::utils::metal_is_available() {
            info!("Apple Metal accelerator detected. Primary GPU set to Metal:0.");
            return HardwareBackend::Metal(0);
        }
    }

    // 3. Check Microsoft DirectML (AMD, Intel, Qualcomm, or NVIDIA without CUDA)
    if dml_is_available() {
        info!("Microsoft DirectML accelerator detected. Primary GPU set to DirectML:0.");
        return HardwareBackend::DirectMl(0);
    }

    info!("No hardware accelerator detected. Falling back to CPU.");
    HardwareBackend::Cpu
}
