use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Precision {
    FP32,
    FP16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryStrategy {
    FullGpu(Precision),
    PartialOffload {
        gpu_layers: usize,
        cpu_layers: usize,
        precision: Precision,
    },
    FullCpu,
}

// --- Windows-specific Memory API FFI ---
#[cfg(windows)]
#[repr(C)]
#[derive(Debug, Copy, Clone)]
struct MEMORYSTATUSEX {
    dwLength: u32,
    dwMemoryLoad: u32,
    ullTotalPhys: u64,
    ullAvailPhys: u64,
    ullTotalPageFile: u64,
    ullAvailPageFile: u64,
    ullTotalVirtual: u64,
    ullAvailVirtual: u64,
    ullAvailExtendedVirtual: u64,
}

#[cfg(windows)]
extern "system" {
    fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> i32;
}

/// Dynamic system RAM query via safe FFI
pub fn get_system_ram_bytes() -> Option<u64> {
    #[cfg(windows)]
    {
        unsafe {
            let mut mem_info = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                dwMemoryLoad: 0,
                ullTotalPhys: 0,
                ullAvailPhys: 0,
                ullTotalPageFile: 0,
                ullAvailPageFile: 0,
                ullTotalVirtual: 0,
                ullAvailVirtual: 0,
                ullAvailExtendedVirtual: 0,
            };
            if GlobalMemoryStatusEx(&mut mem_info) != 0 {
                return Some(mem_info.ullAvailPhys);
            }
        }
    }

    #[cfg(not(windows))]
    {
        // Platform fallback: Unix-like /proc/meminfo parser
        if let Ok(mut file) = std::fs::File::open("/proc/meminfo") {
            let mut content = String::new();
            if file.read_to_string(&mut content).is_ok() {
                for line in content.lines() {
                    if line.starts_with("MemAvailable:") {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if parts.len() >= 2 {
                            if let Ok(kb) = parts[1].parse::<u64>() {
                                return Some(kb * 1024);
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Dynamic NVIDIA VRAM query using dynamic library loading
pub fn get_cuda_vram_bytes() -> Option<(u64, u64)> {
    #[cfg(windows)]
    const CUDA_LIB_NAME: &str = "nvcuda.dll";
    #[cfg(not(windows))]
    const CUDA_LIB_NAME: &str = "libcuda.so";

    unsafe {
        let lib = libloading::Library::new(CUDA_LIB_NAME).ok()?;
        
        // Load CUDA driver methods dynamically
        let cu_init: libloading::Symbol<unsafe extern "C" fn(u32) -> i32> = lib.get(b"cuInit").ok()?;
        let cu_device_get: libloading::Symbol<unsafe extern "C" fn(*mut i32, i32) -> i32> = lib.get(b"cuDeviceGet").ok()?;
        let cu_ctx_create: libloading::Symbol<unsafe extern "C" fn(*mut *mut std::ffi::c_void, u32, i32) -> i32> = lib.get(b"cuCtxCreate_v2").ok()?;
        let cu_mem_get_info: libloading::Symbol<unsafe extern "C" fn(*mut usize, *mut usize) -> i32> = lib.get(b"cuMemGetInfo_v2").ok()?;
        let cu_ctx_destroy: libloading::Symbol<unsafe extern "C" fn(*mut std::ffi::c_void) -> i32> = lib.get(b"cuCtxDestroy_v2").ok()?;

        if cu_init(0) != 0 {
            return None;
        }
        
        let mut dev: i32 = 0;
        if cu_device_get(&mut dev, 0) != 0 {
            return None;
        }
        
        let mut ctx: *mut std::ffi::c_void = std::ptr::null_mut();
        if cu_ctx_create(&mut ctx, 0, dev) != 0 {
            return None;
        }
        
        let mut free: usize = 0;
        let mut total: usize = 0;
        let mem_res = cu_mem_get_info(&mut free, &mut total);
        
        let _ = cu_ctx_destroy(ctx);
        
        if mem_res == 0 {
            Some((free as u64, total as u64))
        } else {
            None
        }
    }
}

/// Generates layer offloading and precision strategy dynamically based on hardware limits
pub fn get_offload_strategy(model_size_bytes: u64, total_layers: usize) -> MemoryStrategy {
    let avail_ram = get_system_ram_bytes().unwrap_or(8 * 1024 * 1024 * 1024); // default 8GB fallback
    let (avail_vram, _) = get_cuda_vram_bytes().unwrap_or((0, 0));

    tracing::info!(
        "[ML-Offloader] Memory Analysis -> RAM Avail: {}MB, GPU VRAM Avail: {}MB, Model Raw Size: {}MB",
        avail_ram / 1024 / 1024,
        avail_vram / 1024 / 1024,
        model_size_bytes / 1024 / 1024
    );

    // Scenario 1: GPU has enough VRAM to load full FP32 (model size + 1.5GB margin)
    let gpu_fp32_req = model_size_bytes + 1500 * 1024 * 1024;
    if avail_vram >= gpu_fp32_req {
        tracing::info!("[ML-Offloader] Selected: Full GPU Execution (FP32)");
        return MemoryStrategy::FullGpu(Precision::FP32);
    }

    // Scenario 2: GPU has enough VRAM to load full FP16 (assumed 55% model size + 1GB margin)
    let fp16_size = (model_size_bytes as f64 * 0.55) as u64;
    let gpu_fp16_req = fp16_size + 1000 * 1024 * 1024;
    if avail_vram >= gpu_fp16_req {
        tracing::info!("[ML-Offloader] Selected: Full GPU Execution (FP16 Quantized)");
        return MemoryStrategy::FullGpu(Precision::FP16);
    }

    // Scenario 3: GPU has limited VRAM, calculate partial offload layer partitioning
    if avail_vram > 512 * 1024 * 1024 {
        let usable_vram = avail_vram.saturating_sub(512 * 1024 * 1024); // Reserve 512MB for UI/System
        let layer_size = fp16_size / total_layers.max(1) as u64;
        if layer_size > 0 {
            let gpu_layers = (usable_vram / layer_size) as usize;
            if gpu_layers > 0 && gpu_layers < total_layers {
                tracing::info!(
                    "[ML-Offloader] Selected: Partial Offload (GPU layers: {}, CPU layers: {}, Precision: FP16)",
                    gpu_layers,
                    total_layers - gpu_layers
                );
                return MemoryStrategy::PartialOffload {
                    gpu_layers,
                    cpu_layers: total_layers - gpu_layers,
                    precision: Precision::FP16,
                };
            } else if gpu_layers >= total_layers {
                tracing::info!("[ML-Offloader] Selected: Full GPU Execution (FP16 Quantized)");
                return MemoryStrategy::FullGpu(Precision::FP16);
            }
        }
    }

    // Scenario 4: Hardware VRAM exhausted, run model entirely on CPU
    tracing::warn!("[ML-Offloader] Selected: Full CPU Execution (Safety fallback mode active)");
    if avail_ram < model_size_bytes {
        tracing::warn!("[ML-Offloader] DANGER: Physical RAM is lower than model size. Extreme low memory condition!");
    }
    MemoryStrategy::FullCpu
}
