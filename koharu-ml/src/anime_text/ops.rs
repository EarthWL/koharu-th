//! Conv helpers — thin pass-through to candle_nn. Upstream's version
//! had ZLUDA-specific workarounds we don't need (we don't ship ZLUDA),
//! so this stays minimal: same signature so the ported `model.rs`
//! compiles unchanged.

use candle_core::Result;
use candle_nn::{Conv2d, Conv2dConfig, VarBuilder};

pub(crate) fn conv2d(
    in_channels: usize,
    out_channels: usize,
    kernel_size: usize,
    cfg: Conv2dConfig,
    vb: VarBuilder,
) -> Result<Conv2d> {
    candle_nn::conv2d(in_channels, out_channels, kernel_size, cfg, vb)
}

pub(crate) fn conv2d_no_bias(
    in_channels: usize,
    out_channels: usize,
    kernel_size: usize,
    cfg: Conv2dConfig,
    vb: VarBuilder,
) -> Result<Conv2d> {
    candle_nn::conv2d_no_bias(in_channels, out_channels, kernel_size, cfg, vb)
}
