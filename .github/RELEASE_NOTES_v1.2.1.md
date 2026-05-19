# Koharu-TH v1.2.1 — community batch + 1.2.0 regression hotfix

Small follow-up to 1.2.0. One **bug** from the 1.2.0 MenuBar audit
that escaped review, plus three concrete UX wins from
[@HetCreep](https://github.com/HetCreep) on the issue tracker.

> Two more of HetCreep's asks (#18 LaMa resolution slider, #31
> translation style switcher) are intentionally deferred to v2's
> Engine Profile UI — see [`docs/v2-arch.md`](https://github.com/EarthWL/koharu-th/blob/main/docs/v2-arch.md)
> for the v2 plan. Doing them now means rebuilding the same UI
> twice.

---

## 🐛 Fixed

- **#28 — MenuBar View / Process items stayed disabled after
  opening a chapter.** Regression from the v1.2.0 MenuBar audit.
  The audit added "disable these items when no document is loaded"
  gating, but the chapter-open flow forgot to push the new page
  count into the editor store — so the items stayed disabled
  forever when you came in through the Project / Chapters workflow.
  Now fixed at all four chapter-open sites (Chapters tab, Command
  Palette, Welcome dialog). Bonus: the Navigator also auto-resets
  to page 1 of the newly opened chapter.

## ✨ Added

- **#23 — Photoshop-style canvas navigation.**
  - **Space + drag** → pan the viewport regardless of which tool
    is active. The convention every graphics editor follows so you
    don't have to switch tools to reposition mid-edit.
  - **Alt + scroll wheel** → zoom toward the cursor (the canvas
    point under the cursor stays put). The existing Ctrl + wheel
    keeps doing center-based zoom — both work, pick whichever fits
    your muscle memory.
  - Cursor changes to `grab` while Space is held so the gesture
    affordance is visible.
  - Space typed into a text field still produces a space (form-
    input guard); alt-tabbing mid-pan doesn't leave the key
    stuck (window-blur reset).

- **#24 — Delete a chat message.** Hover any row in the AI Chat
  panel → small ✕ appears top-right → click → confirm → message is
  removed from `series.db` and the next assistant turn doesn't
  carry it forward. Works on user, assistant, and tool-result
  rows. A backend "undo from this point" op also ships under the
  hood (deletes a message + every reply that came after) but the
  UI button for that is queued for v1.3.x's command-palette.

- **#30 — `.koharuproj` file association on Windows.** Double-
  clicking a Series Project manifest in Explorer now launches
  Koharu (previously: "How do you want to open this file?").
  Registered alongside the existing `.khr` association under
  `HKCU\Software\Classes`. Note: this v1.2.1 fix LAUNCHES Koharu
  on double-click; auto-loading the picked project on launch needs
  a positional-arg parser + tauri-plugin-single-instance and is
  queued for v1.3.x. The `.khr` association has had the same
  limitation since day one.

## 🛠 Internals

- New SQLite helpers `chat::delete()` + `chat::delete_from()` in
  `koharu-project`.
- New RPC methods `chat_message_delete` + `chat_messages_delete_from`
  exposed via MCP so external agents can use them today.
- `register_khr()` refactored into `register_extension()` helper +
  combined `register_file_associations()` entry point.

## 📦 Builds

Same per-GPU split as 1.2.0: **Turing / Ampere / Ada / Blackwell**.
The split remains necessary while `bindgen_cuda` 0.1.6 can't accept
a multi-cap build string; revisit when upstream's PTX-JIT path is
backported in 1.3.x.

Pick the binary matching your card:
- **Turing** — RTX 20-series, GTX 16-series, Quadro RTX
- **Ampere** — RTX 30-series, A-series
- **Ada** — RTX 40-series
- **Blackwell** — RTX 50-series

---

**Full changelog**: see [CHANGELOG.md](https://github.com/EarthWL/koharu-th/blob/main/CHANGELOG.md#121--2026-05-19)

**Upgrade path from 1.2.0**: drop-in. No DB migration, no settings
reset.

**Thanks** to [@HetCreep](https://github.com/HetCreep) for filing
clear, reproducible bug reports + concrete feature asks across the
issue tracker — most of this release came from there.
