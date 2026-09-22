//! Translation queue — persistent list of chapters waiting to be
//! auto-translated in the background.
//!
//! V1 contract: sequential processing (one chapter at a time). The
//! actual chapter-open + pipeline-run loop lives in
//! `koharu-pipeline/src/ops/queue.rs`; this module is just the SQLite
//! CRUD surface that both the worker and the UI talk to.

use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use strum::{AsRefStr, EnumString};

use crate::db::Conn;
use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, AsRefStr, EnumString, Serialize, Deserialize)]
#[strum(serialize_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum QueueStatus {
    /// Waiting for the worker to pick it up.
    Pending,
    /// The worker is actively running this chapter.
    Running,
    /// Successfully finished translating + rendering every page.
    Completed,
    /// Hit an error mid-run; `error_message` is populated.
    Failed,
    /// User cancelled (either this entry specifically or the whole queue).
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEntry {
    pub id: i64,
    pub chapter_id: i64,
    pub status: QueueStatus,
    pub total_pages: i64,
    pub done_pages: i64,
    pub error_message: Option<String>,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<QueueEntry> {
    let status_str: String = row.get(2)?;
    let status = status_str
        .parse::<QueueStatus>()
        .unwrap_or(QueueStatus::Pending);
    Ok(QueueEntry {
        id: row.get(0)?,
        chapter_id: row.get(1)?,
        status,
        total_pages: row.get(3)?,
        done_pages: row.get(4)?,
        error_message: row.get(5)?,
        enqueued_at: row.get(6)?,
        started_at: row.get(7)?,
        finished_at: row.get(8)?,
    })
}

const SELECT_COLS: &str = "id, chapter_id, status, total_pages, done_pages,
                           error_message, enqueued_at, started_at, finished_at";

/// Add a chapter to the queue. Idempotent in the sense that you can
/// re-enqueue a chapter that previously completed/failed/cancelled —
/// only blocks if there's already a `pending` or `running` entry for
/// the same chapter.
pub fn enqueue(conn: &Conn, chapter_id: i64) -> Result<QueueEntry> {
    let active: Option<i64> = conn
        .query_row(
            "SELECT id FROM translation_queue
             WHERE chapter_id = ?1 AND status IN ('pending', 'running')
             LIMIT 1",
            params![chapter_id],
            |r| r.get(0),
        )
        .optional()?;

    if let Some(existing_id) = active {
        return get(conn, existing_id)?
            .ok_or_else(|| crate::error::Error::NotFound("queue entry".into()));
    }

    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO translation_queue (chapter_id, status, enqueued_at)
         VALUES (?1, 'pending', ?2)",
        params![chapter_id, now],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)?.ok_or_else(|| crate::error::Error::NotFound("queue entry just inserted".into()))
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<QueueEntry>> {
    let entry = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM translation_queue WHERE id = ?1"),
            params![id],
            row_to_entry,
        )
        .optional()?;
    Ok(entry)
}

/// All queue entries, most-recently-enqueued first. UI shows them in
/// this order so the active/just-finished work is at the top.
pub fn list(conn: &Conn) -> Result<Vec<QueueEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM translation_queue
         ORDER BY enqueued_at DESC, id DESC"
    ))?;
    let rows = stmt
        .query_map([], row_to_entry)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Next pending entry, oldest first (FIFO). Worker calls this in a loop.
pub fn next_pending(conn: &Conn) -> Result<Option<QueueEntry>> {
    let entry = conn
        .query_row(
            &format!(
                "SELECT {SELECT_COLS} FROM translation_queue
                 WHERE status = 'pending'
                 ORDER BY enqueued_at ASC, id ASC
                 LIMIT 1"
            ),
            [],
            row_to_entry,
        )
        .optional()?;
    Ok(entry)
}

/// Mark an entry as running and stamp `started_at`. Used by the
/// worker right before kicking off the pipeline.
///
/// Returns `true` if a row was actually updated (status was still
/// `pending`); `false` if the row had already moved on (most likely
/// the user cancelled it in the gap between `next_pending` returning
/// it and the worker getting here — race that would otherwise let
/// `mark_completed` overwrite the `cancelled` state).
pub fn mark_running(conn: &Conn, id: i64) -> Result<bool> {
    let now = Utc::now().timestamp();
    let rows = conn.execute(
        "UPDATE translation_queue
         SET status = 'running', started_at = ?2
         WHERE id = ?1 AND status = 'pending'",
        params![id, now],
    )?;
    Ok(rows > 0)
}

/// Update the per-entry page progress. Called by the worker as the
/// pipeline ticks through pages so the UI can render a live progress bar.
pub fn update_progress(conn: &Conn, id: i64, done_pages: i64, total_pages: i64) -> Result<()> {
    conn.execute(
        "UPDATE translation_queue
         SET done_pages = ?2, total_pages = ?3
         WHERE id = ?1",
        params![id, done_pages, total_pages],
    )?;
    Ok(())
}

/// Mark a queue entry as completed — **only if it's still `running`**.
///
/// The guard prevents a race where the user cancels mid-pipeline:
///   1. Worker is processing.
///   2. User clicks Cancel → `cancel()` flips `status` to `cancelled`.
///   3. Pipeline finishes its current page before noticing the cancel
///      flag and emits `PipelineStatus::Completed`.
///   4. Worker calls `mark_completed()` — without the guard this
///      would overwrite `cancelled` back to `completed` and the UI
///      would lie about what happened.
///
/// With the guard, the UPDATE matches zero rows in that race and the
/// entry correctly stays `cancelled`.
pub fn mark_completed(conn: &Conn, id: i64) -> Result<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE translation_queue
         SET status = 'completed', finished_at = ?2, error_message = NULL
         WHERE id = ?1 AND status = 'running'",
        params![id, now],
    )?;
    Ok(())
}

/// Mark a queue entry as failed — same `status = 'running'` guard as
/// `mark_completed`, for the same race-against-cancel reason.
pub fn mark_failed(conn: &Conn, id: i64, error: &str) -> Result<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE translation_queue
         SET status = 'failed', finished_at = ?2, error_message = ?3
         WHERE id = ?1 AND status = 'running'",
        params![id, now, error],
    )?;
    Ok(())
}

/// Cancel an entry. Allowed from `pending` (immediate) or `running`
/// (the worker checks for this and bails out at the next page boundary).
pub fn cancel(conn: &Conn, id: i64) -> Result<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE translation_queue
         SET status = 'cancelled', finished_at = ?2
         WHERE id = ?1 AND status IN ('pending', 'running')",
        params![id, now],
    )?;
    Ok(())
}

/// Reset any entries left in `running` state to `pending`. Called once
/// on project open — if the app crashed mid-run, the entry is stuck in
/// `running` forever otherwise. (We can't tell if it actually finished
/// some pages, so we restart from scratch; that's correct because the
/// per-page work is idempotent given the same source.)
pub fn reset_orphan_running(conn: &Conn) -> Result<usize> {
    let n = conn.execute(
        "UPDATE translation_queue
         SET status = 'pending', started_at = NULL, done_pages = 0
         WHERE status = 'running'",
        [],
    )?;
    Ok(n)
}

/// Remove all entries in a terminal state (completed / failed /
/// cancelled). Used by the "Clear completed" UI action.
pub fn clear_finished(conn: &Conn) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM translation_queue
         WHERE status IN ('completed', 'failed', 'cancelled')",
        [],
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open;
    use tempfile::tempdir;

    fn seed_chapter(conn: &Conn) -> i64 {
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO chapters (folder_path, chapter_number, status, created_at, updated_at)
             VALUES ('chapters/ch01', 1.0, 'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn enqueue_then_list_roundtrip() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let entry = enqueue(&conn, ch).unwrap();
        assert_eq!(entry.chapter_id, ch);
        assert_eq!(entry.status, QueueStatus::Pending);

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn enqueue_is_idempotent_while_active() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let first = enqueue(&conn, ch).unwrap();
        let second = enqueue(&conn, ch).unwrap();
        assert_eq!(first.id, second.id, "should return the existing entry");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn re_enqueue_after_terminal_creates_new_entry() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let first = enqueue(&conn, ch).unwrap();
        mark_running(&conn, first.id).unwrap();
        mark_completed(&conn, first.id).unwrap();

        let second = enqueue(&conn, ch).unwrap();
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn next_pending_is_fifo() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch1 = seed_chapter(&conn);
        // Second chapter so we can have two distinct pending entries.
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO chapters (folder_path, chapter_number, status, created_at, updated_at)
             VALUES ('chapters/ch02', 2.0, 'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();
        let ch2 = conn.last_insert_rowid();

        let first = enqueue(&conn, ch1).unwrap();
        // Ensure deterministic ordering even when enqueued_at ties to the second.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let _second = enqueue(&conn, ch2).unwrap();

        let next = next_pending(&conn).unwrap().unwrap();
        assert_eq!(next.id, first.id);
    }

    #[test]
    fn cancel_only_affects_active_states() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let entry = enqueue(&conn, ch).unwrap();
        mark_running(&conn, entry.id).unwrap();
        mark_completed(&conn, entry.id).unwrap();

        // Should be a no-op since it's already completed.
        cancel(&conn, entry.id).unwrap();
        let after = get(&conn, entry.id).unwrap().unwrap();
        assert_eq!(after.status, QueueStatus::Completed);
    }

    #[test]
    fn reset_orphan_running_restarts_them() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let entry = enqueue(&conn, ch).unwrap();
        mark_running(&conn, entry.id).unwrap();
        update_progress(&conn, entry.id, 3, 10).unwrap();

        let reset = reset_orphan_running(&conn).unwrap();
        assert_eq!(reset, 1);

        let after = get(&conn, entry.id).unwrap().unwrap();
        assert_eq!(after.status, QueueStatus::Pending);
        assert_eq!(after.done_pages, 0);
        assert!(after.started_at.is_none());
    }

    #[test]
    fn mark_running_returns_false_if_entry_was_cancelled() {
        // Models the race between next_pending() returning a row and the
        // worker getting around to claiming it: if the user cancels in
        // that window, mark_running must report "not claimed" so the
        // worker skips the entry without ever overwriting its status.
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let entry = enqueue(&conn, ch).unwrap();
        cancel(&conn, entry.id).unwrap();

        let claimed = mark_running(&conn, entry.id).unwrap();
        assert!(!claimed, "must not claim a cancelled entry");

        let after = get(&conn, entry.id).unwrap().unwrap();
        assert_eq!(after.status, QueueStatus::Cancelled);
    }

    #[test]
    fn mark_running_returns_false_if_already_running() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let entry = enqueue(&conn, ch).unwrap();
        let first = mark_running(&conn, entry.id).unwrap();
        assert!(first);
        let second = mark_running(&conn, entry.id).unwrap();
        assert!(!second, "second claim must be a no-op");
    }

    #[test]
    fn clear_finished_only_drops_terminal_entries() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let ch = seed_chapter(&conn);
        let done = enqueue(&conn, ch).unwrap();
        mark_running(&conn, done.id).unwrap();
        mark_completed(&conn, done.id).unwrap();

        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO chapters (folder_path, chapter_number, status, created_at, updated_at)
             VALUES ('chapters/ch02', 2.0, 'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();
        let ch2 = conn.last_insert_rowid();
        let _pending = enqueue(&conn, ch2).unwrap();

        let dropped = clear_finished(&conn).unwrap();
        assert_eq!(dropped, 1);
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
