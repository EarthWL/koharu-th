use std::sync::{Arc, Mutex};

use anyhow::Result;
use image::{DynamicImage, GrayImage};
use rayon::iter::{IntoParallelRefMutIterator, ParallelIterator};

use koharu_types::{
    Document, SerializableDynamicImage, TextAlign, TextBlock, TextShaderEffect, TextStrokeStyle,
    TextStyle,
};

use crate::{
    font::{FamilyName, Font, FontBook, Properties},
    layout::{LayoutRun, TextLayout, WritingMode},
    renderer::{RenderOptions, RenderStrokeOptions, TinySkiaRenderer},
    text::{
        latin::{
            LayoutBox, expand_latin_layout_box_relaxed, expand_latin_layout_box_strict,
            is_expanded_layout_box, latin_layout_underfilled, latin_width_overflow_factor,
            layout_box_area, layout_box_from_block, pick_better_latin_candidate,
        },
        script::{
            font_families_for_text, is_latin_only, normalize_translation_for_layout,
            writing_mode_for_block,
        },
    },
};

pub struct Renderer {
    fontbook: Arc<Mutex<FontBook>>,
    renderer: TinySkiaRenderer,
    symbol_fallbacks: Vec<Font>,
}

impl Renderer {
    pub fn new() -> Result<Self> {
        Self::new_with_extra_font_dirs(&[])
    }

    /// Same as `new()` but also scans each extra directory for
    /// `.ttf` / `.otf` / `.ttc` files to register as bundled fonts.
    /// Use this to surface fonts (e.g. Noto Sans Thai) that the user's
    /// OS doesn't ship with.
    pub fn new_with_extra_font_dirs(extra_dirs: &[std::path::PathBuf]) -> Result<Self> {
        let mut fontbook = FontBook::new();
        for dir in extra_dirs {
            let n = fontbook.register_fonts_from_dir(dir);
            if n > 0 {
                tracing::info!(?dir, count = n, "registered bundled fonts from dir");
            }
        }
        let symbol_fallbacks = load_symbol_fallbacks(&mut fontbook);
        Ok(Self {
            fontbook: Arc::new(Mutex::new(fontbook)),
            renderer: TinySkiaRenderer::new()?,
            symbol_fallbacks,
        })
    }

    pub fn available_fonts(&self) -> Result<Vec<String>> {
        let mut fontbook = self
            .fontbook
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock fontbook"))?;
        let mut families = fontbook.all_families();
        families.sort();
        Ok(families)
    }

    pub fn render(
        &self,
        document: &mut Document,
        text_block_index: Option<usize>,
        effect: TextShaderEffect,
        stroke: Option<TextStrokeStyle>,
        font_family: Option<&str>,
    ) -> Result<()> {
        let bubble_map = if let Some(inpainted) = &document.inpainted {
            inpainted.to_luma8()
        } else {
            document.image.to_luma8()
        };

        let mut text_blocks = match text_block_index {
            Some(index) => document
                .text_blocks
                .get_mut(index)
                .map(|tb| vec![tb])
                .ok_or_else(|| anyhow::anyhow!("Text block index out of bounds"))?,
            None => document.text_blocks.iter_mut().collect(),
        };

        // Propagate per-block render failures instead of dropping them
        // with `let _ = ...`. Previously a font-load error or a
        // texture-allocation OOM on one block would silently leave that
        // block unrendered while the pipeline reported `Completed`,
        // confusing the user (page showed missing translations on a
        // "successful" run). `try_for_each` short-circuits at the
        // first error — other in-flight parallel jobs may still finish
        // their work, but the function as a whole returns Err so the
        // caller's pipeline status flips to Failed. Partial output is
        // preserved on disk; nothing is rolled back.
        text_blocks.par_iter_mut().try_for_each(|text_block| {
            self.render_text_block(
                text_block,
                effect,
                stroke.clone(),
                font_family,
                Some(&bubble_map),
            )
        })?;

        if let Some(inpainted) = &document.inpainted
            && text_block_index.is_none()
        {
            let width = inpainted.width();
            let height = inpainted.height();
            let mut surface = tiny_skia::Pixmap::new(width, height)
                .ok_or_else(|| anyhow::anyhow!("Failed to create composition surface"))?;

            // Draw base image (inpainted or original)
            let mut base_rgba = inpainted.to_rgba8().into_raw();
            premultiply_rgba(&mut base_rgba);
            surface.fill_path(
                &tiny_skia::PathBuilder::from_rect(
                    tiny_skia::Rect::from_xywh(0.0, 0.0, width as f32, height as f32).unwrap(),
                ),
                &tiny_skia::Paint {
                    shader: tiny_skia::Pattern::new(
                        tiny_skia::PixmapRef::from_bytes(&base_rgba, width, height).unwrap(),
                        tiny_skia::SpreadMode::Pad,
                        tiny_skia::FilterQuality::Bilinear,
                        1.0,
                        tiny_skia::Transform::identity(),
                    ),
                    anti_alias: true,
                    ..Default::default()
                },
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            );

            if let Some(brush_layer) = &document.brush_layer {
                let brush = brush_layer.to_rgba8();
                surface.draw_pixmap(
                    0,
                    0,
                    tiny_skia::PixmapRef::from_bytes(&brush, width, height).unwrap(),
                    &tiny_skia::PixmapPaint::default(),
                    tiny_skia::Transform::identity(),
                    None,
                );
            }

            for text_block in text_blocks {
                let Some(block) = text_block.rendered.as_ref() else {
                    continue;
                };
                let block_width = block.width();
                let block_height = block.height();
                let mut sprite_data = block.0.to_rgba8().into_raw();
                premultiply_rgba(&mut sprite_data);
                let sprite = tiny_skia::PixmapRef::from_bytes(&sprite_data, block_width, block_height)
                    .ok_or_else(|| anyhow::anyhow!("Failed to create sprite pixmap ref"))?;

                let mut transform = tiny_skia::Transform::from_translate(text_block.x, text_block.y);

                if let Some(rotation) = text_block.rotation_deg
                    && rotation != 0.0
                {
                    // Rotate around the center of the text block
                    let cx = block_width as f32 / 2.0;
                    let cy = block_height as f32 / 2.0;
                    transform = transform
                        .pre_translate(cx, cy)
                        .pre_rotate(rotation)
                        .pre_translate(-cx, -cy);
                }

                surface.draw_pixmap(
                    0,
                    0,
                    sprite,
                    &tiny_skia::PixmapPaint {
                        quality: tiny_skia::FilterQuality::Bilinear,
                        ..Default::default()
                    },
                    transform,
                    None,
                );
            }

            let pixels = surface.data().to_vec();
            let mut img = image::RgbaImage::from_raw(width, height, pixels)
                .ok_or_else(|| anyhow::anyhow!("Failed to create RgbaImage from pixmap"))?;

            // tiny-skia uses premultiplied alpha, so we need to unpremultiply it
            // the TinySkiaRenderer already has an unpremultiply_rgba helper but it's private.
            // I'll copy or use it if I can.
            // Wait, TinySkiaRenderer::render already does unpremultiply.
            // I'll add a helper or just do it here.

            for px in img.pixels_mut() {
                let a = px[3];
                if a == 0 || a == 255 {
                    continue;
                }
                let alpha = a as u32;
                px[0] = ((px[0] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                px[1] = ((px[1] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                px[2] = ((px[2] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
            }

            document.rendered = Some(DynamicImage::ImageRgba8(img).into());
        }
        Ok(())
    }

    fn render_text_block(
        &self,
        text_block: &mut TextBlock,
        effect: TextShaderEffect,
        global_stroke: Option<TextStrokeStyle>,
        font_family: Option<&str>,
        bubble_map: Option<&GrayImage>,
    ) -> Result<()> {
        let Some(translation) = text_block.translation.as_ref().cloned() else {
            return Ok(());
        };
        if translation.is_empty() {
            return Ok(());
        };
        let normalized_translation = normalize_translation_for_layout(&translation);
        let (seed_x, seed_y, seed_width, seed_height) = text_block.seed_layout_box();
        let layout_source_block = TextBlock {
            x: seed_x,
            y: seed_y,
            width: seed_width,
            height: seed_height,
            translation: Some(translation.clone()),
            ..Default::default()
        };
        let mut style = text_block.style.clone().unwrap_or_else(|| TextStyle {
            font_families: font_families_for_text(&normalized_translation),
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

        apply_global_font_family(&mut style.font_families, font_family);
        apply_default_font_families(&mut style.font_families, &normalized_translation);
        let font = self.select_font(&style)?;
        let mut block_effect = style.effect.unwrap_or(effect);

        // If the user requested bold/italic, check if the matched font is actually bold/italic.
        // If not (fell back to Regular), automatically enable synthetic faux bold/italic as a fallback!
        if block_effect.bold && font.attributes.weight() < fontique::FontWeight::BOLD {
            block_effect.faux_bold = true;
        }
        if block_effect.italic && font.attributes.style() == fontique::FontStyle::Normal {
            block_effect.faux_italic = true;
        }
        let color = text_block
            .style
            .as_ref()
            .map(|style| style.color)
            .or_else(|| {
                text_block.font_prediction.as_ref().map(|pred| {
                    [
                        pred.text_color[0],
                        pred.text_color[1],
                        pred.text_color[2],
                        255,
                    ]
                })
            })
            .unwrap_or([0, 0, 0, 255]);
        let writing_mode = writing_mode_for_block(&layout_source_block);
        let english_layout =
            english_layout_behavior(text_block, &normalized_translation, writing_mode);
        let english_horizontal_layout = english_layout != EnglishLayoutBehavior::Disabled;
        let auto_expand_english_layout = english_layout == EnglishLayoutBehavior::AutoExpand;
        let text_align = style.text_align.unwrap_or({
            if english_horizontal_layout {
                TextAlign::Center
            } else {
                TextAlign::Left
            }
        });
        let original_layout_box = layout_box_from_block(&layout_source_block);
        let mut layout_box = if auto_expand_english_layout {
            bubble_map
                .map(|map| expand_latin_layout_box_strict(&layout_source_block, map))
                .unwrap_or(original_layout_box)
        } else {
            original_layout_box
        };

        let build_layout = |box_for_layout: LayoutBox, allow_expanded_overflow: bool| {
            let expanded_box = is_expanded_layout_box(box_for_layout, original_layout_box);
            let overflow = if english_horizontal_layout {
                if expanded_box {
                    latin_width_overflow_factor(true, allow_expanded_overflow)
                } else {
                    latin_width_overflow_factor(false, allow_expanded_overflow)
                }
            } else {
                1.0
            };
            let max_width = if box_for_layout.width.is_finite() && box_for_layout.width > 0.0 {
                box_for_layout.width * overflow
            } else {
                box_for_layout.width
            };

            let manual_size = style.font_size.filter(|s| s.is_finite() && *s > 0.0);
            let line_height = style.line_height.unwrap_or(1.0);
            let letter_spacing = style.letter_spacing_px.unwrap_or(0.0);
            let min_size = style
                .min_font_size
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(|v| v.round() as u32)
                .unwrap_or(6);

            let mut tl = TextLayout::new(&font, manual_size)
                .with_fallback_fonts(&self.symbol_fallbacks)
                .with_max_height(box_for_layout.height)
                .with_max_width(max_width)
                .with_writing_mode(writing_mode)
                .with_line_height(line_height)
                .with_letter_spacing(letter_spacing)
                .with_horizontal_scale(style.horizontal_scale.unwrap_or(1.0))
                .with_min_font_size(min_size);
            if let Some(size) = manual_size {
                tl = tl.with_font_size(size);
            }
            tl.run(&normalized_translation)
        };

        let mut layout = build_layout(layout_box, false)?;
        if auto_expand_english_layout {
            let underfilled = latin_layout_underfilled(&layout, layout_box.height);
            if underfilled {
                let relaxed_box = bubble_map
                    .map(|map| expand_latin_layout_box_relaxed(&layout_source_block, map))
                    .unwrap_or(layout_box);
                let relaxed_candidate =
                    if layout_box_area(relaxed_box) > layout_box_area(layout_box) * 1.06 {
                        build_layout(relaxed_box, true)
                            .ok()
                            .map(|layout| (layout, relaxed_box))
                    } else {
                        None
                    };

                let overflow_candidate = build_layout(layout_box, true)
                    .ok()
                    .map(|layout| (layout, layout_box));
                if let Some((candidate_layout, candidate_box)) =
                    pick_better_latin_candidate(&layout, relaxed_candidate, overflow_candidate)
                {
                    layout = candidate_layout;
                    layout_box = candidate_box;
                }
            }

            center_layout_vertically(&mut layout, layout_box.height);
        }
        // Apply user-controlled vertical alignment (default Top is the
        // pre-existing behaviour — nothing to do).
        if let Some(va) = style.vertical_align {
            apply_vertical_align(&mut layout, layout_box.height, va);
        }
        if let Some(shift) = style.baseline_shift_px {
            for line in &mut layout.lines {
                if writing_mode.is_vertical() {
                    line.baseline.0 += shift;
                } else {
                    line.baseline.1 -= shift;
                }
            }
        }
        align_layout_horizontally(&mut layout, writing_mode, layout_box.width, text_align);

        // Expand the layout surface to match layout_box dimensions before rendering.
        //
        // `align_layout_horizontally` shifts glyph baseline positions for center/right
        // alignment relative to `layout_box.width`, but `renderer.render()` creates a
        // Pixmap of `layout.width × layout.height` (the tight ink-bounds size).  When
        // center/right offsets push glyphs beyond `layout.width`, they are drawn outside
        // the Pixmap and silently clipped — the translation visually "overflows" the
        // text block on canvas.
        //
        // By setting layout.width/height to layout_box dimensions here, the renderer
        // allocates a surface that is exactly the block size.  Glyphs at their final
        // (alignment-adjusted) positions are always within bounds.  For overflow text
        // (auto-fit fell back to min_font_size), tiny_skia clips at the surface edge —
        // truncation is visible but does not exceed the block boundary.
        layout.width = layout_box.width;
        layout.height = layout_box.height;

        let resolved_stroke = resolve_stroke_style(
            text_block,
            style.stroke.as_ref(),
            global_stroke.as_ref(),
            layout.font_size,
        );
        let rendered = self.renderer.render(
            &layout,
            writing_mode,
            &RenderOptions {
                font_size: layout.font_size,
                color,
                effect: block_effect,
                stroke: resolved_stroke,
                horizontal_scale: style.horizontal_scale.unwrap_or(1.0),
                ..Default::default()
            },
        )?;

        text_block.x = layout_box.x;
        text_block.y = layout_box.y;
        text_block.width = layout_box.width;
        text_block.height = layout_box.height;
        text_block.rendered = Some(DynamicImage::ImageRgba8(rendered).into());
        Ok(())
    }

    fn select_font(&self, style: &TextStyle) -> Result<Font> {
        let mut fontbook = self
            .fontbook
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock fontbook"))?;
        
        let mut props = Properties::default();
        if let Some(effect) = style.effect {
            if effect.bold {
                props.weight = fontique::FontWeight::BOLD;
            }
            if effect.italic {
                props.style = fontique::FontStyle::Italic;
            }
        }

        let font = fontbook.query(
            style
                .font_families
                .iter()
                .map(|family| FamilyName::Title(family.to_string()))
                .collect::<Vec<_>>()
                .as_slice(),
            &props,
        )?;
        Ok(font)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnglishLayoutBehavior {
    Disabled,
    AutoExpand,
    LockedToManualSize,
}

fn english_layout_behavior(
    text_block: &TextBlock,
    normalized_translation: &str,
    writing_mode: WritingMode,
) -> EnglishLayoutBehavior {
    let is_english_horizontal =
        writing_mode == WritingMode::Horizontal && is_latin_only(normalized_translation);
    if !is_english_horizontal {
        return EnglishLayoutBehavior::Disabled;
    }

    if text_block.lock_layout_box {
        EnglishLayoutBehavior::LockedToManualSize
    } else {
        EnglishLayoutBehavior::AutoExpand
    }
}

fn default_stroke_width(font_size: f32) -> f32 {
    (font_size * 0.10).clamp(1.2, 8.0)
}

fn apply_global_font_family(font_families: &mut Vec<String>, font_family: Option<&str>) {
    if font_families.is_empty()
        && let Some(font_family) = font_family
    {
        font_families.push(font_family.to_string());
    }
}

fn apply_default_font_families(font_families: &mut Vec<String>, text: &str) {
    if font_families.is_empty() {
        *font_families = font_families_for_text(text);
    }
}

fn resolve_stroke_style(
    block: &TextBlock,
    block_stroke: Option<&TextStrokeStyle>,
    global_stroke: Option<&TextStrokeStyle>,
    font_size: f32,
) -> Option<RenderStrokeOptions> {
    if let Some(stroke) = block_stroke {
        if !stroke.enabled {
            return None;
        }
        return Some(RenderStrokeOptions {
            color: stroke.color,
            width_px: stroke
                .width_px
                .unwrap_or_else(|| default_stroke_width(font_size)),
        });
    }

    if let Some(stroke) = global_stroke {
        if !stroke.enabled {
            return None;
        }
        return Some(RenderStrokeOptions {
            color: stroke.color,
            width_px: stroke
                .width_px
                .unwrap_or_else(|| default_stroke_width(font_size)),
        });
    }

    if let Some(pred) = &block.font_prediction
        && pred.stroke_width_px > 0.0
    {
        return Some(RenderStrokeOptions {
            color: [
                pred.stroke_color[0],
                pred.stroke_color[1],
                pred.stroke_color[2],
                255,
            ],
            width_px: pred.stroke_width_px,
        });
    }

    Some(RenderStrokeOptions {
        color: [255, 255, 255, 255],
        width_px: default_stroke_width(font_size),
    })
}

fn align_layout_horizontally(
    layout: &mut LayoutRun<'_>,
    writing_mode: WritingMode,
    container_width: f32,
    text_align: TextAlign,
) {
    if !container_width.is_finite() || container_width <= 0.0 {
        return;
    }

    let target_width = layout.width.max(container_width);
    if writing_mode.is_vertical() {
        let remaining = (container_width - layout.width).max(0.0);
        let offset = match text_align {
            TextAlign::Left => 0.0,
            TextAlign::Center => remaining * 0.5,
            TextAlign::Right => remaining,
        };
        if offset > 0.0 {
            for line in &mut layout.lines {
                line.baseline.0 += offset;
            }
        }
        layout.width = target_width;
        return;
    }

    for line in &mut layout.lines {
        if line.advance <= 0.0 {
            continue;
        }
        let remaining = (container_width - line.advance).max(0.0);
        let offset = match text_align {
            TextAlign::Left => 0.0,
            TextAlign::Center => remaining * 0.5,
            TextAlign::Right => remaining,
        };
        if offset > 0.0 {
            line.baseline.0 += offset;
        }
    }
    layout.width = target_width;
}

fn center_layout_vertically(layout: &mut LayoutRun<'_>, container_height: f32) {
    if !container_height.is_finite() || container_height <= 0.0 || layout.lines.is_empty() {
        return;
    }
    let offset = ((container_height - layout.height) * 0.5).max(0.0);
    if offset <= 0.0 {
        return;
    }

    for line in &mut layout.lines {
        line.baseline.1 += offset;
    }
    layout.height = layout.height.max(container_height);
}

/// Shift the laid-out lines so that the block sits at the top, middle,
/// or bottom of the container. Top is a no-op (the layout already
/// starts at y=0).
fn apply_vertical_align(
    layout: &mut LayoutRun<'_>,
    container_height: f32,
    align: koharu_types::VerticalAlign,
) {
    if !container_height.is_finite() || container_height <= 0.0 || layout.lines.is_empty() {
        return;
    }
    let remaining = (container_height - layout.height).max(0.0);
    if remaining <= 0.0 {
        return;
    }
    let offset = match align {
        koharu_types::VerticalAlign::Top => return,
        koharu_types::VerticalAlign::Middle => remaining * 0.5,
        koharu_types::VerticalAlign::Bottom => remaining,
    };
    for line in &mut layout.lines {
        line.baseline.1 += offset;
    }
    layout.height = layout.height.max(container_height);
}

fn load_symbol_fallbacks(fontbook: &mut FontBook) -> Vec<Font> {
    let props = Properties::default();
    let candidates = [
        "Segoe UI Symbol",
        "Segoe UI Emoji",
        "Noto Sans Symbols",
        "Noto Sans Symbols2",
        "Noto Color Emoji",
        "Apple Color Emoji",
        "Apple Symbols",
        "Symbola",
        "Arial Unicode MS",
    ];
    let mut fonts = Vec::new();
    for name in candidates {
        if let Ok(font) = fontbook.query(&[FamilyName::Title(name.to_string())], &props) {
            fonts.push(font);
        }
    }
    fonts
}

#[cfg(test)]
mod tests {
    use super::{
        EnglishLayoutBehavior, align_layout_horizontally, apply_default_font_families,
        apply_global_font_family, center_layout_vertically, english_layout_behavior,
    };
    use crate::layout::{LayoutLine, LayoutRun, WritingMode};
    use koharu_types::{TextAlign, TextBlock};

    #[test]
    fn horizontal_alignment_offsets_each_line() {
        let mut layout = LayoutRun {
            lines: vec![
                LayoutLine {
                    advance: 40.0,
                    baseline: (0.0, 10.0),
                    ..Default::default()
                },
                LayoutLine {
                    advance: 80.0,
                    baseline: (0.0, 30.0),
                    ..Default::default()
                },
            ],
            width: 80.0,
            height: 40.0,
            font_size: 16.0,
        };

        align_layout_horizontally(
            &mut layout,
            WritingMode::Horizontal,
            100.0,
            TextAlign::Center,
        );

        assert_eq!(layout.lines[0].baseline.0, 30.0);
        assert_eq!(layout.lines[1].baseline.0, 10.0);
        assert_eq!(layout.width, 100.0);
    }

    #[test]
    fn right_alignment_uses_full_remaining_width() {
        let mut layout = LayoutRun {
            lines: vec![LayoutLine {
                advance: 40.0,
                baseline: (0.0, 10.0),
                ..Default::default()
            }],
            width: 40.0,
            height: 20.0,
            font_size: 16.0,
        };

        align_layout_horizontally(
            &mut layout,
            WritingMode::Horizontal,
            100.0,
            TextAlign::Right,
        );

        assert_eq!(layout.lines[0].baseline.0, 60.0);
    }

    #[test]
    fn vertical_alignment_offsets_all_columns_as_a_group() {
        let mut layout = LayoutRun {
            lines: vec![
                LayoutLine {
                    baseline: (10.0, 12.0),
                    ..Default::default()
                },
                LayoutLine {
                    baseline: (30.0, 12.0),
                    ..Default::default()
                },
            ],
            width: 40.0,
            height: 80.0,
            font_size: 16.0,
        };

        align_layout_horizontally(
            &mut layout,
            WritingMode::VerticalRl,
            100.0,
            TextAlign::Center,
        );

        assert_eq!(layout.lines[0].baseline.0, 40.0);
        assert_eq!(layout.lines[1].baseline.0, 60.0);
        assert_eq!(layout.width, 100.0);
    }

    #[test]
    fn vertical_centering_preserves_existing_behavior() {
        let mut layout = LayoutRun {
            lines: vec![LayoutLine {
                advance: 40.0,
                baseline: (0.0, 12.0),
                ..Default::default()
            }],
            width: 40.0,
            height: 20.0,
            font_size: 16.0,
        };

        center_layout_vertically(&mut layout, 60.0);

        assert_eq!(layout.lines[0].baseline.1, 32.0);
        assert_eq!(layout.height, 60.0);
    }

    #[test]
    fn explicit_block_font_should_not_be_overridden_by_global_font() {
        let mut font_families = vec!["Block Font".to_string()];
        apply_global_font_family(&mut font_families, Some("Global Font"));

        assert_eq!(font_families, vec!["Block Font".to_string()]);
    }

    #[test]
    fn global_font_should_fill_empty_block_font_list() {
        let mut font_families = Vec::new();
        apply_global_font_family(&mut font_families, Some("Global Font"));
        assert_eq!(font_families, vec!["Global Font".to_string()]);
    }

    #[test]
    fn default_font_families_should_fill_empty_list() {
        let mut font_families = Vec::new();
        apply_default_font_families(&mut font_families, "hello");
        assert!(!font_families.is_empty());
    }

    #[test]
    fn english_layout_auto_expands_by_default() {
        let block = TextBlock::default();
        let behavior = english_layout_behavior(&block, "HELLO WORLD", WritingMode::Horizontal);
        assert_eq!(behavior, EnglishLayoutBehavior::AutoExpand);
    }

    #[test]
    fn english_layout_stops_auto_expand_after_manual_resize() {
        let block = TextBlock {
            lock_layout_box: true,
            ..Default::default()
        };
        let behavior = english_layout_behavior(&block, "HELLO WORLD", WritingMode::Horizontal);
        assert_eq!(behavior, EnglishLayoutBehavior::LockedToManualSize);
    }

    #[test]
    fn non_english_layout_never_uses_english_expansion_logic() {
        let block = TextBlock::default();
        let behavior = english_layout_behavior(&block, "こんにちは", WritingMode::Horizontal);
        assert_eq!(behavior, EnglishLayoutBehavior::Disabled);
    }
}

fn premultiply_rgba(pixels: &mut [u8]) {
    for px in pixels.chunks_exact_mut(4) {
        let a = px[3];
        if a == 0 || a == 255 {
            continue;
        }
        let alpha = a as u32;
        px[0] = ((px[0] as u32 * alpha + 127) / 255) as u8;
        px[1] = ((px[1] as u32 * alpha + 127) / 255) as u8;
        px[2] = ((px[2] as u32 * alpha + 127) / 255) as u8;
    }
}
