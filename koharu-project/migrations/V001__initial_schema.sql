-- Initial schema for koharu-project.
--
-- All timestamps are Unix epoch seconds (INTEGER).
-- JSON-shaped TEXT columns are documented inline.

PRAGMA foreign_keys = ON;

-- ============================================================
-- Series metadata (singleton row, id always = 1)
-- ============================================================
CREATE TABLE series_meta (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    title           TEXT NOT NULL,
    title_original  TEXT,
    synopsis        TEXT,
    genre           TEXT,            -- JSON array of strings
    target_audience TEXT,            -- shounen|seinen|shoujo|josei|...
    source_language TEXT NOT NULL DEFAULT 'ja',
    target_language TEXT NOT NULL DEFAULT 'th',
    tone            TEXT,            -- casual|formal|mixed
    formality_level TEXT,            -- low|medium|high
    style_notes     TEXT,
    cover_image     TEXT,            -- relative path inside project root
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

-- ============================================================
-- Chapters
-- ============================================================
CREATE TABLE chapters (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path      TEXT NOT NULL UNIQUE,        -- relative: "chapters/ch01.khr"
    chapter_number REAL NOT NULL,               -- supports 2.5 omake numbering
    title          TEXT,
    volume         INTEGER,
    status         TEXT NOT NULL DEFAULT 'pending',
                                                -- pending|in_progress|translated|reviewed|done
    summary        TEXT,                        -- LLM-generated, user-editable
    notes          TEXT,
    page_count     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_chapters_number ON chapters(chapter_number);
CREATE INDEX idx_chapters_status ON chapters(status);

-- ============================================================
-- Characters
-- ============================================================
CREATE TABLE characters (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name               TEXT NOT NULL,
    translated_name             TEXT NOT NULL,
    aliases                     TEXT,           -- JSON: [{"src":"...","tgt":"..."}]
    role                        TEXT,           -- protagonist|antagonist|supporting|mob
    gender                      TEXT,
    age                         TEXT,           -- free-form string
    speech_style                TEXT,
    personality                 TEXT,
    relationships               TEXT,           -- JSON array
    first_appearance_chapter_id INTEGER,
    notes                       TEXT,
    is_main                     INTEGER NOT NULL DEFAULT 0,  -- 0|1
    sort_order                  INTEGER NOT NULL DEFAULT 0,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL,
    FOREIGN KEY (first_appearance_chapter_id)
        REFERENCES chapters(id) ON DELETE SET NULL
);
CREATE INDEX idx_characters_original ON characters(original_name);
CREATE INDEX idx_characters_main     ON characters(is_main);

-- ============================================================
-- Glossary
-- ============================================================
CREATE TABLE glossary (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_text                 TEXT NOT NULL,
    target_text                 TEXT NOT NULL,
    category                    TEXT NOT NULL,  -- term|place|skill|honorific|item|org|sfx
    aliases                     TEXT,           -- JSON array of alt source forms
    context_note                TEXT,
    first_appearance_chapter_id INTEGER,
    usage_count                 INTEGER NOT NULL DEFAULT 0,
    confidence                  TEXT NOT NULL DEFAULT 'manual',
                                                -- manual|extracted|auto
    approved                    INTEGER NOT NULL DEFAULT 1,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL,
    FOREIGN KEY (first_appearance_chapter_id)
        REFERENCES chapters(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_glossary_source   ON glossary(source_text, category);
CREATE INDEX        idx_glossary_category ON glossary(category);
CREATE INDEX        idx_glossary_approved ON glossary(approved);

-- FTS5 index for fast multi-form glossary matching
CREATE VIRTUAL TABLE glossary_fts USING fts5(
    source_text,
    aliases,
    content='glossary',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER glossary_fts_ai AFTER INSERT ON glossary BEGIN
    INSERT INTO glossary_fts(rowid, source_text, aliases)
    VALUES (new.id, new.source_text, new.aliases);
END;
CREATE TRIGGER glossary_fts_ad AFTER DELETE ON glossary BEGIN
    INSERT INTO glossary_fts(glossary_fts, rowid, source_text, aliases)
    VALUES ('delete', old.id, old.source_text, old.aliases);
END;
CREATE TRIGGER glossary_fts_au AFTER UPDATE ON glossary BEGIN
    INSERT INTO glossary_fts(glossary_fts, rowid, source_text, aliases)
    VALUES ('delete', old.id, old.source_text, old.aliases);
    INSERT INTO glossary_fts(rowid, source_text, aliases)
    VALUES (new.id, new.source_text, new.aliases);
END;

-- ============================================================
-- Translation memory (TM)
-- ============================================================
CREATE TABLE translation_memory (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_text        TEXT NOT NULL,
    source_hash        TEXT NOT NULL,           -- sha256 hex for exact dedup
    target_text        TEXT NOT NULL,
    source_lang        TEXT NOT NULL,
    target_lang        TEXT NOT NULL,
    chapter_id         INTEGER,
    page_index         INTEGER,
    text_block_index   INTEGER,
    provider           TEXT,
    model              TEXT,
    prompt_template_id INTEGER,
    quality_rating     INTEGER,                 -- 1-5, NULL = unrated
    is_approved        INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    FOREIGN KEY (chapter_id)         REFERENCES chapters(id)         ON DELETE SET NULL,
    FOREIGN KEY (prompt_template_id) REFERENCES prompt_templates(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_tm_hash     ON translation_memory(source_hash, target_lang);
CREATE INDEX        idx_tm_chapter  ON translation_memory(chapter_id);
CREATE INDEX        idx_tm_approved ON translation_memory(is_approved);

CREATE VIRTUAL TABLE tm_fts USING fts5(
    source_text,
    target_text,
    content='translation_memory',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER tm_fts_ai AFTER INSERT ON translation_memory BEGIN
    INSERT INTO tm_fts(rowid, source_text, target_text)
    VALUES (new.id, new.source_text, new.target_text);
END;
CREATE TRIGGER tm_fts_ad AFTER DELETE ON translation_memory BEGIN
    INSERT INTO tm_fts(tm_fts, rowid, source_text, target_text)
    VALUES ('delete', old.id, old.source_text, old.target_text);
END;
CREATE TRIGGER tm_fts_au AFTER UPDATE ON translation_memory BEGIN
    INSERT INTO tm_fts(tm_fts, rowid, source_text, target_text)
    VALUES ('delete', old.id, old.source_text, old.target_text);
    INSERT INTO tm_fts(rowid, source_text, target_text)
    VALUES (new.id, new.source_text, new.target_text);
END;

-- ============================================================
-- Prompt templates
-- ============================================================
CREATE TABLE prompt_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    use_case    TEXT NOT NULL,        -- translate|extract_entities|summarize_chapter
    template    TEXT NOT NULL,        -- handlebars-style {{var}}
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_prompt_templates_use_case ON prompt_templates(use_case);

-- ============================================================
-- Provider profiles
-- API keys are NOT stored here -- api_key_ref is a lookup
-- into the OS keyring (added in phase 9). For now it may be empty.
-- ============================================================
CREATE TABLE provider_profiles (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    provider           TEXT NOT NULL,        -- openai|gemini|anthropic
    api_url            TEXT,
    model_name         TEXT NOT NULL,
    api_key_ref        TEXT,                 -- keyring service+account ref
    extra_headers      TEXT,                 -- JSON
    extra_params       TEXT,                 -- JSON
    is_default         INTEGER NOT NULL DEFAULT 0,
    cost_input_per_1m  REAL,
    cost_output_per_1m REAL,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);

-- ============================================================
-- LLM call log (cost / debugging)
-- ============================================================
CREATE TABLE llm_call_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id         INTEGER,
    use_case           TEXT NOT NULL,
    chapter_id         INTEGER,
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    estimated_cost_usd REAL,
    duration_ms        INTEGER,
    success            INTEGER NOT NULL,
    error_message      TEXT,
    created_at         INTEGER NOT NULL,
    FOREIGN KEY (profile_id) REFERENCES provider_profiles(id) ON DELETE SET NULL,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id)          ON DELETE SET NULL
);
CREATE INDEX idx_log_created ON llm_call_log(created_at);
CREATE INDEX idx_log_chapter ON llm_call_log(chapter_id);
