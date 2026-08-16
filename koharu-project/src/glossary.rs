//! Glossary CRUD plus the smart-filter helper used by Phase 5.

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};

use crate::db::Conn;
use crate::error::Result;
use crate::types::{Confidence, GlossaryCategory, GlossaryEntry};

#[derive(Debug, Clone)]
pub struct GlossaryInsert {
    pub source_text: String,
    pub target_text: String,
    pub category: GlossaryCategory,
    pub aliases: Vec<String>,
    pub context_note: Option<String>,
    pub first_appearance_chapter_id: Option<i64>,
    pub confidence: Confidence,
    pub approved: bool,
}

#[derive(Debug, Default, Clone)]
pub struct GlossaryPatch {
    pub source_text: Option<String>,
    pub target_text: Option<String>,
    pub category: Option<GlossaryCategory>,
    pub aliases: Option<Vec<String>>,
    pub context_note: Option<Option<String>>,
    pub first_appearance_chapter_id: Option<Option<i64>>,
    pub confidence: Option<Confidence>,
    pub approved: Option<bool>,
}

pub fn list(conn: &Conn) -> Result<Vec<GlossaryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_text, target_text, category, aliases, context_note,
                first_appearance_chapter_id, usage_count, confidence, approved,
                created_at, updated_at
         FROM glossary
         ORDER BY category ASC, source_text ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_entry)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<GlossaryEntry>> {
    let row = conn
        .query_row(
            "SELECT id, source_text, target_text, category, aliases, context_note,
                    first_appearance_chapter_id, usage_count, confidence, approved,
                    created_at, updated_at
             FROM glossary WHERE id = ?1",
            params![id],
            row_to_entry,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(conn: &Conn, item: GlossaryInsert) -> Result<GlossaryEntry> {
    let now = Utc::now().timestamp();
    let aliases_json = serde_json::to_string(&item.aliases).unwrap_or("[]".into());
    conn.execute(
        "INSERT INTO glossary
            (source_text, target_text, category, aliases, context_note,
             first_appearance_chapter_id, usage_count, confidence, approved,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?9)",
        params![
            item.source_text,
            item.target_text,
            item.category.as_str(),
            aliases_json,
            item.context_note,
            item.first_appearance_chapter_id,
            item.confidence.as_str(),
            if item.approved { 1 } else { 0 },
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)?
        .ok_or_else(|| crate::error::Error::NotFound(format!("glossary entry id={id} after insert")))
}

pub fn update(conn: &Conn, id: i64, patch: GlossaryPatch) -> Result<Option<GlossaryEntry>> {
    let now = Utc::now().timestamp();
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(v) = patch.source_text {
        sets.push("source_text = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.target_text {
        sets.push("target_text = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.category {
        sets.push("category = ?");
        values.push(v.as_str().to_string().into());
    }
    if let Some(v) = patch.aliases {
        sets.push("aliases = ?");
        values.push(serde_json::to_string(&v).unwrap_or("[]".into()).into());
    }
    if let Some(v) = patch.context_note {
        sets.push("context_note = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.first_appearance_chapter_id {
        sets.push("first_appearance_chapter_id = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.confidence {
        sets.push("confidence = ?");
        values.push(v.as_str().to_string().into());
    }
    if let Some(v) = patch.approved {
        sets.push("approved = ?");
        values.push((if v { 1 } else { 0 }).into());
    }

    if sets.is_empty() {
        return get(conn, id);
    }
    sets.push("updated_at = ?");
    values.push(now.into());
    values.push(id.into());

    let sql = format!("UPDATE glossary SET {} WHERE id = ?", sets.join(", "));
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

pub fn remove(conn: &Conn, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM glossary WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

/// Bulk-import glossary entries in a single transaction. Returns
/// `(inserted, skipped)` where `skipped` counts rows that collided with
/// an existing (source_text, category) pair (the unique index on
/// `idx_glossary_source`).
///
/// Each item is best-effort: a single bad row doesn't abort the whole
/// batch — it just gets counted under `skipped`.
pub fn bulk_insert(conn: &mut Conn, items: Vec<GlossaryInsert>) -> Result<(usize, usize)> {
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let now = Utc::now().timestamp();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO glossary
                (source_text, target_text, category, aliases, context_note,
                 first_appearance_chapter_id, usage_count, confidence, approved,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?9)",
        )?;
        for item in items {
            let aliases_json = serde_json::to_string(&item.aliases).unwrap_or("[]".into());
            let changed = stmt.execute(params![
                item.source_text,
                item.target_text,
                item.category.as_str(),
                aliases_json,
                item.context_note,
                item.first_appearance_chapter_id,
                item.confidence.as_str(),
                if item.approved { 1 } else { 0 },
                now,
            ])?;
            if changed > 0 {
                inserted += 1;
            } else {
                skipped += 1;
            }
        }
    }
    tx.commit()?;
    Ok((inserted, skipped))
}

/// Bump `usage_count` for a list of glossary entries. Called after a
/// prompt that injected those entries is sent successfully.
pub fn bump_usage(conn: &Conn, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut stmt =
        conn.prepare("UPDATE glossary SET usage_count = usage_count + 1 WHERE id = ?1")?;
    for id in ids {
        stmt.execute(params![id])?;
    }
    Ok(())
}

/// Return the subset of `entries` whose source_text (or any alias) appears
/// as a substring of `page_text`. Substring is intentional rather than
/// word-boundary because CJK + Thai have no word separators.
pub fn filter_for_text<'a>(
    entries: &'a [GlossaryEntry],
    page_text: &str,
) -> Vec<&'a GlossaryEntry> {
    entries
        .iter()
        .filter(|e| {
            if page_text.contains(&e.source_text) {
                return true;
            }
            e.aliases.iter().any(|a| page_text.contains(a))
        })
        .collect()
}

fn row_to_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<GlossaryEntry> {
    let aliases_json: Option<String> = r.get(4)?;
    let aliases = aliases_json
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    let category_str: String = r.get(3)?;
    let confidence_str: String = r.get(8)?;
    let approved_int: i64 = r.get(9)?;
    Ok(GlossaryEntry {
        id: r.get(0)?,
        source_text: r.get(1)?,
        target_text: r.get(2)?,
        category: GlossaryCategory::parse(&category_str).unwrap_or(GlossaryCategory::Term),
        aliases,
        context_note: r.get(5)?,
        first_appearance_chapter_id: r.get(6)?,
        usage_count: r.get(7)?,
        confidence: match confidence_str.as_str() {
            "extracted" => Confidence::Extracted,
            "auto" => Confidence::Auto,
            _ => Confidence::Manual,
        },
        approved: approved_int != 0,
        created_at: ts_to_utc(r.get(10)?),
        updated_at: ts_to_utc(r.get(11)?),
    })
}

fn ts_to_utc(ts: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(ts, 0).single().unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use tempfile::tempdir;

    fn insert_simple(
        conn: &Conn,
        src: &str,
        tgt: &str,
        aliases: Vec<String>,
        category: GlossaryCategory,
    ) -> GlossaryEntry {
        insert(
            conn,
            GlossaryInsert {
                source_text: src.into(),
                target_text: tgt.into(),
                category,
                aliases,
                context_note: None,
                first_appearance_chapter_id: None,
                confidence: Confidence::Manual,
                approved: true,
            },
        )
        .unwrap()
    }

    #[test]
    fn glossary_crud_round_trip() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        let _ = insert_simple(&conn, "魔法剣", "ดาบเวทย์", vec![], GlossaryCategory::Term);
        let g2 = insert_simple(
            &conn,
            "京都",
            "เกียวโต",
            vec!["京の都".into()],
            GlossaryCategory::Place,
        );

        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 2);

        let updated = update(
            &conn,
            g2.id,
            GlossaryPatch {
                target_text: Some("เคียวโตะ".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.target_text, "เคียวโตะ");

        assert!(remove(&conn, g2.id).unwrap());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn bulk_insert_dedupes_and_counts_skipped() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let mut conn = p.pool().get().unwrap();

        // Seed one entry so we can verify the dedup path.
        let _ = insert_simple(&conn, "京都", "เกียวโต", vec![], GlossaryCategory::Place);

        let items = vec![
            GlossaryInsert {
                source_text: "健太".into(),
                target_text: "เคนตะ".into(),
                category: GlossaryCategory::Term,
                aliases: vec![],
                context_note: None,
                first_appearance_chapter_id: None,
                confidence: Confidence::Manual,
                approved: true,
            },
            GlossaryInsert {
                source_text: "魔法剣".into(),
                target_text: "ดาบเวทย์".into(),
                category: GlossaryCategory::Term,
                aliases: vec![],
                context_note: None,
                first_appearance_chapter_id: None,
                confidence: Confidence::Manual,
                approved: true,
            },
            // Collides with the seeded 京都/place row → should be skipped.
            GlossaryInsert {
                source_text: "京都".into(),
                target_text: "Kyoto (duplicate)".into(),
                category: GlossaryCategory::Place,
                aliases: vec![],
                context_note: None,
                first_appearance_chapter_id: None,
                confidence: Confidence::Manual,
                approved: true,
            },
        ];
        let (ok, dup) = bulk_insert(&mut conn, items).unwrap();
        assert_eq!(ok, 2);
        assert_eq!(dup, 1);
        // Total is the seeded row plus the 2 new inserts.
        assert_eq!(list(&conn).unwrap().len(), 3);
    }

    #[test]
    fn filter_matches_source_and_aliases_and_bumps_usage() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        let _kenta = insert_simple(
            &conn,
            "健太",
            "เคนตะ",
            vec!["健ちゃん".into()],
            GlossaryCategory::Term,
        );
        let _sword = insert_simple(&conn, "魔法剣", "ดาบเวทย์", vec![], GlossaryCategory::Term);
        let _unused = insert_simple(&conn, "京都", "เกียวโต", vec![], GlossaryCategory::Place);

        let all = list(&conn).unwrap();
        let page = "健ちゃんが魔法剣を抜いた";
        let hits = filter_for_text(&all, page);
        let sources: Vec<&str> = hits.iter().map(|e| e.source_text.as_str()).collect();
        assert!(sources.contains(&"健太"), "alias 健ちゃん should hit 健太");
        assert!(sources.contains(&"魔法剣"));
        assert!(!sources.contains(&"京都"));

        let ids: Vec<i64> = hits.iter().map(|e| e.id).collect();
        bump_usage(&conn, &ids).unwrap();
        let after = list(&conn).unwrap();
        for e in &after {
            if ids.contains(&e.id) {
                assert_eq!(e.usage_count, 1);
            } else {
                assert_eq!(e.usage_count, 0);
            }
        }
    }
}
