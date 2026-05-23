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
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// cuDNN must match the installed CUDA Toolkit's MAJOR version. A CUDA-12
/// cuDNN build does NOT actually work against a CUDA-13 runtime — it hangs
/// or returns `CUDNN_STATUS_INTERNAL_ERROR` on the first conv (verified on
/// CUDA 13.2 + cuDNN 9.8 `_cuda12`), despite older release-note claims of
/// ABI compatibility. So we pin one baseline per CUDA major and select by
/// the detected toolkit version. CUDA-13 support starts at cuDNN 9.12.
struct CudnnPin {
    version: &'static str,
    cuda_tag: &'static str,
}

/// Detect the installed CUDA Toolkit major version from `CUDA_PATH`
/// (e.g. `...\CUDA\v13.2` -> 13). Defaults to 12 when it can't be parsed.
fn cuda_major() -> u32 {
    if let Ok(path) = std::env::var("CUDA_PATH") {
        if let Some(name) = Path::new(&path).file_name() {
            let name = name.to_string_lossy();
            let digits = name.trim_start_matches('v');
            if let Some(major) = digits.split('.').next().and_then(|s| s.parse::<u32>().ok()) {
                return major;
            }
        }
    }
    12
}

fn cudnn_pin() -> CudnnPin {
    if cuda_major() >= 13 {
        // First cuDNN with a CUDA-13 build; loads via cudarc 0.19's dynamic
        // `cudnn64_9` / `cudnn_graph64_9` lookup just like the 9.8 baseline.
        CudnnPin {
            version: "9.18.0.77",
            cuda_tag: "cuda13",
        }
    } else {
        CudnnPin {
            version: "9.8.0.87",
            cuda_tag: "cuda12",
        }
    }
}

fn cudnn_version() -> &'static str {
    cudnn_pin().version
}

fn cudnn_url() -> String {
    let p = cudnn_pin();
    format!(
        "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-{}_{}-archive.zip",
        p.version, p.cuda_tag
    )
}

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
        .join(format!("v{}", cudnn_version()))
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

/// Quick check for an NVIDIA GPU via `nvidia-smi`. Used to gate the
/// startup auto-install — no point downloading 700 MB of cuDNN on a
/// machine that has no NVIDIA card. Mirrors the `CREATE_NO_WINDOW`
/// trick used in `enumerate_cuda_devices` so no console flashes.
pub fn has_nvidia_gpu() -> bool {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name", "--format=csv,noheader"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(o) if o.status.success() => !o.stdout.is_empty(),
        _ => false,
    }
}

/// Snapshot of the current cuDNN install state for the UI.
pub fn cudnn_status(runtime_root: &Path) -> CudnnStatus {
    if is_cudnn_installed(runtime_root) {
        CudnnStatus::Installed {
            version: cudnn_version().into(),
            path: cudnn_install_dir(runtime_root).display().to_string(),
        }
    } else {
        CudnnStatus::Missing {
            version: cudnn_version().into(),
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

    let staging_root = runtime_root.join("cudnn").join(format!(".v{}.tmp", cudnn_version()));
    let _ = std::fs::remove_dir_all(&staging_root);
    std::fs::create_dir_all(&staging_root).context("create cudnn staging dir")?;

    // 1. Stream the ZIP to a temp file (706 MB — can't hold in memory).
    let zip_path = staging_root.join("cudnn.zip");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()?;
    let mut resp = client
        .get(cudnn_url())
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
            version: cudnn_version().into(),
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
        version: cudnn_version().into(),
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
        version: cudnn_version().into(),
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
        cudnn_version()
    );
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn register_cudnn_dll_path(_runtime_root: &Path) -> Result<()> {
    // Non-Windows builds use libcudnn.so on the system loader path or
    // LD_LIBRARY_PATH — out of scope for Phase 1.
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — Manifest probe
// ──────────────────────────────────────────────────────────────────────

const MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/HetCreep/koharu-th/feat/ux-improvements/runtime_manifest.json";
const MANIFEST_CACHE_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CudnnRelease {
    pub version: String,
    pub released_at: String,
    pub cuda_compat: Vec<String>,
    pub url: String,
    pub size_bytes: Option<u64>,
    pub baseline: bool,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CudnnManifest {
    pub windows_x86_64: Option<Vec<CudnnRelease>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub updated_at: String,
    pub cudnn: CudnnManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestCache {
    fetched_at_unix: u64,
    etag: Option<String>,
    payload: RuntimeManifest,
}

fn manifest_cache_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join("manifest_cache.json")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Fetch the runtime manifest from the HetCreep repo, honouring HTTP
/// ETag for revalidation. Caches the parsed manifest + ETag on disk so
/// repeated checks within the TTL window don't hammer GitHub raw.
pub async fn fetch_manifest(runtime_root: &Path) -> Result<RuntimeManifest> {
    let cache_path = manifest_cache_path(runtime_root);

    // Load any prior cache so we can revalidate with If-None-Match.
    let cache: Option<ManifestCache> = std::fs::read(&cache_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());

    if let Some(c) = &cache {
        if now_unix().saturating_sub(c.fetched_at_unix) < MANIFEST_CACHE_TTL_SECS {
            return Ok(c.payload.clone());
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut req = client.get(MANIFEST_URL);
    if let Some(c) = &cache {
        if let Some(etag) = &c.etag {
            req = req.header(reqwest::header::IF_NONE_MATCH, etag);
        }
    }
    let resp = req.send().await.context("GET runtime manifest")?;
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        // 304 — bump the cached fetched_at and reuse payload.
        if let Some(mut c) = cache {
            c.fetched_at_unix = now_unix();
            if let Some(parent) = cache_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&cache_path, serde_json::to_vec_pretty(&c)?);
            return Ok(c.payload);
        }
    }
    if !resp.status().is_success() {
        // Network success but bad status — fall back to cache if present.
        if let Some(c) = cache {
            return Ok(c.payload);
        }
        anyhow::bail!("manifest fetch returned HTTP {}", resp.status());
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let payload: RuntimeManifest = resp.json().await.context("parse manifest")?;
    let entry = ManifestCache {
        fetched_at_unix: now_unix(),
        etag,
        payload: payload.clone(),
    };
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&cache_path, serde_json::to_vec_pretty(&entry)?);
    Ok(payload)
}

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — Stability gate
// ──────────────────────────────────────────────────────────────────────

const STABILITY_AGE_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize)]
pub struct UpgradeCandidate {
    pub version: String,
    pub size_bytes: Option<u64>,
    pub released_at: String,
    pub notes: Option<String>,
}

/// Given a manifest + the currently-installed baseline, decide which
/// (if any) newer release passes the stability gate and should be
/// surfaced to the UI as "upgrade available".
pub fn pick_upgrade(
    manifest: &RuntimeManifest,
    installed_version: &str,
) -> Option<UpgradeCandidate> {
    let releases = manifest.cudnn.windows_x86_64.as_ref()?;
    let installed_major = major_minor(installed_version)?;
    let now = now_unix() as i64;

    let mut best: Option<&CudnnRelease> = None;
    for rel in releases {
        if rel.version == installed_version {
            continue;
        }
        let Some(rel_major) = major_minor(&rel.version) else {
            continue;
        };
        // Gate: same MAJOR version to keep ABI compatible.
        if rel_major.0 != installed_major.0 {
            continue;
        }
        // Gate: release age >= 30 days.
        let Some(released_unix) = parse_iso8601_to_unix(&rel.released_at) else {
            continue;
        };
        let age_days = (now - released_unix) / 86_400;
        if age_days < STABILITY_AGE_DAYS {
            continue;
        }
        // Gate: must be a strict version bump.
        if version_compare(&rel.version, installed_version) != std::cmp::Ordering::Greater {
            continue;
        }
        // Track highest eligible.
        match best {
            None => best = Some(rel),
            Some(b)
                if version_compare(&rel.version, &b.version) == std::cmp::Ordering::Greater =>
            {
                best = Some(rel)
            }
            _ => {}
        }
    }
    best.map(|r| UpgradeCandidate {
        version: r.version.clone(),
        size_bytes: r.size_bytes,
        released_at: r.released_at.clone(),
        notes: r.notes.clone(),
    })
}

fn major_minor(v: &str) -> Option<(u32, u32)> {
    let mut parts = v.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn version_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let av: Vec<u32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let bv: Vec<u32> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    av.cmp(&bv)
}

fn parse_iso8601_to_unix(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

// ──────────────────────────────────────────────────────────────────────
// Phase 4 — Boot health + stale GC
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimeHealth {
    pub active_cudnn_version: Option<String>,
    pub crash_count_24h: u32,
    pub crash_window_start_unix: u64,
    pub last_promoted_unix: u64,
}

fn health_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join("health.json")
}

pub fn read_health(runtime_root: &Path) -> RuntimeHealth {
    std::fs::read(health_path(runtime_root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn write_health(runtime_root: &Path, health: &RuntimeHealth) -> Result<()> {
    let path = health_path(runtime_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(health)?;
    std::fs::write(&path, bytes)?;
    Ok(())
}

/// Record a panic-time crash. Called from the panic hook so the next
/// startup can decide whether to roll back. The 24-hour window resets
/// every time the count hits 0 again.
pub fn record_crash(runtime_root: &Path) {
    let mut h = read_health(runtime_root);
    let now = now_unix();
    if now.saturating_sub(h.crash_window_start_unix) > 86_400 {
        h.crash_count_24h = 0;
        h.crash_window_start_unix = now;
    }
    h.crash_count_24h += 1;
    let _ = write_health(runtime_root, &h);
}

/// Mark a runtime version as stale (slated for cleanup). A sentinel
/// file inside the version directory holds the eligibility timestamp;
/// `gc_stale_runtimes` deletes the dir once the grace period elapses.
pub fn mark_stale(runtime_root: &Path, version: &str) -> Result<()> {
    let dir = runtime_root
        .join("cudnn")
        .join(format!("v{version}"));
    if !dir.exists() {
        return Ok(());
    }
    let stale_marker = dir.join(".stale");
    std::fs::write(&stale_marker, now_unix().to_string())?;
    Ok(())
}

const STALE_GC_GRACE_SECS: u64 = 7 * 24 * 60 * 60;

/// Background sweep — delete versioned runtime dirs that have been
/// marked stale for longer than the grace period. Called once at
/// startup (after the active baseline is confirmed working).
pub fn gc_stale_runtimes(runtime_root: &Path) -> Result<u32> {
    let cudnn_root = runtime_root.join("cudnn");
    if !cudnn_root.exists() {
        return Ok(0);
    }
    let mut removed = 0u32;
    for entry in std::fs::read_dir(&cudnn_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let marker = entry.path().join(".stale");
        let Ok(marker_bytes) = std::fs::read_to_string(&marker) else {
            continue;
        };
        let Ok(staled_at) = marker_bytes.trim().parse::<u64>() else {
            continue;
        };
        if now_unix().saturating_sub(staled_at) >= STALE_GC_GRACE_SECS {
            if std::fs::remove_dir_all(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Mark every versioned cuDNN dir that is NOT the active version as stale, so
/// `gc_stale_runtimes` reclaims it after the grace window. This is what
/// actually wires up cleanup — without it nothing ever calls `mark_stale`,
/// so an upgrade or a CUDA-major switch (e.g. `v9.8.0.87` cuda12 ->
/// `v9.18.0.77` cuda13) leaves the old ~0.7-1 GB dir on disk forever.
///
/// Safe by design: it refuses to mark anything until the ACTIVE version is
/// actually installed (never strands the last working cuDNN), only marks a
/// dir once (preserving the original timestamp so the grace clock isn't
/// reset every launch), and skips the active dir + non-`v` staging dirs.
pub fn mark_superseded_versions_stale(runtime_root: &Path) -> Result<u32> {
    let cudnn_root = runtime_root.join("cudnn");
    let keep_dir = format!("v{}", cudnn_version());
    if !cudnn_root.join(&keep_dir).exists() {
        // Active version not installed yet — don't mark the old one stale.
        return Ok(0);
    }
    let mut marked = 0u32;
    for entry in std::fs::read_dir(&cudnn_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Only versioned dirs (`v*`); skip the active one and `.v*.tmp`
        // staging dirs (those start with `.`).
        if !name.starts_with('v') || name == keep_dir {
            continue;
        }
        let marker = entry.path().join(".stale");
        if !marker.exists() {
            std::fs::write(&marker, now_unix().to_string())?;
            marked += 1;
        }
    }
    Ok(marked)
}
