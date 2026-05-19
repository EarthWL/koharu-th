//! koharu-core — shared primitives for the v2 architecture refactor.
//!
//! See `docs/v2-arch.md` (on `main`) for the full design rationale.
//! This crate intentionally has **no consumers yet** in Phase 1 — it
//! lands the new substrate without disturbing existing code. Phase 2
//! wires `BlobStore` into the serialization boundary; Phase 3 brings
//! in the Engine trait (in `koharu-engines`, a separate crate).
//!
//! ## Module map
//!
//! - [`id`]      — newtype wrappers for `PageId`, `NodeId`, `TmEntryId`
//! - [`blob`]    — content-addressed `BlobStore` (blake3-hashed)
//! - [`scene`]   — page model: `Scene` → `Page` → `TextBlock`
//! - [`op`]      — `Op` enum (the unit of state change) + `OpInverse`
//! - [`hardware`] — `HardwareReq`, `DetectedHardware`, `EngineCost`
//!
//! All public types are `Serialize + Deserialize` so the same shapes
//! traverse the RPC layer (frontend ↔ backend) and the on-disk
//! persistence layer (`koharu-project` SQLite blob columns).

pub mod blob;
pub mod hardware;
pub mod id;
pub mod op;
pub mod scene;

pub use blob::{BlobId, BlobStore};
pub use hardware::{
    BackendSupport, CompatibilityCheck, DetectedHardware, EngineCost, GpuVendor, HardwareReq,
};
pub use id::{NodeId, PageId, TmEntryId};
pub use op::{Op, TextBlockPatch};
pub use scene::{FontPrediction, Page, Region, Scene, TextBlock, TextStyle};
