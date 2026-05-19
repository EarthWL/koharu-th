//! `ProjectSession` — owner of the canonical in-memory `Scene` +
//! history + event bus for one open project.
//!
//! Phase 5.1 (this commit) ships the **type surface** — struct,
//! signatures, error type, public API shape. `apply` / `undo` /
//! `redo` bodies are `todo!()` placeholders to be filled in
//! Phase 5.2.
//!
//! The design intent (locked, see `docs/v2-arch.md` §6):
//!
//! - Every mutation goes through `apply(op)`. The bridge that
//!   currently writes to `Document` directly will be rewired in
//!   Phase 5.3 so engine-emitted Ops route through here first.
//! - `apply` computes the **inverse Op** from the current Scene
//!   state BEFORE mutating, stores `(op, inverse)` on the
//!   history entry, then runs the forward mutation. Undo replays
//!   the inverse against the now-mutated Scene; redo replays the
//!   forward op against the post-undo Scene.
//! - All ops emit `SessionEvent::OpsApplied { page, op_count }`
//!   so subscribers (autosave, frontend, etc.) can react.

use serde::Serialize;
use thiserror::Error;

use koharu_core::scene::Page;
use koharu_core::{NodeId, Op, PageId, Scene, TextBlockPatch};

use crate::event::{EventBus, SessionEvent};
use crate::history::{History, HistoryEntry, HistoryState};

/// Configuration knobs for [`ProjectSession`]. Sized so default
/// = production behaviour; tests override capacity to exercise
/// the ring buffer edges without burning 100 ops.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    /// History ring buffer capacity — 100 per locked decision.
    pub history_capacity: usize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            history_capacity: 100,
        }
    }
}

/// Things that can go wrong inside the session. Most apply paths
/// fail cleanly (engine emits a bad Op → apply returns Err →
/// driver surfaces in the ActivityBubble; history is unchanged
/// since we record AFTER successful mutation).
#[derive(Debug, Error)]
pub enum SessionError {
    /// `Op::UpdateTextBlock` / `RemoveTextBlock` targeted a node
    /// that doesn't exist on the page (caller bug — engine drift
    /// or stale id from a previous apply).
    #[error("node {0:?} not found on page {1:?}")]
    NodeNotFound(koharu_core::NodeId, koharu_core::PageId),

    /// Op targeted a page id that's not in the Scene.
    #[error("page {0:?} not found in scene")]
    PageNotFound(koharu_core::PageId),

    /// `Op::AddPage` was applied with an id that already exists in
    /// the Scene. We refuse to overwrite — the `AddPage` inverse
    /// is `RemovePage`, which would delete the overwritten page
    /// on undo and lose the original. Engines should use
    /// `UpdatePageImage` or unique ids; the bridge's
    /// `index_to_node_id` shift makes collisions impossible in
    /// practice (audit #6 P1).
    #[error("page {0:?} already exists; AddPage refuses to overwrite")]
    PageAlreadyExists(koharu_core::PageId),

    /// Same shape for nodes: `Op::AddTextBlock` against an
    /// existing block id refuses to overwrite. Use
    /// `UpdateTextBlock` for in-place edits.
    #[error("node {0:?} already exists on page {1:?}; AddTextBlock refuses to overwrite")]
    NodeAlreadyExists(koharu_core::NodeId, koharu_core::PageId),

    /// Nothing to undo — the undo stack is empty.
    #[error("nothing to undo")]
    NothingToUndo,

    /// Nothing to redo — the redo stack is empty (or was cleared
    /// by a new apply after the undo).
    #[error("nothing to redo")]
    NothingToRedo,

    /// Op variant not yet covered by `apply` / `compute_inverse`.
    /// Phase 5.2 will cover every variant; this exists so a
    /// future Op variant added without an apply arm fails loudly
    /// instead of silently no-op.
    #[error("op variant not yet implemented: {0}")]
    Unimplemented(&'static str),
}

/// The session — owner of `Scene`, `History`, and the broadcast
/// `EventBus`.
///
/// Constructed once per open project (or once per open chapter,
/// since the locked decision is per-chapter session — Phase 5.5
/// wires the autosave coordinator + per-chapter lifecycle).
///
/// `Scene` is `pub(crate)` for now — Phase 5.3 will expose
/// read-only accessors (`page(id)`, `pages_iter()`) instead of
/// raw access so external readers can't accidentally mutate
/// around the apply pipeline.
#[derive(Debug)]
pub struct ProjectSession {
    scene: Scene,
    history: History,
    bus: EventBus,
    config: SessionConfig,
}

impl ProjectSession {
    /// Start a fresh session over the given Scene. Common case:
    /// chapter open → build Scene from disk → wrap in
    /// ProjectSession.
    pub fn new(scene: Scene, config: SessionConfig) -> Self {
        Self {
            scene,
            history: History::new(config.history_capacity),
            bus: EventBus::new(),
            config,
        }
    }

    /// Read-only access to the current Scene. Phase 5.3 will
    /// migrate the bridge + engines to use this instead of a
    /// separately-owned Scene reference.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Subscribe to session events. Caller owns the returned
    /// receiver; dropping it unsubscribes.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<SessionEvent> {
        self.bus.subscribe()
    }

    /// Snapshot of history state — for the frontend toolbar
    /// (undo/redo enabled flags + op count badge).
    pub fn history_state(&self) -> HistoryState {
        self.history.state()
    }

    /// Top-N op summaries from both stacks — for the History
    /// popover. Most-recent first.
    pub fn recent_history(&self, limit: usize) -> crate::RecentHistory {
        self.history.recent_summaries(limit)
    }

    /// Apply one `Op` (or a `Batch` of Ops).
    ///
    /// 1. Compute inverse Op from the current Scene state.
    /// 2. Mutate the Scene.
    /// 3. Push `HistoryEntry { op, inverse }` onto the undo stack
    ///    (clears redo — branched timeline).
    /// 4. Emit `SessionEvent::OpsApplied { page, op_count }`.
    ///
    /// Returns `Err` (without touching history or Scene) when the
    /// Op targets a missing page/node. The order matters: inverse
    /// computation runs BEFORE mutation so a failed inverse leaves
    /// the Scene untouched.
    pub fn apply(&mut self, op: Op) -> Result<(), SessionError> {
        // Empty Batch — nothing to do, nothing to record.
        if matches!(&op, Op::Batch(inner) if inner.is_empty()) {
            return Ok(());
        }

        let inverse = compute_inverse(&self.scene, &op)?;
        apply_to_scene(&mut self.scene, &op)?;
        self.history.push(HistoryEntry {
            op: op.clone(),
            inverse,
        });
        let (page, op_count) = summarise(&op);
        self.bus.emit(SessionEvent::OpsApplied { page, op_count });
        Ok(())
    }

    /// Undo the most recent applied Op. Returns the **inverse Op**
    /// that was applied to Scene — callers that maintain a mirror
    /// state (the legacy Document via engine_bridge in Phase 5.3)
    /// apply it themselves to stay in sync.
    pub fn undo(&mut self) -> Result<Op, SessionError> {
        let entry = self
            .history
            .pop_undo()
            .ok_or(SessionError::NothingToUndo)?;
        // Apply the inverse directly (NOT via apply() — that would
        // recurse + double-record). On error, push the entry back
        // so the user can retry, and the history stays consistent.
        if let Err(e) = apply_to_scene(&mut self.scene, &entry.inverse) {
            self.history.push_replay(entry);
            return Err(e);
        }
        let applied = entry.inverse.clone();
        let (page, op_count) = summarise(&applied);
        self.history.push_redo(entry);
        self.bus.emit(SessionEvent::OpsUndone { page, op_count });
        Ok(applied)
    }

    /// Redo the most recently undone Op. Returns the **forward Op**
    /// that was re-applied to Scene — symmetric with `undo`.
    pub fn redo(&mut self) -> Result<Op, SessionError> {
        let entry = self
            .history
            .pop_redo()
            .ok_or(SessionError::NothingToRedo)?;
        if let Err(e) = apply_to_scene(&mut self.scene, &entry.op) {
            // Re-push to redo so the cursor is unchanged on
            // failure — symmetric with `undo`'s error recovery.
            self.history.push_redo(entry);
            return Err(e);
        }
        let applied = entry.op.clone();
        let (page, op_count) = summarise(&applied);
        self.history.push_replay(entry);
        self.bus.emit(SessionEvent::OpsRedone { page, op_count });
        Ok(applied)
    }

    /// Wipe history — used on chapter close (per-chapter session
    /// means undo doesn't survive chapter switches).
    pub fn clear_history(&mut self) {
        self.history.clear();
        self.bus.emit(SessionEvent::HistoryCleared);
    }

    /// Expose the configured cap for tests + future tuning.
    pub fn config(&self) -> SessionConfig {
        self.config
    }
}

fn summarise(op: &Op) -> (PageId, usize) {
    // Best-effort page-id resolution — for events we want SOME
    // page id to scope subscriber work. For an empty/no-op batch
    // (filtered earlier in apply) this branch is unreachable.
    // For a heterogeneous batch (rare today), we pick the FIRST
    // op's page — subscribers that need a different scope can
    // re-fetch the full op list.
    fn first_page(op: &Op) -> Option<PageId> {
        match op {
            Op::Batch(inner) => inner.iter().find_map(first_page),
            Op::AddPage { id, .. } | Op::RemovePage { id } | Op::UpdatePageImage { id, .. } => {
                Some(*id)
            }
            Op::AddTextBlock { page, .. }
            | Op::UpdateTextBlock { page, .. }
            | Op::RemoveTextBlock { page, .. }
            | Op::SetSegmentationMask { page, .. }
            | Op::SetInpaintedImage { page, .. }
            | Op::SetRenderedImage { page, .. }
            | Op::SetBrushLayer { page, .. } => Some(*page),
        }
    }
    fn count(op: &Op) -> usize {
        match op {
            Op::Batch(inner) => inner.iter().map(count).sum(),
            _ => 1,
        }
    }
    (first_page(op).unwrap_or(PageId(0)), count(op))
}

/// Apply `op` to `scene` IN PLACE. No history involvement — this
/// is the raw mutation primitive used by both `apply()` and the
/// undo/redo replay paths.
fn apply_to_scene(scene: &mut Scene, op: &Op) -> Result<(), SessionError> {
    match op {
        Op::Batch(inner) => {
            for sub in inner {
                apply_to_scene(scene, sub)?;
            }
        }
        Op::AddPage {
            id,
            image,
            width,
            height,
        } => {
            // Audit #6 P1: reject duplicate ids. The default
            // `IndexMap::insert` silently overwrites, but our
            // inverse (`RemovePage`) would then delete the
            // overwritten page on undo — losing the original.
            if scene.pages.contains_key(id) {
                return Err(SessionError::PageAlreadyExists(*id));
            }
            scene.pages.insert(
                *id,
                Page {
                    id: *id,
                    source_image: *image,
                    width: *width,
                    height: *height,
                    text_blocks: Default::default(),
                    segmentation_mask: None,
                    inpainted_image: None,
                    rendered_image: None,
                    brush_layer: None,
                },
            );
        }
        Op::RemovePage { id } => {
            scene
                .pages
                .shift_remove(id)
                .ok_or(SessionError::PageNotFound(*id))?;
        }
        Op::UpdatePageImage { id, image } => {
            let page = scene
                .pages
                .get_mut(id)
                .ok_or(SessionError::PageNotFound(*id))?;
            page.source_image = *image;
        }
        Op::AddTextBlock { page, block } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            // Audit #6 P1: same duplicate guard as AddPage —
            // refuse to overwrite; `RemoveTextBlock` inverse
            // would otherwise lose the original block.
            if p.text_blocks.contains_key(&block.id) {
                return Err(SessionError::NodeAlreadyExists(block.id, *page));
            }
            p.text_blocks.insert(block.id, block.clone());
        }
        Op::UpdateTextBlock { page, id, patch } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            let block = p
                .text_blocks
                .get_mut(id)
                .ok_or(SessionError::NodeNotFound(*id, *page))?;
            apply_text_block_patch(block, patch);
        }
        Op::RemoveTextBlock { page, id } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            p.text_blocks
                .shift_remove(id)
                .ok_or(SessionError::NodeNotFound(*id, *page))?;
        }
        Op::SetSegmentationMask { page, mask } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            p.segmentation_mask = *mask;
        }
        Op::SetInpaintedImage { page, image } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            p.inpainted_image = *image;
        }
        Op::SetRenderedImage { page, image } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            p.rendered_image = *image;
        }
        Op::SetBrushLayer { page, brush } => {
            let p = scene
                .pages
                .get_mut(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            p.brush_layer = *brush;
        }
    }
    Ok(())
}

/// Apply a `TextBlockPatch` field by field. Mirror of the v2
/// double-option semantics: outer `None` = leave alone; outer
/// `Some(None)` = explicitly clear; outer `Some(Some(v))` = set.
fn apply_text_block_patch(
    block: &mut koharu_core::scene::TextBlock,
    patch: &TextBlockPatch,
) {
    if let Some(region) = patch.region {
        block.region = region;
    }
    if let Some(source_text) = &patch.source_text {
        block.source_text = source_text.clone();
    }
    if let Some(translation) = &patch.translation {
        block.translation = translation.clone();
    }
    if let Some(style) = &patch.style {
        block.style = style.clone();
    }
    if let Some(source_lang) = &patch.source_lang {
        block.source_lang = source_lang.clone();
    }
}

/// Compute the inverse Op for `op` against the CURRENT (pre-apply)
/// `scene`. Caller invokes this before `apply_to_scene` so the
/// returned inverse captures the right prior state.
///
/// Strategy per variant:
///
/// - `Batch(ops)` → `Batch(reversed inverses)`. Each sub-op's
///   inverse is computed against the Scene as it would look
///   AFTER all preceding sub-ops are applied — so we apply on a
///   clone, walk forward, computing inverses against that
///   evolving clone. Cost is O(n) clones in the worst case; in
///   practice batches are small (≤30 ops per engine result).
///
/// - Lifecycle ops swap: Add ↔ Remove. The Remove inverse needs
///   the FULL prior state (block.clone() for text blocks; whole
///   Page for AddPage's inverse RemovePage … no wait, RemovePage
///   needs to RECREATE the page with ALL its prior contents,
///   which means RemovePage's inverse must carry the full page
///   data. That's `Op::Batch(AddPage + every AddTextBlock +
///   every Set*Image)`.
///
/// - Set* ops on optional artifacts: inverse Set* with the
///   prior value (None or Some(prior_id)).
///
/// - UpdateTextBlock: inverse UpdateTextBlock with a patch
///   carrying the prior values for the fields the forward patch
///   changed. Fields the forward patch leaves alone stay alone
///   in the inverse.
fn compute_inverse(scene: &Scene, op: &Op) -> Result<Op, SessionError> {
    match op {
        Op::Batch(inner) => {
            // Walk forward on a clone; collect inverses; reverse
            // at the end so Batch(inverses).apply() rolls back in
            // the right order.
            let mut working = scene.clone();
            let mut inverses = Vec::with_capacity(inner.len());
            for sub in inner {
                let inv = compute_inverse(&working, sub)?;
                apply_to_scene(&mut working, sub)?;
                inverses.push(inv);
            }
            inverses.reverse();
            Ok(Op::Batch(inverses))
        }
        Op::AddPage { id, .. } => Ok(Op::RemovePage { id: *id }),
        Op::RemovePage { id } => {
            let page = scene
                .pages
                .get(id)
                .ok_or(SessionError::PageNotFound(*id))?;
            // Restore via Batch: AddPage (image + dims) then every
            // text block + every artifact in the right order.
            let mut restore: Vec<Op> = Vec::new();
            restore.push(Op::AddPage {
                id: *id,
                image: page.source_image,
                width: page.width,
                height: page.height,
            });
            for block in page.text_blocks.values() {
                restore.push(Op::AddTextBlock {
                    page: *id,
                    block: block.clone(),
                });
            }
            if page.segmentation_mask.is_some() {
                restore.push(Op::SetSegmentationMask {
                    page: *id,
                    mask: page.segmentation_mask,
                });
            }
            if page.inpainted_image.is_some() {
                restore.push(Op::SetInpaintedImage {
                    page: *id,
                    image: page.inpainted_image,
                });
            }
            if page.rendered_image.is_some() {
                restore.push(Op::SetRenderedImage {
                    page: *id,
                    image: page.rendered_image,
                });
            }
            if page.brush_layer.is_some() {
                restore.push(Op::SetBrushLayer {
                    page: *id,
                    brush: page.brush_layer,
                });
            }
            Ok(Op::Batch(restore))
        }
        Op::UpdatePageImage { id, .. } => {
            let page = scene
                .pages
                .get(id)
                .ok_or(SessionError::PageNotFound(*id))?;
            Ok(Op::UpdatePageImage {
                id: *id,
                image: page.source_image,
            })
        }
        Op::AddTextBlock { page, block } => Ok(Op::RemoveTextBlock {
            page: *page,
            id: block.id,
        }),
        Op::UpdateTextBlock { page, id, patch } => {
            let p = scene
                .pages
                .get(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            let block = p
                .text_blocks
                .get(id)
                .ok_or(SessionError::NodeNotFound(*id, *page))?;
            // For each field the forward patch sets, capture the
            // PRIOR value. Fields the patch leaves alone stay
            // unset (outer None) in the inverse.
            let inverse_patch = TextBlockPatch {
                region: patch.region.map(|_| block.region),
                source_text: patch.source_text.as_ref().map(|_| block.source_text.clone()),
                translation: patch.translation.as_ref().map(|_| block.translation.clone()),
                style: patch.style.as_ref().map(|_| block.style.clone()),
                source_lang: patch.source_lang.as_ref().map(|_| block.source_lang.clone()),
            };
            Ok(Op::UpdateTextBlock {
                page: *page,
                id: *id,
                patch: inverse_patch,
            })
        }
        Op::RemoveTextBlock { page, id } => {
            let p = scene
                .pages
                .get(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            let block = p
                .text_blocks
                .get(id)
                .ok_or(SessionError::NodeNotFound(*id, *page))?;
            Ok(Op::AddTextBlock {
                page: *page,
                block: block.clone(),
            })
        }
        Op::SetSegmentationMask { page, .. } => {
            let p = scene
                .pages
                .get(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            Ok(Op::SetSegmentationMask {
                page: *page,
                mask: p.segmentation_mask,
            })
        }
        Op::SetInpaintedImage { page, .. } => {
            let p = scene
                .pages
                .get(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            Ok(Op::SetInpaintedImage {
                page: *page,
                image: p.inpainted_image,
            })
        }
        Op::SetRenderedImage { page, .. } => {
            let p = scene
                .pages
                .get(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            Ok(Op::SetRenderedImage {
                page: *page,
                image: p.rendered_image,
            })
        }
        Op::SetBrushLayer { page, .. } => {
            let p = scene
                .pages
                .get(page)
                .ok_or(SessionError::PageNotFound(*page))?;
            Ok(Op::SetBrushLayer {
                page: *page,
                brush: p.brush_layer,
            })
        }
    }
}

// Silence unused-import warnings for NodeId — it's used in the
// match arms above via SessionError variants but rustc sometimes
// fails to notice when used purely through type-driven constructors.
#[allow(dead_code)]
fn _node_id_used(id: NodeId) -> NodeId {
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_core::{BlobId, NodeId, Op, PageId, Region, Scene, scene::Page, scene::TextBlock as SceneTextBlock};
    use indexmap::IndexMap;

    #[test]
    fn new_session_starts_with_empty_history() {
        let session = ProjectSession::new(Scene::default(), SessionConfig::default());
        let state = session.history_state();
        assert_eq!(state.undo_len, 0);
        assert_eq!(state.redo_len, 0);
        assert_eq!(state.capacity, 100);
    }

    #[test]
    fn config_drives_capacity() {
        let session = ProjectSession::new(
            Scene::default(),
            SessionConfig {
                history_capacity: 3,
            },
        );
        assert_eq!(session.history_state().capacity, 3);
    }

    #[test]
    fn clear_history_emits_event() {
        let session = ProjectSession::new(Scene::default(), SessionConfig::default());
        let mut rx = session.subscribe();
        let mut session = session;
        session.clear_history();
        match rx.try_recv() {
            Ok(SessionEvent::HistoryCleared) => {}
            other => panic!("expected HistoryCleared, got {other:?}"),
        }
    }

    fn one_page_scene() -> Scene {
        let mut pages = IndexMap::new();
        pages.insert(
            PageId(1),
            Page {
                id: PageId(1),
                source_image: BlobId([0u8; 32]),
                width: 100,
                height: 100,
                text_blocks: IndexMap::new(),
                segmentation_mask: None,
                inpainted_image: None,
                rendered_image: None,
                brush_layer: None,
            },
        );
        Scene { pages }
    }

    fn sample_block(id: u64, text: &str) -> SceneTextBlock {
        SceneTextBlock {
            id: NodeId(id),
            region: Region {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            source_text: Some(text.into()),
            translation: None,
            style: None,
            source_lang: None,
            font_prediction: None,
        }
    }

    #[test]
    fn apply_add_text_block_then_undo_restores() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        session
            .apply(Op::AddTextBlock {
                page: PageId(1),
                block: sample_block(1, "hello"),
            })
            .unwrap();
        assert_eq!(session.scene().pages.get(&PageId(1)).unwrap().text_blocks.len(), 1);
        assert_eq!(session.history_state().undo_len, 1);

        session.undo().unwrap();
        assert_eq!(session.scene().pages.get(&PageId(1)).unwrap().text_blocks.len(), 0);
        assert_eq!(session.history_state().undo_len, 0);
        assert_eq!(session.history_state().redo_len, 1);

        session.redo().unwrap();
        assert_eq!(session.scene().pages.get(&PageId(1)).unwrap().text_blocks.len(), 1);
        assert_eq!(session.history_state().redo_len, 0);
    }

    #[test]
    fn update_text_block_inverse_captures_prior_values() {
        let mut scene = one_page_scene();
        scene
            .pages
            .get_mut(&PageId(1))
            .unwrap()
            .text_blocks
            .insert(NodeId(1), sample_block(1, "before"));
        let mut session = ProjectSession::new(scene, SessionConfig::default());

        session
            .apply(Op::UpdateTextBlock {
                page: PageId(1),
                id: NodeId(1),
                patch: TextBlockPatch {
                    source_text: Some(Some("after".into())),
                    ..Default::default()
                },
            })
            .unwrap();

        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap()
                .text_blocks.get(&NodeId(1)).unwrap()
                .source_text.as_deref(),
            Some("after"),
        );

        session.undo().unwrap();

        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap()
                .text_blocks.get(&NodeId(1)).unwrap()
                .source_text.as_deref(),
            Some("before"),
            "undo restores the prior source_text",
        );
    }

    #[test]
    fn set_segmentation_mask_inverse_restores_prior_blob() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        let blob_a = BlobId([1u8; 32]);
        let blob_b = BlobId([2u8; 32]);

        session
            .apply(Op::SetSegmentationMask {
                page: PageId(1),
                mask: Some(blob_a),
            })
            .unwrap();
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap().segmentation_mask,
            Some(blob_a),
        );

        session
            .apply(Op::SetSegmentationMask {
                page: PageId(1),
                mask: Some(blob_b),
            })
            .unwrap();
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap().segmentation_mask,
            Some(blob_b),
        );

        // Undo b → expect a.
        session.undo().unwrap();
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap().segmentation_mask,
            Some(blob_a),
        );
        // Undo a → expect None (initial state).
        session.undo().unwrap();
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap().segmentation_mask,
            None,
        );
    }

    #[test]
    fn batch_undoes_in_reverse_order() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        session
            .apply(Op::Batch(vec![
                Op::AddTextBlock {
                    page: PageId(1),
                    block: sample_block(1, "a"),
                },
                Op::AddTextBlock {
                    page: PageId(1),
                    block: sample_block(2, "b"),
                },
            ]))
            .unwrap();
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap().text_blocks.len(),
            2,
        );
        session.undo().unwrap();
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap().text_blocks.len(),
            0,
            "batch undo removes both",
        );
    }

    #[test]
    fn empty_batch_apply_is_noop_no_history() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        session.apply(Op::Batch(vec![])).unwrap();
        assert_eq!(session.history_state().undo_len, 0);
    }

    #[test]
    fn new_apply_clears_redo() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        session
            .apply(Op::AddTextBlock {
                page: PageId(1),
                block: sample_block(1, "a"),
            })
            .unwrap();
        session.undo().unwrap();
        assert_eq!(session.history_state().redo_len, 1);

        // New apply branches the timeline → redo cleared.
        session
            .apply(Op::AddTextBlock {
                page: PageId(1),
                block: sample_block(2, "b"),
            })
            .unwrap();
        assert_eq!(session.history_state().redo_len, 0);
    }

    #[test]
    fn apply_to_missing_page_errors_without_history_push() {
        let mut session = ProjectSession::new(Scene::default(), SessionConfig::default());
        let result = session.apply(Op::AddTextBlock {
            page: PageId(99),
            block: sample_block(1, "x"),
        });
        assert!(matches!(result, Err(SessionError::PageNotFound(_))));
        // Failed apply must NOT have touched history.
        assert_eq!(session.history_state().undo_len, 0);
    }

    #[test]
    fn undo_with_empty_history_errors() {
        let mut session = ProjectSession::new(Scene::default(), SessionConfig::default());
        assert!(matches!(session.undo(), Err(SessionError::NothingToUndo)));
    }

    /// Audit #6/P1 regression: AddTextBlock with a NodeId already
    /// in the page MUST fail loudly, not silently overwrite. If
    /// the old `insert()` semantics returned, this test would
    /// see the second block in place, the inverse RemoveTextBlock
    /// would wipe it, and undo would lose the original.
    #[test]
    fn add_text_block_rejects_duplicate_id() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        session
            .apply(Op::AddTextBlock {
                page: PageId(1),
                block: sample_block(1, "first"),
            })
            .unwrap();

        let result = session.apply(Op::AddTextBlock {
            page: PageId(1),
            block: sample_block(1, "second"),
        });
        assert!(matches!(result, Err(SessionError::NodeAlreadyExists(NodeId(1), _))));
        // First block unchanged.
        assert_eq!(
            session.scene().pages.get(&PageId(1)).unwrap()
                .text_blocks.get(&NodeId(1)).unwrap()
                .source_text.as_deref(),
            Some("first"),
        );
        // History: only the first apply pushed. Failed apply
        // didn't add a second entry.
        assert_eq!(session.history_state().undo_len, 1);
    }

    #[test]
    fn add_page_rejects_duplicate_id() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        // one_page_scene() already has PageId(1). Re-adding it
        // must error.
        let result = session.apply(Op::AddPage {
            id: PageId(1),
            image: BlobId([9u8; 32]),
            width: 200,
            height: 200,
        });
        assert!(matches!(result, Err(SessionError::PageAlreadyExists(PageId(1)))));
        // Original page unchanged.
        let page = session.scene().pages.get(&PageId(1)).unwrap();
        assert_eq!(page.width, 100);
        assert_eq!(page.height, 100);
    }

    #[test]
    fn apply_emits_ops_applied_event() {
        let mut session = ProjectSession::new(one_page_scene(), SessionConfig::default());
        let mut rx = session.subscribe();
        session
            .apply(Op::AddTextBlock {
                page: PageId(1),
                block: sample_block(1, "a"),
            })
            .unwrap();
        match rx.try_recv() {
            Ok(SessionEvent::OpsApplied { page, op_count }) => {
                assert_eq!(page, PageId(1));
                assert_eq!(op_count, 1);
            }
            other => panic!("expected OpsApplied, got {other:?}"),
        }
    }
}
