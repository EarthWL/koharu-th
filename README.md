# Koharu-TH 🚀

[![Version](https://img.shields.io/badge/version-1.2.1-blue.svg)](https://github.com/EarthWL/koharu-th/releases)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Sub-crates: Apache 2.0](https://img.shields.io/badge/sub--crates-Apache--2.0-blue.svg)](LICENSE-APACHE)
[![Forked from](https://img.shields.io/badge/forked%20from-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> **Looking for Thai version?** 👉 [ภาษาไทย](./README.th.md)

**Koharu-TH** is the ultimate AI-powered manga translation and localization studio. Unlike general page-by-page translators, Koharu-TH is a professional-grade translation memory suite designed to manage whole manga series. It automatically remembers your glossary, characters, and translation history to guarantee stylistic consistency across multiple chapters. 

Written in high-performance **Rust** using Hugging Face's [candle](https://github.com/huggingface/candle) for local ML inference, and [Tauri](https://github.com/tauri-apps/tauri) for a gorgeous, glassmorphic desktop GUI.

---

## ⚡ Core Superpowers (Why Koharu-TH?)

If you want a professional tool that works like a translation memory suite (similar to SDL Trados or OmegaT) but built specifically for manga typesetting and translation, **Koharu-TH is your choice.**

*   🗂️ **Series-Level SQLite Workspace**: Organizes your translation into projects. It auto-extracts characters and keeps a central glossary.
*   🧠 **Translation Context (New!)**: Integrates previous page translations and nearby bubble context dynamically so translations flow naturally and never sound disjointed.
*   🤖 **Agentic AI Chat (MCP & Vision)**: A sidebar assistant with full vision capabilities (attach canvas, upload images) and over 60 tools to query and update your project database, pull wiki pages, and check spelling/grammar.
*   ✍️ **Photoshop-Style Typography**: Advanced typography engine with full support for vertical text, rotation, custom letter-spacing (Tracking), line-height (Leading), and auto-bubble-fitting with amber/rose overflow warning badges.
*   📦 **Multi-Chapter CBZ Export**: One-click packaging with Kavita/Komga-compatible `ComicInfo.xml` metadata sidecars.
*   🔒 **Enterprise-Grade Infrastructure**: Thread-safe global scratchpad database fallbacks, atomic file writes to prevent project corruption, system memory FFI diagnostics, and V8-level memory zeroization for API key security.

---

## 🔄 Upstream vs. Koharu-TH

*Koharu-TH* is a divergent fork of **mayocream/koharu 0.37.0**. While upstream focuses on general-purpose single-page translation speed, this fork focuses on **series localization continuity**.

| Feature | Upstream (0.59.x) | Koharu-TH (1.2.1) |
| :--- | :--- | :--- |
| **Project Model** | Open individual files / `.khr` | **Folder-based Series Project** with SQLite database |
| **Workflow Scope** | Page-by-page translation | **Multi-chapter rolling context** with automated chapter summaries |
| **Translation Memory** | None | **Exact, Jaccard, and Semantic Vector Search** + TMX 1.4 import/export |
| **Glossary & Characters** | None | **Per-series DB**, automatically injected into LLM translation prompts |
| **AI Assistant** | Custom prompt editor | **Agentic AI Chat (Vision + 60 MCP Tools + 10 Slash Commands)** |
| **Typography Control** | System font weights/styles | **Thai-aware fonts, rotation, Leading (A/A), Tracking (VA), overflow warning** |
| **Export Formats** | Single-page rendered, layered PSD | **CBZ archive (multi-chapter)** with `ComicInfo.xml` |
| **Cost Tracking** | None | **Live cost dashboard** (breaks down spend by model, chapter, and day) |
| **Infrastructure** | llama.cpp local runner, Sentry telemetry | **Weak ETags cache-control, atomic file writes, system memory FFI** |

---

## ✨ Deep-Dive Features

### 🗂️ Series Project Workspace
Every manga series gets its own dedicated folder containing a SQLite database (`series.db`). This database ties together all assets, characters, and translations.

```
MyMangaProject/
├── series.koharuproj          # Project manifest file (JSON)
├── series.db                  # SQLite database (contains glossary, characters, TM, logs)
└── chapters/
    ├── ch01/
    │   ├── source/            # Original Japanese/raw images
    │   └── render/            # Final typeset/translated images
    └── ch02/...
```

### 🧠 Translation Context (New!)
No more broken dialogues! When translating a bubble or page, Koharu-TH automatically pulls translations from previous bubbles and the previous page to build a contextual history. This is supported natively in both the **Local LLM pipeline** and **Cloud LLMs** (batch & single-block modes).

### 🤖 Vision-Enabled Agentic AI Chat
The sidebar AI Chat is powered by native function-calling. It can interact with the app's database to update characters, glossary terms, or read the current canvas.
*   **Vision Support**: Capture the current canvas view or upload reference images.
*   **Slash Commands**:
    *   `/fetch-wiki <url>`: Automatically scrape a wiki page to propose glossary & character entries.
    *   `/qc-consistency`: Analyze the active chapter to check if translations drift from the glossary.
    *   `/check-thai`: Review Thai output for spelling, grammar, and natural tone.
    *   `/tm-semantic <text>`: Semantic translation memory lookup via embeddings.

### 🎨 Pixel-Perfect Rendering & Typography
Fine-tune typesetting with Photoshop-level precision directly in the sidebar:
*   **Controls**: Adjustable line-height (Leading), letter-spacing (Tracking), vertical alignment, and rotation angle.
*   **Bubble Fit**: Snap bboxes to bubble silhouettes using flood-fill bounds. Displays amber `TIGHT` and red `OVERFLOW` warning badges if text is likely to clip.
*   **Font Favorites**: Pin your frequently used fonts to the top of the dropdown for fast access.

---

## 📥 Installation

Koharu-TH is compiled from source to optimize for your specific GPU architecture. 

### 1. Prerequisites
Ensure you have the following installed:
*   [Rust Compiler](https://www.rust-lang.org/tools/install) (version 1.92 or later)
*   [Bun Runtime](https://bun.sh/) (version 1.0 or later)

### 2. Clone and Install
```bash
git clone https://github.com/EarthWL/koharu-th.git
cd koharu-th
bun install
```

### 3. Build & Run
To run the developer server with hot-rebuild (HMR):
```bash
bun run dev
```
To compile the production release binary:
```bash
bun run build
```
The compiled binary will be located in `target/release/`.

---

## ⚡ GPU Acceleration & Performance

Koharu-TH leverages GPU acceleration for high-speed local OCR, text detection, and inpainting.

### NVIDIA CUDA
*   Bundled with CUDA Toolkit 12.1 and cuDNN 9.x dependencies.
*   Required: NVIDIA GPUs with compute capability **7.5 or higher** (Turing, Ampere, Ada Lovelace, Blackwell).
*   *Note: Ensure your GPU drivers are updated via the NVIDIA App.*

### Apple Silicon Metal
*   Supported natively on macOS with Apple Silicon (M1, M2, M3 series).

### CPU Fallback
If you do not have a supported GPU, you can force CPU execution:
```bash
koharu --cpu
```

---

## 🛠️ Usage Tips

*   **Command Palette**: Press <kbd>Ctrl</kbd> + <kbd>K</kbd> (or <kbd>Cmd</kbd> + <kbd>K</kbd>) to instantly jump to chapters, change LLM profiles, or run AI Chat commands.
*   **Navigation**: Use <kbd>Ctrl</kbd> + Mouse Wheel to zoom, and <kbd>Ctrl</kbd> + Drag to pan across the manga page canvas.
*   **Custom Fonts**: Place any `.ttf` / `.otf` / `.ttc` files into the bundled fonts folder (`<app-data>/Koharu/fonts/`) to register them instantly.
*   **Double-click Open**: On Windows, `.khr` files are automatically associated with Koharu-TH. Double-click any file to open it instantly.

---

## 🗺️ Roadmap & Current Status

*   **Shipped (1.2.x)**: Closed cross-project cache leaks, automated system memory diagnostics, dynamic precision quantization, recursive XY-Cut reading order sorting, and WebSocket-bypass WebP streaming.
*   **Planned (1.3.x)**: CUDA PTX-JIT integration (one binary for all RTX GPUs), Vulkan cross-vendor GPU acceleration, and opt-in modern OCR/Inpaint backports from upstream.

---

## 📜 Credits & License

Koharu-TH is built on top of [mayocream/koharu](https://github.com/mayocream/koharu). All original ML pipelines and core renderer layouts belong to the upstream maintainer. If you enjoy this project, consider supporting upstream:
*   [GitHub Sponsors](https://github.com/sponsors/mayocream)
*   [Patreon](https://www.patreon.com/mayocream)

**License**: GPL-3.0 (for the application) and Apache-2.0 (for sub-crates).
