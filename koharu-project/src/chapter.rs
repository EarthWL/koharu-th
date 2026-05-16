//! Chapter index CRUD.

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, OptionalExtension};

use crate::db::Conn;
use crate::error::Result;
use crate::types::{Chapter, ChapterStatus};

#[derive(Debug, Clone)]
pub struct ChapterInsert {
    pub file_path: String,
    pub chapter_number: f64,
    pub title: Option<String>,
    pub volume: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct ChapterPatch {
    pub chapter_number: Option<f64>,
    pub title: Option<Option<String>>,
    pub volume: Option<Option<i64>>,
    pub status: Option<ChapterStatus>,
    pub summary: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    pub page_count: Option<i64>,
}

pub fn list(conn: &Conn) -> Result<Vec<Chapter>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_path, chapter_number, title, volume, status,
                summary, notes, page_count, created_at, updated_at
         FROM chapters
         ORDER BY chapter_number ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_chapter)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<Chapter>> {
    let row = conn
        .query_row(
            "SELECT id, file_path, chapter_number, title, volume, status,
                    summary, notes, page_count, created_at, updated_at
             FROM chapters WHERE id = ?1",
            params![id],
            row_to_chapter,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(conn: &Conn, item: ChapterInsert) -> Result<Chapter> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO chapters
            (file_path, chapter_number, title, volume, status,
             page_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)",
        params![
            item.file_path,
            item.chapter_number,
            item.title,
            item.volume,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("just inserted row"))
}

pub fn update(conn: &Conn, id: i64, patch: ChapterPatch) -> Result<Option<Chapter>> {
    let now = Utc::now().timestamp();
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(v) = patch.chapter_number {
        sets.push("chapter_number = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.title {
        sets.push("title = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.volume {
        sets.push("volume = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.status {
        sets.push("status = ?");
        values.push(v.as_str().to_string().into());
    }
    if let Some(v) = patch.summary {
        sets.push("summary = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.notes {
        sets.push("notes = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.page_count {
        sets.push("page_count = ?");
        values.push(v.into());
    }

    if sets.is_empty() {
        return get(conn, id);
    }

    sets.push("updated_at = ?");
    values.push(now.into());
    values.push(id.into());

    let sql = format!(
        "UPDATE chapters SET {} WHERE id = ?",
        sets.join(", ")
    );
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

pub fn remove(conn: &Conn, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM chapters WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

fn row_to_chapter(r: &rusqlite::Row<'_>) -> rusqlite::Result<Chapter> {
    let status_str: String = r.get(5)?;
    Ok(Chapter {
        id: r.get(0)?,
        file_path: r.get(1)?,
        chapter_number: r.get(2)?,
        title: r.get(3)?,
        volume: r.get(4)?,
        status: ChapterStatus::parse(&status_str).unwrap_or(ChapterStatus::Pending),
        summary: r.get(6)?,
        notes: r.get(7)?,
        page_count: r.get(8)?,
        created_at: ts_to_utc(r.get(9)?),
        updated_at: ts_to_utc(r.get(10)?),
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

    #[test]
    fn chapter_crud_round_trip() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0.0.0").unwrap();
        let conn = p.pool().get().unwrap();

        assert!(list(&conn).unwrap().is_empty());

        let inserted = insert(
            &conn,
            ChapterInsert {
                file_path: "chapters/ch01.khr".into(),
                chapter_number: 1.0,
                title: Some("The Beginning".into()),
                volume: Some(1),
            },
        )
        .unwrap();
        assert_eq!(inserted.title.as_deref(), Some("The Beginning"));
        assert_eq!(inserted.status, ChapterStatus::Pending);

        let updated = update(
            &conn,
            inserted.id,
            ChapterPatch {
                status: Some(ChapterStatus::Translated),
                summary: Some(Some("Kenta meets Sato".into())),
                page_count: Some(22),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.status, ChapterStatus::Translated);
        assert_eq!(updated.summary.as_deref(), Some("Kenta meets Sato"));
        assert_eq!(updated.page_count, 22);

        // Insert another chapter and verify ordering by chapter_number.
        let _ = insert(
            &conn,
            ChapterInsert {
                file_path: "chapters/ch00.khr".into(),
                chapter_number: 0.5,
                title: Some("Prologue".into()),
                volume: Some(1),
            },
        )
        .unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].chapter_number, 0.5);
        assert_eq!(all[1].chapter_number, 1.0);

        assert!(remove(&conn, inserted.id).unwrap());
        assert!(!remove(&conn, inserted.id).unwrap());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
