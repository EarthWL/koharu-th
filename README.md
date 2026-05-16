# Koharu-TH

[![Version](https://img.shields.io/badge/version-1.0.1-blue.svg)](https://github.com/EarthWL/koharu-th/releases)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Sub-crates: Apache 2.0](https://img.shields.io/badge/sub--crates-Apache--2.0-blue.svg)](LICENSE-APACHE)
[![Based on](https://img.shields.io/badge/based%20on-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [ภาษาไทย](./README.th.md)
>
> **Manga series-translation studio**, based on [mayocream/koharu](https://github.com/mayocream/koharu) 0.37.0. What started as a Thai-language patch has grown into its own product with per-project SQLite (characters / glossary / translation memory / prompt templates / cost log), a 5-provider LLM profile system, an agentic AI Chat that can populate project data from a wiki URL, and a ~60-tool MCP server for external agents. Versioning is independent from upstream (we run our own semver starting at 1.0.0).

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
| Renderer | CJK fonts | + Thai-aware fonts + text-block rotation + line-height / letter-spacing / vertical-align / min-font-size controls + overflow warnings |
| MCP server | 25 tools | **~60 tools** covering full project surface + agentic web fetch |
| AI assistant | — | **In-app AI Chat** — streaming, multi-modal (image attach), native function-calling on 4 providers, 10 slash commands |
| Translation memory | — | exact / Jaccard / **semantic (vector embeddings)** + TMX 1.4 import/export |
| Export | single page | **CBZ multi-chapter** with ComicInfo.xml |
| Cost tracking | — | per-call log + **dashboard** (by profile / chapter / day / use case) |
| Power-user | — | **⌘K command palette** for chapter / profile / export / slash jump |

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

### AI Chat (agentic, multi-modal, streaming)

A sidebar tab that talks to your **active profile** using native function-calling on all 4 cloud providers. It has tools for every project entity (series_meta / chapters / characters / glossary / TM / prompt_render) plus a server-side `web_fetch_url` that bypasses browser CORS.

- **Streaming responses** with a Stop button — tokens appear as the model generates them (OpenAI / OpenRouter / Local SSE · Anthropic content_block_delta · Gemini :streamGenerateContent).
- **Image attachments** — attach the current canvas page (1-click) or upload any image. Auto-downsized to ≤1024px JPEG q85 before send. Sent as multi-modal blocks to all 4 providers; previous attachments persist in the chat history.

**Slash commands** (autocomplete on `/`):
- `/fetch-wiki <url>` — pull a Fandom/wiki page, propose updates to synopsis + characters + glossary
- `/draft-synopsis`, `/draft-style-notes` — brainstorm context fields
- `/suggest-character <name>` — propose Thai name / speech style / role
- `/extract-glossary <text>` — pull terms from a chunk of source text
- `/summarize-chapter [id]` — generate the chapter summary (feeds rolling context)
- `/preview-prompt <text>` — show the actual prompt your translation will see
- `/qc-consistency` — scan the open chapter for glossary / character-name mismatches, propose fixes
- `/tm-semantic <text>` — semantic TM lookup via embeddings (finds paraphrases)
- `/check-thai` — review Thai output for spelling / grammar / naturalness, auto-apply fixes

Chat history is stored per project in `series.db` (`chat_messages` table); the panel displays the last 50 messages and pages back through history.

### Command palette (Cmd+K)

⌘K / Ctrl+K opens a global palette to jump to chapter, switch LLM profile, export CBZ, open settings, or copy any slash command into the chat input.

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

### Translation memory

- **Exact-match** + **Jaccard fuzzy** lookup (threshold configurable, default 0.85)
- **Semantic / vector search** via embeddings (cosine similarity, top-K) — finds paraphrases that fuzzy match misses. Backfill button in Project tab embeds existing entries with the active LLM profile (`text-embedding-3-small` on OpenAI-compat, `text-embedding-004` on Gemini)
- Hit on TM short-circuits the cloud call entirely
- **TMX 1.4 import / export** — round-trip translation memory with Trados / OmegaT / MemoQ / any CAT tool

### Cost tracking + dashboard

- Every LLM call logged in `llm_call_log` with token counts, duration, success/failure, estimated USD cost
- **Dashboard in the Project sidebar tab**: headline spend / call / token stats + bar charts for last 30 days, per profile, per chapter, per use case. Bring-your-own per-1M pricing on each profile to get accurate dollar figures

### Multi-chapter export

- **CBZ export** per chapter with `ComicInfo.xml` sidecar (Kavita / Komga / YACReader / mobile manga readers). Uses pages from `<chapter>/render/` when available, falls back to `source/`. Click the archive icon on any chapter row or trigger from the Cmd+K palette

### Quality control

- **Bubble-fit warnings** — text-block panel shows amber `TIGHT` / rose `OVERFLOW` badges when the translation is likely to overflow the original bubble (heuristic: chars × estimated 18pt glyph area vs. bubble area, plus Thai/source length ratio)
- **Consistency checker** — `/qc-consistency` slash scans every translated block on the open chapter against the glossary + character names (including aliases), surfaces mismatches as a table, and proposes fixes via `update_text_block` after approval

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
- <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>: Open command palette

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

This fork no longer tracks upstream linearly — the project-folder + sidebar tabs restructuring + new crates (`koharu-project`) mean a straight rebase would conflict everywhere. Cherry-pick selectively:

```bash
git fetch upstream
git log <last-synced>..upstream/main --oneline --grep="^fix"   # candidate bug fixes
git show <sha>                                                  # inspect before applying
git cherry-pick -x <sha>                                        # records original SHA in commit body
```

When backporting, cite the upstream SHA in the commit body (see `git log --grep="cherry-picked from"` for prior examples) so the audit trail stays intact.

## Roadmap

Not promises — just things being considered as the fork keeps iterating.

**Shipped — Tier 1 (UX wins on AI Chat):**

- [x] Vision in AI Chat — attach the current canvas page or any image, multi-modal blocks across all 4 providers
- [x] Streaming chat responses (SSE token deltas + ⏹ Stop button via AbortController)

**Shipped — Tier 2 (workflow polish):**

- [x] Cost dashboard — per-profile / per-chapter / 30-day / per-use-case breakdown in Project sidebar
- [x] QC consistency checker — `qc_chapter_consistency` tool + `/qc-consistency` slash command (scans glossary + character mismatches, proposes fixes)
- [x] Thai bubble-fit warnings — amber/rose badges in text-block panel headers when translation is tight or overflows the bubble
- [x] Auto-extract characters + glossary — wand button per chapter row: opens chapter → OCRs all pages → extract proposals → bulk-add on approval

**Shipped — Tier 3 (interchange + power-user):**

- [x] CBZ multi-chapter export with `ComicInfo.xml` (Kavita / Komga / YACReader compatible)
- [x] Cmd+K / Ctrl+K command palette — jump to chapter, switch profile, export, slash commands
- [x] Vector-embedding TM with cosine semantic search + backfill button + `/tm-semantic` slash command
- [x] TMX 1.4 import/export (Trados / OmegaT / MemoQ interchange)
- [x] Thai spell / grammar check via `/check-thai` AI Chat slash command

**Earlier shipped:**

- [x] Series project format + glossary + TM + custom prompt templates
- [x] OpenRouter + Local LLM support · 5-provider live model search
- [x] OS keyring for API keys
- [x] Bundled-font support for Thai
- [x] Rolling-context summaries from previous chapters
- [x] Folder-based chapters (`source/` + `render/`) with auto-wrap of legacy single-file chapters
- [x] MCP server with ~60 tools covering the full project surface

**Not shipped yet (next considerations):**

- [ ] Batch chapter translation queue (background worker, multi-chapter progress)
- [ ] Cloud sync for project folders (Google Drive / Dropbox / S3)
- [ ] Multi-project workspace with shared TM / glossary pool across series
- [ ] Translator collaboration (multi-user, comments, approve workflow)
- [ ] Thai OCR (current OCR is JP-only via manga-ocr)

## Known limitations

- **Anthropic in pure-browser headless mode** — CORS will block direct calls in a plain browser; the desktop Tauri build adds `anthropic-dangerous-direct-browser-access: true` and works fine.
- **OpenAI JSON mode** is gated by a `model.includes('gpt')` check. Newer OpenAI models (`o3`, `o4`) and most OpenRouter-routed models skip JSON mode and may need lenient parsing — handled but quality varies.
- **Thai font fallback** depends on the OS having one of the listed fonts installed (Leelawadee UI / Tahoma on Windows · Thonburi / Krungthep on macOS · Noto Sans Thai on Linux). If none are present, drop a Thai TTF into the bundled-fonts directory.
- **Translation result streaming** (page-level translate) still resolves on full response; AI Chat is streamed but the per-block translate path isn't yet.
- **OCR is JP-only** — current OCR model is manga-ocr; Thai OCR is not yet supported.
- **Semantic TM embeddings** require a key on an OpenAI-compatible profile (OpenAI / OpenRouter / Local / Gemini). Anthropic has no native embeddings API.

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
