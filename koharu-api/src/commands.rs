use koharu_types::{DetectorEngine, OcrEngine, TextBlock, TextShaderEffect, TextStrokeStyle};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub ml_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalPayload {
    pub url: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexPayload {
    pub index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResult {
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentsPayload {
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub filename: String,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPayload {
    pub index: usize,
    pub text_block_index: Option<usize>,
    pub shader_effect: Option<TextShaderEffect>,
    pub shader_stroke: Option<TextStrokeStyle>,
    pub font_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTextBlocksPayload {
    pub index: usize,
    pub text_blocks: Vec<TextBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmListPayload {
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmLoadPayload {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmGeneratePayload {
    pub index: usize,
    pub text_block_index: Option<usize>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmLoadParams {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmGenerateParams {
    pub index: usize,
    pub text_block_index: Option<usize>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRequest {
    pub index: Option<usize>,
    pub llm_model_id: Option<String>,
    pub language: Option<String>,
    pub shader_effect: Option<TextShaderEffect>,
    pub shader_stroke: Option<TextStrokeStyle>,
    pub font_family: Option<String>,
    /// Engine to use for the OCR step. `None` ⇒ backend default
    /// (Mit48px). UI sets this from `preferencesStore.ocrEngine`.
    pub ocr_engine: Option<OcrEngine>,
    /// Skip the OCR step entirely — frontend caller has already
    /// populated `text_blocks[].text` (e.g. via Cloud Vision OCR done
    /// in TypeScript). Used when `ocrEngine` is `'cloud'` on the
    /// frontend: it OCRs first, then asks Rust to run
    /// [skip detect] → [skip OCR] → inpaint → translate → render.
    pub skip_ocr: Option<bool>,
    /// Skip the detect step. Frontend uses this in tandem with
    /// `skip_ocr=true` when doing Cloud Vision OCR — it already
    /// called `detect` directly and populated text_blocks, so
    /// re-running detect inside the pipeline would overwrite the
    /// cloud-OCR'd text.
    pub skip_detect: Option<bool>,
    /// Engine to use for the Detect step. `None` ⇒ backend default
    /// (`comic_text_detector`). UI sets this from
    /// `preferencesStore.detectorEngine`.
    pub detector_engine: Option<DetectorEngine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InpaintRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInpaintMaskPayload {
    pub index: usize,
    #[serde(with = "serde_bytes")]
    pub mask: Vec<u8>,
    pub region: Option<InpaintRegion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBrushLayerPayload {
    pub index: usize,
    #[serde(with = "serde_bytes")]
    pub patch: Vec<u8>,
    pub region: InpaintRegion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintPartialPayload {
    pub index: usize,
    pub region: InpaintRegion,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewImageParams {
    pub index: usize,
    pub layer: String,
    pub max_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewTextBlockParams {
    pub index: usize,
    pub text_block_index: usize,
    pub layer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentsParams {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocumentParams {
    pub index: usize,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenderParams {
    pub index: usize,
    pub text_block_index: Option<usize>,
    pub shader_effect: Option<String>,
    pub font_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessParams {
    pub index: Option<usize>,
    pub llm_model_id: Option<String>,
    pub language: Option<String>,
    pub shader_effect: Option<String>,
    pub font_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTextBlockPayload {
    pub index: usize,
    pub text_block_index: usize,
    pub translation: Option<String>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub font_families: Option<Vec<String>>,
    pub font_size: Option<f32>,
    pub color: Option<String>,
    pub shader_effect: Option<String>,
    pub rotation_deg: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddTextBlockPayload {
    pub index: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextBlockFitToBubblePayload {
    pub index: usize,
    pub text_block_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTextBlockPayload {
    pub index: usize,
    pub text_block_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaskMorphPayload {
    pub index: usize,
    pub radius: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InpaintRegionParams {
    pub index: usize,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

// ------------------------------------------------------------
// Project lifecycle (Phase 1) — folder-anchored series projects.
// Path is the project root directory (the folder containing
// series.koharuproj). For the open-picker variant, the user picks
// a `.koharuproj` file and the host resolves the parent dir.
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreatePayload {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreatePickerPayload {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectDto {
    pub path: String,
    pub name: String,
    pub last_opened_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectRemovePayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBackupResult {
    /// Absolute path of the zip file written, or null if the user
    /// cancelled the save-file dialog.
    pub path: Option<String>,
    pub file_count: u32,
}

/// Summary returned by project_open / project_create / project_current.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: String,
    pub id: String,
    pub name: String,
    pub name_original: Option<String>,
    pub schema_version: u32,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub chapter_count: u32,
    pub character_count: u32,
    pub glossary_count: u32,
}

// ------------------------------------------------------------
// Phase 2: series metadata + chapter index payloads.
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMetaDto {
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMetaUpdatePayload {
    pub title: Option<String>,
    pub title_original: Option<String>,
    pub synopsis: Option<String>,
    pub genre: Option<Vec<String>>,
    pub target_audience: Option<String>,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub tone: Option<String>,
    pub formality_level: Option<String>,
    pub style_notes: Option<String>,
    pub cover_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDto {
    pub id: i64,
    /// Relative folder path inside the project root, e.g. "chapters/ch01".
    pub folder_path: String,
    pub chapter_number: f64,
    pub title: Option<String>,
    pub volume: Option<i64>,
    pub status: String,
    pub summary: Option<String>,
    pub notes: Option<String>,
    pub page_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Create a chapter — backend mints a folder name from title /
/// chapter_number, makes `source/` + `render/` subfolders, and inserts
/// the row. No files yet; user adds pages separately.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCreatePayload {
    pub chapter_number: f64,
    pub title: Option<String>,
    pub volume: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterAddPagesPayload {
    pub chapter_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterUpdatePayload {
    pub id: i64,
    pub chapter_number: Option<f64>,
    pub title: Option<String>,
    pub volume: Option<i64>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub notes: Option<String>,
    pub page_count: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterIdPayload {
    pub id: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterClearPagesResult {
    /// Number of files successfully deleted from `source/`.
    pub removed: u32,
    /// Number of files we failed to delete (logged on the Rust side).
    /// Usually 0 — a non-zero count typically means a file was locked
    /// by another process (e.g. the OS preview pane).
    pub failed: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPagePayload {
    pub chapter_id: i64,
    /// 0-based index into the chapter's `source/` directory after the
    /// pages are sorted by filename. Matches the same ordering the
    /// editor uses when the chapter is opened.
    pub page_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPageBytes {
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    /// Filename of the page on disk (e.g. "001.png") so the caller can
    /// infer mime / show it as a label.
    pub filename: String,
    pub page_index: usize,
    pub total_pages: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterExportCbzResult {
    /// Absolute path of the .cbz written, or null when the user
    /// cancelled the save dialog.
    pub path: Option<String>,
    pub page_count: u32,
    /// True if pages came from `render/`; false if we fell back to `source/`.
    pub used_render: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterImportResult {
    /// Number of new chapter rows added.
    pub added: u32,
    /// Number of files the user picked that were skipped (unsupported
    /// extension, copy failure, etc.).
    pub skipped: u32,
}

// ------------------------------------------------------------
// Phase 3: characters + glossary
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NameAliasDto {
    pub src: String,
    pub tgt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDto {
    pub id: i64,
    pub original_name: String,
    pub translated_name: String,
    pub aliases: Vec<NameAliasDto>,
    pub role: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub speech_style: Option<String>,
    pub personality: Option<String>,
    pub notes: Option<String>,
    pub is_main: bool,
    pub sort_order: i64,
    pub first_appearance_chapter_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CharacterAddPayload {
    pub original_name: String,
    pub translated_name: String,
    #[serde(default)]
    pub aliases: Vec<NameAliasDto>,
    pub role: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub speech_style: Option<String>,
    pub personality: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub is_main: bool,
    #[serde(default)]
    pub sort_order: i64,
    pub first_appearance_chapter_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CharacterUpdatePayload {
    pub id: i64,
    pub original_name: Option<String>,
    pub translated_name: Option<String>,
    pub aliases: Option<Vec<NameAliasDto>>,
    pub role: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub speech_style: Option<String>,
    pub personality: Option<String>,
    pub notes: Option<String>,
    pub is_main: Option<bool>,
    pub sort_order: Option<i64>,
    pub first_appearance_chapter_id: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CharacterIdPayload {
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryDto {
    pub id: i64,
    pub source_text: String,
    pub target_text: String,
    pub category: String,
    pub aliases: Vec<String>,
    pub context_note: Option<String>,
    pub first_appearance_chapter_id: Option<i64>,
    pub usage_count: i64,
    pub confidence: String,
    pub approved: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryAddPayload {
    pub source_text: String,
    pub target_text: String,
    pub category: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub context_note: Option<String>,
    pub first_appearance_chapter_id: Option<i64>,
    pub confidence: Option<String>,
    pub approved: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryUpdatePayload {
    pub id: i64,
    pub source_text: Option<String>,
    pub target_text: Option<String>,
    pub category: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub context_note: Option<String>,
    pub first_appearance_chapter_id: Option<i64>,
    pub confidence: Option<String>,
    pub approved: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryIdPayload {
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryBumpUsagePayload {
    pub ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryBulkAddPayload {
    pub items: Vec<GlossaryAddPayload>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryBulkAddResult {
    pub inserted: u32,
    pub skipped: u32,
}

// ------------------------------------------------------------
// Phase 4: prompt templates + rendering
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateDto {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub use_case: String,
    pub template: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateAddPayload {
    pub name: String,
    pub description: Option<String>,
    pub use_case: String,
    pub template: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateUpdatePayload {
    pub id: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub use_case: Option<String>,
    pub template: Option<String>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateIdPayload {
    pub id: i64,
}

/// Inputs to `prompt_render`. If `template_name` is None the default
/// template for `use_case` is used.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptRenderPayload {
    pub use_case: String,
    pub source_text: String,
    pub template_name: Option<String>,
    /// Optional pre-built rolling-summary string. If both this and
    /// `chapter_id` are empty, no summary is injected.
    #[serde(default)]
    pub rolling_summary: String,
    /// When set (and `rolling_summary` is empty), the backend auto-fetches
    /// summaries of the N chapters before this one via
    /// `chapter::rolling_summary`.
    #[serde(default)]
    pub chapter_id: Option<i64>,
    /// Number of prior chapters to include in the auto-fetched summary.
    /// Ignored when `chapter_id` is None. Defaults to 2 if not set.
    #[serde(default)]
    pub rolling_chapter_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptRenderResult {
    pub prompt: String,
    /// Name of the template actually used.
    pub template_name: String,
    /// Glossary entry IDs that the smart filter matched. The UI passes
    /// these back to `glossary_bump_usage` after a successful generation.
    pub glossary_hit_ids: Vec<i64>,
}

// ------------------------------------------------------------
// Phase 6: translation memory
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmLookupPayload {
    pub source_text: String,
    pub target_lang: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmLookupFuzzyPayload {
    pub source_text: String,
    pub target_lang: String,
    /// 0.0..1.0; entries below this Jaccard similarity are ignored.
    /// Recommended default is ~0.85 for "very close" matches.
    pub min_similarity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmFuzzyHit {
    pub entry: TmEntryDto,
    pub similarity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmInsertPayload {
    pub source_text: String,
    pub target_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub chapter_id: Option<i64>,
    pub page_index: Option<i64>,
    pub text_block_index: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmEntryDto {
    pub id: i64,
    pub source_text: String,
    pub target_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub chapter_id: Option<i64>,
    pub page_index: Option<i64>,
    pub text_block_index: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub is_approved: bool,
    pub created_at: String,
}

// ------------------------------------------------------------
// TM semantic-search (embeddings)
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmPendingEmbeddingsPayload {
    /// The embedding model id we plan to embed with (entries with a
    /// different `embedding_model` are also returned as pending so
    /// the user can re-backfill when switching models).
    pub model: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmPendingEmbeddingItem {
    pub id: i64,
    pub source_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmPendingCountPayload {
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmSetEmbeddingPayload {
    pub id: i64,
    pub embedding: Vec<f32>,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmLookupSemanticPayload {
    pub embedding: Vec<f32>,
    pub model: String,
    pub target_lang: String,
    /// Default 5.
    pub top_k: Option<u32>,
    /// Cosine threshold below which entries are dropped. 0.0..1.0,
    /// default 0.75. (~0.85 for "very close" semantic matches.)
    pub min_similarity: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmSemanticHit {
    pub entry: TmEntryDto,
    pub similarity: f32,
}

// ------------------------------------------------------------
// TMX (Translation Memory eXchange) import/export
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmxExportResult {
    /// Absolute path written, or null if cancelled.
    pub path: Option<String>,
    pub entries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmxImportResult {
    pub inserted: u32,
    pub skipped: u32,
}

// ------------------------------------------------------------
// Phase 9: provider profiles
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileDto {
    pub id: i64,
    pub name: String,
    pub provider: String,
    pub api_url: Option<String>,
    pub model_name: String,
    pub api_key_ref: Option<String>,
    pub is_default: bool,
    pub cost_input_per_1m: Option<f64>,
    pub cost_output_per_1m: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileAddPayload {
    pub name: String,
    pub provider: String,
    pub api_url: Option<String>,
    pub model_name: String,
    /// Plaintext API key — stored in the OS keyring server-side and
    /// never written back to the DB. Pass an empty string to leave
    /// the keyring entry empty.
    pub api_key: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    pub cost_input_per_1m: Option<f64>,
    pub cost_output_per_1m: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileUpdatePayload {
    pub id: i64,
    pub name: Option<String>,
    pub provider: Option<String>,
    pub api_url: Option<String>,
    pub model_name: Option<String>,
    /// When present, rewrites the keyring entry. Pass empty string to
    /// clear it, omit (None) to leave it alone.
    pub api_key: Option<String>,
    pub is_default: Option<bool>,
    pub cost_input_per_1m: Option<f64>,
    pub cost_output_per_1m: Option<f64>,
}

/// Response of `provider_profile_secret_get` — used by the UI just
/// before applying a profile so it can populate the live preferences
/// store without ever persisting the plaintext key client-side.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileSecret {
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileIdPayload {
    pub id: i64,
}

// ------------------------------------------------------------
// Phase 10: LLM call log + stats
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCallLogPayload {
    pub profile_id: Option<i64>,
    pub use_case: String,
    pub chapter_id: Option<i64>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub estimated_cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub success: bool,
    pub error_message: Option<String>,
}

// ------------------------------------------------------------
// AI Chat (per-project chat history + agentic web fetch tool)
// ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub id: i64,
    /// `user`, `assistant`, `tool`, `system`.
    pub role: String,
    pub content: String,
    /// JSON array of tool_calls when present (assistant turns).
    pub tool_calls: Option<String>,
    /// Set on tool rows — matching assistant tool_call.id.
    pub tool_call_id: Option<String>,
    /// `provider:model` that produced an assistant turn.
    pub model: Option<String>,
    /// JSON array `[{dataUrl, mimeType, width, height}]` of images
    /// attached to this turn. NULL when no attachments.
    pub attachments: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatListPayload {
    /// Max rows to return; default 50, max 1000.
    pub limit: Option<u32>,
    /// Page back through history: pass the smallest id in the current
    /// page to fetch the page before it. None = newest page.
    pub before_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageAddPayload {
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub model: Option<String>,
    pub attachments: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatClearResult {
    pub removed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchPayload {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    /// Final URL after redirects.
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub title: Option<String>,
    /// HTML-stripped text (or raw body for non-HTML).
    pub text: String,
    /// True if the response exceeded the byte cap and `text` is partial.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostByProfile {
    pub profile_id: i64,
    pub profile_name: String,
    pub provider: String,
    pub total_calls: i64,
    pub successful_calls: i64,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostByChapter {
    pub chapter_id: i64,
    pub chapter_title: String,
    pub chapter_number: f64,
    pub total_calls: i64,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostByDay {
    /// "YYYY-MM-DD" UTC.
    pub day: String,
    pub total_calls: i64,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostByUseCase {
    pub use_case: String,
    pub total_calls: i64,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostBreakdown {
    pub by_profile: Vec<LlmCostByProfile>,
    pub by_chapter: Vec<LlmCostByChapter>,
    pub by_day: Vec<LlmCostByDay>,
    pub by_use_case: Vec<LlmCostByUseCase>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostStats {
    pub total_calls: i64,
    pub successful_calls: i64,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
    pub total_cost_usd: f64,
}

#[cfg(test)]
mod tests {
    use koharu_types::{TextAlign, TextStyle};
    use serde::Serialize;
    use serde::de::DeserializeOwned;

    use super::*;

    fn round_trip<T>(value: &T)
    where
        T: Serialize + DeserializeOwned,
    {
        let encoded = serde_json::to_vec(value).expect("serialize");
        let decoded: T = serde_json::from_slice(&encoded).expect("deserialize");
        let original = serde_json::to_value(value).expect("serialize to value");
        let restored = serde_json::to_value(decoded).expect("serialize decoded to value");
        assert_eq!(original, restored);
    }

    #[test]
    fn command_dtos_round_trip() {
        let text_block = TextBlock {
            x: 10.0,
            y: 11.0,
            width: 120.0,
            height: 40.0,
            confidence: 0.95,
            text: Some("source".to_string()),
            translation: Some("translated".to_string()),
            style: Some(TextStyle {
                font_families: vec!["Noto Sans".to_string()],
                font_size: Some(18.0),
                color: [255, 255, 255, 255],
                effect: Some(TextShaderEffect {
                    italic: true,
                    bold: false,
                }),
                stroke: Some(TextStrokeStyle {
                    enabled: true,
                    color: [255, 255, 255, 255],
                    width_px: Some(2.0),
                }),
                text_align: Some(TextAlign::Right),
                line_height: None,
                letter_spacing_px: None,
                min_font_size: None,
                vertical_align: None,
            }),
            ..Default::default()
        };

        round_trip(&DeviceInfo {
            ml_device: "CPU".to_string(),
        });
        round_trip(&OpenExternalPayload {
            url: "https://example.com".to_string(),
        });
        round_trip(&IndexPayload { index: 2 });
        round_trip(&ThumbnailResult {
            data: vec![1, 2, 3],
            content_type: "image/webp".to_string(),
        });
        round_trip(&FileEntry {
            name: "page.png".to_string(),
            data: vec![7, 8, 9],
        });
        round_trip(&OpenDocumentsPayload {
            files: vec![FileEntry {
                name: "page.png".to_string(),
                data: vec![7, 8, 9],
            }],
        });
        round_trip(&FileResult {
            filename: "page_koharu.png".to_string(),
            data: vec![1, 2, 3, 4],
            content_type: "image/png".to_string(),
        });
        round_trip(&RenderPayload {
            index: 1,
            text_block_index: Some(3),
            shader_effect: Some(TextShaderEffect {
                italic: false,
                bold: true,
            }),
            shader_stroke: Some(TextStrokeStyle {
                enabled: true,
                color: [255, 255, 255, 255],
                width_px: Some(1.6),
            }),
            font_family: Some("Noto Sans".to_string()),
        });
        round_trip(&UpdateTextBlocksPayload {
            index: 1,
            text_blocks: vec![text_block.clone()],
        });
        round_trip(&LlmListPayload {
            language: Some("zh-CN".to_string()),
        });
        round_trip(&LlmLoadPayload {
            id: "sakura".to_string(),
        });
        round_trip(&LlmGeneratePayload {
            index: 1,
            text_block_index: Some(0),
            language: Some("zh-CN".to_string()),
        });
        round_trip(&LlmLoadParams {
            id: "sakura".to_string(),
        });
        round_trip(&LlmGenerateParams {
            index: 1,
            text_block_index: Some(0),
            language: Some("zh-CN".to_string()),
        });
        round_trip(&ProcessRequest {
            index: Some(1),
            llm_model_id: Some("sakura".to_string()),
            language: Some("zh-CN".to_string()),
            shader_effect: Some(TextShaderEffect {
                italic: true,
                bold: true,
            }),
            shader_stroke: Some(TextStrokeStyle {
                enabled: false,
                color: [255, 255, 255, 255],
                width_px: Some(2.0),
            }),
            font_family: Some("Noto Sans".to_string()),
        });
        round_trip(&InpaintRegion {
            x: 10,
            y: 20,
            width: 30,
            height: 40,
        });
        round_trip(&UpdateInpaintMaskPayload {
            index: 1,
            mask: vec![0, 255],
            region: Some(InpaintRegion {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }),
        });
        round_trip(&UpdateBrushLayerPayload {
            index: 1,
            patch: vec![1, 2, 3],
            region: InpaintRegion {
                x: 4,
                y: 5,
                width: 6,
                height: 7,
            },
        });
        round_trip(&InpaintPartialPayload {
            index: 1,
            region: InpaintRegion {
                x: 8,
                y: 9,
                width: 10,
                height: 11,
            },
        });
        round_trip(&ViewImageParams {
            index: 1,
            layer: "original".to_string(),
            max_size: Some(512),
        });
        round_trip(&ViewTextBlockParams {
            index: 1,
            text_block_index: 0,
            layer: Some("rendered".to_string()),
        });
        round_trip(&OpenDocumentsParams {
            paths: vec!["a.png".to_string(), "b.png".to_string()],
        });
        round_trip(&ExportDocumentParams {
            index: 1,
            output_path: "out.png".to_string(),
        });
        round_trip(&RenderParams {
            index: 1,
            text_block_index: Some(0),
            shader_effect: Some("bold".to_string()),
            font_family: Some("Noto Sans".to_string()),
        });
        round_trip(&ProcessParams {
            index: Some(1),
            llm_model_id: Some("sakura".to_string()),
            language: Some("zh-CN".to_string()),
            shader_effect: Some("italic,bold".to_string()),
            font_family: Some("Noto Sans".to_string()),
        });
        round_trip(&UpdateTextBlockPayload {
            index: 1,
            text_block_index: 0,
            translation: Some("translated".to_string()),
            x: Some(1.0),
            y: Some(2.0),
            width: Some(3.0),
            height: Some(4.0),
            font_families: Some(vec!["Noto Sans".to_string()]),
            font_size: Some(16.0),
            color: Some("#ffffff".to_string()),
            shader_effect: Some("italic,bold".to_string()),
            rotation_deg: Some(0.0),
        });
        round_trip(&AddTextBlockPayload {
            index: 1,
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        });
        round_trip(&RemoveTextBlockPayload {
            index: 1,
            text_block_index: 0,
        });
        round_trip(&MaskMorphPayload {
            index: 1,
            radius: 2,
        });
        round_trip(&InpaintRegionParams {
            index: 1,
            x: 2,
            y: 3,
            width: 4,
            height: 5,
        });
    }
}

// ── Translation queue ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueEnqueuePayload {
    /// `chapters.id` to translate. The entry runs as soon as the
    /// worker reaches it (after any earlier pending entries).
    pub chapter_id: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueIdPayload {
    /// `translation_queue.id` of the entry to act on (cancel etc.).
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryDto {
    pub id: i64,
    pub chapter_id: i64,
    pub status: String,
    pub total_pages: i64,
    pub done_pages: i64,
    pub error_message: Option<String>,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueClearResult {
    /// Number of finished (completed/failed/cancelled) entries removed.
    pub removed: usize,
}

