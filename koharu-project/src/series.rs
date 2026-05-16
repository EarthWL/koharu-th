//! Series-metadata CRUD against the singleton row in `series_meta`.

use chrono::{DateTime, TimeZone, Utc};

use crate::db::Conn;
use crate::error::Result;
use crate::types::SeriesMeta;

/// Fetch the singleton series metadata row. Panics in debug if the row
/// is missing — `Project::create` is responsible for seeding it.
pub fn get(conn: &Conn) -> Result<SeriesMeta> {
    let row = conn.query_row(
        "SELECT title, title_original, synopsis, genre, target_audience,
                source_language, target_language, tone, formality_level,
                style_notes, cover_image, created_at, updated_at
         FROM series_meta WHERE id = 1",
        [],
        |r| {
            let genre_json: Option<String> = r.get(3)?;
            let genre = genre_json
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .unwrap_or_default();
            Ok(SeriesMeta {
                title: r.get(0)?,
                title_original: r.get(1)?,
                synopsis: r.get(2)?,
                genre,
                target_audience: r.get(4)?,
                source_language: r.get(5)?,
                target_language: r.get(6)?,
                tone: r.get(7)?,
                formality_level: r.get(8)?,
                style_notes: r.get(9)?,
                cover_image: r.get(10)?,
                created_at: ts_to_utc(r.get(11)?),
                updated_at: ts_to_utc(r.get(12)?),
            })
        },
    )?;
    Ok(row)
}

/// Patch a subset of series_meta fields. `None` means "leave unchanged".
#[derive(Debug, Default, Clone)]
pub struct SeriesMetaPatch {
    pub title: Option<String>,
    pub title_original: Option<Option<String>>,
    pub synopsis: Option<Option<String>>,
    pub genre: Option<Vec<String>>,
    pub target_audience: Option<Option<String>>,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub tone: Option<Option<String>>,
    pub formality_level: Option<Option<String>>,
    pub style_notes: Option<Option<String>>,
    pub cover_image: Option<Option<String>>,
}

pub fn update(conn: &Conn, patch: SeriesMetaPatch) -> Result<SeriesMeta> {
    let now = Utc::now().timestamp();
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(v) = patch.title {
        sets.push("title = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.title_original {
        sets.push("title_original = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.synopsis {
        sets.push("synopsis = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.genre {
        sets.push("genre = ?");
        values.push(serde_json::to_string(&v).unwrap_or("[]".into()).into());
    }
    if let Some(v) = patch.target_audience {
        sets.push("target_audience = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.source_language {
        sets.push("source_language = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.target_language {
        sets.push("target_language = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.tone {
        sets.push("tone = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.formality_level {
        sets.push("formality_level = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.style_notes {
        sets.push("style_notes = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.cover_image {
        sets.push("cover_image = ?");
        values.push(v.into());
    }

    if !sets.is_empty() {
        sets.push("updated_at = ?");
        values.push(now.into());
        let sql = format!("UPDATE series_meta SET {} WHERE id = 1", sets.join(", "));
        let params_iter = rusqlite::params_from_iter(values.iter());
        conn.execute(&sql, params_iter)?;
    }
    get(conn)
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
    fn round_trip_series_meta() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0.0.0").unwrap();
        let conn = p.pool().get().unwrap();

        let meta = get(&conn).unwrap();
        assert_eq!(meta.title, "Test");
        assert_eq!(meta.source_language, "ja");

        let updated = update(
            &conn,
            SeriesMetaPatch {
                title: Some("Onmyouji Tales".into()),
                title_original: Some(Some("陰陽師物語".into())),
                synopsis: Some(Some("A young exorcist...".into())),
                genre: Some(vec!["fantasy".into(), "shounen".into()]),
                tone: Some(Some("casual".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.title, "Onmyouji Tales");
        assert_eq!(updated.title_original.as_deref(), Some("陰陽師物語"));
        assert_eq!(updated.genre, vec!["fantasy", "shounen"]);
        assert_eq!(updated.tone.as_deref(), Some("casual"));
    }
}

// Tiny adapter so `Option<String>` can be Into<Value> without ceremony.
// `rusqlite::types::Value` already implements From<Option<T>> for some T.
// We rely on that; no manual impl needed.
