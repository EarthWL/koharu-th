use image::{ColorType, codecs::webp::WebPEncoder};
use koharu_core::BlobStore;
use koharu_types::{Document, SerializableDynamicImage, TextBlock};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub has_segment: bool,
    pub has_inpainted: bool,
    pub has_rendered: bool,
    pub text_blocks: Vec<TextBlockInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlockInfo {
    pub index: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub confidence: f32,
    pub text: Option<String>,
    pub translation: Option<String>,
    pub direction: Option<String>,
    pub font_size_px: Option<f32>,
    pub text_color: Option<[u8; 3]>,
    pub style: Option<TextStyleInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyleInfo {
    pub font_families: Vec<String>,
    pub font_size: Option<f32>,
    pub color: [u8; 4],
    pub effect: Option<String>,
    pub stroke: Option<TextStrokeInfo>,
    pub text_align: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStrokeInfo {
    pub enabled: bool,
    pub color: [u8; 4],
    pub width_px: Option<f32>,
}

pub fn to_block_info(i: usize, block: &TextBlock) -> TextBlockInfo {
    TextBlockInfo {
        index: i,
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        confidence: block.confidence,
        text: block.text.clone(),
        translation: block.translation.clone(),
        direction: block
            .font_prediction
            .as_ref()
            .map(|fp| format!("{:?}", fp.direction)),
        font_size_px: block.font_prediction.as_ref().map(|fp| fp.font_size_px),
        text_color: block.font_prediction.as_ref().map(|fp| fp.text_color),
        style: block.style.as_ref().map(|s| TextStyleInfo {
            font_families: s.font_families.clone(),
            font_size: s.font_size,
            color: s.color,
            effect: s.effect.map(|e| e.to_string()),
            stroke: s.stroke.as_ref().map(|stroke| TextStrokeInfo {
                enabled: stroke.enabled,
                color: stroke.color,
                width_px: stroke.width_px,
            }),
            text_align: s.text_align.map(|align| format!("{align:?}")),
        }),
    }
}

pub fn to_doc_info(doc: &Document) -> DocumentInfo {
    DocumentInfo {
        name: doc.name.clone(),
        width: doc.width,
        height: doc.height,
        has_segment: doc.segment.is_some(),
        has_inpainted: doc.inpainted.is_some(),
        has_rendered: doc.rendered.is_some(),
        text_blocks: doc
            .text_blocks
            .iter()
            .enumerate()
            .map(|(i, block)| to_block_info(i, block))
            .collect(),
    }
}

// ────────────────────────────────────────────────────────────────────
// DocumentDto — v2 blob-transport boundary
//
// `koharu_types::Document` keeps the in-memory `DynamicImage` so
// engines have pixel access. Sending that over the WS RPC pipe
// msgpack-encodes the WebP-lossless bytes per fetch — 2-5 MB per
// page, hot path during navigation. Phase 2 moves binaries to the
// `/blob/:hex` HTTP route (zero-copy `Bytes` response, browser
// caches via content-addressed immutable URL). `DocumentDto` is the
// shape that traverses the wire instead: same scalars + text blocks
// as `Document`, but each binary field is the hex `BlobId` of bytes
// the backend has already pushed into the `BlobStore`.
//
// The frontend renders by setting `<img src="/blob/{hex}">`; browser
// fetches once, caches forever (URL is content hash so it's
// immutable by construction), and uses its native GPU-accelerated
// decoder rather than JS-side `URL.createObjectURL` on a Uint8Array.
// ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDto {
    pub id: String,
    pub path: std::path::PathBuf,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Hex blake3 of the WebP-lossless-encoded page image. Fetch via
    /// `GET /blob/<hex>`. Always present (every page has a source
    /// image).
    pub image: String,
    pub text_blocks: Vec<TextBlock>,
    /// Hex blob id for the segmentation mask. `None` = stage not run.
    pub segment: Option<String>,
    pub inpainted: Option<String>,
    pub rendered: Option<String>,
    pub brush_layer: Option<String>,
}

/// Re-encode a single image into WebP-lossless bytes and push it
/// into the BlobStore. Returns the hex BlobId the frontend can
/// use as a URL fragment.
///
/// Same encoding as `SerializableDynamicImage::serialize` — lossless
/// WebP. Matters for content-addressed dedup: if a stage emits the
/// same pixels twice across runs, both hash to the same id and the
/// browser's cached fetch is reused.
fn register_image(blobs: &BlobStore, img: &SerializableDynamicImage) -> anyhow::Result<String> {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let raw = rgba.into_raw();

    let mut buf = Vec::new();
    let enc = WebPEncoder::new_lossless(&mut buf);
    enc.encode(&raw, width, height, ColorType::Rgba8.into())?;

    let id = blobs.put(buf);
    Ok(id.to_hex())
}

/// Convert a backend `Document` into the wire-friendly `DocumentDto`.
/// Encodes + registers all 5 binary fields with the `BlobStore` and
/// hands out hex BlobIds. The backend keeps the in-memory
/// `DynamicImage` separately for engine pixel access — this DTO is
/// purely the RPC return shape.
pub fn to_doc_dto(doc: &Document, blobs: &BlobStore) -> anyhow::Result<DocumentDto> {
    Ok(DocumentDto {
        id: doc.id.clone(),
        path: doc.path.clone(),
        name: doc.name.clone(),
        width: doc.width,
        height: doc.height,
        image: register_image(blobs, &doc.image)?,
        text_blocks: doc.text_blocks.clone(),
        segment: doc
            .segment
            .as_ref()
            .map(|img| register_image(blobs, img))
            .transpose()?,
        inpainted: doc
            .inpainted
            .as_ref()
            .map(|img| register_image(blobs, img))
            .transpose()?,
        rendered: doc
            .rendered
            .as_ref()
            .map(|img| register_image(blobs, img))
            .transpose()?,
        brush_layer: doc
            .brush_layer
            .as_ref()
            .map(|img| register_image(blobs, img))
            .transpose()?,
    })
}
