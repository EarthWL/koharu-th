//! Runtime dependency installer — Phase 1: cuDNN.
//!
//! candle's CUDA convolution path links cudarc' cuDNN module unconditionally
//! (cudarc 0.19 statically compiles the cuDNN module in even when the
//! `cudnn` cargo feature is off). If the user has an NVIDIA GPU + CUDA
//! Toolkit but no cuDNN, the first conv2d invocation panics at
//! `cudarc-0.19.7/src/cudnn/safe/core.rs:43:55` with
//! `CudnnError(CUDNN_STATUS_INTERNAL_ERROR)`.
//!
//! Rather than force every end-user to manually download a 700 MB cuDNN
//! installer from developer.nvidia.com, this module fetches a pinned
//! cuDNN ZIP from NVIDIA's redist CDN, extracts just the runtime DLLs,
//! drops them into `APP_ROOT/runtime/cudnn/bin/`, and registers that
//! directory with the Windows DLL loader so `libloading::Library::new`
//! picks them up at startup.
//!
//! ## Stability gate
//!
//! The version pinned here is the *baseline* — tested against the build
//! and known-good. Phase 2-4 will add a manifest fetcher that probes
//! NVIDIA for a newer stable release, gates the upgrade on age (≥30
//! days since release) + ABI match, and performs an atomic swap with
//! rollback on boot-test failure. Until that lands, the baseline is the
//! only version we install.
//!
//! ## License
//!
//! NVIDIA cuDNN SLA permits redistribution as part of a derivative work.
//! We don't bundle the DLLs in the installer — we download them on
//! first launch from NVIDIA's own CDN — so users always pull directly
//! from the vendor.

use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Pinned baseline cuDNN release. Use the `_cuda12-archive` build —
/// cuDNN's CUDA-12 binaries are ABI-compatible with CUDA-13 toolkits per
/// NVIDIA's release notes, and the CUDA-12 archives have a longer track
/// record on the redist server.
const CUDNN_VERSION: &str = "9.8.0.87";
const CUDNN_URL: &str = "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-9.8.0.87_cuda12-archive.zip";

/// Status reported back to the UI during install.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CudnnStatus {
    /// Already installed at the expected runtime path.
    Installed { version: String, path: String },
    /// Not installed locally — UI should offer to download.
    Missing { version: String },
    /// In-progress fetch (bytes streamed). UI uses for progress bar.
    Downloading {
        version: String,
        bytes_done: u64,
        bytes_total: Option<u64>,
    },
    /// Extraction phase (after download completes).
    Extracting { version: String },
    /// Install finished successfully.
    Ready { version: String, path: String },
    /// Install failed; surface the error to the UI.
    Failed { version: String, error: String },
}

/// Returns the directory where cuDNN DLLs live for *this* baseline.
/// Version-tagged so an upgrade can drop into a sibling folder and the
/// old one is kept for rollback (Phase 4).
fn cudnn_install_dir(runtime_root: &Path) -> PathBuf {
    runtime_root
        .join("cudnn")
        .join(format!("v{}", CUDNN_VERSION))
        .join("bin")
}

/// Sentinel DLL that signals a complete install. cuDNN 9.x ships its
/// public loader as `cudnn64_9.dll`; presence of this file means the
/// rest of the bundle is there too (we extract them atomically).
const CUDNN_LOADER_DLL: &str = "cudnn64_9.dll";

/// Detect whether the pinned cuDNN baseline is already extracted.
pub fn is_cudnn_installed(runtime_root: &Path) -> bool {
    cudnn_install_dir(runtime_root)
        .join(CUDNN_LOADER_DLL)
        .exists()
}

/// Snapshot of the current cuDNN install state for the UI.
pub fn cudnn_status(runtime_root: &Path) -> CudnnStatus {
    if is_cudnn_installed(runtime_root) {
        CudnnStatus::Installed {
            version: CUDNN_VERSION.into(),
            path: cudnn_install_dir(runtime_root).display().to_string(),
        }
    } else {
        CudnnStatus::Missing {
            version: CUDNN_VERSION.into(),
        }
    }
}

/// Download + extract cuDNN to the runtime directory.
///
/// `progress` is invoked synchronously on the downloading thread for
/// each chunk; the Tauri command wrapper translates those into JS events.
///
/// The download lands in a temp file, then we extract atomically into a
/// staging dir, then rename into place — so a partial install can never
/// leave a half-populated `bin/` folder that would make
/// `is_cudnn_installed` return true falsely.
pub async fn install_cudnn(
    runtime_root: &Path,
    mut progress: impl FnMut(CudnnStatus) + Send + 'static,
) -> Result<PathBuf> {
    use tokio::io::AsyncWriteExt;

    let final_dir = cudnn_install_dir(runtime_root);
    if final_dir.join(CUDNN_LOADER_DLL).exists() {
        return Ok(final_dir);
    }

    let staging_root = runtime_root.join("cudnn").join(format!(".v{}.tmp", CUDNN_VERSION));
    let _ = std::fs::remove_dir_all(&staging_root);
    std::fs::create_dir_all(&staging_root).context("create cudnn staging dir")?;

    // 1. Stream the ZIP to a temp file (706 MB — can't hold in memory).
    let zip_path = staging_root.join("cudnn.zip");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()?;
    let mut resp = client
        .get(CUDNN_URL)
        .send()
        .await
        .context("GET cudnn redist")?;
    if !resp.status().is_success() {
        anyhow::bail!("cudnn redist returned HTTP {}", resp.status());
    }
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(&zip_path).await?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await? {
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        progress(CudnnStatus::Downloading {
            version: CUDNN_VERSION.into(),
            bytes_done: downloaded,
            bytes_total: total,
        });
    }
    file.flush().await?;
    drop(file);

    // 2. Extract only `bin/*.dll` entries. The redist archive also
    //    contains include headers + lib files we don't need at runtime —
    //    skipping them halves the on-disk footprint (~350 MB instead of
    //    ~700 MB).
    progress(CudnnStatus::Extracting {
        version: CUDNN_VERSION.into(),
    });
    let staging_bin = staging_root.join("bin");
    std::fs::create_dir_all(&staging_bin)?;
    let zip_bytes = std::fs::read(&zip_path).context("read staged zip")?;
    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).context("open cudnn zip")?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        // Match `<root>/bin/*.dll` — ZIP root has the archive name as
        // top-level folder.
        if !name.contains("/bin/") || !name.ends_with(".dll") {
            continue;
        }
        let basename = Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .context("cudnn zip entry without filename")?;
        let out_path = staging_bin.join(basename);
        let mut out_file = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out_file)?;
    }
    // Free the in-memory zip before we delete the file.
    drop(archive);
    let _ = std::fs::remove_file(&zip_path);

    if !staging_bin.join(CUDNN_LOADER_DLL).exists() {
        anyhow::bail!(
            "cudnn extraction completed but {} is missing — archive layout changed?",
            CUDNN_LOADER_DLL
        );
    }

    // 3. Atomic rename staging → final. If the parent of `final_dir`
    //    doesn't exist yet, create it.
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if final_dir.exists() {
        let _ = std::fs::remove_dir_all(&final_dir);
    }
    std::fs::rename(&staging_bin, &final_dir).context("commit cudnn install")?;
    let _ = std::fs::remove_dir_all(&staging_root);

    progress(CudnnStatus::Ready {
        version: CUDNN_VERSION.into(),
        path: final_dir.display().to_string(),
    });
    Ok(final_dir)
}

/// Add the cuDNN install directory to the Windows DLL search path so
/// `libloading::Library::new("cudnn64_9.dll")` finds our extracted
/// copy before walking system32 / PATH. Called once at startup, after
/// `is_cudnn_installed` confirms a complete install.
///
/// Uses `AddDllDirectory` on Windows 8+ which is the modern, scoped
/// alternative to the legacy `SetDllDirectory` (the latter has process-
/// wide effects that can disrupt other libraries).
#[cfg(target_os = "windows")]
pub fn register_cudnn_dll_path(runtime_root: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    if !is_cudnn_installed(runtime_root) {
        return Ok(());
    }
    let dir = cudnn_install_dir(runtime_root);
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: pointer is valid for the duration of this call. The Win32
    // API copies the string internally and returns a cookie we discard
    // — we don't need to remove the entry later because the process is
    // single-purpose.
    unsafe {
        unsafe extern "system" {
            fn AddDllDirectory(NewDirectory: *const u16) -> *mut std::ffi::c_void;
            fn SetDefaultDllDirectories(DirectoryFlags: u32) -> i32;
        }
        // Enable user dirs in the default search order (the AddDllDirectory
        // cookie is only honoured when `LOAD_LIBRARY_SEARCH_USER_DIRS` is
        // part of the default flags).
        const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x00001000;
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);

        let cookie = AddDllDirectory(wide.as_ptr());
        if cookie.is_null() {
            anyhow::bail!("AddDllDirectory failed for {}", dir.display());
        }
    }
    tracing::info!(
        "Registered cuDNN DLL path: {} (version {})",
        dir.display(),
        CUDNN_VERSION
    );
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn register_cudnn_dll_path(_runtime_root: &Path) -> Result<()> {
    // Non-Windows builds use libcudnn.so on the system loader path or
    // LD_LIBRARY_PATH — out of scope for Phase 1.
    Ok(())
}
