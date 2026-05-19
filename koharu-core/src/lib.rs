//! koharu-core — shared primitives for the v2 architecture refactor.
//!
//! See `docs/v2-arch.md` (on `main`) for the full design rationale,
//! including §12 "Design changelog" which logs every amendment to
//! the locked spec. Phase 1 + 1.1 ship the substrate; Phase 2+
//! consumes it (BlobStore HTTP wire, Engine trait, ProjectSession).
//!
//! ## Module map
//!
//! - [`id`]         — newtype wrappers (`PageId`, `NodeId`, `TmEntryId`)
//! - [`blob`]       — content-addressed `BlobStore` (blake3-hashed)
//! - [`scene`]      — page model: `Scene` → `Page` → `TextBlock`
//! - [`op`]         — `Op` enum (Scene mutations) + `EngineResult`
//! - [`op_project`] — `ProjectOp` enum (project entity mutations)
//! - [`artifact`]   — `ArtifactKind` (engine consumes/produces declaration)
//! - [`settings`]   — `SettingDescriptor` (engine config schema)
//! - [`hardware`]   — `HardwareReq`, `DetectedHardware`, `EngineCost`
//!
//! All public types are `Serialize + Deserialize` so the same shapes
//! traverse the RPC layer (frontend ↔ backend), the on-disk
//! persistence layer (`koharu-project` SQLite), and the in-memory
//! event bus.

pub mod artifact;
pub mod blob;
pub mod hardware;
pub mod id;
pub mod op;
pub mod op_project;
pub mod scene;
pub mod settings;

pub use artifact::ArtifactKind;
pub use blob::{BlobId, BlobStore};
pub use hardware::{
    BackendSupport, CompatibilityCheck, DetectedHardware, EngineCost, GpuVendor, HardwareReq,
};
pub use id::{NodeId, PageId, TmEntryId};
pub use op::{EngineResult, Op, TextBlockPatch};
pub use op_project::{
    CharacterAdd, CharacterAlias, CharacterId, CharacterPatch, GlossaryAdd, GlossaryCategory,
    GlossaryConfidence, GlossaryEntryId, GlossaryPatch, ProjectOp, SeriesMetaPatch,
};
pub use scene::{FontPrediction, Page, Region, Scene, TextBlock, TextStyle};
pub use settings::{SettingDescriptor, SettingValue, StoredValue};
