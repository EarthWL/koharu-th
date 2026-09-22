//! When does `Renderer::render` fill `Document::rendered`?
//!
//! The v2 `text_renderer` engine always renders the whole page and
//! treats a missing composite as an error, so a full-page render must
//! composite whether or not the page has been inpainted yet.

use image::{DynamicImage, RgbaImage};
use koharu_renderer::facade::Renderer;
use koharu_types::{Document, SerializableDynamicImage, TextBlock, TextShaderEffect};

fn page(with_inpainted: bool) -> Document {
    let img =
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(400, 300, [255, 255, 255, 255].into()));
    Document {
        width: 400,
        height: 300,
        image: SerializableDynamicImage::from(img.clone()),
        inpainted: with_inpainted.then(|| SerializableDynamicImage::from(img)),
        text_blocks: vec![
            TextBlock {
                x: 40.0,
                y: 40.0,
                width: 150.0,
                height: 80.0,
                translation: Some("Hello".into()),
                ..Default::default()
            },
            TextBlock {
                x: 200.0,
                y: 150.0,
                width: 150.0,
                height: 80.0,
                translation: Some("World".into()),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}

fn render(doc: &mut Document, block: Option<usize>) {
    let renderer = Renderer::new().expect("renderer");
    renderer
        .render(doc, block, TextShaderEffect::default(), None, None)
        .expect("render");
}

#[test]
fn full_page_with_inpainted_produces_composite() {
    let mut doc = page(true);
    render(&mut doc, None);
    assert!(doc.rendered.is_some());
}

#[test]
fn full_page_without_inpainted_produces_composite() {
    let mut doc = page(false);
    render(&mut doc, None);
    assert!(
        doc.rendered.is_some(),
        "translate-before-inpaint must still composite"
    );
}
