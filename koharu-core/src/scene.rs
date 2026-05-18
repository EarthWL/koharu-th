//! `Scene` — the read-only page model engines see.
//!
//! Engines never mutate a `Scene` directly. They read the current
//! state through `&Scene` (or `&Page`) and emit `Vec<Op>`; the driver
//! applies those ops to produce the next `Scene`.
//!
//! The shape mirrors the existing `Document` / `TextBlock` types in
//! `ui/types.d.ts` so the migration is mostly a rename + replacing
//! raw `Uint8Array` fields with `BlobId`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::blob::BlobId;
use crate::id::{NodeId, PageId};

/// The entire project state visible to engines for one execution.
///
/// `Scene` does not own project-wide entities (glossary, characters,
/// TM, prompts) — those stay in `koharu-project` and are passed
/// separately via `EngineCtx.project`. `Scene` only owns the visual
/// state of pages.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Scene {
    pub pages: IndexMap<PageId, Page>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub id: PageId,
    pub source_image: BlobId,
    pub width: u32,
    pub height: u32,

    /// Text blocks indexed by stable `NodeId`. Insertion order is the
    /// reading order — `IndexMap` preserves it across serialization.
    pub text_blocks: IndexMap<NodeId, TextBlock>,

    // Pipeline-produced artifacts. `None` = stage not yet run.
    pub segmentation_mask: Option<BlobId>,
    pub inpainted_image: Option<BlobId>,
    pub rendered_image: Option<BlobId>,
    pub brush_layer: Option<BlobId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextBlock {
    pub id: NodeId,
    pub region: Region,
    pub source_text: Option<String>,
    pub translation: Option<String>,
    pub style: Option<TextStyle>,
    pub source_lang: Option<String>,
    pub font_prediction: Option<FontPrediction>,
}

/// Axis-aligned bounding box in source-image pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Region {
    /// Area in square pixels. Used by the bubble-fit warning
    /// heuristic and for engine output validation.
    pub fn area(&self) -> u64 {
        self.width as u64 * self.height as u64
    }

    /// True if `other` is fully inside `self`.
    pub fn contains(&self, other: &Region) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.x + other.width <= self.x + self.width
            && other.y + other.height <= self.y + self.height
    }
}

/// Rendering style for a text block. Mirrors the existing
/// `TextStyle` in `ui/types.d.ts` minus the binary `rendered` field
/// (that's now a `BlobId` on the parent `Page` if it's a full-page
/// composite, or omitted entirely for per-block on-the-fly render).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextStyle {
    pub font_families: Vec<String>,
    pub font_size: Option<f32>,
    pub color: Option<[u8; 4]>,
    pub effect: Option<RenderEffect>,
    pub stroke: Option<RenderStroke>,
    pub text_align: Option<TextAlign>,
    pub line_height: Option<f32>,
    pub letter_spacing_px: Option<f32>,
    pub min_font_size: Option<f32>,
    pub vertical_align: Option<VerticalAlign>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RenderEffect {
    pub italic: bool,
    pub bold: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderStroke {
    pub enabled: bool,
    pub color: [u8; 4],
    pub width_px: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerticalAlign {
    Top,
    Middle,
    Bottom,
}

/// Output of the font-detection model (yuzumarker-font-detection).
/// Engines downstream (LLM translate, renderer) read this to seed
/// their font picks before user override.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontPrediction {
    pub font_family: String,
    pub text_color: [u8; 3],
    pub confidence: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: u64) -> Page {
        Page {
            id: PageId(id),
            source_image: BlobId([0; 32]),
            width: 800,
            height: 1200,
            text_blocks: IndexMap::new(),
            segmentation_mask: None,
            inpainted_image: None,
            rendered_image: None,
            brush_layer: None,
        }
    }

    #[test]
    fn region_area() {
        let r = Region { x: 0, y: 0, width: 100, height: 50 };
        assert_eq!(r.area(), 5000);
    }

    #[test]
    fn region_contains() {
        let outer = Region { x: 0, y: 0, width: 100, height: 100 };
        let inner = Region { x: 10, y: 10, width: 50, height: 50 };
        let edge = Region { x: 0, y: 0, width: 100, height: 100 };
        let overhang = Region { x: 60, y: 0, width: 50, height: 50 };
        assert!(outer.contains(&inner));
        assert!(outer.contains(&edge), "edge-aligned box is contained");
        assert!(!outer.contains(&overhang));
    }

    #[test]
    fn scene_round_trip_serde() {
        let mut scene = Scene::default();
        scene.pages.insert(PageId(1), page(1));
        scene.pages.insert(PageId(2), page(2));
        let s = serde_json::to_string(&scene).unwrap();
        let scene2: Scene = serde_json::from_str(&s).unwrap();
        assert_eq!(scene2.pages.len(), 2);
        // Ordering preserved by IndexMap → first key is still 1.
        assert_eq!(scene2.pages.keys().next(), Some(&PageId(1)));
    }
}
