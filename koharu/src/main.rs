#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use koharu::app;

fn main() -> anyhow::Result<()> {
    // candle's CUDA conv path is stack-hungry — on the default ~2 MB tokio
    // worker stack it hits STATUS_STACK_OVERFLOW (exit 0xC00000FD) deep
    // inside nvcuda64.dll during GPU inference, which crashes the app the
    // moment the GPU is exercised. `RUST_MIN_STACK` must be set BEFORE any
    // runtime spins up its threads so every std-spawned thread (including
    // Tauri's own async runtime, which we don't build here) inherits the
    // larger default; we ALSO set `thread_stack_size` on the runtime we own
    // so it doesn't depend on env propagation. 64 MB is reserve-only
    // (committed lazily), so the cost is address space, not RAM.
    const BIG_STACK: usize = 64 * 1024 * 1024;
    // SAFETY: called at the very top of `main`, before any threads are
    // spawned, so there is no concurrent access to the environment.
    unsafe {
        std::env::set_var("RUST_MIN_STACK", BIG_STACK.to_string());
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(BIG_STACK)
        .build()?;
    runtime.block_on(app::run())
}
