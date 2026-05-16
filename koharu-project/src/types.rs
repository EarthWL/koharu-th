//! Core data types mirroring the SQLite schema. Wire-format (camelCase)
//! matches the existing koharu UI / API convention.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Project status of a chapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChapterStatus {
    Pending,
    InProgress,
    Translated,
    Reviewed,
    Done,
}

impl ChapterStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Translated => "translated",
            Self::Reviewed => "reviewed",
            Self::Done => "done",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "translated" => Some(Self::Translated),
            "reviewed" => Some(Self::Reviewed),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

/// Where a glossary entry came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Manual,
    Extracted,
    Auto,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Extracted => "extracted",
            Self::Auto => "auto",
        }
    }
}

/// Singleton series metadata row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMeta {
    pub title: String,
    pub title_original: Option<String>,
    pub synopsis: Option<String>,
    pub genre: Vec<String>,
    pub target_audience: Option<String>,
    pub source_language: String,
    pub target_language: String,
    pub tone: Option<String>,
    pub formality_level: Option<String>,
    pub style_notes: Option<String>,
    pub cover_image: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl SeriesMeta {
    /// Reasonable defaults for a brand-new series.
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            title: title.into(),
            title_original: None,
            synopsis: None,
            genre: Vec::new(),
            target_audience: None,
            source_language: "ja".into(),
            target_language: "th".into(),
            tone: None,
            formality_level: None,
            style_notes: None,
            cover_image: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// A chapter inside a project. `folder_path` is relative to the project
/// root and contains two subfolders: `source/` (uploaded originals) and
/// `render/` (rendered output). Page count reflects files in source/.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: i64,
    pub folder_path: String,
    pub chapter_number: f64,
    pub title: Option<String>,
    pub volume: Option<i64>,
    pub status: ChapterStatus,
    pub summary: Option<String>,
    pub notes: Option<String>,
    pub page_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// An alias for a character — original form and its preferred translation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameAlias {
    pub src: String,
    pub tgt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: i64,
    pub original_name: String,
    pub translated_name: String,
    #[serde(default)]
    pub aliases: Vec<NameAlias>,
    pub role: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub speech_style: Option<String>,
    pub personality: Option<String>,
    #[serde(default)]
    pub relationships: serde_json::Value,
    pub first_appearance_chapter_id: Option<i64>,
    pub notes: Option<String>,
    pub is_main: bool,
    pub sort_order: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlossaryCategory {
    Term,
    Place,
    Skill,
    Honorific,
    Item,
    Org,
    Sfx,
}

impl GlossaryCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Term => "term",
            Self::Place => "place",
            Self::Skill => "skill",
            Self::Honorific => "honorific",
            Self::Item => "item",
            Self::Org => "org",
            Self::Sfx => "sfx",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "term" => Some(Self::Term),
            "place" => Some(Self::Place),
            "skill" => Some(Self::Skill),
            "honorific" => Some(Self::Honorific),
            "item" => Some(Self::Item),
            "org" => Some(Self::Org),
            "sfx" => Some(Self::Sfx),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryEntry {
    pub id: i64,
    pub source_text: String,
    pub target_text: String,
    pub category: GlossaryCategory,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub context_note: Option<String>,
    pub first_appearance_chapter_id: Option<i64>,
    pub usage_count: i64,
    pub confidence: Confidence,
    pub approved: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptUseCase {
    Translate,
    ExtractEntities,
    SummarizeChapter,
}

impl PromptUseCase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Translate => "translate",
            Self::ExtractEntities => "extract_entities",
            Self::SummarizeChapter => "summarize_chapter",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub use_case: PromptUseCase,
    pub template: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Gemini,
    Anthropic,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Gemini => "gemini",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: i64,
    pub name: String,
    pub provider: Provider,
    pub api_url: Option<String>,
    pub model_name: String,
    /// Reference into the OS keyring — the actual key is never persisted in DB.
    pub api_key_ref: Option<String>,
    #[serde(default)]
    pub extra_headers: serde_json::Value,
    #[serde(default)]
    pub extra_params: serde_json::Value,
    pub is_default: bool,
    pub cost_input_per_1m: Option<f64>,
    pub cost_output_per_1m: Option<f64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
