use anyhow::Result;
use image::{DynamicImage, GenericImageView};
use koharu_types::{Document, DetectorEngine, FontPrediction, OcrEngine, SerializableDynamicImage};
use tokio::sync::Mutex;

use crate::anime_text::{AnimeTextDetector, AnimeTextYoloVariant};
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
    /// Lazily loaded on first use — AnimeTextYOLO N variant is ~10MB,
    /// X variant ~250MB. We hold one loaded variant at a time
    /// (Mutex<Option<(variant, detector)>>) instead of caching all
    /// five — switching variants reloads the new one and drops the
    /// old, which keeps VRAM bounded but means switching has a
    /// one-time cost. Users typically pick a size and stick with it,
    /// so this is the right tradeoff.
    detector_anime: Mutex<Option<(AnimeTextYoloVariant, std::sync::Arc<AnimeTextDetector>)>>,
    /// Stashed so the lazy MangaOcr / AnimeTextDetector loaders know
    /// whether to use CPU.
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
            detector_anime: Mutex::new(None),
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

    async fn anime_text_detector(
        &self,
        variant: AnimeTextYoloVariant,
    ) -> Result<std::sync::Arc<AnimeTextDetector>> {
        let mut guard = self.detector_anime.lock().await;
        match guard.as_ref() {
            Some((cached, det)) if *cached == variant => Ok(det.clone()),
            _ => {
                tracing::info!(
                    variant = variant.as_str(),
                    "loading AnimeText YOLO variant (reloading or first use)"
                );
                let det = std::sync::Arc::new(
                    AnimeTextDetector::load_variant(variant, self.use_cpu).await?,
                );
                *guard = Some((variant, det.clone()));
                Ok(det)
            }
        }
    }

    /// Detect text blocks and fonts in a document with the default
    /// detector (`comic_text_detector`). Thin wrapper around
    /// `detect_with` for callers that haven't been threaded the
    /// engine preference yet.
    pub async fn detect(&self, doc: &mut Document) -> Result<()> {
        self.detect_with(doc, DetectorEngine::default(), None, None)
            .await
    }

    /// Detect text blocks + bubble mask + fonts using the chosen
    /// detector engine. Falls back to the default if the requested
    /// engine fails to load (e.g. network down for the first-time
    /// AnimeTextYolo fetch). Always populates the bubble `segment`
    /// from the default detector — Anime Text YOLO has no bubble
    /// branch, so we keep using the default for that signal.
    ///
    /// `anime_yolo_variant` only matters when `engine` is `AnimeYolo`;
    /// None defaults to the smallest (N) variant.
    ///
    /// `anime_yolo_confidence` overrides Anime Text YOLO's confidence
    /// threshold (None = module default 0.25). Clamped to a sane range;
    /// only consulted when the YOLO branch actually runs.
fn intersection_over_union(a: &koharu_types::TextBlock, b: &koharu_types::TextBlock) -> f32 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.width).min(b.x + b.width);
    let y2 = (a.y + a.height).min(b.y + b.height);

    let intersection_width = (x2 - x1).max(0.0);
    let intersection_height = (y2 - y1).max(0.0);
    let intersection_area = intersection_width * intersection_height;

    let area_a = a.width * a.height;
    let area_b = b.width * b.height;
    let union_area = area_a + area_b - intersection_area;

    if union_area <= 0.0 {
        0.0
    } else {
        intersection_area / union_area
    }
}

    /// Detect text blocks + bubble mask + fonts using the chosen
    /// detector engine. Falls back to the default if the requested
    /// engine fails to load (e.g. network down for the first-time
    /// AnimeTextYolo fetch). Always populates the bubble `segment`
    /// from the default detector — Anime Text YOLO has no bubble
    /// branch, so we keep using the default for that signal.
    ///
    /// `anime_yolo_variant` only matters when `engine` is `AnimeYolo` or `Auto`;
    /// None defaults to the smallest (N) variant or is dynamically scaled if `Auto`.
    ///
    /// `anime_yolo_confidence` overrides Anime Text YOLO's confidence
    /// threshold (None = module default 0.25). Clamped to a sane range;
    /// only consulted when the YOLO branch actually runs.
    pub async fn detect_with(
        &self,
        doc: &mut Document,
        engine: DetectorEngine,
        anime_yolo_variant: Option<AnimeTextYoloVariant>,
        anime_yolo_confidence: Option<f32>,
    ) -> Result<()> {
        let is_cuda = matches!(crate::device(false), Ok(candle_core::Device::Cuda(_)));
        let actual_variant = match anime_yolo_variant.unwrap_or(AnimeTextYoloVariant::N) {
            AnimeTextYoloVariant::Auto => {
                if !is_cuda {
                    AnimeTextYoloVariant::N
                } else {
                    let max_dim = doc.width.max(doc.height);
                    if max_dim >= 2500 {
                        AnimeTextYoloVariant::X
                    } else if max_dim >= 1800 {
                        AnimeTextYoloVariant::L
                    } else if max_dim >= 1200 {
                        AnimeTextYoloVariant::M
                    } else {
                        AnimeTextYoloVariant::S
                    }
                }
            }
            other => other,
        };

        // Always run the default lightweight detector first to get base text blocks and mask
        let default_detection = self.dialog_detector.inference(&doc.image)?;
        let default_blocks = default_detection.text_blocks;
        doc.segment = Some(DynamicImage::ImageLuma8(default_detection.mask).into());

        // Determine if we should also run the heavier Anime YOLO model
        let run_yolo = match engine {
            DetectorEngine::Default => false,
            DetectorEngine::AnimeYolo => true,
            DetectorEngine::Auto => {
                // Heuristic for Auto engine:
                // 1. If default detector found no text at all (potential out-of-bubble/SFX only page).
                // 2. If running on CUDA since it is very fast, to ensure maximum recall.
                // 3. If the page is dense (>= 8 blocks) and likely has complex layouts.
                default_blocks.is_empty() || is_cuda || default_blocks.len() >= 8
            }
        };

        let mut final_blocks = default_blocks.clone();

        if run_yolo {
            match self.anime_text_detector(actual_variant).await {
                Ok(yolo) => {
                    let conf = anime_yolo_confidence
                        .unwrap_or(crate::anime_text::DEFAULT_CONFIDENCE_THRESHOLD)
                        .clamp(0.05, 0.95);
                    match yolo.inference_with_thresholds(
                        &doc.image,
                        conf,
                        crate::anime_text::DEFAULT_NMS_THRESHOLD,
                    ) {
                        Ok(anime) => {
                            // Parallel Hybrid Merge with IoU deduplication
                            let mut merged = anime.text_blocks; // Keep all YOLO blocks (SFX, stylized)
                            for def_block in default_blocks {
                                let is_duplicate = merged.iter().any(|yolo_block| {
                                    intersection_over_union(&def_block, yolo_block) > 0.35
                                });
                                if !is_duplicate {
                                    merged.push(def_block);
                                }
                            }
                            final_blocks = merged;
                        }
                        Err(err) => {
                            tracing::warn!("AnimeText YOLO inference failed ({err:#}); falling back to default detector");
                        }
                    }
                }
                Err(err) => {
                    tracing::warn!(
                        "AnimeText YOLO {} failed to load ({err:#}); falling back to default detector",
                        actual_variant.as_str()
                    );
                }
            }
        }

        doc.text_blocks = final_blocks;

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
