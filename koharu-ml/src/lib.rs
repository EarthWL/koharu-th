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

    // cuBLAS/cuDNN are NOT probed in-process. Loading a broken/mismatched
    // cuDNN DLL can HANG inside the Windows loader lock, which deadlocks the
    // WHOLE process — an in-process thread + timeout can't rescue it (the
    // timeout returns but the loader lock stays poisoned, so the main thread
    // can't make progress either). Instead the app runs a real conv probe in
    // a SEPARATE child process (`--cuda-smoke-test`) and publishes the result
    // here via `set_cuda_probe_ok`. Until that runs we conservatively stay on
    // CPU. (1 = GPU verified usable.)
    matches!(CUDA_PROBE.load(std::sync::atomic::Ordering::Relaxed), 1)
}

/// Out-of-process CUDA probe result: 0 = not run yet, 1 = GPU works,
/// 2 = GPU unusable. Set by the app after running the `--cuda-smoke-test`
/// child process.
static CUDA_PROBE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Publish the out-of-process CUDA probe result (see `run_cuda_conv_probe`).
pub fn set_cuda_probe_ok(ok: bool) {
    CUDA_PROBE.store(
        if ok { 1 } else { 2 },
        std::sync::atomic::Ordering::Relaxed,
    );
}

/// The actual GPU exercise — meant to run in a DEDICATED CHILD PROCESS
/// (`koharu --cuda-smoke-test`): a `Device::new_cuda` + `conv2d` (the op that
/// loads cuBLAS + cuDNN and drives the cuDNN path). Returns whether it
/// succeeded. Wrapped in `catch_unwind` so a cudarc panic becomes `false`
/// instead of aborting the child; a HANG is handled by the parent killing the
/// child after a timeout. Do NOT call this in the main process — a hung cuDNN
/// load would freeze it.
pub fn run_cuda_conv_probe() -> bool {
    // Report each step on STDERR (not tracing) so the parent can capture
    // exactly where the GPU stack breaks — driver/cuBLAS at `new_cuda`,
    // the conv kernel at `conv2d`, or device→host readback. This runs in
    // the throwaway `--cuda-smoke-test` child BEFORE any tracing
    // subscriber is installed, so `tracing::*` would go nowhere; `eprintln!`
    // always reaches stderr, which `run_cuda_smoke_subprocess` pipes back
    // and logs. Prefix lets the parent grep the relevant lines.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
        eprintln!("[cuda-probe] creating CUDA device 0…");
        let dev = candle_core::Device::new_cuda(0)
            .map_err(|e| anyhow::anyhow!("new_cuda(0) failed (driver/cuBLAS load): {e}"))?;
        eprintln!("[cuda-probe] device OK; allocating tensors…");
        let input = candle_core::Tensor::zeros((1usize, 1, 8, 8), candle_core::DType::F32, &dev)
            .map_err(|e| anyhow::anyhow!("input tensor alloc failed: {e}"))?;
        let kernel = candle_core::Tensor::zeros((1usize, 1, 3, 3), candle_core::DType::F32, &dev)
            .map_err(|e| anyhow::anyhow!("kernel tensor alloc failed: {e}"))?;
        eprintln!("[cuda-probe] running conv2d…");
        let out = input
            .conv2d(&kernel, 0, 1, 1, 1)
            .map_err(|e| anyhow::anyhow!("conv2d failed: {e}"))?;
        eprintln!("[cuda-probe] reading result back to host…");
        out.flatten_all()
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| anyhow::anyhow!("GPU readback failed: {e}"))?;
        eprintln!("[cuda-probe] conv2d + readback OK — GPU usable");
        Ok(())
    }));

    match result {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            eprintln!("[cuda-probe] FAILED: {e:#}");
            false
        }
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic payload".to_string());
            eprintln!("[cuda-probe] PANICKED: {msg}");
            false
        }
    }
}
