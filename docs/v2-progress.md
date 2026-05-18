# v2 architecture refactor — progress tracker

**Branch**: `arch/v2-foundation`
**Design source of truth**: [`docs/v2-arch.md`](./v2-arch.md) (on `main`)
**Base anchor**: tag `arch/v2-base`

This file lives **only on the branch**. It tracks what's done in each
phase, current blockers, and the upstream sync log. Phase summaries
here should match the phasing section of `v2-arch.md`; if they
diverge, update `v2-arch.md` first (design is locked there, not here).

---

## Current phase: Phase 1 — `koharu-core` scaffold

**Status**: 🟡 in progress (started 2026-05-19)

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
| 1 — `koharu-core` scaffold | 🟡 in progress | 2 | Substrate. No consumers yet. |
| 2 — `BlobStore` wired into pipeline | ⏳ pending | 3 | `Document.image: Uint8Array` → `BlobId` at serialization boundary |
| 3 — Engine trait + registry + hardware probe | ⏳ pending | 1 | Detector ported as first engine |
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
