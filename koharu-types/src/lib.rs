mod effect;
mod font;
mod image;

pub use effect::TextShaderEffect;
pub use font::{FontPrediction, NamedFontPrediction, TextDirection};
pub use image::SerializableDynamicImage;

/// Selectable OCR engine. The current default `Mit48px` is what the
/// app has shipped with since fork; `Manga` is a Japanese-tuned
/// encoder-decoder (mayocream/manga-ocr) — often better at handwritten
/// or stylised Japanese, sometimes worse at SFX / latin.
#[derive(
    Default, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash,
)]
#[serde(rename_all = "snake_case")]
pub enum OcrEngine {
    #[default]
    Mit48px,
    Manga,
}

/// Selectable text-region detector. `Default` keeps the current
/// `comic_text_detector` (DBNet + UNet + YOLOv5 backbone trio, tuned
/// for in-bubble text); `AnimeYolo` swaps in YOLO12 trained
/// specifically on anime/manga text (mayocream/anime-text-yolo) —
/// designed to catch SFX / stylised titles / out-of-bubble text
/// that the default misses. Lazy-loaded ~10MB on first use of the
/// N (nano) variant.
#[derive(
    Default, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash,
)]
#[serde(rename_all = "snake_case")]
pub enum DetectorEngine {
    #[default]
    Default,
    AnimeYolo,
}

impl OcrEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            OcrEngine::Mit48px => "mit48px",
            OcrEngine::Manga => "manga",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "mit48px" | "mit48" | "mit" => Some(OcrEngine::Mit48px),
            "manga" | "manga_ocr" | "mangaocr" => Some(OcrEngine::Manga),
            _ => None,
        }
    }
}

impl DetectorEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            DetectorEngine::Default => "default",
            DetectorEngine::AnimeYolo => "anime_yolo",
        }
    }
}

/// Size variant for the Anime Text YOLO detector. Only meaningful
/// when `DetectorEngine::AnimeYolo` is selected. Mirrors
/// `koharu_ml::anime_text::AnimeTextYoloVariant`.
///
/// Bigger variants = better recall, slower inference + larger
/// download. Approximate sizes:
///   N (nano)        ~10MB
///   S (small)       ~30MB
///   M (medium)      ~80MB
///   L (large)       ~150MB
///   X (extra large) ~250MB
#[derive(
    Default, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash,
)]
#[serde(rename_all = "lowercase")]
pub enum AnimeYoloVariant {
    #[default]
    N,
    S,
    M,
    L,
    X,
}

impl AnimeYoloVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            AnimeYoloVariant::N => "n",
            AnimeYoloVariant::S => "s",
            AnimeYoloVariant::M => "m",
            AnimeYoloVariant::L => "l",
            AnimeYoloVariant::X => "x",
        }
    }
}

use std::{path::PathBuf, sync::Arc};

use ::image::GenericImageView;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub confidence: f32,
    pub line_polygons: Option<Vec<[[f32; 2]; 4]>>,
    pub source_direction: Option<TextDirection>,
    pub source_language: Option<String>,
    pub rotation_deg: Option<f32>,
    pub detected_font_size_px: Option<f32>,
    pub detector: Option<String>,
    pub text: Option<String>,
    pub translation: Option<String>,
    pub style: Option<TextStyle>,
    pub font_prediction: Option<FontPrediction>,
    pub rendered: Option<SerializableDynamicImage>,
    #[serde(skip)]
    pub lock_layout_box: bool,
    #[serde(skip)]
    pub layout_seed_x: Option<f32>,
    #[serde(skip)]
    pub layout_seed_y: Option<f32>,
    #[serde(skip)]
    pub layout_seed_width: Option<f32>,
    #[serde(skip)]
    pub layout_seed_height: Option<f32>,
}

impl TextBlock {
    pub fn set_layout_seed(&mut self, x: f32, y: f32, width: f32, height: f32) {
        self.layout_seed_x = Some(x);
        self.layout_seed_y = Some(y);
        self.layout_seed_width = Some(width.max(1.0));
        self.layout_seed_height = Some(height.max(1.0));
    }

    pub fn seed_layout_box(&mut self) -> (f32, f32, f32, f32) {
        match (
            self.layout_seed_x,
            self.layout_seed_y,
            self.layout_seed_width,
            self.layout_seed_height,
        ) {
            (Some(x), Some(y), Some(width), Some(height))
                if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 =>
            {
                (x, y, width, height)
            }
            _ => {
                self.set_layout_seed(self.x, self.y, self.width, self.height);
                (self.x, self.y, self.width.max(1.0), self.height.max(1.0))
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStrokeStyle {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_stroke_color")]
    pub color: [u8; 4],
    #[serde(default)]
    pub width_px: Option<f32>,
}

impl Default for TextStrokeStyle {
    fn default() -> Self {
        Self {
            enabled: true,
            color: [255, 255, 255, 255],
            width_px: None,
        }
    }
}

const fn default_true() -> bool {
    true
}

const fn default_stroke_color() -> [u8; 4] {
    [255, 255, 255, 255]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum VerticalAlign {
    #[default]
    Top,
    Middle,
    Bottom,
}

/// User override for text orientation. `Auto` (default) lets the
/// renderer pick from script + bubble aspect ratio (CJK in a tall
/// bubble → vertical). `Horizontal` / `Vertical` force the choice —
/// useful for SFX or stylised lettering where the auto-heuristic
/// (which never goes vertical for non-CJK like Thai) guesses wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextWritingMode {
    #[default]
    Auto,
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub font_families: Vec<String>,
    pub font_size: Option<f32>,
    pub color: [u8; 4],
    pub effect: Option<TextShaderEffect>,
    pub stroke: Option<TextStrokeStyle>,
    #[serde(default)]
    pub text_align: Option<TextAlign>,
    /// Multiplier on the font's intrinsic line height. 1.0 = use the
    /// font's natural metrics; 1.3 is a good default for Thai so tone
    /// marks have room to breathe.
    #[serde(default)]
    pub line_height: Option<f32>,
    /// Extra horizontal pixels inserted between every shaped cluster.
    /// Helps Thai readability at small font sizes; default = 0.
    #[serde(default)]
    pub letter_spacing_px: Option<f32>,
    /// Floor for the auto-fit binary search. Without this, auto-fit
    /// can shrink text to 6px which is illegible for Thai. Default
    /// (None) keeps the global floor.
    #[serde(default)]
    pub min_font_size: Option<f32>,
    /// Where to place the laid-out block within its bubble. Default
    /// behaviour (None) is Top to keep current visual output unchanged.
    #[serde(default)]
    pub vertical_align: Option<VerticalAlign>,
    /// Force horizontal / vertical text, or `None`/`Auto` to let the
    /// renderer decide from script + bubble shape.
    #[serde(default)]
    pub writing_mode: Option<TextWritingMode>,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub image: SerializableDynamicImage,
    pub width: u32,
    pub height: u32,
    pub text_blocks: Vec<TextBlock>,
    pub segment: Option<SerializableDynamicImage>,
    pub inpainted: Option<SerializableDynamicImage>,
    pub rendered: Option<SerializableDynamicImage>,
    pub brush_layer: Option<SerializableDynamicImage>,
}

impl Document {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let bytes = std::fs::read(&path)?;

        let documents = Self::from_bytes(path, bytes)?;
        documents
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No document found in file"))
    }

    pub fn from_bytes(path: impl Into<PathBuf>, bytes: Vec<u8>) -> anyhow::Result<Vec<Self>> {
        let path = path.into();
        Ok(vec![Self::image(path, bytes)?])
    }

    fn image(path: PathBuf, bytes: Vec<u8>) -> anyhow::Result<Self> {
        let img = ::image::load_from_memory(&bytes)?;
        let (width, height) = img.dimensions();
        let id = blake3::hash(&bytes).to_hex().to_string();
        let name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        Ok(Document {
            id,
            path,
            name,
            image: SerializableDynamicImage(img),
            width,
            height,
            ..Default::default()
        })
    }
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub documents: Vec<Document>,
}

pub type AppState = Arc<RwLock<State>>;

#[cfg(test)]
mod tests {
    use super::TextBlock;

    #[test]
    fn seed_layout_box_stays_stable_until_explicit_reset() {
        let mut block = TextBlock {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
            ..Default::default()
        };

        let first = block.seed_layout_box();
        assert_eq!(first, (10.0, 20.0, 30.0, 40.0));

        block.x = 100.0;
        block.y = 200.0;
        block.width = 300.0;
        block.height = 400.0;

        let second = block.seed_layout_box();
        assert_eq!(second, first);

        block.set_layout_seed(block.x, block.y, block.width, block.height);
        let third = block.seed_layout_box();
        assert_eq!(third, (100.0, 200.0, 300.0, 400.0));
    }
}
