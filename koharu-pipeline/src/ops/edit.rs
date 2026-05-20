use image::DynamicImage;
use image::GenericImageView;
use imageproc::distance_transform::Norm;
use koharu_api::commands::{
    AddTextBlockPayload, InpaintPartialPayload, MaskMorphPayload, RemoveTextBlockPayload,
    UpdateBrushLayerPayload, UpdateInpaintMaskPayload, UpdateTextBlockPayload,
    UpdateTextBlocksPayload,
};
use koharu_api::parse::parse_hex_color;
use koharu_api::views::{TextBlockInfo, to_block_info};
use koharu_core::{Op, Region, TextBlockPatch};
use koharu_types::{SerializableDynamicImage, TextBlock, TextStyle};
use tracing::instrument;

use crate::engine_bridge::index_to_node_id;
use crate::style_convert::scene_style_from_v1;
use crate::{AppResources, state_tx};

use super::utils::{InpaintRegionExt, blank_rgba};

const MATCH_GEOMETRY_EPS: f32 = 0.01;
const MATCH_NEAR_GEOMETRY_DELTA: f32 = 4.0;
const MATCH_TEXT_GEOMETRY_DELTA: f32 = 64.0;

fn geometry_delta(a: &TextBlock, b: &TextBlock) -> f32 {
    (a.x - b.x).abs() + (a.y - b.y).abs() + (a.width - b.width).abs() + (a.height - b.height).abs()
}

fn geometry_changed(a: &TextBlock, b: &TextBlock) -> bool {
    geometry_delta(a, b) > MATCH_GEOMETRY_EPS
}

fn size_changed(a: &TextBlock, b: &TextBlock) -> bool {
    (a.width - b.width).abs() > MATCH_GEOMETRY_EPS
        || (a.height - b.height).abs() > MATCH_GEOMETRY_EPS
}

fn geometry_overlaps(a: &TextBlock, b: &TextBlock) -> bool {
    let ax0 = a.x;
    let ay0 = a.y;
    let ax1 = a.x + a.width;
    let ay1 = a.y + a.height;
    let bx0 = b.x;
    let by0 = b.y;
    let bx1 = b.x + b.width;
    let by1 = b.y + b.height;

    ax0 < bx1 && ay0 < by1 && ax1 > bx0 && ay1 > by0
}

fn has_stable_content_identity(a: &TextBlock, b: &TextBlock) -> bool {
    let has_content =
        a.text.is_some() || a.translation.is_some() || b.text.is_some() || b.translation.is_some();
    has_content && a.text == b.text && a.translation == b.translation
}

fn seed_from_block(block: &TextBlock) -> Option<(f32, f32, f32, f32)> {
    match (
        block.layout_seed_x,
        block.layout_seed_y,
        block.layout_seed_width,
        block.layout_seed_height,
    ) {
        (Some(x), Some(y), Some(width), Some(height))
            if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 =>
        {
            Some((x, y, width, height))
        }
        _ => None,
    }
}

fn find_matching_previous(
    current: &TextBlock,
    current_index: usize,
    previous: &[TextBlock],
    used_previous: &[bool],
) -> Option<usize> {
    if current_index < previous.len() && !used_previous[current_index] {
        let indexed = &previous[current_index];
        let delta = geometry_delta(current, indexed);
        if delta <= MATCH_NEAR_GEOMETRY_DELTA
            || geometry_overlaps(current, indexed)
            || has_stable_content_identity(current, indexed)
        {
            return Some(current_index);
        }
    }

    let mut best_idx = None;
    let mut best_delta = f32::INFINITY;

    for (idx, prev) in previous.iter().enumerate() {
        if used_previous[idx] {
            continue;
        }
        let delta = geometry_delta(current, prev);
        if delta < best_delta {
            best_idx = Some(idx);
            best_delta = delta;
        }
    }

    let candidate_idx = best_idx?;
    let candidate = &previous[candidate_idx];
    if best_delta <= MATCH_NEAR_GEOMETRY_DELTA {
        return Some(candidate_idx);
    }

    if has_stable_content_identity(current, candidate) && best_delta <= MATCH_TEXT_GEOMETRY_DELTA {
        return Some(candidate_idx);
    }

    None
}

fn rehydrate_runtime_text_block_state(current: &mut TextBlock, previous: Option<&TextBlock>) {
    let Some(prev) = previous else {
        current.lock_layout_box = false;
        current.set_layout_seed(current.x, current.y, current.width, current.height);
        return;
    };

    current.lock_layout_box = if size_changed(current, prev) {
        true
    } else {
        prev.lock_layout_box
    };

    if geometry_changed(current, prev) {
        current.set_layout_seed(current.x, current.y, current.width, current.height);
    } else if let Some((x, y, width, height)) = seed_from_block(prev) {
        current.set_layout_seed(x, y, width, height);
    } else {
        current.set_layout_seed(current.x, current.y, current.width, current.height);
    }

    // Self-test fix #2 (bulk path): frontend's JSON payload omits
    // `rendered` because TextBlock's `rendered?: Uint8Array` field
    // doesn't survive JSON serialization. Without restore here, a
    // simple drag-move would null every block's sprite — the
    // TextBlockSpriteLayer reads `block.rendered` and falls back to
    // nothing when missing → translations disappear from canvas
    // until a full Render rebake. Restore from the matched previous
    // block whenever sprite-relevant fields haven't changed.
    //
    // Sprite-relevant = size (w/h), rotation, translation, style.
    // Pure position (x/y) preserves; the sprite renders the same
    // text glyph image regardless of canvas placement.
    let translation_changed = current.translation != prev.translation;
    // TextStyle doesn't derive PartialEq (its nested types don't
    // either) so compare via serde fingerprint — cheap relative to
    // the sprite re-bake we'd otherwise schedule. `ok()` on either
    // side: if serialization fails (shouldn't, but defensive),
    // treat as changed so we err on the safe side.
    let style_changed = serde_json::to_string(&current.style).ok()
        != serde_json::to_string(&prev.style).ok();
    let rotation_changed = current.rotation_deg != prev.rotation_deg;
    let sprite_invalidated =
        size_changed(current, prev) || translation_changed || style_changed || rotation_changed;
    if !sprite_invalidated && current.rendered.is_none() {
        current.rendered = prev.rendered.clone();
    }
}

fn block_bounds(block: &TextBlock) -> Option<(f32, f32, f32, f32)> {
    let bx0 = block.x.max(0.0);
    let by0 = block.y.max(0.0);
    let bx1 = (block.x + block.width).max(bx0);
    let by1 = (block.y + block.height).max(by0);
    (bx1 > bx0 && by1 > by0).then_some((bx0, by0, bx1, by1))
}

fn localize_line_polygons(
    polygons: &Option<Vec<[[f32; 2]; 4]>>,
    x0: u32,
    y0: u32,
    crop_width: u32,
    crop_height: u32,
) -> Option<Vec<[[f32; 2]; 4]>> {
    polygons.as_ref().map(|polygons| {
        polygons
            .iter()
            .map(|polygon| {
                let mut localized = *polygon;
                for point in &mut localized {
                    point[0] = (point[0] - x0 as f32).clamp(0.0, crop_width as f32);
                    point[1] = (point[1] - y0 as f32).clamp(0.0, crop_height as f32);
                }
                localized
            })
            .collect()
    })
}

fn localize_inpaint_text_blocks(
    text_blocks: &[TextBlock],
    x0: u32,
    y0: u32,
    crop_width: u32,
    crop_height: u32,
) -> Vec<TextBlock> {
    let crop_x1 = x0 + crop_width;
    let crop_y1 = y0 + crop_height;

    text_blocks
        .iter()
        .filter_map(|block| {
            let (bx0, by0, bx1, by1) = block_bounds(block)?;
            let ix0 = bx0.max(x0 as f32);
            let iy0 = by0.max(y0 as f32);
            let ix1 = bx1.min(crop_x1 as f32);
            let iy1 = by1.min(crop_y1 as f32);
            if ix1 <= ix0 || iy1 <= iy0 {
                return None;
            }

            let mut localized = block.clone();
            localized.x = ix0 - x0 as f32;
            localized.y = iy0 - y0 as f32;
            localized.width = ix1 - ix0;
            localized.height = iy1 - iy0;
            localized.line_polygons =
                localize_line_polygons(&block.line_polygons, x0, y0, crop_width, crop_height);
            Some(localized)
        })
        .collect()
}

fn paste_crop(stitched: &mut image::RgbaImage, patch: &image::RgbaImage, x0: u32, y0: u32) {
    image::imageops::replace(stitched, patch, i64::from(x0), i64::from(y0));
}

/// Scene-relevant fields of a TextBlock (the ones that map to an
/// `UpdateTextBlock` op). Runtime-only fields — `rendered`, layout
/// seeds, `lock_layout_box` — are intentionally excluded so the undo
/// diff doesn't fire on a re-render or a seed bump.
fn scene_relevant_changed(old: &TextBlock, new: &TextBlock) -> bool {
    if (old.x, old.y, old.width, old.height) != (new.x, new.y, new.width, new.height)
        || old.text != new.text
        || old.translation != new.translation
        || old.source_language != new.source_language
        || old.rotation_deg != new.rotation_deg
    {
        return true;
    }
    // TextStyle has no PartialEq — compare by serialized form.
    serde_json::to_value(&old.style).ok() != serde_json::to_value(&new.style).ok()
}

/// Build a full `UpdateTextBlock` patch from a v1 block. Over-specifies
/// (sets every scene field, even unchanged ones) — harmless because the
/// forward re-sets identical values and `compute_inverse` captures the
/// PRIOR scene value per field, so undo restores correctly.
fn full_patch_from_block(blk: &TextBlock) -> TextBlockPatch {
    TextBlockPatch {
        region: Some(Region {
            x: blk.x.max(0.0) as u32,
            y: blk.y.max(0.0) as u32,
            width: blk.width.max(0.0) as u32,
            height: blk.height.max(0.0) as u32,
        }),
        source_text: Some(blk.text.clone()),
        translation: Some(blk.translation.clone()),
        source_lang: Some(blk.source_language.clone()),
        style: Some(blk.style.as_ref().map(scene_style_from_v1)),
        rotation_deg: Some(blk.rotation_deg),
    }
}

pub async fn update_text_blocks(
    state: AppResources,
    payload: UpdateTextBlocksPayload,
) -> anyhow::Result<()> {
    let index = payload.index;
    // Mutate the Document (behaviour unchanged) AND compute a positional
    // diff so a same-length edit (move / resize / rotate / translation /
    // style — no add/remove) can be recorded as an undoable batch.
    // `None` = block count changed (add/remove) → can't map to the
    // session's NodeIds yet (needs stable ids, increment 3) → invalidate.
    let diff: Option<Vec<(usize, TextBlock)>> =
        state_tx::mutate_doc(&state.state, index, |document| {
            let previous = std::mem::take(&mut document.text_blocks);
            document.text_blocks = payload.text_blocks;

            let mut used_previous = vec![false; previous.len()];
            for (block_index, block) in document.text_blocks.iter_mut().enumerate() {
                let matched_idx =
                    find_matching_previous(block, block_index, &previous, &used_previous);
                if let Some(idx) = matched_idx {
                    used_previous[idx] = true;
                    rehydrate_runtime_text_block_state(block, Some(&previous[idx]));
                } else {
                    rehydrate_runtime_text_block_state(block, None);
                }
            }

            let diff = if previous.len() == document.text_blocks.len() {
                Some(
                    previous
                        .iter()
                        .zip(document.text_blocks.iter())
                        .enumerate()
                        .filter(|(_, (old, new))| scene_relevant_changed(old, new))
                        .map(|(i, (_, new))| (i, new.clone()))
                        .collect(),
                )
            } else {
                None
            };
            Ok(diff)
        })
        .await?;

    match diff {
        Some(changes) => {
            if !changes.is_empty() {
                let mut guard = state.session.write().await;
                let mut drift = false;
                if let Some(session) = guard.session_for_mut(index) {
                    if let Some(page) = session.scene().pages.keys().next().copied() {
                        // Every target node must exist in the scene; a
                        // missing one means the scene drifted from the
                        // Document — invalidate rather than apply a
                        // partial, inconsistent batch.
                        let all_present = session
                            .scene()
                            .pages
                            .get(&page)
                            .map(|p| {
                                changes
                                    .iter()
                                    .all(|(i, _)| p.text_blocks.contains_key(&index_to_node_id(*i)))
                            })
                            .unwrap_or(false);
                        if all_present {
                            let ops = changes
                                .iter()
                                .map(|(i, blk)| Op::UpdateTextBlock {
                                    page,
                                    id: index_to_node_id(*i),
                                    patch: full_patch_from_block(blk),
                                })
                                .collect();
                            if session.apply(Op::Batch(ops)).is_err() {
                                drift = true;
                            }
                        } else {
                            drift = true;
                        }
                    }
                }
                // `session` borrow ended (NLL) — safe to invalidate now.
                if drift {
                    guard.invalidate_if_doc(index);
                }
                // No in-sync session → history simply not recorded; the
                // edit still applied to the Document above.
            }
            // Empty diff → nothing changed in scene terms; leave session.
        }
        // Structural change (count differs) — bulk add/remove. Keep the
        // pre-stable-id behaviour: drop history so undo can't corrupt the
        // NodeId↔index mapping.
        None => {
            state.session.write().await.invalidate_if_doc(index);
        }
    }
    Ok(())
}

pub async fn update_text_block(
    state: AppResources,
    payload: UpdateTextBlockPayload,
) -> anyhow::Result<TextBlockInfo> {
    state_tx::mutate_doc(&state.state, payload.index, |document| {
        let block = document
            .text_blocks
            .get_mut(payload.text_block_index)
            .ok_or_else(|| anyhow::anyhow!("Text block {} not found", payload.text_block_index))?;
        // Self-test fix #2: track whether the change invalidates
        // the rendered sprite. Pure-position moves (x/y only) do
        // NOT change the sprite contents — only its placement on
        // the canvas — so we preserve `block.rendered` and the
        // frontend's TextBlockSpriteLayer keeps showing the
        // translation. Pre-fix every update_text_block call
        // unconditionally cleared `rendered`, so dragging a block
        // to reposition it made the translated text vanish until
        // the user pressed Render again.
        let mut size_changed = false; // affects sprite content
        let mut moved = false; // pure-position, sprite unchanged

        if let Some(translation) = payload.translation {
            block.translation = Some(translation);
            size_changed = true; // text content rebaked
        }
        if let Some(x) = payload.x {
            block.x = x;
            moved = true;
        }
        if let Some(y) = payload.y {
            block.y = y;
            moved = true;
        }
        if let Some(width) = payload.width {
            block.width = width;
            size_changed = true;
            block.lock_layout_box = true;
        }
        if let Some(height) = payload.height {
            block.height = height;
            size_changed = true;
            block.lock_layout_box = true;
        }
        if let Some(rotation_deg) = payload.rotation_deg {
            block.rotation_deg = Some(rotation_deg);
            size_changed = true; // sprite rotation baked-in
        }
        if size_changed || moved {
            block.set_layout_seed(block.x, block.y, block.width, block.height);
        }

        let mut style_changed = false;
        if payload.font_families.is_some()
            || payload.font_size.is_some()
            || payload.color.is_some()
            || payload.shader_effect.is_some()
        {
            style_changed = true;
            let style = block.style.get_or_insert_with(|| TextStyle {
                font_families: Vec::new(),
                font_size: None,
                color: [0, 0, 0, 255],
                effect: None,
                stroke: None,
                text_align: None,
                line_height: None,
                letter_spacing_px: None,
                min_font_size: None,
                vertical_align: None,
                writing_mode: None,
            });

            if let Some(families) = payload.font_families {
                style.font_families = families;
            }
            if let Some(font_size) = payload.font_size {
                style.font_size = Some(font_size);
            }
            if let Some(hex) = payload.color {
                style.color = parse_hex_color(&hex)?;
            }
            if let Some(effect) = payload.shader_effect {
                style.effect = Some(effect.parse()?);
            }
        }

        if size_changed || style_changed {
            // Sprite content changed → stale rebake.
            block.rendered = None;
        }
        // Pure `moved` (x/y only) preserves rendered.
        Ok(to_block_info(payload.text_block_index, block))
    })
    .await
}

/// Expand a text block's bbox to match the bubble it sits in. Useful
/// when comic-text-detector returned a tight bbox around the SOURCE
/// text but the translated Thai needs the full bubble area to fit.
///
/// Algorithm: flood-fill white pixels (luminance ≥ threshold) on the
/// original image starting from a grid of seeds inside the current
/// bbox, then take the bounding rectangle of the filled region with a
/// small inward padding so we don't kiss the bubble outline.
///
/// Returns the updated TextBlockInfo so the UI can re-render.
pub async fn text_block_fit_to_bubble(
    state: AppResources,
    payload: koharu_api::commands::TextBlockFitToBubblePayload,
) -> anyhow::Result<TextBlockInfo> {
    state_tx::mutate_doc(&state.state, payload.index, |document| {
        let img_w = document.width as i32;
        let img_h = document.height as i32;
        let luma = document.image.to_luma8();

        let block = document
            .text_blocks
            .get(payload.text_block_index)
            .ok_or_else(|| {
                anyhow::anyhow!("Text block {} not found", payload.text_block_index)
            })?;
        let bx0 = block.x.max(0.0) as i32;
        let by0 = block.y.max(0.0) as i32;
        let bx1 = ((block.x + block.width) as i32).min(img_w - 1);
        let by1 = ((block.y + block.height) as i32).min(img_h - 1);
        if bx0 >= bx1 || by0 >= by1 {
            anyhow::bail!("Block bbox has zero or negative size");
        }

        // Cap how far we let the fill grow — 3× the original bbox in
        // each direction. Without this, on pages with very-light
        // backgrounds the flood would leak out of the bubble entirely.
        let cap_padding_x = ((bx1 - bx0) as f32 * 1.5) as i32;
        let cap_padding_y = ((by1 - by0) as f32 * 1.5) as i32;
        let cap_x0 = (bx0 - cap_padding_x).max(0);
        let cap_y0 = (by0 - cap_padding_y).max(0);
        let cap_x1 = (bx1 + cap_padding_x).min(img_w - 1);
        let cap_y1 = (by1 + cap_padding_y).min(img_h - 1);

        // Threshold: pixels with luma >= 200 count as "bubble interior".
        // 200 is generous — bubbles are usually pure white but JPEG
        // compression can drop a few pixels into the 200-240 range.
        const LUMA_THRESHOLD: u8 = 200;

        // BFS flood from seeds = all pixels inside the original bbox
        // that pass the threshold. Using multiple seeds (not just centre)
        // is more robust when text characters split the bubble interior
        // into several regions through the bbox centre.
        let bbox_w = (cap_x1 - cap_x0 + 1) as usize;
        let bbox_h = (cap_y1 - cap_y0 + 1) as usize;
        let mut visited = vec![false; bbox_w * bbox_h];
        let mut queue: std::collections::VecDeque<(i32, i32)> =
            std::collections::VecDeque::new();

        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let p = luma.get_pixel(x as u32, y as u32)[0];
                if p >= LUMA_THRESHOLD {
                    let idx = ((y - cap_y0) as usize) * bbox_w + ((x - cap_x0) as usize);
                    if !visited[idx] {
                        visited[idx] = true;
                        queue.push_back((x, y));
                    }
                }
            }
        }
        if queue.is_empty() {
            anyhow::bail!(
                "No bubble interior detected inside current bbox (page is too dark / bubble outline crosses bbox)"
            );
        }

        let mut min_x = bx0;
        let mut min_y = by0;
        let mut max_x = bx1;
        let mut max_y = by1;

        while let Some((x, y)) = queue.pop_front() {
            if x < min_x {
                min_x = x;
            }
            if x > max_x {
                max_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if y > max_y {
                max_y = y;
            }
            for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                let nx = x + dx;
                let ny = y + dy;
                if nx < cap_x0 || ny < cap_y0 || nx > cap_x1 || ny > cap_y1 {
                    continue;
                }
                let idx = ((ny - cap_y0) as usize) * bbox_w + ((nx - cap_x0) as usize);
                if visited[idx] {
                    continue;
                }
                let p = luma.get_pixel(nx as u32, ny as u32)[0];
                if p >= LUMA_THRESHOLD {
                    visited[idx] = true;
                    queue.push_back((nx, ny));
                }
            }
        }

        // Inward padding so text doesn't render flush against the
        // bubble outline. 4% of the smaller dimension, capped to a
        // reasonable absolute range.
        let span_w = (max_x - min_x) as f32;
        let span_h = (max_y - min_y) as f32;
        let pad = ((span_w.min(span_h) * 0.04) as i32).clamp(2, 12);

        let new_x = (min_x + pad).max(0) as f32;
        let new_y = (min_y + pad).max(0) as f32;
        let new_w = ((max_x - min_x - 2 * pad).max(8)) as f32;
        let new_h = ((max_y - min_y - 2 * pad).max(8)) as f32;

        let block = document
            .text_blocks
            .get_mut(payload.text_block_index)
            .unwrap();
        block.x = new_x;
        block.y = new_y;
        block.width = new_w;
        block.height = new_h;
        block.lock_layout_box = true;
        block.set_layout_seed(new_x, new_y, new_w, new_h);

        Ok(to_block_info(payload.text_block_index, block))
    })
    .await
}

pub async fn add_text_block(
    state: AppResources,
    payload: AddTextBlockPayload,
) -> anyhow::Result<usize> {
    let result = state_tx::mutate_doc(&state.state, payload.index, |document| {
        let mut block = TextBlock {
            x: payload.x,
            y: payload.y,
            width: payload.width,
            height: payload.height,
            confidence: 1.0,
            ..Default::default()
        };
        block.set_layout_seed(block.x, block.y, block.width, block.height);
        document.text_blocks.push(block);
        Ok(document.text_blocks.len() - 1)
    })
    .await;
    // Audit #9/B1: appending shifts no existing NodeId but adds a
    // NodeId at len+1 that session.scene doesn't know about — next
    // undo of an engine-emitted Op would silent-skip on this new
    // block. Invalidate so the bridge rebuilds at next engine run.
    state.session.write().await.invalidate_if_doc(payload.index);
    result
}

pub async fn remove_text_block(
    state: AppResources,
    payload: RemoveTextBlockPayload,
) -> anyhow::Result<usize> {
    let result = state_tx::mutate_doc(&state.state, payload.index, |document| {
        if payload.text_block_index >= document.text_blocks.len() {
            anyhow::bail!("Text block {} not found", payload.text_block_index);
        }
        document.text_blocks.remove(payload.text_block_index);
        Ok(document.text_blocks.len())
    })
    .await;
    // Audit #9/B1: the canonical drift trigger from self-test —
    // removing a block makes NodeId(k) for k > removed-index shift
    // by -1 in array terms, so every prior AddTextBlock entry in
    // session history now maps to the wrong row. Invalidate.
    state.session.write().await.invalidate_if_doc(payload.index);
    result
}

pub async fn dilate_mask(state: AppResources, payload: MaskMorphPayload) -> anyhow::Result<()> {
    if payload.radius == 0 || payload.radius > 50 {
        anyhow::bail!("Radius must be 1-50");
    }

    state_tx::mutate_doc(&state.state, payload.index, |document| {
        let segment = document
            .segment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No segment mask. Run detect first."))?;

        let gray = segment.to_luma8();
        let dilated = imageproc::morphology::dilate(&gray, Norm::LInf, payload.radius);
        document.segment = Some(SerializableDynamicImage(DynamicImage::ImageLuma8(dilated)));
        Ok(())
    })
    .await
}

pub async fn erode_mask(state: AppResources, payload: MaskMorphPayload) -> anyhow::Result<()> {
    if payload.radius == 0 || payload.radius > 50 {
        anyhow::bail!("Radius must be 1-50");
    }

    state_tx::mutate_doc(&state.state, payload.index, |document| {
        let segment = document
            .segment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No segment mask. Run detect first."))?;

        let gray = segment.to_luma8();
        let eroded = imageproc::morphology::erode(&gray, Norm::LInf, payload.radius);
        document.segment = Some(SerializableDynamicImage(DynamicImage::ImageLuma8(eroded)));
        Ok(())
    })
    .await
}

pub async fn update_inpaint_mask(
    state: AppResources,
    payload: UpdateInpaintMaskPayload,
) -> anyhow::Result<()> {
    let snapshot = state_tx::read_doc(&state.state, payload.index).await?;

    let update_image = image::load_from_memory(&payload.mask)?;
    let (doc_width, doc_height) = (snapshot.width, snapshot.height);

    let mut base_mask = snapshot
        .segment
        .clone()
        .unwrap_or_else(|| blank_rgba(doc_width, doc_height, image::Rgba([0, 0, 0, 255])))
        .to_rgba8();

    match payload.region {
        Some(region) => {
            let (patch_width, patch_height) = update_image.dimensions();
            if patch_width != region.width || patch_height != region.height {
                anyhow::bail!(
                    "Mask patch size mismatch: expected {}x{}, got {}x{}",
                    region.width,
                    region.height,
                    patch_width,
                    patch_height
                );
            }

            let x0 = region.x.min(doc_width.saturating_sub(1));
            let y0 = region.y.min(doc_height.saturating_sub(1));
            let x1 = region.x.saturating_add(region.width).min(doc_width);
            let y1 = region.y.saturating_add(region.height).min(doc_height);

            if x1 <= x0 || y1 <= y0 {
                return Ok(());
            }

            let patch_rgba = update_image.to_rgba8();
            for y in 0..(y1 - y0) {
                for x in 0..(x1 - x0) {
                    base_mask.put_pixel(x0 + x, y0 + y, *patch_rgba.get_pixel(x, y));
                }
            }
        }
        None => {
            let (mask_width, mask_height) = update_image.dimensions();
            if mask_width != doc_width || mask_height != doc_height {
                anyhow::bail!(
                    "Mask size mismatch: expected {}x{}, got {}x{}",
                    doc_width,
                    doc_height,
                    mask_width,
                    mask_height
                );
            }
            base_mask = update_image.to_rgba8();
        }
    }

    let mut updated = snapshot;
    updated.segment = Some(image::DynamicImage::ImageRgba8(base_mask).into());
    state_tx::update_doc(&state.state, payload.index, updated).await
}

pub async fn update_brush_layer(
    state: AppResources,
    payload: UpdateBrushLayerPayload,
) -> anyhow::Result<()> {
    let snapshot = state_tx::read_doc(&state.state, payload.index).await?;

    let (img_width, img_height) = (snapshot.width, snapshot.height);
    let Some((x0, y0, width, height)) = payload.region.clamp(img_width, img_height) else {
        return Ok(());
    };

    let patch_image = image::load_from_memory(&payload.patch)?;
    let (patch_width, patch_height) = patch_image.dimensions();

    if patch_width != payload.region.width || patch_height != payload.region.height {
        anyhow::bail!(
            "Brush patch size mismatch: expected {}x{}, got {}x{}",
            payload.region.width,
            payload.region.height,
            patch_width,
            patch_height
        );
    }

    let brush_rgba = patch_image.to_rgba8();
    let mut brush_layer = snapshot
        .brush_layer
        .clone()
        .unwrap_or_else(|| blank_rgba(img_width, img_height, image::Rgba([0, 0, 0, 0])))
        .to_rgba8();

    for y in 0..height {
        for x in 0..width {
            brush_layer.put_pixel(x0 + x, y0 + y, *brush_rgba.get_pixel(x, y));
        }
    }

    let mut updated = snapshot;
    updated.brush_layer = Some(image::DynamicImage::ImageRgba8(brush_layer).into());

    state_tx::update_doc(&state.state, payload.index, updated).await
}

#[instrument(level = "info", skip_all)]
pub async fn inpaint_partial(
    state: AppResources,
    payload: InpaintPartialPayload,
) -> anyhow::Result<()> {
    let snapshot = state_tx::read_doc(&state.state, payload.index).await?;

    let mask_image = snapshot
        .segment
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Segment image not found"))?;

    if payload.region.width == 0 || payload.region.height == 0 {
        return Ok(());
    }

    let (img_width, img_height) = (snapshot.width, snapshot.height);
    let x0 = payload.region.x.min(img_width.saturating_sub(1));
    let y0 = payload.region.y.min(img_height.saturating_sub(1));
    let x1 = payload
        .region
        .x
        .saturating_add(payload.region.width)
        .min(img_width);
    let y1 = payload
        .region
        .y
        .saturating_add(payload.region.height)
        .min(img_height);
    let crop_width = x1.saturating_sub(x0);
    let crop_height = y1.saturating_sub(y0);

    if crop_width == 0 || crop_height == 0 {
        return Ok(());
    }

    let localized_blocks =
        localize_inpaint_text_blocks(&snapshot.text_blocks, x0, y0, crop_width, crop_height);
    if localized_blocks.is_empty() {
        return Ok(());
    }

    let image_crop =
        SerializableDynamicImage(snapshot.image.crop_imm(x0, y0, crop_width, crop_height));
    let mask_crop = SerializableDynamicImage(mask_image.crop_imm(x0, y0, crop_width, crop_height));

    let inpainted_crop = state
        .ml
        .inpaint_raw(&image_crop, &mask_crop, Some(&localized_blocks))
        .await?;

    let mut stitched = snapshot
        .inpainted
        .as_ref()
        .unwrap_or(&snapshot.image)
        .to_rgba8();

    let patch = inpainted_crop.to_rgba8();
    paste_crop(&mut stitched, &patch, x0, y0);

    let mut updated = snapshot;
    updated.inpainted = Some(image::DynamicImage::ImageRgba8(stitched).into());

    state_tx::update_doc(&state.state, payload.index, updated).await
}

#[cfg(test)]
mod tests {
    use super::{
        find_matching_previous, localize_inpaint_text_blocks, paste_crop,
        rehydrate_runtime_text_block_state,
    };
    use image::{Rgba, RgbaImage};
    use koharu_types::TextBlock;

    #[test]
    fn resized_block_locks_layout_box() {
        let previous = TextBlock {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 80.0,
            ..Default::default()
        };
        let mut current = TextBlock {
            x: 10.0,
            y: 20.0,
            width: 72.0,
            height: 80.0,
            ..Default::default()
        };

        rehydrate_runtime_text_block_state(&mut current, Some(&previous));

        assert!(current.lock_layout_box);
        assert_eq!(current.seed_layout_box(), (10.0, 20.0, 72.0, 80.0));
    }

    #[test]
    fn unchanged_block_preserves_layout_box_lock_and_seed() {
        let mut previous = TextBlock {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 80.0,
            lock_layout_box: true,
            ..Default::default()
        };
        previous.set_layout_seed(5.0, 6.0, 70.0, 60.0);

        let mut current = TextBlock {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 80.0,
            ..Default::default()
        };

        rehydrate_runtime_text_block_state(&mut current, Some(&previous));

        assert!(current.lock_layout_box);
        assert_eq!(current.seed_layout_box(), (5.0, 6.0, 70.0, 60.0));
    }

    #[test]
    fn partial_inpaint_blocks_are_localized_to_crop() {
        let block = TextBlock {
            x: 40.0,
            y: 30.0,
            width: 40.0,
            height: 30.0,
            line_polygons: Some(vec![[
                [42.0, 32.0],
                [78.0, 32.0],
                [78.0, 40.0],
                [42.0, 40.0],
            ]]),
            ..Default::default()
        };

        let localized = localize_inpaint_text_blocks(&[block], 50, 20, 40, 30);
        assert_eq!(localized.len(), 1);
        assert_eq!(localized[0].x, 0.0);
        assert_eq!(localized[0].y, 10.0);
        assert_eq!(localized[0].width, 30.0);
        assert_eq!(localized[0].height, 20.0);
        assert_eq!(
            localized[0].line_polygons,
            Some(vec![[[0.0, 12.0], [28.0, 12.0], [28.0, 20.0], [0.0, 20.0]]])
        );
    }

    #[test]
    fn partial_inpaint_with_no_overlapping_blocks_returns_empty_list() {
        let block = TextBlock {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            ..Default::default()
        };

        let localized = localize_inpaint_text_blocks(&[block], 50, 20, 40, 30);
        assert!(localized.is_empty());
    }

    #[test]
    fn crop_paste_replaces_entire_returned_patch() {
        let mut stitched = RgbaImage::from_pixel(8, 8, Rgba([0, 0, 0, 255]));
        let patch = RgbaImage::from_pixel(3, 3, Rgba([255, 0, 0, 255]));

        paste_crop(&mut stitched, &patch, 2, 2);

        assert_eq!(stitched.get_pixel(2, 2).0, [255, 0, 0, 255]);
        assert_eq!(stitched.get_pixel(4, 4).0, [255, 0, 0, 255]);
        assert_eq!(stitched.get_pixel(1, 1).0, [0, 0, 0, 255]);
    }

    #[test]
    fn matching_previous_prefers_same_index_for_large_manual_resize() {
        let previous = vec![
            TextBlock {
                x: 10.0,
                y: 10.0,
                width: 40.0,
                height: 20.0,
                translation: Some("HELLO".to_string()),
                ..Default::default()
            },
            TextBlock {
                x: 100.0,
                y: 10.0,
                width: 40.0,
                height: 20.0,
                translation: Some("WORLD".to_string()),
                ..Default::default()
            },
        ];

        let current = TextBlock {
            x: 10.0,
            y: 10.0,
            width: 140.0,
            height: 80.0,
            translation: Some("HELLO".to_string()),
            ..Default::default()
        };

        let matched = find_matching_previous(&current, 0, &previous, &[false, false]);
        assert_eq!(matched, Some(0));
    }

    #[test]
    fn non_overlapping_same_index_without_identity_does_not_force_match() {
        let previous = vec![
            TextBlock {
                x: 10.0,
                y: 10.0,
                width: 20.0,
                height: 20.0,
                ..Default::default()
            },
            TextBlock {
                x: 80.0,
                y: 10.0,
                width: 20.0,
                height: 20.0,
                ..Default::default()
            },
        ];

        let current = TextBlock {
            x: 82.0,
            y: 12.0,
            width: 20.0,
            height: 20.0,
            ..Default::default()
        };

        let matched = find_matching_previous(&current, 0, &previous, &[false, false]);
        assert_eq!(matched, Some(1));
    }
}
