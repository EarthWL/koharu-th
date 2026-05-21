use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use hf_hub::{
    Cache, Repo,
    api::tokio::{Api, ApiBuilder, Progress},
};
use indicatif::ProgressBar;
use koharu_api::events::{DownloadProgress, DownloadStatus};
use once_cell::sync::{Lazy, OnceCell};

use crate::download::emit;
use crate::progress::progress_bar;

static CACHE_DIR: OnceCell<PathBuf> = OnceCell::new();

static HF_API: Lazy<Api> = Lazy::new(|| {
    ApiBuilder::new()
        .with_cache_dir(get_cache_dir().to_path_buf())
        .high()
        .build()
        .expect("build HF API client")
});
static HF_CACHE: Lazy<Cache> = Lazy::new(|| Cache::new(get_cache_dir().to_path_buf()));

fn get_cache_dir() -> &'static PathBuf {
    CACHE_DIR.get_or_init(|| {
        // Per issue #41 — `HF_API` and `HF_CACHE` are `Lazy<>`
        // that resolve `CACHE_DIR` on first access. The production
        // invariant is `koharu::app::initialize` calls
        // `set_cache_dir(MODEL_ROOT)` BEFORE any code path can
        // touch them. If that ordering is ever violated, the
        // fallback fires and downloads land in the WRONG directory.
        //
        // Surface the case so it's loud + observable. Tests +
        // headless tools that intentionally rely on the fallback
        // can ignore the warning (test framework filters
        // `tracing::warn!` by default unless RUST_LOG is set).
        tracing::warn!(
            "hf_hub::CACHE_DIR fallback fired — set_cache_dir was \
             never called. If this is a production binary, the HF \
             cache will land in dirs::data_local_dir()/KoharuTH/hf rather \
             than the MODEL_ROOT path (issue #41)."
        );
        // Uses `data_local_dir` + `KoharuTH` to match the production
        // `MODEL_ROOT` path exactly, so that if this fallback fires
        // first (race with `set_cache_dir`), `set_cache_dir` can
        // detect the collision as a same-path duplicate and succeed
        // rather than crashing with "already set" (issue #41, #44).
        let path = dirs::data_local_dir()
            .unwrap_or_default()
            .join("KoharuTH")
            .join("hf");

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
    })
}

pub fn set_cache_dir(path: PathBuf) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    let path = {
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
    };

    use anyhow::Context;
    std::fs::create_dir_all(&path)
        .with_context(|| format!("failed to create cache directory: {}", path.display()))?;

    // Tolerate duplicate calls with the same path — can happen if the
    // HF_API / HF_CACHE lazy statics fire their fallback initializer
    // before `initialize()` reaches `set_cache_dir` (issue #41).
    if let Err(_rejected) = CACHE_DIR.set(path.clone()) {
        let existing = CACHE_DIR
            .get()
            .expect("set failed so cell must be initialized");
        if existing == &path {
            tracing::debug!("set_cache_dir: already set to same path; ignoring duplicate call");
            return Ok(());
        }
        anyhow::bail!(
            "cache dir already set to '{}'; cannot change to '{}'",
            existing.display(),
            path.display()
        );
    }
    Ok(())
}

pub fn api() -> &'static Api {
    &HF_API
}

pub fn cache() -> &'static Cache {
    &HF_CACHE
}

pub fn repo(name: &str) -> Repo {
    Repo::model(name.to_string())
}

#[derive(Clone)]
pub(crate) struct Reporter {
    pb: ProgressBar,
    filename: String,
    downloaded: Arc<AtomicU64>,
    total: u64,
}

impl Reporter {
    pub fn new(filename: &str) -> Self {
        Self {
            pb: progress_bar(filename),
            filename: filename.to_string(),
            downloaded: Arc::new(AtomicU64::new(0)),
            total: 0,
        }
    }
}

impl Progress for Reporter {
    async fn init(&mut self, size: usize, filename: &str) {
        self.filename = filename.to_string();
        self.downloaded.store(0, Ordering::Relaxed);
        self.total = size as u64;
        self.pb.set_length(size as u64);
        self.pb.set_position(0);
        emit(DownloadProgress {
            filename: self.filename.clone(),
            downloaded: 0,
            total: Some(self.total),
            status: DownloadStatus::Started,
        });
    }

    async fn update(&mut self, size: usize) {
        let current = self.downloaded.fetch_add(size as u64, Ordering::Relaxed) + size as u64;
        self.pb.inc(size as u64);
        emit(DownloadProgress {
            filename: self.filename.clone(),
            downloaded: current,
            total: Some(self.total),
            status: DownloadStatus::Downloading,
        });
    }

    async fn finish(&mut self) {
        self.pb.finish_and_clear();
        emit(DownloadProgress {
            filename: self.filename.clone(),
            downloaded: self.downloaded.load(Ordering::Relaxed),
            total: Some(self.total),
            status: DownloadStatus::Completed,
        });
    }
}
