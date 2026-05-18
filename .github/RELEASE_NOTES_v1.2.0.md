# Koharu-TH v1.2.0 — the audit-cycle release

54 commits since v1.1.1. Surface area is largely stable — what
changed is the **interior**: 21 components walked end-to-end for
data-loss bugs, race conditions, missing flushes, and broken i18n.
5 GitHub issues closed, 4 LLM-provider quirks fixed, several real
perf wins on the inpaint path.

> The biggest single fix: **project switching no longer leaks data
> between projects.** Cached chat / glossary / characters / cost
> data from the outgoing project used to survive the swap for
> 200–1000 ms — a fast click could fire a mutation against the
> closed project. Now properly cleared.

---

## 🛑 Critical fixes (data integrity)

- **Cross-project cache leak on project swap** — every panel that
  reads project-scoped data now drops its cache the moment you
  switch projects, instead of marking it stale and showing the old
  project's rows during refetch. Closes a window where a fast click
  could mutate the wrong project's database.
- **`activeChapterId` survived project swap** — could silently
  anchor rolling-context summaries to the wrong chapter in the new
  project if the chapter IDs happened to collide.
- **Pending edits were orphaned on every page / project switch** —
  text-block, mask, and brush sync queues now drain before any
  navigation that would clobber them. Affected sites: Navigator,
  Menu File>Open / Recent / Close, Command Palette New / Open /
  Close, retranslate flow, JSON glossary import, JSON text-blocks
  import, entity extraction apply.
- **Local LLM chat was completely blocked** by the API-key gate —
  Ollama / LM Studio / llama.cpp profiles have no key by design;
  Send always errored with "no API key". Now bypassed correctly for
  local profiles, cloud providers still gated normally.
- **Attachment-only chat send was dead** — the Send button enabled
  itself for image-only turns but the handler bailed at empty text.
  Image-QA flows ("what does this bubble say?") work now.
- **Command Palette applied LLM profiles via the wrong dispatcher**
  for legacy OpenRouter rows — could route requests to the OpenAI
  endpoint when applied from the palette but the OpenRouter endpoint
  when applied from the Profiles tab. Silent inconsistency depending
  on entry point.

## 🐛 GitHub issues closed

- **#11** — OCR on stylised Latin titles collapsed word boundaries
  ("DEAD ARGON" → "DEADARGON").
- **#12** — Translation panel edits silently failed because the
  backend RPC registry was missing `update_text_block`.
- **#17** — Added **Process > Re-translate (skip inpaint)** menu
  item for prompt iteration without re-running the slowest step.
- **#20** — Project now auto-detects source language from first OCR.
- **#21** — Thai post-processing — collapses excess whitespace
  between Thai characters, converts ASCII quotes to typographic
  curly quotes. Toggleable in Settings. Mixed-script content like
  character names is preserved.

## 🌐 LLM provider quirks

- **Gemini** multi-turn tool use was failing with schema mismatch
  400s — `functionResponse.name` was being sent as the tool-call id
  instead of the function name.
- **Anthropic** Claude 3.5 Sonnet translations got truncated mid-
  sentence — `max_tokens` is now scaled per-model.
- **OpenAI** JSON-mode gate was too strict; some compatible models
  were classified as text-only.
- **OpenRouter** profiles saved before 1.0.0 mis-stored as
  `provider='openai'` are now correctly routed.

## ✨ UX

- **Modal accessibility** standardised across Welcome, Command
  Palette, Glossary Import, Entity Extraction — `role="dialog"`,
  Esc to close, backdrop click, focus return.
- **ActivityBubble announces operations** to screen readers via
  `role="status"` + `aria-live="polite"`.
- **`prefers-reduced-motion`** honoured on the indeterminate
  progress sweep and pulsing activity dots (WCAG 2.3.3).
- **Partial-success surfacing** on every bulk op (glossary import,
  entity extraction, queue clear) — amber callout with how many
  inserted / skipped / failed, instead of silent drops.
- **`/check-thai` slash command** for AI Chat — review the open
  chapter for spelling, grammar, naturalness, tone consistency;
  apply fixes on approval.
- **Storage panel** in Settings showing model-cache footprint with
  a safe Reset.
- **Profile-rename duplicate detection** — frontend warns before
  saving over an existing name.
- **Auto-select first model** when switching LLM provider tab.

## 🌍 i18n

Thai (TH) and Japanese (JA) coverage **completed** across every
audited component. ~120 new keys across new namespaces
(`palette.*`, `costDashboard.*`, `queue.*`, `glossaryImport.*`,
`extractEntities.*`) plus backfills into existing namespaces.
Plurals use i18next `_one` / `_other`. Two-placeholder strings
preserve word-order flexibility so Thai natural phrasing
("สำเร็จ 80%") works alongside English ("80% ok").

## ⚡ Performance

- **Parallel bubble inference** during the detect step.
- **LaMa inpaint crops capped at 512 px** before inference —
  large bubbles previously allocated megabytes the network then
  resized away.
- **Renderer error propagation** — failed per-block renders now
  surface instead of being silently dropped.

## 🛡 Security

- **NSIS uninstaller safety belts** (4 layers) — prevents the
  installer from touching user-owned project folders during
  uninstall.

## 📦 Builds

Same per-GPU split as 1.1.x: **Turing / Ampere / Ada / Blackwell**.
The split remains necessary while `bindgen_cuda` 0.1.6 can't
accept a multi-cap build string; revisit in 1.2.x when upstream
PTX-JIT sync lands.

Pick the binary matching your card:
- **Turing** — RTX 20-series, GTX 16-series, Quadro RTX
- **Ampere** — RTX 30-series, A-series
- **Ada** — RTX 40-series
- **Blackwell** — RTX 50-series

---

**Full changelog**: see [CHANGELOG.md](https://github.com/EarthWL/koharu-th/blob/main/CHANGELOG.md#120--2026-05-19)
for the structured Keep-a-Changelog entry.

**Upgrade path from 1.1.x**: drop-in. No DB migration, no settings
reset. Existing `.koharuproj` projects open as-is.

**Known limitation**: Linux desktop window controls are still
rendered Windows-style (`isWindowsTauri = isTauri() && !isMacOS()`).
Cosmetic only — Linux distribution itself is not in this release.
Will be fixed when Linux ships in 1.3.x.
