//! Concrete engine implementations.
//!
//! Lives in `koharu-pipeline` (not `koharu-engines`) because each
//! engine needs the heavy backend primitives (ML facade, renderer,
//! project store) that pipeline already pulls in. Keeping the
//! engines-crate light to types-and-trait scaffolding only.
//!
//! ## Linker note
//!
//! Each engine `submit!`s its `EngineInfo` to the inventory at link
//! time. For inventory's submission to actually be visible to the
//! driver at runtime, this `engines` module must be *reachable* from
//! the final binary's link unit — `inventory` relies on linker
//! retention of the submission symbol, and on some platforms
//! (Windows MSVC + lib-only crate) a fully-orphan module gets dead-
//! stripped before reaching the binary.
//!
//! We avoid that by `pub use`-ing one symbol from each engine module
//! into the parent module — the `pub use` is a real symbol reference
//! that keeps the entire module alive through dead-code elimination.
//! The final binary links koharu-pipeline so the chain holds.

pub mod comic_text_detector;
pub mod lama_inpaint;
pub mod manga_ocr;
pub mod mit48px_ocr;

// Keep submissions retained — see module docstring. Adding a real
// `pub use` of one symbol per engine makes the module reachable from
// the binary's link unit and stops `inventory::submit!` from being
// dead-stripped on Windows MSVC.
pub use comic_text_detector::ENGINE_ID as COMIC_TEXT_DETECTOR_ID;
pub use lama_inpaint::ENGINE_ID as LAMA_INPAINT_ID;
pub use manga_ocr::ENGINE_ID as MANGA_OCR_ID;
pub use mit48px_ocr::ENGINE_ID as MIT48PX_OCR_ID;
