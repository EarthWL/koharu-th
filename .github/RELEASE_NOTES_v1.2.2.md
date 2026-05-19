# Koharu-TH v1.2.2 — defensive HF cache path fix (#34)

Single-fix patch on top of v1.2.1. Defensive cleanup for one bug
report from [@HetCreep](https://github.com/HetCreep) — no new
features, no schema changes, no API churn, no behaviour change for
the vast majority of users.

> If you're not seeing model-download errors on Windows, the
> upgrade still makes sense (path layout cleanup + auto-migration
> of your existing cache), but there's no urgency. Skip-able.

---

## 🐛 Fixed

- **#34 — Windows `os error 3` on first-time HuggingFace model
  downloads.** HF's cache layout under our namespace burns ~100
  chars on its own before the filename
  (`models--<org>--<repo>\snapshots\<40-hex>\<filename>`); on long
  usernames + nested repo names the full path occasionally trips
  Windows' 260-char MAX_PATH legacy limit, producing a "system
  cannot find the path specified" crash during first download.

  Renamed our HF cache namespace from
  `%LOCALAPPDATA%\Koharu\models\` to `%LOCALAPPDATA%\Koharu\hf\` —
  saves 7 chars vs MAX_PATH, enough to rescue paths that hover near
  the edge. Migration is automatic on first v1.2.2 launch via an
  atomic `fs::rename` of the legacy cache to the new location —
  no re-download, no settings reset.

  The NSIS uninstaller recognises **both** the new path and the
  legacy `models\` path, so an upgrade-without-launch followed by
  uninstall still cleans the legacy folder.

  **Caveat**: original report had no reproduction log, and the
  install-path baseline on a standard user account is ~160 chars
  (well under 260). This is a defensive improvement, not a fix for
  a confirmed reproduce. A heavier Tauri-manifest `longPathAware`
  fix (which would handle paths past 260 globally on systems with
  the Windows registry flag set) is deferred — Tauri 2.x config
  schema doesn't expose the field, so it'd need a `build.rs`
  custom manifest emitter heavier than this patch warrants. Will
  revisit if a real reproduce comes in.

## 🛠 Internals

- `migrate_legacy_model_cache()` in `koharu/src/app.rs` — runs at
  startup before `set_cache_dir`. Three-way outcome:
  legacy-populated + modern-empty → `fs::rename`; both populated
  → log warning + leave both (shouldn't happen in practice but
  defensive); rename fails → log + continue with new path (hf-hub
  re-downloads).
- `LEGACY_MODEL_ROOT` constant references the v1.2.1-and-earlier
  path from a single source so the migration helper and the
  uninstaller hook can't drift.

## 📦 Builds

Same per-GPU split as v1.2.0/v1.2.1: **Turing / Ampere / Ada /
Blackwell**. Pick the binary matching your card:

- **Turing** — RTX 20-series, GTX 16-series, Quadro RTX
- **Ampere** — RTX 30-series, A-series
- **Ada** — RTX 40-series
- **Blackwell** — RTX 50-series

The split remains necessary while `bindgen_cuda` 0.1.6 can't
accept a multi-cap build string; revisit when upstream's PTX-JIT
path is backported.

---

**Full changelog**: see [CHANGELOG.md](https://github.com/EarthWL/koharu-th/blob/main/CHANGELOG.md#122--2026-05-19)

**Upgrade path from v1.2.1**: drop-in. Cache auto-migrates on
first launch; no manual steps. Your settings, projects, and
models stay put.

**Thanks** to [@HetCreep](https://github.com/HetCreep) for raising
the MAX_PATH concern — defensive improvements like this one keep
edge-case users out of crash territory before the issue shows up
in the wild.
