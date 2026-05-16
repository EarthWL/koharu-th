//! Semantic TM lookup via cosine similarity on stored embeddings.
//!
//! Pragmatic implementation — full table scan. SQLite has no native
//! vector index, and `sqlite-vec` adds a heavy build dep we don't
//! need at our scale (typical project: hundreds, maybe low thousands
//! of TM entries; brute-force cosine over 1536-d vectors is sub-ms).
//!
//! Only entries whose `embedding_model` matches the query's model
//! participate — mixing vector spaces is meaningless. Callers must
//! pass the same model they used when backfilling.

use rusqlite::params;

use crate::db::Conn;
use crate::error::Result;
use crate::tm::TmEntry;

/// Encode an f32 slice as little-endian bytes for BLOB storage.
pub fn encode_vec(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Decode a BLOB back into f32s.
pub fn decode_vec(bytes: &[u8]) -> Vec<f32> {
    let n = bytes.len() / 4;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let s = i * 4;
        out.push(f32::from_le_bytes([
            bytes[s],
            bytes[s + 1],
            bytes[s + 2],
            bytes[s + 3],
        ]));
    }
    out
}

/// Cosine similarity in `[-1, 1]`. Returns 0 when either vector is zero
/// or dimensions don't match (defensive — callers should normalise).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Persist a freshly-computed embedding for a TM entry.
pub fn set_embedding(
    conn: &Conn,
    tm_id: i64,
    embedding: &[f32],
    model: &str,
) -> Result<()> {
    let bytes = encode_vec(embedding);
    conn.execute(
        "UPDATE translation_memory SET embedding = ?1, embedding_model = ?2 WHERE id = ?3",
        params![bytes, model, tm_id],
    )?;
    Ok(())
}

/// List TM entries that don't yet have an embedding for the given
/// model — driver of the backfill loop.
pub fn list_pending_embeddings(
    conn: &Conn,
    model: &str,
    limit: u32,
) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_text
         FROM translation_memory
         WHERE embedding IS NULL OR embedding_model != ?1
         ORDER BY id ASC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![model, limit as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn count_pending_embeddings(conn: &Conn, model: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM translation_memory
         WHERE embedding IS NULL OR embedding_model != ?1",
        params![model],
        |r| r.get(0),
    )?)
}

/// Top-K semantic search. `query_embedding` is the embedded form of
/// the user's source text; we walk every TM entry with a matching
/// `embedding_model` and return entries ranked by cosine similarity.
pub fn lookup_semantic(
    conn: &Conn,
    query_embedding: &[f32],
    model: &str,
    target_lang: &str,
    top_k: usize,
    min_similarity: f32,
) -> Result<Vec<(TmEntry, f32)>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_text, source_hash, target_text, source_lang,
                target_lang, chapter_id, page_index, text_block_index,
                provider, model, prompt_template_id, quality_rating,
                is_approved, created_at, embedding
         FROM translation_memory
         WHERE embedding IS NOT NULL
           AND embedding_model = ?1
           AND target_lang = ?2",
    )?;

    let rows = stmt.query_map(params![model, target_lang], |r| {
        let entry = TmEntry {
            id: r.get(0)?,
            source_text: r.get(1)?,
            source_hash: r.get(2)?,
            target_text: r.get(3)?,
            source_lang: r.get(4)?,
            target_lang: r.get(5)?,
            chapter_id: r.get(6)?,
            page_index: r.get(7)?,
            text_block_index: r.get(8)?,
            provider: r.get(9)?,
            model: r.get(10)?,
            prompt_template_id: r.get(11)?,
            quality_rating: r.get(12)?,
            is_approved: r.get::<_, i64>(13)? != 0,
            created_at: chrono::Utc
                .timestamp_opt(r.get::<_, i64>(14)?, 0)
                .single()
                .unwrap_or_else(chrono::Utc::now),
        };
        let blob: Vec<u8> = r.get(15)?;
        Ok((entry, blob))
    })?;

    let mut scored: Vec<(TmEntry, f32)> = Vec::new();
    for row in rows {
        let (entry, blob) = row?;
        let vec = decode_vec(&blob);
        let sim = cosine(query_embedding, &vec);
        if sim >= min_similarity {
            scored.push((entry, sim));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    Ok(scored)
}

use chrono::TimeZone;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vec_roundtrip_preserves_floats() {
        let v: Vec<f32> = vec![1.0, -0.5, 0.25, 1e-9, 3.14];
        let b = encode_vec(&v);
        let back = decode_vec(&b);
        for (a, b) in v.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1e-9);
        }
    }

    #[test]
    fn cosine_identical_is_one() {
        let v: Vec<f32> = vec![1.0, 2.0, 3.0, -4.0];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_is_neg_one() {
        let v: Vec<f32> = vec![1.0, 2.0, 3.0];
        let nv: Vec<f32> = v.iter().map(|x| -x).collect();
        assert!((cosine(&v, &nv) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn cosine_mismatched_dimensions_returns_zero() {
        assert_eq!(cosine(&[1.0, 2.0], &[1.0, 2.0, 3.0]), 0.0);
    }
}
