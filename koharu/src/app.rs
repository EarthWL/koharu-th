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
    dirs::data_local_dir()
        .map(|path| path.join("Koharu"))
        .unwrap_or_default()
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

    tracing_subscriber::fmt()
        .with_span_events(FmtSpan::CLOSE)
        .with_env_filter(
            tracing_subscriber::filter::EnvFilter::builder()
                .with_default_directive(tracing::Level::INFO.into())
                .from_env_lossy(),
        )
        .init();

    // Migrate legacy `Koharu/models/` → `Koharu/hf/` for v1.2.1
    // users upgrading to v1.2.2+. Best-effort: failure logs + we
    // continue with the new path (hf-hub will re-download). Runs
    // BEFORE create_dir_all on the new path so the rename target
    // is still missing — std::fs::rename refuses to overwrite a
    // non-empty directory on Windows.
    migrate_legacy_model_cache();

    std::fs::create_dir_all(MODEL_ROOT.as_path()).ok();
    std::fs::create_dir_all(LIB_ROOT.as_path()).ok();

    // hook model cache dir
    koharu_ml::set_cache_dir(MODEL_ROOT.to_path_buf())?;

    if headless {
        std::panic::set_hook(Box::new(|info| {
            eprintln!("panic: {info}");
        }));
    } else {
        std::panic::set_hook(Box::new(|info| {
            let msg = info.to_string();
            MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Panic")
                .set_description(&msg)
                .show();
            std::process::exit(1);
        }));
    }

    Ok(())
}

async fn prefetch() -> Result<()> {
    ensure_dylibs(LIB_ROOT.to_path_buf()).await?;
    koharu_ml::facade::prefetch().await?;

    Ok(())
}

/// One-shot migration of the HuggingFace model cache from the v1.2.1
/// location (`%LOCALAPPDATA%/Koharu/models/`) to the v1.2.2 location
/// (`%LOCALAPPDATA%/Koharu/hf/`). The rename is atomic on same-volume
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
        let _ = std::fs::create_dir_all(parent);
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

async fn build_resources(cpu: bool) -> Result<AppResources> {
    // Try the requested device (usually GPU) first. If anything in the
    // GPU init path fails — dylib download, preload, ML model init on
    // the wrong compute cap, driver mismatch — fall back to CPU once
    // and surface a warning. Better than crashing the whole app for
    // someone whose card the binary wasn't built for (e.g. RTX 50xx
    // when CUDA_COMPUTE_CAP only included Turing).
    if !cpu {
        match build_resources_inner(false).await {
            Ok(res) => return Ok(res),
            Err(err) => {
                tracing::warn!(
                    "GPU initialization failed: {err:#}. Falling back to CPU mode for this session."
                );
            }
        }
    }
    build_resources_inner(true).await
}

async fn build_resources_inner(cpu: bool) -> Result<AppResources> {
    if !cpu && cuda_is_available() {
        ensure_dylibs(LIB_ROOT.to_path_buf())
            .await
            .context("Failed to ensure dynamic libraries")?;
        preload_dylibs(LIB_ROOT.to_path_buf()).context("Failed to preload dynamic libraries")?;

        #[cfg(target_os = "windows")]
        {
            if let Err(err) = crate::windows::register_file_associations() {
                tracing::warn!(
                    ?err,
                    "Failed to register .khr / .koharuproj file associations"
                );
            }

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

    Ok(AppResources {
        state,
        ml,
        llm,
        renderer,
        device: device(cpu)?,
        pipeline: Arc::new(RwLock::new(None)),
        queue_worker: Arc::new(RwLock::new(None)),
        project: Arc::new(RwLock::new(None)),
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
    } = Cli::parse();

    initialize(headless, debug)?;

    if download {
        prefetch().await?;
        return Ok(());
    }

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port.unwrap_or(0))).await?;
    let ws_port = listener.local_addr()?.port();
    let shared: SharedResources = Arc::new(tokio::sync::OnceCell::new());

    let app = tauri::Builder::default()
        .append_invoke_initialization_script(format!("window.__KOHARU_WS_PORT__ = {};", ws_port))
        .setup({
            let shared = shared.clone();
            move |app| {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    handle
                        .plugin(tauri_plugin_updater::Builder::new().build())
                        .ok();

                    shared
                        .get_or_try_init(|| async { build_resources(cpu).await })
                        .await
                        .expect("failed to build app resources");

                    handle
                        .get_webview_window("splashscreen")
                        .expect("splashscreen window not found")
                        .close()
                        .ok();
                    handle
                        .get_webview_window("main")
                        .expect("main window not found")
                        .show()
                        .ok();
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
            .get_or_try_init(|| async { build_resources(cpu).await })
            .await?;
        tokio::signal::ctrl_c().await?;
    } else {
        app.run(|_, _| {});
    }

    Ok(())
}
