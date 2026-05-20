//! Crash-safe file writes.
//!
//! `std::fs::write` truncates the target, then streams bytes in. A
//! crash or power loss between truncate and the final byte leaves a
//! torn / empty file on disk — for the project manifest or the recent-
//! projects list that means a corrupted project or a wiped MRU list
//! (issue #49).
//!
//! `atomic_write` instead writes to a sibling temp file, fsyncs it,
//! then renames it over the target. Rename is atomic on the same
//! filesystem, so a reader/observer ever sees only the complete old
//! file or the complete new one — never a partial write. The temp file
//! lives in the *same directory* as the target so the rename stays on
//! one volume (cross-volume rename is a copy + is not atomic).

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Per-process counter so concurrent `atomic_write` calls to different
/// targets never collide on the same temp filename.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Durably + atomically write `bytes` to `path`.
///
/// The parent directory must already exist (callers that can't
/// guarantee that should `create_dir_all` first). On error the temp
/// file is best-effort removed.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("koharu");
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{stem}.{}.{counter}.tmp", std::process::id()));

    // Write + fsync inside a scope so the handle is closed before the
    // rename — Windows refuses to rename a file that still has an open
    // handle.
    let write_result = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
        // fsync: force the bytes to stable storage before we swap the
        // file in, so a power loss right after the rename can't surface
        // a rename-to-empty-file.
        f.sync_all()
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_then_reads_back() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.json");
        atomic_write(&p, b"hello").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"hello");
    }

    #[test]
    fn overwrites_existing_atomically() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.json");
        fs::write(&p, b"old-contents-longer").unwrap();
        atomic_write(&p, b"new").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
    }

    #[test]
    fn leaves_no_temp_files_behind() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.json");
        atomic_write(&p, b"x").unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }
}
