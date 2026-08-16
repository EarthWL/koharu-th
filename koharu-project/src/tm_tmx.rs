//! TMX 1.4 import/export for translation memory interchange.
//!
//! TMX is the LISA / OASIS standard format used by CAT tools (Trados,
//! OmegaT, MemoQ, …). We support a minimal but valid subset:
//!
//! ```xml
//! <?xml version="1.0" encoding="UTF-8"?>
//! <tmx version="1.4">
//!   <header creationtool="koharu-th" srclang="ja" datatype="plaintext"
//!           adminlang="en" segtype="sentence" o-tmf="koharu"/>
//!   <body>
//!     <tu>
//!       <tuv xml:lang="ja"><seg>こんにちは</seg></tuv>
//!       <tuv xml:lang="th"><seg>สวัสดี</seg></tuv>
//!     </tu>
//!   </body>
//! </tmx>
//! ```
//!
//! Importer is forgiving: tolerates unknown attributes, picks the first
//! two `<tuv>` per `<tu>` whose langs match the requested src/tgt, and
//! skips malformed entries instead of failing the whole batch.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use chrono::Utc;
use rusqlite::params;

use crate::db::Conn;
use crate::error::{Error, Result};
use crate::tm::{TmInsert, hash_source};

/// Stream every TM entry whose `target_lang == target_lang_filter` (or
/// every entry when None) into a TMX file. Returns the count written.
pub fn export_to_tmx(
    conn: &Conn,
    out_path: &Path,
    target_lang_filter: Option<&str>,
    src_lang_default: &str,
) -> Result<usize> {
    let mut stmt = if let Some(_) = target_lang_filter {
        conn.prepare(
            "SELECT source_text, target_text, source_lang, target_lang
             FROM translation_memory
             WHERE target_lang = ?1
             ORDER BY id ASC",
        )?
    } else {
        conn.prepare(
            "SELECT source_text, target_text, source_lang, target_lang
             FROM translation_memory
             ORDER BY id ASC",
        )?
    };

    let mut file = File::create(out_path).map_err(|e| Error::io(out_path, e))?;
    writeln!(file, "{}", TMX_HEAD).map_err(|e| Error::io(out_path, e))?;
    writeln!(
        file,
        r#"<tmx version="1.4">
  <header creationtool="koharu-th" creationtoolversion="0.37.0" srclang="{src}"
          datatype="plaintext" adminlang="en" segtype="sentence"
          o-tmf="koharu" creationdate="{now}"/>
  <body>"#,
        src = xml_escape(src_lang_default),
        now = Utc::now().format("%Y%m%dT%H%M%SZ"),
    )
    .map_err(|e| Error::io(out_path, e))?;

    let rows = if let Some(lang) = target_lang_filter {
        stmt.query_map(params![lang], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut count = 0usize;
    for (src, tgt, src_lang, tgt_lang) in rows {
        writeln!(
            file,
            "    <tu>\n      <tuv xml:lang=\"{sl}\"><seg>{src}</seg></tuv>\n      <tuv xml:lang=\"{tl}\"><seg>{tgt}</seg></tuv>\n    </tu>",
            sl = xml_escape(&src_lang),
            tl = xml_escape(&tgt_lang),
            src = xml_escape(&src),
            tgt = xml_escape(&tgt),
        )
        .map_err(|e| Error::io(out_path, e))?;
        count += 1;
    }
    writeln!(file, "  </body>\n</tmx>").map_err(|e| Error::io(out_path, e))?;
    Ok(count)
}

const TMX_HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tmx SYSTEM "tmx14.dtd">"#;

#[derive(Debug, Clone)]
pub struct TmxImportResult {
    pub inserted: usize,
    pub skipped: usize,
}

/// Parse a TMX file and insert each translation unit matching the
/// given `src_lang` + `tgt_lang` into translation_memory. Returns
/// counts. Duplicates (matching source_hash+target_lang) are skipped
/// since `tm::insert` already dedupes.
pub fn import_from_tmx(
    conn: &mut Conn,
    in_path: &Path,
    src_lang: &str,
    tgt_lang: &str,
) -> Result<TmxImportResult> {
    let mut file = File::open(in_path).map_err(|e| Error::io(in_path, e))?;
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|e| Error::io(in_path, e))?;

    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let tx = conn.transaction()?;

    for tu in iter_tu_blocks(&xml) {
        match extract_pair(&tu, src_lang, tgt_lang) {
            Some((src, tgt)) if !src.is_empty() && !tgt.is_empty() => {
                let hash = hash_source(&src);
                // Skip if already present
                let exists: bool = tx
                    .query_row(
                        "SELECT 1 FROM translation_memory WHERE source_hash = ?1 AND target_lang = ?2 LIMIT 1",
                        params![hash, tgt_lang],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if exists {
                    skipped += 1;
                    continue;
                }
                let now = Utc::now().timestamp();
                let _ = tx.execute(
                    "INSERT INTO translation_memory
                        (source_text, source_hash, target_text, source_lang, target_lang,
                         chapter_id, page_index, text_block_index, provider, model,
                         prompt_template_id, quality_rating, is_approved, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, 'tmx-import', NULL, NULL, NULL, 0, ?6)",
                    params![src, hash, tgt, src_lang, tgt_lang, now],
                );
                inserted += 1;
                // Reuse the TmInsert type at least once for clarity in tests
                let _ = TmInsert {
                    source_text: String::new(),
                    target_text: String::new(),
                    source_lang: String::new(),
                    target_lang: String::new(),
                    chapter_id: None,
                    page_index: None,
                    text_block_index: None,
                    provider: None,
                    model: None,
                    prompt_template_id: None,
                };
            }
            _ => skipped += 1,
        }
    }
    tx.commit()?;
    Ok(TmxImportResult { inserted, skipped })
}

// ── Minimal hand-rolled TMX parser ──────────────────────────────────
// Robust enough for files emitted by Trados / OmegaT / MemoQ. We slice
// the XML by `<tu>` boundaries and pull out `<tuv xml:lang="…">` +
// inner `<seg>` per unit.

fn iter_tu_blocks(xml: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = xml[i..].find("<tu") {
        let start = i + rel;
        // Skip if it's actually <tuv ...> by looking at the next char.
        let after_open = &xml[start + 3..];
        let first = after_open.chars().next();
        if first != Some(' ')
            && first != Some('>')
            && first != Some('\t')
            && first != Some('\n')
            && first != Some('\r')
        {
            // <tuv or <tu… something — only accept `<tu ` / `<tu>`
            i = start + 3;
            continue;
        }
        let end_marker = "</tu>";
        match xml[start..].find(end_marker) {
            Some(rel_end) => {
                let end = start + rel_end + end_marker.len();
                out.push(&xml[start..end]);
                i = end;
            }
            None => break,
        }
    }
    out
}

fn extract_pair(tu: &str, src_lang: &str, tgt_lang: &str) -> Option<(String, String)> {
    let mut src: Option<String> = None;
    let mut tgt: Option<String> = None;
    let mut cursor = 0;
    while let Some(rel) = tu[cursor..].find("<tuv") {
        let open_start = cursor + rel;
        let open_end_rel = tu[open_start..].find('>')?;
        let open_end = open_start + open_end_rel;
        let attrs = &tu[open_start + 4..open_end];

        // Parse xml:lang="…" attribute (also accept lang="…").
        let lang = extract_attr(attrs, "xml:lang").or_else(|| extract_attr(attrs, "lang"));
        let close_pos_rel = tu[open_end..].find("</tuv>")?;
        let close_pos = open_end + close_pos_rel;
        let body = &tu[open_end + 1..close_pos];

        // Inner <seg>…</seg> — accept anything between tags.
        let seg_text = body
            .find("<seg")
            .and_then(|s| body[s..].find('>').map(|e| s + e + 1))
            .and_then(|seg_start| {
                body[seg_start..]
                    .find("</seg>")
                    .map(|end| body[seg_start..seg_start + end].to_string())
            })
            .map(|s| xml_unescape(&s));

        match (lang.as_deref(), seg_text) {
            (Some(l), Some(text)) if lang_matches(l, src_lang) && src.is_none() => src = Some(text),
            (Some(l), Some(text)) if lang_matches(l, tgt_lang) && tgt.is_none() => tgt = Some(text),
            _ => {}
        }

        cursor = close_pos + "</tuv>".len();
    }
    match (src, tgt) {
        (Some(s), Some(t)) => Some((s, t)),
        _ => None,
    }
}

fn lang_matches(found: &str, want: &str) -> bool {
    if found.eq_ignore_ascii_case(want) {
        return true;
    }
    // Loose match: "en-US" matches "en", "ja-JP" matches "ja", etc.
    let found_prefix = found.split(['-', '_']).next().unwrap_or(found);
    let want_prefix = want.split(['-', '_']).next().unwrap_or(want);
    found_prefix.eq_ignore_ascii_case(want_prefix)
}

fn extract_attr(attrs: &str, name: &str) -> Option<String> {
    let key1 = format!("{name}=\"");
    let key2 = format!("{name}='");
    let (start, quote) = if let Some(s) = attrs.find(&key1) {
        (s + key1.len(), '"')
    } else if let Some(s) = attrs.find(&key2) {
        (s + key2.len(), '\'')
    } else {
        return None;
    };
    let end = attrs[start..].find(quote)?;
    Some(attrs[start..start + end].to_string())
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use tempfile::tempdir;

    #[test]
    fn roundtrip_export_then_import() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        // Seed a few TM entries
        crate::tm::insert(
            &conn,
            TmInsert {
                source_text: "こんにちは".into(),
                target_text: "สวัสดี".into(),
                source_lang: "ja".into(),
                target_lang: "th".into(),
                chapter_id: None,
                page_index: None,
                text_block_index: None,
                provider: None,
                model: None,
                prompt_template_id: None,
            },
        )
        .unwrap();
        crate::tm::insert(
            &conn,
            TmInsert {
                source_text: "ありがとう".into(),
                target_text: "ขอบคุณ".into(),
                source_lang: "ja".into(),
                target_lang: "th".into(),
                chapter_id: None,
                page_index: None,
                text_block_index: None,
                provider: None,
                model: None,
                prompt_template_id: None,
            },
        )
        .unwrap();

        // Export
        let tmx_path = dir.path().join("out.tmx");
        let n = export_to_tmx(&conn, &tmx_path, Some("th"), "ja").unwrap();
        assert_eq!(n, 2);
        let xml = std::fs::read_to_string(&tmx_path).unwrap();
        assert!(xml.contains("こんにちは"));
        assert!(xml.contains("สวัสดี"));

        // Fresh project, import
        let dir2 = tempdir().unwrap();
        let p2 = Project::create(dir2.path(), "Test2", "0").unwrap();
        let mut conn2 = p2.pool().get().unwrap();
        let r = import_from_tmx(&mut conn2, &tmx_path, "ja", "th").unwrap();
        assert_eq!(r.inserted, 2);
        assert_eq!(r.skipped, 0);

        // Importing again should skip dupes
        let r2 = import_from_tmx(&mut conn2, &tmx_path, "ja", "th").unwrap();
        assert_eq!(r2.inserted, 0);
        assert_eq!(r2.skipped, 2);
    }

    #[test]
    fn lang_loose_match_works() {
        assert!(lang_matches("ja", "ja"));
        assert!(lang_matches("ja-JP", "ja"));
        assert!(lang_matches("th_TH", "th"));
        assert!(lang_matches("EN", "en"));
        assert!(!lang_matches("ja", "th"));
    }
}
