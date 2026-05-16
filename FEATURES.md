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
- **~60 MCP-style tools** — read/modify series metadata, characters, glossary, chapters, prompt templates; fetch web pages (wikis); view the current canvas page.
- **Slash commands** — `/draft-synopsis`, `/draft-style-notes`, `/suggest-character`, `/extract-glossary`, `/qc-consistency`, etc.
- **Replies in the app's UI language** — system prompt is set from `i18n.language` (Thai / English / Japanese / Chinese / Russian / Spanish).
- **Tool-progress narration** — every tool dispatch shows `🔧 calling <name>… ✓` inline so the agentic loop isn't a silent gap.
- **Clear history** per project.

## Rendering

- **Bundled font directory** with searchable picker.
- **Thai script support** — Leelawadee UI / Tahoma / Noto Sans Thai branch in the font-fallback chain.
- **Per-block text styling** — size, line-height, letter/word spacing, vertical alignment, rotation (degrees), font family.
- **Fit to bubble** — flood-fill the white bubble interior from the block's bbox and snap the block to the actual bubble outline. Fixes Thai overflow.
- **Render effects** — shader-based stroke + shadow, opt-in per render call.

## Workflow & UX

- **Welcome gate** — pick recent project, open another, create new, or "standalone files" escape hatch.
- **Tabbed sidebar** — Pages, Chapters, Project, Characters, Glossary, Prompts, Profiles, AI Chat. Active tab persists.
- **Open chapter → auto-switch to Pages** so you see the thumbnails of what you opened.
- **Resizable 3-pane layout** with persisted sizes.
- **Cmd+K / Ctrl+K command palette** (cmdk) — jump to chapter, switch profile, run slash commands, open settings. Works on Thai / non-Latin keyboard layouts.
- **Recent projects** tracked in app data.
- **i18n** — UI in Thai, English, Japanese, Simplified + Traditional Chinese, Russian, Spanish.

## QA & review

- **Side-by-side QA review page** — source vs translation per block, per-chapter.
- **Translation provenance badges** — which profile + model produced each block.
- **Per-block model override** — re-run a single block through a different profile without leaving the QA view.
- **QC consistency checker** — AI Chat slash command that scans a chapter against the glossary and flags drift.
- **Thai spell / grammar check** — pluggable check pass.

## Import / export

- **Chapter import** — pick folder, files copied into `source/` of the active chapter.
- **CBZ export** — per chapter; uses rendered output if available, falls back to source.
- **TMX import / export** — interop with CAT tools.
- **Glossary CSV / JSON paste** — bulk add.
- **Backup zip** — entire project folder.

## Infrastructure

- **Tauri 2.x desktop app** — Windows today; macOS + Linux builds planned.
- **MCP server** — `koharu-rpc` exposes the agentic tools over Streamable HTTP for external agents.
- **WebSocket msgpack RPC** between UI and Rust backend.
- **SQLite migrations** managed in `koharu-project` — 5 migrations to date.
- **OS keyring** for API key storage (not raw in DB).
- **GPL-3.0** app + **Apache-2.0** sub-crates (preserved from upstream).
