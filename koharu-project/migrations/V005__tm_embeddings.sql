-- Semantic-search TM: store an embedding vector per source_text.
--
-- `embedding` is the raw little-endian f32 array of the model's output
-- (1536 dimensions for text-embedding-3-small = 6144 bytes). Storing
-- as BLOB avoids JSON parse overhead during similarity scans.
--
-- `embedding_model` records which model produced the vector so we can
-- refuse cross-model comparisons (different vector spaces aren't
-- compatible). NULL on rows that haven't been backfilled yet.

ALTER TABLE translation_memory ADD COLUMN embedding BLOB;
ALTER TABLE translation_memory ADD COLUMN embedding_model TEXT;

CREATE INDEX idx_tm_embedding_model ON translation_memory(embedding_model);
