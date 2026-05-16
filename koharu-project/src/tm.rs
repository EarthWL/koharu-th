//! Translation memory: cache prior translations keyed by source-text
//! hash so identical bubbles don't re-hit the LLM.

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Conn;
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmEntry {
    pub id: i64,
    pub source_text: String,
    pub source_hash: String,
    pub target_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub chapter_id: Option<i64>,
    pub page_index: Option<i64>,
    pub text_block_index: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub prompt_template_id: Option<i64>,
    pub quality_rating: Option<i64>,
    pub is_approved: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct TmInsert {
    pub source_text: String,
    pub target_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub chapter_id: Option<i64>,
    pub page_index: Option<i64>,
    pub text_block_index: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub prompt_template_id: Option<i64>,
}

/// Stable hash for TM lookup. Same source text → same hex string across
/// runs / machines (it's just SHA-256 of the UTF-8 bytes).
pub fn hash_source(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Look up an exact-match translation. `target_lang` must match because
/// the same source can have different translations per language.
pub fn lookup_exact(
    conn: &Conn,
    source_text: &str,
    target_lang: &str,
) -> Result<Option<TmEntry>> {
    let hash = hash_source(source_text);
    let row = conn
        .query_row(
            "SELECT id, source_text, source_hash, target_text, source_lang,
                    target_lang, chapter_id, page_index, text_block_index,
                    provider, model, prompt_template_id, quality_rating,
                    is_approved, created_at
             FROM translation_memory
             WHERE source_hash = ?1 AND target_lang = ?2
             ORDER BY is_approved DESC, created_at DESC
             LIMIT 1",
            params![hash, target_lang],
            row_to_entry,
        )
        .optional()?;
    Ok(row)
}

/// Insert a new TM entry. If an exact (source_hash, target_lang) entry
/// already exists this is a no-op (returns the existing row).
pub fn insert(conn: &Conn, item: TmInsert) -> Result<TmEntry> {
    if let Some(existing) = lookup_exact(conn, &item.source_text, &item.target_lang)? {
        return Ok(existing);
    }
    let now = Utc::now().timestamp();
    let hash = hash_source(&item.source_text);
    conn.execute(
        "INSERT INTO translation_memory
            (source_text, source_hash, target_text, source_lang, target_lang,
             chapter_id, page_index, text_block_index, provider, model,
             prompt_template_id, quality_rating, is_approved, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, 0, ?12)",
        params![
            item.source_text,
            hash,
            item.target_text,
            item.source_lang,
            item.target_lang,
            item.chapter_id,
            item.page_index,
            item.text_block_index,
            item.provider,
            item.model,
            item.prompt_template_id,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(conn
        .query_row(
            "SELECT id, source_text, source_hash, target_text, source_lang,
                    target_lang, chapter_id, page_index, text_block_index,
                    provider, model, prompt_template_id, quality_rating,
                    is_approved, created_at
             FROM translation_memory WHERE id = ?1",
            params![id],
            row_to_entry,
        )
        .expect("just inserted"))
}

pub fn approve(conn: &Conn, id: i64, approved: bool) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE translation_memory SET is_approved = ?1 WHERE id = ?2",
        params![if approved { 1 } else { 0 }, id],
    )?;
    Ok(changed > 0)
}

pub fn remove(conn: &Conn, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM translation_memory WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

/// Aggregate counts for the project dashboard.
pub fn count(conn: &Conn) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM translation_memory", [], |r| r.get(0))?)
}

/// Fuzzy-match `source_text` against TM. Returns the best candidate
/// over `min_similarity` (0.0..1.0) or None.
///
/// Two-stage search:
///   1. tm_fts MATCH narrows down to top-K candidates by word-overlap
///      (FTS5's bm25 ranking).
///   2. We re-score each candidate with a character-bigram Jaccard
///      similarity against the live source. This is cheap O(n) and
///      handles partial-text edits much better than word overlap alone
///      (which is useless for CJK that has no word delimiters).
///
/// Returns (entry, similarity) so callers can show "♻️ 87% match"
/// indicators.
pub fn lookup_fuzzy(
    conn: &Conn,
    source_text: &str,
    target_lang: &str,
    min_similarity: f32,
) -> Result<Option<(TmEntry, f32)>> {
    let trimmed = source_text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    // FTS5 MATCH wants safe tokens — escape double-quotes and wrap in
    // quotes so phrase queries with arbitrary chars don't blow up.
    let safe = trimmed.replace('"', "\"\"");
    let match_q = format!("\"{safe}\"");

    let mut stmt = conn.prepare(
        "SELECT tm.id, tm.source_text, tm.source_hash, tm.target_text,
                tm.source_lang, tm.target_lang, tm.chapter_id, tm.page_index,
                tm.text_block_index, tm.provider, tm.model,
                tm.prompt_template_id, tm.quality_rating, tm.is_approved,
                tm.created_at
         FROM tm_fts
         JOIN translation_memory tm ON tm.id = tm_fts.rowid
         WHERE tm_fts MATCH ?1
           AND tm.target_lang = ?2
         ORDER BY bm25(tm_fts) ASC
         LIMIT 8",
    )?;
    let candidates: Vec<TmEntry> = stmt
        .query_map(params![match_q, target_lang], row_to_entry)?
        .collect::<rusqlite::Result<_>>()?;

    let mut best: Option<(TmEntry, f32)> = None;
    for entry in candidates {
        let sim = bigram_jaccard(trimmed, entry.source_text.trim());
        if sim >= min_similarity {
            match &best {
                Some((_, s)) if *s >= sim => {}
                _ => best = Some((entry, sim)),
            }
        }
    }
    Ok(best)
}

/// Character-bigram Jaccard similarity. Handles CJK / Thai without word
/// segmentation since it operates on character pairs directly.
fn bigram_jaccard(a: &str, b: &str) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let bigrams = |s: &str| -> std::collections::HashSet<(char, char)> {
        let chars: Vec<char> = s.chars().collect();
        if chars.len() < 2 {
            return std::collections::HashSet::new();
        }
        chars
            .windows(2)
            .map(|w| (w[0], w[1]))
            .collect::<std::collections::HashSet<_>>()
    };
    let ba = bigrams(a);
    let bb = bigrams(b);
    if ba.is_empty() && bb.is_empty() {
        // Two single-char strings — fall back to char equality.
        let ca = a.chars().next();
        let cb = b.chars().next();
        return if ca == cb && ca.is_some() { 1.0 } else { 0.0 };
    }
    let inter = ba.intersection(&bb).count() as f32;
    let union = ba.union(&bb).count() as f32;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn row_to_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<TmEntry> {
    let approved_int: i64 = r.get(13)?;
    Ok(TmEntry {
        id: r.get(0)?,
        source_text: r.get(1)?,
        source_hash: r.get(2)?,
        target_text: r.get(3)?,
        source_lang: r.get(4)?,
        target_lang: r.get(5)?,
        chapter_id: r.get(6)?,
        page_index: r.get(7)?,
        text_block_index: r.get(8)?,
        provider: r.get(9)?,
        model: r.get(10)?,
        prompt_template_id: r.get(11)?,
        quality_rating: r.get(12)?,
        is_approved: approved_int != 0,
        created_at: Utc.timestamp_opt(r.get(14)?, 0).single().unwrap_or_else(Utc::now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use tempfile::tempdir;

    #[test]
    fn insert_and_lookup_exact_then_dedupes() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        assert!(lookup_exact(&conn, "行くぞ!", "th").unwrap().is_none());

        let inserted = insert(
            &conn,
            TmInsert {
                source_text: "行くぞ!".into(),
                target_text: "ไปกันเถอะ!".into(),
                source_lang: "ja".into(),
                target_lang: "th".into(),
                chapter_id: None,
                page_index: None,
                text_block_index: None,
                provider: Some("openrouter".into()),
                model: Some("anthropic/claude-3.5-sonnet".into()),
                prompt_template_id: None,
            },
        )
        .unwrap();

        let hit = lookup_exact(&conn, "行くぞ!", "th").unwrap().unwrap();
        assert_eq!(hit.id, inserted.id);
        assert_eq!(hit.target_text, "ไปกันเถอะ!");

        // Different language → no hit.
        assert!(lookup_exact(&conn, "行くぞ!", "en").unwrap().is_none());

        // Inserting the same source twice doesn't duplicate.
        let second = insert(
            &conn,
            TmInsert {
                source_text: "行くぞ!".into(),
                target_text: "Let's go!".into(),
                source_lang: "ja".into(),
                target_lang: "th".into(), // same target lang triggers dedupe
                chapter_id: None,
                page_index: None,
                text_block_index: None,
                provider: None,
                model: None,
                prompt_template_id: None,
            },
        )
        .unwrap();
        assert_eq!(second.id, inserted.id);
        assert_eq!(count(&conn).unwrap(), 1);
    }

    fn seed(conn: &Conn, src: &str, tgt: &str) {
        insert(
            conn,
            TmInsert {
                source_text: src.into(),
                target_text: tgt.into(),
                source_lang: "ja".into(),
                target_lang: "th".into(),
                chapter_id: None,
                page_index: None,
                text_block_index: None,
                provider: None,
                model: None,
                prompt_template_id: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn fuzzy_lookup_catches_near_duplicates() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        seed(&conn, "今日はいい天気ですね", "วันนี้อากาศดีนะ");
        seed(&conn, "おはようございます", "อรุณสวัสดิ์");
        seed(&conn, "ありがとうございました", "ขอบคุณมาก");

        // Exact match — not via fuzzy (would also hit exact, that's fine).
        let exact = lookup_fuzzy(&conn, "今日はいい天気ですね", "th", 0.5).unwrap();
        assert!(exact.is_some());
        assert_eq!(exact.as_ref().unwrap().1, 1.0);

        // Near-miss with trailing punctuation change.
        let near = lookup_fuzzy(&conn, "今日はいい天気ですね。", "th", 0.7).unwrap();
        assert!(near.is_some(), "should fuzzy-match with high similarity");
        let (entry, sim) = near.unwrap();
        assert_eq!(entry.target_text, "วันนี้อากาศดีนะ");
        assert!(sim >= 0.7, "expected sim >= 0.7, got {sim}");

        // Totally different text → no hit even at low threshold.
        let none = lookup_fuzzy(&conn, "全然違うテキスト", "th", 0.5).unwrap();
        assert!(none.is_none());

        // Wrong target lang → no hit.
        let other_lang =
            lookup_fuzzy(&conn, "今日はいい天気ですね", "en", 0.5).unwrap();
        assert!(other_lang.is_none());
    }
}
