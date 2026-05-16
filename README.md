# Koharu-TH

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Upstream](https://img.shields.io/badge/upstream-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [ภาษาไทย](./README.th.md)
>
> Personal fork of [mayocream/koharu](https://github.com/mayocream/koharu) — adds **Cloud LLM translation**, **Thai font/layout support**, and **text-block rotation** on top of upstream 0.37.0.

ML-powered manga translator, written in **Rust**.

Koharu introduces a new workflow for manga translation, utilizing the power of ML to automate the process. It combines the capabilities of object detection, OCR, inpainting, and LLMs to create a seamless translation experience.

Under the hood, Koharu uses [candle](https://github.com/huggingface/candle) for high-performance inference, and uses [Tauri](https://github.com/tauri-apps/tauri) for the GUI. All components are written in Rust, ensuring safety and speed.

> [!NOTE]
> Koharu runs ML models **locally** by default. If you opt into a cloud LLM provider (OpenAI / Gemini / Anthropic / OpenAI-compatible), the text you translate is sent to that provider — everything else still runs locally. Cloud usage is opt-in via Settings.

---

![screenshot](assets/koharu-screenshot-en.png)

## What's different in this fork

This fork extends upstream 0.37.0 with three additions aimed at Thai-language output and external-API workflows:

- **☁️  Cloud LLM translation** — translate via OpenAI (or any OpenAI-compatible endpoint such as OpenRouter or a local server), Google Gemini, or Anthropic Claude, as an alternative to the bundled local LLMs. Supports per-block translation and batched JSON mode for whole pages. Falls back to the local LLM when no provider is configured.
- **🇹🇭 Thai script support** in the text renderer — Thai-aware font fallback (Leelawadee UI / Tahoma / Noto Sans Thai depending on OS) so Thai glyphs render correctly in speech bubbles. Default cloud target language is Thai.
- **🔄 Text-block rotation** — `rotation_deg` plumbed end-to-end (API → pipeline → renderer → UI) so text blocks can be angled to fit non-rectangular bubbles or stylised SFX.

Configure cloud providers under **Settings → Cloud AI**. Leave the provider set to *None* to keep using the bundled local LLMs.

## Features

- Automatic speech bubble detection and segmentation
- OCR for manga text recognition
- Inpainting to remove original text from images
- LLM-powered translation (local **and** cloud — *fork addition*)
- Vertical text layout for CJK languages
- Thai-aware font fallback (*fork addition*)
- Rotatable text blocks (*fork addition*)
- MCP server for AI agents

## Usage

### Hot keys

- <kbd>Ctrl</kbd> + Mouse Wheel: Zoom in/out
- <kbd>Ctrl</kbd> + Drag: Pan the canvas
- <kbd>Del</kbd>: Delete selected text block

### Cloud AI translation

Open **Settings → Cloud AI** and pick a provider:

| Provider | What you enter |
|---|---|
| **OpenAI** (or compatible) | API Key · Model name (e.g. `gpt-4o`, `gpt-4o-mini`) · Base URL (default `https://api.openai.com/v1`; switch to Together, a local llama.cpp / vLLM server, etc.) |
| **OpenRouter** | API Key only — model list is fetched live from OpenRouter and presented as a searchable picker (with pricing + context-length shown per model) |
| **Google Gemini** | API Key · Model name (e.g. `gemini-2.5-pro`, `gemini-2.5-flash`) |
| **Anthropic Claude** | API Key · Model name (e.g. `claude-3-5-sonnet`, `claude-opus-4-5`) |

After configuring, the LLM translate button uses the cloud provider instead of the local model. Set provider back to *None* to revert to local.

> [!NOTE]
> Anthropic's API blocks browser-origin calls by default. This fork sends `anthropic-dangerous-direct-browser-access: true` to work inside the Tauri webview. In pure headless / web mode against a browser, CORS may block the request — use OpenAI-compatible or Gemini in that case.

### MCP Server

Koharu has a built-in MCP server that can be used to integrate with AI agents. By default, the MCP server listens on a random port, but you can specify the port using the `--port` flag.

```bash
# macOS / Linux
koharu --port 9999
# Windows
koharu.exe --port 9999
```

Point your AI agent at `http://localhost:9999/mcp`.

### Headless Mode

Koharu can be run in headless mode via command line.

```bash
# macOS / Linux
koharu --port 4000 --headless
# Windows
koharu.exe --port 4000 --headless
```

Then open the Koharu Web UI at `http://localhost:4000`.

### File association

On Windows, Koharu automatically associates `.khr` files, so you can open them by double-clicking. `.khr` files can also be opened as pictures to view the thumbnails of the contained images.

### Bundled fonts

Koharu-TH creates `<app-data>/Koharu/fonts/` on first launch (Windows: `%LOCALAPPDATA%\Koharu\fonts`, macOS: `~/Library/Application Support/Koharu/fonts`, Linux: `~/.local/share/Koharu/fonts`). Drop any `.ttf` / `.otf` / `.ttc` file there and it's registered alongside system fonts on next launch. Useful for shipping Thai (e.g. [Noto Sans Thai](https://fonts.google.com/noto/specimen/Noto+Sans+Thai)) or specialty manga fonts to machines that don't have them installed system-wide.

## GPU acceleration

CUDA and Metal are supported for GPU acceleration, significantly improving performance on supported hardware.

### CUDA

Koharu bundles CUDA toolkit 13.1 and cuDNN 9.19; dylibs are automatically extracted to the application data directory on first run.

> [!NOTE]
> Make sure your system has the latest NVIDIA drivers installed via the [NVIDIA App](https://www.nvidia.com/en-us/software/nvidia-app/).

Supported: NVIDIA GPUs with compute capability **7.5 or higher**. Check the [CUDA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus) and the [cuDNN Support Matrix](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/support-matrix.html).

### Metal

Metal-based GPU acceleration is supported on macOS with Apple Silicon (M1, M2, etc.).

### CPU fallback

Force CPU inference:

```bash
# macOS / Linux
koharu --cpu
# Windows
koharu.exe --cpu
```

## ML Models

### Computer Vision Models

- [comic-text-detector](https://github.com/dmMaze/comic-text-detector)
- [manga-ocr](https://github.com/kha-white/manga-ocr)
- [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting)
- [YuzuMarker.FontDetection](https://github.com/JeffersonQin/YuzuMarker.FontDetection)

Models are downloaded automatically on first run. Converted safetensors weights are hosted on [Hugging Face](https://huggingface.co/mayocream).

### Local Large Language Models

Koharu supports various quantized LLMs in GGUF format via [candle](https://github.com/huggingface/candle), and preselects a model based on system locale.

For translating to **English**:

- [vntl-llama3-8b-v2](https://huggingface.co/lmg-anon/vntl-llama3-8b-v2-gguf) — ~8.5 GB Q8_0, needs ≥10 GB VRAM (or plenty of RAM for CPU); best when accuracy matters.
- [lfm2-350m-enjp-mt](https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT-GGUF) — ultra-light (~350M, Q8_0); runs on CPU and low-memory GPUs.

For translating to **Chinese**:

- [sakura-galtransl-7b-v3.7](https://huggingface.co/SakuraLLM/Sakura-GalTransl-7B-v3.7) — ~6.3 GB, fits on 8 GB VRAM.
- [sakura-1.5b-qwen2.5-v1.0](https://huggingface.co/shing3232/Sakura-1.5B-Qwen2.5-v1.0-GGUF-IMX) — lightweight (~1.5B, Q5KS) for 4–6 GB GPUs / CPU.

For **other languages** (including Thai):

- [hunyuan-7b-mt-v1.0](https://huggingface.co/Mungert/Hunyuan-MT-7B-GGUF) — ~6.3 GB on 8 GB VRAM, decent multi-language quality.
- Or use a **cloud provider** (see [Cloud AI translation](#cloud-ai-translation)) — recommended for Thai output if local 7B/8B models give weak results.

LLMs are downloaded on demand when selected in Settings.

## Installation

This fork does not ship pre-built binaries — build from source (see below), or use an upstream release from [mayocream/koharu releases](https://github.com/mayocream/koharu/releases/latest) if you don't need the fork-specific features.

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (1.92 or later)
- [Bun](https://bun.sh/) (1.0 or later)

### Install dependencies

```bash
bun install
```

### Build

```bash
bun run build
```

Built binaries land in `target/release`.

### Syncing with upstream

```bash
git fetch upstream
git diff upstream/main         # see what's diverged
git merge upstream/main        # or rebase, your call
```

## Roadmap

Not promises — just things I'm considering as I keep iterating on this fork.

- [x] Bundle a Thai font (e.g. Noto Sans Thai) with the app so rendering works on machines without a local Thai font — *drop the .ttf into the app's `fonts/` data dir (see [Bundled fonts](#bundled-fonts))*
- [ ] Streaming responses from cloud providers for faster perceived translation
- [ ] Per-document glossary / term consistency across pages
- [ ] Translation memory / caching to avoid re-translating identical text
- [ ] Custom prompt template per document (genre, character names, formality)
- [ ] More cloud providers (xAI Grok, Mistral, DeepSeek)
- [ ] Proper i18n keys for the Cloud AI settings UI (currently English fallback strings)
- [ ] OCR support for Thai source text (current OCR is JP-only)
- [ ] Vertical layout polish for Thai when bubbles are very tall and narrow

## Known limitations

- **Anthropic in pure-browser headless mode** — see the note in [Cloud AI translation](#cloud-ai-translation). CORS will block direct calls; works fine inside the Tauri desktop build.
- **OpenAI JSON mode detection** is currently gated by a `model.includes('gpt')` check. Newer OpenAI models (`o3`, `o4`, etc.) and most OpenRouter-routed models skip JSON mode and may occasionally return text that needs lenient parsing — handled, but quality varies by model.
- **Thai font fallback** depends on the OS having one of the listed fonts installed (Leelawadee UI / Tahoma on Windows · Thonburi / Krungthep on macOS · Noto Sans Thai on Linux). If none are present, the renderer falls back to default and may show tofu.
- **No translation streaming** yet — translations appear when the cloud request fully completes.
- **No glossary / cross-page consistency** — each block (or each batch) is translated independently; character names and terminology can drift across pages.

## Credits

This fork is built on top of [mayocream/koharu](https://github.com/mayocream/koharu) and its contributors. All original ML pipeline, Tauri shell, and renderer work is theirs — please consider supporting the upstream project:

- [GitHub Sponsors](https://github.com/sponsors/mayocream)
- [Patreon](https://www.patreon.com/mayocream)

<a href="https://github.com/mayocream/koharu/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=mayocream/koharu" />
</a>

## License

Koharu application is licensed under the [GNU General Public License v3.0](LICENSE-GPL). This fork inherits the same license.

The sub-crates of Koharu are licensed under the [Apache License 2.0](LICENSE-APACHE).
