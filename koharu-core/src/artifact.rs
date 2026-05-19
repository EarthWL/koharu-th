//! `ArtifactKind` — what an engine consumes and produces.
//!
//! Replaces the rigid `PipelineStage` enum from the original Phase 1
//! spec (issue I in the post-#33 re-review). An engine declares
//! which artifacts it needs (`consumes`) and which it generates
//! (`produces`); the DAG resolver in `koharu-engines` (Phase 3) walks
//! the produces-consumes graph to derive execution order.
//!
//! Multi-artifact engines come for free — Anime Text YOLO produces
//! both `DetectionBoxes` AND `SegmentationMask` in one pass, so it
//! lists both in `produces` instead of being forced to split into
//! two artificial stages.
//!
//! ## Adding new artifacts
//!
//! Adding a variant is non-breaking (DAG resolver ignores artifact
//! kinds it doesn't see). Removing one IS breaking — any engine
//! still referencing it won't compile. Document the deprecation
//! before removing.

use serde::{Deserialize, Serialize};

/// The distinct artifact types that engines pass through the
/// pipeline. Order in this enum is meaningless (DAG resolver uses
/// the consumes/produces graph, not enum order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    /// The raw page image. Always present on every page (it's the
    /// input the user imported). No engine produces this; every
    /// engine that touches pixel data consumes it.
    SourceImage,

    /// Text-block bounding boxes from a detector pass.
    DetectionBoxes,

    /// Pixel-level mask used by inpainters to identify what to
    /// remove. Some detectors emit this (anime-text YOLO, bubble
    /// segmentation) — others need a separate segmentation step.
    SegmentationMask,

    /// Per-block source-language text from an OCR pass.
    OcrText,

    /// Page with source lettering removed, ready for translated
    /// text overlay.
    InpaintedImage,

    /// Per-block target-language translation. Consumes glossary,
    /// characters, prompt template from `ProjectView`.
    Translation,

    /// Final composite — inpainted page + rendered translated text.
    RenderedImage,

    /// User-drawn brush overlay (eraser / repair-brush strokes).
    /// Not produced by any engine; written by the canvas brush tool
    /// directly. Engines may consume it (e.g. inpaint that respects
    /// user-drawn mask additions).
    BrushLayer,

    /// Per-block font + text-color prediction from the font-
    /// detection model.
    FontPrediction,

    /// Reading order, paragraph grouping, line-direction hints.
    /// Used by the renderer engine to decide vertical vs horizontal
    /// flow and by the translate engine to feed the LLM in order.
    LayoutAnalysis,
}

impl ArtifactKind {
    /// True if the artifact is the canonical input that the user
    /// imports — engines never produce this, the document loader
    /// does. Used by the DAG resolver to ignore source-image as a
    /// dependency that needs producing.
    pub fn is_source(self) -> bool {
        matches!(self, ArtifactKind::SourceImage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_case_serialization() {
        let s = serde_json::to_string(&ArtifactKind::InpaintedImage).unwrap();
        assert_eq!(s, "\"inpainted_image\"");
    }

    #[test]
    fn source_image_marked_as_source() {
        assert!(ArtifactKind::SourceImage.is_source());
        assert!(!ArtifactKind::Translation.is_source());
        assert!(!ArtifactKind::SegmentationMask.is_source());
    }

    #[test]
    fn round_trip() {
        for k in [
            ArtifactKind::SourceImage,
            ArtifactKind::DetectionBoxes,
            ArtifactKind::SegmentationMask,
            ArtifactKind::OcrText,
            ArtifactKind::InpaintedImage,
            ArtifactKind::Translation,
            ArtifactKind::RenderedImage,
            ArtifactKind::BrushLayer,
            ArtifactKind::FontPrediction,
            ArtifactKind::LayoutAnalysis,
        ] {
            let s = serde_json::to_string(&k).unwrap();
            let k2: ArtifactKind = serde_json::from_str(&s).unwrap();
            assert_eq!(k, k2);
        }
    }
}
