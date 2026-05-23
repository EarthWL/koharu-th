//! Character CRUD.

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};

use crate::db::Conn;
use crate::error::Result;
use crate::types::{Character, NameAlias};

#[derive(Debug, Clone)]
pub struct CharacterInsert {
    pub original_name: String,
    pub translated_name: String,
    pub aliases: Vec<NameAlias>,
    pub role: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub speech_style: Option<String>,
    pub personality: Option<String>,
    pub notes: Option<String>,
    pub is_main: bool,
    pub sort_order: i64,
    pub first_appearance_chapter_id: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct CharacterPatch {
    pub original_name: Option<String>,
    pub translated_name: Option<String>,
    pub aliases: Option<Vec<NameAlias>>,
    pub role: Option<Option<String>>,
    pub gender: Option<Option<String>>,
    pub age: Option<Option<String>>,
    pub speech_style: Option<Option<String>>,
    pub personality: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    pub is_main: Option<bool>,
    pub sort_order: Option<i64>,
    pub first_appearance_chapter_id: Option<Option<i64>>,
}

pub fn list(conn: &Conn) -> Result<Vec<Character>> {
    let mut stmt = conn.prepare(
        "SELECT id, original_name, translated_name, aliases, role, gender,
                age, speech_style, personality, relationships,
                first_appearance_chapter_id, notes, is_main, sort_order,
                created_at, updated_at
         FROM characters
         ORDER BY is_main DESC, sort_order ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_character)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<Character>> {
    let row = conn
        .query_row(
            "SELECT id, original_name, translated_name, aliases, role, gender,
                    age, speech_style, personality, relationships,
                    first_appearance_chapter_id, notes, is_main, sort_order,
                    created_at, updated_at
             FROM characters WHERE id = ?1",
            params![id],
            row_to_character,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(conn: &Conn, item: CharacterInsert) -> Result<Character> {
    let now = Utc::now().timestamp();
    let aliases_json = serde_json::to_string(&item.aliases).unwrap_or("[]".into());
    conn.execute(
        "INSERT INTO characters
            (original_name, translated_name, aliases, role, gender, age,
             speech_style, personality, relationships,
             first_appearance_chapter_id, notes, is_main, sort_order,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            item.original_name,
            item.translated_name,
            aliases_json,
            item.role,
            item.gender,
            item.age,
            item.speech_style,
            item.personality,
            item.first_appearance_chapter_id,
            item.notes,
            if item.is_main { 1 } else { 0 },
            item.sort_order,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)?
        .ok_or_else(|| crate::error::Error::NotFound(format!("character id={id} after insert")))
}

pub fn update(conn: &Conn, id: i64, patch: CharacterPatch) -> Result<Option<Character>> {
    let now = Utc::now().timestamp();
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(v) = patch.original_name {
        sets.push("original_name = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.translated_name {
        sets.push("translated_name = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.aliases {
        sets.push("aliases = ?");
        values.push(serde_json::to_string(&v).unwrap_or("[]".into()).into());
    }
    if let Some(v) = patch.role {
        sets.push("role = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.gender {
        sets.push("gender = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.age {
        sets.push("age = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.speech_style {
        sets.push("speech_style = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.personality {
        sets.push("personality = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.notes {
        sets.push("notes = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.is_main {
        sets.push("is_main = ?");
        values.push((if v { 1 } else { 0 }).into());
    }
    if let Some(v) = patch.sort_order {
        sets.push("sort_order = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.first_appearance_chapter_id {
        sets.push("first_appearance_chapter_id = ?");
        values.push(v.into());
    }

    if sets.is_empty() {
        return get(conn, id);
    }

    sets.push("updated_at = ?");
    values.push(now.into());
    values.push(id.into());

    let sql = format!("UPDATE characters SET {} WHERE id = ?", sets.join(", "));
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

pub fn remove(conn: &Conn, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM characters WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

fn row_to_character(r: &rusqlite::Row<'_>) -> rusqlite::Result<Character> {
    let aliases_json: Option<String> = r.get(3)?;
    let aliases = aliases_json
        .and_then(|s| serde_json::from_str::<Vec<NameAlias>>(&s).ok())
        .unwrap_or_default();
    let relationships_json: Option<String> = r.get(9)?;
    let relationships = relationships_json
        .as_deref()
        .map(|s| serde_json::from_str(s).unwrap_or(serde_json::Value::Array(Vec::new())))
        .unwrap_or(serde_json::Value::Array(Vec::new()));
    let is_main_int: i64 = r.get(12)?;
    Ok(Character {
        id: r.get(0)?,
        original_name: r.get(1)?,
        translated_name: r.get(2)?,
        aliases,
        role: r.get(4)?,
        gender: r.get(5)?,
        age: r.get(6)?,
        speech_style: r.get(7)?,
        personality: r.get(8)?,
        relationships,
        first_appearance_chapter_id: r.get(10)?,
        notes: r.get(11)?,
        is_main: is_main_int != 0,
        sort_order: r.get(13)?,
        created_at: ts_to_utc(r.get(14)?),
        updated_at: ts_to_utc(r.get(15)?),
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
    fn character_crud_with_aliases_and_main_sort() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        let kenta = insert(
            &conn,
            CharacterInsert {
                original_name: "健太".into(),
                translated_name: "เคนตะ".into(),
                aliases: vec![NameAlias {
                    src: "健ちゃん".into(),
                    tgt: "เคนจัง".into(),
                }],
                role: Some("protagonist".into()),
                gender: Some("M".into()),
                age: Some("17".into()),
                speech_style: None,
                personality: None,
                notes: None,
                is_main: true,
                sort_order: 0,
                first_appearance_chapter_id: None,
            },
        )
        .unwrap();
        assert!(kenta.is_main);
        assert_eq!(kenta.aliases.len(), 1);

        let mob = insert(
            &conn,
            CharacterInsert {
                original_name: "通行人".into(),
                translated_name: "คนผ่านทาง".into(),
                aliases: vec![],
                role: Some("mob".into()),
                gender: None,
                age: None,
                speech_style: None,
                personality: None,
                notes: None,
                is_main: false,
                sort_order: 10,
                first_appearance_chapter_id: None,
            },
        )
        .unwrap();
        assert!(!mob.is_main);

        let listed = list(&conn).unwrap();
        // is_main DESC means kenta first.
        assert_eq!(listed[0].id, kenta.id);
        assert_eq!(listed[1].id, mob.id);

        let promoted = update(
            &conn,
            mob.id,
            CharacterPatch {
                is_main: Some(true),
                speech_style: Some(Some("ห้วน".into())),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert!(promoted.is_main);
        assert_eq!(promoted.speech_style.as_deref(), Some("ห้วน"));

        assert!(remove(&conn, mob.id).unwrap());
    }
}
