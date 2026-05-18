# Koharu-TH

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](https://github.com/EarthWL/koharu-th/releases)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Sub-crates: Apache 2.0](https://img.shields.io/badge/sub--crates-Apache--2.0-blue.svg)](LICENSE-APACHE)
[![Forked from](https://img.shields.io/badge/forked%20from-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Upstream now](https://img.shields.io/badge/upstream%20now-0.59.x-lightgrey.svg)](https://github.com/mayocream/koharu/releases)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [ภาษาไทย](./README.th.md)
>
> **Manga series-translation studio.** A divergent fork of
> [mayocream/koharu](https://github.com/mayocream/koharu) — same
> 0.37.0 source ancestor, different product shape. We added a
> per-project SQLite store (characters / glossary / translation memory
> / prompt templates / cost log), a 5-provider LLM profile system,
> an agentic AI Chat that can populate project data from a wiki URL,
> and a ~60-tool MCP server for external agents. Versioning is
> independent (1.x.x); we cherry-pick upstream bug fixes selectively.
> See [How we got here](#how-we-got-here-and-where-upstream-went)
> for the divergence narrative.

ML-powered manga translation studio, written in **Rust**.

Under the hood, Koharu uses [candle](https://github.com/huggingface/candle) for high-performance ML inference and [Tauri](https://github.com/tauri-apps/tauri) for the desktop GUI. All native components are written in Rust.

> [!NOTE]
> Koharu runs ML models **locally** by default. If you save and apply a Cloud LLM Profile (OpenAI / Claude / Gemini / OpenRouter / Local LLM server), the text you translate is sent to that provider — everything else still runs locally. Cloud usage is opt-in via the Profiles sidebar tab.

---

![screenshot](assets/koharu-th-screenshot-ex.png)

## How we got here (and where upstream went)

This fork started as a Thai-language patch of upstream **koharu
0.37.0** (March 2026). Since then both projects shipped substantially
along different roadmaps. Histories aren't merge-related — the fork
was a squashed import of 0.37.0 source, not a `git fork`, so direct
`git diff` is meaningless. The shape divergence below is what
matters.

**Upstream** advanced 0.37.0 → 0.59.x over **22 minor releases and
485 commits**, toward a faster broader-coverage general manga
translator: llama.cpp replacing candle for LLM inference, AMD GPU
acceleration via ZLUDA, Vulkan backend for non-NVIDIA, PTX-JIT
single-binary CUDA across compute caps, newer OCR / inpainting
models (`paddleocr-vl-1.5`, `manga-text-segmentation-2025`, AOT
inpaint, Flux.2 Klein), Codex image-to-image page regeneration,
layered PSD export, CLI regression-test pipeline, an in-app updater,
DeepL / Google / Caiyun MT providers, font weight/style picker, and
9+ new UI locales (KO / BE / BG / PT / TR / …).

**This fork** went the other direction — a per-series
**localization studio with project memory**: SQLite-backed glossary,
character roster, translation memory (exact + Jaccard + semantic
embeddings + TMX 1.4 interchange), prompt templates, and cost log,
all per project. An agentic AI Chat that can populate that data from
a wiki URL, QC a chapter for inconsistencies, or apply Thai
spelling/grammar fixes. CBZ multi-chapter export with
`ComicInfo.xml`. Thai-aware renderer (line-height, letter-spacing,
min-font-size floor, vertical-align, text-block rotation,
overflow/tight warnings, Thai post-processing). A ~60-tool MCP server
for external agents. 169 commits and 6 releases (1.0.0 → 1.2.0).

The two roadmaps no longer overlap. **Pick upstream** if you want
the best ML pipeline for many languages on many GPUs. **Pick this
fork** if you want a workflow tool that remembers your characters
and glossary across chapters — especially for Thai output.

We still cherry-pick upstream bug fixes that touch overlapping code
(see [Syncing with upstream](#syncing-with-upstream)). The 1.3.x
roadmap revisits upstream's PTX-JIT / Vulkan / ZLUDA backend so we
can ship one binary instead of four.

## What's different in this fork

Comparing **current upstream (0.59.x)** against **this fork (1.2.0)**
— not a slight on either side; both are healthy projects with
different audiences.

| Area | Upstream 0.59.x | Koharu-TH 1.2.0 |
|---|---|---|
| Project model | open files / `.khr` | **per-folder Series Project** with SQLite (11 tables) |
| Workflow scope | per-page detect → OCR → inpaint → translate → render | **per-chapter, with rolling-context summaries from prior chapters** |
| LLM backends | **llama.cpp** local + multi-preset cloud (OpenAI / Claude / Gemini / DeepL / Google / Caiyun) | candle local + **5 cloud profile types** (OpenAI / Claude / Gemini / OpenRouter / Local LLM server) — per-project, live model search, per-1M pricing |
| Translation memory | — | exact / Jaccard / **semantic (vector embeddings)** + TMX 1.4 import/export |
| AI assistant | custom system prompt | **agentic AI Chat** — 20 tools + 10 slash commands, function-calling on 4 providers, image attachments, ~60-tool MCP for external agents |
| Glossary / Characters | — | **per-project, smart-filtered into the translate prompt** |
| Export | single page · **layered PSD** | **CBZ multi-chapter** with `ComicInfo.xml` |
| Cost tracking | — | per-call log + **dashboard** (by profile / chapter / day / use case) |
| Power-user | **keybind config**, **multi-selection**, **redo/undo** | **⌘K command palette** for chapter / profile / export / slash jump |
| Renderer | CJK + **font weights/styles**, **LTR/RTL reading order** | + **Thai-aware fonts**, text-block rotation, line-height / letter-spacing / vertical-align / min-font-size, **overflow warnings**, **Thai post-process** |
| GPU support | **Vulkan + ZLUDA (AMD) + CUDA PTX-JIT single binary** | CUDA per-GPU binaries (Turing / Ampere / Ada / Blackwell) + Metal — ZLUDA / Vulkan / PTX-JIT planned for 1.3.x |
| OCR models | **paddleocr-vl-1.5, manga-text-segmentation-2025, pp-doclayout-v3** | MIT-48px (Latin / CJK / Thai) + manga-ocr (JP) + Anime Text YOLO (1.1.x) · upstream models tracked for backport |
| Inpainting | **Flux.2 Klein, AOT, bubble-aware** | LaMa (carried from 0.37.0) · upstream models tracked |
| Image-to-image | **Codex img2img** page regeneration | — |
| Locales | EN / JA / ZH-CN / ZH-TW / KO / RU / ES / BE / BG / PT / TR / FR / DE / IT / VI / TH | **EN / TH / JA** with full coverage + a11y pass (1.2.0); others available but partial |
| In-app updater | **yes** | — (manual download from Releases page) |
| Telemetry | **Sentry** | none |
| CI/CD | full GitHub Actions matrix | disabled on the fork (macOS minutes 10× cost; PTX-JIT sync prerequisite) |
| Versioning | continuous 0.x.x | **independent semver** 1.x.x |

## Features

> Quick capability index: [FEATURES.md](FEATURES.md). Sections below
> go deeper on the big ones.

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

The fork no longer shares git history with upstream — `git merge-base
upstream/main HEAD` returns nothing because the fork was a squashed
0.37.0 import, not a `git fork`. As of v1.2.0 upstream is at 0.59.x
(**485 commits / 22 minor releases** ahead in linear count); a rebase
is impossible and even a 3-way merge would conflict everywhere
because we restructured the project layout (sidebar tabs, new
`koharu-project` crate, SQLite schema).

Cherry-picking selectively works as long as you stay in files
upstream and the fork both still touch (renderer, OCR pipeline,
LLM dispatch, candle bindings). Use the commit message to triage:

```bash
git fetch upstream
git log 0.37.0..upstream/main --oneline --grep="^fix"   # candidate bug fixes
git log 0.37.0..upstream/main --oneline --grep="^feat"  # candidate feature backports
git show <sha>                                          # inspect before applying
git cherry-pick -x <sha>                                # records original SHA in commit body
```

When backporting, cite the upstream SHA in the commit body (see
`git log --grep="cherry-picked from"` for prior examples) so the
audit trail stays intact.

The 1.3.x roadmap is largely **upstream backend sync** (PTX-JIT
CUDA / Vulkan / ZLUDA) — at that point the per-GPU release matrix
collapses to one binary and we close the ML-backend gap entirely.
Application-layer divergence (project format, AI Chat, MCP, TM,
Thai workflow) stays.

## Roadmap

Not promises — just things being considered as the fork keeps iterating.

**Shipped — 1.2.0 (audit cycle: data-integrity, i18n, a11y):**

- [x] **Cross-project cache leak closed** — every project / document
  swap now drains pending sync queues and **removes** (not just
  invalidates) the outgoing project's cached queries, eliminating a
  200–1000 ms window where a fast click could fire a mutation
  against the project that just closed.
- [x] **21-component audit pass** — every sidebar tab + every non-
  tab UI surface (Welcome, Workspace, MenuBar, CommandPalette,
  ActivityBubble, QueueWidget, TextBlocksPanel, RenderControlsPanel,
  ExtractEntitiesModal, ImportGlossaryModal, CostDashboard) walked
  end-to-end for race conditions, missing flushes, broken i18n,
  silent error swallowing.
- [x] **Local LLM chat unblocked** — Ollama / LM Studio / llama.cpp
  profiles were silently blocked by an API-key gate they couldn't
  satisfy. Detect via `kindOf({apiUrl}) === 'local'` and bypass.
- [x] **5 GitHub issues closed** — #11 (OCR Latin word boundary
  collapse), #12 (translation panel edits silently failed via
  missing RPC method), #17 (Re-translate menu item), #20 (auto-
  detect source language from OCR), #21 (Thai post-processing
  pass).
- [x] **4 LLM provider quirks fixed** — Gemini multi-turn
  `functionResponse.name`, Anthropic `max_tokens` scaling, OpenAI
  JSON-mode gate, OpenRouter legacy DB-row mis-store.
- [x] **i18n completed across TH and JA** — new `palette.*`,
  `costDashboard.*`, `queue.*`, `glossaryImport.*`,
  `extractEntities.*` namespaces + ~120 backfill keys. Plurals
  flow through i18next `_one` / `_other` resolution.
- [x] **Modal a11y kit applied uniformly** — `role="dialog"` +
  `aria-modal` + `aria-labelledby` + Esc + backdrop-click on every
  modal surface (Welcome, Command Palette, Glossary Import, Entity
  Extraction).
- [x] **`prefers-reduced-motion: reduce` honoured** on the
  indeterminate progress sweep and pulsing activity dots
  (WCAG 2.3.3).
- [x] **NSIS uninstaller safety belts** carried from 1.1.x —
  4 layers preventing the installer from touching user-owned
  project folders during uninstall.
- [x] **Partial-success surfacing** on every bulk operation
  (glossary import, entity extraction, queue clear) — amber
  callout with `{inserted, skipped, failed}` instead of silent
  drops.

**Shipped — 1.1.x (detector + OCR engine + storage management):**

- [x] **Anime Text YOLO** as opt-in detector alternative (`mayocream/anime-text-yolo`) — catches SFX, stylised titles, and out-of-bubble text the default detector misses. 5 size variants N → X (~10 MB → ~250 MB), lazy-loaded per pick.
- [x] **Confidence slider** for Anime YOLO in Settings (0.05 – 0.95, default 0.25). Reset link when off-default.
- [x] **Standalone Detect / OCR buttons respect the engine preference** — earlier the buttons silently used the backend default regardless of the Settings pick. Now `DetectPayload` / `OcrPayload` thread the choice end-to-end.
- [x] **Cloud Vision OCR sends per-bubble crops** instead of one full page + bbox list — small models like `gemini-2.5-flash-lite` can no longer mis-map text between bubbles, including after the user manually deletes some boxes.
- [x] **Settings → Storage panel** lists every on-disk artefact koharu manages outside project folders (CUDA libs, AI model cache, custom fonts, recent-projects list) with size + path + per-row Clear button. Bonus "Preferences → Reset to defaults".
- [x] **Windows NSIS uninstaller hook** offers to also remove `%LOCALAPPDATA%\Koharu\` (cached models + CUDA libs) on uninstall. 4 safety belts: refuses if `$LOCALAPPDATA` is empty, requires marker files before any destructive op, deletes by named subfolder (not parent recursively), final non-recursive parent removal only succeeds if folder is empty. Bounded blast radius — cannot follow a parent-level junction the way an unguarded `RMDir /r` could.

**Shipped — 1.0.3 (chat polish + first portable release):**

- [x] Markdown rendering in AI Chat (tables, code fences, lists, blockquotes — same renderer for streaming + persisted)
- [x] Chat text selectable / copyable (was globally `select-none` for canvas pan)
- [x] Token usage logged for every chat round (`use_case='chat'` in cost dashboard, per-provider parsing)
- [x] Portable Windows release — `.msi`, `.exe` (NSIS), and `.zip` artifacts; maintainer's local filesystem paths scrubbed out of the binary

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

**1.3.x — planned (sync upstream backend → collapse the per-GPU
release matrix):**

- [ ] **PTX JIT for CUDA** — adopt upstream's single-binary approach
  (compute 8.0 base + forward-JIT PTX) so we ship one installer for
  RTX 30xx / 40xx / 50xx instead of one per generation. Trade-off:
  drops RTX 20xx (Turing 7.5) GPU acceleration; those users get
  CPU fallback.
- [ ] **Vulkan backend** — pull upstream's cross-vendor Vulkan path
  for OCR + local LLM inference. AMD / Intel GPUs get partial
  acceleration without ZLUDA.
- [ ] **ZLUDA (experimental, Windows)** — re-add upstream's CUDA-
  compat layer for AMD GPUs on Windows. We explicitly stripped this
  during the fork; bringing it back gives AMD users a path to
  Detect / Inpaint acceleration too.
- [ ] **Re-enable GitHub Actions release matrix** — currently
  disabled (macOS minutes 10× cost; upstream's matrix CI was too
  eager). Becomes feasible once the PTX path lands and we're back
  to one binary per platform.
- [ ] **Optional upstream OCR / inpaint model backports** —
  `paddleocr-vl-1.5`, `manga-text-segmentation-2025`, Flux.2 Klein,
  AOT inpainting. Each is an opt-in engine, not a default swap, so
  the v1.x quality baseline doesn't shift under existing users.

**1.4.x+ — application-layer differentiation (NOT planned to
converge with upstream):**

- [ ] Streaming display in AI Chat (currently waits for full
  response)
- [ ] Cancel mid-turn for AI Chat
- [ ] Toast notification library (replace `alert()` everywhere)
- [ ] Auto-updater (HetCreep groundwork in 1.1.x can be lit up)
- [ ] Multi-project workspace with shared TM / glossary pool
- [ ] Translator collaboration (multi-user, comments, approve flow)
- [ ] Cloud sync for project folders (Google Drive / Dropbox / S3)
- [ ] Pre-built macOS releases (code compiles + has Metal kernels;
  not yet distributed)
- [ ] Pre-built Linux releases (CI groundwork in place; window
  controls fix needed — they currently render Windows-style on
  Linux)
- [ ] Thai OCR (current Thai path goes through MIT-48px Latin
  branch or cloud Vision OCR)
- [ ] Cloud Vision OCR inside the batch queue (single-shot
  dispatch only today; queue falls back to MIT-48px)

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
