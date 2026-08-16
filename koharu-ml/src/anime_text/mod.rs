//! Anime Text YOLO detector — ported from upstream mayocream/koharu's
//! `anime_text` module. YOLO12 architecture trained specifically on
//! anime/manga text (mayocream/anime-text-yolo on HuggingFace),
//! including SFX / stylised titles / out-of-bubble text that the
//! comic_text_detector's DBNet branch tends to miss.
//!
//! Adapted to our codebase:
//!   - Uses our `define_models!` macro + `loading::load_mmaped_safetensors`
//!     instead of upstream's `RuntimeManager` / `declare_hf_model_package!`.
//!   - Output uses `koharu_types::TextBlock` directly (upstream defined
//!     its own intermediate `TextRegion` type).
//!   - Always loads in F32 (no upstream BF16/ZLUDA gymnastics).
//!
//! Selectable via Settings → Engines → Detector. Default OFF; the
//! existing `comic_text_detector` remains the production default.

mod model;
mod ops;

use std::time::Instant;

use anyhow::{Context, Result, bail};
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_transformers::object_detection::{Bbox, non_maximum_suppression};
use image::{
    DynamicImage, Rgb, RgbImage,
    imageops::{self, FilterType},
};
pub use koharu_types::AnimeYoloVariant as AnimeTextYoloVariant;
use koharu_types::TextBlock;
use serde::Serialize;
use tracing::instrument;

use crate::{define_models, device, loading};

use self::model::{Yolo12, Yolo12Scale};

pub const HF_REPO: &str = "mayocream/anime-text-yolo";
const INPUT_SIZE: u32 = 640;
const NUM_CLASSES: usize = 1;
const DEFAULT_VARIANT: AnimeTextYoloVariant = AnimeTextYoloVariant::N;
// Upstream uses 0.25 / 0.45. Default matches upstream so power users
// matching reference tooling see identical output; in practice users
// who hit over-detection raise the slider in Settings → Detector to
// 0.35-0.45. NMS held at 0.50 so near-overlapping boxes (typical of
// stylised vertical SFX) merge instead of stacking.
pub const DEFAULT_CONFIDENCE_THRESHOLD: f32 = 0.25;
pub const DEFAULT_NMS_THRESHOLD: f32 = 0.50;
const LETTERBOX_COLOR: u8 = 114;
const DETECTOR_NAME: &str = "anime-text-yolo";

define_models! {
    Yolo12n => ("mayocream/anime-text-yolo", "yolo12n_animetext.safetensors"),
    Yolo12s => ("mayocream/anime-text-yolo", "yolo12s_animetext.safetensors"),
    Yolo12m => ("mayocream/anime-text-yolo", "yolo12m_animetext.safetensors"),
    Yolo12l => ("mayocream/anime-text-yolo", "yolo12l_animetext.safetensors"),
    Yolo12x => ("mayocream/anime-text-yolo", "yolo12x_animetext.safetensors"),
}

/// Map the shared types-side `AnimeYoloVariant` to our model
/// manifest + Yolo12 scale. Kept here so the rest of the codebase
/// only depends on `koharu_types::AnimeYoloVariant`.
fn manifest_for(v: AnimeTextYoloVariant) -> Manifest {
    match v {
        AnimeTextYoloVariant::N | AnimeTextYoloVariant::Auto => Manifest::Yolo12n,
        AnimeTextYoloVariant::S => Manifest::Yolo12s,
        AnimeTextYoloVariant::M => Manifest::Yolo12m,
        AnimeTextYoloVariant::L => Manifest::Yolo12l,
        AnimeTextYoloVariant::X => Manifest::Yolo12x,
    }
}

fn scale_for(v: AnimeTextYoloVariant) -> Yolo12Scale {
    match v {
        AnimeTextYoloVariant::N | AnimeTextYoloVariant::Auto => Yolo12Scale::N,
        AnimeTextYoloVariant::S => Yolo12Scale::S,
        AnimeTextYoloVariant::M => Yolo12Scale::M,
        AnimeTextYoloVariant::L => Yolo12Scale::L,
        AnimeTextYoloVariant::X => Yolo12Scale::X,
    }
}

pub struct AnimeTextDetector {
    model: Yolo12,
    variant: AnimeTextYoloVariant,
    device: Device,
}

#[derive(Debug, Clone)]
struct PreparedInput {
    pixel_values: Tensor,
    original_width: u32,
    original_height: u32,
    pad_x: u32,
    pad_y: u32,
    scale: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeTextDetection {
    pub image_width: u32,
    pub image_height: u32,
    pub variant: AnimeTextYoloVariant,
    pub regions: Vec<AnimeTextRegion>,
    pub text_blocks: Vec<TextBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeTextRegion {
    pub label_id: usize,
    pub score: f32,
    pub bbox: [f32; 4],
}

impl AnimeTextDetector {
    pub async fn load(cpu: bool) -> Result<Self> {
        Self::load_variant(DEFAULT_VARIANT, cpu).await
    }

    pub async fn load_variant(variant: AnimeTextYoloVariant, cpu: bool) -> Result<Self> {
        let device = device(cpu)?;
        let scale = scale_for(variant);
        let model =
            loading::load_mmaped_safetensors(manifest_for(variant).get(), &device, move |vb| {
                Yolo12::load(vb, scale, NUM_CLASSES)
            })
            .await
            .with_context(|| {
                format!(
                    "failed to load anime text YOLO {} weights",
                    variant.as_str()
                )
            })?;

        Ok(Self {
            model,
            variant,
            device,
        })
    }

    pub fn variant(&self) -> AnimeTextYoloVariant {
        self.variant
    }

    #[instrument(level = "debug", skip_all)]
    pub fn inference(&self, image: &DynamicImage) -> Result<AnimeTextDetection> {
        self.inference_with_thresholds(image, DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_NMS_THRESHOLD)
    }

    #[instrument(level = "debug", skip_all)]
    pub fn inference_with_thresholds(
        &self,
        image: &DynamicImage,
        confidence_threshold: f32,
        nms_threshold: f32,
    ) -> Result<AnimeTextDetection> {
        let started = Instant::now();
        let prepared = self.preprocess(image)?;
        let outputs = self.model.forward(&prepared.pixel_values)?;
        let regions = postprocess(&outputs, &prepared, confidence_threshold, nms_threshold)?;
        let text_blocks = regions_to_text_blocks(&regions);

        tracing::info!(
            width = image.width(),
            height = image.height(),
            variant = self.variant.as_str(),
            detections = regions.len(),
            total_ms = started.elapsed().as_millis(),
            "anime text YOLO timings"
        );

        Ok(AnimeTextDetection {
            image_width: prepared.original_width,
            image_height: prepared.original_height,
            variant: self.variant,
            regions,
            text_blocks,
        })
    }

    fn preprocess(&self, image: &DynamicImage) -> Result<PreparedInput> {
        let rgb = image.to_rgb8();
        let (original_width, original_height) = rgb.dimensions();
        let scale = f32::min(
            INPUT_SIZE as f32 / original_width.max(1) as f32,
            INPUT_SIZE as f32 / original_height.max(1) as f32,
        );
        let resized_width = ((original_width as f32 * scale).round() as u32).clamp(1, INPUT_SIZE);
        let resized_height = ((original_height as f32 * scale).round() as u32).clamp(1, INPUT_SIZE);
        let pad_x = (INPUT_SIZE - resized_width) / 2;
        let pad_y = (INPUT_SIZE - resized_height) / 2;

        let resized = if resized_width == original_width && resized_height == original_height {
            rgb
        } else {
            imageops::resize(&rgb, resized_width, resized_height, FilterType::Triangle)
        };

        let mut letterboxed =
            RgbImage::from_pixel(INPUT_SIZE, INPUT_SIZE, Rgb([LETTERBOX_COLOR; 3]));
        imageops::overlay(
            &mut letterboxed,
            &resized,
            i64::from(pad_x),
            i64::from(pad_y),
        );

        let pixel_values = Tensor::from_vec(
            letterboxed.into_raw(),
            (1, INPUT_SIZE as usize, INPUT_SIZE as usize, 3),
            &self.device,
        )?
        .permute((0, 3, 1, 2))?
        .to_dtype(DType::F32)?;
        let pixel_values = (pixel_values * (1.0 / 255.0))?;

        Ok(PreparedInput {
            pixel_values,
            original_width,
            original_height,
            pad_x,
            pad_y,
            scale,
        })
    }
}

// NOTE: `define_models!` auto-generates a `prefetch()` that downloads
// every variant (~500MB+ if X is included). We deliberately don't
// call it from `facade::prefetch()` — users who opt into this
// detector via Settings only download the variant they pick, on
// first use, via `AnimeTextDetector::load_variant`.

fn postprocess(
    outputs: &Tensor,
    prepared: &PreparedInput,
    confidence_threshold: f32,
    nms_threshold: f32,
) -> Result<Vec<AnimeTextRegion>> {
    let pred = outputs
        .to_dtype(DType::F32)?
        .to_device(&Device::Cpu)?
        .i(0)?;
    let (channels, anchors) = pred.dims2()?;
    let expected_channels = 4 + NUM_CLASSES;
    if channels != expected_channels {
        bail!(
            "unexpected anime text YOLO prediction channels {channels}, expected {expected_channels}"
        );
    }

    let mut grouped: Vec<Vec<Bbox<usize>>> = (0..NUM_CLASSES).map(|_| Vec::new()).collect();
    for anchor_idx in 0..anchors {
        let values = pred.i((.., anchor_idx))?.to_vec1::<f32>()?;
        let class_scores = &values[4..4 + NUM_CLASSES];
        let Some((label_id, &score)) = class_scores
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.total_cmp(b))
        else {
            continue;
        };
        if score < confidence_threshold {
            continue;
        }

        let bbox = map_bbox_to_original(
            [
                values[0] - values[2] * 0.5,
                values[1] - values[3] * 0.5,
                values[0] + values[2] * 0.5,
                values[1] + values[3] * 0.5,
            ],
            prepared,
        );
        if bbox[2] <= bbox[0] || bbox[3] <= bbox[1] {
            continue;
        }

        grouped[label_id].push(Bbox {
            xmin: bbox[0],
            ymin: bbox[1],
            xmax: bbox[2],
            ymax: bbox[3],
            confidence: score,
            data: label_id,
        });
    }

    non_maximum_suppression(&mut grouped, nms_threshold);

    let mut regions = Vec::new();
    for (label_id, bboxes) in grouped.into_iter().enumerate() {
        for bbox in bboxes {
            regions.push(AnimeTextRegion {
                label_id,
                score: bbox.confidence,
                bbox: [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax],
            });
        }
    }
    regions.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(regions)
}

fn map_bbox_to_original(bbox: [f32; 4], prepared: &PreparedInput) -> [f32; 4] {
    let width = prepared.original_width as f32;
    let height = prepared.original_height as f32;
    let pad_x = prepared.pad_x as f32;
    let pad_y = prepared.pad_y as f32;
    [
        ((bbox[0] - pad_x) / prepared.scale).clamp(0.0, width),
        ((bbox[1] - pad_y) / prepared.scale).clamp(0.0, height),
        ((bbox[2] - pad_x) / prepared.scale).clamp(0.0, width),
        ((bbox[3] - pad_y) / prepared.scale).clamp(0.0, height),
    ]
}

fn regions_to_text_blocks(regions: &[AnimeTextRegion]) -> Vec<TextBlock> {
    regions
        .iter()
        .filter_map(|region| {
            let width = (region.bbox[2] - region.bbox[0]).max(0.0);
            let height = (region.bbox[3] - region.bbox[1]).max(0.0);
            if width <= 1.0 || height <= 1.0 {
                return None;
            }
            let quad: [[f32; 2]; 4] = [
                [region.bbox[0], region.bbox[1]],
                [region.bbox[2], region.bbox[1]],
                [region.bbox[2], region.bbox[3]],
                [region.bbox[0], region.bbox[3]],
            ];
            let mut block = TextBlock::default();
            block.x = region.bbox[0];
            block.y = region.bbox[1];
            block.width = width;
            block.height = height;
            block.confidence = region.score;
            block.line_polygons = Some(vec![quad]);
            block.detector = Some(DETECTOR_NAME.to_string());
            Some(block)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{PreparedInput, map_bbox_to_original};
    use candle_core::{DType, Device, Tensor};

    #[test]
    fn map_bbox_to_original_removes_letterbox_padding() {
        let prepared = PreparedInput {
            pixel_values: Tensor::zeros((1, 3, 640, 640), DType::F32, &Device::Cpu)
                .expect("tensor"),
            original_width: 1000,
            original_height: 500,
            pad_x: 0,
            pad_y: 160,
            scale: 0.64,
        };

        let bbox = map_bbox_to_original([100.0, 200.0, 540.0, 440.0], &prepared);
        assert!((bbox[0] - 156.25).abs() < 1e-3);
        assert!((bbox[1] - 62.5).abs() < 1e-3);
        assert!((bbox[2] - 843.75).abs() < 1e-3);
        assert!((bbox[3] - 437.5).abs() < 1e-3);
    }
}
