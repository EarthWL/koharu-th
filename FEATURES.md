# Features

What koharu-th can do today, grouped by capability. For chronological
release history see [CHANGELOG.md](CHANGELOG.md).

---

## Translation pipeline

- **5 LLM providers** — OpenAI, OpenRouter, Google Gemini, Anthropic Claude, and local (Ollama). Switch per use-case via Profiles.
- **Provider profiles** — saved configs with provider, model, base URL, API key (stored in OS keyring), cost rates. Set defaults per use-case; Save also applies.
- **Handlebars prompt templates** — built-in `manga-standard`, `sfx-only`, `fast-draft`, plus a custom editor with live preview and test-on-block.
- **3-layer context injection** — always-on main-character + tone hints, smart-filtered glossary (only entries that appear in the current page), and rolling summaries of the last N chapters.
- **Translation memory (TM)** — exact-match short-circuit before send, fuzzy lookup via SQLite FTS5, optional vector embeddings for semantic matches. Per-block hit indicator.
- **SSE streaming + retry** — token-by-token rendering for cloud calls, exponential backoff on transient errors.
- **Auto-render after translate** — both single-block and batch paths re-render the page so you see the new text without a manual click.
- **AI Translation Style Switcher** — switch between General, Shonen, and Polite styles per text block to modify the LLM's translation tone.

## Series Project (per-series DB)

- **Folder-based project** — anchored by a `.koharuproj` manifest; SQLite (`series.db`) holds all metadata.
- **Series metadata** — title, original title, synopsis, genre, audience, source/target language, tone, formality, style notes, cover image.
- **Chapters** — folder-per-chapter (`source/`, `khr/`, `render/`), drag-reorderable, per-chapter status (pending → in_progress → translated → reviewed → done), LLM-generated summaries you can edit.
- **Characters** — original ↔ translated name, aliases, role, speech style, relationships, main/supporting split, auto-extracted from chapter text.
- **Glossary** — source ↔ target, category (term/place/skill/honorific/item/org/sfx), context notes, usage count, manual/extracted confidence. CSV/JSON bulk import.
- **Cost log** — every LLM call recorded with tokens, duration, profile, chapter. Dashboard with totals + per-chapter breakdown.
- **Project backup** — one-click zip of the whole folder.

## AI Chat (agentic)

- **Sidebar panel** with streaming responses, attachment support (vision-capable models only — auto-detected), stop button.
- **Deep AI Chat Undo/Redo Stack** — Multi-step in-memory undo/redo stack in the sidebar chat, allowing users to step backward and forward through prompt/response turns seamlessly.
- **~60 MCP-style tools** — read/modify series metadata, characters, glossary, chapters, prompt templates; fetch web pages (wikis); view the current canvas page.
- **Slash commands** — `/draft-synopsis`, `/draft-style-notes`, `/suggest-character`, `/extract-glossary`, `/qc-consistency`, etc.
- **Replies in the app's UI language** — system prompt is set from `i18n.language` (Thai / English / Japanese / Chinese / Russian / Spanish). Supports bilingual auto-adaptation.
- **Tool-progress narration** — every tool dispatch shows `🔧 calling <name>… ✓` inline so the agentic loop isn't a silent gap.
- **Clear history** per project.

## Rendering

- **Bundled font directory** with searchable picker.
- **Thai script support** — Leelawadee UI / Tahoma / Noto Sans Thai branch in the font-fallback chain.
- **Photoshop-style Typography Controls** — adjustable line-height (Leading A/A) and letter-spacing (Tracking VA) with live toolbar updates.
- **Native Bold/Italic rendering** — supports loading real bold/italic font weights from disk with faux fallback.
- **Per-block text styling** — size, line-height, letter/word spacing, vertical alignment, rotation (degrees), font family.
- **Fit to bubble & warnings** — flood-fill the white bubble interior from the block's bbox and snap the block to the actual bubble outline. Displays TIGHT/OVERFLOW warnings ignoring Thai combining accent/vowel marks.
- **Render effects** — shader-based stroke + shadow, opt-in per render call.
- **Text Block Reordering** — rearrange text rendering priority (Move Up / Down buttons) to fix OCR sequence ordering issues.

## Workflow & UX

- **Welcome gate** — pick recent project, open another, create new, or "standalone files" escape hatch.
- **Tabbed sidebar** — Pages, Chapters, Project, Characters, Glossary, Prompts, Profiles, AI Chat. Active tab persists.
- **Open chapter → auto-switch to Pages** so you see the thumbnails of what you opened.
- **Resizable 3-pane layout** with persisted sizes.
- **Cmd+K / Ctrl+K command palette** (cmdk) — jump to chapter, switch profile, run slash commands, open settings. Works on Thai / non-Latin keyboard layouts.
- **Photoshop Canvas Hotkeys** — standard canvas zoom (`Alt + Scroll`) and lateral pan (`Ctrl + Scroll`).
- **Next-Gen Studio Enhancements** — Interactive customizer for premium themes (Neon Cyberpunk, Soft Sakura, Deep Space Obsidian), real-time collaborative synchronization for shared translation memories, and custom hardware micro-benchmark scanner.
- **Recent projects** tracked in app data.
- **i18n** — UI in Thai, English, Japanese, Simplified + Traditional Chinese, Russian, Spanish.

## QA & review

- **Side-by-side QA review page** — source vs translation per block, per-chapter.
- **Translation provenance badges** — which profile + model produced each block.
- **Per-block model override** — re-run a single block through a different profile without leaving the QA view.
- **QC consistency checker** — AI Chat slash command that scans a chapter against the glossary and flags drift.
- **Thai spell / grammar check** — pluggable check pass.
- **Live Menu Synced state** — View/Process toolbar menus restored immediately via cached React Query states on chapter open.

## Import / export

- **Chapter import** — pick folder, files copied into `source/` of the active chapter.
- **CBZ export** — per chapter; uses rendered output if available, falls back to source.
- **TMX import / export** — interop with CAT tools.
- **Glossary CSV / JSON paste** — bulk add.
- **Backup zip** — entire project folder.
- **Bulletproof PNG/WebP Export** — lossless file render exporting to ensure data integrity.

## Infrastructure

- **Tauri 2.x desktop app** — Windows today; macOS + Linux builds planned.
- **HTTP Image Streaming API & WebSocket Bypass** — Axum-served GET routes `/api/thumbnail/:index` and `/api/image/:index/:layer` streaming WebP images directly to the browser WebView. Features custom weak ETags and HTTP Cache-Control header validation to eliminate redundant memory allocations, GPU decoding cycles, and disk I/O.
- **MCP server** — `koharu-rpc` exposes the agentic tools over Streamable HTTP for external agents.
- **SQLite migrations** managed in `koharu-project`.
- **Remote In-App Addon & Language Store** — Glassmorphic settings panel with real-time CDN download of language pack addon dictionaries (FR, ES, PT, ZH, RU) featuring offline fallback to local static bundles, plus Tauri relaunch FFI integration.
- **Security Hardening** — V8 memory zeroization for sensitive API keys after use, anti-debugging hooks, and TLS 1.2 minimum protocol requirements.
- **3-mode Auto-updater** — automated, notify-only, or manual update options from GitHub Releases.
- **OS keyring** for API key storage (not raw in DB).
- **Windows Registry Association** — registers `.koharuproj` extension to auto-launch the application and automatically load/open the double-clicked project directory directly at startup.
- **Windows Path & Cache Hardening** — Uses Windows UNC prefix (`\\?\`) recursively resolved at startup to automatically bypass the 260-character `MAX_PATH` limit, resolving model download `os error 3` (Path Not Found) panics.
- **GPL-3.0** app + **Apache-2.0** sub-crates (preserved from upstream).
