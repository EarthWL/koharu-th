mod hf_hub;

pub mod anime_text;
pub mod backend;
pub mod comic_text_detector;
pub mod facade;
pub mod font_detector;
pub mod lama;
pub mod llm;
pub mod loading;
pub mod manga_ocr;
pub mod mit48px_ocr;
pub mod offloader;

use anyhow::Result;
pub use backend::{HardwareBackend, detect_best_backend, dml_is_available};
use candle_core::utils::metal_is_available;

pub use candle_core::Device;
pub use koharu_http::hf_hub::set_cache_dir;
pub use llm::{language_from_tag, supported_locales};

use std::sync::RwLock;

static CUSTOM_DEVICE_SELECTION: RwLock<Option<String>> = RwLock::new(None);

pub fn set_custom_device_selection(selection: Option<String>) {
    match CUSTOM_DEVICE_SELECTION.write() {
        Ok(mut guard) => *guard = selection,
        Err(err) => tracing::error!(
            "Device selection lock poisoned; selection not applied: {err}. \
             GPU/CPU preference from Settings will be ignored this session."
        ),
    }
}

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

    let selection = if let Ok(guard) = CUSTOM_DEVICE_SELECTION.read() {
        guard.clone()
    } else {
        None
    };

    if let Some(ref sel) = selection {
        match sel.as_str() {
            "CPU" => return Ok(Device::Cpu),
            "CUDA:0" => match Device::new_cuda(0) {
                Ok(dev) => return Ok(dev),
                Err(err) => {
                    tracing::warn!("CUDA:0 requested but failed: {err}. Falling back to CPU.");
                    return Ok(Device::Cpu);
                }
            },
            "CUDA:1" => match Device::new_cuda(1) {
                Ok(dev) => return Ok(dev),
                Err(err) => {
                    tracing::warn!("CUDA:1 requested but failed: {err}. Falling back to CPU.");
                    return Ok(Device::Cpu);
                }
            },
            "CUDA:2" => match Device::new_cuda(2) {
                Ok(dev) => return Ok(dev),
                Err(err) => {
                    tracing::warn!("CUDA:2 requested but failed: {err}. Falling back to CPU.");
                    return Ok(Device::Cpu);
                }
            },
            sel => {
                // Support CUDA:N for any index beyond the named cases above.
                if let Some(idx_str) = sel.strip_prefix("CUDA:") {
                    match idx_str.parse::<usize>() {
                        Ok(idx) => match Device::new_cuda(idx) {
                            Ok(dev) => return Ok(dev),
                            Err(err) => {
                                tracing::warn!(
                                    "CUDA:{idx} requested but failed: {err}. Falling back to CPU."
                                );
                                return Ok(Device::Cpu);
                            }
                        },
                        Err(_) => {
                            tracing::warn!(
                                "Unknown device selection {sel:?}. Falling back to auto-detection."
                            );
                        }
                    }
                } else {
                    tracing::warn!(
                        "Unknown device selection {sel:?}. Falling back to auto-detection."
                    );
                }
            }
        }
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
    let driver_ok = unsafe {
        libloading::Library::new(if cfg!(target_os = "windows") {
            "nvcuda.dll"
        } else {
            "libcuda.so"
        })
        .is_ok()
    };

    if !driver_ok || !cfg!(feature = "cuda") {
        return false;
    }

    // Defensively check if cublas can be dynamically loaded as well.
    // If nvcuda is present (GPU driver installed) but cublas is missing
    // (CUDA Toolkit not installed), candle/cudarc will panic at runtime
    // during device creation instead of returning an error.
    let cublas_libs = if cfg!(target_os = "windows") {
        vec![
            "cublas.dll",
            "cublas64.dll",
            "cublas64_13.dll", // CUDA 13.x (Blackwell-era toolkits)
            "cublas64_12.dll",
            "cublas64_11.dll",
            "cublas64_10.dll",
            "cublas64_9.dll",
        ]
    } else {
        vec![
            "libcublas.so",
            "libcublas.so.13",
            "libcublas.so.12",
            "libcublas.so.11",
            "libcublas.so.10",
        ]
    };

    let cublas_ok = unsafe {
        cublas_libs
            .iter()
            .any(|&lib_name| libloading::Library::new(lib_name).is_ok())
    };

    if !cublas_ok {
        return false;
    }

    // candle's CUDA convolution path goes through cuDNN even when the
    // `cudnn` cargo feature is off — cudarc 0.19+ statically links the
    // cudnn module whenever the cuda backend is built. So if cuDNN
    // isn't installed the first conv2d call panics with
    //   `unwrap()` on Err(CudnnError(CUDNN_STATUS_INTERNAL_ERROR))
    // at cudarc-0.19.7/src/cudnn/safe/core.rs:43.
    // Detect the entry-point DLL up front and refuse CUDA when it's
    // missing — the caller falls back to CPU gracefully instead of
    // crashing later.
    let cudnn_libs = if cfg!(target_os = "windows") {
        vec![
            "cudnn64_9.dll",
            "cudnn64_8.dll",
            "cudnn_graph64_9.dll", // cuDNN 9 split: graph component is required
        ]
    } else {
        vec!["libcudnn.so", "libcudnn.so.9", "libcudnn.so.8"]
    };
    let cudnn_ok = unsafe {
        cudnn_libs
            .iter()
            .any(|&lib_name| libloading::Library::new(lib_name).is_ok())
    };
    if !cudnn_ok {
        tracing::warn!(
            "CUDA + cuBLAS detected but cuDNN is missing — falling back to CPU. \
             Install cuDNN 9.x from https://developer.nvidia.com/cudnn-downloads to enable GPU acceleration."
        );
        return false;
    }

    true
}
