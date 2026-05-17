First public EarthWL/koharu-th release. Detector / OCR engine selection overhaul, new in-app Storage panel for managing cached models, and a Windows uninstaller that offers to clean up its own leftovers.

## Download — pick the file that matches your GPU

| Your GPU | Installer (.exe / NSIS) | Installer (.msi) |
|---|---|---|
| RTX 20xx / Quadro RTX (Turing, compute 7.5) | `koharu_1.1.0_rtx20-turing-setup.exe` | `koharu_1.1.0_rtx20-turing.msi` |
| RTX 30xx / A-series (Ampere, compute 8.6) | `koharu_1.1.0_rtx30-ampere-setup.exe` | `koharu_1.1.0_rtx30-ampere.msi` |
| RTX 40xx (Ada, compute 8.9) | `koharu_1.1.0_rtx40-ada-setup.exe` | `koharu_1.1.0_rtx40-ada.msi` |
| RTX 50xx (Blackwell, compute 12.0) | `koharu_1.1.0_rtx50-blackwell-setup.exe` | `koharu_1.1.0_rtx50-blackwell.msi` |
| AMD / Intel / no GPU | Any installer — pass `--cpu` on launch | (same) |

**Why GPU-specific builds?** `bindgen_cuda` 0.1.6 (transitive via `candle-kernels`) only accepts a single CUDA compute capability per build, and emits `sm_XX`-only without forward-JIT PTX. Mixing arches isn't supported by that toolchain, so v1.1.0 ships one binary per RTX family. v1.2.0 will sync with upstream's PTX-JIT + Vulkan + ZLUDA backend selection to ship a single multi-GPU binary.

**On the wrong build?** The app will start but inference results may be wrong or kernels may fail silently. Uninstall and reinstall the correct one. Your project data lives in user-chosen folders and is not touched.

**Pre-installed NVIDIA driver required** (any recent one — CUDA 13.1 runtime is bundled with the app and extracted to `%LOCALAPPDATA%\Koharu\libs` on first GPU launch).

**`.exe` vs `.msi`** — both install the same app. NSIS `.exe` is friendlier for individual users (shorter prompts, integrates the new "remove cached AI models on uninstall?" cleanup hook). MSI is better for enterprise / silent / GPO deploys.

## What's new in 1.1.0

### Added
- **Anime Text YOLO detector** as opt-in alternative — tuned for anime / manga; catches SFX, stylised titles, out-of-bubble text. 5 size variants N (~10MB) → X (~250MB) lazy-loaded. Settings → Detector.
- **Confidence slider for Anime Text YOLO** (Settings → Detector, 0.05 – 0.95 step 0.05, default 0.25). Reset link appears when off-default.
- **Settings → Storage panel** lists every on-disk artefact koharu manages outside your project folders (CUDA libs, AI model cache, custom fonts, recent-projects list) with size + path + per-row Clear button. Bonus "Preferences → Reset to defaults" row resets all UI prefs without touching project data.
- **Windows NSIS uninstall hook** — on uninstall, the wizard offers to also delete `%LOCALAPPDATA%\Koharu` (cached AI models + CUDA libs, ~1-3 GB). Default = No (re-installing reuses the cache). Four safety belts: refuses if `$LOCALAPPDATA` is empty, requires Koharu marker files before any destructive op, deletes by named subfolder (not parent recursively), final non-recursive parent removal only succeeds if folder is empty. Bounded blast radius — cannot follow a hypothetical parent-level junction the way unguarded `RMDir /r` could.
- **Cloud Vision OCR sends per-bubble crops** instead of one full page + bbox list. Each request part is one image containing exactly one bubble (with 8% context padding) — small models like gemini-2.5-flash-lite can no longer mis-map text between bubbles.

### Fixed
- **Standalone Detect button bypassed the engine preference** — picked Anime YOLO in Settings, button kept running default detector silently. New `DetectPayload` threads the prefs end-to-end.
- **Standalone OCR button bypassed the engine preference** — picked Manga OCR, backend defaulted to MIT-48px regardless, output was single-char garbage on Japanese vertical text. New `OcrPayload` threads the choice through.
- **Cloud Vision OCR misaligned text after the user deleted bubbles** — fixed by the per-bubble crops approach above.

### Tuning
- Anime Text YOLO defaults held at upstream's `confidence=0.25`, `nms=0.50` (NMS bumped 0.45 → 0.50 to merge near-overlapping vertical SFX). Users who hit over-detection raise the new slider to 0.35–0.45.

Full changelog: see [`CHANGELOG.md`](https://github.com/EarthWL/koharu-th/blob/main/CHANGELOG.md).
