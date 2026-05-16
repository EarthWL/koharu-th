# Changelog

All notable changes to **Koharu-TH** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is independent from upstream
[mayocream/koharu](https://github.com/mayocream/koharu) — see the
[1.0.0] notes for the divergence point. For releases of upstream
itself, see [their CHANGELOG](https://github.com/mayocream/koharu/blob/main/CHANGELOG.md).

---

## [1.0.2] — 2026-05-17

Small UX cleanup pass after 1.0.1 — workflow polish across the
Chapters → Pages handoff and the AI Chat panel.

### Added

- **Auto-switch to Pages tab on chapter open** — clicking Open (or the
  Auto-setup wand) on a chapter row now flips the left sidebar to the
  Pages tab so you land on the thumbnails of what you just opened.
  Active sidebar tab is now persisted (lives in `projectStore`).
- **Chat replies follow the app UI language** — system prompt reads
  `i18n.language` and tells the model
  `Reply to the user in <Language> unless they explicitly ask for
  another language.` (Thai / English / Japanese / Simplified +
  Traditional Chinese / Russian / Spanish.) Removes the old
  "target language Thai by default" hint, which the model misread as
  the *translation* target.
- **"Clear" label on the chat-history wipe button** — the action
  existed but was a 24px icon-only button in the header that
  blended in. Now `[🗑 Clear]`, disabled when there's nothing to
  clear or a turn is streaming.

### Fixed

- **Extract Entities modal overflow with many OCR pages + items** —
  the items table + its own action bar were rendered as siblings of
  the scroll area, stacking outside the modal's `max-h-[90vh]` and
  pushing the Close footer off-screen. Refactored to a single scroll
  region (description + textarea + items table) with one combined
  footer that switches between "selected count + Toggle all + Close +
  Apply N" and just "Close".
- **OCR textarea inside Extract modal grew unbounded** — Tailwind v4's
  default `field-sizing-content` let the textarea expand to hold every
  page. Pinned to `min-h-32 max-h-48` with internal scroll.
- **Slash-command picker lingered after Enter** — `setShowSlash`
  only updated inside textarea `onChange`, so pressing Enter on a
  `/command` line cleared the input but left the picker covering the
  textarea for the whole streaming turn. Now closes immediately on
  send.

---

## [1.0.1] — 2026-05-17

Patch release focused on tightening the AI Chat + LLM Profile flows
discovered after the 1.0.0 cut, plus a meaningful UX feature
("Fit to bubble") for Thai translations that overflow the original
detected text-block bbox.

### Added

- **Fit to bubble** button per text-block (in TextBlocksPanel
  accordion). Floods white pixels from the current bbox on the
  original image, snaps the block geometry to the actual bubble
  outline. Fixes the common case where the Japanese-source bbox is
  too tight for the longer Thai translation. Adds new RPC method
  `text_block_fit_to_bubble`.
- **Vision-support detection** in AI Chat — `👁 vision` / `text only`
  badge in the panel header; attach buttons disable on text-only
  models. New `lib/services/visionSupport.ts` with heuristics for
  OpenAI / Claude / Gemini / OpenRouter / Local.
- **Searchable font picker** in RenderControlsPanel — type-to-filter
  the font dropdown (was a plain Radix Select; awful with 200+
  installed fonts).
- **Tool-progress narration** in the streaming chat bubble: every
  tool dispatch shows `🔧 calling <name>… ✓` (or `✗`) so the user
  sees the agentic loop in flight instead of a silent gap.

### Fixed

- **OpenRouter round-trip** — Rust `Provider` enum collapsed
  `"openrouter"` into `Provider::Openai`, so saving an OpenRouter
  profile stored `provider='openai'`. Edit modal re-opened the wrong
  tile, Apply pointed prefs at OpenAI, and translate hit the wrong
  endpoint with the wrong key. Added `Provider::Openrouter`; UI now
  also detects legacy mis-stored rows via the `vendor/model` slash
  heuristic and routes them to the OpenRouter tile / dispatcher.
- **"Resources not initialized" on cold launch** — UI WebSocket
  connects + fires RPCs before the Rust `AppResources` OnceCell is
  populated (~1-2s of model init). New `get_resources_wait` polls up
  to 20s with 100ms intervals so early requests queue silently
  instead of bouncing with a scary overlay.
- **Auto-apply after profile Save** — saving a profile now also
  writes its provider / model / apiUrl / apiKey into the live
  preferences store. Previously the user had to click both Save AND
  Apply (or pick from toolbar). Now Save = Apply.
- **Apply badge missed legacy profiles** — `isActive` compared raw
  `provider` field; for mis-stored OpenRouter rows that never
  matched. Now compares the effective dispatched provider via
  `kindOf()`.
- **API-key state on edit** — modal now distinguishes "loaded from
  keyring" vs "never stored" vs "keyring miss" vs "keyring error" and
  shows a coloured hint so the user knows whether they need to
  re-enter. Save with a blank field is safe (sends JSON null, leaves
  the keyring untouched).
- **Auto-render after batch translate** — the single-block translate
  path already re-rendered, but batch translate left the new
  translations sitting in the data model until the user clicked
  Render manually. Now batch translate triggers a full-page render +
  cache invalidation on completion.
- **"(empty)" placeholder on tool-only assistant turns** in AI Chat
  made tool dispatches look like failures. Suppressed when the turn
  has tool_calls.
- **Chat panel scroll layout** — three issues with one root cause:
  ScrollArea was missing `min-h-0`, so it grew with content past the
  panel bounds. The input footer fell off the bottom, the message
  list became unscrollable, and chat-area scroll bubbled up to the
  window and dragged the sidebar icon strip along. Added `min-h-0`
  to ScrollArea + `flex-1` to ChatTabPanel root + flex chain through
  the tab content column.
- **"Cloud API Key is missing"** error message is now actionable —
  tells the user to apply a profile or re-enter the key, with the
  active provider name.
- **Help menu** GitHub link now points at our fork instead of
  upstream; new "Report an issue" entry; upstream Discord renamed to
  "Upstream Discord (Mayo)" so users know it's not our support
  channel.

### Changed

- **Help menu** entries reorganised (see Fixed above).

[1.0.1]: https://github.com/EarthWL/koharu-th/releases/tag/1.0.1

---

## [1.0.0] — 2026-05-17

First independent release of Koharu-TH. Forked from
[mayocream/koharu](https://github.com/mayocream/koharu) at tag
[`0.37.0`](https://github.com/mayocream/koharu/releases/tag/0.37.0).
Reset to semver `1.0.0` because the fork has grown into a different
product (per-project series workspace + agentic AI chat + MCP
expansion) rather than a patch series on top of upstream.

### Added

#### Series project workspace

- **Folder-based project format** anchored by `series.koharuproj`
  manifest + `series.db` SQLite. Schema covers chapters, characters,
  glossary, translation memory, prompt templates, provider profiles,
  LLM cost log, and chat history. 5 migrations (V001–V005).
- **Folder-based chapters** with `source/` (raws) + `render/` (output)
  subfolders. Auto-wraps legacy single-file chapters on first open via
  `chapter::ensure_folder_layout`.
- **Welcome wizard** — guided New / Open / Recent project flow that
  gates the editor until a project is opened (standalone `.khr`
  workflow still available via escape hatch).
- **8-tab sidebar** — Pages · Chapters · Project · Characters · Glossary
  · Prompts · Profiles · AI Chat.
- **Prompt template engine** — Handlebars templates rendered with
  series meta + main characters + smart-filtered glossary + rolling
  summaries from the previous N chapters. Default templates ship for
  `translate`, `extract_entities`, `summarize_chapter`.
- **Translation memory** — exact (SHA-256 hash) + Jaccard fuzzy lookup;
  hit short-circuits the cloud call.
- **Project backup** to single `.zip` (manifest + DB + chapters +
  reference + assets).

#### LLM providers

- **5-provider profile system** — OpenAI · Claude · Gemini · OpenRouter
  · Local LLM (Ollama / LM Studio / llama.cpp). Live model search per
  provider with type-to-filter. API keys stored in the OS keyring.
- **Toolbar LLM badge** lets you pick which saved profile is active
  without leaving the canvas.

#### Agentic AI Chat (per-project)

- Sidebar tab with multi-turn chat against the active LLM profile.
  Native function-calling on all 4 cloud providers (OpenAI tools,
  Anthropic `tool_use`, Gemini `functionDeclarations`, OpenRouter via
  OpenAI dialect).
- **Streaming responses** — SSE deltas across all 4 providers + ⏹
  Stop button via `AbortController`.
- **Multi-modal image attachments** — attach the current canvas page
  (1-click) or upload from disk. Auto-downsized to ≤1024px JPEG q85
  before send.
- **10 slash commands**: `/fetch-wiki`, `/draft-synopsis`,
  `/draft-style-notes`, `/suggest-character`, `/extract-glossary`,
  `/summarize-chapter`, `/preview-prompt`, `/qc-consistency`,
  `/tm-semantic`, `/check-thai`.
- **Per-project chat history** stored in `chat_messages` table with
  attachment column (V004 migration). UI displays last 50, pages back
  through full history.

#### Quality control + analytics

- **Cost dashboard** in the Project tab — per-profile / per-chapter /
  30-day / per-use-case breakdown via `llm_cost_breakdown` RPC.
- **QC consistency checker** — scans translated blocks against glossary
  + character names (incl. aliases), surfaces mismatches as a markdown
  table, proposes fixes via `update_text_block`.
- **Bubble-fit warnings** — `TIGHT` / `OVERFLOW` badges on text-block
  panel headers based on translation / source ratio and estimated
  glyph coverage of the bubble area.
- **Auto-extract** wand button per chapter row: open → OCR every page
  → extract characters + glossary proposals → bulk-add on approval.

#### Interchange + power-user

- **CBZ multi-chapter export** with `ComicInfo.xml` sidecar (Kavita /
  Komga / YACReader / mobile reader compatible). Uses `render/` if
  present, falls back to `source/`.
- **TMX 1.4 import / export** for CAT-tool interchange (Trados /
  OmegaT / MemoQ).
- **Vector-embedding TM** (V005 migration: `embedding BLOB` +
  `embedding_model TEXT`). Backfill loop embeds existing TM entries
  with the active profile's embedding model (`text-embedding-3-small`
  on OpenAI-compat, `text-embedding-004` on Gemini). Top-K cosine
  semantic search via `tm_lookup_semantic` RPC + AI Chat tool.
- **Cmd+K / Ctrl+K command palette** powered by cmdk — jump to
  chapter, switch profile, export, copy slash command into chat.

#### MCP server expansion

- **~60 tools** at `/mcp` (was 25). Wraps the full project surface:
  project lifecycle, series meta, chapters (incl. programmatic
  `chapter_add_pages_from_paths` for agents), characters, glossary,
  prompt templates + render, translation memory, provider profiles,
  cost log, chat history, plus agentic `web_fetch_url` (Rust-side
  reqwest with 12s timeout / 1.5MB cap / HTML→text strip).

#### Thai output

- Thai-aware font fallback (Leelawadee UI / Tahoma / Thonburi /
  Noto Sans Thai depending on OS).
- Per-block renderer controls — **line-height**, **letter-spacing**,
  **min font size** (auto-fit floor), **vertical-align**, **manual
  font size**, **Thai preset** button.
- **Text-block rotation** (`rotation_deg`) plumbed end-to-end (API →
  pipeline → renderer → UI) for non-rectangular bubbles and stylised
  SFX.
- **Bundled fonts** auto-loaded from `<app-data>/Koharu/fonts/` —
  drop `.ttf` / `.otf` / `.ttc` to ship Thai or specialty manga fonts
  to users whose OS doesn't have them.

### Changed

- **Settings page** stripped down: Cloud AI section removed, all
  provider config moved to the Profiles sidebar tab.
- **LLM toolbar dropdown** lists saved profiles instead of bare
  provider names; selecting one applies the profile inline.
- **Right panel** is now a resizable vertical split (Layers/Render
  tabs ↕ TextBlocks); main layout `LAYOUT_ID` reset to `v3` to clear
  stale persisted sizes.
- **Navigator** thumbnails capped at 200px and centered in the panel.
- **About page** rebranded as "Koharu-TH" with "Based on" credit row
  + License row pointing to LICENSE-GPL.
- **Help menu** GitHub link now points to `EarthWL/koharu-th`; new
  "Report an issue" item; upstream Discord retained but explicitly
  labeled "Upstream Discord (Mayo)".
- **README** rewritten with comparison table vs upstream + roadmap
  tiers + cherry-pick workflow for upstream syncs.

### Fixed

Cherry-picked from upstream (citation SHAs in commit bodies):

- Pipeline crash when detect finds no text blocks — guards in
  `translate_with_llm` and `Model::inpaint`.
  [upstream [`82454e03`](https://github.com/mayocream/koharu/commit/82454e03)]
- `compare_blocks_for_reading_order` non-transitive sort that could
  panic Rust's stable sort.
  [upstream [`103b93e4`](https://github.com/mayocream/koharu/commit/103b93e4)]
- Canvas wheel `preventDefault` blocking page scroll on non-zoom wheel
  events.
  [upstream [`bfc0aefa`](https://github.com/mayocream/koharu/commit/bfc0aefa)]

Fork-local fixes:

- Text-style schema validator stripped fork-added fields
  (`lineHeight`, `letterSpacingPx`, `minFontSize`, `verticalAlign`) —
  added to zod schema.
- Decimal stepper reverting to integer mid-type — rewrote
  `NumericStepper` with local draft string + `inputMode='decimal'`.
- Renderer `run_auto` returning an error when text didn't fit at
  floor — now falls back to `run_with_size(text, floor)`.
- V002 chapter-folder migration's NOT NULL constraint on legacy
  `file_path` column — fixed via SQLite table-rebuild pattern.
- HMR mid-edit build breaks during multi-file Rust changes —
  resolved by structured per-feature commits.
- Right panel internal split (Layers/Render ↕ TextBlocks) wasn't
  resizable — converted from fixed `h-60` to `react-resizable-panels`
  vertical Group.
- Font picker dropdown text too small to read Thai font names —
  `text-xs` → `text-sm`, items rendered at 14px.

### Removed

- `/project/*` Next.js routes (overview, characters, glossary, prompts,
  profiles, layout) — replaced by sidebar tabs.
- Cloud AI section from `/settings` page (moved to Profiles tab).

### License

GPL-3.0 (app) + Apache-2.0 (sub-crates), unchanged from upstream.
Both `LICENSE-GPL` and `LICENSE-APACHE` retained at repo root.
Upstream attribution preserved in README Credits, About page, and
Cargo `authors` field.

---

## Pre-1.0.0 — Upstream history

Koharu-TH started as a clone of upstream `mayocream/koharu` at tag
[`0.37.0`](https://github.com/mayocream/koharu/releases/tag/0.37.0)
(released 2026-03-11). For the release history of upstream itself
(0.1.0 through 0.37.0 and beyond), see
[upstream CHANGELOG.md](https://github.com/mayocream/koharu/blob/main/CHANGELOG.md).

This fork's pre-1.0.0 work landed across two informal batches before
the 1.0.0 cut:

- **Mar 16** — Cloud LLM translation (OpenAI / Gemini / Anthropic /
  OpenRouter), Thai-script font fallback in renderer, text-block
  rotation plumbing.
- **Apr–May** — Series project schema (Phases 0–10): characters,
  glossary, TM, prompt templates, provider profiles, LLM call log.
  Folder-based chapters (V002). AI Chat (V003) + image attachments
  (V004) + vector TM embeddings (V005). MCP server expansion. CBZ +
  TMX interchange. Cmd+K command palette. Cost dashboard. QC
  consistency / bubble-fit / auto-extract.

Full granular history is preserved in `git log` on this repo.

[1.0.0]: https://github.com/EarthWL/koharu-th/releases/tag/1.0.0
