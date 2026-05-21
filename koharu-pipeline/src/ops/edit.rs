use image::DynamicImage;
use image::GenericImageView;
use imageproc::distance_transform::Norm;
use koharu_api::commands::{
    AddTextBlockPayload, InpaintPartialPayload, MaskMorphPayload, RemoveTextBlockPayload,
    ReorderTextBlocksPayload, UpdateBrushLayerPayload, UpdateInpaintMaskPayload,
    UpdateTextBlockPayload, UpdateTextBlocksPayload,
};
use koharu_api::parse::parse_hex_color;
use koharu_api::views::{TextBlockInfo, to_block_info};
use koharu_types::{ReadingOrder, SerializableDynamicImage, TextBlock, TextStyle};
use tracing::instrument;

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

pub async fn update_text_blocks(
    state: AppResources,
    payload: UpdateTextBlocksPayload,
) -> anyhow::Result<()> {
    state_tx::mutate_doc(&state.state, payload.index, |document| {
        let previous = std::mem::take(&mut document.text_blocks);
        document.text_blocks = payload.text_blocks;

        let mut used_previous = vec![false; previous.len()];
        for (block_index, block) in document.text_blocks.iter_mut().enumerate() {
            let matched_idx = find_matching_previous(block, block_index, &previous, &used_previous);
            if let Some(idx) = matched_idx {
                used_previous[idx] = true;
                rehydrate_runtime_text_block_state(block, Some(&previous[idx]));
            } else {
                rehydrate_runtime_text_block_state(block, None);
            }
        }
        Ok(())
    })
    .await
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
        let mut geometry_changed = false;

        if let Some(translation) = payload.translation {
            block.translation = Some(translation);
        }
        if let Some(x) = payload.x {
            block.x = x;
            geometry_changed = true;
        }
        if let Some(y) = payload.y {
            block.y = y;
            geometry_changed = true;
        }
        if let Some(width) = payload.width {
            block.width = width;
            geometry_changed = true;
            block.lock_layout_box = true;
        }
        if let Some(height) = payload.height {
            block.height = height;
            geometry_changed = true;
            block.lock_layout_box = true;
        }
        if let Some(rotation_deg) = payload.rotation_deg {
            block.rotation_deg = Some(rotation_deg);
        }
        if geometry_changed {
            block.set_layout_seed(block.x, block.y, block.width, block.height);
        }

        if payload.font_families.is_some()
            || payload.font_size.is_some()
            || payload.color.is_some()
            || payload.shader_effect.is_some()
        {
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
                baseline_shift_px: None,
                horizontal_scale: None,
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

        block.rendered = None;
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
        // that pass the threshold. To prevent merging multiple disjoint speech bubbles
        // (in case the bbox overlaps multiple bubbles), we first group the white pixels inside
        // the bbox into connected components, and then use only the component that is
        // closest to the center of the bounding box as our seed region.
        let bbox_w = (cap_x1 - cap_x0 + 1) as usize;
        let bbox_h = (cap_y1 - cap_y0 + 1) as usize;
        let mut visited = vec![false; bbox_w * bbox_h];
        let mut queue: std::collections::VecDeque<(i32, i32)> =
            std::collections::VecDeque::new();

        // Find connected components of white pixels strictly inside bx0..=bx1 and by0..=by1
        let mut local_visited = vec![false; ((bx1 - bx0 + 1) * (by1 - by0 + 1)) as usize];
        let local_w = (bx1 - bx0 + 1) as usize;
        let mut components: Vec<Vec<(i32, i32)>> = Vec::new();

        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let p = luma.get_pixel(x as u32, y as u32)[0];
                if p >= LUMA_THRESHOLD {
                    let local_idx = ((y - by0) as usize) * local_w + ((x - bx0) as usize);
                    if !local_visited[local_idx] {
                        let mut comp = Vec::new();
                        let mut local_q = std::collections::VecDeque::new();

                        local_visited[local_idx] = true;
                        local_q.push_back((x, y));

                        while let Some((cx, cy)) = local_q.pop_front() {
                            comp.push((cx, cy));

                            for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                                let nx = cx + dx;
                                let ny = cy + dy;
                                if nx >= bx0 && nx <= bx1 && ny >= by0 && ny <= by1 {
                                    let n_idx = ((ny - by0) as usize) * local_w + ((nx - bx0) as usize);
                                    if !local_visited[n_idx] {
                                        let np = luma.get_pixel(nx as u32, ny as u32)[0];
                                        if np >= LUMA_THRESHOLD {
                                            local_visited[n_idx] = true;
                                            local_q.push_back((nx, ny));
                                        }
                                    }
                                }
                            }
                        }
                        components.push(comp);
                    }
                }
            }
        }

        // Find the component closest to the center of the bounding box
        let center_x = (bx0 + bx1) as f32 / 2.0;
        let center_y = (by0 + by1) as f32 / 2.0;
        let mut best_comp_idx = None;
        let mut min_dist_sq = f32::MAX;

        for (idx, comp) in components.iter().enumerate() {
            let mut comp_min_dist = f32::MAX;
            for &(x, y) in comp {
                let dx = x as f32 - center_x;
                let dy = y as f32 - center_y;
                let dist_sq = dx * dx + dy * dy;
                if dist_sq < comp_min_dist {
                    comp_min_dist = dist_sq;
                }
            }
            if comp_min_dist < min_dist_sq {
                min_dist_sq = comp_min_dist;
                best_comp_idx = Some(idx);
            }
        }

        // Seed BFS strictly using only the closest connected component
        if let Some(idx) = best_comp_idx {
            for &(x, y) in &components[idx] {
                let idx = ((y - cap_y0) as usize) * bbox_w + ((x - cap_x0) as usize);
                visited[idx] = true;
                queue.push_back((x, y));
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
            .ok_or_else(|| anyhow::anyhow!("Text block {} not found", payload.text_block_index))?;
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
    state_tx::mutate_doc(&state.state, payload.index, |document| {
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
    .await
}

pub async fn remove_text_block(
    state: AppResources,
    payload: RemoveTextBlockPayload,
) -> anyhow::Result<usize> {
    state_tx::mutate_doc(&state.state, payload.index, |document| {
        if payload.text_block_index >= document.text_blocks.len() {
            anyhow::bail!("Text block {} not found", payload.text_block_index);
        }
        document.text_blocks.remove(payload.text_block_index);
        Ok(document.text_blocks.len())
    })
    .await
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
        document.segment = Some(DynamicImage::ImageLuma8(dilated).into());
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
        document.segment = Some(DynamicImage::ImageLuma8(eroded).into());
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
        SerializableDynamicImage(std::sync::Arc::new(snapshot.image.crop_imm(x0, y0, crop_width, crop_height)));
    let mask_crop = SerializableDynamicImage(std::sync::Arc::new(mask_image.crop_imm(x0, y0, crop_width, crop_height)));

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

fn recursive_xy_cut(
    indices: &[usize],
    blocks: &[TextBlock],
    reading_order: ReadingOrder,
) -> Vec<usize> {
    if indices.len() <= 1 {
        return indices.to_vec();
    }

    // 1. Sanitize dimensions and get medians
    let mut widths = Vec::new();
    let mut heights = Vec::new();
    for &idx in indices {
        if let Some(b) = blocks.get(idx) {
            let w = if b.width.is_finite() && b.width >= 0.0 { b.width } else { 0.0 };
            let h = if b.height.is_finite() && b.height >= 0.0 { b.height } else { 0.0 };
            widths.push(w);
            heights.push(h);
        }
    }
    widths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_w = if widths.is_empty() { 50.0 } else { widths[widths.len() / 2] };
    let median_h = if heights.is_empty() { 20.0 } else { heights[heights.len() / 2] };

    let min_gap_x = (median_w * 0.15).max(10.0);
    let min_gap_y = (median_h * 0.10).max(8.0);

    // 2. Find best horizontal (Y) gap
    let mut y_intervals = Vec::new();
    for &idx in indices {
        if let Some(b) = blocks.get(idx) {
            let y = if b.y.is_finite() { b.y } else { 0.0 };
            let h = if b.height.is_finite() && b.height >= 0.0 { b.height } else { 0.0 };
            y_intervals.push((y, y + h));
        }
    }
    y_intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut y_merged: Vec<(f32, f32)> = Vec::new();
    for &(start, end) in &y_intervals {
        if let Some(last) = y_merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
            } else {
                y_merged.push((start, end));
            }
        } else {
            y_merged.push((start, end));
        }
    }
    let mut best_y_gap: Option<(f32, f32, f32)> = None; // (start, end, size)
    for i in 0..y_merged.len().saturating_sub(1) {
        let size = y_merged[i+1].0 - y_merged[i].1;
        if size > min_gap_y {
            if best_y_gap.map_or(true, |(_, _, best_size)| size > best_size) {
                best_y_gap = Some((y_merged[i].1, y_merged[i+1].0, size));
            }
        }
    }

    // 3. Find best vertical (X) gap
    let mut x_intervals = Vec::new();
    for &idx in indices {
        if let Some(b) = blocks.get(idx) {
            let x = if b.x.is_finite() { b.x } else { 0.0 };
            let w = if b.width.is_finite() && b.width >= 0.0 { b.width } else { 0.0 };
            x_intervals.push((x, x + w));
        }
    }
    x_intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut x_merged: Vec<(f32, f32)> = Vec::new();
    for &(start, end) in &x_intervals {
        if let Some(last) = x_merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
            } else {
                x_merged.push((start, end));
            }
        } else {
            x_merged.push((start, end));
        }
    }
    let mut best_x_gap: Option<(f32, f32, f32)> = None;
    for i in 0..x_merged.len().saturating_sub(1) {
        let size = x_merged[i+1].0 - x_merged[i].1;
        if size > min_gap_x {
            if best_x_gap.map_or(true, |(_, _, best_size)| size > best_size) {
                best_x_gap = Some((x_merged[i].1, x_merged[i+1].0, size));
            }
        }
    }

    // 4. Decide where to cut
    match (best_x_gap, best_y_gap) {
        (Some((x_start, x_end, x_size)), Some((y_start, y_end, y_size))) => {
            if x_size > y_size {
                // Cut X
                let cut_coord = (x_start + x_end) / 2.0;
                let (part1, part2) = partition_by_x(indices, blocks, cut_coord, reading_order);
                let mut sorted = recursive_xy_cut(&part1, blocks, reading_order);
                sorted.extend(recursive_xy_cut(&part2, blocks, reading_order));
                sorted
            } else {
                // Cut Y
                let cut_coord = (y_start + y_end) / 2.0;
                let (part1, part2) = partition_by_y(indices, blocks, cut_coord);
                let mut sorted = recursive_xy_cut(&part1, blocks, reading_order);
                sorted.extend(recursive_xy_cut(&part2, blocks, reading_order));
                sorted
            }
        }
        (Some((x_start, x_end, _)), None) => {
            // Cut X
            let cut_coord = (x_start + x_end) / 2.0;
            let (part1, part2) = partition_by_x(indices, blocks, cut_coord, reading_order);
            let mut sorted = recursive_xy_cut(&part1, blocks, reading_order);
            sorted.extend(recursive_xy_cut(&part2, blocks, reading_order));
            sorted
        }
        (None, Some((y_start, y_end, _))) => {
            // Cut Y
            let cut_coord = (y_start + y_end) / 2.0;
            let (part1, part2) = partition_by_y(indices, blocks, cut_coord);
            let mut sorted = recursive_xy_cut(&part1, blocks, reading_order);
            sorted.extend(recursive_xy_cut(&part2, blocks, reading_order));
            sorted
        }
        (None, None) => {
            // No gaps found, fallback sorting
            let mut fallback_indices = indices.to_vec();
            let tolerance_y = (median_h * 0.5).max(5.0);
            fallback_indices.sort_by(|&idx_a, &idx_b| {
                let a = &blocks[idx_a];
                let b = &blocks[idx_b];
                let ay = if a.y.is_finite() { a.y } else { 0.0 };
                let by = if b.y.is_finite() { b.y } else { 0.0 };
                let ax = if a.x.is_finite() { a.x } else { 0.0 };
                let bx = if b.x.is_finite() { b.x } else { 0.0 };
                let aw = if a.width.is_finite() && a.width >= 0.0 { a.width } else { 0.0 };
                let bw = if b.width.is_finite() && b.width >= 0.0 { b.width } else { 0.0 };
                let center_ax = ax + aw / 2.0;
                let center_bx = bx + bw / 2.0;

                if (ay - by).abs() < tolerance_y {
                    match reading_order {
                        ReadingOrder::Rtl => {
                            // Right to Left: larger X first
                            center_bx.partial_cmp(&center_ax).unwrap_or(std::cmp::Ordering::Equal)
                        }
                        _ => {
                            // Left to Right: smaller X first
                            center_ax.partial_cmp(&center_bx).unwrap_or(std::cmp::Ordering::Equal)
                        }
                    }
                } else {
                    // Top to bottom: smaller Y first
                    ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal)
                }
            });
            fallback_indices
        }
    }
}

fn partition_by_x(
    indices: &[usize],
    blocks: &[TextBlock],
    cut_coord: f32,
    reading_order: ReadingOrder,
) -> (Vec<usize>, Vec<usize>) {
    let mut part1 = Vec::new();
    let mut part2 = Vec::new();
    for &idx in indices {
        if let Some(b) = blocks.get(idx) {
            let x = if b.x.is_finite() { b.x } else { 0.0 };
            let w = if b.width.is_finite() && b.width >= 0.0 { b.width } else { 0.0 };
            let center_x = x + w / 2.0;
            match reading_order {
                ReadingOrder::Rtl => {
                    // Right to Left: Right comes first
                    if center_x >= cut_coord {
                        part1.push(idx);
                    } else {
                        part2.push(idx);
                    }
                }
                _ => {
                    // Left to Right: Left comes first
                    if center_x < cut_coord {
                        part1.push(idx);
                    } else {
                        part2.push(idx);
                    }
                }
            }
        }
    }
    (part1, part2)
}

fn partition_by_y(
    indices: &[usize],
    blocks: &[TextBlock],
    cut_coord: f32,
) -> (Vec<usize>, Vec<usize>) {
    let mut part1 = Vec::new();
    let mut part2 = Vec::new();
    for &idx in indices {
        if let Some(b) = blocks.get(idx) {
            let y = if b.y.is_finite() { b.y } else { 0.0 };
            let h = if b.height.is_finite() && b.height >= 0.0 { b.height } else { 0.0 };
            let center_y = y + h / 2.0;
            // Top to bottom: Top comes first
            if center_y < cut_coord {
                part1.push(idx);
            } else {
                part2.push(idx);
            }
        }
    }
    (part1, part2)
}

pub async fn reorder_text_blocks(
    state: AppResources,
    payload: ReorderTextBlocksPayload,
) -> anyhow::Result<()> {
    state_tx::mutate_doc(&state.state, payload.index, |document| {
        if payload.reading_order == ReadingOrder::Custom {
            return Ok(());
        }

        let indices: Vec<usize> = (0..document.text_blocks.len()).collect();
        let sorted_indices = recursive_xy_cut(&indices, &document.text_blocks, payload.reading_order);

        let mut sorted_blocks = Vec::with_capacity(document.text_blocks.len());
        for idx in sorted_indices {
            if let Some(block) = document.text_blocks.get(idx) {
                sorted_blocks.push(block.clone());
            }
        }

        if sorted_blocks.len() == document.text_blocks.len() {
            document.text_blocks = sorted_blocks;
        } else {
            tracing::warn!("Mismatched block count during XY-cut reordering; aborting mutation");
        }

        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        find_matching_previous, localize_inpaint_text_blocks, paste_crop,
        rehydrate_runtime_text_block_state, recursive_xy_cut,
    };
    use image::{Rgba, RgbaImage};
    use koharu_types::{ReadingOrder, TextBlock};

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

    #[test]
    fn xy_cut_sorting_rtl_ltr() {
        let blocks = vec![
            TextBlock {
                x: 100.0,
                y: 10.0,
                width: 20.0,
                height: 20.0,
                ..Default::default()
            }, // 0: Right column, top
            TextBlock {
                x: 10.0,
                y: 10.0,
                width: 20.0,
                height: 20.0,
                ..Default::default()
            }, // 1: Left column, top
            TextBlock {
                x: 50.0,
                y: 80.0,
                width: 20.0,
                height: 20.0,
                ..Default::default()
            }, // 2: Bottom row
        ];

        let indices = vec![0, 1, 2];

        // For RTL: Right column top (0) -> Left column top (1) -> Bottom row (2)
        let rtl_sorted = recursive_xy_cut(&indices, &blocks, ReadingOrder::Rtl);
        assert_eq!(rtl_sorted, vec![0, 1, 2]);

        // For LTR: Left column top (1) -> Right column top (0) -> Bottom row (2)
        let ltr_sorted = recursive_xy_cut(&indices, &blocks, ReadingOrder::Ltr);
        assert_eq!(ltr_sorted, vec![1, 0, 2]);
    }
}

