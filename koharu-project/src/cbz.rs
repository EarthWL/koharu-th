//! Pack a chapter's rendered pages into a `.cbz` (Comic Book ZIP) —
//! standard format read by Kavita / Komga / YACReader / CDisplayEx /
//! mobile manga apps. Includes a `ComicInfo.xml` sidecar with series
//! + chapter metadata so the reader can index correctly.
//!
//! Source preference order (per page set):
//!   1. `<chapter>/render/`  — finished translation, if present
//!   2. `<chapter>/source/`  — fall back to raws (useful when shipping
//!                              partial work or untranslated chapters)
//!
//! Pages are sorted by filename; reader display order follows.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::chapter::{RENDER_SUBDIR, SOURCE_SUBDIR};
use crate::error::{Error, Result};
use crate::types::{Chapter, SeriesMeta};

/// What got into the .cbz. The UI surfaces these counts so the user
/// knows whether they exported rendered translations or raw scans.
#[derive(Debug, Clone)]
pub struct CbzExportResult {
    pub path: PathBuf,
    pub page_count: usize,
    pub used_render: bool,
}

/// Export a single chapter. `out_cbz` is the absolute destination path
/// (the caller picks via save-dialog).
pub fn export_chapter(
    project_root: &Path,
    chapter: &Chapter,
    series: &SeriesMeta,
    out_cbz: &Path,
) -> Result<CbzExportResult> {
    let chapter_dir = project_root.join(&chapter.folder_path);
    let render_dir = chapter_dir.join(RENDER_SUBDIR);
    let source_dir = chapter_dir.join(SOURCE_SUBDIR);

    let mut used_render = true;
    let mut pages = list_image_files(&render_dir)?;
    if pages.is_empty() {
        used_render = false;
        pages = list_image_files(&source_dir)?;
    }
    if pages.is_empty() {
        return Err(Error::InvalidManifest {
            path: chapter_dir,
            reason: "no images in render/ or source/ for this chapter".into(),
        });
    }

    write_cbz(out_cbz, &pages, chapter, series, used_render)?;

    Ok(CbzExportResult {
        path: out_cbz.to_path_buf(),
        page_count: pages.len(),
        used_render,
    })
}

fn write_cbz(
    out_cbz: &Path,
    pages: &[PathBuf],
    chapter: &Chapter,
    series: &SeriesMeta,
    used_render: bool,
) -> Result<()> {
    let f = File::create(out_cbz).map_err(|e| Error::io(out_cbz, e))?;
    let mut zip = zip::ZipWriter::new(f);
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored); // images already compressed

    let mut buf = Vec::with_capacity(512 * 1024);
    for (i, page) in pages.iter().enumerate() {
        let ext = page
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        // Zero-padded sequential names so reader sort order is stable
        // regardless of source filename quirks (e.g. mixing 2- and 3-
        // digit numbers).
        let name = format!("{:04}.{ext}", i + 1);

        let mut src = File::open(page).map_err(|e| Error::io(page, e))?;
        buf.clear();
        src.read_to_end(&mut buf).map_err(|e| Error::io(page, e))?;

        zip.start_file::<&str, ()>(&name, opts)
            .map_err(|e| Error::InvalidManifest {
                path: out_cbz.to_path_buf(),
                reason: format!("zip start_file failed: {e}"),
            })?;
        zip.write_all(&buf).map_err(|e| Error::io(out_cbz, e))?;
    }

    // ComicInfo.xml sidecar — read by Kavita / Komga / YACReader.
    let info = comic_info_xml(chapter, series, pages.len(), used_render);
    zip.start_file::<&str, ()>("ComicInfo.xml", opts)
        .map_err(|e| Error::InvalidManifest {
            path: out_cbz.to_path_buf(),
            reason: format!("zip start_file failed: {e}"),
        })?;
    zip.write_all(info.as_bytes())
        .map_err(|e| Error::io(out_cbz, e))?;

    zip.finish().map_err(|e| Error::InvalidManifest {
        path: out_cbz.to_path_buf(),
        reason: format!("zip finish failed: {e}"),
    })?;
    Ok(())
}

fn list_image_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(dir, e)),
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            match ext.as_deref() {
                Some("png") | Some("jpg") | Some("jpeg") | Some("webp") | Some("bmp") => Some(p),
                _ => None,
            }
        })
        .collect();
    paths.sort();
    Ok(paths)
}

fn comic_info_xml(
    chapter: &Chapter,
    series: &SeriesMeta,
    page_count: usize,
    used_render: bool,
) -> String {
    let series_title = xml_escape(&series.title);
    let chapter_title = xml_escape(chapter.title.as_deref().unwrap_or(""));
    let lang = xml_escape(&series.target_language);
    let notes_raw = if used_render {
        "Rendered by Koharu-TH"
    } else {
        "Raw source pages (not yet rendered)"
    };
    let notes = xml_escape(notes_raw);

    let number = format_chapter_number(chapter.chapter_number);

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Title>{chapter_title}</Title>
  <Series>{series_title}</Series>
  <Number>{number}</Number>
  <Count>-1</Count>
  <Volume>{volume}</Volume>
  <LanguageISO>{lang}</LanguageISO>
  <PageCount>{page_count}</PageCount>
  <Manga>YesAndRightToLeft</Manga>
  <Notes>{notes}</Notes>
</ComicInfo>
"#,
        volume = chapter.volume.unwrap_or(0),
    )
}

fn format_chapter_number(n: f64) -> String {
    if (n.fract()).abs() < f64::EPSILON {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use chrono::Utc;
    use tempfile::tempdir;

    #[test]
    fn export_picks_render_then_falls_back_to_source() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test Series", "0").unwrap();

        // Make a chapter folder with source/ pages but no render/.
        let chapter_dir = dir.path().join("chapters/ch01");
        let src = chapter_dir.join(SOURCE_SUBDIR);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("001.png"), &[0u8; 16]).unwrap();
        std::fs::write(src.join("002.png"), &[0u8; 16]).unwrap();

        let chapter = Chapter {
            id: 1,
            folder_path: "chapters/ch01".into(),
            chapter_number: 1.0,
            title: Some("Pilot".into()),
            volume: Some(1),
            status: crate::ChapterStatus::Pending,
            summary: None,
            notes: None,
            page_count: 2,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let conn = p.pool().get().unwrap();
        let series = crate::series::get(&conn).unwrap();

        let out = dir.path().join("ch01.cbz");
        let res = export_chapter(dir.path(), &chapter, &series, &out).unwrap();
        assert_eq!(res.page_count, 2);
        assert!(!res.used_render);
        assert!(out.exists());

        // Add a render/ page → next export should prefer render.
        let rdir = chapter_dir.join(RENDER_SUBDIR);
        std::fs::create_dir_all(&rdir).unwrap();
        std::fs::write(rdir.join("p01.png"), &[1u8; 16]).unwrap();

        let res2 = export_chapter(dir.path(), &chapter, &series, &out).unwrap();
        assert!(res2.used_render);
        assert_eq!(res2.page_count, 1);
    }

    #[test]
    fn export_fails_when_no_pages() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let chapter_dir = dir.path().join("chapters/empty");
        std::fs::create_dir_all(chapter_dir.join(SOURCE_SUBDIR)).unwrap();
        std::fs::create_dir_all(chapter_dir.join(RENDER_SUBDIR)).unwrap();

        let chapter = Chapter {
            id: 1,
            folder_path: "chapters/empty".into(),
            chapter_number: 1.0,
            title: None,
            volume: None,
            status: crate::ChapterStatus::Pending,
            summary: None,
            notes: None,
            page_count: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let conn = p.pool().get().unwrap();
        let series = crate::series::get(&conn).unwrap();

        let out = dir.path().join("empty.cbz");
        let r = export_chapter(dir.path(), &chapter, &series, &out);
        assert!(r.is_err());
    }
}
