//! v1 ↔ scene `TextStyle` conversion.
//!
//! Phase 4.1 deferred per-block style across the bridge with a
//! `style: None` stub on both legs (Document→scene in
//! `engine_bridge::build_scene_from_document`, and scene→Document in
//! `text_renderer::build_tmp_document`). The renderer reads
//! `koharu_types::TextBlock::style` and honours font size, color,
//! stroke, alignment, line-height, letter-spacing, min-font-size and
//! vertical-align — so dropping style meant **none of the Render-panel
//! controls had any on-canvas effect** through the v2 engine path.
//!
//! These two functions complete the mapping. The shapes are mirror
//! images; the only awkward seam is `color`: scene carries
//! `Option<[u8;4]>` (None = "inherit / auto-pick from font prediction")
//! while v1 carries a required `[u8;4]`. We materialise None to opaque
//! black on the way to v1, matching the renderer's historical fallback.

use koharu_core::scene::{
    RenderEffect as SceneEffect, RenderStroke as SceneStroke, TextAlign as SceneAlign,
    TextStyle as SceneStyle, VerticalAlign as SceneVAlign, WritingMode as SceneWritingMode,
};
use koharu_types::{
    TextAlign as V1Align, TextShaderEffect as V1Effect, TextStrokeStyle as V1Stroke,
    TextStyle as V1Style, TextWritingMode as V1WritingMode, VerticalAlign as V1VAlign,
};

/// Default text colour when a scene block leaves `color` unset.
/// Opaque black matches the renderer's pre-v2 fallback.
const DEFAULT_TEXT_COLOR: [u8; 4] = [0, 0, 0, 255];

fn align_v1_to_scene(a: V1Align) -> SceneAlign {
    match a {
        V1Align::Left => SceneAlign::Left,
        V1Align::Center => SceneAlign::Center,
        V1Align::Right => SceneAlign::Right,
    }
}

fn align_scene_to_v1(a: SceneAlign) -> V1Align {
    match a {
        SceneAlign::Left => V1Align::Left,
        SceneAlign::Center => V1Align::Center,
        SceneAlign::Right => V1Align::Right,
    }
}

fn valign_v1_to_scene(a: V1VAlign) -> SceneVAlign {
    match a {
        V1VAlign::Top => SceneVAlign::Top,
        V1VAlign::Middle => SceneVAlign::Middle,
        V1VAlign::Bottom => SceneVAlign::Bottom,
    }
}

fn valign_scene_to_v1(a: SceneVAlign) -> V1VAlign {
    match a {
        SceneVAlign::Top => V1VAlign::Top,
        SceneVAlign::Middle => V1VAlign::Middle,
        SceneVAlign::Bottom => V1VAlign::Bottom,
    }
}

fn wmode_v1_to_scene(m: V1WritingMode) -> SceneWritingMode {
    match m {
        V1WritingMode::Auto => SceneWritingMode::Auto,
        V1WritingMode::Horizontal => SceneWritingMode::Horizontal,
        V1WritingMode::Vertical => SceneWritingMode::Vertical,
    }
}

fn wmode_scene_to_v1(m: SceneWritingMode) -> V1WritingMode {
    match m {
        SceneWritingMode::Auto => V1WritingMode::Auto,
        SceneWritingMode::Horizontal => V1WritingMode::Horizontal,
        SceneWritingMode::Vertical => V1WritingMode::Vertical,
    }
}

/// Convert a persisted v1 `TextStyle` (the shape stored on
/// `Document`/SQLite and edited by the Render panel) into the scene
/// representation the engine pipeline carries.
pub fn scene_style_from_v1(s: &V1Style) -> SceneStyle {
    SceneStyle {
        font_families: s.font_families.clone(),
        font_size: s.font_size,
        color: Some(s.color),
        effect: s.effect.map(|e| SceneEffect {
            italic: e.italic,
            bold: e.bold,
        }),
        stroke: s.stroke.as_ref().map(|st| SceneStroke {
            enabled: st.enabled,
            color: st.color,
            width_px: st.width_px,
        }),
        text_align: s.text_align.map(align_v1_to_scene),
        line_height: s.line_height,
        letter_spacing_px: s.letter_spacing_px,
        min_font_size: s.min_font_size,
        vertical_align: s.vertical_align.map(valign_v1_to_scene),
        writing_mode: s.writing_mode.map(wmode_v1_to_scene),
    }
}

/// Convert a scene `TextStyle` back into the v1 shape the renderer
/// (`koharu_renderer::facade::Renderer::render`) consumes.
pub fn v1_style_from_scene(s: &SceneStyle) -> V1Style {
    V1Style {
        font_families: s.font_families.clone(),
        font_size: s.font_size,
        color: s.color.unwrap_or(DEFAULT_TEXT_COLOR),
        effect: s.effect.map(|e| V1Effect {
            italic: e.italic,
            bold: e.bold,
        }),
        stroke: s.stroke.as_ref().map(|st| V1Stroke {
            enabled: st.enabled,
            color: st.color,
            width_px: st.width_px,
        }),
        text_align: s.text_align.map(align_scene_to_v1),
        line_height: s.line_height,
        letter_spacing_px: s.letter_spacing_px,
        min_font_size: s.min_font_size,
        vertical_align: s.vertical_align.map(valign_scene_to_v1),
        writing_mode: s.writing_mode.map(wmode_scene_to_v1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_all_fields() {
        let original = V1Style {
            font_families: vec!["Noto Sans Thai".into(), "Arial".into()],
            font_size: Some(28.0),
            color: [12, 34, 56, 200],
            effect: Some(V1Effect {
                italic: true,
                bold: false,
            }),
            stroke: Some(V1Stroke {
                enabled: true,
                color: [255, 255, 255, 255],
                width_px: Some(2.5),
            }),
            text_align: Some(V1Align::Center),
            line_height: Some(1.35),
            letter_spacing_px: Some(0.5),
            min_font_size: Some(14.0),
            vertical_align: Some(V1VAlign::Middle),
            writing_mode: Some(V1WritingMode::Vertical),
        };

        let scene = scene_style_from_v1(&original);
        let back = v1_style_from_scene(&scene);

        assert_eq!(back.font_families, original.font_families);
        assert_eq!(back.font_size, original.font_size);
        assert_eq!(back.color, original.color);
        assert_eq!(back.effect.map(|e| (e.italic, e.bold)), Some((true, false)));
        assert!(back.stroke.is_some());
        let st = back.stroke.unwrap();
        assert!(st.enabled);
        assert_eq!(st.width_px, Some(2.5));
        assert_eq!(back.text_align, Some(V1Align::Center));
        assert_eq!(back.line_height, Some(1.35));
        assert_eq!(back.letter_spacing_px, Some(0.5));
        assert_eq!(back.min_font_size, Some(14.0));
        assert_eq!(back.vertical_align, Some(V1VAlign::Middle));
        assert_eq!(back.writing_mode, Some(V1WritingMode::Vertical));
    }

    #[test]
    fn scene_none_color_materialises_to_black() {
        let scene = SceneStyle {
            font_families: vec![],
            font_size: None,
            color: None,
            effect: None,
            stroke: None,
            text_align: None,
            line_height: None,
            letter_spacing_px: None,
            min_font_size: None,
            vertical_align: None,
            writing_mode: None,
        };
        assert_eq!(v1_style_from_scene(&scene).color, DEFAULT_TEXT_COLOR);
    }
}
