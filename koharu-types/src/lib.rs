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
    Mit48px,
    Manga,
    #[default]
    Auto,
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
    Auto,
}

impl OcrEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            OcrEngine::Mit48px => "mit48px",
            OcrEngine::Manga => "manga",
            OcrEngine::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "mit48px" | "mit48" | "mit" => Some(OcrEngine::Mit48px),
            "manga" | "manga_ocr" | "mangaocr" => Some(OcrEngine::Manga),
            "auto" => Some(OcrEngine::Auto),
            _ => None,
        }
    }
}

impl DetectorEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            DetectorEngine::Default => "default",
            DetectorEngine::AnimeYolo => "anime_yolo",
            DetectorEngine::Auto => "auto",
        }
    }
}

/// Selectable Inpainting Engine.
/// `Lama` (Tier 1: Offline, lightweight, fast, default)
/// `StableDiffusion` (Tier 2: Offline/Local high-quality quantized/OpenVINO or local high-quality path)
/// `CloudFlux` (Tier 3: Online high-quality via API or premium fallbacks)
#[derive(
    Default, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash,
)]
#[serde(rename_all = "snake_case")]
pub enum InpaintEngine {
    #[default]
    Lama,
    StableDiffusion,
    CloudFlux,
}

impl InpaintEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            InpaintEngine::Lama => "lama",
            InpaintEngine::StableDiffusion => "stable_diffusion",
            InpaintEngine::CloudFlux => "cloud_flux",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "lama" => Some(InpaintEngine::Lama),
            "stable_diffusion" | "stable-diffusion" | "sd" => Some(InpaintEngine::StableDiffusion),
            "cloud_flux" | "cloud-flux" | "flux" => Some(InpaintEngine::CloudFlux),
            _ => None,
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
    Auto,
}

impl AnimeYoloVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            AnimeYoloVariant::N => "n",
            AnimeYoloVariant::S => "s",
            AnimeYoloVariant::M => "m",
            AnimeYoloVariant::L => "l",
            AnimeYoloVariant::X => "x",
            AnimeYoloVariant::Auto => "auto",
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
    /// Shift baseline vertically (positive values shift text up for horizontal writing mode).
    #[serde(default)]
    pub baseline_shift_px: Option<f32>,
    /// Scale glyphs horizontally (e.g. 1.0 is default, 0.9 compresses, 1.1 expands).
    #[serde(default)]
    pub horizontal_scale: Option<f32>,
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
            image: img.into(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticError {
    pub code: String,
    pub msg_th: String,
    pub details: String,
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.msg_th)
    }
}

impl std::error::Error for DiagnosticError {}

impl DiagnosticError {
    pub fn new(code: &str, msg_th: &str, details: &str) -> Self {
        Self {
            code: code.to_string(),
            msg_th: msg_th.to_string(),
            details: details.to_string(),
        }
    }
}

pub fn classify_error(err: &anyhow::Error) -> DiagnosticError {
    if let Some(diag) = err.downcast_ref::<DiagnosticError>() {
        return diag.clone();
    }

    let err_str = format!("{err:#}");

    // 1. LLM / API errors
    if err_str.contains("API key") || err_str.contains("api_key") || err_str.contains("ApiKey") {
        return DiagnosticError::new(
            "ERR_LLM_INVALID_KEY",
            "ไม่พบ API Key หรือ API Key ไม่ถูกต้อง กรุณาตรวจสอบการตั้งค่าคีย์ในเมนูโปรไฟล์",
            &err_str,
        );
    }
    if err_str.contains("rate limit") || err_str.contains("RateLimit") || err_str.contains("429") {
        return DiagnosticError::new(
            "ERR_LLM_RATE_LIMIT",
            "เกินขีดจำกัดความเร็วคำขอ (Rate Limit) ของผู้ให้บริการระบบแปล กรุณารอสักครู่แล้วลองใหม่อีกครั้ง",
            &err_str,
        );
    }
    if err_str.contains("blocked") || err_str.contains("safety") || err_str.contains("harmful") {
        return DiagnosticError::new(
            "ERR_LLM_BLOCKED",
            "คำขอถูกบล็อกจากนโยบายความปลอดภัยของผู้ให้บริการ LLM หรือเนื้อหาถูกปฏิเสธ",
            &err_str,
        );
    }

    // 2. Network errors
    if err_str.contains("timeout") || err_str.contains("timed out") {
        return DiagnosticError::new(
            "ERR_NET_TIMEOUT",
            "การเชื่อมต่อเครือข่ายหมดเวลา กรุณาตรวจสอบอินเทอร์เน็ตหรือตั้งค่า Proxy",
            &err_str,
        );
    }
    if err_str.contains("dns") || err_str.contains("resolve host") || err_str.contains("Could not resolve") {
        return DiagnosticError::new(
            "ERR_NET_DNS_FAILED",
            "ไม่สามารถค้นหาโฮสต์ปลายทางได้ (DNS Error) กรุณาตรวจสอบความถูกต้องของ URL หรือเครือข่าย",
            &err_str,
        );
    }
    if err_str.contains("proxy") || err_str.contains("Socks5") || err_str.contains("HttpProxy") {
        return DiagnosticError::new(
            "ERR_NET_PROXY_FAILED",
            "การเชื่อมต่อผ่าน Proxy ล้มเหลว กรุณาตรวจสอบตัวแปรสภาพแวดล้อมหรือการเชื่อมต่อ VPN/Proxy ของคุณ",
            &err_str,
        );
    }

    // 3. Database errors
    if err_str.contains("database is locked") || err_str.contains("busy") {
        return DiagnosticError::new(
            "ERR_DB_LOCKED",
            "ฐานข้อมูล SQLite ถูกล็อกเนื่องจากการเขียนซ้อนทับ กรุณารอสักครู่ให้งานก่อนหน้าทำงานเสร็จ",
            &err_str,
        );
    }
    if err_str.contains("constraint failed") || err_str.contains("UNIQUE constraint") {
        return DiagnosticError::new(
            "ERR_DB_CONSTRAINT",
            "เกิดข้อผิดพลาดของเงื่อนไขฐานข้อมูล (Unique/Constraint) ข้อมูลนี้อาจจะมีอยู่แล้วในระบบ",
            &err_str,
        );
    }
    if err_str.contains("corrupt") {
        return DiagnosticError::new(
            "ERR_DB_CORRUPTED",
            "ไฟล์ฐานข้อมูลโครงการเสียหาย กรุณาใช้ระบบกู้คืนไฟล์สำรองข้อมูล (Backup Restore)",
            &err_str,
        );
    }

    // 4. ML / Inference errors
    if err_str.contains("OOM") || err_str.contains("out of memory") || err_str.contains("CUDA error") {
        return DiagnosticError::new(
            "ERR_ML_GPU_OOM",
            "หน่วยความจำการ์ดจอ (VRAM) หรือ RAM ไม่เพียงพอสำหรับประมวลผลโมเดล AI กรุณาลองปรับลดขนาดรูปภาพลง",
            &err_str,
        );
    }
    if err_str.contains("model not found") || err_str.contains("weights missing") {
        return DiagnosticError::new(
            "ERR_ML_MODEL_NOT_FOUND",
            "ไม่พบไฟล์โมเดล AI หรือการดาวน์โหลดโมเดลไม่สำเร็จ กรุณาตรวจสอบพื้นที่ว่างดิสก์และความเร็วอินเทอร์เน็ต",
            &err_str,
        );
    }

    // 5. File System errors
    if err_str.contains("disk full") || err_str.contains("No space left on device") {
        return DiagnosticError::new(
            "ERR_FS_DISK_FULL",
            "พื้นที่จัดเก็บข้อมูลบนฮาร์ดดิสก์ของคุณเต็มแล้ว กรุณาเคลียร์พื้นที่เพื่อให้แอปทำงานต่อได้",
            &err_str,
        );
    }
    if err_str.contains("permission denied") || err_str.contains("Access is denied") {
        return DiagnosticError::new(
            "ERR_FS_PERMISSION",
            "ไม่มีสิทธิ์เข้าถึงหรือแก้ไขไฟล์ระบบ กรุณาเปิดแอปในฐานะผู้ดูแลระบบ (Administrator) หรือตรวจสอบสิทธิ์ของโฟลเดอร์",
            &err_str,
        );
    }
    if err_str.contains("not found") || err_str.contains("No such file") {
        return DiagnosticError::new(
            "ERR_FS_NOT_FOUND",
            "ไม่พบไฟล์หรือโฟลเดอร์ที่ระบุในเครื่องของคุณ กรุณาตรวจสอบตำแหน่งไฟล์ใหม่อีกครั้ง",
            &err_str,
        );
    }

    // Default error
    DiagnosticError::new(
        "ERR_SYSTEM_UNKNOWN",
        "เกิดข้อผิดพลาดที่ไม่คาดคิดในการประมวลผลข้อมูลภายในระบบ",
        &err_str,
    )
}

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

