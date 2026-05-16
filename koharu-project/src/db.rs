//! SQLite connection pool + migration runner.

use std::path::Path;

use r2d2::PooledConnection;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;

use crate::error::{Error, Result};

pub type Pool = r2d2::Pool<SqliteConnectionManager>;
pub type Conn = PooledConnection<SqliteConnectionManager>;

const APPLIED_MIGRATIONS_TABLE: &str = "_koharu_migrations";

/// A migration bundled into the binary.
struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

/// Migrations are applied in `version` order. New migrations are appended here.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        sql: include_str!("../migrations/V001__initial_schema.sql"),
    },
    Migration {
        version: 2,
        name: "chapter_folders",
        sql: include_str!("../migrations/V002__chapter_folders.sql"),
    },
    Migration {
        version: 3,
        name: "chat_messages",
        sql: include_str!("../migrations/V003__chat_messages.sql"),
    },
    Migration {
        version: 4,
        name: "chat_attachments",
        sql: include_str!("../migrations/V004__chat_attachments.sql"),
    },
];

/// Open (or create) the database at `path`, install required PRAGMAs,
/// and apply any pending migrations.
pub fn open(path: impl AsRef<Path>) -> Result<Pool> {
    let manager = SqliteConnectionManager::file(path.as_ref()).with_init(|c| {
        c.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
    });
    let pool = Pool::new(manager)?;
    {
        let mut conn = pool.get()?;
        run_migrations(&mut conn)?;
    }
    Ok(pool)
}

fn run_migrations(conn: &mut Conn) -> Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {APPLIED_MIGRATIONS_TABLE} (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            applied_at  INTEGER NOT NULL
        );"
    ))?;

    let applied: std::collections::BTreeSet<u32> = conn
        .prepare(&format!(
            "SELECT version FROM {APPLIED_MIGRATIONS_TABLE}"
        ))?
        .query_map([], |row| row.get::<_, u32>(0))?
        .collect::<rusqlite::Result<_>>()?;

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }
        tracing::info!(
            version = migration.version,
            name = migration.name,
            "applying migration"
        );
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql).map_err(|source| Error::Migration {
            version: migration.version,
            name: migration.name.to_string(),
            source,
        })?;
        tx.execute(
            &format!(
                "INSERT INTO {APPLIED_MIGRATIONS_TABLE} (version, name, applied_at)
                 VALUES (?1, ?2, ?3)"
            ),
            params![
                migration.version,
                migration.name,
                chrono::Utc::now().timestamp(),
            ],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn migrations_apply_cleanly_and_are_idempotent() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("series.db");

        let pool = open(&db_path).expect("open creates and migrates");
        let conn = pool.get().unwrap();

        // Spot-check a handful of tables exist after migration.
        for table in [
            "series_meta",
            "chapters",
            "characters",
            "glossary",
            "glossary_fts",
            "translation_memory",
            "tm_fts",
            "prompt_templates",
            "provider_profiles",
            "llm_call_log",
            "_koharu_migrations",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "expected table/index '{table}' to exist");
        }

        // Reopening should not re-apply migrations.
        drop(conn);
        drop(pool);
        let pool2 = open(&db_path).expect("reopen");
        let applied: i64 = pool2
            .get()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM _koharu_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(applied, MIGRATIONS.len() as i64);
    }

    #[test]
    fn glossary_fts_trigger_round_trip() {
        let dir = tempdir().unwrap();
        let pool = open(dir.path().join("series.db")).unwrap();
        let conn = pool.get().unwrap();

        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO glossary
                (source_text, target_text, category, aliases,
                 usage_count, confidence, approved, created_at, updated_at)
             VALUES ('魔法剣', 'ดาบเวทย์', 'term', NULL, 0, 'manual', 1, ?1, ?1)",
            params![now],
        )
        .unwrap();

        let hit: i64 = conn
            .query_row(
                "SELECT rowid FROM glossary_fts WHERE source_text MATCH '魔法剣'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(hit > 0);
    }
}
