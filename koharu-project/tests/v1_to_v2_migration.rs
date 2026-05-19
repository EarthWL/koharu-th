//! Phase 6.3 — end-to-end migration tests against a synthesized
//! v1 project on disk.
//!
//! These exercise the full `Project::open` flow including the
//! Phase 6.1 host-process hooks: pre_open backup → db::open
//! migration runner → post_open manifest bump + blobs/ dir.
//! Module-level unit tests in `migration.rs` cover each helper
//! in isolation; this file is the integration glue test.
//!
//! Limitation: a "real" v1 user would have a db with V001-V006
//! already applied + actual rows from a v1.x binary. We can't
//! check out an old binary in CI, so we synthesize the v1 state
//! by writing a v1 manifest alongside an EMPTY db file. The
//! migration runner sees no `_koharu_migrations` rows and applies
//! V001-V007 in order on first open — which is fine: we're
//! testing the host-process hooks + their composition with the
//! SQL runner, not the runner's idempotent re-apply path (which
//! has its own dedicated test in `db::tests`).

use std::fs;
use std::path::Path;

use koharu_project::{Manifest, ManifestPaths, Project, MANIFEST_FILENAME, SUPPORTED_SCHEMA_VERSION};
use tempfile::TempDir;

/// Write a v1 manifest + empty db file into `root`. Mirrors what
/// a v1.x koharu-th binary would have created on disk.
fn seed_v1_project(root: &Path, name: &str) {
    let now = chrono::Utc::now();
    let manifest = Manifest {
        schema_version: 1, // v1 era
        format: "koharu-project".into(),
        id: uuid::Uuid::new_v4(),
        name: name.into(),
        name_original: None,
        koharu_version: "1.1.0".into(), // pretend old binary
        created_at: now,
        updated_at: now,
        paths: ManifestPaths::default(),
        default_provider_profile: None,
        default_prompt_template: None,
        tags: Vec::new(),
    };
    // Write manifest via the public API (matches v1 binary path).
    manifest
        .write(root.join(MANIFEST_FILENAME))
        .expect("write v1 manifest");
    // Empty db file — the migration runner creates the schema
    // tables on first open.
    fs::write(root.join("series.db"), b"").expect("seed empty db");
}

/// Crack open the SQLite db (read-only-ish) + count rows in the
/// migration table. Confirms which V-files have applied.
fn count_applied_migrations(db_path: &Path) -> usize {
    let conn = rusqlite::Connection::open(db_path).expect("open db");
    conn.query_row("SELECT COUNT(*) FROM _koharu_migrations", [], |row| {
        row.get::<_, i64>(0)
    })
    .expect("count migrations") as usize
}

/// True if a given SQLite table exists in the db.
fn table_exists(db_path: &Path, table: &str) -> bool {
    let conn = rusqlite::Connection::open(db_path).expect("open db");
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        rusqlite::params![table],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

#[test]
fn opening_v1_project_runs_full_migration() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    seed_v1_project(root, "Test Migration Project");

    // Sanity: pre-conditions match a v1 state.
    let manifest_before = Manifest::read(&root.join(MANIFEST_FILENAME)).unwrap();
    assert_eq!(manifest_before.schema_version, 1);
    assert!(!root.join("series.db.bak.v1").exists());
    assert!(!root.join("blobs").is_dir());

    // Open via the public API — runs the full migration chain.
    let project = Project::open(root).expect("v1 project should open + migrate");

    // 1. Backup file lives at the documented path.
    let backup = root.join("series.db.bak.v1");
    assert!(
        backup.exists(),
        "pre_open should have created series.db.bak.v1",
    );

    // 2. Manifest schema_version bumped + persisted.
    let manifest_after = Manifest::read(&root.join(MANIFEST_FILENAME)).unwrap();
    assert_eq!(manifest_after.schema_version, SUPPORTED_SCHEMA_VERSION);
    assert_eq!(manifest_after.schema_version, 2);
    // The bump preserves identity — same project name, same id.
    assert_eq!(manifest_after.name, "Test Migration Project");
    assert_eq!(manifest_after.id, manifest_before.id);

    // 3. blobs/ directory created at the project root.
    assert!(
        root.join("blobs").is_dir(),
        "post_open should have created blobs/",
    );

    // 4. V007 has applied — blob_index table exists.
    let db_path = root.join("series.db");
    assert!(
        table_exists(&db_path, "blob_index"),
        "V007 migration should have created blob_index",
    );

    // 5. _koharu_migrations records all 7 V-files (V001-V007).
    assert_eq!(
        count_applied_migrations(&db_path),
        7,
        "all 7 migrations should be recorded in _koharu_migrations",
    );

    // 6. Project handle reflects the migrated state.
    assert_eq!(project.manifest().schema_version, 2);
}

#[test]
fn reopening_migrated_project_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    seed_v1_project(root, "Idempotent Test");

    // First open — does the migration.
    let _project = Project::open(root).expect("first open");
    let backup_mtime_before = fs::metadata(root.join("series.db.bak.v1"))
        .unwrap()
        .modified()
        .unwrap();
    let manifest_mtime_before = fs::metadata(root.join(MANIFEST_FILENAME))
        .unwrap()
        .modified()
        .unwrap();
    let migration_count_before = count_applied_migrations(&root.join("series.db"));

    // Sleep briefly so any new writes would have a distinct
    // mtime — proves we're not just hitting filesystem time-
    // resolution coincidences.
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Second open — manifest already at v2, db already at V007.
    // All three host hooks (pre_open, post_open, db::open) should
    // be no-ops.
    let _project2 = Project::open(root).expect("second open");

    // Backup file untouched.
    let backup_mtime_after = fs::metadata(root.join("series.db.bak.v1"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(
        backup_mtime_before, backup_mtime_after,
        "second open should not rewrite the backup",
    );

    // Manifest untouched.
    let manifest_mtime_after = fs::metadata(root.join(MANIFEST_FILENAME))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(
        manifest_mtime_before, manifest_mtime_after,
        "second open should not rewrite the manifest",
    );

    // _koharu_migrations row count unchanged.
    assert_eq!(
        count_applied_migrations(&root.join("series.db")),
        migration_count_before,
        "second open should not re-apply migrations",
    );
}

#[test]
fn pre_existing_backup_is_preserved_on_open() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    seed_v1_project(root, "Backup Preservation Test");

    // Simulate a half-migrated state: backup already exists from
    // a previous attempt that crashed before the manifest bump.
    let backup_content = b"sentinel - original v1 backup bytes";
    fs::write(root.join("series.db.bak.v1"), backup_content).unwrap();

    let _project = Project::open(root).expect("open with pre-existing backup");

    // The backup is the SAME bytes as before — we never overwrote
    // it with whatever empty bytes the synthesized v1 db had.
    // This matters because the FIRST backup is the only one we
    // trust to be a real v1-era db.
    let backup_after = fs::read(root.join("series.db.bak.v1")).unwrap();
    assert_eq!(
        backup_after, backup_content,
        "pre_open must NOT overwrite an existing .bak.v1 (it could be a real v1 db from a prior attempt)",
    );
}

#[test]
fn fresh_v2_project_creation_does_not_trigger_migration_artifacts() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // A brand-new v2 project created via the normal API. Manifest
    // is born at schema_version = SUPPORTED_SCHEMA_VERSION, so
    // both pre_open + post_open hooks are no-ops on subsequent
    // opens.
    let _project = Project::create(root, "Fresh v2", "1.2.2").expect("create v2 project");
    // Close + re-open.
    drop(_project);
    let _project = Project::open(root).expect("reopen v2 project");

    assert!(
        !root.join("series.db.bak.v1").exists(),
        "fresh v2 project should never produce a v1 backup file",
    );
    // Audit #7/P3 fix: Project::create now seeds `blobs/`
    // directly so fresh-create + migrated projects match on
    // disk. Before the fix, only the v1→v2 migration path
    // created the directory and fresh v2 projects had a
    // contract gap.
    assert!(
        root.join("blobs").is_dir(),
        "Project::create must seed blobs/ for v2 contract parity with migrated projects",
    );
    let manifest = Manifest::read(&root.join(MANIFEST_FILENAME)).unwrap();
    assert_eq!(manifest.schema_version, 2);
}
