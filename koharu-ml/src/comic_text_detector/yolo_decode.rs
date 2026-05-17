//! YOLOv5 output postprocessing — decode raw predictions into image-
//! space bboxes, filter by confidence, deduplicate via NMS.
//!
//! `YoloV5::forward` already returns predictions with cx/cy/w/h in
//! detect-resolution image coordinates (anchor + grid math done in
//! the model). This file picks up from there: confidence filter +
//! class selection + non-max suppression + scale-back to original
//! image dimensions.
//!
//! Used only by the experimental "merge YOLO bboxes" detector path
//! (Settings → Engines → "Also use YOLO bboxes"). The default
//! `ComicTextDetector::inference` is unaffected.

use anyhow::Result;
use candle_core::Tensor;

/// One YOLO detection in original-image pixel coords.
#[derive(Debug, Clone, Copy)]
pub struct YoloBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub confidence: f32,
    /// Index into the model's class list. The comic-text-detector YOLO
    /// has 2 classes (likely text + bubble in some order). Caller
    /// decides which to keep.
    pub class_id: usize,
}

impl YoloBox {
    pub fn width(&self) -> f32 {
        (self.x2 - self.x1).max(0.0)
    }
    pub fn height(&self) -> f32 {
        (self.y2 - self.y1).max(0.0)
    }
    pub fn area(&self) -> f32 {
        self.width() * self.height()
    }
}

/// Decode + filter + NMS the raw `[1, N, 7]` predictions tensor.
///
/// `detect_size` is the square input resolution the model ran at
/// (1280 or 640); we rescale boxes back to `original_dims`.
///
/// - `conf_threshold`: drop boxes whose `objectness * class_prob` is
///   below this. 0.25 is a YOLOv5 default; bump to 0.4 for fewer
///   false positives.
/// - `iou_threshold`: NMS overlap cutoff. 0.45 is the YOLOv5 default.
/// - `keep_classes`: bitmask of allowed class indices. `None` = keep
///   both. For "text only" pass `Some(&[0])` (or `&[1]` depending on
///   which class is text in this specific model — we keep both by
///   default since the comic-text-detector docs are ambiguous).
pub fn decode_predictions(
    predictions: &Tensor,
    detect_size: u32,
    original_dims: (u32, u32),
    conf_threshold: f32,
    iou_threshold: f32,
    keep_classes: Option<&[usize]>,
) -> Result<Vec<YoloBox>> {
    let (orig_w, orig_h) = original_dims;
    // Shape: [batch, N, 5 + num_classes]. We only ran with batch=1.
    let pred = predictions.squeeze(0)?; // [N, 5 + num_classes]
    let dims = pred.dims();
    if dims.len() != 2 || dims[1] < 6 {
        anyhow::bail!(
            "unexpected YOLO predictions shape {:?} (expected [N, 5+num_classes])",
            dims
        );
    }
    let n = dims[0];
    let num_classes = dims[1] - 5;

    // Pull the whole tensor to CPU as a flat Vec<f32>. N is typically
    // ~25k for 1280px input, so this is a few hundred KB — fine.
    let flat: Vec<f32> = pred.to_dtype(candle_core::DType::F32)?.flatten_all()?.to_vec1()?;
    let row_stride = 5 + num_classes;

    // Scale factor from detect-space back to original-image space.
    // YOLOv5 was square-padded to detect_size on its longer side; the
    // shorter side was letterboxed. We use a simple uniform scale
    // because preprocess in mod.rs resizes the whole image to a
    // square *without* letterboxing (rearranged_maps takes care of
    // aspect mismatches separately) — see fix below for the typical
    // case where the preprocess does a flat resize.
    let scale_x = orig_w as f32 / detect_size as f32;
    let scale_y = orig_h as f32 / detect_size as f32;

    let mut candidates: Vec<YoloBox> = Vec::with_capacity(64);
    for i in 0..n {
        let off = i * row_stride;
        let cx = flat[off];
        let cy = flat[off + 1];
        let w = flat[off + 2];
        let h = flat[off + 3];
        let obj = flat[off + 4];
        if obj < conf_threshold {
            continue;
        }
        // Pick best class
        let mut best_class = 0usize;
        let mut best_class_prob = 0.0f32;
        for c in 0..num_classes {
            let p = flat[off + 5 + c];
            if p > best_class_prob {
                best_class_prob = p;
                best_class = c;
            }
        }
        if let Some(allowed) = keep_classes
            && !allowed.contains(&best_class)
        {
            continue;
        }
        let confidence = obj * best_class_prob;
        if confidence < conf_threshold {
            continue;
        }
        // Center+wh in detect-space → corner+corner in image-space
        let x1 = (cx - w * 0.5) * scale_x;
        let y1 = (cy - h * 0.5) * scale_y;
        let x2 = (cx + w * 0.5) * scale_x;
        let y2 = (cy + h * 0.5) * scale_y;
        // Clamp to image bounds + drop degenerate boxes
        let x1 = x1.max(0.0);
        let y1 = y1.max(0.0);
        let x2 = x2.min(orig_w as f32);
        let y2 = y2.min(orig_h as f32);
        if x2 - x1 < 2.0 || y2 - y1 < 2.0 {
            continue;
        }
        candidates.push(YoloBox {
            x1,
            y1,
            x2,
            y2,
            confidence,
            class_id: best_class,
        });
    }

    Ok(non_max_suppression(candidates, iou_threshold))
}

/// Standard greedy NMS — keep highest-confidence boxes, drop anything
/// overlapping them above the IoU threshold.
fn non_max_suppression(mut boxes: Vec<YoloBox>, iou_threshold: f32) -> Vec<YoloBox> {
    boxes.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    let mut kept: Vec<YoloBox> = Vec::with_capacity(boxes.len());
    for b in boxes {
        let mut overlaps = false;
        for k in &kept {
            if k.class_id == b.class_id && iou(k, &b) > iou_threshold {
                overlaps = true;
                break;
            }
        }
        if !overlaps {
            kept.push(b);
        }
    }
    kept
}

/// Intersection-over-Union for two axis-aligned boxes.
fn iou(a: &YoloBox, b: &YoloBox) -> f32 {
    let ix1 = a.x1.max(b.x1);
    let iy1 = a.y1.max(b.y1);
    let ix2 = a.x2.min(b.x2);
    let iy2 = a.y2.min(b.y2);
    let iw = (ix2 - ix1).max(0.0);
    let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    let union = a.area() + b.area() - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x1: f32, y1: f32, x2: f32, y2: f32, c: f32) -> YoloBox {
        YoloBox {
            x1,
            y1,
            x2,
            y2,
            confidence: c,
            class_id: 0,
        }
    }

    #[test]
    fn nms_keeps_highest_drops_overlapping() {
        // Two boxes that overlap ~90% — should keep only the higher-conf one.
        let boxes = vec![b(0.0, 0.0, 100.0, 100.0, 0.9), b(5.0, 5.0, 95.0, 95.0, 0.8)];
        let kept = non_max_suppression(boxes, 0.45);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].confidence, 0.9);
    }

    #[test]
    fn nms_keeps_non_overlapping() {
        let boxes = vec![b(0.0, 0.0, 50.0, 50.0, 0.9), b(60.0, 60.0, 100.0, 100.0, 0.8)];
        let kept = non_max_suppression(boxes, 0.45);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn iou_self_is_one() {
        let a = b(10.0, 10.0, 50.0, 50.0, 1.0);
        assert!((iou(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn iou_disjoint_is_zero() {
        let a = b(0.0, 0.0, 10.0, 10.0, 1.0);
        let c = b(20.0, 20.0, 30.0, 30.0, 1.0);
        assert_eq!(iou(&a, &c), 0.0);
    }
}
