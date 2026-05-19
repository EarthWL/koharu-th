# v2 architecture refactor — progress tracker

**Branch**: `arch/v2-foundation`
**Design source of truth**: [`docs/v2-arch.md`](./v2-arch.md) (on `main`)
**Base anchor**: tag `arch/v2-base`

This file lives **only on the branch**. It tracks what's done in each
phase, current blockers, and the upstream sync log. Phase summaries
here should match the phasing section of `v2-arch.md`; if they
diverge, update `v2-arch.md` first (design is locked there, not here).

---

## Current phase: Phase 6 — Migration script + integration tests

**Status**: 🔄 IN PROGRESS — 6.1 / 6.2 / 6.3 / 6.4 ✅ complete; 6.5 / 6.6 remaining

### Phase 6.1 — V007 migration SQL + host backup/manifest bump ✅

`koharu-project/migrations/V007__v2_blob_index.sql` adds the
`blob_index` STRICT table (`blob_id BLOB PRIMARY KEY`, `size_bytes`,
`created_at` + index) for cross-restart blob dedup. SQL runs through
the existing `applied_migrations` runner — no hand-written transaction.

Host-process hooks in `koharu-project/src/migration.rs`:

- `pre_open_v1_to_v2(root)` — atomic `series.db` → `series.db.bak.v1`
  before opening the DB (skipped if backup exists or schema already v2).
- `post_open_v1_to_v2(root)` — create `blobs/` dir + bump manifest
  `schema_version` 1 → 2 via temp + rename.
- `peek_migration(root)` — dry-run check so the UI can show a confirm
  dialog before the destructive backup runs.

8 unit tests cover noop paths, idempotent backup, manifest atomicity.

### Phase 6.2 — Migration confirm dialog ✅

`project_open` calls `peek_migration` before opening; if v1 detected,
an `rfd::MessageDialog` confirm runs on the blocking pool. Accept →
run pre_open + open + post_open. Reject → return early with a clean
"migration cancelled" error. No silent destructive backup.

### Phase 6.3 — Migration integration tests ✅

`koharu-project/tests/v1_to_v2_migration.rs` synthesises a v1
`.koharuproj` fixture (V001-V006 schema seeded, manifest at
`schema_version: 1`, no `blobs/`) and exercises the full open path:

- Backup file appears at `series.db.bak.v1` post-migration
- `blobs/` directory created
- Manifest re-serialised at `schema_version: 2` with all other fields
  preserved (default_provider_profile, default_prompt_template, tags)
- Re-opening the migrated project is a noop (idempotent guards)
- Fresh v2 project creation includes `blobs/` from the start (audit #7 P3)

### Phase 6.4 — Engine-pipeline stage golden tests ✅

15 new tests in `engine_bridge.rs` freeze the per-stage Op-application
contract. Real ML/LLM runs aren't reproducible in CI, but the bridge's
Op translation onto the legacy Document is deterministic — exactly the
surface that broke under audits #5/#6/#7.

Coverage:

- Per-stage golden: detector / OCR / translate / inpaint / render / brush
- Full-chain golden: detect→OCR→translate stability across the
  `NodeId +1 / -1` shift convention
- Defensive Op handling: NodeId::NONE warn-and-skip,
  out-of-range warn-and-skip, missing-blob → Err,
  None-blob clears the Document slot
- Dual-apply contract: `apply_op` vs `session.apply` produce
  matching NodeId sets after rebuild
- Audit #7/P1 regression: re-detect after `clear_text_blocks_first`
  doesn't collide with audit #6/P1's duplicate-id guard

Also fixes pre-existing `ProcessRequest` round-trip rot in
`koharu-api/commands.rs` (7 fields drifted since the test last
compiled).

koharu-pipeline lib: **50 → 66 tests**, all green.

### Phase 6.5 — CI re-enable ⏳ next

GitHub Actions disabled at the repo level (billing concern — macOS
minutes are 10× per [[feedback-github-actions]]). Options:

- Re-enable Linux + CPU only on `arch/v2-foundation` push triggers
  (cheap, catches clippy + compile + unit-test regressions)
- Defer until RC merge, rely on the per-GPU local build flow
  (`scripts/build-all-gpus.sh`) plus manual test runs

Before re-enabling either way: fix the Rust 1.94 clippy warnings in
koharu-project / koharu-renderer / koharu-core/hardware.rs
(collapsible_if patterns predating Phase 3) and the unused-import
warning in koharu-pipeline introduced/fixed mid-audit-#7.

### Phase 6.6 — RC merge prep + `v2.0.0-rc1` tag ⏳

- Squash-merge vs preserve-history decision based on diff size at
  merge time
- Per-GPU bundle build (Turing / Ampere / Ada / Blackwell) via
  `scripts/build-all-gpus.sh`
- GitHub release with prebuilt installers
- Update CHANGELOG + release notes; freeze the doc on main

---

## Phase status (branch tip `6b8fbce8`)

| Phase | Status | Tip commit | Highlights |
|---|---|---|---|
| 1 — koharu-core scaffold | ✅ | `fe484b7a` | 18+2 tests; proptest caught double-option serde bug day 1 |
| 1.1 — re-review amendments | ✅ | `fd79047b` | Drop OpInverse + Op::NoteTmHit; add ProjectOp + ArtifactKind + SettingDescriptor |
| 2 — BlobStore (HTTP /blob/:hex) | ✅ | `eeba36e9` | Survived 2 external audits; credit @HetCreep #33 |
| 1.2 — Phase 3 prep stubs | ✅ | `a05f5e35` | ProjectView + PipelineRunOptions stubs |
| 3.1–3.3 — koharu-engines + hardware probe + first engine | ✅ | `fe604c98` | Engine trait + EngineCtx + inventory; cudarc probe; comic_text_detector ported |
| 4.1 — Scene/Document bridge | ✅ | `97fed1c3` | `run_engine_on_document` + 5 unit tests |
| 4.2 — Detector call-site swap | ✅ | `97fed1c3` | `ops::vision::detect` routes through engine path |
| 4.3 — OCR + segmentation engines | ✅ | `425e6e98` | MIT-48px + manga-ocr + comic_text_bubble |
| 4.4 — Inpaint engine | ✅ | `a49d33b4` | LaMa ported |
| 4.5 — Translate engines | ✅ | `4642ef6a` | 5 LLM providers (local + 4 cloud) as engines; real ProjectView |
| 4.6 — DAG resolver + legacy delete | ✅ | `4c2b38a9` | `resolve_plan` with `prefer` map disambiguation |
| 4.7 — Engine Profile sidebar UI | ✅ | `9884726f` | Read-only minimal scaffolding |
| F4.A — AnimeYolo as 2nd detector | ✅ | `e00f7ab6` | settings_schema for size variant + confidence |
| F4.B — Settings form auto-generator | ✅ | `106e1eb3` | Preview-only render of `SettingDescriptor` |
| F4.C — Engine profile save | ✅ | `289b88a8` | Storage + RPC + frontend wire |
| F4.D — Render engine + per-block translate | ✅ | `5b84b0e1` | Bridge profile passthrough; legacy `ops/vision.rs` deleted |
| Audit #5 — 4 findings on Phase 4 | ✅ | `b7622537` | NodeId(0)/PageId(0) NONE collision + docstring nits |
| 5.1 — koharu-app crate scaffold | ✅ | `7f7b1133` | ProjectSession + History + SessionEvent types |
| 5.2 — Inverse Op computation | ✅ | `be2a91d2` | Inline inverse (not OpInverse trait — dropped post-#33) |
| 5.3 — engine_bridge dual-apply | ✅ | `9f5d4de1` | Document + session.scene kept in sync per run |
| 5.4 — Frontend undo/redo | ✅ | `393a484c` | RPC + hook + toolbar; Thai-keyboard-safe `event.code === 'KeyZ'` |
| 5.5 — Chapter session lifecycle | ✅ | `ce0baf0f` | Open/close + autosave coordinator |
| Audit #6 — 3 findings on Phase 5 | ✅ | `16df2756` | Duplicate-id guard + profile race + trailing blank |
| 6.1 — V007 migration SQL + hooks | ✅ | `864325ed` | Backup + blobs/ + manifest bump |
| 6.2 — Migration confirm dialog | ✅ | `69ee5707` | rfd::MessageDialog on blocking pool |
| 6.3 — Migration integration tests | ✅ | `1eba2f42` | Synthesised v1 fixture; 8 unit tests pass |
| Audit #7 — 4 findings on Phase 5/6 | ✅ | `4c97c5bc` | SessionSlot wrapper + re-detect reset + persist lock + blobs/ on create |
| 6.4 — Engine-pipeline golden tests | ✅ | `6b8fbce8` | 15 stage-golden + dual-apply + audit-#7 regression tests |
| 6.5 — CI re-enable | ⏳ next | — | clippy cleanup + Actions decision |
| 6.6 — RC merge + per-GPU build + tag `v2.0.0-rc1` | ⏳ | — | Squash policy + release artefacts |

## Test posture

- **koharu-core**: 43 unit + 2 proptest
- **koharu-engines**: 5 unit
- **koharu-pipeline**: 66 unit (incl. 25 engine_bridge, 5 session_slot, 8 DAG integration, 9 engine adapters)
- **koharu-app**: 23 unit (session + history + event bus)
- **koharu-project**: 51 unit (incl. 8 migration tests + 6 backup/recent/series)
- **koharu-api**: 5 unit (incl. ProcessRequest round-trip — un-rotted in 6.4)

Workspace `cargo build --workspace --lib` and `cargo test --workspace
--lib` clean as of tip.

## External audits survived

| # | Phase covered | Findings | Fix commit |
|---|---|---|---|
| #3 | Phase 2 | no-store on /blob errors + zero-copy Bytes | `47a503c2` |
| #4 | Phase 2 | F2-F5 — ProjectOp split + Region u64 + Cache-Control + CompatibilityCheck | `c70dd387` |
| Post-Phase-2 | Phase 2 | origin/CORS + Uint8Array→string + get_document_dto in RpcMethodMap | `a6d9edf7` |
| Branch-sync | Phase 2 | F1 migration doc + F4-followup prose | (rebase) |
| #5 | Phase 4 | NodeId(0)/PageId(0) NONE collision + 3 docstring nits | `b7622537` |
| #6 | Phase 5 | P1 duplicate-id guard + P2 profile persist race + P3 trailing blank | `16df2756` |
| #7 | Phase 5/6 | P1 session doc-switch drift + P1 re-detect dup + P2 persist lock + P3 blobs/ on create | `4c97c5bc` |

## Locked decisions (won't revisit without explicit approval)

- Linear history (no CRDT)
- Per-chapter session undo, in-memory ring buffer (~100 ops)
- Machine-wide engine profile (not per-project)
- Hardware auto-probe + recommend + warn-on-overspec; never lock
- Atomic v1→v2 migration with `.bak.v1`
- `koharu-project` stays orthogonal to v2 (not absorbed)
- `async_trait` over native AFIT (dyn-compat for `Box<dyn Engine>`)
- No `op_log` SQLite table — op log is in-memory only
- No `app_meta` SQLite table — schema_version lives in the manifest

---

## Sync log (main → branch rebases)

| Date | Branch HEAD before | main HEAD synced to | Cherry-picks | Notes |
|---|---|---|---|---|
| 2026-05-19 | (initial branch creation) | `18423265` | — | Branch forked from arch/v2-base |
| 2026-05-19 | `fe484b7a` | `64974db6` | — | Rebased to pull v1.2.1 release + design doc amendments (HTTP blob from #33, Op+Engine re-review). Conflict-free. |

No rebases performed during Phase 4 / 5 / 6 work — branch has stayed
on its own track. Next rebase will happen as part of Phase 6.6 RC
merge prep, picking up v1.2.2 + main's bug fixes from `efc6cc40`
(`fix(#40 #41)` startup failure surfacing).

---

## Decisions log (changes to `v2-arch.md` on main)

| Date | Commit on main | Change | Impact on branch |
|---|---|---|---|
| 2026-05-19 | `18423265` (initial land) | Initial design doc | — branch starts here |

---

## Blockers / open questions

**Not yet surfaced**:

1. v1→v2 migration has only been tested against synthesised fixtures.
   First real-world `.koharuproj` migration won't happen until
   v2.0.0-rc1 is in user hands. Pre-RC owed: dogfood a personal
   project through the migration path.
2. End-to-end engine pipeline (detect → OCR → inpaint → translate →
   render) hasn't been smoke-tested against a real chapter since
   Phase 5.3's dual-apply landed. Unit tests cover the contract;
   nothing covers the user-facing flow.
3. Clippy is dirty across the workspace (Rust 1.94 collapsible_if
   patterns + one unused-import). Phase 6.5 must clean these before
   CI re-enable to avoid a wave of red on first run.

---

## CI status

- [ ] GitHub Actions re-enabled on `arch/v2-foundation`
- [ ] clippy clean across workspace
- [ ] Matrix: Linux + CPU (cheap) on push; per-GPU Windows builds
      reserved for tags
- [ ] Merge-back gate: workspace lib tests + clippy required before
      `v2.0.0-rc1` tag
