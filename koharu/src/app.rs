use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use clap::Parser;
use once_cell::sync::Lazy;
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
static MODEL_ROOT: Lazy<PathBuf> = Lazy::new(|| APP_ROOT.join("models"));
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

    std::fs::create_dir_all(MODEL_ROOT.as_path()).ok();
    std::fs::create_dir_all(LIB_ROOT.as_path()).ok();

    // hook model cache dir
    koharu_ml::set_cache_dir(MODEL_ROOT.to_path_buf())?;

    // Audit #9 follow-up #2: the panic hook ONLY logs. Critical
    // not to call MessageDialog + process::exit here — those run
    // synchronously at the panic point, BEFORE Rust starts
    // unwinding. Which means `std::panic::catch_unwind` further up
    // the stack never gets a chance to convert the panic into an
    // Err. The audit-#9/B3 thread guard in koharu_ml::lama::
    // catch_cudnn_panic + the bridge-level guard in
    // engine_bridge::run_engine_on_document are NO-OPS as long as
    // this hook exits the process first.
    //
    // Symptom we hit: cudarc 0.19.3 has `unwrap()` in
    // `<Cudnn as Drop>::drop` — when the cuDNN handle gets
    // destroyed after a successful inference call,
    // CUDNN_STATUS_INTERNAL_ERROR in cleanup triggers a panic in
    // a destructor. The destructor runs INSIDE our catch_unwind
    // region (handle goes out of scope inside the call), so
    // catch_unwind COULD catch it — but only if this hook doesn't
    // pre-empt with exit(1).
    //
    // New behaviour: log the panic + backtrace via tracing (so we
    // still see it in logs), then RETURN from the hook. Rust's
    // default unwinding continues, catch_unwind catches inside
    // engine.run / inference_model_rgb, panic becomes Err,
    // process survives, user gets a toast through the existing
    // engine-failure path.
    //
    // Uncaught panics (escape every catch_unwind boundary) follow
    // Rust's default thread-abort behaviour. The Tauri main
    // thread aborting would crash the app anyway; surfacing a
    // friendly dialog for THAT case is future work.
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        tracing::error!(panic = %msg, "panic captured by hook (log-only, will continue unwinding)");
        if let Some(loc) = info.location() {
            tracing::error!(
                file = loc.file(),
                line = loc.line(),
                col = loc.column(),
                "panic location"
            );
        }
        let bt = std::backtrace::Backtrace::force_capture();
        tracing::error!(backtrace = %bt, "panic backtrace");
        // In headless mode tracing alone might not surface to the
        // terminal if subscribers are filtered; mirror to stderr.
        if std::env::var_os("KOHARU_HEADLESS").is_some() {
            eprintln!("panic: {msg}");
        }
    }));
    let _ = headless; // signal-only — the hook is the same in both modes

    Ok(())
}

async fn prefetch() -> Result<()> {
    ensure_dylibs(LIB_ROOT.to_path_buf()).await?;
    koharu_ml::facade::prefetch().await?;

    Ok(())
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

    // F4.C: load the machine-wide engine profile. Missing file =
    // empty profile (fresh install). A parse error keeps the app
    // launchable with a default profile + a warning — losing the
    // saved profile is a degraded UX, not a launch-blocker.
    let engine_profile_path = APP_ROOT.join("engine_profile.json");
    let engine_profile = koharu_pipeline::engine_profile::EngineProfileStore::load(
        &engine_profile_path,
    )
    .unwrap_or_else(|err| {
        tracing::warn!(
            ?err,
            path = %engine_profile_path.display(),
            "could not load engine profile; starting from defaults"
        );
        koharu_pipeline::engine_profile::EngineProfileStore::with_initial(
            Default::default(),
            engine_profile_path.clone(),
        )
    });

    Ok(AppResources {
        state,
        // Phase 2: in-memory BlobStore. Lives for the app's lifetime;
        // every binary served to the frontend (page image, masks,
        // renders) lands here keyed by blake3 hash. Disk backing
        // queued for a later phase — current sessions don't need
        // cross-restart blob persistence.
        blobs: koharu_core::BlobStore::in_memory(),
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
        engine_profile,
        // Phase 5.3: ProjectSession is lazy-initialised on the
        // first engine_bridge run. Phase 5.5 manages explicit
        // chapter-open/close lifecycle. Wrapped in `SessionSlot`
        // (audit #7/P1) so the doc_index travels alongside the
        // session under one lock, preventing cross-doc undo
        // mirroring bugs.
        session: Arc::new(RwLock::new(
            koharu_pipeline::session_slot::SessionSlot::new(),
        )),
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
