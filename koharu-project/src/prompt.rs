//! Prompt template CRUD and rendering.
//!
//! Templates are Handlebars strings. Rendering takes a [`PromptContext`]
//! assembled from the project DB (series meta, main characters, filtered
//! glossary, rolling chapter summary) plus the source text to translate.
//!
//! Variables available in templates:
//! - `{{source}}`              — the raw text to translate
//! - `{{target_language}}`     — e.g. "Thai"
//! - `{{source_language}}`     — e.g. "Japanese"
//! - `{{series_title}}`        — title from series_meta
//! - `{{series_title_original}}` — original-script title, may be empty
//! - `{{series_synopsis}}`     — 2-3 sentence pitch
//! - `{{tone}}` / `{{formality}}` / `{{style_notes}}`
//! - `{{main_characters}}`     — pre-rendered list ("健太→เคนตะ ...")
//! - `{{filtered_glossary}}`   — pre-rendered list, only entries that
//!                               appear in `{{source}}`
//! - `{{rolling_summary}}`     — concatenated previous-chapter summaries
//!
//! The rendering is *strict-mode off*: unknown variables produce empty
//! strings rather than errors, so older templates keep working when new
//! vars are added.

use chrono::{DateTime, TimeZone, Utc};
use handlebars::Handlebars;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::db::Conn;
use crate::error::Result;
use crate::glossary;
use crate::types::{Character, GlossaryEntry, PromptTemplate, PromptUseCase, SeriesMeta};

/// Fully-resolved context fed to the Handlebars engine.
#[derive(Debug, Clone, Serialize)]
pub struct PromptContext {
    pub source: String,
    pub source_language: String,
    pub target_language: String,
    pub series_title: String,
    pub series_title_original: String,
    pub series_synopsis: String,
    pub tone: String,
    pub formality: String,
    pub style_notes: String,
    /// Pre-rendered "Name (role): speech-style" lines for main chars.
    pub main_characters: String,
    /// Pre-rendered "源 → 訳 (note)" lines for matched glossary entries.
    pub filtered_glossary: String,
    /// Rolling summary of the N previous chapters concatenated.
    pub rolling_summary: String,
    /// IDs of glossary entries that were filtered in. Caller uses this
    /// to call `glossary::bump_usage` after a successful translation.
    #[serde(skip)]
    pub glossary_hit_ids: Vec<i64>,
}

/// Build a [`PromptContext`] from project state and the current page text.
pub fn build_context(
    series: &SeriesMeta,
    main_characters: &[Character],
    glossary_entries: &[GlossaryEntry],
    rolling_summary: &str,
    source_text: &str,
) -> PromptContext {
    let hits = glossary::filter_for_text(glossary_entries, source_text);
    let glossary_hit_ids = hits.iter().map(|e| e.id).collect();

    let filtered_glossary = if hits.is_empty() {
        String::new()
    } else {
        hits.iter()
            .map(|e| {
                let note = e
                    .context_note
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(" ({s})"))
                    .unwrap_or_default();
                format!("- {} → {}{note}", e.source_text, e.target_text)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let main_characters_str = main_characters
        .iter()
        .map(|c| {
            let role = c.role.as_deref().unwrap_or("");
            let speech = c.speech_style.as_deref().unwrap_or("");
            let alias_part = if c.aliases.is_empty() {
                String::new()
            } else {
                let aliases = c
                    .aliases
                    .iter()
                    .map(|a| format!("{}→{}", a.src, a.tgt))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(" [aliases: {aliases}]")
            };
            let role_part = if role.is_empty() {
                String::new()
            } else {
                format!(" ({role})")
            };
            let speech_part = if speech.is_empty() {
                String::new()
            } else {
                format!(" — speech: {speech}")
            };
            format!(
                "- {} → {}{role_part}{speech_part}{alias_part}",
                c.original_name, c.translated_name
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    PromptContext {
        source: source_text.to_string(),
        source_language: map_lang_name(&series.source_language),
        target_language: map_lang_name(&series.target_language),
        series_title: series.title.clone(),
        series_title_original: series.title_original.clone().unwrap_or_default(),
        series_synopsis: series.synopsis.clone().unwrap_or_default(),
        tone: series.tone.clone().unwrap_or_default(),
        formality: series.formality_level.clone().unwrap_or_default(),
        style_notes: series.style_notes.clone().unwrap_or_default(),
        main_characters: main_characters_str,
        filtered_glossary,
        rolling_summary: rolling_summary.to_string(),
        glossary_hit_ids,
    }
}

fn map_lang_name(code: &str) -> String {
    match code.to_lowercase().as_str() {
        "th" | "tha" => "Thai".to_string(),
        "en" | "eng" => "English".to_string(),
        "ja" | "jpn" | "jp" => "Japanese".to_string(),
        "zh" | "zho" | "chi" | "cn" => "Chinese".to_string(),
        "ko" | "kor" => "Korean".to_string(),
        "fr" | "fra" | "fre" => "French".to_string(),
        "de" | "deu" | "ger" => "German".to_string(),
        "es" | "spa" => "Spanish".to_string(),
        "ru" | "rus" => "Russian".to_string(),
        "it" | "ita" => "Italian".to_string(),
        "pt" | "por" => "Portuguese".to_string(),
        "vi" | "vie" => "Vietnamese".to_string(),
        "id" | "ind" => "Indonesian".to_string(),
        _ => {
            if code.len() > 3 {
                let mut chars = code.chars();
                match chars.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                }
            } else {
                code.to_string()
            }
        }
    }
}

/// Render a template string with the given context. Unknown variables
/// resolve to empty strings (non-strict mode) so older templates keep
/// working when new vars are added.
pub fn render_template(template: &str, ctx: &PromptContext) -> Result<String> {
    let mut hb = Handlebars::new();
    hb.set_strict_mode(false);
    let rendered =
        hb.render_template(template, ctx)
            .map_err(|e| crate::error::Error::InvalidManifest {
                // Reuse InvalidManifest variant generically; rendering errors
                // are user-facing config problems, not infra failures.
                path: Default::default(),
                reason: format!("template render failed: {e}"),
            })?;
    Ok(rendered)
}

// -----------------------------------------------------------
// CRUD
// -----------------------------------------------------------

pub fn list(conn: &Conn) -> Result<Vec<PromptTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, is_default, use_case, template,
                created_at, updated_at
         FROM prompt_templates
         ORDER BY use_case ASC, is_default DESC, name ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_template)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<PromptTemplate>> {
    let row = conn
        .query_row(
            "SELECT id, name, description, is_default, use_case, template,
                    created_at, updated_at
             FROM prompt_templates WHERE id = ?1",
            params![id],
            row_to_template,
        )
        .optional()?;
    Ok(row)
}

pub fn get_by_name(conn: &Conn, name: &str) -> Result<Option<PromptTemplate>> {
    let row = conn
        .query_row(
            "SELECT id, name, description, is_default, use_case, template,
                    created_at, updated_at
             FROM prompt_templates WHERE name = ?1",
            params![name],
            row_to_template,
        )
        .optional()?;
    Ok(row)
}

/// Resolve the default template for a use case, falling back to *any*
/// template for that use case if none is marked default.
pub fn default_for(conn: &Conn, use_case: PromptUseCase) -> Result<Option<PromptTemplate>> {
    let row = conn
        .query_row(
            "SELECT id, name, description, is_default, use_case, template,
                    created_at, updated_at
             FROM prompt_templates
             WHERE use_case = ?1
             ORDER BY is_default DESC, id ASC
             LIMIT 1",
            params![use_case.as_str()],
            row_to_template,
        )
        .optional()?;
    Ok(row)
}

pub struct PromptTemplateInsert {
    pub name: String,
    pub description: Option<String>,
    pub use_case: PromptUseCase,
    pub template: String,
    pub is_default: bool,
}

pub fn insert(conn: &Conn, item: PromptTemplateInsert) -> Result<PromptTemplate> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO prompt_templates
            (name, description, is_default, use_case, template,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            item.name,
            item.description,
            if item.is_default { 1 } else { 0 },
            item.use_case.as_str(),
            item.template,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("just inserted"))
}

#[derive(Default)]
pub struct PromptTemplatePatch {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub use_case: Option<PromptUseCase>,
    pub template: Option<String>,
    pub is_default: Option<bool>,
}

pub fn update(conn: &Conn, id: i64, patch: PromptTemplatePatch) -> Result<Option<PromptTemplate>> {
    let now = Utc::now().timestamp();
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(v) = patch.name {
        sets.push("name = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.description {
        sets.push("description = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.use_case {
        sets.push("use_case = ?");
        values.push(v.as_str().to_string().into());
    }
    if let Some(v) = patch.template {
        sets.push("template = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.is_default {
        sets.push("is_default = ?");
        values.push((if v { 1 } else { 0 }).into());
    }

    if sets.is_empty() {
        return get(conn, id);
    }
    sets.push("updated_at = ?");
    values.push(now.into());
    values.push(id.into());

    let sql = format!(
        "UPDATE prompt_templates SET {} WHERE id = ?",
        sets.join(", ")
    );
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

pub fn remove(conn: &Conn, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM prompt_templates WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

/// Seed the built-in default templates for a freshly created project.
/// Idempotent: skipped if a template with the same name already exists.
pub fn seed_defaults(conn: &Conn) -> Result<()> {
    for (name, description, use_case, body, is_default) in BUILTIN_TEMPLATES {
        if get_by_name(conn, name)?.is_some() {
            continue;
        }
        insert(
            conn,
            PromptTemplateInsert {
                name: (*name).into(),
                description: Some((*description).into()),
                use_case: *use_case,
                template: (*body).into(),
                is_default: *is_default,
            },
        )?;
    }
    Ok(())
}

/// Built-in templates installed on `Project::create`. The translate
/// template uses all the 3-layer context (always-on + filtered glossary
/// + rolling summary).
const BUILTIN_TEMPLATES: &[(&str, &str, PromptUseCase, &str, bool)] = &[
    (
        "manga-standard",
        "Standard manga translation with full 3-layer context.",
        PromptUseCase::Translate,
        r#"You are a professional manga translator. Translate the source text from {{source_language}} to {{target_language}}.

Series: {{series_title}}{{#if series_title_original}} ({{series_title_original}}){{/if}}
{{#if series_synopsis}}Synopsis: {{series_synopsis}}{{/if}}
{{#if tone}}Tone: {{tone}}{{/if}}{{#if formality}} · Formality: {{formality}}{{/if}}
{{#if style_notes}}Style notes: {{style_notes}}{{/if}}

{{#if main_characters}}Main characters:
{{main_characters}}{{/if}}

{{#if filtered_glossary}}Relevant glossary for this page:
{{filtered_glossary}}{{/if}}

{{#if rolling_summary}}Recent story so far:
{{rolling_summary}}{{/if}}

Translation guidelines:
- Output only the translation, no explanation.
- Match each character's established speech style and use the glossary terms exactly as listed.
- Preserve line breaks in the source.

Source:
{{source}}"#,
        true,
    ),
    (
        "manga-extract",
        "Ask the LLM to extract named entities from a chapter's translated text.",
        PromptUseCase::ExtractEntities,
        r#"You are helping build a glossary for a manga translation project.

Given the source text and its translation below, identify all named entities (character names, places, special terms, attack/skill names, organizations, honorifics, recurring sound effects).

Return ONLY a JSON array, no commentary. Each item: {"original": "<source form>", "translation": "<suggested translation in {{target_language}}>", "category": "character|place|term|skill|honorific|item|org|sfx"}.

Source:
{{source}}"#,
        true,
    ),
    (
        "manga-summarize",
        "Generate a 2-3 sentence chapter summary for rolling context.",
        PromptUseCase::SummarizeChapter,
        r#"Summarize the events of the following manga chapter in 2-3 sentences in {{target_language}}. Focus on plot beats and character developments that future chapters will reference.

Chapter text:
{{source}}"#,
        true,
    ),
];

fn row_to_template(r: &rusqlite::Row<'_>) -> rusqlite::Result<PromptTemplate> {
    let use_case_str: String = r.get(4)?;
    let is_default_int: i64 = r.get(3)?;
    Ok(PromptTemplate {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        is_default: is_default_int != 0,
        use_case: match use_case_str.as_str() {
            "extract_entities" => PromptUseCase::ExtractEntities,
            "summarize_chapter" => PromptUseCase::SummarizeChapter,
            _ => PromptUseCase::Translate,
        },
        template: r.get(5)?,
        created_at: ts_to_utc(r.get(6)?),
        updated_at: ts_to_utc(r.get(7)?),
    })
}

fn ts_to_utc(ts: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(ts, 0).single().unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Confidence, GlossaryCategory, NameAlias};
    use crate::{Project, character, glossary as gl_ops, series};
    use tempfile::tempdir;

    #[test]
    fn seed_then_render_full_context() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        seed_defaults(&conn).unwrap();
        let all = list(&conn).unwrap();
        assert!(all.iter().any(|t| t.name == "manga-standard"));
        assert!(all.iter().any(|t| t.name == "manga-extract"));
        assert!(all.iter().any(|t| t.name == "manga-summarize"));

        // re-seed is idempotent
        seed_defaults(&conn).unwrap();
        assert_eq!(list(&conn).unwrap().len(), all.len());

        // Add some series + chars + glossary so the rendered prompt is meaty.
        series::update(
            &conn,
            series::SeriesMetaPatch {
                synopsis: Some(Some("A young exorcist's tale.".into())),
                tone: Some(Some("casual".into())),
                ..Default::default()
            },
        )
        .unwrap();
        character::insert(
            &conn,
            character::CharacterInsert {
                original_name: "健太".into(),
                translated_name: "เคนตะ".into(),
                aliases: vec![NameAlias {
                    src: "健ちゃん".into(),
                    tgt: "เคนจัง".into(),
                }],
                role: Some("protagonist".into()),
                gender: None,
                age: None,
                speech_style: Some("polite".into()),
                personality: None,
                notes: None,
                is_main: true,
                sort_order: 0,
                first_appearance_chapter_id: None,
            },
        )
        .unwrap();
        gl_ops::insert(
            &conn,
            gl_ops::GlossaryInsert {
                source_text: "魔法剣".into(),
                target_text: "ดาบเวทย์".into(),
                category: GlossaryCategory::Term,
                aliases: vec![],
                context_note: None,
                first_appearance_chapter_id: None,
                confidence: Confidence::Manual,
                approved: true,
            },
        )
        .unwrap();
        gl_ops::insert(
            &conn,
            gl_ops::GlossaryInsert {
                source_text: "京都".into(),
                target_text: "เกียวโต".into(),
                category: GlossaryCategory::Place,
                aliases: vec![],
                context_note: None,
                first_appearance_chapter_id: None,
                confidence: Confidence::Manual,
                approved: true,
            },
        )
        .unwrap();

        let meta = series::get(&conn).unwrap();
        let chars = character::list(&conn).unwrap();
        let mains: Vec<_> = chars.into_iter().filter(|c| c.is_main).collect();
        let entries = gl_ops::list(&conn).unwrap();
        let page = "健ちゃんが魔法剣を抜いた";

        let ctx = build_context(&meta, &mains, &entries, "", page);
        assert_eq!(ctx.glossary_hit_ids.len(), 1, "only 魔法剣 should match");

        let template = get_by_name(&conn, "manga-standard").unwrap().unwrap();
        let rendered = render_template(&template.template, &ctx).unwrap();
        assert!(rendered.contains("Test"), "should contain series title");
        assert!(rendered.contains("健太 → เคนตะ"));
        assert!(rendered.contains("魔法剣 → ดาบเวทย์"));
        assert!(!rendered.contains("京都"), "non-matching entry stays out");
        assert!(rendered.contains(page));
    }
}
