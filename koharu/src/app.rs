use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use clap::Parser;
use once_cell::sync::Lazy;
use rfd::MessageDialog;
use tauri::Manager;
use tokio::{net::TcpListener, sync::RwLock};
use tracing_subscriber::fmt::format::FmtSpan;

use koharu_ml::{cuda_is_available, device};
use koharu_pipeline::AppResources;
use koharu_renderer::facade::Renderer;
use koharu_rpc::{SharedResources, server};
use koharu_runtime::{ensure_dylibs, preload_dylibs};
use koharu_types::State;

static APP_ROOT: Lazy<PathBuf> = Lazy::new(|| {
    let path = dirs::data_local_dir()
        .map(|path| path.join("KoharuTH"))
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        if path.as_os_str().is_empty() {
            path
        } else {
            let abs_path = std::path::absolute(&path).unwrap_or(path);
            let path_str = abs_path.to_string_lossy();
            if !path_str.starts_with(r"\\?\") {
                PathBuf::from(format!(r"\\?\{}", path_str.replace('/', r"\")))
            } else {
                abs_path
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        path
    }
});
static LIB_ROOT: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("libs"));
/// HuggingFace model cache directory.
///
/// Renamed from `models/` to `hf/` in v1.2.2 to claw back a handful
/// of characters against Windows' MAX_PATH (260-char legacy limit).
/// HF's own layout under here (`models--<org>--<repo>/snapshots/<40-
/// hex-commit>/<filename>`) burns ~100 chars on its own, so shaving
/// the parent subdir from "models" to "hf" rescues paths that hover
/// just over the limit (long usernames + nested repo names).
///
/// `migrate_legacy_model_cache` (called at app startup) moves any
/// existing `Koharu/models/` content into `Koharu/hf/` so existing
/// users don't have to re-download multi-GB model weights.
/// See [issue #34](https://github.com/EarthWL/koharu-th/issues/34).
static MODEL_ROOT: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("hf"));
/// Legacy HF cache location used through v1.2.1. Kept as a constant
/// so the migration helper + uninstaller hook reference the same
/// path string. Once we're confident no v1.2.1-or-older user is
/// running unmigrated (a year+ from now), this can be deleted.
static LEGACY_MODEL_ROOT: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("models"));
/// User-droppable font directory. Any .ttf / .otf / .ttc in here is
/// registered alongside system fonts at renderer startup. Created on
/// first launch so the path always exists for the user to populate.
static FONT_ROOT: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("fonts"));
static ML_DEVICE_CONFIG_PATH: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("ml-device.json"));

#[derive(Parser)]
#[command(version = crate::version::APP_VERSION, about)]
struct Cli {
    #[arg(
        short,
        long,
        help = "Download dynamic libraries and exit",
        default_value_t = false
    )]
    download: bool,
    #[arg(
        long,
        help = "Force using CPU even if GPU is available",
        default_value_t = false
    )]
    cpu: bool,
    #[arg(
        short,
        long,
        value_name = "PORT",
        help = "Bind the HTTP server to a specific port instead of a random port"
    )]
    port: Option<u16>,
    #[arg(
        long,
        help = "Run in headless mode without starting the GUI",
        default_value_t = false
    )]
    headless: bool,
    #[arg(
        long,
        help = "Enable debug mode with console output",
        default_value_t = false
    )]
    debug: bool,
    #[arg(help = "Path to the .koharuproj file or project directory to open")]
    file: Option<PathBuf>,
}

static LOG_ROOT: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("logs"));

struct RollingFileWriter {
    log_dir: PathBuf,
    max_size: u64,
    inner: std::sync::Mutex<Option<RollingWriterInner>>,
}

struct RollingWriterInner {
    file: std::fs::File,
    current_size: u64,
}

impl RollingFileWriter {
    fn new(log_dir: PathBuf, max_size: u64) -> Self {
        Self {
            log_dir,
            max_size,
            inner: std::sync::Mutex::new(None),
        }
    }

    fn write_buf(&self, buf: &[u8]) -> std::io::Result<()> {
        let mut guard = self.inner.lock().unwrap();
        
        // Ensure directories exist and file is open
        if guard.is_none() {
            let _ = std::fs::create_dir_all(&self.log_dir);
            let active_path = self.log_dir.join("koharu.log");
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&active_path)?;
            let metadata = file.metadata()?;
            *guard = Some(RollingWriterInner {
                file,
                current_size: metadata.len(),
            });
        }

        let inner = guard.as_mut().unwrap();
        
        // Check size limit (10MB)
        if inner.current_size + buf.len() as u64 > self.max_size {
            // Rotate files
            // 1. Drop the current file to close it
            guard.take();

            let log_dir = &self.log_dir;
            let active_path = log_dir.join("koharu.log");
            let backup_1 = log_dir.join("koharu.1.log");
            let backup_2 = log_dir.join("koharu.2.log");

            // Delete backup_2, rename backup_1 to backup_2, rename active to backup_1
            if backup_2.exists() {
                let _ = std::fs::remove_file(&backup_2);
            }
            if backup_1.exists() {
                let _ = std::fs::rename(&backup_1, &backup_2);
            }
            if active_path.exists() {
                let _ = std::fs::rename(&active_path, &backup_1);
            }

            // Re-open active file
            let file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true) // Start fresh
                .open(&active_path)?;
            
            *guard = Some(RollingWriterInner {
                file,
                current_size: 0,
            });
        }

        if let Some(inner) = guard.as_mut() {
            use std::io::Write;
            inner.file.write_all(buf)?;
            let _ = inner.file.flush();
            inner.current_size += buf.len() as u64;
        }

        Ok(())
    }
}

struct CombinedWriter {
    file_writer: Arc<RollingFileWriter>,
}

impl std::io::Write for CombinedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stdout().write(buf);
        let _ = self.file_writer.write_buf(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stdout().flush();
        Ok(())
    }
}

fn initialize(headless: bool, _debug: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let attached_to_parent = crate::windows::attach_parent_console();

        // In GUI release builds, prefer the parent terminal if one exists.
        // Only allocate a new console window for explicit console-oriented runs.
        if !attached_to_parent && (headless || _debug) {
            crate::windows::create_console_window();
        }

        crate::windows::enable_ansi_support().ok();
    }

    // Initialize custom rolling file logger capped at 10MB
    std::fs::create_dir_all(LOG_ROOT.as_path()).ok();
    let file_writer = Arc::new(RollingFileWriter::new(LOG_ROOT.to_path_buf(), 10 * 1024 * 1024));
    let file_writer_clone = file_writer.clone();

    tracing_subscriber::fmt()
        .with_span_events(FmtSpan::CLOSE)
        .with_env_filter(
            tracing_subscriber::filter::EnvFilter::builder()
                .with_default_directive(tracing::Level::INFO.into())
                .from_env_lossy(),
        )
        .with_writer(move || CombinedWriter {
            file_writer: file_writer_clone.clone(),
        })
        .init();

    // Migrate legacy Koharu folder → KoharuTH (branding rename). Must run
    // before migrate_legacy_model_cache() so APP_ROOT exists first.
    if let Some(local_dir) = dirs::data_local_dir() {
        let legacy_path = local_dir.join("Koharu");
        if legacy_path.exists() && !APP_ROOT.exists() {
            tracing::info!("Migrating legacy Koharu directory from {:?} to {:?}", legacy_path, *APP_ROOT);
            if let Err(err) = robust_move_dir(&legacy_path, &*APP_ROOT) {
                tracing::warn!(?err, "Failed to migrate legacy Koharu directory automatically");
            }
        }
    }

    // Migrate legacy `KoharuTH/models/` → `KoharuTH/hf/` for users
    // upgrading from v1.2.1. Best-effort: failure logs and we continue
    // with the new path (hf-hub will re-download if needed). Runs BEFORE
    // create_dir_all on the new path so the rename target is still
    // missing — std::fs::rename refuses to overwrite a non-empty directory.
    migrate_legacy_model_cache();

    // Migrate WebView2 local storage and cache from the old identifier directory to the new one
    if let Some(local_dir) = dirs::data_local_dir() {
        let old_webview_path = APP_ROOT.join("EBWebView");
        let new_appdata_path = local_dir.join("com.earthwl.koharu-th");
        let new_webview_path = new_appdata_path.join("EBWebView");

        if old_webview_path.exists() && !new_webview_path.exists() {
            tracing::info!("Migrating legacy WebView2 user data from {:?} to {:?}", old_webview_path, new_webview_path);
            if let Err(err) = std::fs::create_dir_all(&new_appdata_path) {
                tracing::warn!(?err, "Failed to create new appdata directory for WebView2 migration");
            } else if let Err(err) = robust_move_dir(&old_webview_path, &new_webview_path) {
                tracing::warn!(?err, "Failed to migrate legacy WebView2 user data automatically");
            }
        }
    }

    std::fs::create_dir_all(MODEL_ROOT.as_path()).ok();
    std::fs::create_dir_all(LIB_ROOT.as_path()).ok();

    // Register libs + app root as protected directories so cleaner tools
    // (IObit, Revo Uninstaller, etc.) skip them in future scans.
    #[cfg(target_os = "windows")]
    crate::windows::register_protected_dirs(&[
        LIB_ROOT.as_path(),
        APP_ROOT.as_path(),
    ]);

    // Register .khr and .koharuproj file associations unconditionally so
    // double-clicking either extension opens Koharu regardless of GPU mode.
    // Previously this was gated behind cuda_is_available() in
    // build_resources_inner, meaning CPU-only machines never got the
    // associations registered at all.
    #[cfg(target_os = "windows")]
    if let Err(err) = crate::windows::register_file_associations() {
        tracing::warn!(
            ?err,
            "Failed to register .khr / .koharuproj file associations"
        );
    }

    // Remove stale temp files left by cleaner tools from the libs directory. IObit marks files it cannot delete immediately by
    // appending `_IObitDel` (potentially multiple times on retry) to the
    // filename. These stale rename-targets are safe to remove on startup
    // because: (a) the real DLL with the original name still exists, and
    // (b) the renamed copy is never loaded — it is only kept around for
    // IObit's own deferred-delete queue.
    cleanup_cleaner_temp_files(LIB_ROOT.as_path());
    cleanup_app_temp_files(APP_ROOT.as_path());


    // hook model cache dir
    koharu_ml::set_cache_dir(MODEL_ROOT.to_path_buf())?;

    // 3. Register custom std::panic::set_hook with backtrace and crash dump to APP_ROOT/crashes/
    std::panic::set_hook(Box::new(move |info| {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let crash_dir = APP_ROOT.join("crashes");
        let _ = std::fs::create_dir_all(&crash_dir);
        let crash_path = crash_dir.join(format!("crash_{}.log", timestamp));

        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            *s
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.as_str()
        } else {
            "Unknown panic payload"
        };

        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "Unknown location".to_string());
        
        let backtrace = std::backtrace::Backtrace::capture();
        let cuda_available = koharu_ml::cuda_is_available();
        let cpu_info = std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "Unknown".to_string());

        let dump_content = format!(
            "================================================================================\n\
             KOHARU-TH FATAL CRASH DUMP\n\
             ================================================================================\n\
             Timestamp: {}\n\
             OS: Windows\n\
             Arch: {}\n\
             CPU: {}\n\
             CUDA Available: {}\n\
             \n\
             Panic Payload: {}\n\
             Location: {}\n\
             \n\
             Backtrace:\n\
             {:?}\n\
             ================================================================================\n",
            chrono::Utc::now().to_rfc3339(),
            std::env::consts::ARCH,
            cpu_info,
            cuda_available,
            payload,
            location,
            backtrace
        );

        if let Err(e) = std::fs::write(&crash_path, &dump_content) {
            eprintln!("Failed to write crash dump to {:?}: {:?}", crash_path, e);
        }

        let dialog_msg = format!(
            "A fatal panic occurred (probably GPU CUDA Out Of Memory or model execution error).\n\n\
             Error: {}\n\
             Location: {}\n\n\
             A detailed diagnostic crash dump has been saved to:\n\
             {:?}\n\n\
             Please report this issue to the Koharu-TH developers.",
            payload, location, crash_path
        );

        if headless {
            eprintln!("================================================================================");
            eprintln!("FATAL PANIC AT {}", location);
            eprintln!("{}", payload);
            eprintln!("Crash dump saved to {:?}", crash_path);
            eprintln!("================================================================================");
        } else {
            MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Koharu-TH — Fatal Error")
                .set_description(&dialog_msg)
                .show();
        }

        std::process::exit(1);
    }));

    Ok(())
}

async fn prefetch() -> Result<()> {
    ensure_dylibs(LIB_ROOT.to_path_buf()).await?;
    koharu_ml::facade::prefetch().await?;

    Ok(())
}

/// One-shot migration of the HuggingFace model cache from the v1.2.1
/// location (`%LOCALAPPDATA%/KoharuTH/models/`) to the v1.2.2 location
/// (`%LOCALAPPDATA%/KoharuTH/hf/`). The rename is atomic on same-volume
/// renames (Windows + Unix both); cross-volume rename should never
/// happen here (both paths share the same %LOCALAPPDATA% root).
///
/// Failure modes:
///
/// - **Legacy path missing**: fresh install. Silent no-op.
/// - **Both paths populated**: should be impossible in practice (the
///   new path was introduced this commit), but defensively we LEAVE
///   BOTH alone — log a warning so a future investigator can spot
///   the conflict. hf-hub uses the new path; the legacy folder is
///   then dead weight cleanable by the user via the Storage panel
///   (it still sizes the `models/` folder via the legacy ownership
///   check) or the next uninstall.
/// - **Rename fails** (permissions, antivirus lock, etc.): log +
///   continue. hf-hub will re-download into the new path. Users
///   notice a one-time multi-GB re-download — annoying but not a
///   data-loss path. The legacy folder stays behind for them to
///   clean manually.
fn migrate_legacy_model_cache() {
    let legacy = LEGACY_MODEL_ROOT.as_path();
    let modern = MODEL_ROOT.as_path();

    let legacy_has_content = legacy.exists()
        && std::fs::read_dir(legacy)
            .ok()
            .map(|mut it| it.next().is_some())
            .unwrap_or(false);
    if !legacy_has_content {
        return;
    }

    let modern_has_content = modern.exists()
        && std::fs::read_dir(modern)
            .ok()
            .map(|mut it| it.next().is_some())
            .unwrap_or(false);
    if modern_has_content {
        tracing::warn!(
            legacy = %legacy.display(),
            modern = %modern.display(),
            "Both legacy and modern HF cache paths have content — leaving \
             both intact. Clean the legacy folder via Settings → Storage \
             once you've confirmed the new path works."
        );
        return;
    }

    // Make sure the rename target's parent exists. Both paths share
    // APP_ROOT but APP_ROOT might not have been created yet on a
    // first-of-its-kind install (legacy was the only thing here).
    if let Some(parent) = modern.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            tracing::warn!(
                ?err,
                dir = %parent.display(),
                "Failed to create parent directory for HF cache migration; skipping rename"
            );
            return;
        }
    }

    match std::fs::rename(legacy, modern) {
        Ok(()) => {
            tracing::info!(
                from = %legacy.display(),
                to = %modern.display(),
                "Migrated HF model cache to shorter path (issue #34)"
            );
        }
        Err(err) => {
            tracing::warn!(
                legacy = %legacy.display(),
                modern = %modern.display(),
                ?err,
                "Failed to migrate legacy HF cache; hf-hub will re-download \
                 missing weights on next launch. Legacy folder left intact."
            );
        }
    }
}

fn get_ml_device_selection() -> String {
    if let Ok(content) = std::fs::read_to_string(ML_DEVICE_CONFIG_PATH.as_path()) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(selection) = val.get("selection").and_then(|s| s.as_str()) {
                return selection.to_string();
            }
        }
    }
    "AUTO".to_string()
}

async fn build_resources(cpu_cli: bool, file: Option<PathBuf>) -> Result<AppResources> {
    let selection = if cpu_cli {
        "CPU".to_string()
    } else {
        get_ml_device_selection()
    };

    tracing::info!("Selected ML Compute device: {}", selection);
    koharu_ml::set_custom_device_selection(Some(selection.clone()));

    let is_cpu = selection == "CPU";

    // Try the requested selection first.
    if !is_cpu {
        match build_resources_inner(false, file.clone()).await {
            Ok(res) => return Ok(res),
            Err(err) => {
                tracing::warn!(
                    "Requested accelerator selection {selection} failed to initialize: {err:#}. Falling back to CPU mode for this session."
                );
                // Temporarily force CPU in the static state too for downstream lazy loads
                koharu_ml::set_custom_device_selection(Some("CPU".to_string()));
            }
        }
    }
    build_resources_inner(true, file).await
}

async fn build_resources_inner(cpu: bool, file: Option<PathBuf>) -> Result<AppResources> {
    if !cpu && cuda_is_available() {
        ensure_dylibs(LIB_ROOT.to_path_buf())
            .await
            .context("Failed to ensure dynamic libraries")?;
        preload_dylibs(LIB_ROOT.to_path_buf()).context("Failed to preload dynamic libraries")?;

        #[cfg(target_os = "windows")]
        {
            crate::windows::add_dll_directory(&LIB_ROOT).context("Failed to add DLL directory")?;
        }

        tracing::info!(
            "CUDA is available, loaded dynamic libraries from {:?}",
            *LIB_ROOT
        );
    }

    let ml = Arc::new(
        koharu_ml::facade::Model::new(cpu)
            .await
            .context("Failed to initialize ML model")?,
    );
    let llm = Arc::new(koharu_ml::llm::facade::Model::new(cpu));
    // Make sure the bundled-fonts directory exists so the user can drop
    // .ttf / .otf files in (e.g. Noto Sans Thai) without manually
    // creating the path. The first-run mkdir is non-fatal.
    if let Err(err) = std::fs::create_dir_all(FONT_ROOT.as_path()) {
        tracing::warn!(?err, dir = ?*FONT_ROOT, "could not create bundled-fonts dir");
    }
    let renderer = Arc::new(
        Renderer::new_with_extra_font_dirs(&[FONT_ROOT.to_path_buf()])
            .context("Failed to initialize renderer")?,
    );
    let state = Arc::new(RwLock::new(State::default()));

    let project = if let Some(path) = file {
        let root = if path.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("koharuproj"))
                == Some(true)
        {
            // `path.parent()` can return `Some("")` for bare filenames like
            // `foo.koharuproj` with no directory component. Fall back to the
            // current working directory so Project::open receives a valid dir.
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| path.clone()))
        } else {
            path
        };
        match koharu_project::Project::open(&root) {
            Ok(p) => {
                tracing::info!("Auto-loaded project from command-line: {:?}", root);
                // Also add to recent projects list!
                let entry = koharu_project::recent::RecentProject {
                    path: p.root().to_path_buf(),
                    name: p.manifest().name.clone(),
                    last_opened_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0),
                };
                let recent_path = APP_ROOT.join("recent-projects.json");
                let _ = koharu_project::recent::push(&recent_path, entry);
                Some(p)
            }
            Err(err) => {
                tracing::error!("Failed to auto-load project from command-line {:?}: {err:#}", root);
                None
            }
        }
    } else {
        None
    };

    Ok(AppResources {
        state,
        ml,
        llm,
        renderer,
        device: device(cpu)?,
        pipeline: Arc::new(RwLock::new(None)),
        queue_worker: Arc::new(RwLock::new(None)),
        project: Arc::new(RwLock::new(project)),
        recent_projects_path: APP_ROOT.join("recent-projects.json"),
        lib_root: LIB_ROOT.to_path_buf(),
        model_root: MODEL_ROOT.to_path_buf(),
        font_root: FONT_ROOT.to_path_buf(),
        version: crate::version::current(),
    })
}

pub async fn run() -> Result<()> {
    let Cli {
        download,
        cpu,
        port,
        headless,
        debug,
        file,
    } = Cli::parse();

    initialize(headless, debug)?;

    if download {
        prefetch().await?;
        return Ok(());
    }

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port.unwrap_or(0))).await?;
    let ws_port = listener.local_addr()?.port();
    let shared: SharedResources = Arc::new(tokio::sync::OnceCell::new());

#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn get_ml_device_config() -> String {
    get_ml_device_selection()
}

#[tauri::command]
fn set_ml_device_config(selection: String) -> std::result::Result<(), String> {
    if let Err(err) = std::fs::create_dir_all(APP_ROOT.as_path()) {
        return Err(format!("Failed to create APP_ROOT directory: {err}"));
    }
    let val = serde_json::json!({ "selection": selection });
    let content = serde_json::to_string_pretty(&val)
        .map_err(|e| format!("Failed to serialize ML device config: {e}"))?;
    std::fs::write(ML_DEVICE_CONFIG_PATH.as_path(), content)
        .map_err(|err| format!("Failed to write ml-device.json: {err}"))?;
    Ok(())
}

    let app = tauri::Builder::default()
        .append_invoke_initialization_script(format!("window.__KOHARU_WS_PORT__ = {};", ws_port))
        .invoke_handler(tauri::generate_handler![
            relaunch_app,
            get_ml_device_config,
            set_ml_device_config
        ])
        .setup({
            let shared = shared.clone();
            let file = file.clone();
            move |app| {
                let handle = app.handle().clone();
                let file = file.clone();
                tauri::async_runtime::spawn(async move {
                    handle
                        .plugin(tauri_plugin_updater::Builder::new().build())
                        .ok();

                    // Per issue #40: the global panic hook (installed in
                    // `initialize`) catches panics on the main thread —
                    // but `tauri::async_runtime::spawn` isolates panics
                    // at the task boundary, so a panic here would leave
                    // the splashscreen open forever with no error
                    // surfaced. Surface the error via a message dialog +
                    // exit cleanly instead.
                    let init_result = shared
                        .get_or_try_init(|| async { build_resources(cpu, file).await })
                        .await;
                    if let Err(err) = init_result {
                        let msg = format!(
                            "Failed to initialize app resources:\n\n{err:#}\n\n\
                             Common causes: missing GPU drivers, no disk space \
                             for the model cache, or a corrupted model download. \
                             Check the log file at %LOCALAPPDATA%\\Koharu\\ for \
                             details."
                        );
                        tracing::error!(?err, "build_resources failed");
                        MessageDialog::new()
                            .set_level(rfd::MessageLevel::Error)
                            .set_title("Koharu — Startup failed")
                            .set_description(&msg)
                            .show();
                        handle.exit(1);
                        return;
                    }

                    // Window-missing should never fire in a healthy
                    // bundle (both labels are declared in
                    // tauri.conf.json), but if it does we'd rather
                    // exit cleanly than panic inside a spawned task.
                    let Some(splash) = handle.get_webview_window("splashscreen") else {
                        tracing::error!("splashscreen window not found in bundle");
                        handle.exit(1);
                        return;
                    };
                    splash.close().ok();
                    let Some(main) = handle.get_webview_window("main") else {
                        tracing::error!("main window not found in bundle");
                        handle.exit(1);
                        return;
                    };
                    main.show().ok();
                });
                Ok(())
            }
        })
        .build(tauri::generate_context!())?;

    let tauri_resolver = Arc::new(app.asset_resolver());
    let resolver: server::SharedAssetResolver = Arc::new(move |path: &str| {
        let asset = tauri_resolver.get(path.to_string())?;
        Some(server::Asset {
            bytes: asset.bytes.to_vec(),
            mime_type: asset.mime_type.clone(),
        })
    });
    tokio::spawn({
        let shared = shared.clone();
        async move {
            if let Err(err) = server::serve_with_listener(listener, shared, resolver).await {
                tracing::error!("Server error: {err:#}");
            }
        }
    });

    if headless {
        shared
            .get_or_try_init(|| async { build_resources(cpu, file).await })
            .await?;
        tokio::signal::ctrl_c().await?;
    } else {
        app.run(|_, _| {});
    }

    Ok(())
}

/// ย้ายโฟลเดอร์แบบปลอดภัยรองรับการย้ายข้ามพาร์ทิชันดิสก์ (Cross-device partition move fallback)
///
/// Two-phase design (collect → copy → delete) ensures source files are NEVER
/// removed until ALL copies have succeeded. A mid-copy failure on disk-full /
/// permission-error / antivirus-lock leaves the source directory intact with
/// no data loss.
/// Remove stale temp files left behind by third-party cleaner / uninstaller
/// tools from `dir`.
///
/// Several popular tools rename files they cannot delete immediately rather
/// than deleting them in-place. On subsequent scans they may rename the
/// already-renamed copy again, causing suffix duplication. Patterns covered:
///
/// | Tool                              | Rename pattern         |
/// |-----------------------------------|------------------------|
/// | IObit Uninstaller / Advanced SystemCare | `_IObitDel` (repeating) |
/// | Revo Uninstaller                  | `_rbu`                 |
/// | FileASSASSIN / MoveFile           | `.$$$` extension       |
/// | Old Windows Installer cleanup     | `~` prefix             |
///
/// The original file with the correct name is never renamed by these tools —
/// only the "marked for deletion" copies accumulate. Removing them on startup
/// keeps the directory tidy and prevents false-positive load failures.
///
/// Note: CCleaner, Wise Registry Cleaner, and Windows Defender do *not*
/// rename — they either delete outright (handled by `ensure_dylibs` re-
/// downloading missing files) or quarantine to a separate folder outside
/// the app directory.
fn cleanup_cleaner_temp_files(dir: &std::path::Path) {
    /// Returns true if the filename matches a known cleaner-tool rename pattern.
    fn is_cleaner_temp(name: &str) -> bool {
        let lower = name.to_lowercase();
        // IObit: _IObitDel (may repeat: _IObitDel_IObitDel_IObitDel...)
        lower.contains("iobitdel")
        // Revo Uninstaller: _rbu suffix
        || lower.contains("_rbu.")
        // FileASSASSIN / MoveFile: .$$$, .$$, .$ extensions
        || lower.ends_with(".$$$")
        || lower.ends_with(".$$")
        || lower.ends_with(".$")
        // Windows Installer leftover: ~-prefixed staging files
        || name.starts_with('~')
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_cleaner_temp(&name_str) {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => tracing::debug!(
                    path = ?entry.path(),
                    "removed cleaner tool temp file"
                ),
                Err(err) => tracing::warn!(
                    path = ?entry.path(),
                    ?err,
                    "failed to remove cleaner tool temp file (will retry next launch)"
                ),
            }
        }
    }
}

/// Remove stale .tmp and .json.tmp files left behind in the application's root directory
/// after crashes or aborted atomic-write operations.
fn cleanup_app_temp_files(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let lower = name_str.to_lowercase();
            if lower.ends_with(".json.tmp") || lower.ends_with(".tmp") {
                match std::fs::remove_file(&path) {
                    Ok(()) => tracing::info!(?path, "removed stale app temporary file"),
                    Err(err) => tracing::warn!(?path, ?err, "failed to remove stale app temporary file"),
                }
            }
        }
    }
}


///
/// Symlinks and Windows NTFS junctions are skipped rather than traversed, to
/// prevent accidentally deleting the contents of an unrelated directory that a
/// junction inside the source tree might point at.
fn move_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    if src.is_file() {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
        std::fs::remove_file(src)?;
        return Ok(());
    }

    // Phase 1: collect all (src_file, dst_file) pairs recursively.
    let mut pairs: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    collect_file_pairs(src, dst, &mut pairs)?;

    // Phase 2: copy everything — abort on first error, sources untouched.
    for (s, d) in &pairs {
        if let Some(parent) = d.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(s, d)?;
    }

    // Phase 3: delete sources — only reached after ALL copies succeeded.
    for (s, _) in &pairs {
        let _ = std::fs::remove_file(s);
    }

    // Remove now-empty source directories (best-effort; non-fatal).
    remove_empty_dirs(src).ok();
    Ok(())
}

/// Recursively collect (src, dst) file path pairs, skipping symlinks/junctions.
fn collect_file_pairs(
    src: &std::path::Path,
    dst: &std::path::Path,
    out: &mut Vec<(std::path::PathBuf, std::path::PathBuf)>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if ft.is_symlink() {
            tracing::warn!(path = ?s, "skipping symlink/junction during directory migration");
            continue;
        }
        if ft.is_dir() {
            collect_file_pairs(&s, &d, out)?;
        } else {
            out.push((s, d));
        }
    }
    Ok(())
}

/// Remove a directory tree bottom-up, stopping as soon as any directory is non-empty.
fn remove_empty_dirs(path: &std::path::Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(path)?.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            remove_empty_dirs(&entry.path()).ok();
        }
    }
    std::fs::remove_dir(path)
}

/// พยายามย้ายไดเรกทอรีด้วย std::fs::rename ก่อน และถ้าล้มเหลว (เช่น ย้ายข้าม Drive) จะใช้ move_dir_all คัดลอกและลบแทน
fn robust_move_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    move_dir_all(src, dst)
}
