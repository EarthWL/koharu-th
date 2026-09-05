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

**Status**: 🔄 IN PROGRESS — 6.1 – 6.5 ✅ complete; **6.6 (RC prep) is the only
phase left**, and it is gated on hardware/dogfood work, not code.

> **Reconciled 2026-09-05** against branch tip `9969d39b` (106 commits ahead
> of `main`, which is 4 ahead of us at `f5b1889d` / v1.2.2). This file had
> not been updated since 2026-05-21 while the undo 1–3 series, KI-1/KI-3,
> the Engines-tab consolidation and Cloud engines landed — several items
> below that were listed as "planned" had already shipped. Every status
> here was re-verified against the code, not carried forward.
>
> Durable detail for the post-Phase-6 blocks lives in the dedicated
> sections near the end ("Engines-tab consolidation", "Cloud engines",
> "Recurring serde gotcha").

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

### Phase 6.5 — CI re-enable ✅ (clippy side) / ⏳ (repo-settings side)

**Done** (`9969d39b`, 2026-09-05): workspace is clean under
`cargo clippy --workspace --all-targets -- -D warnings` on Rust 1.94 —
25 warnings across koharu-core / -project / -renderer / -ml / -engines /
-pipeline cleared (let-chain `collapsible_if`, doc-list indentation,
`matches!`, struct-init, a test-only helper gated `#[cfg(test)]`).
`cargo test --workspace` green. This is a strict superset of what
`lint.yml` runs (`cargo clippy -- -D warnings` on the default member).

**Already true since 2026-05-19** (`109af480`): `.github/workflows/test.yml`
and `lint.yml` trigger on `push` to `arch/v2-foundation`. Both are
ubuntu-only, so the macOS 10× billing concern
([[feedback-github-actions]]) does not apply to them.

**Still owed — cannot be verified from a checkout**:
- Confirm GitHub Actions is enabled at the repo level (Settings →
  Actions). If it is off, none of the above runs regardless of triggers.
- Watch the first push after enabling: `test.yml` runs
  `cargo test --workspace --tests`, which has never executed on CI for
  this branch. Expect a Linux-only toolchain surprise or two (fonts,
  webkit deps are already in the apt step).

### Phase 6.6 — RC merge prep + `v2.0.0-rc1` tag ⏳

Checklist, in order. Items marked **(hardware)** need the RTX 50xx
Blackwell box; items marked **(dogfood)** need a real user project.
These were previously buried under "Blockers / open questions" at the
bottom of this file — they are the actual RC gate, so they live here now.

1. [ ] **Rebase onto `main`** — main is 4 commits ahead
       (`d00fba66` v1.2.2, `efc6cc40` fix #40/#41 startup-failure
       surfacing, `f5b1889d` ui version sync). Locked policy is weekly
       rebase; none has happened since 2026-05-19. #40/#41 touch startup,
       which is the same path as the v2 hardware probe — resolve
       conflicts there carefully. Also brings README/Cargo/ui versions to
       1.2.2. Record in the Sync log below.
2. [ ] **(dogfood) Real v1 → v2 migration.** Only synthesised fixtures
       have gone through `pre_open_v1_to_v2` / V007 / manifest bump. Open
       a personal `.koharuproj` from a 1.2.x install, confirm the
       `series.db.bak.v1` appears, `blobs/` is created, re-render is
       byte-identical to the v1 render.
3. [ ] **(hardware) End-to-end smoke** — detect → OCR → inpaint →
       translate → render on a real chapter through the Engine path.
       Nothing has exercised the user-facing flow since Phase 5.3's
       dual-apply landed; unit tests cover the Op contract only.
4. [ ] **(hardware) KI-1 decision** — build with `cuda,cudnn`, confirm
       shutdown after inpaint no longer aborts with
       `STATUS_STACK_BUFFER_OVERRUN`; benchmark detect+inpaint with
       `cudnn` on vs off. If the delta is immaterial, **revert the
       236k-line cudarc vendor** (`git revert e83bd91a`, drop the
       `[patch.crates-io]`) and disable the feature instead. Every
       shipped build carries this patch until decided.
5. [ ] Squash-merge vs preserve-history decision (diff is ~106 commits;
       lean preserve — the audit trail in commit bodies is the design
       record).
6. [ ] Per-GPU bundle build (Turing / Ampere / Ada / Blackwell) via
       `scripts/build-all-gpus.sh`.
7. [ ] GitHub release with prebuilt installers; CHANGELOG + release
       notes; freeze `v2-arch.md` on main; tag `v2.0.0-rc1`.

---

## Phase status (branch tip `9969d39b`, 2026-09-05)

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
| Audit #8 + #9 (self-test) | ✅ | `f79e649f` / `eefa3a85` | Session reset on clear-before-build; cuDNN panic guard; surface-drift toast |
| Undo 1 — render is a derived view | ✅ | `d2a4748f` | `SetRenderedImage` no longer enters history; one Ctrl+Z reverts the whole edit |
| Undo 2 — same-length manual edits recorded | ✅ | `df1f2ec9` / `45b1b41c` | Bulk `update_text_blocks` diffs prev↔new into `Batch<UpdateTextBlock>`; single edit + fit-to-bubble routed too |
| Undo 3a/3b/3c — add/remove undoable (closes KI-2) | ✅ | `bcb5e6f3` / `28ac8310` / `aa5c0a00` / `10d7e613` | `Op::InsertTextBlock`; id-keyed Document mirror (`node_id`); heuristic matcher + drift guard |
| KI-3 — LaMa min-crop gate | ✅ | `c20f58bd` | `check_min_inpaint_dims` + downscale clamp |
| KI-1 — cuDNN Drop abort (root fix, runtime test owed) | ✅ code / ⏳ verify | `e83bd91a` / `c20f58bd` | Vendored cudarc 0.19.3 with softened Drop; see 6.6 item 4 |
| Engines-tab consolidation | ✅ | `366fb840` … `ac038277` | Single source of truth for engine selection; legacy-pref migration; i18n help |
| Cloud engines in the tab | ✅ | `28c14a77` / `f57056ae` / `c367a744` | `SettingDescriptor::ProfileSelect`; frontend pseudo-engines; `skip_translate` in Process |
| 6.5 — CI re-enable (clippy) | ✅ | `9969d39b` | Workspace clean under `--all-targets -D warnings`; workflows already target the branch |
| 6.6 — RC merge + per-GPU build + tag `v2.0.0-rc1` | ⏳ | — | See checklist above — gated on rebase + hardware + dogfood |

## Test posture

Counted at `9969d39b` (2026-09-05) from `cargo test --workspace`; all
green. Numbers drift with every commit — treat as a floor, re-run rather
than trust.

- **koharu-core**: 44 unit + 2 proptest
- **koharu-engines**: 5 unit
- **koharu-pipeline**: 79 unit (engine_bridge golden/dual-apply, session_slot, DAG, engine adapters, engine_profile)
- **koharu-app**: 25 unit (session + history + event bus)
- **koharu-project**: 54 unit + 4 integration (`tests/v1_to_v2_migration.rs`)
- **koharu-api**: 5 unit
- **koharu-renderer**: 38 unit

`cargo clippy --workspace --all-targets -- -D warnings` clean as of tip.

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
| #8 | Phase 5/6 | P1 clear-before-build session reset + P2 picker migration gate + P3 per-doc history state | `f79e649f` |
| #9 | Phase 4-6 (self-test) | B3 cuDNN panic guard + B1 surface drift toast + B1 root invalidate session + B2 text_renderer hard error | `eefa3a85` |

## Known issues (workaround documented; no in-tree fix yet)

### ~~KI-3: LaMa tensor `narrow` error on degenerate crop~~ — RESOLVED 2026-05-20

**Fix**: `check_min_inpaint_dims(w, h)` gates the top of
`inference_model_rgb` in `koharu-ml/src/lama/mod.rs`; crops thinner
than `MIN_INPAINT_DIM` (16px) on either axis bail with a Thai-friendly
toast ("พื้นที่เล็กเกินไปสำหรับการลบข้อความ … ลองขยายพื้นที่ด้วยแปรง mask
หรือใช้ Fit to Bubble") instead of letting candle's internal narrow op
fail mid-inference. Gating at the input covers both the blockwise
(eraser-narrowed bubble) and `inference_crop` (full-image) paths. Unit
test `rejects_crops_thinner_than_model_minimum` covers the boundary.

Follow-up (scrutinize): the gate alone had a hole — a long-thin crop
(e.g. 2000×20) passes it (both sides ≥16) but the >512 downscale path
proportionally shrank the short side below 16 and still crashed candle.
Fixed by clamping the downscaled dims at `MIN_INPAINT_DIM` instead of `1`
(`downscale_dims`); test `downscale_never_shrinks_a_side_below_model_minimum`.
9/9 lama lib tests green.

<details><summary>original report</summary>

**Symptom**: Toast surfaces
`narrow invalid args start + len > dim_len: [1, 128, 1, 13], dim: 2, start: 1, len: 1`
when running inpaint (full or partial) on a region where the
mask has been edited down to a very thin strip — e.g. 1-pixel
tall after eraser brush cleanup. The tensor shape `[1, 128, 1, 13]`
shows the model intermediate has `height=1` after preprocess +
resize → the model's downstream slicing fails because internal
dim 2 has size 1 and the op tries `start=1, len=1`.

**Status**: process survives — the audit #9 / KI-1 #2 path
correctly converts the candle tensor error into an
`anyhow::Error`, which surfaces as the toast above instead of a
panic. Pipeline is alive; user just can't inpaint that
specific malformed region.

**Root cause**: no min-size validation on the crop passed to
`LaMa::inference_model_rgb`. `koharu-ml/src/lama/mod.rs:246`
accepts whatever crop the caller hands over; if the user has
narrowed the mask to a sub-model-minimum region (LaMa expects
≥ ~16-32 pixels per dimension after letterbox), candle's
internal narrow / split ops fail mid-inference.

**Planned fix** (5-10 mins):

Bounds-check `crop.image.dimensions()` at the top of
`inference_model_rgb` (or in `inference_blockwise` before the
per-crop loop):

```rust
const MIN_INPAINT_DIM: u32 = 16;
if w < MIN_INPAINT_DIM || h < MIN_INPAINT_DIM {
    bail!(
        "Region too small for inpaint ({w}x{h}, min {min}x{min}). \
         Try expanding the mask brush or use Fit to Bubble.",
         min = MIN_INPAINT_DIM,
    );
}
```

Friendly Thai-language toast replaces the cryptic
candle/cuDNN tensor shape error. No model change required —
just gate the input.

**Not in-flight yet** — recorded so the next session picks it
up. Tensor error is non-fatal; user can work around by
re-running detect + auto-inpaint (which uses bubble-mask sized
regions) or by enlarging the mask before inpaint_partial.

</details>

### ~~KI-2: Manual UI edits clear undo history~~ — RESOLVED 2026-05-20

**Fix** (undo 1 → 3c, commits `d2a4748f` `df1f2ec9` `45b1b41c` `bcb5e6f3`
`28ac8310` `aa5c0a00` `10d7e613`). **Note: shipped the opposite of the plan
recorded below.** The plan was dedicated single-op RPCs + a frontend switch
away from bulk replace, with bulk diffing dismissed as "too complex". What
landed keeps the frontend on bulk `updateTextBlocks` and makes the backend
diff it:

- `koharu_types::TextBlock` gained a runtime-only `#[serde(skip)] node_id`;
  the Document mirror in `engine_bridge` is id-keyed, not positional, so
  the mapping survives add/remove (3b).
- `ops::edit::update_text_blocks` (`koharu-pipeline/src/ops/edit.rs`)
  matches each new block to a previous one via `find_matching_previous`,
  preserves its `node_id`, and records `UpdateTextBlock` for changed
  survivors, `InsertTextBlock { index }` for an add, `RemoveTextBlock`
  for a delete — one structural change = one undo step. More than one
  add+remove at once (re-detect) still invalidates history (3c).
- `Op::InsertTextBlock` was added to koharu-core so undo of a delete
  restores at the original index instead of appending (3a).
- Because the matcher is a heuristic, `verify_session_or_invalidate`
  fingerprints session scene vs Document after every structural edit and
  drops history on any mismatch — fail-safe, never a wrong undo.
- Single `update_text_block` (AI chat), `text_block_fit_to_bubble`, and the
  standalone `add_text_block` / `remove_text_block` RPCs go through the
  same recorder.
- `SetRenderedImage` no longer enters history (render is a projection of
  blocks + inpaint), so one Ctrl+Z reverts geometry + text + composite
  together (undo 1).

**Residual**: undo is only recorded when a session is in-sync for the
document (i.e. after at least one engine run or session open). Edits
before that apply but are not undoable — by design, not a bug.

<details><summary>original plan (superseded)</summary>

**Symptom**: Engine actions (detect / OCR / translate / render) ARE
undoable via Cmd+Z. Manual UI actions are NOT — pressing Del to
delete a block, right-click → Delete, dragging a block to resize,
or editing translation text via TextBlocksPanel all clear the
undo stack.

**Root cause**: 3 of the 4 Document-mutating RPCs in `ops::edit`
routed directly to `state_tx::mutate_doc` instead of through
`session.apply`.

**Planned scope**: refactor `ops::edit::{remove_text_block,
add_text_block, update_text_block}` to route through `session.apply`;
frontend `useTextBlocks.removeBlock` → `api.removeTextBlock`,
`appendBlock` → `api.addTextBlock`; keep bulk `update_text_blocks` on
the invalidate path because "bulk diffing into Ops is complex and not
worth it".

</details>

### KI-1: cuDNN TLS panic on Drop — root cause fixed (vendored cudarc), runtime test owed

**Status: fixed at the root (2026-05-20), pending on-device runtime
confirmation.** cudarc 0.19.3 is now vendored at `third-party/cudarc`
and consumed via `[patch.crates-io]`; the one offending line in
`<Cudnn as Drop>::drop` (`destroy_handle(handle).unwrap()`) is softened
to log-and-ignore. Both our direct dep and candle-core pull cudarc
0.19.x from crates.io, so the single patch covers every cuDNN handle in
the process — not just the LaMa path. The earlier partial mitigation
(LaMa multi-crop loops sequentially on CUDA instead of fanning out
scoped threads) stays in place as defence-in-depth.

**Verification done**: patched cudarc compiles cleanly with the full
candle feature set (`cargo check` standalone, `Compiling cudarc 0.19.3
(third-party/cudarc) … Finished`). The full koharu-ml `cuda,cudnn`
binary build could NOT be completed in the agent shell — the box has VS
18 (2026) which CUDA 13.1's nvcc rejects (`unsupported Microsoft Visual
Studio version! Only 2019–2022`). That's a host-toolchain gate on
candle-kernels, unrelated to the patch. **Owed**: full per-GPU build +
on-device check that app shutdown after an inpaint no longer aborts
with `STATUS_STACK_BUFFER_OVERRUN` (needs the RTX 50xx Blackwell box).

**Refinement of the original report**: after the partial mitigation the
panic was no longer firing ~15s after inpaint — that timing came from
the scoped worker threads being joined+dropped right after inpaint.
Post-mitigation the inpaint conv runs on the persistent tokio worker
that polls the dispatch task ([rpc.rs](../koharu-rpc/src/rpc.rs):303),
whose TLS only tears down at process exit, so the residual abort was
shutdown-only. The "text_renderer also triggers it" note was a
misattribution — the renderer ([facade.rs](../koharu-renderer/src/facade.rs):103)
is tiny_skia + rayon on CPU and never touches cuDNN. The vendored patch
makes both moot.

**Symptom**: After a successful LaMa inpaint or text_renderer run, the
process can die ~15s later with `STATUS_STACK_BUFFER_OVERRUN`
(Windows fast-fail). Log shows
`panicked at cudarc-0.19.3/src/cudnn/safe/core.rs:43:55: called
Result::unwrap() on an Err value: CudnnError(CUDNN_STATUS_INTERNAL_ERROR)`
followed by `fatal runtime error: thread local panicked on drop,
aborting`.

**Root cause** (verified against source): cudarc's
`<Cudnn as Drop>::drop` (`cudnn/safe/core.rs:43`) calls
`destroy_handle` and `.unwrap()`s it. candle caches the handle in a
`thread_local!` keyed by DeviceId — `candle-core/src/cuda_backend/cudnn.rs:12`,
populated via `CUDNN.with(...)` on every conv (every model sets
`cudnn_fwd_algo: None`). So the handle's lifetime is tied to the
*thread* that first ran a CUDA conv, and Drop runs when that thread's
TLS is destroyed. If `cudnnDestroy` then returns
`CUDNN_STATUS_INTERNAL_ERROR` (common when the CUDA primary context is
already tearing down), the `.unwrap()` panics *inside a destructor
during TLS teardown* — above every `catch_unwind` frame
(`catch_cudnn_panic` at lama/mod.rs:188, the audit #9/B3 bridge guard at
engine_bridge.rs:190) — so Rust calls `abort()` → Windows
`STATUS_STACK_BUFFER_OVERRUN`.

**Fix applied**: vendored cudarc with the `.unwrap()` → log-and-ignore
(see status block above). Swallowing the destroy error is safe — the
driver reclaims the handle on context teardown anyway.

Reproduction is environment-dependent (RTX 50xx Blackwell +
CUDA 13.1 + cuDNN 9.19) so a deterministic test isn't in the
suite. The panic_hook log shipped in `bf0ed50d` stays as a tracer for
any future cuDNN Drop error (now logged, not aborting).

**Open decision — is the vendor worth it? (scrutinize, owed benchmark)**
Vendoring ~236k lines to soften one Drop unwrap is heavy for a
shutdown-only, no-work-lost abort. The lighter alternative is to drop
the `cudnn` feature from `koharu-runtime` defaults — candle then uses
its own im2col+gemm conv, no `Cudnn` type is ever instantiated, and
KI-1 disappears at the root with a one-line revert. It was NOT chosen
because the conv-perf cost (detection runs interactively per page) is
unmeasured — and can't be measured in the agent shell (VS18/CUDA13.1
blocks the cuda build). **Owed on the Blackwell box**: benchmark
detect+inpaint with cudnn on vs off; if the delta is immaterial, revert
this vendor (`git revert e83bd91a` + drop the patch) and disable the
feature instead.

## Engines-tab consolidation (2026-05-21, user-verified)

The Engines sidebar tab is the single source of truth for engine selection +
per-engine settings. Commits `366fb840` `f9de4d9f` `f35781f1` `ac038277`.

- Settings page no longer has any engine config — removed the Detector +
  local-OCR cards; dropped `detectorEngine`/`animeYoloVariant`/
  `animeYoloConfidence` from `preferencesStore`.
- `EngineInfo.is_default` → `EngineInfoView.isDefault`: the tab highlights the
  backend's actual default (comic_text_detector / mit48px_ocr / lama_inpaint /
  local_llm_translate / text_renderer), not `engines[0]`.
- `migrateEnginePrefs.ts` (one-shot in `Providers`) seeds the engine profile
  from a legacy localStorage detector/OCR choice — guarded + idempotent.
- i18n: nested `engineSettings.*` (en + th); `EngineSettingsForm` renders help
  as a visible line. Labels/help only surfaced after `ac038277` fixed the
  `SettingDescriptor` field serialization — see the serde gotcha below.

### Cloud engines in the tab (Approach B: frontend pseudo-engines)

Commits `28c14a77` (OCR) `f57056ae` (translate) `c367a744` (Process support).

- New `SettingDescriptor::ProfileSelect` (koharu-core/settings.rs): a dynamic
  provider-profile picker — options resolved at runtime from
  `providerProfilesList`, not `&'static`; `vision_only` flag. Rendered by
  `ProfileSelectControl` in `EngineSettingsForm`.
- `cloud_vision_ocr` + `cloud_llm_translate` registered in the engine inventory
  (produce OcrText / Translation, `cost=cloud`, `is_default=false`) so they
  appear in the tab with a ProfileSelect. Their Rust `run()` BAILS — both are
  frontend-orchestrated (`cloudOcr.ts` / `cloudLlm.ts`); they must never be
  dispatched to the backend bridge.
- Cloud OCR selection: `readCloudOcrChoice()` (mutations) reads
  `engine_profile active['ocr_text'] === 'cloud_vision_ocr'` + the
  `vision_profile` setting; replaced the old Settings cloud toggle.
- Cloud translate: `useTranslateProfileSync()` one-way mirrors the tab's
  Translation choice → the shared `cloudProvider`/`activeProfileId` prefs (the
  app-wide active cloud LLM, also used by chat/embeddings). Skips first run so
  it doesn't clobber persisted state; the canvas-toolbar dropdown stays synced
  via the same prefs. `applyProviderProfile`/`clearProviderProfile` shared in
  `profileHelpers`.

### ⚠️ Two engine-selection paths — keep them in sync

- **Standalone** Detect/OCR buttons → `vision::detect/ocr` (payload engine None)
  → `run_engine_for_artifact` → reads `engine_profile` + merges profile
  settings (`run_engine_on_document`). All four anime_yolo settings apply.
- **Full Process / batch** → `run_pipeline_inner` (pipeline.rs) → LEGACY ML
  facade keyed off `ProcessRequest.{detector_engine, ocr_engine, anime_yolo_*}`
  — does NOT read `engine_profile`. `readPipelineEngines()` (mutations) bridges
  the profile → those legacy fields for `processImage`/`processAllImages`
  (`a5fd6064`). Caveat: the legacy pipeline can't carry nms/containment, so full
  Process applies only variant+confidence for anime_yolo.
- Cloud in the pipeline: `skip_translate` added to `ProcessRequest` + the
  `LlmGenerate` step (mirrors `skip_ocr`). `processImage` has 4 combos —
  all-local = one pipeline call; any cloud (OCR/translate) → frontend runs
  detect→OCR→cloud-translate then the pipeline does only inpaint+render
  (`c367a744`). Batch always translates locally.

## ⚠️ Recurring serde gotcha (bit 3× on 2026-05-21)

`#[serde(rename_all = "camelCase")]` is per-struct and is NOT recursive into
nested structs/enums. Every DTO the frontend reads needs its own attr. The tell
is the frontend reading a multi-word field as `undefined`. Fixed this session
in `DetectedHardware` (→ "CPU only" everywhere), the nested `HardwareReq` /
`BackendSupport` / `EngineCost` (→ "No backend"), and the `SettingDescriptor`
ENUM fields (→ labels fell back to ids, help blank; an enum needs
`rename_all_fields="camelCase"` ALONGSIDE the `rename_all="snake_case"` that
renames the `kind` variant tag). Single-word fields + tuple/array elements
survive snake_case, which masks the bug (Select options resolved while the
label didn't). When adding a backend→frontend DTO field: check the camelCase
attr first.

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
on its own track, in breach of the weekly-rebase policy in
`v2-arch.md` §2. As of 2026-09-05 `main` is 4 commits ahead
(`d00fba66` v1.2.2 → `efc6cc40` fix #40/#41 → `f5b1889d` ui version
sync). Rebase is item 1 of the Phase 6.6 checklist.

---

## Decisions log (changes to `v2-arch.md` on main)

| Date | Commit on main | Change | Impact on branch |
|---|---|---|---|
| 2026-05-19 | `18423265` (initial land) | Initial design doc | — branch starts here |

---

## Blockers / open questions

The three pre-RC blockers formerly listed here (real-project migration
dogfood, end-to-end smoke, clippy cleanup) moved into the **Phase 6.6
checklist** above — clippy is done, the other two are items 2 and 3.

**Post-RC order is locked in `v2-arch.md` §13** (2026-09-05): translation
engines in Rust consuming `ctx.project` → single engine-selection path →
MCP through session → Thai typesetting → engine crate split → new models
→ (v3) image generation. The items below are the debt that §13 items 2
and 5 close.

**Open design debt (not blocking RC, closed by 2.1)**:

1. **Two engine-selection paths.** Standalone Detect/OCR honour the
   machine-wide `engine_profile`; full Process / batch go through the
   legacy `ProcessRequest.{detector_engine, ocr_engine, anime_yolo_*}`
   fields, bridged from the profile by `readPipelineEngines()` in
   `ui/lib/query/mutations.ts`. The legacy pipeline cannot carry
   nms/containment settings, so full Process silently applies a subset
   of the anime_yolo settings. Fix = port `run_pipeline_inner` onto
   `koharu_engines::resolve_plan`. Recorded in `v2-arch.md` §12.
2. **`koharu-types` still live** (~34 importing files). The Scene ↔
   Document mirror depends on it. Deletion deferred to 2.1 — see
   `v2-arch.md` §9 Q2.
3. **Repo not `cargo fmt`-clean.** Edition-2024 rustfmt reformats ~35
   untouched files. A dedicated `chore(fmt)` commit is cheap but should
   land right after the rebase (item 1 of 6.6) to avoid conflict noise.
   `lint.yml` does not run `fmt --check`, so this is hygiene, not a gate.

---

## CI status

- [x] `test.yml` + `lint.yml` trigger on `arch/v2-foundation` (`109af480`)
- [ ] GitHub Actions confirmed enabled at repo level; first run green
- [x] clippy clean across workspace, all targets, `-D warnings` (`9969d39b`)
- [x] Matrix: Linux + CPU (cheap) on push; per-GPU Windows builds
      reserved for tags (`release.yaml` / `publish.yml`)
- [ ] Merge-back gate: workspace tests + clippy required before
      `v2.0.0-rc1` tag
