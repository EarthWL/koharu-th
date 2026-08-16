-- SQLite database index optimization for missing Foreign Key columns to prevent full table scans.

CREATE INDEX IF NOT EXISTS idx_characters_first_appearance_chapter ON characters(first_appearance_chapter_id);
CREATE INDEX IF NOT EXISTS idx_glossary_first_appearance_chapter ON glossary(first_appearance_chapter_id);
CREATE INDEX IF NOT EXISTS idx_tm_prompt_template ON translation_memory(prompt_template_id);
CREATE INDEX IF NOT EXISTS idx_log_profile ON llm_call_log(profile_id);
