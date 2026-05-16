-- Chapters get a folder layout instead of a single file:
--
--   chapters/
--     ch01/
--       source/   -- raw images / .khr the user imported
--       render/   -- exported / rendered output
--
-- The old `file_path` column is kept (nullable) for backward compat —
-- a runtime helper in koharu_project::chapter::ensure_folder_layout
-- moves any legacy single-file chapter into a fresh folder layout
-- when the project is opened. Once the migration helper runs once
-- the row has folder_path populated and file_path goes to NULL.
--
-- SQLite has no ALTER COLUMN, so dropping NOT NULL on file_path means
-- rebuilding the table. We preserve all data + indexes.

PRAGMA foreign_keys = OFF;

CREATE TABLE chapters_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path      TEXT UNIQUE,                 -- nullable; legacy column
    folder_path    TEXT,                        -- new; "chapters/<name>"
    chapter_number REAL NOT NULL,
    title          TEXT,
    volume         INTEGER,
    status         TEXT NOT NULL DEFAULT 'pending',
    summary        TEXT,
    notes          TEXT,
    page_count     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

INSERT INTO chapters_new
    (id, file_path, folder_path, chapter_number, title, volume, status,
     summary, notes, page_count, created_at, updated_at)
SELECT id, file_path, NULL, chapter_number, title, volume, status,
       summary, notes, page_count, created_at, updated_at
  FROM chapters;

DROP TABLE chapters;
ALTER TABLE chapters_new RENAME TO chapters;

CREATE INDEX idx_chapters_number      ON chapters(chapter_number);
CREATE INDEX idx_chapters_status      ON chapters(status);
CREATE INDEX idx_chapters_folder_path ON chapters(folder_path);

PRAGMA foreign_keys = ON;
