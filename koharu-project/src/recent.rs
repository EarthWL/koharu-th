//! Recently-opened projects, stored as a small JSON file in the app
//! data directory. Read/written on demand — there's no in-memory
//! cache because the file is tiny and the ops aren't hot-path.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const MAX_ENTRIES: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    /// Absolute path to the project root (the folder containing
    /// `series.koharuproj`).
    pub path: PathBuf,
    /// Display name pulled from the manifest at the time we recorded.
    pub name: String,
    /// Unix epoch seconds. Newest first when listed.
    pub last_opened_at: i64,
}

/// Read the list. Returns an empty list if the file is missing or
/// unparseable (forward-compat — old/corrupt entries don't break the
/// app). Entries are returned newest-first.
pub fn list(store: &Path) -> Result<Vec<RecentProject>> {
    let bytes = match std::fs::read(store) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(store, e)),
    };
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

/// Push `entry` to the top of the list (deduping by canonical path).
/// Older entries beyond `MAX_ENTRIES` are pruned.
pub fn push(store: &Path, entry: RecentProject) -> Result<()> {
    let mut entries = list(store)?;
    let key = canonicalize_for_compare(&entry.path);
    entries.retain(|e| canonicalize_for_compare(&e.path) != key);
    entries.insert(0, entry);
    entries.truncate(MAX_ENTRIES);
    write(store, &entries)
}

/// Remove the entry matching `path` (if any). Returns true if removed.
pub fn remove(store: &Path, path: &Path) -> Result<bool> {
    let mut entries = list(store)?;
    let key = canonicalize_for_compare(path);
    let before = entries.len();
    entries.retain(|e| canonicalize_for_compare(&e.path) != key);
    if entries.len() == before {
        return Ok(false);
    }
    write(store, &entries)?;
    Ok(true)
}

fn write(store: &Path, entries: &[RecentProject]) -> Result<()> {
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
    }
    let bytes = serde_json::to_vec_pretty(entries)?;
    std::fs::write(store, bytes).map_err(|e| Error::io(store, e))
}

/// Normalise a path for equality: try canonicalize() (resolves
/// symlinks + relative parts), fall back to the raw path so a
/// not-yet-existing or stale entry still matches itself.
fn canonicalize_for_compare(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn entry(name: &str, path: &Path, ts: i64) -> RecentProject {
        RecentProject {
            path: path.to_path_buf(),
            name: name.into(),
            last_opened_at: ts,
        }
    }

    #[test]
    fn missing_file_returns_empty_list() {
        let dir = tempdir().unwrap();
        let store = dir.path().join("recent.json");
        assert!(list(&store).unwrap().is_empty());
    }

    #[test]
    fn push_dedupes_and_caps_length() {
        let dir = tempdir().unwrap();
        let store = dir.path().join("recent.json");

        let p1 = dir.path().join("proj-a");
        let p2 = dir.path().join("proj-b");
        push(&store, entry("A", &p1, 100)).unwrap();
        push(&store, entry("B", &p2, 200)).unwrap();
        push(&store, entry("A again", &p1, 300)).unwrap();

        let listed = list(&store).unwrap();
        // A re-pushed → moves to top, dedupes the first entry.
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "A again");
        assert_eq!(listed[0].last_opened_at, 300);
        assert_eq!(listed[1].name, "B");

        // Stuff way more than the cap and verify pruning.
        for i in 0..30 {
            let p = dir.path().join(format!("proj-{i}"));
            push(&store, entry(&format!("P{i}"), &p, 1000 + i as i64)).unwrap();
        }
        assert_eq!(list(&store).unwrap().len(), MAX_ENTRIES);
    }

    #[test]
    fn remove_strips_entry() {
        let dir = tempdir().unwrap();
        let store = dir.path().join("recent.json");
        let p = dir.path().join("proj-x");
        push(&store, entry("X", &p, 1)).unwrap();
        assert_eq!(list(&store).unwrap().len(), 1);
        assert!(remove(&store, &p).unwrap());
        assert!(list(&store).unwrap().is_empty());
        // Removing again is a no-op.
        assert!(!remove(&store, &p).unwrap());
    }
}
