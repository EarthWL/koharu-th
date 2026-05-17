mod hf_hub;

pub mod anime_text;
pub mod comic_text_detector;
pub mod facade;
pub mod font_detector;
pub mod lama;
pub mod llm;
pub mod loading;
pub mod manga_ocr;
pub mod mit48px_ocr;

use anyhow::Result;
use candle_core::utils::metal_is_available;

pub use candle_core::Device;
pub use koharu_http::hf_hub::set_cache_dir;
pub use llm::{language_from_tag, supported_locales};

/// Pick the best available accelerator, gracefully falling back to CPU
/// when GPU initialization fails. Common reasons device creation can
/// fail even when the library loaded:
///   - GPU driver too old for the installed CUDA runtime
///   - Compute capability mismatch (kernels not compiled for this SM)
///   - GPU is in TCC mode / used by another process / WSL2 quirks
///
/// We log + downgrade to CPU instead of crashing the app. Caller can
/// inspect the returned `Device` to decide whether to also keep models
/// CPU-only (see `device_or_cpu_fallback` for the build_resources path).
pub fn device(cpu: bool) -> Result<Device> {
    if cpu {
        return Ok(Device::Cpu);
    }
    if cuda_is_available() {
        match Device::new_cuda(0) {
            Ok(dev) => return Ok(dev),
            Err(err) => {
                tracing::warn!(
                    "CUDA library is available but `Device::new_cuda(0)` failed: {err}. \
                     Falling back to CPU."
                );
            }
        }
    }
    if metal_is_available() {
        match Device::new_metal(0) {
            Ok(dev) => return Ok(dev),
            Err(err) => {
                tracing::warn!(
                    "Metal is available but `Device::new_metal(0)` failed: {err}. \
                     Falling back to CPU."
                );
            }
        }
    }
    tracing::info!("No accelerator available. Using CPU device.");
    Ok(Device::Cpu)
}

pub fn cuda_is_available() -> bool {
    (unsafe {
        libloading::Library::new(if cfg!(target_os = "windows") {
            "nvcuda.dll"
        } else {
            "libcuda.so"
        })
        .is_ok()
    }) && cfg!(feature = "cuda")
}
