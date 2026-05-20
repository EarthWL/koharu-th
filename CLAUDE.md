<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->

# Commit Message Format

All commits use English subject + Thai body (bullet points, no section headers):

```
<type>(<scope>): <english subject, imperative, ≤72 chars>

- รายละเอียดสิ่งที่เปลี่ยนแปลงเป็นภาษาไทย แบบละเอียด
- ระบุไฟล์/ฟังก์ชัน/logic ที่เกี่ยวข้อง
- อธิบาย behavior ใหม่ที่เกิดขึ้น
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `ci`, `clean`

## Commit Segregation Rule (การแยก Commit ตามกลุ่มงาน)
- **ห้ามมัดรวม**การแก้ไข/ฟีเจอร์ที่ไม่เกี่ยวข้องกันไว้ใน Commit เดียวกัน
- ให้พิจารณาและตรวจสอบทุกครั้งว่างานในแต่ละไฟล์เป็นประเภทเดียวกันหรือทำหน้าที่เชื่อมโยงกันหรือไม่
- หากไม่เกี่ยวข้องกันหรือคนละวัตถุประสงค์ (เช่น ตัวฟิวเจอร์ UX บล็อกข้อความ vs การจัด Prettier Formatting ไฟล์อื่น ๆ หรือการแก้บั๊กฐานข้อมูล) ให้**ซอยแยกออกเป็นคนละ Commit**
- ทำการ stage ไฟล์เฉพาะกลุ่มเพื่อทำ Commit ทีละส่วนอย่างเป็นระบบ

# Fork Structure (Koharu Project Topology)

```
EarthWL/koharu-th (official)
        │
        │ fork + sync fork
        ▼
HetCreep/main  <──── Sync fork ────>  EarthWL/main
        │
        │ + 100 custom commits
        ▼
HetCreep/feat/ux-improvements  ──→  PR #16  ──→  EarthWL/main
```

- **EarthWL/koharu-th**: official upstream (parent fork from mayocream/koharu)
- **HetCreep/main**: our fork's main, kept in sync with EarthWL/main
- **HetCreep/feat/ux-improvements**: working branch with ~100 custom commits, source of PR #16 → EarthWL/main
- Sync direction: EarthWL/main → HetCreep/main (one-way); PR #16 is the only upstream contribution path

# Pre-Operation Check (MANDATORY)

**Before starting ANY operation** (code fix, audit, feature, etc.), verify local is current with upstream:

```bash
rtk git fetch upstream
git log --oneline HEAD..upstream/main
```

- **No output** → local is current, proceed
- **Has commits** → upstream has new changes → run **Upstream Sync Workflow** below FIRST, then proceed with original task

Code is always read from `C:\Users\zxc59\source\repos\Koharu-TH` (local filesystem). Local must reflect upstream/main as its base before any work begins.

# Upstream Sync Workflow

When user says **"โค้ดแม่มีการอัพเดต หรือ Sync หรือ ซิงค์"**, execute these steps in order:

1. **Fetch upstream**
   ```bash
   rtk git fetch upstream
   ```

2. **Check pending commits** (commits not yet merged upstream)
   ```bash
   rtk git log upstream/main..HEAD
   ```

3. **Check for already-merged commits** (cherry-picks / equivalent patches upstream)
   ```bash
   git log --oneline HEAD..upstream/main
   ```
   If any local commits were already merged upstream, rebase them out:
   ```bash
   git rebase upstream/main
   ```

4. **Update PR #16 description** at https://github.com/EarthWL/koharu-th/pull/16
   - Read current commits via `git log --oneline upstream/main..HEAD`
   - Draft updated description grouped by category (features, fixes, perf, infra)
   - Present markdown for user to paste into GitHub PR

## Notes
- `CLAUDE.md` and `.rtk/` are in `.gitignore` — never commit them upstream
- Upstream remote: `https://github.com/EarthWL/koharu-th.git`
- Fork remote: `https://github.com/HetCreep/koharu-th.git`

# Audit → Fix → PR Workflow

When user runs an audit/inspection AND ends with **"ทำการ PR ทั้งหมด หรือ PR"** (or "PR ทุกจุด"), execute these steps in order for EACH finding:

## Step 1 — Fix the code

For every bug/risk found:
- Edit the exact file + line identified in the audit
- Keep the fix minimal and surgical (no unrelated changes)
- Commit with English subject + Thai bullet body:

```
fix(<scope>): <english description, imperative, ≤72 chars>

- อธิบายปัญหาที่แก้
- อธิบายวิธีแก้ที่เลือก
- ระบุไฟล์/ฟังก์ชันที่เปลี่ยน
```

- Push to `origin feat/ux-improvements`:
  ```bash
  rtk git push origin feat/ux-improvements
  ```

## Step 2 — Create GitHub issue for each fix

After pushing, create a Bug issue per finding via GitHub API (see pattern below).
- Title: `[Bug] <english description matching commit subject>`
- `what_happened`: Thai — อธิบายปัญหา, ผลกระทบ, และ fix ที่ทำไป

## Step 3 — Update PR #16 description

After all issues are created:
- Add `Closes #XX` links to the appropriate section in PR #16 description
- Bug fixes go into the existing sections (Infrastructure / Security / etc.) or a new **🐛 Bug Fixes** section if no existing section fits
- Use GitHub API (PowerShell UTF-8 pattern) to PATCH the PR body

## Notes
- Do all three steps per finding before moving to the next, OR batch all fixes first then batch issue creation then update PR once
- Never skip Step 3 — PR description must always reflect what's in the branch

# GitHub Issue Creation

When a new feature or bug is identified that warrants an issue, create it via GitHub API using `GITHUB_TOKEN`.

## Bug Report Pattern

```
title: "[Bug] <english description>"
version: "all" (or specific version if known)
os: "Other / not sure"
gpu: (select closest match, or "No GPU / CPU-only" if irrelevant)
what_happened: <ภาษาไทย — อธิบายสิ่งที่เกิดขึ้น สิ่งที่คาดหวัง และผลจริง>
```

## Feature Request Pattern

```
title: "[Feature] <english description>"
problem: <ภาษาไทย — ปัญหาที่พบในปัจจุบัน>
proposal: <ภาษาไทย — วิธีแก้ที่ต้องการ>
scope: (select from options below based on feature area)
```

### Scope Options (Where in the app)
- `AI Chat panel`
- `Translation pipeline / LLM`
- `Canvas / rendering`
- `Project / chapter management`
- `Settings / preferences`
- `Installer / distribution`
- `MCP server (external agent tools)`
- `Other / not sure`

## PowerShell API Call

```powershell
$token = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User")
$headers = @{
    Authorization = "Bearer $token"
    "User-Agent" = "koharu-th-claude"
    Accept = "application/vnd.github+json"
}

# Bug report body (use bug_report.yml template fields)
$body = @{
    title = "[Bug] <title>"
    body  = "### koharu-th version`nall`n`n### Operating system`nOther / not sure`n`n### GPU`n<gpu>`n`n### What happened`n<thai description>"
    labels = @("bug")
} | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri "https://api.github.com/repos/EarthWL/koharu-th/issues" -Method POST -Headers $headers -Body $bytes -ContentType "application/json; charset=utf-8"

# Feature request body
$body = @{
    title = "[Feature] <title>"
    body  = "### What's the problem`n<thai>`n`n### What would solve it`n<thai>`n`n### Where in the app does this live?`n<scope>"
    labels = @("enhancement")
} | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri "https://api.github.com/repos/EarthWL/koharu-th/issues" -Method POST -Headers $headers -Body $bytes -ContentType "application/json; charset=utf-8"
```

