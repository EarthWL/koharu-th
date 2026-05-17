-- Translation queue: persistent list of chapters waiting to be auto-translated
-- in the background. Sequential processing for v1 (one chapter at a time)
-- to avoid hammering provider rate limits and keep the existing single-
-- pipeline contract in koharu-pipeline.

CREATE TABLE translation_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id    INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
                                   -- pending | running | completed | failed | cancelled
    total_pages   INTEGER NOT NULL DEFAULT 0,
    done_pages    INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    enqueued_at   INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
);

CREATE INDEX idx_queue_status      ON translation_queue(status);
CREATE INDEX idx_queue_chapter     ON translation_queue(chapter_id);
CREATE INDEX idx_queue_enqueued_at ON translation_queue(enqueued_at);
