use std::time::Duration;

use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use once_cell::sync::Lazy;

static PROGRESS_BAR: Lazy<MultiProgress> = Lazy::new(MultiProgress::new);

pub fn progress_bar(filename: &str) -> ProgressBar {
    let pb = PROGRESS_BAR.add(indicatif::ProgressBar::new_spinner());
    pb.enable_steady_tick(Duration::from_millis(120));
    // The template is a compile-time string literal with valid
    // indicatif placeholders, so with_template can't fail at runtime —
    // but fall back to the default style instead of unwrapping to keep
    // the no-panic invariant.
    if let Ok(style) = ProgressStyle::with_template(
        "{msg} [{elapsed_precise}] [{wide_bar}] {bytes}/{total_bytes} ({eta})",
    ) {
        pb.set_style(style);
    }
    pb.set_message(filename.to_string());
    pb
}
