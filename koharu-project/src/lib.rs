//! Per-series project storage for koharu-th.
//!
//! A "project" is a folder containing:
//! - `series.koharuproj` — manifest (JSON, small)
//! - `series.db`         — SQLite database (canonical data)
//! - `chapters/*.khr`    — chapter files (still standalone-openable)
//! - `reference/`, `assets/`, `export/`
//!
//! The DB holds series metadata, chapters index, characters, glossary,
//! translation memory, prompt templates, provider profiles, and an LLM
//! call log. See `migrations/V001__initial_schema.sql` for the schema.

pub mod chapter;
pub mod character;
mod db;
mod error;
pub mod glossary;
mod manifest;
mod project;
pub mod series;
mod types;

pub use db::{Conn, Pool};
pub use error::{Error, Result};
pub use manifest::{Manifest, ManifestPaths, MANIFEST_FILENAME, SUPPORTED_SCHEMA_VERSION};
pub use project::Project;
pub use types::{
    Chapter, ChapterStatus, Character, Confidence, GlossaryCategory, GlossaryEntry, NameAlias,
    PromptTemplate, PromptUseCase, Provider, ProviderProfile, SeriesMeta,
};
