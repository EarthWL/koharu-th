//! Chapter index CRUD.

use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, OptionalExtension};

use crate::db::Conn;
use crate::error::{Error, Result};
use crate::types::{Chapter, ChapterStatus};

/// Subfolder inside a chapter folder where user-uploaded originals live.
pub const SOURCE_SUBDIR: &str = "source";
/// Subfolder inside a chapter folder where rendered output is written.
pub const RENDER_SUBDIR: &str = "render";

/// File extensions we'll treat as page images.
pub const PAGE_EXTENSIONS: &[&str] = &["khr", "png", "jpg", "jpeg", "webp", "bmp"];

#[derive(Debug, Clone)]
pub struct ChapterInsert {
    /// Relative folder path inside the project, e.g. "chapters/ch01".
    pub folder_path: String,
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
        "SELECT id, folder_path, chapter_number, title, volume, status,
                summary, notes, page_count, created_at, updated_at
         FROM chapters
         WHERE folder_path IS NOT NULL
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
            "SELECT id, folder_path, chapter_number, title, volume, status,
                    summary, notes, page_count, created_at, updated_at
             FROM chapters WHERE id = ?1 AND folder_path IS NOT NULL",
            params![id],
            row_to_chapter,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(conn: &Conn, item: ChapterInsert) -> Result<Chapter> {
    let now = Utc::now().timestamp();
    // Auto-name the chapter from its number if no title was supplied,
    // matching the on-disk folder naming convention used by
    // `create_chapter_folder`.
    let auto_title = item.title.clone().unwrap_or_else(|| {
        let n = item.chapter_number;
        if (n.fract()).abs() < f64::EPSILON {
            format!("Chapter {}", n as i64)
        } else {
            format!("Chapter {n}")
        }
    });
    conn.execute(
        "INSERT INTO chapters
            (folder_path, chapter_number, title, volume, status,
             page_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)",
        params![
            item.folder_path,
            item.chapter_number,
            auto_title,
            item.volume,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("just inserted row"))
}

/// Snap an arbitrary chapter title into a filesystem-safe folder name.
pub fn folder_name_for(chapter_number: f64, title: Option<&str>) -> String {
    if let Some(t) = title {
        let cleaned: String = t
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                other => other,
            })
            .collect();
        let trimmed = cleaned.trim().trim_matches('.');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if (chapter_number.fract()).abs() < f64::EPSILON {
        format!("ch{:03}", chapter_number as i64)
    } else {
        format!("ch{:0>5.2}", chapter_number)
    }
}

/// Pick a folder name that doesn't collide with anything already in
/// `chapters_dir`. Appends "-2", "-3", ... if needed.
pub fn dedupe_folder_name(chapters_dir: &Path, base: &str) -> String {
    if !chapters_dir.join(base).exists() {
        return base.to_string()
    }
    for n in 2..=9999 {
        let cand = format!("{base}-{n}");
        if !chapters_dir.join(&cand).exists() {
            return cand;
        }
    }
    base.to_string()
}

/// Create `<chapters_dir>/<name>/source/` and `.../render/`, returning
/// the absolute path of the chapter root (`<chapters_dir>/<name>`).
pub fn create_chapter_folder(chapters_dir: &Path, name: &str) -> Result<PathBuf> {
    let root = chapters_dir.join(name);
    std::fs::create_dir_all(root.join(SOURCE_SUBDIR)).map_err(|e| Error::io(&root, e))?;
    std::fs::create_dir_all(root.join(RENDER_SUBDIR)).map_err(|e| Error::io(&root, e))?;
    Ok(root)
}

/// Enumerate the source page files inside a chapter folder. Returns
/// absolute paths sorted by filename.
pub fn list_source_pages(project_root: &Path, chapter: &Chapter) -> Result<Vec<PathBuf>> {
    let dir = project_root.join(&chapter.folder_path).join(SOURCE_SUBDIR);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(&dir, e)),
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            if let Some(ext) = ext {
                if PAGE_EXTENSIONS.iter().any(|valid| *valid == ext) {
                    return Some(p);
                }
            }
            None
        })
        .collect();
    paths.sort();
    Ok(paths)
}

/// Refresh `page_count` for the given chapter based on what's on disk.
pub fn refresh_page_count(
    conn: &Conn,
    project_root: &Path,
    chapter_id: i64,
) -> Result<i64> {
    let chapter = get(conn, chapter_id)?
        .ok_or_else(|| Error::InvalidManifest {
            path: Default::default(),
            reason: format!("chapter {chapter_id} not found"),
        })?;
    let pages = list_source_pages(project_root, &chapter)?;
    let count = pages.len() as i64;
    conn.execute(
        "UPDATE chapters SET page_count = ?1, updated_at = ?2 WHERE id = ?3",
        params![count, Utc::now().timestamp(), chapter_id],
    )?;
    Ok(count)
}

/// One-shot helper: scan for legacy rows where the `file_path` column
/// is set but `folder_path` is null (from V001 schema, where each
/// chapter was a single file). For each one, mint a folder, move the
/// file into `source/`, and update the row. Idempotent — safe to call
/// every Project::open.
pub fn ensure_folder_layout(conn: &mut Conn, project_root: &Path) -> Result<usize> {
    let chapters_dir = project_root.join("chapters");
    std::fs::create_dir_all(&chapters_dir).ok();

    let legacy: Vec<(i64, String, f64, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, file_path, chapter_number, title FROM chapters
             WHERE folder_path IS NULL AND file_path IS NOT NULL",
        )?;
        stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    if legacy.is_empty() {
        return Ok(0);
    }

    let mut migrated = 0;
    for (id, old_file_path, chapter_number, title) in legacy {
        let base = folder_name_for(chapter_number, title.as_deref());
        let dedup = dedupe_folder_name(&chapters_dir, &base);
        let root = create_chapter_folder(&chapters_dir, &dedup)?;
        let rel = format!("chapters/{dedup}");

        // Move old file into source/
        let old_abs = project_root.join(&old_file_path);
        if old_abs.exists() {
            let filename = old_abs
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "page-001".into());
            let dst = root.join(SOURCE_SUBDIR).join(&filename);
            if let Err(err) = std::fs::rename(&old_abs, &dst) {
                tracing::warn!(?err, ?old_abs, ?dst, "rename failed, trying copy");
                if let Err(err) = std::fs::copy(&old_abs, &dst) {
                    tracing::warn!(?err, "copy also failed; leaving legacy file in place");
                }
            }
        }

        conn.execute(
            "UPDATE chapters SET folder_path = ?1, file_path = NULL, page_count = ?2
             WHERE id = ?3",
            params![
                rel,
                std::fs::read_dir(root.join(SOURCE_SUBDIR))
                    .map(|d| d.count() as i64)
                    .unwrap_or(0),
                id,
            ],
        )?;
        migrated += 1;
    }
    tracing::info!(count = migrated, "auto-wrapped legacy chapters into folders");
    Ok(migrated)
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
    // Cascade-delete queue entries that reference this chapter so the
    // queue panel doesn't keep showing rows pointing at a chapter that
    // no longer exists. Stale rows would otherwise pollute the queue
    // UI list + counts, and the worker would try to pick them up and
    // fail with "chapter not found" on the next tick.
    // (No FK constraint on translation_queue.chapter_id in the schema
    // today — when we add one in a future migration this becomes a
    // safety net rather than the primary mechanism.)
    conn.execute(
        "DELETE FROM translation_queue WHERE chapter_id = ?1",
        params![id],
    )?;
    let changed = conn.execute("DELETE FROM chapters WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

/// Return concatenated summaries of the N chapters that come strictly
/// *before* `before_chapter_id` in chapter_number order. Used as the
/// `rolling_summary` prompt variable.
///
/// Empty summaries are skipped. If `before_chapter_id` doesn't exist in
/// the DB the call returns an empty string.
pub fn rolling_summary(conn: &Conn, before_chapter_id: i64, count: u32) -> Result<String> {
    let before_number: Option<f64> = conn
        .query_row(
            "SELECT chapter_number FROM chapters WHERE id = ?1",
            params![before_chapter_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(before_number) = before_number else {
        return Ok(String::new());
    };

    let mut stmt = conn.prepare(
        "SELECT chapter_number, COALESCE(title, ''), summary
         FROM chapters
         WHERE chapter_number < ?1
           AND summary IS NOT NULL
           AND TRIM(summary) <> ''
         ORDER BY chapter_number DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![before_number, count], |r| {
        Ok((
            r.get::<_, f64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;

    let mut entries: Vec<(f64, String, String)> = rows.collect::<rusqlite::Result<_>>()?;
    // We pulled them newest-first to honour LIMIT; reverse for natural reading order.
    entries.reverse();
    let formatted: Vec<String> = entries
        .into_iter()
        .map(|(num, title, summary)| {
            if title.is_empty() {
                format!("Ch. {num}: {summary}")
            } else {
                format!("Ch. {num} \"{title}\": {summary}")
            }
        })
        .collect();
    Ok(formatted.join("\n"))
}

fn row_to_chapter(r: &rusqlite::Row<'_>) -> rusqlite::Result<Chapter> {
    let status_str: String = r.get(5)?;
    Ok(Chapter {
        id: r.get(0)?,
        folder_path: r.get(1)?,
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
                folder_path: "chapters/ch01".into(),
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
                folder_path: "chapters/ch00".into(),
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

    #[test]
    fn rolling_summary_picks_prior_chapters_in_order() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        let make = |num: f64, title: &str, summary: Option<&str>| {
            let c = insert(
                &conn,
                ChapterInsert {
                    folder_path: format!("chapters/{num}"),
                    chapter_number: num,
                    title: Some(title.into()),
                    volume: None,
                },
            )
            .unwrap();
            if let Some(s) = summary {
                update(
                    &conn,
                    c.id,
                    ChapterPatch {
                        summary: Some(Some(s.into())),
                        ..Default::default()
                    },
                )
                .unwrap();
            }
            c.id
        };

        let _c1 = make(1.0, "Beginning", Some("Kenta arrives."));
        let _c2 = make(2.0, "Meeting", Some("Kenta meets Sato."));
        let _c3 = make(3.0, "Conflict", None); // no summary -> skipped
        let c4 = make(4.0, "Climax", Some("They fight the demon."));

        let s = rolling_summary(&conn, c4, 2).unwrap();
        // Should pick chapters 1 and 2 (skipping 3 which has no summary),
        // newest first by LIMIT, then reversed → reading order ch1 then ch2.
        assert!(s.contains("Ch. 1"));
        assert!(s.contains("Ch. 2"));
        assert!(!s.contains("Ch. 3"));
        assert!(!s.contains("Ch. 4"));
        let p1 = s.find("Ch. 1").unwrap();
        let p2 = s.find("Ch. 2").unwrap();
        assert!(p1 < p2, "older chapters should appear first");

        // count=1 → only ch2 (the most recent with summary before ch4)
        let s1 = rolling_summary(&conn, c4, 1).unwrap();
        assert!(s1.contains("Ch. 2"));
        assert!(!s1.contains("Ch. 1"));
    }
}
