//! Pack an open project (manifest + DB + chapters + reference + assets)
//! into a single deflate-compressed zip for backup or transfer.
//!
//! `export/` is intentionally excluded — those are derived artifacts
//! the user can regenerate, and including them tends to double the
//! archive size for nothing.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::manifest::MANIFEST_FILENAME;

/// Names of top-level directories that should NOT be included in the
/// backup. Everything else under the project root is packed verbatim.
const SKIP_DIRS: &[&str] = &["export", "target", "node_modules", ".git"];

/// Stream the project at `root` into a zip file at `out_zip`.
/// Returns the count of files written.
pub fn backup_to(root: &Path, out_zip: &Path) -> Result<usize> {
    let manifest_path = root.join(MANIFEST_FILENAME);
    if !manifest_path.exists() {
        return Err(Error::NotAProject(root.to_path_buf()));
    }

    let file = File::create(out_zip).map_err(|e| Error::io(out_zip, e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0usize;
    let mut buf = Vec::with_capacity(64 * 1024);
    for entry in walk_files(root)? {
        let rel = entry.strip_prefix(root).unwrap_or(&entry);
        let rel_str = rel
            .to_str()
            .ok_or_else(|| Error::InvalidManifest {
                path: entry.clone(),
                reason: "path is not valid UTF-8".into(),
            })?
            .replace('\\', "/");

        let mut f = File::open(&entry).map_err(|e| Error::io(&entry, e))?;
        buf.clear();
        f.read_to_end(&mut buf).map_err(|e| Error::io(&entry, e))?;

        zip.start_file(&rel_str, options).map_err(|e| Error::InvalidManifest {
            path: out_zip.to_path_buf(),
            reason: format!("zip start_file failed: {e}"),
        })?;
        zip.write_all(&buf).map_err(|e| Error::io(out_zip, e))?;
        count += 1;
    }

    zip.finish().map_err(|e| Error::InvalidManifest {
        path: out_zip.to_path_buf(),
        reason: format!("zip finish failed: {e}"),
    })?;
    Ok(count)
}

/// Depth-first walk that skips the `SKIP_DIRS` top-level entries.
fn walk_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| Error::io(&dir, e))?;
        for entry in entries.flatten() {
            let p = entry.path();
            let ft = entry.file_type().map_err(|e| Error::io(&p, e))?;
            // Only skip top-level matches; nested folders named "export"
            // (unlikely but possible) are kept.
            if dir == root {
                if let Some(name) = entry.file_name().to_str() {
                    if SKIP_DIRS.iter().any(|s| *s == name) {
                        continue;
                    }
                }
            }
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                out.push(p);
            }
            // Symlinks and other types are skipped.
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use std::io::Write as _;
    use tempfile::tempdir;

    #[test]
    fn backup_includes_manifest_db_chapters_excludes_export() {
        let src = tempdir().unwrap();
        let project = Project::create(src.path(), "Test", "0").unwrap();
        let root = project.root().to_path_buf();

        // Drop a fake chapter and a fake export file so we can assert
        // they end up in / out of the zip respectively.
        let chap = root.join("chapters").join("ch01.khr");
        let mut f = File::create(&chap).unwrap();
        write!(f, "fake-chapter-bytes").unwrap();

        let export_dir = root.join("export");
        std::fs::create_dir_all(&export_dir).unwrap();
        let exp = export_dir.join("page-001.png");
        let mut g = File::create(&exp).unwrap();
        write!(g, "fake-rendered").unwrap();

        let out_zip = src.path().join("backup.zip");
        let count = backup_to(&root, &out_zip).unwrap();
        assert!(count > 0, "should pack at least the manifest + db");

        // Crack open the archive and check contents.
        let f = File::open(&out_zip).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == MANIFEST_FILENAME));
        assert!(names.iter().any(|n| n == "series.db"));
        assert!(names.iter().any(|n| n == "chapters/ch01.khr"));
        assert!(
            !names.iter().any(|n| n.starts_with("export/")),
            "export/ should be skipped, got {names:?}"
        );
    }
}
