-- V007 — v2 architecture refactor (Phase 6).
--
-- Adds `blob_index` for the future on-disk BlobStore backing.
-- v2.0 ships the in-memory BlobStore only (no rows ever written),
-- but the schema lands here so the on-disk backing phase (post-v2.0)
-- can flip on without another migration round-trip.
--
-- Locked-decision recap (see docs/v2-arch.md §6 on main):
-- - NO `op_log` table — history is in-memory only.
-- - NO `app_meta` table — schema_version lives in the
--   `series.koharuproj` manifest JSON.
-- - The `series.db.bak.v1` backup + manifest bump + `blobs/`
--   directory creation happen in the host process around the SQL
--   migration; they're documented in `koharu-project::backup` and
--   in `docs/migration.md`.

PRAGMA foreign_keys = ON;

CREATE TABLE blob_index (
    -- blake3 hash of the bytes — 32 raw bytes stored as BLOB,
    -- matches `koharu_core::BlobId([u8; 32])` on the Rust side.
    blob_id     BLOB PRIMARY KEY NOT NULL,
    -- Size of the original bytes for the Settings → Storage size
    -- accounting + future LRU eviction.
    size_bytes  INTEGER NOT NULL,
    -- Unix epoch seconds — used for created-at sort + LRU.
    created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_blob_index_created ON blob_index(created_at);
