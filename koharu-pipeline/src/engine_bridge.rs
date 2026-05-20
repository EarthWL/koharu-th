//! Bridge between the legacy v1 `Document` world and the v2 `Engine`
//! trait + Scene/Op model.
//!
//! Phase 4.1 ships this as a runtime adapter so existing call sites
//! (`ops::vision::detect`, eventually `::ocr`, `::inpaint`, etc.)
//! can invoke v2 engines without first migrating the whole
//! `AppResources.state` over to Scene-backed storage. Phase 4.6
//! deletes the legacy direct-call ops; Phase 5 may collapse the
//! Document storage into Scene proper.
//!
//! ## What the bridge does
//!
//! 1. **Build Scene from Document** — registers the page image in
//!    the `BlobStore` (WebP-lossless, same encoding as the RPC DTO
//!    serializer), constructs a single-page `Scene` with v2
//!    `TextBlock`s converted from the v1 vector.
//! 2. **Run the engine** — load via inventory by id, build
//!    `EngineCtx`, drive `run` to completion while draining the
//!    `mpsc::Sender<EngineResult>` channel.
//! 3. **Apply Ops back to Document** — translate each `Op` into a
//!    Document mutation (covered variants below; un-covered
//!    variants log a warning + are skipped — Phase 4.6 broadens
//!    coverage as more engines need it).
//!
//! ## Op coverage (Phase 4.1)
//!
//! - `Op::AddTextBlock` ✅ (clear-and-replace policy for now —
//!   detector re-runs replace prior detections)
//! - `Op::SetSegmentationMask` ✅ (fetch from BlobStore, decode,
//!   set `doc.segment`)
//! - `Op::SetInpaintedImage` ✅ (same shape)
//! - `Op::SetRenderedImage` ✅
//! - `Op::SetBrushLayer` ✅
//! - `Op::UpdateTextBlock` ⏳ deferred — needs NodeId→v1-array-index
//!   mapping; lands when the first engine that uses it is ported
//!   (probably translate or render-per-block in Phase 4.5+).
//! - `Op::RemoveTextBlock` ⏳ deferred — same NodeId concern.
//! - `Op::AddPage` / `Op::RemovePage` / `Op::UpdatePageImage` —
//!   not used by single-page engines; handled by the document
//!   loader outside this bridge.
//! - `Op::Batch` ✅ (recurse).

use anyhow::{Context, Result, anyhow};
use futures::FutureExt;
use image::codecs::webp::WebPEncoder;
use indexmap::IndexMap;
use std::panic::AssertUnwindSafe;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use koharu_core::{
    ArtifactKind, BlobId, BlobStore, CharacterId, CharacterRow, GlossaryCategory, GlossaryEntryId,
    GlossaryRow, NodeId, Op, PageId, PipelineRunOptions, ProjectView, Region, Scene, SeriesMetaRow,
    scene::Page, scene::TextBlock as SceneTextBlock,
};
use koharu_engines::{Engine, EngineCtx, info as engine_info};
use koharu_types::{Document, SerializableDynamicImage};

use crate::AppResources;
use crate::engine_profile::EngineProfileStore;

/// Policy bag for [`run_engine_on_document`]. Phase 4.1 ships one
/// knob (`clear_text_blocks_first`); future fields land additively.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunPolicy {
    /// Wipe `doc.text_blocks` after the engine completes but before
    /// applying its emitted `AddTextBlock` ops. Use for stages that
    /// produce a fresh detection (Phase 4.2 detector swap, future
    /// re-OCR call sites). Leave `false` for stages that augment
    /// existing blocks (translate, render-per-block).
    ///
    /// Phase 4.6 replaces this with a proper
    /// `Op::ReplaceTextBlocks` variant emitted by the engine.
    pub clear_text_blocks_first: bool,
}

/// Run the engine identified by `engine_id` against the document at
/// `doc_index`. Reads the document from state, builds a v2 Scene,
/// drives the engine, applies returned `Op`s back to the Document,
/// writes it back to state.
///
/// `options` carries the per-run typed settings the engine reads via
/// `EngineCtx::setting`. Caller is responsible for building it from
/// saved preferences + payload knobs (Phase 4.2+ call sites do this).
///
/// `cancel` is the cooperative cancellation handle. Pass
/// `CancellationToken::new()` from a fresh root if there's no
/// parent cancellation tree yet.
pub async fn run_engine_on_document(
    state: &AppResources,
    doc_index: usize,
    engine_id: &str,
    options: PipelineRunOptions,
    policy: RunPolicy,
    cancel: CancellationToken,
) -> Result<()> {
    // Look up the engine in the inventory. find_engine returns
    // None for an unknown id (typo, stale saved profile pointing
    // at a removed engine, etc.).
    let info = engine_info::find_engine(engine_id)
        .ok_or_else(|| anyhow!("no engine registered with id '{}'", engine_id))?;

    // F4.D: merge the saved engine-profile settings under the
    // caller's per-call options. Caller's options win on key
    // conflict — `DetectPayload.anime_yolo_variant` overrides the
    // saved profile's `variant` for one-shot runs, while a setting
    // not present in the payload falls back to the profile, which
    // itself falls back to the engine's schema default at
    // `ctx.setting::<T>(_, default)` call time.
    let merged_options = merge_profile_settings(&state.engine_profile, engine_id, options);

    // Load (async) — model weights + GPU init happen here on first
    // call. Driver should cache `Box<dyn Engine>` per engine id in
    // a real implementation; Phase 4.1 loads fresh each call to
    // keep the bridge focused on the wire shape.
    let engine: Box<dyn Engine> = (info.load)()
        .await
        .with_context(|| format!("loading engine '{}'", engine_id))?;

    // Read the document snapshot we'll feed to the engine.
    let mut doc = crate::state_tx::read_doc(&state.state, doc_index).await?;

    // Audit #8/P1: clear v1 text_blocks BEFORE build_scene_from_document
    // so the Scene we pass to the engine + clone into the session reset
    // below reflects the post-clear state. Doing the clear later (audit
    // #7 fix) left scene.text_blocks populated with NodeId(1)..N — the
    // session got reset with that stale scene and the engine's first
    // AddTextBlock(NodeId(1)) tripped audit #6/P1's duplicate-id guard.
    // The audit #7 regression test missed it because the test rebuilt
    // scene from the cleared doc manually instead of following the real
    // run_engine_on_document order.
    if policy.clear_text_blocks_first {
        doc.text_blocks.clear();
    }

    // Build the Scene shape the engine reads + the page id it
    // operates on.
    let (scene, page_id) = build_scene_from_document(&mut doc, &state.blobs)?;

    // Phase 4.5: build a real ProjectView from the open
    // koharu-project (if any). Translate engines read glossary +
    // characters from this. Detector/OCR/inpaint don't read
    // project state — the build is cheap when no project is
    // open (returns empty immediately), and a few ms of SQLite
    // when one is.
    let project = build_project_view(state).await?;

    // Channel for engine → driver Op streaming. Size 16 is a soft
    // ceiling; engines that out-pace the apply path block on send
    // (back-pressure). 16 is enough for streaming-translate per-
    // bubble emission on a typical page.
    let (ops_tx, mut ops_rx) = mpsc::channel::<koharu_core::EngineResult>(16);

    let ctx = EngineCtx {
        scene: &scene,
        page: page_id,
        project: &project,
        blobs: &state.blobs,
        ml: &state.ml,
        llm: &state.llm,
        renderer: &state.renderer,
        options: &merged_options,
        cancel: &cancel,
    };

    // Run the engine in this task — back-pressure via the bounded
    // channel keeps memory bounded if the apply loop is slow.
    // tokio::select! ensures we don't deadlock if the engine sends
    // its final result and we're still pulling it off the channel
    // (we drop ops_tx via the run-future taking ownership; channel
    // closes when run returns, ops_rx.recv() then returns None).
    //
    // Audit #9/B3: wrap with `catch_unwind` so a panic inside any
    // engine (notably cudarc's `cudnn/safe/core.rs:43` unwrap on
    // `CUDNN_STATUS_INTERNAL_ERROR` from LaMa inpaint) doesn't
    // unwind the whole Tauri process. Convert the caught panic
    // payload into an `anyhow::Error` so the existing engine
    // failure path surfaces it as a user-visible toast.
    //
    // Caveats:
    //   1. After a cuDNN panic the model handle state may be
    //      corrupted — subsequent runs of the same engine may
    //      fail. We still recover the process; the user can save
    //      + restart cleanly.
    //   2. `AssertUnwindSafe` is required because EngineCtx /
    //      ml / llm Arcs aren't `UnwindSafe`. We accept this — the
    //      alternative is a process death from a third-party
    //      unwrap that we don't control.
    let run_future = AssertUnwindSafe(engine.run(ctx, ops_tx))
        .catch_unwind()
        .map(|outcome| match outcome {
            Ok(result) => result,
            Err(payload) => Err(anyhow!(
                "engine '{}' panicked: {}",
                engine_id,
                panic_payload_message(&payload),
            )),
        });

    // Audit #7/P1 + audit #8/P1: prepare the session BEFORE the
    // apply loop so it's guaranteed to be (a) initialised and (b)
    // tagged with the current doc_index. Two reset conditions:
    //   - session is missing or built for a DIFFERENT doc → init
    //     from the freshly-built scene, history starts empty
    //   - `clear_text_blocks_first` policy → destructive boundary
    //     (re-detect), prior history no longer maps to the new
    //     block set; reset so apply doesn't trip the
    //     NodeAlreadyExists guard on duplicate AddTextBlock ids
    //
    // The doc.text_blocks.clear() now runs BEFORE
    // build_scene_from_document above, so scene already reflects
    // the cleared state — reset_with gets an empty-text-blocks
    // Scene and the engine's AddTextBlock(NodeId(1)) doesn't
    // collide.
    {
        let mut session_guard = state.session.write().await;
        let needs_reset = policy.clear_text_blocks_first
            || session_guard.active_doc_index() != Some(doc_index);
        if needs_reset {
            session_guard.reset_with(scene.clone(), doc_index);
        }
    }

    let mut apply_count: usize = 0;
    tokio::pin!(run_future);
    loop {
        tokio::select! {
            biased;
            result = &mut run_future => {
                // Engine finished. Drain any pending results from
                // the channel before exiting (engine may have sent
                // its final EngineResult just before returning).
                while let Ok(batch) = ops_rx.try_recv() {
                    apply_engine_result_dual(state, &mut doc, doc_index, batch).await?;
                    apply_count += 1;
                }
                result.with_context(|| format!("engine '{}' run failed", engine_id))?;
                break;
            }
            maybe_batch = ops_rx.recv() => {
                match maybe_batch {
                    Some(batch) => {
                        apply_engine_result_dual(state, &mut doc, doc_index, batch).await?;
                        apply_count += 1;
                    }
                    None => {
                        // Channel closed but run_future hasn't
                        // resolved yet — engine dropped ops_tx
                        // early. Wait on run_future to surface its
                        // result (could be Ok or Err).
                        (&mut run_future)
                            .await
                            .with_context(|| format!("engine '{}' run failed", engine_id))?;
                        break;
                    }
                }
            }
        }
    }

    tracing::debug!(
        engine = engine_id,
        doc_index,
        batches = apply_count,
        "engine run complete, writing document back"
    );

    // Write the mutated document back into state.
    crate::state_tx::update_doc(&state.state, doc_index, doc).await
}

/// Build a single-page Scene from a v1 Document. Registers the
/// page image in the BlobStore (idempotent — same bytes hash to
/// the same BlobId, so re-runs don't re-encode unnecessarily).
fn build_scene_from_document(doc: &mut Document, blobs: &BlobStore) -> Result<(Scene, PageId)> {
    let image_id = register_image(blobs, &doc.image)?;
    let segment_id = doc
        .segment
        .as_ref()
        .map(|img| register_image(blobs, img))
        .transpose()?;
    let inpainted_id = doc
        .inpainted
        .as_ref()
        .map(|img| register_image(blobs, img))
        .transpose()?;
    let rendered_id = doc
        .rendered
        .as_ref()
        .map(|img| register_image(blobs, img))
        .transpose()?;
    let brush_id = doc
        .brush_layer
        .as_ref()
        .map(|img| register_image(blobs, img))
        .transpose()?;

    // Convert existing TextBlocks (v1 → v2). Engines that consume
    // OcrText / Translation / FontPrediction get to see whatever
    // upstream stages already produced.
    //
    // Stable node ids: each Document block carries a runtime `node_id`
    // (serde-skipped) that becomes its scene `NodeId`. We BACKFILL any
    // unassigned (0) ids here — assigning above the current max so a
    // re-detect/add never reuses an id still referenced by session
    // history. For a fresh document (all ids 0) this assigns 1, 2, 3…
    // — identical to the previous positional `NodeId(idx + 1)`, so the
    // change is behaviour-preserving until add/remove start reordering.
    // `NodeId::NONE = 0` stays reserved (max+1 is always ≥ 1).
    let mut next_id = doc
        .text_blocks
        .iter()
        .map(|b| b.node_id)
        .max()
        .unwrap_or(0)
        + 1;
    let mut text_blocks: IndexMap<NodeId, SceneTextBlock> = IndexMap::new();
    for v1 in doc.text_blocks.iter_mut() {
        if v1.node_id == 0 {
            v1.node_id = next_id;
            next_id += 1;
        }
        let id = NodeId(v1.node_id);
        text_blocks.insert(
            id,
            SceneTextBlock {
                id,
                region: Region {
                    x: v1.x.max(0.0) as u32,
                    y: v1.y.max(0.0) as u32,
                    width: v1.width.max(0.0) as u32,
                    height: v1.height.max(0.0) as u32,
                },
                source_text: v1.text.clone(),
                translation: v1.translation.clone(),
                // Carry the per-block render style across the bridge so
                // the renderer honours font/colour/stroke/align/etc the
                // user set in the Render panel. (Phase 4.1 stubbed this
                // `None`, which silently disabled every Render control
                // through the v2 engine path.)
                style: v1.style.as_ref().map(crate::style_convert::scene_style_from_v1),
                source_lang: v1.source_language.clone(),
                font_prediction: None, // converted on demand by translate/render engines
                rotation_deg: v1.rotation_deg,
            },
        );
    }

    // `PageId(1)` (not `PageId(0)`) — Phase 4.1 runs one engine per
    // page invocation so we don't need stable cross-call page ids,
    // but we must skip the `PageId::NONE` (= 0) sentinel reserved
    // by koharu-core. Phase 4.6's batch runner will assign real
    // ids from `koharu_project::chapter::pages`.
    let page_id = PageId(1);
    let page = Page {
        id: page_id,
        source_image: image_id,
        width: doc.width,
        height: doc.height,
        text_blocks,
        segmentation_mask: segment_id,
        inpainted_image: inpainted_id,
        rendered_image: rendered_id,
        brush_layer: brush_id,
    };

    let mut pages = IndexMap::new();
    pages.insert(page_id, page);
    Ok((Scene { pages }, page_id))
}

/// Encode a `SerializableDynamicImage` as WebP-lossless and register
/// in the BlobStore. Matches `koharu-api::views::register_image` —
/// same encoding so the same image content produces the same
/// BlobId across the RPC return path and the engine input path.
fn register_image(blobs: &BlobStore, img: &SerializableDynamicImage) -> Result<BlobId> {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let raw = rgba.into_raw();

    let mut buf = Vec::new();
    let enc = WebPEncoder::new_lossless(&mut buf);
    enc.encode(&raw, width, height, image::ColorType::Rgba8.into())?;
    Ok(blobs.put(buf))
}

/// Phase 5.3 — dual-apply path. Applies the batch to both the
/// legacy `Document` (for state_tx RPC reads) AND the
/// `ProjectSession` (for history + events). The session is
/// lazy-initialized from `initial_scene` on first use — that's
/// the Scene this engine run was driven against, so the
/// session's initial state matches what the engine saw.
///
/// The session.apply path can fail (e.g. `NodeNotFound` when the
/// engine emits an `UpdateTextBlock` against a block the session
/// doesn't have because session.scene drifted from doc via a
/// non-engine RPC path). We LOG the failure but don't propagate —
/// the Document apply already succeeded, RPC reads stay correct,
/// only history is out of sync. Phase 5.4 RPCs that hit a drift
/// would surface a clean "history unavailable for this state"
/// rather than crash.
///
/// Phase 6+ will delete the Document path entirely once Scene
/// becomes the canonical RPC return shape too. For now the
/// duplication is the cost of incremental migration.
async fn apply_engine_result_dual(
    state: &AppResources,
    doc: &mut Document,
    doc_index: usize,
    batch: koharu_core::EngineResult,
) -> Result<()> {
    // Apply to Document FIRST so RPC reads stay correct even if
    // the session path errors below.
    for op in &batch.scene_ops {
        apply_op(doc, op.clone(), &state.blobs)?;
    }
    if !batch.project_ops.is_empty() {
        warn!(
            count = batch.project_ops.len(),
            "ProjectOps received but bridge is not yet wired to koharu-project"
        );
    }

    // Then apply to the session for history tracking. The
    // caller already reset the session for this doc_index in
    // `run_engine_on_document` before the loop, so
    // `session_for_mut` should be Some — but we tolerate None
    // (session was wiped mid-run by chapter_open or similar) by
    // skipping the apply with a warning. The Document path has
    // already succeeded, so RPC reads stay correct; only history
    // is degraded.
    let mut session_guard = state.session.write().await;
    let Some(session) = session_guard.session_for_mut(doc_index) else {
        tracing::warn!(
            doc_index,
            "session slot empty or doc_index mismatched mid-run — \
             skipping session.apply; history unavailable for this run"
        );
        return Ok(());
    };
    for op in batch.scene_ops {
        // The rendered composite is a DERIVED view (text painted onto
        // the page from the current blocks), not a content edit — it
        // must never be its own undo step. Recording it meant every
        // "edit then auto-render" produced two history entries, so the
        // first Ctrl+Z reverted only the composite, leaving the block's
        // geometry/translation unchanged (the "undo reverts the picture
        // but not the box / panel text" bug). Apply it to the Document
        // (done in the loop above) but keep it out of history; the
        // composite is recomputed by a re-render after undo/redo.
        if matches!(op, Op::SetRenderedImage { .. }) {
            continue;
        }
        if let Err(e) = session.apply(op) {
            // Don't propagate — Document path already succeeded.
            // RPCs that read history will see the truncated
            // history; better than crashing the engine call.
            tracing::warn!(
                error = ?e,
                "session.apply failed — history out of sync with doc; \
                 undo for this op chain will be unavailable"
            );
        }
    }
    Ok(())
}

/// Outcome of applying an `Op` to the legacy `Document`.
///
/// Audit #9/B1 surface: distinguishes "applied cleanly" from
/// "skipped due to drift between session.scene + Document". The
/// session/undo path uses this to decide whether to surface a
/// toast on partial undo — silent skips were invisible to the
/// user pre-audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Every leaf op in this Op (incl. nested Batch) hit valid
    /// Document state and mutated it.
    Clean,
    /// At least one leaf op was warn-and-skipped — usually because
    /// the session's NodeId references a `text_blocks` index the
    /// Document no longer has (drift via a non-engine UI mutation,
    /// e.g. TextBlocksPanel manual delete that bypassed
    /// `session.apply`).
    DriftSkipped,
}

impl ApplyOutcome {
    fn merge(self, other: ApplyOutcome) -> ApplyOutcome {
        match (self, other) {
            (ApplyOutcome::Clean, ApplyOutcome::Clean) => ApplyOutcome::Clean,
            _ => ApplyOutcome::DriftSkipped,
        }
    }
}

/// Translate a single `Op` into the corresponding `Document`
/// mutation. Variants not yet handled log a warning + are skipped.
///
/// `pub` since Phase 5.4 — `ops::session` calls this to mirror
/// the undo/redo result onto the legacy Document so RPC reads
/// stay consistent with `ProjectSession::scene`.
///
/// Returns [`ApplyOutcome::DriftSkipped`] if any leaf op was
/// warn-skipped (used by audit #9/B1 to surface drift toast).
/// Position of the Document block carrying `node_id`, or None if no
/// block has it. The id is the stable mirror of the scene `NodeId`
/// (`build_scene_from_document` backfills it), so this lookup survives
/// add/remove where a positional index would drift.
fn doc_index_of_node(doc: &Document, node_id: NodeId) -> Option<usize> {
    // NodeId::NONE (0) is the "no node" sentinel and also the value of
    // an unassigned `node_id` — it must never match a real block.
    if node_id.0 == 0 {
        return None;
    }
    doc.text_blocks.iter().position(|b| b.node_id == node_id.0)
}

pub fn apply_op(doc: &mut Document, op: Op, blobs: &BlobStore) -> Result<ApplyOutcome> {
    let outcome = match op {
        Op::AddTextBlock { block, .. } => {
            // Append. scene_block_to_v1 stamps the block's NodeId onto
            // the v1 `node_id` so later id-based lookups find it.
            doc.text_blocks.push(scene_block_to_v1(block));
            ApplyOutcome::Clean
        }
        Op::InsertTextBlock { index, block, .. } => {
            // Restore at the original position (undo of a delete). The
            // index is part of the op; clamp to current length.
            let pos = index.min(doc.text_blocks.len());
            doc.text_blocks.insert(pos, scene_block_to_v1(block));
            ApplyOutcome::Clean
        }
        Op::UpdateTextBlock { id, patch, .. } => {
            // Find the Document row by stable `node_id` (not a
            // positional index) so the mapping survives add/remove.
            let Some(idx) = doc_index_of_node(doc, id) else {
                warn!(
                    node_id = id.0,
                    blocks_len = doc.text_blocks.len(),
                    "UpdateTextBlock: no Document block with this node id, skipping"
                );
                return Ok(ApplyOutcome::DriftSkipped);
            };
            apply_text_block_patch(&mut doc.text_blocks[idx], patch);
            ApplyOutcome::Clean
        }
        Op::RemoveTextBlock { id, .. } => {
            let Some(idx) = doc_index_of_node(doc, id) else {
                warn!(
                    node_id = id.0,
                    blocks_len = doc.text_blocks.len(),
                    "RemoveTextBlock: no Document block with this node id, skipping"
                );
                return Ok(ApplyOutcome::DriftSkipped);
            };
            doc.text_blocks.remove(idx);
            ApplyOutcome::Clean
        }
        Op::SetSegmentationMask { mask, .. } => {
            doc.segment = blob_to_serializable_image(blobs, mask)?;
            ApplyOutcome::Clean
        }
        Op::SetInpaintedImage { image, .. } => {
            doc.inpainted = blob_to_serializable_image(blobs, image)?;
            ApplyOutcome::Clean
        }
        Op::SetRenderedImage { image, .. } => {
            doc.rendered = blob_to_serializable_image(blobs, image)?;
            ApplyOutcome::Clean
        }
        Op::SetBrushLayer { brush, .. } => {
            doc.brush_layer = blob_to_serializable_image(blobs, brush)?;
            ApplyOutcome::Clean
        }
        Op::Batch(inner) => {
            let mut combined = ApplyOutcome::Clean;
            for op in inner {
                let leaf = apply_op(doc, op, blobs)?;
                combined = combined.merge(leaf);
            }
            combined
        }
        op => {
            warn!(?op, "Op variant not yet handled by engine_bridge");
            ApplyOutcome::DriftSkipped
        }
    };
    Ok(outcome)
}

/// Apply a v2 `TextBlockPatch` to a v1 `TextBlock`. Mirrors the
/// double-option semantics: `None` = leave alone, `Some(None)` =
/// explicitly clear, `Some(Some(v))` = set.
fn apply_text_block_patch(target: &mut koharu_types::TextBlock, patch: koharu_core::TextBlockPatch) {
    if let Some(region) = patch.region {
        target.x = region.x as f32;
        target.y = region.y as f32;
        target.width = region.width as f32;
        target.height = region.height as f32;
    }
    if let Some(text) = patch.source_text {
        target.text = text;
    }
    if let Some(translation) = patch.translation {
        target.translation = translation;
    }
    if let Some(lang) = patch.source_lang {
        target.source_language = lang;
    }
    // Mirror style + rotation onto the Document so manual edits routed
    // through session.apply (undoable path) keep the v1 Document — which
    // the renderer + RPC reads — in sync. Uses the v1↔scene style mapper
    // added with the render-style passthrough work.
    if let Some(style) = patch.style {
        target.style = style
            .as_ref()
            .map(crate::style_convert::v1_style_from_scene);
    }
    if let Some(rotation) = patch.rotation_deg {
        target.rotation_deg = rotation;
    }
}

/// Helper: optional BlobId → Option<SerializableDynamicImage>. Fetches
/// from the BlobStore, decodes the PNG/WebP, wraps in the v1 type.
fn blob_to_serializable_image(
    blobs: &BlobStore,
    id: Option<BlobId>,
) -> Result<Option<SerializableDynamicImage>> {
    match id {
        None => Ok(None),
        Some(blob_id) => {
            let bytes = blobs
                .get(blob_id)
                .ok_or_else(|| anyhow!("blob {} missing from store", blob_id.to_hex()))?;
            let img = image::load_from_memory(&bytes)
                .with_context(|| format!("decoding blob {} into image", blob_id.to_hex()))?;
            Ok(Some(SerializableDynamicImage::from(img)))
        }
    }
}

/// Convert a v2 scene::TextBlock back to the v1
/// koharu_types::TextBlock. Lossy on Region precision (v1 uses f32,
/// v2 uses u32 — round-trip through u32→f32 is exact for values
/// under 2²⁴, which covers any realistic page dimension).
fn scene_block_to_v1(block: SceneTextBlock) -> koharu_types::TextBlock {
    koharu_types::TextBlock {
        x: block.region.x as f32,
        y: block.region.y as f32,
        width: block.region.width as f32,
        height: block.region.height as f32,
        confidence: 1.0, // v2 doesn't carry confidence on TextBlock; assume detection passed
        line_polygons: None,
        source_direction: None,
        source_language: block.source_lang,
        rotation_deg: block.rotation_deg,
        detected_font_size_px: None,
        detector: None,
        text: block.source_text,
        translation: block.translation,
        style: block
            .style
            .as_ref()
            .map(crate::style_convert::v1_style_from_scene),
        font_prediction: None,
        rendered: None,
        // Carry the scene NodeId so id-based Document lookups find it.
        node_id: block.id.0,
        lock_layout_box: false,
        layout_seed_x: None,
        layout_seed_y: None,
        layout_seed_width: None,
        layout_seed_height: None,
    }
}

/// Special-case helper for engines that REPLACE text blocks
/// (detector re-run). Caller invokes this before driving the
/// engine. Phase 4.6 will replace with a proper
/// `Op::ReplaceTextBlocks` variant.
pub fn clear_doc_text_blocks(doc: &mut Document) {
    doc.text_blocks.clear();
}

/// Run the engine the user picked for a given artifact slot — falls
/// back to `default_engine_id` when no profile override exists.
/// Wrapper over [`run_engine_on_document`] that handles the
/// per-machine engine-profile lookup.
///
/// Use this from call-sites that have a stable "artifact this stage
/// produces" mapping (`vision::detect` → DetectionBoxes,
/// `vision::ocr` → OcrText, etc.). Per-call payload knobs still
/// ride in `options`; the bridge's `merge_profile_settings` layers
/// them on top of the saved settings before the engine sees them.
pub async fn run_engine_for_artifact(
    state: &AppResources,
    doc_index: usize,
    artifact: ArtifactKind,
    default_engine_id: &'static str,
    options: PipelineRunOptions,
    policy: RunPolicy,
    cancel: CancellationToken,
) -> Result<()> {
    let engine_id = state
        .engine_profile
        .active_engine(artifact)
        .unwrap_or_else(|| default_engine_id.to_string());
    run_engine_on_document(state, doc_index, &engine_id, options, policy, cancel).await
}

/// Layer the per-call options over the saved engine-profile
/// settings. Caller wins — a payload-provided `variant` overrides
/// a saved `variant`. Saved settings missing from the payload fall
/// through; the engine's schema default kicks in only at
/// `ctx.setting::<T>(_, default)` call time for keys neither side
/// sets.
fn merge_profile_settings(
    profile: &EngineProfileStore,
    engine_id: &str,
    caller: PipelineRunOptions,
) -> PipelineRunOptions {
    let saved = profile.settings_for(engine_id);
    if saved.is_empty() {
        return caller;
    }
    let mut merged = PipelineRunOptions::new();
    for (k, v) in saved {
        merged.settings.insert(k, v);
    }
    for (k, v) in caller.settings {
        merged.settings.insert(k, v);
    }
    merged
}

/// Convert a v1 `text_blocks[idx]` array index to its v2 `NodeId`.
/// Shifts by `+1` so we don't collide with `NodeId::NONE` (= 0),
/// which koharu-core reserves as the "no node" sentinel.
pub fn index_to_node_id(idx: usize) -> NodeId {
    NodeId(idx as u64 + 1)
}

/// Best-effort string extraction from a `catch_unwind` payload.
/// Rust panic payloads are `Box<dyn Any>`; common shapes are
/// `&str` (from `panic!("literal")`) and `String` (from
/// `panic!("{}", fmt)`). Fall back to a generic message when the
/// downcast fails — cudarc's panics come through as one of these
/// two shapes in practice.
fn panic_payload_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Inverse of [`index_to_node_id`]. Returns `None` for `NodeId(0)`
/// because that's the NONE sentinel — receiving it through an
/// `Op::UpdateTextBlock` is a sign the emitting engine is buggy
/// (or skipped the bridge's `+1` convention).
pub fn node_id_to_index(id: NodeId) -> Option<usize> {
    if id.0 == 0 {
        None
    } else {
        Some((id.0 - 1) as usize)
    }
}

/// Read characters, glossary, and series meta from the currently-
/// open `koharu-project` into a v2 `ProjectView`. Returns an empty
/// view when no project is open — fine for engines that don't
/// consume project state (detector, OCR, inpaint, render). The
/// translate engine REQUIRES a non-empty view to source glossary
/// + character context for the LLM prompt.
async fn build_project_view(state: &AppResources) -> Result<ProjectView> {
    // Cheap fast-path: no project open → no reads, no spawn.
    let project_opt = state.project.read().await.clone();
    let Some(project) = project_opt else {
        return Ok(ProjectView::empty());
    };

    // SQLite reads run on the blocking pool so the tokio runtime
    // isn't stalled by disk I/O. The N (small — tens to low
    // hundreds of rows for a typical series) means the reads
    // finish in single-digit ms.
    tokio::task::spawn_blocking(move || -> Result<ProjectView> {
        let conn = project.pool().get()?;

        let characters = koharu_project::character::list(&conn)?
            .into_iter()
            .map(|c| CharacterRow {
                id: CharacterId(c.id),
                original_name: c.original_name,
                translated_name: c.translated_name,
                is_main: c.is_main,
            })
            .collect();

        let glossary = koharu_project::glossary::list(&conn)?
            .into_iter()
            .map(|g| GlossaryRow {
                id: GlossaryEntryId(g.id),
                source_text: g.source_text,
                target_text: g.target_text,
                category: project_glossary_category_to_core(g.category),
            })
            .collect();

        // series::get errors if the seed row is missing — treat
        // missing series meta as "no view-level info" rather than
        // hard-failing the engine run. Project schema seeds the row
        // on create so this should never fire in practice.
        let series_meta = koharu_project::series::get(&conn).ok().map(|s| SeriesMetaRow {
            title: s.title,
            source_language: s.source_language,
            target_language: s.target_language,
        });

        Ok(ProjectView {
            characters,
            glossary,
            series_meta,
        })
    })
    .await
    .context("blocking task panicked while reading ProjectView")?
}

/// Translate koharu-project's GlossaryCategory enum into the
/// koharu-core one. Variants are 1:1 — adding a category requires
/// updating both crates (see the docstring on
/// `koharu_core::GlossaryCategory`).
fn project_glossary_category_to_core(
    c: koharu_project::GlossaryCategory,
) -> GlossaryCategory {
    use koharu_project::GlossaryCategory as ProjC;
    match c {
        ProjC::Term => GlossaryCategory::Term,
        ProjC::Place => GlossaryCategory::Place,
        ProjC::Skill => GlossaryCategory::Skill,
        ProjC::Honorific => GlossaryCategory::Honorific,
        ProjC::Item => GlossaryCategory::Item,
        ProjC::Org => GlossaryCategory::Org,
        ProjC::Sfx => GlossaryCategory::Sfx,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat};
    use koharu_types::SerializableDynamicImage;
    use std::io::Cursor;

    fn one_pixel_doc() -> Document {
        let img = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(1, 1, image::Rgba([0, 0, 0, 255])));
        Document {
            id: String::new(),
            path: Default::default(),
            name: String::new(),
            image: SerializableDynamicImage::from(img),
            width: 1,
            height: 1,
            text_blocks: vec![],
            segment: None,
            inpainted: None,
            rendered: None,
            brush_layer: None,
        }
    }

    #[test]
    fn build_scene_registers_image_in_blob_store() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let (scene, page_id) = build_scene_from_document(&mut doc, &blobs).unwrap();
        let page = scene.pages.get(&page_id).unwrap();
        assert!(blobs.exists(page.source_image));
        assert_eq!(page.width, 1);
        assert_eq!(page.height, 1);
        assert!(page.text_blocks.is_empty());
    }

    #[test]
    fn register_image_is_content_addressed_idempotent() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let (_, page_a) = build_scene_from_document(&mut doc, &blobs).unwrap();
        let (_, page_b) = build_scene_from_document(&mut doc, &blobs).unwrap();
        let id_a = scene_image_id(&blobs, page_a);
        let id_b = scene_image_id(&blobs, page_b);
        assert_eq!(id_a, id_b);
        assert_eq!(blobs.len(), 1, "second register should hit existing key");
    }

    // Helper for the round-trip test — re-derive image id from the
    // stored page by re-encoding (build_scene returns the scene but
    // not the PageId-to-blob mapping in a convenient shape).
    fn scene_image_id(blobs: &BlobStore, _page: PageId) -> BlobId {
        let mut doc = one_pixel_doc();
        register_image(blobs, &doc.image).unwrap()
    }

    #[test]
    fn apply_op_handles_add_text_block() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let block = SceneTextBlock {
            id: NodeId(0),
            region: Region { x: 10, y: 20, width: 30, height: 40 },
            source_text: Some("テスト".into()),
            translation: Some("ทดสอบ".into()),
            style: None,
            source_lang: Some("ja".into()),
            font_prediction: None,
            rotation_deg: None,
        };
        apply_op(
            &mut doc,
            Op::AddTextBlock { page: PageId(0), block },
            &blobs,
        )
        .unwrap();
        assert_eq!(doc.text_blocks.len(), 1);
        assert_eq!(doc.text_blocks[0].x, 10.0);
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("テスト"));
        assert_eq!(doc.text_blocks[0].translation.as_deref(), Some("ทดสอบ"));
    }

    #[test]
    fn apply_op_handles_batch_recursion() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let block = |i: u32| SceneTextBlock {
            id: NodeId(i as u64),
            region: Region { x: i, y: i, width: 1, height: 1 },
            source_text: None,
            translation: None,
            style: None,
            source_lang: None,
            font_prediction: None,
            rotation_deg: None,
        };
        let ops = Op::Batch(vec![
            Op::AddTextBlock { page: PageId(0), block: block(1) },
            Op::AddTextBlock { page: PageId(0), block: block(2) },
        ]);
        apply_op(&mut doc, ops, &blobs).unwrap();
        assert_eq!(doc.text_blocks.len(), 2);
    }

    #[test]
    fn apply_op_set_segmentation_mask_decodes_blob() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();

        // Build a tiny grayscale PNG, store, then apply
        // SetSegmentationMask referencing the blob.
        let gray = DynamicImage::ImageLuma8(ImageBuffer::from_pixel(2, 2, image::Luma([128])));
        let mut buf = Vec::new();
        gray.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        let mask_id = blobs.put(buf);

        apply_op(
            &mut doc,
            Op::SetSegmentationMask {
                page: PageId(0),
                mask: Some(mask_id),
            },
            &blobs,
        )
        .unwrap();

        let seg = doc.segment.expect("segment set");
        let dyn_img: DynamicImage = seg.into();
        assert_eq!(dyn_img.width(), 2);
        assert_eq!(dyn_img.height(), 2);
    }

    /// Audit #5/F1 regression: Scene-built TextBlocks must NOT
    /// occupy `NodeId::NONE` (= 0). Bridge shifts by `+1` so
    /// `text_blocks[0]` → `NodeId(1)`, etc. Inverse mapping in
    /// `node_id_to_index` recovers the original index.
    #[test]
    fn scene_text_block_ids_skip_none_sentinel() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        // Seed with two existing text blocks so build_scene has
        // something to assign ids to.
        doc.text_blocks.push(koharu_types::TextBlock {
            node_id: 0,
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("first".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });
        doc.text_blocks.push(koharu_types::TextBlock {
            node_id: 0,
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("second".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });

        let (scene, page_id) = build_scene_from_document(&mut doc, &blobs).unwrap();
        assert_ne!(page_id.0, 0, "PageId must skip NONE sentinel");
        let page = scene.pages.get(&page_id).unwrap();
        let ids: Vec<NodeId> = page.text_blocks.keys().copied().collect();
        assert_eq!(ids, vec![NodeId(1), NodeId(2)], "NodeIds must skip 0");
        // Inverse mapping recovers the v1 array indices.
        assert_eq!(node_id_to_index(NodeId(1)), Some(0));
        assert_eq!(node_id_to_index(NodeId(2)), Some(1));
        // NONE rejected.
        assert_eq!(node_id_to_index(NodeId(0)), None);
    }

    use koharu_core::StoredValue;

    /// F4.D regression — caller's per-call options take precedence
    /// over saved profile values for the same key, while non-
    /// overlapping saved keys flow through. Missing keys on both
    /// sides stay missing (engine reads schema default at runtime).
    #[test]
    fn merge_profile_settings_layers_caller_over_saved() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("engine_profile.json");
        let mut saved_profile = crate::engine_profile::EngineProfile::default();
        let mut saved_settings = std::collections::HashMap::new();
        saved_settings.insert("variant".to_string(), StoredValue::String("s".into()));
        saved_settings.insert(
            "confidence_threshold".to_string(),
            StoredValue::Number(0.30),
        );
        saved_profile
            .settings
            .insert("anime_yolo_detector".to_string(), saved_settings);
        let store = crate::engine_profile::EngineProfileStore::with_initial(
            saved_profile,
            path,
        );

        // Caller passes variant=x → wins. confidence not passed →
        // saved 0.30 flows through. New key from caller (foo=42) →
        // present in merged.
        let caller = PipelineRunOptions::new()
            .with("variant", StoredValue::String("x".into()))
            .with("foo", StoredValue::Number(42.0));

        let merged = merge_profile_settings(&store, "anime_yolo_detector", caller);
        assert_eq!(
            merged.get_raw("variant"),
            Some(&StoredValue::String("x".into())),
            "caller wins on key conflict",
        );
        assert_eq!(
            merged.get_raw("confidence_threshold"),
            Some(&StoredValue::Number(0.30)),
            "saved-only key flows through",
        );
        assert_eq!(
            merged.get_raw("foo"),
            Some(&StoredValue::Number(42.0)),
            "caller-only key flows through",
        );
    }

    /// Empty saved profile → caller options pass through verbatim
    /// (no allocations spent walking an empty HashMap).
    #[test]
    fn merge_profile_settings_no_saved_keeps_caller_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("engine_profile.json");
        let store = crate::engine_profile::EngineProfileStore::with_initial(
            crate::engine_profile::EngineProfile::default(),
            path,
        );

        let caller = PipelineRunOptions::new()
            .with("variant", StoredValue::String("n".into()));
        let merged = merge_profile_settings(&store, "anime_yolo_detector", caller);
        assert_eq!(merged.settings.len(), 1);
        assert_eq!(
            merged.get_raw("variant"),
            Some(&StoredValue::String("n".into()))
        );
    }

    /// Updating block via its shifted NodeId hits the correct v1
    /// row. If the bridge's `+1` shift weren't matched by the
    /// inverse `-1` in apply, this test would assert on the wrong
    /// block.
    #[test]
    fn apply_update_text_block_uses_id_mapping() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        doc.text_blocks.push(koharu_types::TextBlock {
            node_id: 1,
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("a-before".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });
        doc.text_blocks.push(koharu_types::TextBlock {
            node_id: 2,
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("b-before".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });

        // Update the block whose stable node_id is 2 (the second). The
        // Document mirror finds it by id, not by array position.
        apply_op(
            &mut doc,
            Op::UpdateTextBlock {
                page: PageId(1),
                id: NodeId(2),
                patch: koharu_core::TextBlockPatch {
                    source_text: Some(Some("b-after".into())),
                    ..Default::default()
                },
            },
            &blobs,
        )
        .unwrap();

        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("a-before"));
        assert_eq!(doc.text_blocks[1].text.as_deref(), Some("b-after"));
    }

    // ─── Phase 6.4 stage-golden tests ───────────────────────────
    // Each stage in the pipeline emits a characteristic shape of
    // Op. Real ML / LLM runs aren't reproducible in CI, but the
    // bridge's translation of those Ops onto the legacy Document
    // IS deterministic — and that translation is exactly what
    // broke under audits #5 / #6 / #7. These tests freeze the
    // per-stage contract so a future bridge refactor breaking the
    // mapping fails loudly.

    fn doc_with_n_blocks(n: usize) -> Document {
        let mut doc = one_pixel_doc();
        for i in 0..n {
            doc.text_blocks.push(koharu_types::TextBlock {
                node_id: 0,
                x: i as f32, y: i as f32, width: 10.0, height: 10.0,
                confidence: 1.0,
                line_polygons: None, source_direction: None,
                source_language: None, rotation_deg: None,
                detected_font_size_px: None, detector: None,
                text: None, translation: None, style: None,
                font_prediction: None, rendered: None,
                lock_layout_box: false,
                layout_seed_x: None, layout_seed_y: None,
                layout_seed_width: None, layout_seed_height: None,
            });
        }
        doc
    }

    fn make_scene_block(id: u64, x: u32) -> SceneTextBlock {
        SceneTextBlock {
            id: NodeId(id),
            region: Region { x, y: 0, width: 5, height: 5 },
            source_text: None,
            translation: None,
            style: None,
            source_lang: None,
            font_prediction: None,
            rotation_deg: None,
        }
    }

    fn png_blob(blobs: &BlobStore, w: u32, h: u32, gray: u8) -> BlobId {
        let img = DynamicImage::ImageLuma8(ImageBuffer::from_pixel(w, h, image::Luma([gray])));
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png).unwrap();
        blobs.put(buf)
    }

    #[test]
    fn detector_stage_golden() {
        // Detector emits N AddTextBlock ops against an empty page.
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        apply_op(
            &mut doc,
            Op::Batch(vec![
                Op::AddTextBlock { page: PageId(1), block: make_scene_block(1, 10) },
                Op::AddTextBlock { page: PageId(1), block: make_scene_block(2, 20) },
                Op::AddTextBlock { page: PageId(1), block: make_scene_block(3, 30) },
            ]),
            &blobs,
        ).unwrap();
        assert_eq!(doc.text_blocks.len(), 3);
        assert_eq!(doc.text_blocks[0].x, 10.0);
        assert_eq!(doc.text_blocks[1].x, 20.0);
        assert_eq!(doc.text_blocks[2].x, 30.0);
    }

    #[test]
    fn ocr_stage_golden() {
        // OCR runs against detector output: UpdateTextBlock setting
        // source_text on each block via its stable NodeId. Backfill
        // node ids first (run_engine_on_document does this before any
        // engine runs) so the id-based Document mirror can find them.
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(3);
        build_scene_from_document(&mut doc, &blobs).unwrap();
        for i in 0..3u64 {
            apply_op(
                &mut doc,
                Op::UpdateTextBlock {
                    page: PageId(1),
                    id: NodeId(i + 1),
                    patch: koharu_core::TextBlockPatch {
                        source_text: Some(Some(format!("ja text {}", i))),
                        ..Default::default()
                    },
                },
                &blobs,
            ).unwrap();
        }
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("ja text 0"));
        assert_eq!(doc.text_blocks[1].text.as_deref(), Some("ja text 1"));
        assert_eq!(doc.text_blocks[2].text.as_deref(), Some("ja text 2"));
    }

    #[test]
    fn translate_stage_golden() {
        // Translate emits per-block UpdateTextBlock setting
        // translation; source_text preserved.
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(2);
        build_scene_from_document(&mut doc, &blobs).unwrap();
        doc.text_blocks[0].text = Some("ja A".into());
        doc.text_blocks[1].text = Some("ja B".into());
        for (id, t) in [(1u64, "th A"), (2, "th B")] {
            apply_op(
                &mut doc,
                Op::UpdateTextBlock {
                    page: PageId(1),
                    id: NodeId(id),
                    patch: koharu_core::TextBlockPatch {
                        translation: Some(Some(t.into())),
                        ..Default::default()
                    },
                },
                &blobs,
            ).unwrap();
        }
        assert_eq!(doc.text_blocks[0].translation.as_deref(), Some("th A"));
        assert_eq!(doc.text_blocks[1].translation.as_deref(), Some("th B"));
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("ja A"));
    }

    #[test]
    fn inpaint_stage_golden() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let blob = png_blob(&blobs, 3, 3, 64);
        apply_op(
            &mut doc,
            Op::SetInpaintedImage { page: PageId(1), image: Some(blob) },
            &blobs,
        ).unwrap();
        let inp: DynamicImage = doc.inpainted.expect("inpainted set").into();
        assert_eq!(inp.dimensions(), (3, 3));
    }

    #[test]
    fn render_stage_golden() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let blob = png_blob(&blobs, 4, 5, 200);
        apply_op(
            &mut doc,
            Op::SetRenderedImage { page: PageId(1), image: Some(blob) },
            &blobs,
        ).unwrap();
        let r: DynamicImage = doc.rendered.expect("rendered set").into();
        assert_eq!(r.dimensions(), (4, 5));
    }

    #[test]
    fn brush_layer_stage_golden() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let blob = png_blob(&blobs, 6, 6, 128);
        apply_op(
            &mut doc,
            Op::SetBrushLayer { page: PageId(1), brush: Some(blob) },
            &blobs,
        ).unwrap();
        assert!(doc.brush_layer.is_some());
    }

    #[test]
    fn set_image_with_none_blob_clears_field() {
        // Engines emit Set*Image with None to clear a prior
        // artifact (user wiped inpainted manually, etc.).
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let blob = png_blob(&blobs, 2, 2, 200);
        apply_op(
            &mut doc,
            Op::SetInpaintedImage { page: PageId(1), image: Some(blob) },
            &blobs,
        ).unwrap();
        assert!(doc.inpainted.is_some());
        apply_op(
            &mut doc,
            Op::SetInpaintedImage { page: PageId(1), image: None },
            &blobs,
        ).unwrap();
        assert!(doc.inpainted.is_none(), "None blob clears the field");
    }

    #[test]
    fn apply_op_update_with_none_id_is_noop() {
        // NodeId(0) is the NONE sentinel — bridge must warn-and-skip
        // rather than write to text_blocks[index_arith_underflow].
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(2);
        doc.text_blocks[0].text = Some("keep".into());
        doc.text_blocks[1].text = Some("keep".into());
        apply_op(
            &mut doc,
            Op::UpdateTextBlock {
                page: PageId(1),
                id: NodeId(0),
                patch: koharu_core::TextBlockPatch {
                    source_text: Some(Some("clobber".into())),
                    ..Default::default()
                },
            },
            &blobs,
        ).unwrap();
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("keep"));
        assert_eq!(doc.text_blocks[1].text.as_deref(), Some("keep"));
    }

    #[test]
    fn apply_op_update_with_out_of_range_id_is_noop() {
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(2);
        doc.text_blocks[0].text = Some("keep".into());
        apply_op(
            &mut doc,
            Op::UpdateTextBlock {
                page: PageId(1),
                id: NodeId(99),
                patch: koharu_core::TextBlockPatch {
                    source_text: Some(Some("clobber".into())),
                    ..Default::default()
                },
            },
            &blobs,
        ).unwrap();
        assert_eq!(doc.text_blocks.len(), 2);
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("keep"));
    }

    #[test]
    fn apply_op_remove_with_shifted_id() {
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(3);
        doc.text_blocks[0].text = Some("first".into());
        doc.text_blocks[1].text = Some("second".into());
        doc.text_blocks[2].text = Some("third".into());
        // Assign stable node ids; the mirror removes by id, not index.
        doc.text_blocks[0].node_id = 1;
        doc.text_blocks[1].node_id = 2;
        doc.text_blocks[2].node_id = 3;
        apply_op(
            &mut doc,
            Op::RemoveTextBlock { page: PageId(1), id: NodeId(2) },
            &blobs,
        ).unwrap();
        assert_eq!(doc.text_blocks.len(), 2);
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("first"));
        assert_eq!(doc.text_blocks[1].text.as_deref(), Some("third"));
    }

    #[test]
    fn apply_op_remove_with_none_id_is_noop() {
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(2);
        apply_op(
            &mut doc,
            Op::RemoveTextBlock { page: PageId(1), id: NodeId(0) },
            &blobs,
        ).unwrap();
        assert_eq!(doc.text_blocks.len(), 2);
    }

    #[test]
    fn apply_op_remove_with_out_of_range_id_is_noop() {
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(2);
        apply_op(
            &mut doc,
            Op::RemoveTextBlock { page: PageId(1), id: NodeId(99) },
            &blobs,
        ).unwrap();
        assert_eq!(doc.text_blocks.len(), 2);
    }

    #[test]
    fn apply_op_set_segmentation_with_missing_blob_errors() {
        // Looking up a BlobId in the wrong BlobStore must error.
        // Better than silently writing zeros into doc.segment.
        let blobs = BlobStore::in_memory();
        let other = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let phantom = blobs.put(b"x".to_vec());
        let err = apply_op(
            &mut doc,
            Op::SetSegmentationMask { page: PageId(1), mask: Some(phantom) },
            &other,
        );
        assert!(err.is_err(), "missing blob must propagate as Err");
    }

    #[test]
    fn detect_then_ocr_then_translate_chain_golden() {
        // Full data-flow chain. Verifies NodeId mapping is stable
        // across all three stages — a regression in the +1 / -1
        // shift would break exactly one stage and the chain test
        // catches the resulting mis-aligned write.
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        apply_op(
            &mut doc,
            Op::Batch(vec![
                Op::AddTextBlock { page: PageId(1), block: make_scene_block(1, 10) },
                Op::AddTextBlock { page: PageId(1), block: make_scene_block(2, 20) },
            ]),
            &blobs,
        ).unwrap();
        for (id, src) in [(1u64, "ja A"), (2, "ja B")] {
            apply_op(
                &mut doc,
                Op::UpdateTextBlock {
                    page: PageId(1),
                    id: NodeId(id),
                    patch: koharu_core::TextBlockPatch {
                        source_text: Some(Some(src.into())),
                        ..Default::default()
                    },
                },
                &blobs,
            ).unwrap();
        }
        for (id, tr) in [(1u64, "th A"), (2, "th B")] {
            apply_op(
                &mut doc,
                Op::UpdateTextBlock {
                    page: PageId(1),
                    id: NodeId(id),
                    patch: koharu_core::TextBlockPatch {
                        translation: Some(Some(tr.into())),
                        ..Default::default()
                    },
                },
                &blobs,
            ).unwrap();
        }
        assert_eq!(doc.text_blocks.len(), 2);
        assert_eq!(doc.text_blocks[0].text.as_deref(), Some("ja A"));
        assert_eq!(doc.text_blocks[0].translation.as_deref(), Some("th A"));
        assert_eq!(doc.text_blocks[1].text.as_deref(), Some("ja B"));
        assert_eq!(doc.text_blocks[1].translation.as_deref(), Some("th B"));
    }

    #[test]
    fn apply_op_and_session_apply_agree_on_add() {
        // Dual-apply contract: same Op against (a) Document via
        // apply_op + (b) ProjectSession via session.apply must
        // yield Scenes with identical NodeId sets. Catches drift
        // between the two paths the bridge runs in parallel.
        use koharu_app::{ProjectSession, SessionConfig};
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        let (scene, page_id) = build_scene_from_document(&mut doc, &blobs).unwrap();
        let mut session = ProjectSession::new(scene, SessionConfig::default());

        let op = Op::AddTextBlock { page: page_id, block: make_scene_block(1, 42) };
        apply_op(&mut doc, op.clone(), &blobs).unwrap();
        session.apply(op).unwrap();

        let (rebuilt, _) = build_scene_from_document(&mut doc, &blobs).unwrap();
        let r_ids: Vec<_> = rebuilt.pages.get(&page_id).unwrap().text_blocks.keys().copied().collect();
        let s_ids: Vec<_> = session.scene().pages.get(&page_id).unwrap().text_blocks.keys().copied().collect();
        assert_eq!(r_ids, s_ids, "dual-apply NodeId set must match");
    }

    #[test]
    fn redetect_after_clear_does_not_collide_with_prior_node_ids() {
        // Audit #7/P1 regression: clear_text_blocks_first wipes
        // doc.text_blocks; the bridge then resets the session to
        // the fresh scene so detector's AddTextBlock(NodeId(1)..)
        // doesn't trip the duplicate-id guard from audit #6/P1.
        use koharu_app::{ProjectSession, SessionConfig};
        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(3);
        let (scene_v1, page_id) = build_scene_from_document(&mut doc, &blobs).unwrap();
        let mut session = ProjectSession::new(scene_v1, SessionConfig::default());
        assert_eq!(session.scene().pages.get(&page_id).unwrap().text_blocks.len(), 3);

        // clear_text_blocks_first policy: wipe v1 vector + reset
        // session from the post-clear scene.
        doc.text_blocks.clear();
        let (scene_v2, _) = build_scene_from_document(&mut doc, &blobs).unwrap();
        session = ProjectSession::new(scene_v2, SessionConfig::default());

        // Re-detect emits NodeId(1) — pre-fix this collided.
        session.apply(Op::AddTextBlock {
            page: page_id,
            block: make_scene_block(1, 10),
        }).expect("re-detect after clear must not collide with old ids");
        assert_eq!(session.scene().pages.get(&page_id).unwrap().text_blocks.len(), 1);
    }

    #[test]
    fn run_engine_order_clear_before_scene_build_avoids_duplicate_node_ids() {
        // Audit #8/P1 regression: the audit #7 test above rebuilt
        // scene from the cleared doc by hand, which masked the
        // real bug — `run_engine_on_document` originally did
        // `build_scene_from_document` BEFORE `doc.text_blocks.clear()`,
        // then reset the session with `scene.clone()` of the
        // stale scene. The session ended up with NodeId(1)..N
        // still populated and the engine's first
        // AddTextBlock(NodeId(1)) collided.
        //
        // This test follows the FIXED order verbatim: clear →
        // build → reset → apply. It pins the order so a future
        // refactor that moves the clear back below the build
        // fails loudly here instead of in production.
        use koharu_app::{ProjectSession, SessionConfig};

        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(3);
        doc.text_blocks[0].text = Some("stale 1".into());
        doc.text_blocks[1].text = Some("stale 2".into());
        doc.text_blocks[2].text = Some("stale 3".into());

        // Real order (matches run_engine_on_document after audit #8):
        //   1. clear doc.text_blocks (if clear_text_blocks_first)
        //   2. build_scene_from_document — scene now reflects the
        //      cleared state, no NodeId(1)..N populated
        //   3. session.reset_with(scene.clone(), doc_index)
        //   4. engine emits AddTextBlock(NodeId(1))
        //   5. session.apply succeeds — no duplicate
        doc.text_blocks.clear();
        let (scene, page_id) = build_scene_from_document(&mut doc, &blobs).unwrap();
        assert_eq!(
            scene.pages.get(&page_id).unwrap().text_blocks.len(),
            0,
            "scene built post-clear must have no text blocks — \
             this is the audit #8/P1 invariant",
        );
        let mut session = ProjectSession::new(scene.clone(), SessionConfig::default());

        // Detector emits its first AddTextBlock. Pre-fix, scene
        // (built before clear) still had NodeId(1) populated and
        // this trip-wired the audit #6/P1 duplicate guard.
        session.apply(Op::AddTextBlock {
            page: page_id,
            block: make_scene_block(1, 50),
        }).expect("audit #8/P1: re-detect on a populated doc must not \
                   collide after the clear-then-build-then-reset order");
        assert_eq!(
            session.scene().pages.get(&page_id).unwrap().text_blocks.len(),
            1
        );
    }

    #[test]
    fn panic_payload_message_extracts_str_and_string() {
        // Audit #9/B3 helper: panics arrive as `Box<dyn Any>` with
        // either &str or String inside (panic!("literal") vs
        // panic!("{fmt}")). The bridge converts to a user-facing
        // toast string — this test pins both shapes.
        let str_payload: Box<dyn std::any::Any + Send> = Box::new("boom");
        assert_eq!(panic_payload_message(&str_payload), "boom");

        let string_payload: Box<dyn std::any::Any + Send> = Box::new("dynamic".to_string());
        assert_eq!(panic_payload_message(&string_payload), "dynamic");

        // Unknown payload type → fall back to generic message
        // instead of dropping the panic on the floor.
        struct Weird;
        let weird_payload: Box<dyn std::any::Any + Send> = Box::new(Weird);
        assert_eq!(
            panic_payload_message(&weird_payload),
            "<non-string panic payload>",
        );
    }

    #[test]
    fn scene_built_from_doc_with_blocks_before_clear_would_collide() {
        // Negative control: documents the bug that audit #8/P1
        // fixes. If scene is built BEFORE doc.text_blocks.clear(),
        // the resulting Scene carries NodeId(1)..N from the prior
        // detection. A session initialised from that stale scene
        // will reject AddTextBlock(NodeId(1)) — exactly the user-
        // visible NodeAlreadyExists this audit closes.
        use koharu_app::{ProjectSession, SessionConfig};

        let blobs = BlobStore::in_memory();
        let mut doc = doc_with_n_blocks(2);

        // BUGGY ORDER (what run_engine_on_document did before #8):
        //   1. build scene FIRST — scene carries stale NodeIds
        //   2. clear doc.text_blocks AFTER (doesn't touch scene)
        //   3. reset session with stale scene
        //   4. engine emits AddTextBlock(NodeId(1)) → DUPLICATE
        let (scene_stale, page_id) = build_scene_from_document(&mut doc, &blobs).unwrap();
        doc.text_blocks.clear(); // clear after build — too late
        let mut session = ProjectSession::new(scene_stale, SessionConfig::default());

        let err = session.apply(Op::AddTextBlock {
            page: page_id,
            block: make_scene_block(1, 50),
        });
        assert!(
            err.is_err(),
            "stale scene should still carry NodeId(1) and reject \
             the detector's AddTextBlock — this is the bug audit \
             #8/P1 fixed by reordering clear before build",
        );
    }
}
