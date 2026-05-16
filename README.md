# Koharu-TH

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Upstream](https://img.shields.io/badge/upstream-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [ภาษาไทย](./README.th.md)
>
> Personal fork of [mayocream/koharu](https://github.com/mayocream/koharu). What started as a Thai-language patch has grown into a **series translation studio** — per-project SQLite for characters / glossary / translation memory / prompt templates / cost log, a 5-provider LLM profile system, an agentic AI Chat that can populate project data from a wiki URL, and a ~60-tool MCP server for external agents.

ML-powered manga translation studio, written in **Rust**.

Under the hood, Koharu uses [candle](https://github.com/huggingface/candle) for high-performance ML inference and [Tauri](https://github.com/tauri-apps/tauri) for the desktop GUI. All native components are written in Rust.

> [!NOTE]
> Koharu runs ML models **locally** by default. If you save and apply a Cloud LLM Profile (OpenAI / Claude / Gemini / OpenRouter / Local LLM server), the text you translate is sent to that provider — everything else still runs locally. Cloud usage is opt-in via the Profiles sidebar tab.

---

![screenshot](assets/koharu-screenshot-en.png)

## What's different in this fork

| Area | Upstream | Koharu-TH |
|---|---|---|
| Workflow | Open `.khr` → detect → OCR → inpaint → translate → render | **Open Project → Chapter (folder w/ source+render) → translate with full series context → log cost → TM** |
| State | In-memory + .khr files | + per-project SQLite (`series.db`) with 11 tables |
| LLM | Local 7B GGUF only | Local + **5 cloud profile types** (OpenAI / Claude / Gemini / OpenRouter / Local LLM server) with live model search |
| Sidebar | Page thumbnails | **8 tabs**: Pages · Chapters · Project · Characters · Glossary · Prompts · Profiles · AI Chat |
| Renderer | CJK fonts | + Thai-aware fonts + text-block rotation + line-height / letter-spacing / vertical-align / min-font-size controls |
| MCP server | 25 tools | **~60 tools** covering full project surface + agentic web fetch |
| AI assistant | — | **In-app AI Chat** with native function-calling, 7 slash commands, drives the same tools as MCP |

## Features

### Series Project (per-folder workspace)

Each translated work is a **project folder** with its own SQLite database. The translation prompt assembles context from this database every time, so character names, attack names, honorifics, and tone stay consistent across chapters.

```
MyManga/
├── series.koharuproj          # manifest (small JSON)
├── series.db                  # SQLite — characters, glossary, TM, prompts, profiles, cost log, chat
├── chapters/
│   ├── ch01/
│   │   ├── source/            # imported raws (.png / .jpg / .khr)
│   │   └── render/            # final rendered output
│   └── ch02/...
└── reference/  assets/  export/
```

Open the **Welcome screen** (auto on launch) → **New Project** → fill in series metadata → create chapters → import page images → translate. Or **Open** an existing project.

### Cloud LLM Profiles

All LLM provider config lives in the **Profiles sidebar tab** (not Settings). Save many profiles, switch between them with one click.

| Provider tile | Model list | Notes |
|---|---|---|
| **OpenAI** | live `/v1/models`, chat-only filter | Edit base URL for OpenAI-compatible servers (Together, DeepSeek, vLLM, …) |
| **Claude** | live `/v1/models` (anthropic-version + dangerous-direct-browser-access) | claude-3.5 / 4 / 4.5 series |
| **Gemini** | live `/v1beta/models`, filtered to `generateContent` | shows token limits |
| **OpenRouter** | live `/v1/models`, browseable without key | shows pricing + context length per model |
| **Local LLM** | `/api/tags` (Ollama) or `/v1/models` (LM Studio / llama.cpp) | no key needed, auto-detects from URL suffix |

Every model picker is searchable — type any part of the model id. API keys live in the **OS keyring** (not in the DB).

The Toolbar **LLM badge** lets you pick which saved profile is active without leaving the canvas.

### AI Chat (agentic)

A sidebar tab that talks to your **active profile** using native function-calling on all 4 cloud providers. It has tools for every project entity (series_meta / chapters / characters / glossary / TM / prompt_render) plus a server-side `web_fetch_url` that bypasses browser CORS.

**Slash commands** (autocomplete on `/`):
- `/fetch-wiki <url>` — pull a Fandom/wiki page, propose updates to synopsis + characters + glossary
- `/draft-synopsis`, `/draft-style-notes` — brainstorm context fields
- `/suggest-character <name>` — propose Thai name / speech style / role
- `/extract-glossary <text>` — pull terms from a chunk of source text
- `/summarize-chapter [id]` — generate the chapter summary (feeds rolling context)
- `/preview-prompt <text>` — show the actual prompt your translation will see

Chat history is stored per project in `series.db` (`chat_messages` table); the panel displays the last 50 messages and pages back through history.

### Prompt template engine

Translate prompts are **Handlebars templates** rendered at call time with:

- `{{series_title}}`, `{{series_synopsis}}`, `{{genre}}`, `{{target_audience}}`
- `{{tone}}`, `{{formality}}`, `{{style_notes}}`
- `{{source_language}}` → `{{target_language}}`
- `{{characters}}` — main cast (aliases, speech style, role)
- `{{glossary_entries}}` — **smart-filtered** to terms that appear in the current source text
- `{{rolling_summary}}` — auto-fetched summaries of the previous N chapters (default 2)
- `{{source}}` — the text block being translated

Edit templates from the **Prompts tab**. Default templates ship for `translate`, `extract_entities`, and `summarize_chapter` use cases.

### Translation memory + cost log

- Exact-match and **Jaccard fuzzy** TM lookup (threshold configurable, default 0.85)
- Hit on TM short-circuits the cloud call entirely
- Every LLM call is logged in `llm_call_log` with token counts, duration, success, and estimated USD cost — `llmCostStats` aggregates for dashboards (UI dashboard pending)

### Thai-specific renderer additions

- Thai-aware font fallback (Leelawadee UI / Tahoma / Thonburi / Noto Sans Thai depending on OS)
- Per-block controls: **line-height**, **letter-spacing**, **min font size** (auto-fit floor), **vertical-align**, **manual font size**, **Thai preset** button
- **Text-block rotation** (`rotation_deg`) for non-rectangular bubbles and stylised SFX

### MCP server (for external agents)

~60 tools exposed at `/mcp` covering the full project surface — project lifecycle, chapters, characters, glossary, prompt rendering, translation memory, provider profiles, LLM cost log, plus the agentic `web_fetch_url`. External agents (Claude Desktop, Cursor, etc.) can drive a full **Project → Chapters → Glossary → Translate → TM** workflow without the GUI.

```bash
koharu --port 9999       # macOS / Linux
koharu.exe --port 9999   # Windows
```

Point your MCP-capable client at `http://localhost:9999/mcp`.

## Usage

### Hot keys

- <kbd>Ctrl</kbd> + Mouse Wheel: Zoom in/out
- <kbd>Ctrl</kbd> + Drag: Pan the canvas
- <kbd>Del</kbd>: Delete selected text block

### Headless mode

```bash
koharu --port 4000 --headless        # macOS / Linux
koharu.exe --port 4000 --headless    # Windows
```

Web UI at `http://localhost:4000`. MCP server still served at `/mcp`.

### File association

On Windows, `.khr` files auto-associate with Koharu — double-click to open in standalone mode (no project required).

### Bundled fonts

Koharu-TH creates `<app-data>/Koharu/fonts/` on first launch (Windows: `%LOCALAPPDATA%\Koharu\fonts`, macOS: `~/Library/Application Support/Koharu/fonts`, Linux: `~/.local/share/Koharu/fonts`). Drop any `.ttf` / `.otf` / `.ttc` file there and it's registered alongside system fonts on next launch. Useful for Thai (e.g. [Noto Sans Thai](https://fonts.google.com/noto/specimen/Noto+Sans+Thai)) or specialty manga fonts.

## GPU acceleration

CUDA and Metal are supported.

### CUDA

Koharu bundles CUDA toolkit 13.1 and cuDNN 9.19; dylibs are auto-extracted to the application data directory on first run.

> [!NOTE]
> Make sure your system has the latest NVIDIA drivers installed via the [NVIDIA App](https://www.nvidia.com/en-us/software/nvidia-app/).

Supported: NVIDIA GPUs with compute capability **7.5 or higher**. Check the [CUDA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus) and the [cuDNN Support Matrix](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/support-matrix.html).

### Metal

Metal-based GPU acceleration is supported on macOS with Apple Silicon (M1, M2, etc.).

### CPU fallback

Force CPU inference:

```bash
koharu --cpu       # macOS / Linux
koharu.exe --cpu   # Windows
```

## ML Models

### Computer Vision Models

- [comic-text-detector](https://github.com/dmMaze/comic-text-detector)
- [manga-ocr](https://github.com/kha-white/manga-ocr)
- [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting)
- [YuzuMarker.FontDetection](https://github.com/JeffersonQin/YuzuMarker.FontDetection)

Models are downloaded automatically on first run. Converted safetensors weights are hosted on [Hugging Face](https://huggingface.co/mayocream).

### Local Large Language Models

Koharu supports various quantized LLMs in GGUF format via [candle](https://github.com/huggingface/candle), preselected by system locale.

For **English**:

- [vntl-llama3-8b-v2](https://huggingface.co/lmg-anon/vntl-llama3-8b-v2-gguf) — ~8.5 GB Q8_0, needs ≥10 GB VRAM; best when accuracy matters
- [lfm2-350m-enjp-mt](https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT-GGUF) — ultra-light (~350M Q8_0); runs on CPU / low-memory GPUs

For **Chinese**:

- [sakura-galtransl-7b-v3.7](https://huggingface.co/SakuraLLM/Sakura-GalTransl-7B-v3.7) — ~6.3 GB, fits on 8 GB VRAM
- [sakura-1.5b-qwen2.5-v1.0](https://huggingface.co/shing3232/Sakura-1.5B-Qwen2.5-v1.0-GGUF-IMX) — ~1.5B Q5KS for 4–6 GB GPUs / CPU

For **Thai** and other languages:

- [hunyuan-7b-mt-v1.0](https://huggingface.co/Mungert/Hunyuan-MT-7B-GGUF) — ~6.3 GB on 8 GB VRAM
- Or save a **Cloud Profile** (Profiles sidebar tab) — recommended for Thai output, since local 7B/8B models tend to be weaker on Thai than on CJK

LLMs are downloaded on demand when selected.

## Installation

This fork does not ship pre-built binaries — build from source (below). Or use an upstream release from [mayocream/koharu releases](https://github.com/mayocream/koharu/releases/latest) if you don't need the series-project / AI chat / multi-profile features.

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

### Dev loop

```bash
bun run dev    # Tauri dev with auto-rebuild on Rust + Next HMR on UI
```

### Tests

```bash
cargo test -p koharu-project -p koharu-api
```

### Syncing with upstream

```bash
git fetch upstream
git diff upstream/main         # see what's diverged (it's a lot now)
```

Direct rebase against upstream gets messy because of the project-folder + sidebar tabs restructuring — prefer cherry-picking specific upstream commits.

## Roadmap

Not promises — just things being considered as the fork keeps iterating. See [memory/roadmap_next_features.md](https://github.com/EarthWL/koharu-th) for the full tiered backlog (private).

**Tier 1 (recommended next):**

- [ ] Vision in AI Chat — attach the current page so the model can see actual bubbles + glyphs
- [ ] Streaming chat responses (token-by-token + stop button)
- [ ] Batch chapter translation queue (background, progress UI)

**Tier 2:**

- [ ] Cost dashboard (log data exists, UI pending)
- [ ] QC consistency checker (AI scans a chapter against glossary)
- [ ] Thai bubble-fit warnings (Thai often 1.5–2× source length)
- [ ] Auto-extract characters + glossary on first chapter import

**Tier 3:**

- [ ] Cmd+K command palette
- [ ] Vector-embedding TM (semantic search beyond fuzzy)
- [ ] TMX import/export (CAT-tool interchange)
- [ ] Multi-chapter export to CBZ / PDF (`<chapter>/render/` is ready)
- [ ] Thai spell / grammar check on output

**Already shipped (was on roadmap earlier):**

- [x] Series project format + glossary + TM + custom prompt templates
- [x] OpenRouter + Local LLM support
- [x] Cost tracking (storage + stats; UI pending)
- [x] Bundled-font support for Thai
- [x] Rolling-context summaries from previous chapters

## Known limitations

- **Anthropic in pure-browser headless mode** — CORS will block direct calls in a plain browser; the desktop Tauri build adds `anthropic-dangerous-direct-browser-access: true` and works fine.
- **OpenAI JSON mode** is gated by a `model.includes('gpt')` check. Newer OpenAI models (`o3`, `o4`) and most OpenRouter-routed models skip JSON mode and may need lenient parsing — handled but quality varies.
- **Thai font fallback** depends on the OS having one of the listed fonts installed (Leelawadee UI / Tahoma on Windows · Thonburi / Krungthep on macOS · Noto Sans Thai on Linux). If none are present, drop a Thai TTF into the bundled-fonts directory.
- **No translation streaming** yet — translations appear when the cloud request fully completes (streaming chat is on the roadmap above).
- **OCR is JP-only** — current OCR model is manga-ocr; Thai OCR is not yet supported.

## Credits

Built on top of [mayocream/koharu](https://github.com/mayocream/koharu). All original ML pipeline, Tauri shell, and renderer work is theirs — please consider supporting the upstream project:

- [GitHub Sponsors](https://github.com/sponsors/mayocream)
- [Patreon](https://www.patreon.com/mayocream)

<a href="https://github.com/mayocream/koharu/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=mayocream/koharu" />
</a>

## License

Koharu application is licensed under the [GNU General Public License v3.0](LICENSE-GPL). This fork inherits the same license.

The sub-crates of Koharu are licensed under the [Apache License 2.0](LICENSE-APACHE).
