# v2 architecture refactor — design doc

**Status**: design locked, implementation pending
**Branch**: `arch/v2-foundation` (worktree at `../koharu-th-v2/`)
**Base tag**: `arch/v2-base` (anchored at the commit this doc lands on)
**Target release**: `v2.0.0`
**Estimated effort**: ~4-5 months
**Last updated**: 2026-05-19

This document is the **single source of truth** for the v2 rebuild.
Decisions captured here are locked unless the doc is amended via PR.
Progress (which phase we're in, what's done, what's blocked) lives in
the sibling [`v2-progress.md`](./v2-progress.md) on the branch.

> **Design changelog**: amendments to locked decisions are logged
> at the bottom of this doc (§12). Read there first if you're
> coming back to the design after a break — it tells you what
> changed and why, so you don't have to re-read the whole doc.

---

## 1. Why we're doing this

Upstream `mayocream/koharu` evolved 0.37.0 → 0.59.x with **485
commits** introducing structural changes worth adopting as
foundation:

- **`koharu-core` crate**: shared `Op`, `Scene`, `BlobStore`,
  `events`, `protocol` primitives
- **Engine trait + DAG resolver + inventory registry**: pluggable
  ML pipeline stages that emit `Vec<Op>` rather than mutating state
- **Op-based state model**: enables undo/redo, autosave coherence,
  cross-component event subscription, time-travel debugging
- **BlobStore**: binary content addressed by hash, separates large
  data from metadata, deduplicates page bytes shared across chapters

We are **NOT** doing a full upstream sync. We keep `koharu-project`
(per-folder SQLite, glossary, characters, TM, prompts, cost log) as
the heart of the fork. The new substrate must accommodate
project-aware engines from day one.

We are **NOT** adopting Codex img2img, layered PSD export, or
multi-user collab CRDT machinery. Standalone-first product
philosophy stays.

The user-facing payoff:

1. **Undo/redo** (per-chapter session) — a top user request
2. **User-selectable engines** per pipeline stage with hardware-
   awareness — fork's product differentiator vs upstream's "one
   binary fits all"
3. **Cheap backports of upstream ML models** (paddleocr-vl-1.5,
   manga-text-segmentation-2025, AOT inpaint, Flux.2 Klein) as
   register-an-engine tasks instead of pipeline rewrites
4. **Autosave coherence** — the audit cycle showed sync queues are
   fragile; Op-based state with event bus replaces the manual
   debouncing
5. **Foundation for future features** without architectural debt:
   plugin engines, real-time pipeline streaming, deeper QC tools

---

## 2. Locked decisions

These are settled. Changing any requires updating this doc.

| Decision | Choice | Implication |
|---|---|---|
| Concurrency model | **Linear history (single-user)** | No CRDT, no operational transform, no conflict resolution. Op design simpler by ~half. |
| Undo scope | **Per-chapter session** | In-memory ring buffer (~50-100 ops cap), clears on app close / chapter switch / project close. ~2 weeks effort. |
| Engine profile scope | **Machine-wide** | One profile per device, all projects share. Stored in app preferences (not in `series.db`). |
| Hardware probe behaviour | **Auto-detect + recommend + warning on over-spec, never lock** | At first launch: detect GPU, VRAM, CUDA cap → propose profile. User can override; if pick exceeds detected VRAM, surface warning callout but allow proceed. |
| Op log persistence | **In-memory only** (session undo) | User-edits (text-block translation, glossary edit, etc.) still go through SQLite as regular writes. Op log doesn't persist across app restart. |
| Migration strategy v1 → v2 | **Atomic migration script with `.bak` backup** | On first open of a v1 `.koharuproj` with v2 binary: copy series.db → series.db.bak, run migration transaction (rollback whole thing if any step fails), update schema_version. |
| `koharu-project` placement | **Stays orthogonal — not folded into `koharu-app`** | Project layer is fork-exclusive; upstream has nothing equivalent. Keep it cleanly isolated so future fork-only features (multi-project workspace, etc.) don't pollute the upstream-aligned core. |
| Cherry-pick policy during branch life | **main → branch only**, weekly rebase | Branch never sends commits back to main until RC merge. Main bug fixes flow into branch via `git cherry-pick -x` weekly. |
| Worktree layout | `koharu-0.37.0/` (main) + `koharu-th-v2/` (branch) at sibling paths | Each has its own `target/`, `node_modules/`, `.next/`. Disk cost ~30-50GB extra for `target/`. Worth it. |
| CI on branch | **Re-enable matrix CI on the branch only** | Refactor needs safety net. Main stays Actions-off (macOS 10× cost). Branch CI gates merge-back. |
| Testing | **`proptest` + integration-tests crate from day 1** | Op-based state enables property testing (apply ∘ undo ∘ apply = apply). New crate `tests/integration` modelled after upstream's. |
| Blob transport (frontend ↔ backend) | **HTTP GET `/blob/:hex` with `Cache-Control: immutable`**, NOT WS-RPC | Browser-native GPU-accelerated decode, automatic HTTP cache (content-addressed = immutable), parallel fetch. Adds one route to the existing Axum server; no msgpack serialization of bitmap bytes. See [#33](https://github.com/EarthWL/koharu-th/issues/33). |

---

## 3. Crate layout (after refactor)

```
koharu-core/        ⭐ NEW — Op + Scene + BlobStore + HardwareReq + protocol
koharu-engines/     ⭐ NEW — Engine trait + DAG resolver + inventory registry
                            + concrete engines (detector, ocr, inpaint, ...)
koharu-app/         ⭐ NEW — ProjectSession (Op apply), event bus, undo history,
                            autosave coordinator
koharu-project/         (unchanged) — SQLite persistence, glossary, characters,
                            TM, prompts, cost log
koharu-runtime/         (unchanged) — CUDA/Metal abstraction
koharu-renderer/        (unchanged) — text rendering (Thai-aware additions kept)
koharu-ml/              (unchanged) — model weights, loading, candle bindings
koharu-rpc/             (unchanged) — RPC layer (~60 tools)
koharu-api/             (unchanged) — API contracts / DTOs
koharu-http/            (unchanged) — HTTP server (UI-facing)
koharu-types/           (likely deprecated) — types move into koharu-core; this
                            crate may be deleted after migration
koharu/                 (binary)  — thin entry point
tests/integration/  ⭐ NEW — end-to-end pipeline regression tests against golden
                            pages
```

**Notes on the split**:
- `koharu-engines/` is the fork's name for what upstream calls
  `koharu-app/src/pipeline/`. Separate crate so engines are pluggable
  in the literal Cargo sense (a future user-installable engine could
  ship as its own crate, depend on `koharu-engines`, register via
  `inventory::submit!`).
- `koharu-app/` only contains session/history/event-bus logic, NOT
  the pipeline (which lives in `koharu-engines/`). This differs from
  upstream's layout deliberately — the fork's "app layer" is thinner
  because `koharu-project` already owns project state.
- `koharu-types` deprecation is a downstream cleanup. Defer until
  end of Phase 4 to avoid churn during engine porting.

---

## 4. Core types (sketch)

These are **sketches** for design alignment, not final API. Phase 1
will finalise these in `koharu-core/src/`.

### 4.1 `Op` and `ProjectOp` — units of state change

**Amended 2026-05-19** after design re-review (issues A–F below).
Original spec wedged everything into one `Op` enum + an `OpInverse`
trait. Both were wrong in load-bearing ways. New shape:

```rust
// koharu-core/src/op.rs

use serde::{Serialize, Deserialize};

/// Scene-layer mutations — page geometry, text blocks, pipeline
/// artifacts. Anything that lives in `Scene` (read model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Op {
    /// Batch of ops applied atomically. Engines never emit Batch
    /// directly — the driver wraps the engine's `Vec<Op>` return
    /// as a single Batch before handing to `ProjectSession`.
    Batch(Vec<Op>),

    // ── Scene structure ──────────────────────────────────────
    AddPage { id: PageId, image: BlobId, width: u32, height: u32 },
    RemovePage { id: PageId },
    UpdatePageImage { id: PageId, image: BlobId },

    // ── Text block lifecycle ─────────────────────────────────
    AddTextBlock { page: PageId, id: NodeId, region: Region, source_lang: Option<String> },
    UpdateTextBlock { page: PageId, id: NodeId, patch: TextBlockPatch },
    RemoveTextBlock { page: PageId, id: NodeId },

    // ── Pipeline artifacts ───────────────────────────────────
    SetSegmentationMask { page: PageId, mask: Option<BlobId> },
    SetInpaintedImage { page: PageId, image: Option<BlobId> },
    SetRenderedImage { page: PageId, image: Option<BlobId> },
    SetBrushLayer { page: PageId, brush: Option<BlobId> },
    // `NoteTmHit` REMOVED — see issue B below.
}

/// Project-layer mutations — characters, glossary, prompt templates,
/// series meta, TM. These live in `koharu-project` (SQLite), NOT
/// in `Scene`. Separated from `Op` so engines can emit both kinds in
/// one atomic apply (driver groups them; SQLite transaction wraps
/// the whole batch).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProjectOp {
    AddCharacter { input: CharacterAddInput },
    UpdateCharacter { id: i64, patch: CharacterPatch },
    RemoveCharacter { id: i64 },

    AddGlossaryEntry { input: GlossaryAddInput },
    UpdateGlossaryEntry { id: i64, patch: GlossaryPatch },
    RemoveGlossaryEntry { id: i64 },

    UpdateSeriesMeta { patch: SeriesMetaPatch },

    UpdatePromptTemplate { use_case: String, body: String },
    // TM rows are append-only via `TmHit` events on the bus,
    // not mutated through ProjectOp — keeps the cache write path
    // out of the undo log (don't want every cached translation
    // to consume an undo slot).
}

/// Engine return shape — both Scene and Project ops emitted in one
/// atomic step.
pub struct EngineResult {
    pub scene_ops: Vec<Op>,
    pub project_ops: Vec<ProjectOp>,
}
```

#### Issues caught in re-review (2026-05-19, post-#33)

**A. `Batch` inverse can't be computed from a single `before`
snapshot.** The middle Op of `Batch([A, B, C])` needs the Scene
state AFTER A applied, not the original `before`. The
`OpInverse::inverse(&self, before: &Scene) -> Op` trait signature
hid this.

→ **Resolution**: Drop the `OpInverse` trait. Compute inverses
**inline at apply time** in `ProjectSession::apply()` — the driver
walks the Scene as it applies each Op, captures the per-Op inverse
against the just-mutated state, stores `(op, captured_inverse)`
pairs in history. Single computation, no trait gymnastics, correct
for Batch.

**B. `NoteTmHit` doesn't fit the "Op = state change" model.** It's
pure annotation (TM cache hit happened); no meaningful inverse.

→ **Resolution**: Remove from `Op`. Surface via the event bus
(Phase 5) as `SessionEvent::TmHit { page, node, tm_entry }`. Cost
dashboard + UI subscribers can react; nothing enters the undo log.

**C. No-op Ops would pollute the history ring.** Applying
`SetInpaintedImage { image: None }` when the image is already
`None` is a no-op, but would still consume an undo slot.

→ **Resolution**: `ProjectSession::apply()` runs a cheap
before-vs-after diff per Op; if unchanged, drop the Op silently
(don't push to history, don't publish event). Filter step happens
before history insertion.

**D. `RemovePage` undo capture cost is large but tractable.**
A removed page's inverse needs all its text blocks + artifact blob
references. For a heavy chapter (100 pages × ~20 MB rendered each
in worst case) this could be 2 GB of captured inverse state.

→ **Resolution**: Captured inverse stores `BlobId` references, NOT
blob bytes. The `BlobStore` already keeps the bytes alive (one
copy, dedup'd by hash); inverse only needs the hash to reconstitute.
Acceptable cost: ~32 bytes per blob ref × 100 ops = trivial.

**E. `Set*` variants were `BlobId`, not `Option<BlobId>`.** Made it
impossible to clear an artifact (e.g. retranslate flow that wipes
the rendered image to force re-render).

→ **Resolution**: All four `Set*` variants now `Option<BlobId>`.
`None` clears, `Some(blob)` sets. Aligns with `TextBlockPatch`'s
three-state pattern.

**F. Engines couldn't mutate project entities (characters,
glossary, series_meta).** Forced the extract-entities flow to call
into `koharu-project` directly, breaking the
"engines-emit-ops-never-mutate" invariant.

→ **Resolution**: New `ProjectOp` enum (above) + engines return
`EngineResult { scene_ops, project_ops }`. Driver applies both in
one SQLite transaction wrapping the in-memory Scene mutation.
Undo of an extract-entities run reverses both the Scene side
(added text-block translations) AND the Project side (added
character/glossary rows).

```rust
// koharu-app/src/session.rs — applies ops + captures inverses
impl ProjectSession {
    pub fn apply(&self, ops: EngineResult) -> Result<()> {
        let tx = self.project.begin_tx()?;  // SQLite transaction
        let mut scene = self.scene.write();

        let mut inverse_scene_ops = Vec::with_capacity(ops.scene_ops.len());
        for op in &ops.scene_ops {
            if let Some(inv) = scene.apply_with_inverse(op)? {
                inverse_scene_ops.push(inv);    // skips no-ops (Issue C)
            }
        }

        let mut inverse_project_ops = Vec::with_capacity(ops.project_ops.len());
        for op in &ops.project_ops {
            if let Some(inv) = project::apply_with_inverse(&tx, op)? {
                inverse_project_ops.push(inv);
            }
        }

        tx.commit()?;
        if !inverse_scene_ops.is_empty() || !inverse_project_ops.is_empty() {
            self.history.write().push(HistoryEntry {
                forward: ops,
                inverse: EngineResult {
                    scene_ops: inverse_scene_ops.into_iter().rev().collect(),
                    project_ops: inverse_project_ops.into_iter().rev().collect(),
                },
            });
            self.bus.publish(SessionEvent::OpsApplied);
        }
        Ok(())
    }
}
```

### 4.2 `Scene` — the page model (read-only from engine POV)

```rust
// koharu-core/src/scene.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub pages: IndexMap<PageId, Page>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub id: PageId,
    pub source_image: BlobId,
    pub width: u32,
    pub height: u32,

    pub text_blocks: IndexMap<NodeId, TextBlock>,

    // Pipeline-produced artifacts (Option = stage not yet run)
    pub segmentation_mask: Option<BlobId>,
    pub inpainted_image: Option<BlobId>,
    pub rendered_image: Option<BlobId>,
    pub brush_layer: Option<BlobId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextBlock {
    pub id: NodeId,
    pub region: Region,
    pub source_text: Option<String>,
    pub translation: Option<String>,
    pub style: Option<TextStyle>,
    pub source_lang: Option<String>,
    pub font_prediction: Option<FontPrediction>,
}
```

### 4.3 `BlobStore` — content-addressed binary store

```rust
// koharu-core/src/blob.rs

pub type BlobId = [u8; 32]; // Blake3 hash

pub struct BlobStore {
    inner: Arc<RwLock<HashMap<BlobId, Arc<[u8]>>>>,
    backing_dir: Option<PathBuf>, // None = in-memory only
}

impl BlobStore {
    pub fn put(&self, bytes: Vec<u8>) -> BlobId { /* blake3 → cache */ }
    pub fn get(&self, id: BlobId) -> Option<Arc<[u8]>>;
    pub fn exists(&self, id: BlobId) -> bool;
}
```

**Key property**: Same image bytes used on two pages → one storage
entry. Currently `Document.image: Uint8Array` duplicates per page.

### 4.4 `Engine` trait + `EngineCtx` (fork-flavoured)

**Amended 2026-05-19** after design re-review (issues E–J below).
Original spec had 6 load-bearing problems that would have surfaced
during Phase 4 engine porting and forced rework. New shape:

```rust
// koharu-engines/src/engine.rs

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait Engine: Send + Sync + 'static {
    /// Run the engine for one page. Emit ops via `ops_tx` as work
    /// progresses — driver applies in batches as they arrive, so
    /// long-running engines (translate, multi-stage segmentation)
    /// can stream partial results to the UI instead of blocking
    /// the page until done.
    ///
    /// Engines that don't need streaming just send one final
    /// `EngineResult` at the end. Driver wraps each send as a
    /// `Batch` Op before applying.
    ///
    /// Returns Ok(()) on success; Err on engine failure (driver
    /// surfaces in ActivityBubble). Cancellation via
    /// `ctx.cancel.is_cancelled()` returns Ok(()) cleanly — driver
    /// drops the in-flight ops, history isn't polluted.
    async fn run(
        &self,
        ctx: EngineCtx<'_>,
        ops_tx: mpsc::Sender<EngineResult>,
    ) -> Result<()>;
}

pub struct EngineCtx<'a> {
    pub scene: &'a Scene,
    pub page: PageId,

    /// Read-only project view — glossary, characters, prompt
    /// templates, series metadata, TM lookup primitive. Engine
    /// can READ but never mutate; mutation happens via the
    /// `ProjectOp` variants in the returned `EngineResult`.
    /// (Was `&ProjectSession` in the original spec — issue F.)
    pub project: &'a ProjectView,

    pub blobs: &'a BlobStore,
    pub runtime: &'a RuntimeManager,
    pub llm: &'a llm::Model,
    pub renderer: &'a renderer::Renderer,

    /// Per-run options threaded from the pipeline driver. Engine
    /// reads settings via `ctx.setting::<T>("key")` — driver loads
    /// the typed value from the engine's settings store using the
    /// schema declared on `EngineInfo`. (Issue J.)
    pub options: &'a PipelineRunOptions,

    /// Cancellation primitive. Use `tokio::select!` to interrupt
    /// long awaits, or `ctx.cancel.is_cancelled()` for cooperative
    /// checking. (Was `&AtomicBool` in the original spec — issue G.)
    pub cancel: &'a CancellationToken,
}

impl EngineCtx<'_> {
    /// Typed setting lookup. Driver pre-loads the engine's settings
    /// store into a typed map before calling `run`. Panics on schema
    /// mismatch (caught in dev; engine declares schema, driver
    /// validates).
    pub fn setting<T: SettingValue>(&self, key: &str) -> T { /* … */ }
}

pub struct EngineInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,

    /// Artifacts this engine consumes (must exist on Scene before
    /// run) and produces (will exist after run). DAG resolver
    /// derives execution order from the produces/consumes graph;
    /// one engine can cover multiple traditional stages (e.g.
    /// Anime Text YOLO produces both DetectionBoxes AND
    /// SegmentationMask in one pass). (Was a rigid PipelineStage
    /// enum in the original spec — issue I.)
    pub consumes: &'static [ArtifactKind],
    pub produces: &'static [ArtifactKind],

    /// User-configurable settings exposed in the Engine Profile UI.
    /// UI auto-generates form controls from this schema; engine
    /// reads typed values via `ctx.setting::<T>(key)` at run time.
    /// Plugin engines ship their own schema → no UI work per engine.
    /// (Issue J — drives Profile UI for #18, #31, future engines.)
    pub settings_schema: &'static [SettingDescriptor],

    pub hardware: HardwareReq,
    pub cost: EngineCost,

    pub load: fn() -> BoxedFuture<Box<dyn Engine>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    SourceImage,           // always present per page (the raw scan)
    DetectionBoxes,        // text-block bounding boxes
    SegmentationMask,      // pixel-level mask for inpainting
    OcrText,               // source_text on each text block
    InpaintedImage,        // cleaned page background
    Translation,           // translated text per block
    RenderedImage,         // final composite
    BrushLayer,            // user paint overlay
    FontPrediction,        // per-block font + color guess
    LayoutAnalysis,        // reading order, paragraph grouping
}

pub enum SettingDescriptor {
    Slider {
        id: &'static str,
        label: &'static str,  // i18n key; resolved at render time
        min: f32, max: f32, step: f32, default: f32,
    },
    NumberInput { id: &'static str, label: &'static str, min: f32, max: f32, step: f32, default: f32 },
    Toggle { id: &'static str, label: &'static str, default: bool },
    Select {
        id: &'static str, label: &'static str,
        options: &'static [(&'static str, &'static str)],  // (value, label-i18n-key)
        default: &'static str,
    },
}

inventory::collect!(EngineInfo);
```

#### Issues caught in re-review (2026-05-19, post-#33)

**E. `EngineCtx.project: &ProjectSession` exposed too much.** Gave
engines direct access to `session.apply()` / `.undo()` — engine
could bypass the Op pipeline and mutate state without the driver
knowing.

→ **Resolution**: Split. New `ProjectView` type is read-only
(immutable refs to glossary/characters/prompts/tm/series_meta).
Engine sees `&ProjectView` for reads; driver still owns
`ProjectSession`, applies engine's returned `EngineResult` after
`run` completes.

**F. Engines that mutate project entities had no path.** Extract-
entities, glossary-bulk-add, and similar engines need to insert
project rows but `Op` was Scene-only.

→ **Resolution**: New `ProjectOp` enum (see §4.1). Engine return
shape is `EngineResult { scene_ops, project_ops }`. Driver applies
both in one SQLite transaction so the extract-entities undo
reverses scene + project in one shot.

**G. `&AtomicBool` cancellation is error-prone.** Engine has to
remember to check the bool between long operations; forget = engine
runs to completion after user cancels.

→ **Resolution**: `tokio_util::sync::CancellationToken`. Engine
can `tokio::select!` over `cancel.cancelled()` and its work
(structured cancellation that aborts long awaits) or call
`cancel.is_cancelled()` for cooperative checks. Standard idiom.

**H. No streaming/incremental Op emission — blocks #19.** Original
`Result<Vec<Op>>` return forced engines to batch ops to end of run.
Stream translation (#19) needs per-bubble updates as the LLM
returns each translation.

→ **Resolution**: Channel-based — engine receives `ops_tx:
mpsc::Sender<EngineResult>` and sends as work progresses. Driver
applies each send as a Batch immediately, publishes
`SessionEvent::OpsApplied` to the bus → frontend re-renders that
block. Engine that doesn't need streaming just sends one final
EngineResult. Combines cleanly with cancellation via `select!`.

**I. Rigid `PipelineStage` enum forced artificial engine splits.**
Anime Text YOLO detects AND segments in one pass; OCR + layout
analysis often share a model. Forcing one stage per engine = code
duplication + lost performance.

→ **Resolution**: Drop `PipelineStage`. Replace with
**`ArtifactKind` declarations** — engine says "I consume X, produce
Y". DAG resolver walks the artifact graph to derive execution
order. One engine can produce multiple artifacts, multiple engines
can produce the same artifact (user picks via Profile UI). Matches
upstream's design + unlocks multi-artifact engines.

**J. No user-configurable engine settings — blocks #18 + makes
Profile UI inconsistent.** LaMa's max-crop-size (#18), Anime YOLO's
confidence threshold, translate engines' temperature — all would
have been hardcoded in UI per engine. Plugin engines couldn't ship
their own controls.

→ **Resolution**: `SettingDescriptor` schema declared on
`EngineInfo`. UI auto-generates form per engine from the schema;
engine reads typed values via `ctx.setting::<T>(key)`. Plugin
engines work for free. Profile UI becomes generic.

### 4.5 `HardwareReq` — drives the engine picker UI

```rust
// koharu-core/src/hardware.rs

#[derive(Debug, Clone)]
pub struct HardwareReq {
    pub min_vram_mb: Option<u32>,        // None = CPU OK
    pub prefers_compute_cap: Option<f32>, // e.g. 8.0 for Ampere+
    pub backends: BackendSupport,
    pub weights_size_mb: u32,             // for download size warnings
}

#[derive(Debug, Clone)]
pub struct BackendSupport {
    pub cuda: bool,
    pub metal: bool,
    pub vulkan: bool,
    pub cpu_fallback: bool,
}

#[derive(Debug, Clone)]
pub struct EngineCost {
    pub per_call_usd: Option<f64>, // Some = cloud engine
    pub local: bool,
}

#[derive(Debug, Clone)]
pub struct DetectedHardware {
    pub gpu_vendor: Option<GpuVendor>,
    pub gpu_name: Option<String>,
    pub vram_mb: Option<u32>,
    pub compute_cap: Option<f32>,
    pub cuda_available: bool,
    pub metal_available: bool,
    pub vulkan_available: bool,
}

impl DetectedHardware {
    /// Return engines that fit the current hardware comfortably.
    pub fn recommend_engines() -> Vec<&'static EngineInfo>;

    /// Returns a warning if the engine over-specs the hardware.
    /// User can still proceed; this populates the UI warning callout.
    pub fn check_compatibility(&self, engine: &EngineInfo) -> CompatibilityCheck;
}
```

### 4.6 `ProjectSession` — applies Ops, owns undo history

```rust
// koharu-app/src/session.rs

pub struct ProjectSession {
    project: Arc<ProjectStore>, // koharu-project handle
    scene: RwLock<Scene>,
    blobs: Arc<BlobStore>,
    history: RwLock<History>,
    bus: EventBus,
}

impl ProjectSession {
    pub fn apply(&self, op: Op) -> Result<()> {
        // 1. Compute inverse against current scene
        let inverse = op.inverse(&self.scene.read());
        // 2. Apply op to scene
        self.scene.write().apply(&op)?;
        // 3. Push to history (capped at HISTORY_CAP)
        self.history.write().push(HistoryEntry { op, inverse });
        // 4. Publish event
        self.bus.publish(SessionEvent::OpApplied(op.clone()));
        // 5. Notify autosave coordinator
        self.bus.publish(SessionEvent::DirtyMarked);
        Ok(())
    }

    pub fn undo(&self) -> Result<()>;
    pub fn redo(&self) -> Result<()>;

    /// Clear history (called on chapter switch / project close).
    pub fn reset_history(&self);

    pub fn subscribe(&self) -> EventReceiver;
}

pub struct History {
    entries: VecDeque<HistoryEntry>, // ring buffer
    redo_stack: Vec<HistoryEntry>,
    cap: usize, // HISTORY_CAP, default 100
}
```

---

## 5. Phasing

Each phase is a **mergeable milestone**. Stopping mid-project leaves
no dead code; the foundation laid waits for the next phase.

### Phase 1 — `koharu-core` scaffold (2 weeks)

- Create `koharu-core` crate
- Implement `Op` enum + serde
- Implement `Scene` + `Page` + `TextBlock` types
- Implement `BlobStore` (in-memory backing first; on-disk later)
- Implement `HardwareReq` + `DetectedHardware` (skeleton — actual
  GPU probe deferred to Phase 3)
- Add `proptest` harness for Op apply/inverse invariants
- **No consumers yet** — old `koharu-types` still in use by every
  other crate. Phase 1 lands the new substrate without disturbing
  existing code.
- **Acceptance**: `cargo test -p koharu-core` green, including
  proptest invariants. README in `koharu-core/` explaining the
  intent + types.

### Phase 2 — `BlobStore` wired into the pipeline (3 weeks)

- `Document.image: Uint8Array` → `Document.image: BlobId` at the
  serialization boundary
- Backend: read raw bytes, write to `BlobStore`, hand `BlobId` to
  frontend
- Frontend: `BlobId` → fetch bytes via **HTTP GET `/blob/:hex`** on
  the existing Axum server (`koharu-rpc/src/server.rs`), NOT via a
  new WS-RPC method. The HTTP path lets the browser do three things
  that an RPC-over-WS path can't:
  - `<img src="/blob/{hex}">` and `createImageBitmap(url)` use the
    browser's native + GPU-accelerated image decoder, off-thread,
    in parallel. No JS heap allocation for decoded bitmaps.
  - HTTP cache works automatically. Since blobs are content-
    addressed (hash = id), the response can set
    `Cache-Control: private, max-age=31536000, immutable` and the
    browser will never re-fetch — paging back and forth between
    chapters is zero-cost. (`private` not `public` — see F4 in
    §13: blobs are user-owned content, must not be cached by any
    intermediary proxy.)
  - HTTP/1.1 multi-connection (or HTTP/2 multiplexing in dev) lets
    multiple page thumbnails fetch in parallel without queueing
    behind the single WS pipe carrying RPC / tool calls.
  Credit: this approach was proposed by @HetCreep in
  [#33](https://github.com/EarthWL/koharu-th/issues/33) and is
  materially better than the WS-RPC `blob_get` design this doc
  originally specified.
- All other binary fields (`segment`, `inpainted`, `rendered`,
  `brush`) get the same treatment via the same route.
- Old mutation path stays intact — `Scene` not yet introduced;
  engines still mutate `Document` directly.
- **Acceptance**: page open + render works; binary bytes are
  fetched via `/blob/:hex`, not embedded in the WS RPC payload;
  Network panel shows 200-from-cache on second visit to a page;
  existing test suite green.

### Phase 3 — `Engine` trait + registry + hardware probe (1 week)

- Create `koharu-engines` crate
- `Engine` trait + `EngineInfo` + `EngineCtx` types
- `inventory` registry setup
- `DetectedHardware` actually probes GPU on launch (CUDA via
  `cudarc::driver`, Metal via `metal-rs`, Vulkan via `ash`)
- Port **detector** as the first engine (simplest stage)
- Old `pipeline.rs` becomes hybrid: detector goes through Engine
  trait; OCR / inpaint / translate / render still direct-call
- **Acceptance**: detector runs through the new Engine path,
  produces `Vec<Op>` (even if `Op::SetSegmentationMask` is the only
  variant used), test page goes through new path and matches old.

### Phase 4 — Engine migration + Engine Profile UI (8-10 weeks) ⭐ largest

Port engines in this order (least risky → most):

1. **Detector** (already in Phase 3 as proof-of-concept)
2. **Segmentation** (bubble-aware, comic_text_bubble)
3. **OCR** (MIT-48px first, then manga-ocr, then Anime Text YOLO,
   then optional backports: paddleocr-vl-1.5)
4. **Inpaint** (LaMa first, then optional AOT, optional Flux.2 Klein)
5. **Translate** (LLM dispatch via existing cloudLlm.ts surface,
   wrapped as engines per provider — OpenAI, Claude, Gemini,
   OpenRouter, Local)
6. **Render** (existing text renderer wrapped as engine)

For each port:
- Engine reads from `EngineCtx` (including `project` for translate)
- Engine emits `Vec<Op>`
- Old direct-call path deleted
- Integration test for that stage runs against golden page

In parallel:
- **Engine Profile sidebar tab** — new UI panel listing engines
  per stage with hardware compatibility chips
- Hardware probe runs at launch, suggests profile
- User can override per stage; warning callout if over-spec
- Cloud engines appear alongside local ones with per-call USD chip

**Acceptance**:
- All 6 stages run through Engine trait
- Old `pipeline.rs` deleted
- Engine Profile UI works with at least 2 alternatives per stage
- Backported engines (paddleocr-vl, AOT) selectable but optional

### Phase 5 — `ProjectSession` + undo/redo (2-3 weeks)

- `ProjectSession` apply / undo / redo
- `History` ring buffer (cap 100 by default, configurable)
- Event bus + `SessionEvent` types
- Keyboard shortcuts: ⌘Z / Ctrl+Z (undo), ⌘⇧Z / Ctrl+Shift+Z (redo)
- UI affordances: undo/redo buttons in toolbar; disabled state when
  stack empty; visible op count in dev mode
- Autosave coordinator subscribes to `DirtyMarked`, debounces, writes
  to SQLite via existing `koharu-project` write path

**Acceptance**:
- Manual edits (text block translation change, etc.) undoable
- Engine-produced changes undoable (rerun detect, then undo → back
  to pre-detect state)
- History clears on chapter switch / project close
- Autosave fires correctly; no double-writes; no missed dirty signal

### Phase 6 — Migration script + integration tests green (1-2 weeks)

- Migration script: v1 `.koharuproj` → v2 schema. The fork already
  has a migration runner (`koharu-project/src/db.rs` +
  `migrations/V001..V006__*.sql`) — v2 adds a new SQL file
  (e.g. `V007__v2_blob_index.sql`) handled by that runner, NOT a
  hand-written transaction. Same flow used for all prior schema
  bumps.
  - Backup `series.db` → `series.db.bak.v1` before running.
  - Manifest file: bump `schema_version` in the
    `series.koharuproj` JSON. **There is no `app_meta` SQLite
    table** — the schema-version pointer lives in the manifest, and
    the SQL `applied_migrations` table tracks which V-files have
    run.
  - No `op_log` table — op log is in-memory only per locked
    decisions §2. (Earlier drafts of this doc mentioned populating
    one; that was a writing slip, removed in audit #2.)
  - Rollback on any error; surface clear error message.
- Integration test suite green across:
  - Open v1 project → migrate → re-render same page → byte-identical
    to v1 render
  - Open v2 project → run pipeline → save → reopen → state preserved
  - Per-stage golden tests (input page → engine → expected ops)
- CI matrix green on branch (Windows / macOS / Linux × CUDA / CPU)

**Acceptance**: all of the above pass. Branch is RC-ready.

### Merge back to main + tag `v2.0.0-rc1`

- Squash-merge with full history preserved in commit body, or
  regular merge keeping branch commit chain (TBD based on size at
  merge time)
- Cut RC build with the per-GPU build matrix one last time (in 2.0
  with PTX-JIT this collapses to single binary if we backport
  upstream's path; if not, per-GPU stays)
- Soft-launch to community testers
- v2.0.0 final tag after RC bake-in period

---

## 6. Migration story (v1 → v2)

### What changes in the on-disk format

- **`series.koharuproj`** (manifest JSON): `schema_version` bumps
  from 1 → 2. This is where the schema-version pointer actually
  lives — there is no `app_meta` table in `series.db`.
- **`series.db`**: one new table added (`blob_index`). The op log
  is **in-memory only** per locked decisions §2; no `op_log` table
  is created. No existing tables modified destructively.
- **Project root**: new `blobs/` subdirectory for the on-disk blob
  backing (lands later than Phase 6 — the v2.0 release ships
  in-memory `BlobStore` only and the directory stays empty until
  the on-disk backing phase).
- **Existing chapter source/render folders**: unchanged.

### What the migration script does

A new SQL file `V007__v2_blob_index.sql` (file number bumps to
whatever's next; check `koharu-project/migrations/` for current
high-water mark) is dropped into the migrations directory. The
existing migration runner picks it up on next project open and
applies it under a single transaction:

```sql
-- V007__v2_blob_index.sql
CREATE TABLE blob_index (
    blob_id     BLOB PRIMARY KEY,        -- blake3 hash (32 bytes)
    size_bytes  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL         -- unix timestamp
);
CREATE INDEX idx_blob_index_created ON blob_index(created_at);
```

The runner records this in `applied_migrations` (existing table
created in `koharu-project/src/db.rs`). No `app_meta` table exists
or needs to exist.

The host process performs three things alongside the SQL migration,
inside the same transaction (or rolled back together on any error):

1. Copy `series.db` → `series.db.bak.v1` before opening the
   transaction. Kept indefinitely; user can delete from
   Settings → Storage. If migration fails, the host restores from
   the backup automatically.
2. Update `series.koharuproj` JSON: bump `schema_version` from 1
   to 2. Atomic write (write to `.tmp` → fsync → rename).
3. Create empty `blobs/` directory in the project root. Marked
   read-only initially; the on-disk backing phase will turn this
   active later.

Migrate any inline image bytes from existing tables: **none in the
current schema** — images live in chapter `source/` folder, not
SQLite (`migrations/V002__chapter_folders.sql` made this so). No
data migration needed; just the blob-index table for future use.

### What the user sees

First time opening a v1 project with v2 binary:

```
┌─────────────────────────────────────────────────────┐
│ Upgrading "MyManga" to project format v2            │
│                                                      │
│ A backup of the current series.db will be saved as  │
│ series.db.bak.v1 (you can delete it later from      │
│ Settings → Storage).                                │
│                                                      │
│ This migration is reversible — opening this project │
│ with v1.x binary again will use the .bak file.      │
│                                                      │
│            [Cancel]    [Migrate and open]           │
└─────────────────────────────────────────────────────┘
```

Atomic transaction — if any step fails, rollback restores the
original state and surfaces a destructive callout with the error.

### Downgrade story

User can downgrade by:
1. Closing v2 binary
2. Installing v1.x binary
3. (Manual) rename `series.db` → `series.db.v2`, then rename
   `series.db.bak.v1` → `series.db`

Not exposed as a UI flow. Documented in `docs/migration.md` (to
be written in Phase 6).

---

## 7. Engine Profile UI (sketch)

New sidebar tab "Engines" (or fold into Settings → Engines):

```
┌─ Engine Profile (machine-wide) ─────────────────────┐
│                                                      │
│  Hardware: RTX 4060 8GB · CUDA 13.1 · 16GB RAM      │
│  Detected at first launch · [Re-probe]              │
│                                                      │
│  ─ Stage ─────────────── Active ──── VRAM ─ Cost ──│
│  Detector            Anime YOLO-M ▼  80 MB  local  │
│  Segmentation        Bubble-aware  ▼  30 MB  local  │
│  OCR                 MIT-48px      ▼  50 MB  local  │
│  Inpaint             LaMa          ▼  80 MB  local  │
│  Translate           Cloud (active profile) ▼  varies │
│  Render              Default       ▼   —    local  │
│                                                      │
│  Profile total: ~240 MB VRAM                        │
│                                                      │
│  [Auto-pick for my hardware]  [Reset to defaults]   │
│                                                      │
│  ⚠ Inpaint > AOT requires 12 GB VRAM (you have 8)   │
│    Selectable with a warning at run time.           │
└──────────────────────────────────────────────────────┘
```

Per dropdown, available engines listed with chips:
- VRAM requirement
- Backend support (CUDA / Metal / Vulkan / CPU)
- Weights download size (if not yet cached)
- Cost (local / $X per 1k calls if cloud)
- "Recommended for your hardware" badge on the auto-pick

Cloud engines (e.g. Cloud Vision OCR via Gemini/GPT-4o) appear as
peers of local engines, gated by having an active LLM profile.

---

## 8. Backport policy (during branch life)

### main → branch

Every Friday: rebase `arch/v2-foundation` onto `main`. Cherry-pick
weekly fixes that touched files the branch hasn't restructured yet.

```bash
# Run from main worktree, target is the v2 worktree
git -C ../koharu-th-v2 fetch
git -C ../koharu-th-v2 rebase main
```

Conflicts that arise touching files the branch HAS restructured:
- Resolve in favour of the branch's new structure
- Cite the upstream-of-fork SHA in the resolution commit body
- Re-apply the fix's intent in the new substrate

### branch → main

**None until RC merge.** No exceptions. If a fix on the branch is
also needed on main, replicate the fix on main separately (not via
cherry-pick from branch — branch commits carry refactor-context that
won't apply on main cleanly).

### Tracking sync state

`docs/v2-progress.md` on the branch has a `## Sync log` section
listing each rebase date + SHA range pulled. Lets us see at a glance
how far ahead/behind main the branch is.

---

## 9. Open questions

Decisions deferred until a phase forces them.

| # | Question | Forced by | Default if unforced |
|---|---|---|---|
| 1 | Op log persistence — should we eventually persist op log to SQLite to enable cross-session undo? | User feedback in 2.x.x cycle | In-memory only stays |
| 2 | `koharu-types` crate — keep as thin re-export shim or delete entirely after migration? | End of Phase 4 cleanup | Delete |
| 3 | Engine plugin system — should external crates be able to register engines via `inventory::submit!`? | 3rd-party engine request | Yes, but document the API contract clearly first |
| 4 | Event bus implementation — `tokio::sync::broadcast`, `crossbeam-channel`, or a custom subscriber registry? | Phase 5 | `tokio::sync::broadcast` (matches Tauri ecosystem) |
| 5 | Vulkan / ZLUDA / PTX-JIT — adopt as part of v2 or defer to 2.1? | Phase 4 testing on AMD/Intel hardware | Defer to 2.1 (out of v2 scope) |
| 6 | macOS / Linux release distribution — turn on now that CI is back? | Phase 6 CI work | Yes for macOS (Metal kernels already exist); Linux deferred until window-controls bug fixed |
| 7 | Codex img2img backport — fork it eventually? | Community request | No (stays standalone, upstream's lane) |
| 8 | Layered PSD export backport? | Community request | No (workflow tools like Photoshop can ingest PNG layers from our CBZ export anyway) |

---

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Branch drifts so far from main that weekly rebase becomes painful | High | High | Strict weekly cadence; if a rebase takes >2 hours, schedule a "drain main" sprint where main feature work pauses until branch catches up |
| Phase 4 turns into a 6-month bog because every engine port surfaces new design questions | Medium | High | Time-box each engine port to 2 weeks; if blocked, document the question in this doc's open questions and ship a temporary direct-call passthrough |
| Migration script corrupts user projects | Low | Catastrophic | Atomic transaction + .bak backup + reversibility doc + community-tester beta before GA |
| Engine Profile UI confuses users who don't understand VRAM | Medium | Medium | Sensible default profile; "Auto-pick" button always available; warning copy reviewed with community testers |
| New `koharu-core` types diverge from upstream's enough that future backports become impossible | Medium | Medium | Periodically diff our `koharu-core` against upstream's; cite divergences in this doc's design section so future maintainers know the why |
| 4-5 month estimate slips to 7-8 months | High | Low (acceptable) | This is a foundation rebuild, not a feature ship. Slipping the timeline doesn't break anything visible to users; main keeps shipping fixes. |

---

## 11. References

- Upstream `koharu-app/src/pipeline/engine.rs` — engine trait
  inspiration: <https://github.com/mayocream/koharu/blob/main/koharu-app/src/pipeline/engine.rs>
- Upstream `koharu-core/` — primitive types inspiration
- Our current `koharu-pipeline/src/` — what gets replaced
- Our `koharu-project/` — what stays orthogonal
- v1.2.0 audit cycle commits `9509030d` through `cacb7f92` — taught us
  every place where sync queues / project swap leak; Op-based state
  fixes the root cause

---

## 12. Design changelog

Tracks amendments to the locked spec after the doc first landed.
Each entry: date, trigger (issue / re-review), summary of what
changed, link to the affected section(s).

### 2026-05-19 — External audit #2 follow-through (5 findings)

**Trigger**: external audit flagged 5 issues against the Phase 1.1
+ Phase 2 shape landed earlier today.

**Changed**:
- **F1 (this section)**: §5 Phase 6 + §6 Migration story rewritten.
  Original draft said the migration script would populate an
  `op_log` table and `UPDATE app_meta SET schema_version = 2` — both
  wrong. The fork's `schema_version` lives in the
  `series.koharuproj` manifest JSON (see `koharu-project/src/
  manifest.rs`), not in an `app_meta` SQLite table (which doesn't
  exist). Op log is in-memory only per locked decisions §2 — no
  `op_log` table should ever be created. Migration now correctly
  flows through the existing migration runner
  (`koharu-project/src/db.rs` + numbered V-files) and bumps the
  manifest version atomically alongside the SQL apply.
- **F2 → F5** (code on `arch/v2-foundation` branch, commit
  `d4da17de`): ProjectOp patches now split by column nullability
  (single Option for required, double Option for nullable);
  Region::contains widened to u64 internally to avoid u32 overflow;
  HTTP /blob Cache-Control switched from `public` to `private` (the
  bytes are user-private work product); CompatibilityCheck gained
  a new `CpuFallbackOnly` variant so the Engine Profile UI can warn
  about the 50-100× slowdown when a GPU engine falls back to CPU
  instead of showing a green chip.

**Sections amended**: §5 Phase 6, §6.

### 2026-05-19 — Phase 2 blob transport: WS-RPC → HTTP

**Trigger**: [#33](https://github.com/EarthWL/koharu-th/issues/33) by
@HetCreep.

**Changed**: Phase 2 wire mechanism for binary blobs. Was a new
WS-RPC method `blob_get(BlobId)` carrying bytes through msgpack;
became HTTP `GET /blob/:hex` on the existing Axum server with
`Cache-Control: public, max-age=31536000, immutable` (safe — URL
is the content hash).

**Why**: Browser gains (1) native + GPU-accelerated image decode
via `<img>` / `createImageBitmap(url)`, (2) automatic HTTP cache
on the immutable URL, (3) parallel multi-connection / HTTP/2
multiplexing instead of queueing every binary behind the single
WS pipe also carrying RPC tool calls. The WS-RPC approach gave us
dedup but none of those.

**Sections amended**: §2 (Locked Decisions, new row), §5 Phase 2.
**Commit**: [`ad0d14c9`](https://github.com/EarthWL/koharu-th/commit/ad0d14c9)

### 2026-05-19 — Op / Engine deep re-review (post-#33 follow-through)

**Trigger**: After #33 surfaced a class of blind spot (didn't think
about client-side capabilities), did a targeted re-review of the
two most load-bearing type sketches — `Op` and `Engine` — before
Phase 2 implementation locks in shape decisions. Found 10 real
issues across both.

**Changed — `Op` (§4.1)**:

- **A.** Dropped `OpInverse` trait. Inverses now computed inline at
  apply time in `ProjectSession::apply()` — the trait signature
  `fn inverse(&self, before: &Scene) -> Op` was broken for
  `Op::Batch` because the middle Op's inverse needs the state AFTER
  prior Ops, not the original `before`. Driver walks the Scene as
  it applies, captures per-Op inverse, stores `(op, captured_inverse)`
  pairs in history. Simpler, correct, no trait gymnastics.
- **B.** Removed `Op::NoteTmHit`. Pure annotation (TM cache hit)
  has no meaningful state inverse — wedging it into Op forced
  awkward decisions. Moved to the event bus as
  `SessionEvent::TmHit { … }`. Cost dashboard + UI subscribers can
  react; nothing enters the undo log.
- **C.** No-op Ops (e.g. `SetInpaintedImage { image: None }` over
  already-`None`) silently dropped at apply time. Filter step
  before history insertion.
- **D.** `RemovePage` inverse captures `BlobId` references, not
  blob bytes. BlobStore keeps the bytes alive (dedup'd by hash);
  inverse only needs the hash. ~32 bytes per blob ref × 100 ops
  history = trivial cost, even for heavy chapters.
- **E.** `Set*` artifact variants are now `Option<BlobId>` (not
  `BlobId`) so clearing a stage's output is a first-class Op —
  needed for retranslate flows that wipe the rendered image to
  force re-render.
- **F.** New `ProjectOp` enum + `EngineResult { scene_ops,
  project_ops }`. Engines can now mutate project entities
  (characters, glossary, series_meta, prompt templates) through
  the Op pipeline — extract-entities engine was the boundary case
  this fixes. Driver wraps both kinds in one SQLite transaction
  for atomic undo.

**Changed — `Engine` (§4.4)**:

- **E.** `EngineCtx.project` is `&ProjectView` (read-only) not
  `&ProjectSession` (which has `.apply()`). Engine can read
  project entities but can't bypass the Op pipeline.
- **F.** Engine return shape changed from `Result<Vec<Op>>` to
  the new `EngineResult { scene_ops, project_ops }` to carry both
  kinds.
- **G.** Cancellation changed from `&AtomicBool` to
  `&CancellationToken` (`tokio_util::sync::CancellationToken`).
  Enables structured cancellation via `tokio::select!` for
  long awaits, not just cooperative bool-checking.
- **H.** Engine `run()` now receives `ops_tx: mpsc::Sender<EngineResult>`
  for streaming — long-running engines emit incrementally instead
  of batching to end. Driver applies each `send` as a Batch
  immediately + publishes `SessionEvent::OpsApplied` so frontend
  re-renders per block. Unblocks #19 (Stream Translation).
- **I.** Dropped `PipelineStage` enum. Replaced with
  `ArtifactKind` declarations on `EngineInfo`
  (`consumes: &[ArtifactKind], produces: &[ArtifactKind]`) — DAG
  resolver walks the graph to derive order. One engine can produce
  multiple artifacts (Anime Text YOLO = DetectionBoxes +
  SegmentationMask in one pass).
- **J.** New `SettingDescriptor` schema on `EngineInfo`. UI
  auto-generates form per engine; engine reads typed values via
  `ctx.setting::<T>(key)`. Drives Engine Profile UI uniformly,
  unblocks #18 (LaMa max-crop slider), works for plugin engines
  without UI code.

**Sections amended**: §4.1, §4.4.
**Commit**: this commit.

**Net impact on phasing**: Phase 1 koharu-core code (`op.rs`,
`hardware.rs`, etc. on `arch/v2-foundation` branch tip `fe484b7a`)
will need a small follow-up commit to:
1. Remove the `OpInverse` trait (no impls, only declaration —
   cheap to delete).
2. Remove `Op::NoteTmHit` variant (already in proptest scope —
   regenerate the regression file).
3. Switch `Set*` variants to `Option<BlobId>` (already partially
   done — verify).
4. Add `ProjectOp` enum scaffold (new file `op_project.rs`).
5. Add `ArtifactKind` enum to `koharu-core` (consumed by
   `koharu-engines` in Phase 3).
6. Add `SettingDescriptor` enum to `koharu-core`.

Estimated effort: half a day. Land as Phase 1.1 on the branch
before Phase 2 work begins.
