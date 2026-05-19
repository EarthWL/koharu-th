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
use image::codecs::webp::WebPEncoder;
use indexmap::IndexMap;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use koharu_core::{
    BlobId, BlobStore, CharacterId, CharacterRow, GlossaryCategory, GlossaryEntryId, GlossaryRow,
    NodeId, Op, PageId, PipelineRunOptions, ProjectView, Region, Scene, SeriesMetaRow,
    scene::Page, scene::TextBlock as SceneTextBlock,
};
use koharu_engines::{Engine, EngineCtx, info as engine_info};
use koharu_types::{Document, SerializableDynamicImage};

use crate::AppResources;

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

    // Load (async) — model weights + GPU init happen here on first
    // call. Driver should cache `Box<dyn Engine>` per engine id in
    // a real implementation; Phase 4.1 loads fresh each call to
    // keep the bridge focused on the wire shape.
    let engine: Box<dyn Engine> = (info.load)()
        .await
        .with_context(|| format!("loading engine '{}'", engine_id))?;

    // Read the document snapshot we'll feed to the engine.
    let mut doc = crate::state_tx::read_doc(&state.state, doc_index).await?;

    // Build the Scene shape the engine reads + the page id it
    // operates on.
    let (scene, page_id) = build_scene_from_document(&doc, &state.blobs)?;

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
        options: &options,
        cancel: &cancel,
    };

    // Run the engine in this task — back-pressure via the bounded
    // channel keeps memory bounded if the apply loop is slow.
    // tokio::select! ensures we don't deadlock if the engine sends
    // its final result and we're still pulling it off the channel
    // (we drop ops_tx via the run-future taking ownership; channel
    // closes when run returns, ops_rx.recv() then returns None).
    let run_future = engine.run(ctx, ops_tx);

    // Replace-policy: clear v1 text_blocks BEFORE applying any
    // AddTextBlock ops from the engine. We do this even if the
    // engine emits zero blocks — a fresh detection that returns
    // empty is still "no blocks", not "keep old ones".
    if policy.clear_text_blocks_first {
        doc.text_blocks.clear();
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
                    apply_engine_result(&mut doc, batch, &state.blobs)?;
                    apply_count += 1;
                }
                result.with_context(|| format!("engine '{}' run failed", engine_id))?;
                break;
            }
            maybe_batch = ops_rx.recv() => {
                match maybe_batch {
                    Some(batch) => {
                        apply_engine_result(&mut doc, batch, &state.blobs)?;
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
fn build_scene_from_document(doc: &Document, blobs: &BlobStore) -> Result<(Scene, PageId)> {
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
    // NodeId(idx + 1) — `+1` because `NodeId::NONE = 0` is the
    // koharu-core sentinel for "no node". Using NodeId(0) for a
    // real block would conflate it with NONE downstream. The
    // mapping is documented next to `index_to_node_id` /
    // `node_id_to_index`.
    let mut text_blocks: IndexMap<NodeId, SceneTextBlock> = IndexMap::new();
    for (idx, v1) in doc.text_blocks.iter().enumerate() {
        let id = index_to_node_id(idx);
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
                style: None, // v1 style shape differs; skip for Phase 4.1
                source_lang: v1.source_language.clone(),
                font_prediction: None, // converted on demand by translate/render engines
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

/// Apply one `EngineResult` batch to the Document. Scene ops mutate
/// the doc; project ops are ignored here (Phase 4.5 will route them
/// through `koharu-project`'s SQLite layer).
fn apply_engine_result(
    doc: &mut Document,
    batch: koharu_core::EngineResult,
    blobs: &BlobStore,
) -> Result<()> {
    for op in batch.scene_ops {
        apply_op(doc, op, blobs)?;
    }
    if !batch.project_ops.is_empty() {
        // Phase 4.1 skips project ops. The detector engine (the
        // only one Phase 4.2 swaps) doesn't emit any, so the warn
        // is a placeholder for when translate-extract-entities
        // lands.
        warn!(
            count = batch.project_ops.len(),
            "ProjectOps received but bridge is not yet wired to koharu-project (Phase 4.5)"
        );
    }
    Ok(())
}

/// Translate a single `Op` into the corresponding `Document`
/// mutation. Variants not yet handled log a warning + are skipped.
fn apply_op(doc: &mut Document, op: Op, blobs: &BlobStore) -> Result<()> {
    match op {
        Op::AddTextBlock { block, .. } => {
            doc.text_blocks.push(scene_block_to_v1(block));
        }
        Op::UpdateTextBlock { id, patch, .. } => {
            // Bridge maps `NodeId(idx + 1)` → v1 `text_blocks[idx]`.
            // The `+ 1` skips `NodeId::NONE` (= 0), reserved by
            // koharu-core as the "no node" sentinel — see id.rs.
            // build_scene_from_document assigns ids by array
            // position so the inverse mapping is `id.0 - 1`.
            // Engines never reorder Scene's IndexMap (read-only),
            // so the mapping is stable across the run.
            let Some(idx) = node_id_to_index(id) else {
                warn!(node_id = id.0, "UpdateTextBlock: node id is NONE, skipping");
                return Ok(());
            };
            let Some(target) = doc.text_blocks.get_mut(idx) else {
                warn!(
                    node_id = id.0,
                    array_index = idx,
                    blocks_len = doc.text_blocks.len(),
                    "UpdateTextBlock: node id out of range, skipping"
                );
                return Ok(());
            };
            apply_text_block_patch(target, patch);
        }
        Op::RemoveTextBlock { id, .. } => {
            let Some(idx) = node_id_to_index(id) else {
                warn!(node_id = id.0, "RemoveTextBlock: node id is NONE, skipping");
                return Ok(());
            };
            if idx < doc.text_blocks.len() {
                doc.text_blocks.remove(idx);
            } else {
                warn!(
                    node_id = id.0,
                    array_index = idx,
                    blocks_len = doc.text_blocks.len(),
                    "RemoveTextBlock: node id out of range, skipping"
                );
            }
        }
        Op::SetSegmentationMask { mask, .. } => {
            doc.segment = blob_to_serializable_image(blobs, mask)?;
        }
        Op::SetInpaintedImage { image, .. } => {
            doc.inpainted = blob_to_serializable_image(blobs, image)?;
        }
        Op::SetRenderedImage { image, .. } => {
            doc.rendered = blob_to_serializable_image(blobs, image)?;
        }
        Op::SetBrushLayer { brush, .. } => {
            doc.brush_layer = blob_to_serializable_image(blobs, brush)?;
        }
        Op::Batch(inner) => {
            for op in inner {
                apply_op(doc, op, blobs)?;
            }
        }
        op => {
            warn!(?op, "Op variant not yet handled by engine_bridge");
        }
    }
    Ok(())
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
    // patch.style intentionally not applied here — v1 TextStyle has
    // a different shape than v2's, and no engine currently emits
    // style updates. Phase 4.4's render engine will, with a proper
    // v1↔v2 style mapping helper.
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
        rotation_deg: None,
        detected_font_size_px: None,
        detector: None,
        text: block.source_text,
        translation: block.translation,
        style: None,
        font_prediction: None,
        rendered: None,
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

/// Convert a v1 `text_blocks[idx]` array index to its v2 `NodeId`.
/// Shifts by `+1` so we don't collide with `NodeId::NONE` (= 0),
/// which koharu-core reserves as the "no node" sentinel.
pub fn index_to_node_id(idx: usize) -> NodeId {
    NodeId(idx as u64 + 1)
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
    use image::{DynamicImage, ImageBuffer, ImageFormat};
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
        let doc = one_pixel_doc();
        let (scene, page_id) = build_scene_from_document(&doc, &blobs).unwrap();
        let page = scene.pages.get(&page_id).unwrap();
        assert!(blobs.exists(page.source_image));
        assert_eq!(page.width, 1);
        assert_eq!(page.height, 1);
        assert!(page.text_blocks.is_empty());
    }

    #[test]
    fn register_image_is_content_addressed_idempotent() {
        let blobs = BlobStore::in_memory();
        let doc = one_pixel_doc();
        let (_, page_a) = build_scene_from_document(&doc, &blobs).unwrap();
        let (_, page_b) = build_scene_from_document(&doc, &blobs).unwrap();
        let id_a = scene_image_id(&blobs, page_a);
        let id_b = scene_image_id(&blobs, page_b);
        assert_eq!(id_a, id_b);
        assert_eq!(blobs.len(), 1, "second register should hit existing key");
    }

    // Helper for the round-trip test — re-derive image id from the
    // stored page by re-encoding (build_scene returns the scene but
    // not the PageId-to-blob mapping in a convenient shape).
    fn scene_image_id(blobs: &BlobStore, _page: PageId) -> BlobId {
        let doc = one_pixel_doc();
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
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("first".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });
        doc.text_blocks.push(koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("second".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });

        let (scene, page_id) = build_scene_from_document(&doc, &blobs).unwrap();
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

    /// Updating block via its shifted NodeId hits the correct v1
    /// row. If the bridge's `+1` shift weren't matched by the
    /// inverse `-1` in apply, this test would assert on the wrong
    /// block.
    #[test]
    fn apply_update_text_block_uses_shifted_id_mapping() {
        let blobs = BlobStore::in_memory();
        let mut doc = one_pixel_doc();
        doc.text_blocks.push(koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("a-before".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });
        doc.text_blocks.push(koharu_types::TextBlock {
            x: 0.0, y: 0.0, width: 1.0, height: 1.0, confidence: 1.0,
            line_polygons: None, source_direction: None, source_language: None,
            rotation_deg: None, detected_font_size_px: None, detector: None,
            text: Some("b-before".into()), translation: None, style: None,
            font_prediction: None, rendered: None, lock_layout_box: false,
            layout_seed_x: None, layout_seed_y: None,
            layout_seed_width: None, layout_seed_height: None,
        });

        // Update the SECOND block (array index 1) via its shifted id
        // NodeId(2). Bridge inverse maps id-1 → index 1.
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
}
