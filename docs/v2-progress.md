# v2 architecture refactor — progress tracker

**Branch**: `arch/v2-foundation`
**Design source of truth**: [`docs/v2-arch.md`](./v2-arch.md) (on `main`)
**Base anchor**: tag `arch/v2-base`

This file lives **only on the branch**. It tracks what's done in each
phase, current blockers, and the upstream sync log. Phase summaries
here should match the phasing section of `v2-arch.md`; if they
diverge, update `v2-arch.md` first (design is locked there, not here).

---

## Current phase: Phase 4 — Engine migration + Profile UI

**Status**: 🔄 IN PROGRESS — Phases 4.1 + 4.2 ✅ complete

### Phase 4.1 — Scene-from-Document bridge ✅

`koharu_pipeline::engine_bridge::run_engine_on_document` is the
runtime adapter that lets v1 `Document`/`AppResources` call sites
invoke v2 engines.

- **Build Scene** — `build_scene_from_document` registers the page
  image in the BlobStore (WebP-lossless, same encoding as the RPC
  DTO serializer — content-addressed, so re-runs hit the existing
  key), converts v1 TextBlocks → v2 (NodeId = array index).
- **Run engine** — load via `find_engine(id)`, build EngineCtx
  with a fresh `ProjectView::empty()` (Phase 4.5 fills), drive
  `engine.run` to completion while draining the `mpsc` channel.
- **Apply Ops** — translate each Op back to Document mutation:
  `AddTextBlock` ✅, `SetSegmentationMask` ✅,
  `SetInpaintedImage` ✅, `SetRenderedImage` ✅, `SetBrushLayer` ✅,
  `Batch` (recursive) ✅. `UpdateTextBlock` / `RemoveTextBlock`
  deferred — need NodeId→array-index map (Phase 4.5 when
  translate emits per-block updates).
- **RunPolicy** — `clear_text_blocks_first` flag for stages that
  REPLACE blocks (detector re-run). Phase 4.6 will replace this
  with a proper `Op::ReplaceTextBlocks` variant.

5 unit tests pass: scene build, content-addressed idempotence,
AddTextBlock apply, Batch recursion, SetSegmentationMask round-trip
through BlobStore.

### Phase 4.2 — Detector call-site swap ✅

`ops::vision::detect` now routes the **default** detector engine
through `engine_bridge::run_engine_on_document(COMIC_TEXT_DETECTOR_ID)`.
AnimeYolo path keeps the legacy direct call until Phase 4.3 ports
it as its own engine. Same `DetectPayload` API — no RPC churn.

Phase 3.3's deferred "test page through new path matches old"
acceptance is satisfied end-to-end: detect button triggers the
engine route, image bytes flow into the BlobStore, detector engine
emits Ops, bridge applies them back, document re-saves with the
same observable result (text_blocks + segment mask populated).

Workspace `cargo build --workspace --lib` clean.

## Previous phase: Phase 3 — Engine trait + registry + hardware probe

**Status**: ✅ COMPLETE

### Phase 3.1 — `koharu-engines` crate scaffold ✅

### Phase 3.1 — `koharu-engines` crate scaffold ✅

Engine trait + EngineCtx + EngineInfo + inventory registry. No
concrete engines yet (Phase 3.3 ports the detector).

- **New crate `koharu-engines`** depending on koharu-core +
  koharu-ml + koharu-renderer.
- **`Engine` trait** — `async_trait`-flavoured for dyn-compat
  (`Box<dyn Engine>` from inventory load fns). Streaming +
  cancellation via `mpsc::Sender<EngineResult>` +
  `CancellationToken` per docs/v2-arch.md §4.4.
- **`EngineCtx<'a>`** — concrete refs to `Scene`, `PageId`,
  `ProjectView`, `BlobStore`, `Arc<koharu_ml::facade::Model>`,
  `Arc<koharu_ml::llm::facade::Model>`,
  `Arc<koharu_renderer::facade::Renderer>`, `PipelineRunOptions`,
  `CancellationToken`. `setting::<T>(key, default)` resolves
  typed values via PipelineRunOptions + falls back on miss/
  mismatch (caller passes the engine's schema default).
- **`EngineInfo`** static descriptor — id/display_name/
  description/consumes/produces/settings_schema/hardware/cost/
  load (fn ptr returning `BoxFuture<'static, Result<Box<dyn
  Engine>>>`). `inventory::collect!(EngineInfo)` for compile-
  time registry. `to_view()` strips the fn ptr for serializing
  to the Engine Profile UI.
- **Helpers**: `all_engines()`, `find_engine(id)`.
- **Tests**: 3 unit (no_engines_registered_yet_in_phase_3_1 +
  setting helper smoke + EngineInfoView camelCase serde).

### Phase 3.2 — Hardware probe ✅

`koharu_engines::probe()` returns a `DetectedHardware` snapshot.
Replaces `DetectedHardware::stub()` for app launches; stub stays
for tests that want a deterministic "nothing detected" baseline.

- **CUDA probe** (feature `cuda`): `cudarc::driver::CudaContext::
  new(0)` to confirm device + queries `CU_DEVICE_ATTRIBUTE_*` for
  compute cap (major + minor encoded as `7.5`-style float, matching
  the `CUDA_COMPUTE_CAP` env-var in `build.yml`), `total_mem` for
  VRAM (rounded to MB), `get_name` for GPU display name. Dynamic-
  loading patch from `mayocream/candle` means we gracefully fail
  on missing CUDA libs (returns `None`, no panic).
- **Metal probe** (feature `metal`, target `macos`): basic
  `MTLCreateSystemDefaultDevice` check + `device.name()`. Full
  enumeration deferred to a follow-up.
- **Vulkan**: not yet implemented; `vulkan_available` stays
  `false`. Future commit can add `ash` under a `vulkan` feature.
- **Failure handling**: every probe arm returns `Option`; worst
  case the result equals stub. UI degrades gracefully.

Tests: 5 unit pass (default-feature build). With `--features cuda`,
4 pass (the `not(any(...))` cfg-gated test correctly drops out).

### Phase 3.3 — Port detector as first engine ✅

`koharu_pipeline::engines::comic_text_detector` — wraps the default
detector path through the v2 [`Engine`](koharu_engines::Engine)
trait. ML inference identical to legacy direct-call; only the wire
shape changes (Vec<Op> through channel instead of `&mut Document`).

- **Lives in `koharu-pipeline`**, not `koharu-engines`: keeps the
  engines crate thin (types + trait scaffolding only) while engines
  pull heavyweight backend deps from their natural home (pipeline
  already has ml + types + renderer).
- **Engine flow**: reads `scene.pages[page].source_image` BlobId →
  fetches bytes from BlobStore → decodes → wraps in throwaway
  Document → calls `ml.detect_with` → converts v1 TextBlocks to
  v2 (`Op::AddTextBlock`) + encodes mask PNG → BlobStore →
  `Op::SetSegmentationMask`. Sends one `EngineResult` via channel.
- **Inventory**: `submit!` registers `EngineInfo` at link time. Mod
  re-exports `ENGINE_ID` so the submission stays reachable through
  dead-code elimination on Windows MSVC (lib-only crates can dead-
  strip orphan modules).
- **Tests**: 2 unit pass (engine registers in inventory, load fn
  returns a Box<dyn Engine>). Full ML inference test gated behind
  needing real ONNX weights — Phase 4 wires the call site so the
  detector actually executes against a real page.

### Phase 3.3 deliberate scope reduction

- **Call-site swap not in Phase 3.3** — `ops::vision::detect` still
  invokes the legacy `ml.detect_with` directly. The Scene-from-
  Document bridge required for the swap is only worth building once
  multiple engines need it (Phase 4 migration).
- **No ReplaceTextBlocks Op** — engine emits `AddTextBlock` only.
  Phase 4 driver decides merge-vs-replace policy when porting OCR /
  inpaint / translate. Adding a `ClearTextBlocks` or
  `ReplaceTextBlocks` variant is a Phase 4 call.

## Phase 3 acceptance summary

- ✅ `Engine` trait + `EngineCtx` + `EngineInfo` + inventory
  registry compile and test.
- ✅ Hardware probe replaces stub; cuda feature path verified.
- ✅ Detector ported as first engine, registers in inventory,
  produces `Vec<Op>` containing both `AddTextBlock` (one per
  detected block) and `SetSegmentationMask` (with a BlobStore-
  registered mask) shapes.
- ⏸️ "Test page through new path matches old" — engine logic is
  in place but exercising it end-to-end needs Phase 4's call-site
  swap. Deferred consciously, not a blocker for Phase 3 sign-off.

### Deliberate Phase 3 omissions

- **DAG resolver** (consumes/produces ordering) — punted to
  Phase 4 where multi-engine plumbing earns its keep. With one
  engine in Phase 3, the driver hand-picks via `find_engine` +
  hardcoded call site.
- **Native AFIT (async fn in trait)** — kept `async_trait` for
  dyn-compat with `Box<dyn Engine>` from the inventory load fns.
  Migration to native + RPITIT possible once dyn-compat AFIT
  stabilises.

## Previous phase: Phase 1.2 — Phase 3 prep stubs

**Status**: ✅ COMPLETE (2026-05-19)

Pre-Phase-3 audit flagged that the v2-arch.md §4.4 spec references
`ProjectView` and `PipelineRunOptions` on `EngineCtx`, but Phase 1.1
shipped neither type. Defining `EngineCtx` in Phase 3 would have
hit a compile wall on the first day. Phase 1.2 lands both as stubs:

- **`koharu-core/src/project_view.rs`**: read-only handle exposing
  characters / glossary / series_meta as owned-`Vec` rows. Empty
  constructor for tests + the Phase 3 detector engine (which
  doesn't read project state). Phase 5 will refactor backing to
  borrow from `ProjectSession`'s SQLite-backed caches once that
  crate exists. TM lookup deferred (needs koharu-project TmStore).
- **`koharu-core/src/run_options.rs`**: per-run typed settings bag.
  `HashMap<String, StoredValue>` keyed by `SettingDescriptor.id`.
  Resolves typed values via `SettingValue::from_stored` so engines
  read with `opts.get::<T>(key)`. The `EngineCtx::setting::<T>`
  helper in Phase 3 will wrap this.
- **Tests**: 43 unit + 2 proptest green (up from 29+2 in Phase 1.1).
  Includes JSON round-trip + lookup helpers + type-mismatch
  fallback paths.

Both modules are additive — no consumers wired, no Phase 2 code
touched. Phase 3 picks up `EngineCtx` definition with all
referenced types in scope.

## Previous phase: Phase 1.1 — re-review amendments

**Status**: ✅ COMPLETE (2026-05-19, branch tip after this commit)

Applied the 10 issues caught in the post-#33 design re-review (see
`docs/v2-arch.md` §12 on main):

- **Subtractive** (commit `715c4982`):
  - Dropped `OpInverse` trait (issue A — broken for Op::Batch)
  - Removed `Op::NoteTmHit` (issue B — annotation, not state)
  - Updated module docs to reflect inline-inverse pattern
- **Additive** (this commit):
  - New `op_project.rs`: `ProjectOp` enum + Character/Glossary/
    SeriesMeta payloads + patches with three-state semantics
  - New `artifact.rs`: `ArtifactKind` enum (replaces rigid
    PipelineStage — issue I)
  - New `settings.rs`: `SettingDescriptor` (Serialize-only because
    schema travels backend → frontend only) + `SettingValue` trait
    + `StoredValue` for round-tripping saved preferences
  - `EngineResult { scene_ops, project_ops }` struct added to op.rs
  - `lib.rs` re-exports all the new types
- **Tests**: 29 unit + 2 proptest green (up from 18+2 in Phase 1)

## Previous phase: Phase 1 — `koharu-core` scaffold

**Status**: ✅ COMPLETE (2026-05-19, commit `fe484b7a`)

### Phase 1 sub-tasks

- [x] Create `koharu-core` crate with `Cargo.toml`
- [x] `lib.rs` module map + public re-exports
- [x] `id.rs` — `PageId`, `NodeId`, `TmEntryId` newtypes
- [x] `blob.rs` — `BlobId`, `BlobStore` in-memory implementation
- [x] `scene.rs` — `Scene`, `Page`, `TextBlock`, `Region`, `TextStyle`
- [x] `op.rs` — `Op` enum, `TextBlockPatch`, `OpInverse` trait declaration
- [x] `hardware.rs` — `HardwareReq`, `BackendSupport`, `EngineCost`,
      `DetectedHardware` (stub), `CompatibilityCheck`
- [x] `tests/proptest_op_roundtrip.rs` — property tests for Op serde
- [x] Wire `koharu-core` into root `Cargo.toml` workspace members
- [x] `cargo test -p koharu-core` green — **18 unit + 2 proptest passing**
  - Proptest caught a real `Option<Option<String>>` double-option
    serde round-trip bug on first run; fixed with custom
    `double_option` deserializer + documented in `op.rs`. Exactly
    why the harness is worth day-1.
- [x] `koharu-core/README.md` explaining intent + module map
- [ ] CI matrix re-enabled on branch (GitHub Actions workflow file)

### Phase 1 acceptance criteria

- `cargo test -p koharu-core` green including proptest invariants
- README at `koharu-core/README.md` (TODO) explaining intent + types
- No consumers wired yet — old `koharu-types` still in use everywhere
- Branch CI green on first push

### Phase 1 deliberate omissions

- `OpInverse` trait has no impls (lands in Phase 5 alongside
  `ProjectSession::apply`)
- `BlobStore` on-disk backing has hook but no implementation (Phase 2)
- `DetectedHardware::stub()` returns "unknown" for everything;
  actual `cudarc` / `metal-rs` / `ash` probes land in Phase 3
- No `koharu-engines` crate yet (Phase 3)
- No `koharu-app` crate yet (Phase 5)

---

## Phase pipeline (high-level)

| Phase | Status | Estimated weeks | Notes |
|---|---|---|---|
| 1 — `koharu-core` scaffold | ✅ complete | 2 → 1 actual | Op/Scene/BlobStore/HardwareReq + 18+2 tests |
| 1.1 — re-review amendments | ✅ complete | 0.5 actual | Drop OpInverse + NoteTmHit; add ProjectOp/ArtifactKind/SettingDescriptor; 29+2 tests |
| 2 — `BlobStore` wired into pipeline | ✅ complete | ~1 actual | HTTP `/blob/:hex` + DocumentDto + frontend; survived 2 external audits |
| 1.2 — Phase 3 prep stubs | ✅ complete | 0.1 actual | Add ProjectView + PipelineRunOptions stubs; 43+2 tests |
| 3.1 — `koharu-engines` crate scaffold | ✅ complete | 0.2 actual | Engine trait + EngineCtx + EngineInfo + inventory; 3 tests |
| 3.2 — Hardware probe | ✅ complete | 0.1 actual | CUDA via cudarc (compute cap + VRAM + name); Metal basic; 5 tests |
| 3.3 — Port detector as first engine | ✅ complete | 0.2 actual | Engine impl + inventory; call-site swap deferred to Phase 4; 2 tests |
| 4 — Engine migration + Engine Profile UI ⭐ | ⏳ next | 8-10 | Largest phase. 6 stages × port + UI work |
| 5 — `ProjectSession` + undo/redo | ⏳ pending | 2-3 | Per-chapter session ring buffer |
| 6 — Migration script + integration tests green | ⏳ pending | 1-2 | v1 → v2 atomic migration |
| Merge back → `v2.0.0-rc1` | ⏳ pending | — | RC build + community bake-in |

**Total estimated**: 17-21 weeks (~4-5 months)

---

## Sync log (main → branch rebases)

Weekly rebase of branch onto main. Cherry-picks documented per row.

| Date | Branch HEAD before | main HEAD synced to | Cherry-picks | Notes |
|---|---|---|---|---|
| 2026-05-19 | (initial branch creation) | `18423265` | — | Branch forked from arch/v2-base (= docs(arch): land v2 architecture design doc) |
| 2026-05-19 | `fe484b7a` | `64974db6` | — | Rebased to pull v1.2.1 release + design doc amendments (HTTP blob transport from #33, Op+Engine re-review). Conflict-free rebase. Phase 1.1 applies the amendments to koharu-core code in commits `715c4982` (subtractive) and the additive follow-up. |

Add new rows weekly. Each row records:
- Which commit on main the branch was rebased onto
- Specific SHAs cherry-picked (if any extras needed beyond plain rebase)
- Conflicts encountered + resolution notes

---

## Decisions log (changes to `v2-arch.md`)

Every time `v2-arch.md` (on main) changes during the branch life,
log the bump here so future readers know the design has shifted.

| Date | `v2-arch.md` commit on main | Change | Impact on branch |
|---|---|---|---|
| 2026-05-19 | `18423265` (initial land) | Initial design doc | — branch starts here |

---

## Blockers / open questions surfaced during implementation

(none yet — Phase 1 just started)

When a blocker surfaces:
1. Add a row here with date + brief description
2. If the blocker affects design decisions, propose an amendment to
   `v2-arch.md` (PR against main) — don't change the doc on the
   branch in isolation
3. If the blocker is purely tactical (lib version, bug workaround),
   document it in the commit body that resolves it

---

## CI status

- [ ] GitHub Actions workflow re-enabled on `arch/v2-foundation`
- [ ] Matrix: Windows × CUDA (Turing/Ampere/Ada/Blackwell), macOS × CPU+Metal, Linux × CPU
- [ ] Per-PR run on push to branch
- [ ] Merge-back gate: every job green required before merge to main

CI re-enabling is queued for the end of Phase 1 (once `koharu-core`
compiles and tests pass locally) — no point burning Actions minutes
on a workspace that doesn't compile yet.
