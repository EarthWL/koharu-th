use std::io::Cursor;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, ImageFormat};

pub(crate) fn encode_png_base64(
    img: &DynamicImage,
    max_size: u32,
) -> Result<String, image::ImageError> {
    let img = if img.width().max(img.height()) > max_size {
        img.resize(max_size, max_size, image::imageops::FilterType::Lanczos3)
    } else {
        img.clone()
    };
    let mut buf = Vec::new();
    // PNG encode of an in-memory image rarely fails, but a zero-dim or
    // pathological image can — propagate instead of panicking the MCP
    // server thread.
    img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)?;
    Ok(BASE64.encode(&buf))
}
