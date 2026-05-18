# Contributing to koharu-th

Thanks for your interest! This is a Thai-focused fork of [mayocream/koharu](https://github.com/mayocream/koharu) maintained by [@EarthWL](https://github.com/EarthWL) — a manga series-translation studio in Rust + Tauri + Next.js.

This file describes how patches, features, and bug reports flow through the fork. The conventions are deliberately light: the project is small enough that everyone's reading every diff.

---

## TL;DR

- **Open an issue first** for anything non-trivial. It's easier to align on scope before code lands.
- **Pull Requests are welcome**, but please keep commits **atomic** — one self-contained change per commit. Big "everything together" branches get cherry-picked into smaller commits during review, which works but slows merging.
- **Direct push to `main`** is the maintainer's normal workflow. External contributors send PRs.
- **AI-generated patches are welcome** as long as a human has read the diff and understands what it does.

If something here is ambiguous, file an issue and we'll clarify (and update this doc).

---

## Reporting bugs / suggesting features

Use the [issue templates](https://github.com/EarthWL/koharu-th/issues/new/choose):

- **🐛 Bug report** — wrong output, crashes, UI regressions. Include GPU + OS + version.
- **✨ Feature request** — explain the workflow pain first, then propose a fix.
- **💬 Question** — usage / design questions. Often turn into README additions.

Blank issues are disabled to keep the queue triage-able. If your report doesn't fit any template, open an Issue with the Feature Request template and we'll re-label.

---

## Sending pull requests

### Before you start

1. **Open an issue** describing what you want to change and wait for a quick reply. A 5-minute back-and-forth before coding saves both sides 30 minutes after.
2. **Check the [Roadmap section in README.md](https://github.com/EarthWL/koharu-th/blob/main/README.md#roadmap)** — your feature might already be planned for a specific release.
3. **Fork the repo** from `main`. We don't maintain long-lived release branches; `main` is the source of truth.

### Commit conventions

Loose, not Conventional Commits strict. The subject line should answer "what changes for users / the next maintainer":

- Prefer present tense: `fix: OCR collapses Latin word boundaries` over `Fixed OCR collapsing words`.
- Optional prefix: `fix:` / `feat:` / `chore:` / `perf:` / `docs:` / `tune:` — helps when scanning `git log --oneline`, no commit hook enforces it.
- Body: explain **why** the change was needed, not just **what** the diff shows. Link any related issue with `closes #N` so it auto-closes on merge.
- **Atomic commits**: if you're adding two unrelated improvements, split them. We'll ask you to split anything bundled.

### What we cherry-pick vs decline

Large external PRs are reviewed commit-by-commit and merged via cherry-pick batches grouped by theme. This means:

- **Atomic commits get merged faster.** A 5-line `fix(rpc): register update_text_block` is in within hours; a 600-line "fix: bunch of things" is held up while we figure out what to keep.
- **Don't `git rebase main` on a PR branch unless we ask** — it creates conflict noise that's hard to bisect across many small commits.
- **Don't include `node_modules/`, `target/`, or `release-out/` in the diff.** Our `.gitignore` covers these; if your PR's stat shows hundreds of files, double-check.

We will **decline** PRs that:

- Rename / move user-data folders without a migration script (a recent example: renaming `%LOCALAPPDATA%\Koharu` would have orphaned 1-3 GB of cached models for every existing user).
- Bundle 5+ unrelated features in one commit (`squash` doesn't help here — bisecting future regressions becomes painful). Split + re-submit.
- Add a build-time dependency on a non-bun package manager (we use `bun` + `cargo`, no npm/pnpm/yarn).

---

## Development

### Prerequisites

- Windows 10/11 (primary), macOS or Linux (build-from-source)
- [Bun](https://bun.sh) ≥ 1.0
- Rust toolchain (stable) via [rustup](https://rustup.rs)
- For NVIDIA GPU builds: CUDA 13.1+ (auto-downloaded as runtime dylibs on first launch — see [README → GPU acceleration](https://github.com/EarthWL/koharu-th/blob/main/README.md#gpu-acceleration))

### First-time setup

```bash
git clone https://github.com/EarthWL/koharu-th.git
cd koharu-th
bun install
```

### Dev loop

```bash
bun run dev
```

This wraps `tauri dev` and auto-detects your GPU's CUDA compute capability via `nvidia-smi`. Hot-reloads frontend + recompiles Rust on save.

### Build a release artifact for your GPU

```bash
bun run build
```

Produces a single NSIS installer at `target/release/bundle/nsis/koharu_<version>_x64-setup.exe` matching your local GPU's compute cap.

### Build all 4 GPU families (Turing/Ampere/Ada/Blackwell)

```bash
bash scripts/build-all-gpus.sh
```

Loops the build with `CUDA_COMPUTE_CAP=75|86|89|120` and renames artifacts into `release-out/`. Takes ~15-20 min (Rust deps cached between runs).

### Tests

```bash
cargo test --workspace
```

Frontend uses TypeScript's `tsc --noEmit -p ui` as a lint pass. There's no runtime test suite for the UI yet.

---

## Code style

- **Rust**: `cargo fmt` before committing. We don't enforce a clippy lint level; warnings during build are OK.
- **TypeScript / TSX**: existing files set the prevailing style — match the surrounding code (no Prettier config enforced). Avoid Tailwind class soup that wraps past 100 chars when a `cn(...)` helper would read better.
- **Comments**: please comment **why**, not what. A wall of `// loops over blocks` is noise; `// Iterate in reverse so we can splice without index drift` is a debugging hint future-you will thank.

---

## Releases

Maintainer only — but for transparency:

1. Bump `[workspace.package].version` in `Cargo.toml`.
2. Update `CHANGELOG.md` with a new section.
3. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z — short summary"`.
4. Build artifacts: `bash scripts/build-all-gpus.sh` (produces 4 per-GPU `.exe` in `release-out/`).
5. `gh release create vX.Y.Z --repo EarthWL/koharu-th --notes-file release-out/RELEASE_NOTES.md release-out/*.exe`.
6. Push tag: `git push --tags`.

GitHub Actions is currently disabled (carry-over from private-fork days when matrix CI burned macOS minutes). Re-enable once upstream's PTX-JIT sync lands and we're back to one binary per platform — see Roadmap.

---

## Questions?

Open a [💬 Question issue](https://github.com/EarthWL/koharu-th/issues/new?template=question.yml) and tag it whatever feels right. We'll figure it out from there.
