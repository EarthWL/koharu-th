//! Content-addressed binary store.
//!
//! Every chunk of binary data (page image, segmentation mask,
//! inpainted output, rendered overlay, chat attachment) is keyed by
//! its blake3 hash. Identical bytes → identical id → one storage
//! entry. This is the foundation that lets a single source page used
//! across two chapters dedup to one blob.
//!
//! Phase 1 ships the in-memory implementation. Phase 2 adds an
//! optional on-disk backing under `<project>/blobs/` keyed by hex of
//! the hash; the in-memory cache becomes a read-through layer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 32-byte blake3 digest. Newtype rather than bare array so the
/// "this is a blob hash, not arbitrary bytes" intent is visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlobId(#[serde(with = "serde_bytes_array")] pub [u8; 32]);

impl BlobId {
    /// Hex string of the digest — used as filename on the on-disk
    /// backing and for human-readable logs.
    pub fn to_hex(self) -> String {
        let mut out = String::with_capacity(64);
        for b in self.0 {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }
}

/// Serde adapter for `[u8; 32]` — serde doesn't derive Serialize for
/// fixed-size byte arrays natively, so we coerce to/from `Vec<u8>`.
mod serde_bytes_array {
    use serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        value.as_slice().serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let v: Vec<u8> = Vec::deserialize(d)?;
        v.try_into()
            .map_err(|_| D::Error::custom("BlobId must be exactly 32 bytes"))
    }
}

#[derive(Debug, Error)]
pub enum BlobError {
    #[error("blob {0:?} not found in store")]
    NotFound(BlobId),
    #[error("io error while reading blob backing: {0}")]
    Io(#[from] std::io::Error),
}

/// In-process content-addressed binary store.
///
/// Backed by an `HashMap<BlobId, Arc<[u8]>>` so multiple readers
/// share the same allocation without copying. Wrapped in `RwLock`
/// because puts are rare (per page-import or per pipeline-stage
/// completion) and gets are frequent (every render tick).
#[derive(Clone)]
pub struct BlobStore {
    inner: Arc<RwLock<HashMap<BlobId, Arc<[u8]>>>>,
    /// Optional on-disk directory for persistence beyond process
    /// lifetime. `None` = pure in-memory (testing / scratch).
    ///
    /// Currently unread — the on-disk read/write path lands in
    /// Phase 2 (when `BlobStore` is wired into the serialization
    /// boundary). The field is here so the in-memory `BlobStore`
    /// shape doesn't shift under callers between phases.
    #[allow(dead_code)]
    backing_dir: Option<PathBuf>,
}

impl BlobStore {
    /// In-memory store with no on-disk backing. Use for tests + the
    /// transient blobs that don't outlive the session.
    pub fn in_memory() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            backing_dir: None,
        }
    }

    /// Store with on-disk backing under `dir`. On `put`, bytes are
    /// also written to `dir/<hex>`. On `get`, in-memory cache is
    /// checked first; falls through to disk if miss.
    pub fn with_backing(dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            backing_dir: Some(dir),
        }
    }

    /// Hash the bytes, store them, return the id. Idempotent: if the
    /// same bytes are put twice the second put is a cheap re-insert
    /// into the same key.
    pub fn put(&self, bytes: Vec<u8>) -> BlobId {
        let hash = blake3::hash(&bytes);
        let id = BlobId(*hash.as_bytes());
        let arc: Arc<[u8]> = bytes.into();
        self.inner.write().insert(id, arc);
        // On-disk backing write is Phase 2 work — leave the hook
        // here so the in-memory shape is final.
        id
    }

    /// Fetch the bytes. Returns `None` if not present.
    pub fn get(&self, id: BlobId) -> Option<Arc<[u8]>> {
        self.inner.read().get(&id).cloned()
    }

    /// Cheap existence check without cloning the Arc.
    pub fn exists(&self, id: BlobId) -> bool {
        self.inner.read().contains_key(&id)
    }

    /// Number of distinct blobs stored — useful for dedup metrics.
    pub fn len(&self) -> usize {
        self.inner.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.read().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_roundtrip() {
        let store = BlobStore::in_memory();
        let id = store.put(b"hello world".to_vec());
        let got = store.get(id).expect("blob present");
        assert_eq!(got.as_ref(), b"hello world");
    }

    #[test]
    fn put_is_dedup() {
        let store = BlobStore::in_memory();
        let id1 = store.put(b"same bytes".to_vec());
        let id2 = store.put(b"same bytes".to_vec());
        assert_eq!(id1, id2, "blake3 of equal bytes must equal");
        assert_eq!(store.len(), 1, "duplicate put must not grow the map");
    }

    #[test]
    fn different_bytes_different_id() {
        let store = BlobStore::in_memory();
        let id1 = store.put(b"foo".to_vec());
        let id2 = store.put(b"bar".to_vec());
        assert_ne!(id1, id2);
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn hex_format_is_64_chars() {
        let store = BlobStore::in_memory();
        let id = store.put(b"x".to_vec());
        assert_eq!(id.to_hex().len(), 64);
    }

    #[test]
    fn blob_id_serde_round_trip() {
        let store = BlobStore::in_memory();
        let id = store.put(b"y".to_vec());
        let s = serde_json::to_string(&id).unwrap();
        let id2: BlobId = serde_json::from_str(&s).unwrap();
        assert_eq!(id, id2);
    }
}
