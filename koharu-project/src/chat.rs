//! AI chat history (per-project). Powers the in-app Chat sidebar tab.

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::params;

use crate::db::Conn;
use crate::error::Result;

/// One message row in the chat log.
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: i64,
    /// `user`, `assistant`, `tool`, or `system`.
    pub role: String,
    /// Markdown for user/assistant turns; JSON-encoded result for tool turns.
    pub content: String,
    /// JSON array `[{id, name, args}]` when an assistant turn invoked tools.
    pub tool_calls: Option<String>,
    /// Set on `tool` rows — the matching assistant tool_call.id.
    pub tool_call_id: Option<String>,
    /// `provider:model` that produced an assistant turn (informational).
    pub model: Option<String>,
    /// JSON array `[{dataUrl, mimeType, width, height}]` of images
    /// attached by the user (multimodal turns). NULL = no attachments.
    pub attachments: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ChatMessageInsert {
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub model: Option<String>,
    pub attachments: Option<String>,
}

pub fn insert(conn: &Conn, item: ChatMessageInsert) -> Result<ChatMessage> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO chat_messages
            (role, content, tool_calls, tool_call_id, model, attachments, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            item.role,
            item.content,
            item.tool_calls,
            item.tool_call_id,
            item.model,
            item.attachments,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("just inserted row"))
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<ChatMessage>> {
    let row = conn
        .query_row(
            "SELECT id, role, content, tool_calls, tool_call_id, model, attachments, created_at
             FROM chat_messages WHERE id = ?1",
            params![id],
            row_to_msg,
        )
        .map(Some)
        .or_else(|err| {
            if err == rusqlite::Error::QueryReturnedNoRows {
                Ok(None)
            } else {
                Err(err)
            }
        })?;
    Ok(row)
}

/// Return the most-recent `limit` messages in chronological (oldest-first)
/// order. The UI uses this with a small cap (~50) for display; the full
/// history stays on disk and can be paged via `before_id`.
pub fn list_recent(
    conn: &Conn,
    limit: u32,
    before_id: Option<i64>,
) -> Result<Vec<ChatMessage>> {
    let limit = limit.clamp(1, 1000) as i64;
    let mut rows: Vec<ChatMessage> = if let Some(before) = before_id {
        let mut stmt = conn.prepare(
            "SELECT id, role, content, tool_calls, tool_call_id, model, attachments, created_at
             FROM chat_messages
             WHERE id < ?1
             ORDER BY id DESC
             LIMIT ?2",
        )?;
        stmt.query_map(params![before, limit], row_to_msg)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, role, content, tool_calls, tool_call_id, model, attachments, created_at
             FROM chat_messages
             ORDER BY id DESC
             LIMIT ?1",
        )?;
        stmt.query_map(params![limit], row_to_msg)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    rows.reverse();
    Ok(rows)
}

pub fn count(conn: &Conn) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))?)
}

pub fn clear(conn: &Conn) -> Result<usize> {
    let n = conn.execute("DELETE FROM chat_messages", [])?;
    Ok(n)
}

/// Delete a single chat message by id. Returns 1 if a row was
/// removed, 0 if the id didn't match (already gone, or never
/// existed). Doesn't error on missing — callers driving an undo
/// flow over a stale UI list shouldn't blow up when the row's been
/// trimmed by another tab.
pub fn delete(conn: &Conn, id: i64) -> Result<usize> {
    let n = conn.execute("DELETE FROM chat_messages WHERE id = ?1", [id])?;
    Ok(n)
}

/// Delete every message with id >= `from_id`. Powers the "undo last
/// turn" / "delete from this point" flow: pick the user turn that
/// kicked off the regret, hand its id here, every assistant /
/// tool / follow-up message inserted after it goes too. Returns
/// the number of rows removed.
pub fn delete_from(conn: &Conn, from_id: i64) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM chat_messages WHERE id >= ?1",
        [from_id],
    )?;
    Ok(n)
}

fn row_to_msg(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: r.get(0)?,
        role: r.get(1)?,
        content: r.get(2)?,
        tool_calls: r.get(3)?,
        tool_call_id: r.get(4)?,
        model: r.get(5)?,
        attachments: r.get(6)?,
        created_at: Utc
            .timestamp_opt(r.get::<_, i64>(7)?, 0)
            .single()
            .unwrap_or_else(Utc::now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use tempfile::tempdir;

    #[test]
    fn chat_round_trip_and_recent_window() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        assert_eq!(count(&conn).unwrap(), 0);
        assert!(list_recent(&conn, 50, None).unwrap().is_empty());

        for i in 0..5 {
            insert(
                &conn,
                ChatMessageInsert {
                    role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                    content: format!("turn {i}"),
                    tool_calls: None,
                    tool_call_id: None,
                    model: Some("openai:gpt-4o-mini".into()),
                    attachments: None,
                },
            )
            .unwrap();
        }
        assert_eq!(count(&conn).unwrap(), 5);

        let recent = list_recent(&conn, 3, None).unwrap();
        assert_eq!(recent.len(), 3);
        // Oldest-first ordering — last 3 of 5 should be turns 2,3,4
        assert_eq!(recent[0].content, "turn 2");
        assert_eq!(recent[2].content, "turn 4");

        // Page back: pass first id of current window as `before_id`
        let first_id = recent[0].id;
        let earlier = list_recent(&conn, 10, Some(first_id)).unwrap();
        assert_eq!(earlier.len(), 2);
        assert_eq!(earlier[0].content, "turn 0");
        assert_eq!(earlier[1].content, "turn 1");

        assert_eq!(clear(&conn).unwrap(), 5);
        assert_eq!(count(&conn).unwrap(), 0);
    }
}
