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
        // `Device::new_cuda` PANICS (via cudarc's dlopen of cuBLAS/cuDNN)
        // on a machine without a working CUDA toolkit — the `Err` arms
        // below cannot recover from a panic. Refuse any CUDA selection up
        // front unless the runtime probe confirms CUDA is usable, falling
        // back to CPU. DirectML/ONNX acceleration is selected separately,
        // before this function is ever called.
        if sel.starts_with("CUDA") && !cuda_is_available() {
            tracing::warn!(
                "{sel} requested but CUDA runtime is unavailable (driver/cuBLAS/cuDNN missing); using CPU."
            );
            return Ok(Device::Cpu);
        }
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

    // DLLs load — but loadable != usable. Verify CUDA + cuBLAS + cuDNN
    // actually EXECUTE before committing to the GPU. cudarc 0.19 `unwrap()`s
    // internally and panics on a broken/mismatched toolkit (e.g.
    // CUDNN_STATUS_INTERNAL_ERROR from a cuDNN/CUDA version mismatch), which
    // callers cannot catch. The cached smoke test runs a real conv2d under a
    // silenced `catch_unwind` so any such failure degrades to CPU instead of
    // crashing the whole app.
    if !cuda_smoke_test_passes() {
        return false;
    }

    true
}

static CUDA_SMOKE_OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Run a one-shot GPU smoke test: a tiny `conv2d` (the op routed through
/// cuBLAS + cuDNN). A broken/mismatched toolkit can either PANIC inside
/// cudarc OR HANG the first GPU op (e.g. cuDNN 9.8 against CUDA 13.2), and
/// `catch_unwind` cannot rescue a hang. So we run the probe on a dedicated
/// named thread (the app panic hook suppresses fatal handling for it, its own
/// `catch_unwind` keeps a panic local) and bound the wait with a timeout —
/// any panic, error, or hang falls back to CPU. Cached: one real run.
fn cuda_smoke_test_passes() -> bool {
    *CUDA_SMOKE_OK.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("koharu-cuda-smoke".to_string())
            .spawn(move || {
                let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let dev = candle_core::Device::new_cuda(0).ok()?;
                    let input = candle_core::Tensor::zeros(
                        (1usize, 1, 8, 8),
                        candle_core::DType::F32,
                        &dev,
                    )
                    .ok()?;
                    let kernel = candle_core::Tensor::zeros(
                        (1usize, 1, 3, 3),
                        candle_core::DType::F32,
                        &dev,
                    )
                    .ok()?;
                    // conv2d exercises the cuDNN path; flatten_all + to_vec1
                    // forces the lazy GPU op to execute + copy to host so a
                    // cuBLAS/cuDNN failure surfaces here.
                    let out = input.conv2d(&kernel, 0, 1, 1, 1).ok()?;
                    out.flatten_all().ok()?.to_vec1::<f32>().ok()?;
                    Some(())
                }))
                .ok()
                .flatten()
                .is_some();
                let _ = tx.send(ok);
            });

        if spawned.is_err() {
            tracing::warn!("Could not spawn CUDA smoke-test thread — using CPU.");
            return false;
        }

        match rx.recv_timeout(std::time::Duration::from_secs(8)) {
            Ok(true) => true,
            Ok(false) => {
                tracing::warn!("CUDA smoke test failed (cuBLAS/cuDNN runtime error) — using CPU.");
                false
            }
            Err(_) => {
                tracing::warn!(
                    "CUDA smoke test timed out (hung/incompatible cuDNN/CUDA) — using CPU."
                );
                false
            }
        }
    })
}
