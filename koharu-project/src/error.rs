use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("connection pool error: {0}")]
    Pool(#[from] r2d2::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("manifest at {path} is invalid: {reason}")]
    InvalidManifest { path: PathBuf, reason: String },

    #[error("unsupported manifest schema version: found {found}, supported up to {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },

    #[error("project root {0} already contains a koharu project")]
    AlreadyExists(PathBuf),

    #[error("project root {0} is not a koharu project (manifest missing)")]
    NotAProject(PathBuf),

    #[error("migration {version} ({name}) failed: {source}")]
    Migration {
        version: u32,
        name: String,
        #[source]
        source: rusqlite::Error,
    },

    #[error("not found: {0}")]
    NotFound(String),
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
