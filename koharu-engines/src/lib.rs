//! koharu-engines — the engine plugin system for v2.
//!
//! See `docs/v2-arch.md` §4.4 (on `main`) for the locked design,
//! including the post-#33 re-review issues E–J that shaped the
//! current trait surface (cancellation via `CancellationToken`,
//! streaming via `mpsc::Sender<EngineResult>`, read-only
//! `ProjectView` instead of `&ProjectSession`, etc.).
//!
//! ## Module map
//!
//! - [`engine`] — `Engine` async trait + `EngineCtx` (per-run handle
//!   threaded through `run`) + `setting::<T>` helper.
//! - [`info`]   — `EngineInfo` static descriptor + `inventory`
//!   registry so engines self-register at compile time
//!   (`inventory::submit!`).
//!
//! ## Scope of Phase 3.1
//!
//! This commit ships the **scaffold only** — trait + types + registry
//! plumbing. No concrete engine impls yet. Phase 3.3 ports the
//! comic-text-detector as the first engine (proof-of-concept). Phase
//! 4 ports the remaining five stages (segment/ocr/inpaint/translate/
//! render) and deletes the legacy direct-call path in
//! `koharu-pipeline`.
//!
//! The **DAG resolver** that derives execution order from each
//! engine's `consumes` / `produces` `ArtifactKind` declaration is
//! intentionally **not** in Phase 3 — with only one engine in the
//! system there's no order to derive. Phase 4 lands the resolver
//! alongside the multi-engine migration where it earns its keep.
//!
//! ## Design pinning
//!
//! - `Engine` is `async_trait`-flavoured for `dyn`-compatibility:
//!   `inventory::collect!(EngineInfo)` stores erased `load`
//!   constructors that return `Box<dyn Engine>`. Native AFIT
//!   (Rust 1.75+) returns an opaque `impl Future` that isn't
//!   dyn-compatible without `dyn*` (unstable) or RPITIT wrapping.
//!   `async_trait` is the pragmatic default; we can migrate later
//!   once dyn-compat AFIT stabilises.
//! - `Send + Sync + 'static` bound on `Engine` so the driver can
//!   hand engines off to spawned tasks freely.
//! - All cross-crate types ride on `koharu-core` (Op, Scene,
//!   BlobStore, ProjectView, PipelineRunOptions, ArtifactKind,
//!   SettingDescriptor, HardwareReq, EngineCost) — keeps this crate
//!   thin on the data side and lets the koharu-core proptests cover
//!   the wire shape.

pub mod engine;
pub mod info;

pub use engine::{Engine, EngineCtx};
pub use info::EngineInfo;

/// Re-export `inventory` so engine modules in OTHER crates can write
/// `koharu_engines::inventory::submit! { koharu_engines::EngineInfo { … } }`
/// without taking a direct `inventory` dep themselves.
pub use inventory;
