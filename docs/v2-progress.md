# v2 architecture refactor — progress tracker

**Branch**: `arch/v2-foundation`
**Design source of truth**: [`docs/v2-arch.md`](./v2-arch.md) (on `main`)
**Base anchor**: tag `arch/v2-base`

This file lives **only on the branch**. It tracks what's done in each
phase, current blockers, and the upstream sync log. Phase summaries
here should match the phasing section of `v2-arch.md`; if they
diverge, update `v2-arch.md` first (design is locked there, not here).

---

## Current phase: Phase 1.2 — Phase 3 prep stubs

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
| 3 — Engine trait + registry + hardware probe | ⏳ next | 1 | Detector ported as first engine |
| 4 — Engine migration + Engine Profile UI ⭐ | ⏳ pending | 8-10 | Largest phase. 6 stages × port + UI work |
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
