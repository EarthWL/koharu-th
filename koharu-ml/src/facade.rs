use anyhow::Result;
use image::{DynamicImage, GenericImageView};
use koharu_types::{Document, FontPrediction, OcrEngine, SerializableDynamicImage};

use crate::comic_text_detector::{self, ComicTextDetector};
use crate::font_detector::{self, FontDetector};
use crate::lama::{self, Lama};
use crate::manga_ocr::MangaOcr;
use crate::mit48px_ocr::{self, Mit48pxOcr};

const NEAR_BLACK_THRESHOLD: u8 = 12;
const GRAY_NEAR_BLACK_THRESHOLD: u8 = 60;
const NEAR_WHITE_THRESHOLD: u8 = 12;
const GRAY_NEAR_WHITE_THRESHOLD: u8 = 60;
const GRAY_TOLERANCE: u8 = 10;
const SIMILAR_COLOR_MAX_DIFF: u8 = 16;

fn clamp_near_black(color: [u8; 3]) -> [u8; 3] {
    let max_channel = *color.iter().max().unwrap_or(&0);
    let min_channel = *color.iter().min().unwrap_or(&0);
    let is_grayish = max_channel.saturating_sub(min_channel) <= GRAY_TOLERANCE;
    let threshold = if is_grayish {
        GRAY_NEAR_BLACK_THRESHOLD
    } else {
        NEAR_BLACK_THRESHOLD
    };

    if color[0] <= threshold && color[1] <= threshold && color[2] <= threshold {
        [0, 0, 0]
    } else {
        color
    }
}

fn clamp_near_white(color: [u8; 3]) -> [u8; 3] {
    let max_channel = *color.iter().max().unwrap_or(&0);
    let min_channel = *color.iter().min().unwrap_or(&0);
    let is_grayish = max_channel.saturating_sub(min_channel) <= GRAY_TOLERANCE;
    let threshold = if is_grayish {
        GRAY_NEAR_WHITE_THRESHOLD
    } else {
        NEAR_WHITE_THRESHOLD
    };

    let min_white = 255u8.saturating_sub(threshold);
    if color[0] >= min_white && color[1] >= min_white && color[2] >= min_white {
        [255, 255, 255]
    } else {
        color
    }
}

fn colors_similar(a: [u8; 3], b: [u8; 3]) -> bool {
    a[0].abs_diff(b[0]) <= SIMILAR_COLOR_MAX_DIFF
        && a[1].abs_diff(b[1]) <= SIMILAR_COLOR_MAX_DIFF
        && a[2].abs_diff(b[2]) <= SIMILAR_COLOR_MAX_DIFF
}

fn normalize_font_prediction(prediction: &mut FontPrediction) {
    prediction.text_color = clamp_near_white(clamp_near_black(prediction.text_color));
    prediction.stroke_color = clamp_near_white(clamp_near_black(prediction.stroke_color));

    if prediction.stroke_width_px > 0.0
        && colors_similar(prediction.text_color, prediction.stroke_color)
    {
        prediction.stroke_width_px = 0.0;
        prediction.stroke_color = prediction.text_color;
    }
}

pub struct Model {
    dialog_detector: ComicTextDetector,
    ocr_mit48px: Mit48pxOcr,
    /// Lazily loaded on first use — Manga OCR is ~100MB and most
    /// users stay on the default Mit48px engine, no reason to pay the
    /// VRAM / startup cost for a model nobody asked for.
    ocr_manga: tokio::sync::OnceCell<MangaOcr>,
    /// Stashed so the lazy MangaOcr loader knows whether to use CPU.
    use_cpu: bool,
    lama: Lama,
    font_detector: FontDetector,
}

impl Model {
    pub async fn new(use_cpu: bool) -> Result<Self> {
        Ok(Self {
            dialog_detector: ComicTextDetector::load(use_cpu).await?,
            ocr_mit48px: Mit48pxOcr::load(use_cpu).await?,
            ocr_manga: tokio::sync::OnceCell::new(),
            use_cpu,
            lama: Lama::load(use_cpu).await?,
            font_detector: FontDetector::load(use_cpu).await?,
        })
    }

    async fn manga_ocr(&self) -> Result<&MangaOcr> {
        self.ocr_manga
            .get_or_try_init(|| MangaOcr::load(self.use_cpu))
            .await
    }

    /// Detect text blocks and fonts in a document.
    /// Sets `doc.text_blocks` (with font predictions/styles) and `doc.segment`.
    pub async fn detect(&self, doc: &mut Document) -> Result<()> {
        self.detect_with(doc, false).await
    }

    /// Same as `detect`, but with an optional experimental
    /// "merge YOLO bboxes" pass. When `merge_yolo` is true, runs the
    /// regular DBNet detection then also decodes YOLOv5's own bbox
    /// output (which DBNet's pipeline normally throws away) and adds
    /// any boxes DBNet missed — targets SFX / stylised title text
    /// that DBNet's per-pixel segmentation tends to miss.
    pub async fn detect_with(&self, doc: &mut Document, merge_yolo: bool) -> Result<()> {
        let detection = if merge_yolo {
            self.dialog_detector
                .inference_with_yolo_merge(&doc.image)?
        } else {
            self.dialog_detector.inference(&doc.image)?
        };
        doc.text_blocks = detection.text_blocks;
        doc.segment = Some(DynamicImage::ImageLuma8(detection.mask).into());

        if !doc.text_blocks.is_empty() {
            let images: Vec<DynamicImage> = doc
                .text_blocks
                .iter()
                .map(|block| {
                    doc.image.crop_imm(
                        block.x as u32,
                        block.y as u32,
                        block.width as u32,
                        block.height as u32,
                    )
                })
                .collect();

            let font_predictions = self.detect_fonts(&images, 1).await?;
            for (block, prediction) in doc.text_blocks.iter_mut().zip(font_predictions) {
                block.font_prediction = Some(prediction);
                block.style = None;
            }
        }

        Ok(())
    }

    /// Run OCR on all text blocks in the document with the default
    /// engine (Mit48px). Kept as a thin wrapper around `ocr_with` so
    /// existing call sites that haven't been threaded the engine
    /// preference yet keep working.
    pub async fn ocr(&self, doc: &mut Document) -> Result<()> {
        self.ocr_with(doc, OcrEngine::default()).await
    }

    /// Run OCR on all text blocks using the chosen engine. Falls back
    /// to Mit48px if the requested engine fails to load (e.g. network
    /// down for the first-time MangaOcr fetch). Caller doesn't need
    /// to know about the fallback — text is still populated.
    pub async fn ocr_with(&self, doc: &mut Document, engine: OcrEngine) -> Result<()> {
        if doc.text_blocks.is_empty() {
            return Ok(());
        }

        let effective_engine = match engine {
            OcrEngine::Mit48px => OcrEngine::Mit48px,
            OcrEngine::Manga => match self.manga_ocr().await {
                Ok(_) => OcrEngine::Manga,
                Err(err) => {
                    tracing::warn!(
                        "Manga OCR failed to load ({err:#}); falling back to Mit48px"
                    );
                    OcrEngine::Mit48px
                }
            },
        };

        match effective_engine {
            OcrEngine::Mit48px => {
                let predictions = self
                    .ocr_mit48px
                    .inference_text_blocks(&doc.image, &doc.text_blocks)?;
                for prediction in predictions {
                    if let Some(block) = doc.text_blocks.get_mut(prediction.block_index) {
                        block.text = Some(prediction.text);
                    }
                }
            }
            OcrEngine::Manga => {
                // MangaOcr.inference takes pre-cropped per-block
                // images and returns texts in input order — different
                // shape from Mit48pxOcr which slices internally. We
                // do the cropping here so the rest of the pipeline
                // doesn't care which engine is active.
                let ocr = self
                    .manga_ocr()
                    .await
                    .expect("checked above");
                let crops: Vec<DynamicImage> = doc
                    .text_blocks
                    .iter()
                    .map(|b| {
                        let (w, h) = doc.image.dimensions();
                        // Defensive clamp — detector occasionally
                        // emits bboxes that touch / cross the image
                        // edge by a fractional pixel.
                        let x = (b.x as u32).min(w.saturating_sub(1));
                        let y = (b.y as u32).min(h.saturating_sub(1));
                        let bw = (b.width as u32).min(w.saturating_sub(x)).max(1);
                        let bh = (b.height as u32).min(h.saturating_sub(y)).max(1);
                        doc.image.crop_imm(x, y, bw, bh)
                    })
                    .collect();
                let texts = ocr.inference(&crops)?;
                for (block, text) in doc.text_blocks.iter_mut().zip(texts) {
                    block.text = Some(text);
                }
            }
        }

        Ok(())
    }

    /// Inpaint text regions in the document.
    /// Uses the current `doc.segment` mask as the inpaint source, sets `doc.inpainted`.
    pub async fn inpaint(&self, doc: &mut Document) -> Result<()> {
        // Upstream fix (cherry-picked from mayocream/koharu commit
        // 82454e03): skip inpaint when detect found nothing — otherwise
        // we run lama on an empty mask and either OOM or silently fail.
        if doc.text_blocks.is_empty() {
            tracing::debug!("skipping inpaint: no text blocks detected");
            return Ok(());
        }
        let mask = doc
            .segment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Segment image not found"))?;
        let result = self
            .lama
            .inference_with_blocks(&doc.image, mask, Some(&doc.text_blocks))?;
        doc.inpainted = Some(result.into());

        Ok(())
    }

    /// Low-level inpaint: inpaint a specific image region with a mask.
    pub async fn inpaint_raw(
        &self,
        image: &SerializableDynamicImage,
        mask: &SerializableDynamicImage,
        text_blocks: Option<&[koharu_types::TextBlock]>,
    ) -> Result<SerializableDynamicImage> {
        let result = self.lama.inference_with_blocks(image, mask, text_blocks)?;
        Ok(result.into())
    }

    pub async fn detect_font(&self, image: &DynamicImage, top_k: usize) -> Result<FontPrediction> {
        let mut results = self
            .detect_fonts(std::slice::from_ref(image), top_k)
            .await?;
        Ok(results.pop().unwrap_or_default())
    }

    pub async fn detect_fonts(
        &self,
        images: &[DynamicImage],
        top_k: usize,
    ) -> Result<Vec<FontPrediction>> {
        if images.is_empty() {
            return Ok(Vec::new());
        }

        let mut predictions = self.font_detector.inference(images, top_k)?;
        for prediction in &mut predictions {
            normalize_font_prediction(prediction);
        }
        Ok(predictions)
    }
}

pub async fn prefetch() -> Result<()> {
    comic_text_detector::prefetch().await?;
    mit48px_ocr::prefetch().await?;
    // Manga OCR is lazy-loaded at first use (it's optional), so we
    // intentionally skip prefetching it. Users who pick it from
    // Settings → Engines pay the one-time download then.
    lama::prefetch().await?;
    font_detector::prefetch().await?;

    Ok(())
}
