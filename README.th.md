# Koharu-TH

[![Version](https://img.shields.io/badge/version-1.0.3-blue.svg)](https://github.com/EarthWL/koharu-th/releases)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Sub-crates: Apache 2.0](https://img.shields.io/badge/sub--crates-Apache--2.0-blue.svg)](LICENSE-APACHE)
[![Based on](https://img.shields.io/badge/based%20on-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [English](./README.md)
>
> **Manga series-translation studio** ที่ตั้งต้นจาก [mayocream/koharu](https://github.com/mayocream/koharu) 0.37.0. เริ่มจาก patch รองรับภาษาไทย, ตอนนี้กลายเป็น product แยกที่มี — SQLite ต่อ project เก็บ characters / glossary / TM / prompt templates / cost log, ระบบ LLM Profile 5 provider, AI Chat agentic ที่สรุปข้อมูลจาก wiki URL เข้าโปรเจคให้ได้, และ MCP server ~60 tools สำหรับ external agents. Versioning แยกอิสระจาก upstream (เริ่ม semver ใหม่ที่ 1.0.0).

โปรแกรมแปลมังงะด้วย ML เขียนด้วย **Rust**

ภายในใช้ [candle](https://github.com/huggingface/candle) สำหรับ ML inference ความเร็วสูง และ [Tauri](https://github.com/tauri-apps/tauri) สำหรับ GUI ทุกส่วน native เขียนด้วย Rust

> [!NOTE]
> Koharu รัน ML models บน **เครื่อง local** เป็นค่าเริ่มต้น ถ้าคุณบันทึก Cloud LLM Profile แล้วกด Apply (OpenAI / Claude / Gemini / OpenRouter / Local LLM server) ข้อความที่แปลจะถูกส่งไป provider นั้น — ส่วนอื่นยังรันบนเครื่องอยู่ ต้อง opt-in ผ่าน Profiles sidebar tab เท่านั้น

---

![screenshot](assets/koharu-th-screenshot-ex.png)

## สิ่งที่ต่างจาก upstream

| มิติ | Upstream | Koharu-TH |
|---|---|---|
| Workflow | เปิด `.khr` → detect → OCR → inpaint → แปล → render | **เปิด Project → Chapter (folder source+render) → แปลพร้อม context ทั้ง series → log cost → TM** |
| State | In-memory + ไฟล์ .khr | + per-project SQLite (`series.db`) มี 11 tables |
| LLM | Local 7B GGUF อย่างเดียว | Local + **5 cloud profile types** (OpenAI / Claude / Gemini / OpenRouter / Local LLM server) พร้อม live model search |
| Sidebar | Page thumbnails | **8 tabs**: Pages · Chapters · Project · Characters · Glossary · Prompts · Profiles · AI Chat |
| Renderer | CJK fonts | + Thai-aware fonts + text-block rotation + line-height / letter-spacing / vertical-align / min-font-size + overflow warnings |
| MCP server | 25 tools | **~60 tools** ครอบคลุม project ทั้งหมด + agentic web fetch |
| AI assistant | — | **AI Chat ในแอป** — streaming + multi-modal (แนบรูป), native function-calling 4 providers, 10 slash commands |
| Translation memory | — | exact / Jaccard / **semantic (vector embeddings)** + TMX 1.4 import/export |
| Export | single page | **CBZ multi-chapter** พร้อม ComicInfo.xml |
| Cost tracking | — | log ต่อ call + **dashboard** (by profile / chapter / day / use case) |
| Power-user | — | **⌘K command palette** — jump chapter / profile / export / slash |

## ฟีเจอร์หลัก

> ดูสรุปฟีเจอร์ทั้งหมดแบบกระชับใน [FEATURES.md](FEATURES.md) ส่วนด้านล่างเจาะลึกอันใหญ่ๆ

### Series Project (workspace ต่อ folder)

แต่ละเรื่องที่แปลเป็น **project folder** มี SQLite database ของตัวเอง — prompt แปลจะ assemble context จาก database นี้ทุกครั้ง ทำให้ชื่อตัวละคร / ชื่อท่า / คำลงท้าย / โทน คงเส้นคงวาตลอดทุก chapter

```
MyManga/
├── series.koharuproj          # manifest (JSON เล็กๆ)
├── series.db                  # SQLite — characters, glossary, TM, prompts, profiles, cost log, chat
├── chapters/
│   ├── ch01/
│   │   ├── source/            # ไฟล์ต้นฉบับที่นำเข้า (.png / .jpg / .khr)
│   │   └── render/            # ไฟล์ render สุดท้าย
│   └── ch02/...
└── reference/  assets/  export/
```

เปิด **Welcome screen** (auto ตอนเปิดแอป) → **New Project** → กรอก series metadata → สร้าง chapter → import รูป → แปล หรือ **Open** project ที่มีอยู่

### Cloud LLM Profiles

LLM provider config ทั้งหมดอยู่ใน **Profiles sidebar tab** (ไม่ใช่ใน Settings) บันทึก profile หลายตัวได้ สลับใช้คลิกเดียว

| Provider | Model list | หมายเหตุ |
|---|---|---|
| **OpenAI** | live `/v1/models` กรอง chat models | แก้ base URL เพื่อใช้ OpenAI-compatible (Together, DeepSeek, vLLM, …) ได้ |
| **Claude** | live `/v1/models` (anthropic-version + dangerous-direct-browser-access) | claude-3.5 / 4 / 4.5 series |
| **Gemini** | live `/v1beta/models` กรองเฉพาะ `generateContent` | แสดง token limits |
| **OpenRouter** | live `/v1/models` browse ได้โดยไม่ต้องมี key | แสดงราคา + context length ต่อ model |
| **Local LLM** | `/api/tags` (Ollama) หรือ `/v1/models` (LM Studio / llama.cpp) | ไม่ต้องมี key, auto-detect จาก URL suffix |

Model picker ทุกตัวค้นได้ — พิมพ์ส่วนใดของ model id ก็เจอ API keys เก็บใน **OS keyring** (ไม่ได้เก็บใน DB)

**LLM badge** บน Toolbar ใช้เลือก profile ที่ active ได้โดยไม่ต้องออกจาก canvas

### AI Chat (agentic, multi-modal, streaming)

Sidebar tab ที่คุยกับ **active profile** ผ่าน native function-calling รองรับทั้ง 4 cloud providers มี tools สำหรับทุก project entity (series_meta / chapters / characters / glossary / TM / prompt_render) บวก server-side `web_fetch_url` ที่ bypass browser CORS

- **Streaming responses** + ปุ่ม Stop — token ไหลออกมาทันที (OpenAI / OpenRouter / Local SSE · Anthropic content_block_delta · Gemini :streamGenerateContent)
- **แนบรูป** — แนบหน้า canvas ปัจจุบัน (1 คลิก) หรือ upload รูปจากเครื่อง auto-downsize ≤1024px JPEG q85 ก่อนส่ง ส่งเป็น multi-modal blocks ไปทุก provider, เก็บค้างใน chat history

**Slash commands** (autocomplete กด `/`):
- `/fetch-wiki <url>` — ดึงหน้า Fandom/wiki, เสนอ update synopsis + characters + glossary
- `/draft-synopsis`, `/draft-style-notes` — brainstorm context fields
- `/suggest-character <name>` — เสนอ Thai name / speech style / role
- `/extract-glossary <text>` — ดึง terms จาก source text
- `/summarize-chapter [id]` — สร้าง chapter summary (ป้อน rolling context)
- `/preview-prompt <text>` — แสดง prompt จริงที่ใช้แปล
- `/qc-consistency` — scan chapter ที่เปิดอยู่หา glossary/character mismatches แล้วเสนอวิธีแก้
- `/tm-semantic <text>` — semantic TM lookup ผ่าน embeddings (เจอ paraphrase)
- `/check-thai` — รีวิวภาษาไทย: สะกด/grammar/naturalness + apply fixes อัตโนมัติ

Chat history เก็บต่อ project ใน `series.db` (`chat_messages` table) panel แสดง 50 messages ล่าสุด + page back ได้

### Command palette (Cmd+K)

⌘K / Ctrl+K เปิด palette global — jump ไป chapter, สลับ profile, export CBZ, เปิด settings, copy slash command ลง chat input

### Prompt template engine

Prompt แปลเป็น **Handlebars templates** render ตอน call จริงพร้อม:

- `{{series_title}}`, `{{series_synopsis}}`, `{{genre}}`, `{{target_audience}}`
- `{{tone}}`, `{{formality}}`, `{{style_notes}}`
- `{{source_language}}` → `{{target_language}}`
- `{{characters}}` — ตัวละครหลัก (aliases, speech style, role)
- `{{glossary_entries}}` — **smart-filter** เฉพาะคำที่อยู่ใน source text ตอนนี้
- `{{rolling_summary}}` — auto-fetch summary ของ N chapters ก่อนหน้า (default 2)
- `{{source}}` — text block ที่กำลังแปล

แก้ template ที่ **Prompts tab** มี default template สำหรับ use cases: `translate`, `extract_entities`, `summarize_chapter`

### Translation memory

- **Exact-match** + **Jaccard fuzzy** (threshold ปรับได้, default 0.85)
- **Semantic / vector search** ผ่าน embeddings (cosine similarity, top-K) — เจอ paraphrase ที่ fuzzy match พลาด ปุ่ม backfill ใน Project tab เพื่อ embed entries เดิมด้วย active profile (`text-embedding-3-small` บน OpenAI-compat, `text-embedding-004` บน Gemini)
- เจอ TM = ข้าม cloud call
- **TMX 1.4 import / export** — ใช้ TM ร่วมกับ Trados / OmegaT / MemoQ / CAT tool อื่น

### Cost tracking + dashboard

- ทุก LLM call log ใน `llm_call_log` พร้อม token counts, duration, success/failure, estimated USD cost
- **Dashboard ใน Project sidebar tab**: headline spend / call / token stats + bar charts (30 วันล่าสุด, by profile, by chapter, by use case) ตั้ง per-1M pricing บนแต่ละ profile ได้ตัวเลข $ แม่นยำ

### Multi-chapter export

- **CBZ export** ต่อ chapter พร้อม `ComicInfo.xml` sidecar (Kavita / Komga / YACReader / mobile reader) ใช้รูปจาก `<chapter>/render/` ถ้ามี, fallback ไป `source/` กดปุ่ม archive ที่ chapter row หรือผ่าน Cmd+K palette

### Quality control

- **Bubble-fit warnings** — text-block panel แสดง badge สี amber `TIGHT` / rose `OVERFLOW` เมื่อ translation มีโอกาสล้นฟอง (heuristic: chars × estimated 18pt glyph area เทียบ bubble area + Thai/source length ratio)
- **Consistency checker** — `/qc-consistency` slash scan ทุก translated block เทียบ glossary + character names (รวม aliases) แสดง mismatches เป็นตาราง + เสนอแก้ผ่าน `update_text_block` หลัง approve

### ฟีเจอร์ renderer ที่เพิ่มสำหรับไทย

- Thai-aware font fallback (Leelawadee UI / Tahoma / Thonburi / Noto Sans Thai ตาม OS)
- Per-block controls: **line-height**, **letter-spacing**, **min font size** (auto-fit floor), **vertical-align**, **manual font size**, **Thai preset** button
- **Text-block rotation** (`rotation_deg`) สำหรับฟองไม่เป็นสี่เหลี่ยม + SFX แบบมีสไตล์

### MCP server (สำหรับ external agents)

~60 tools ที่ `/mcp` ครอบคลุม project ทั้งหมด — project lifecycle, chapters, characters, glossary, prompt rendering, translation memory, provider profiles, LLM cost log, รวมถึง agentic `web_fetch_url` External agent (Claude Desktop, Cursor, ฯลฯ) ทำ workflow **Project → Chapters → Glossary → Translate → TM** ได้ครบโดยไม่ต้องเปิด GUI

```bash
koharu --port 9999       # macOS / Linux
koharu.exe --port 9999   # Windows
```

ชี้ MCP-capable client ไปที่ `http://localhost:9999/mcp`

## การใช้งาน

### Hot keys

- <kbd>Ctrl</kbd> + Mouse Wheel: Zoom in/out
- <kbd>Ctrl</kbd> + Drag: Pan canvas
- <kbd>Del</kbd>: ลบ text block ที่เลือก
- <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>: เปิด command palette

### Headless mode

```bash
koharu --port 4000 --headless        # macOS / Linux
koharu.exe --port 4000 --headless    # Windows
```

Web UI ที่ `http://localhost:4000` MCP server ยัง serve ที่ `/mcp`

### File association

บน Windows ไฟล์ `.khr` จะ associate กับ Koharu อัตโนมัติ — double-click เปิดในโหมด standalone (ไม่ต้องมี project)

### Bundled fonts

Koharu-TH สร้าง `<app-data>/Koharu/fonts/` ตอนเปิดครั้งแรก (Windows: `%LOCALAPPDATA%\Koharu\fonts`, macOS: `~/Library/Application Support/Koharu/fonts`, Linux: `~/.local/share/Koharu/fonts`) วางไฟล์ `.ttf` / `.otf` / `.ttc` ลงไป → register พร้อม system fonts ตอนเปิดครั้งต่อไป มีประโยชน์สำหรับ Thai (เช่น [Noto Sans Thai](https://fonts.google.com/noto/specimen/Noto+Sans+Thai))

## GPU acceleration

รองรับ CUDA และ Metal

### CUDA

Koharu bundle CUDA toolkit 13.1 + cuDNN 9.19; dylibs ถูก extract ไป application data directory ตอนเปิดครั้งแรกอัตโนมัติ

> [!NOTE]
> ตรวจสอบให้แน่ใจว่า NVIDIA driver ล่าสุดติดตั้งแล้วผ่าน [NVIDIA App](https://www.nvidia.com/en-us/software/nvidia-app/)

รองรับ: NVIDIA GPU compute capability **7.5 ขึ้นไป** ดู [CUDA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus) และ [cuDNN Support Matrix](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/support-matrix.html)

### Metal

รองรับบน macOS Apple Silicon (M1, M2, ฯลฯ)

### CPU fallback

บังคับใช้ CPU:

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

Models ดาวน์โหลดอัตโนมัติตอนเปิดครั้งแรก Safetensors weights host ที่ [Hugging Face](https://huggingface.co/mayocream)

### Local LLMs

Koharu รองรับ quantized LLMs format GGUF ผ่าน [candle](https://github.com/huggingface/candle) เลือก preselect ตาม system locale

**English:**

- [vntl-llama3-8b-v2](https://huggingface.co/lmg-anon/vntl-llama3-8b-v2-gguf) — ~8.5 GB Q8_0, ต้อง ≥10 GB VRAM; ดีสุดเมื่อต้องการความแม่นยำ
- [lfm2-350m-enjp-mt](https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT-GGUF) — เบามาก (~350M Q8_0); รันบน CPU / GPU low-memory ได้

**Chinese:**

- [sakura-galtransl-7b-v3.7](https://huggingface.co/SakuraLLM/Sakura-GalTransl-7B-v3.7) — ~6.3 GB, ลง 8 GB VRAM ได้
- [sakura-1.5b-qwen2.5-v1.0](https://huggingface.co/shing3232/Sakura-1.5B-Qwen2.5-v1.0-GGUF-IMX) — เบา (~1.5B Q5KS) สำหรับ 4–6 GB GPU / CPU

**Thai** และภาษาอื่น:

- [hunyuan-7b-mt-v1.0](https://huggingface.co/Mungert/Hunyuan-MT-7B-GGUF) — ~6.3 GB ลง 8 GB VRAM ได้
- หรือบันทึก **Cloud Profile** (Profiles sidebar tab) — แนะนำสำหรับงานไทย เพราะ local 7B/8B มักอ่อนไทยกว่า CJK

LLMs ดาวน์โหลดตอนเลือกใช้

## Installation

Fork นี้ไม่มี pre-built binary — build จาก source (ดูด้านล่าง) หรือใช้ release จาก upstream [mayocream/koharu releases](https://github.com/mayocream/koharu/releases/latest) ถ้าไม่ต้องการฟีเจอร์ series-project / AI chat / multi-profile

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (1.92 ขึ้นไป)
- [Bun](https://bun.sh/) (1.0 ขึ้นไป)

### Install dependencies

```bash
bun install
```

### Build

```bash
bun run build
```

ไฟล์ที่ build ได้อยู่ใน `target/release`

### Dev loop

```bash
bun run dev    # Tauri dev auto-rebuild Rust + Next HMR ฝั่ง UI
```

### Tests

```bash
cargo test -p koharu-project -p koharu-api
```

### Sync กับ upstream

Fork นี้ไม่ track upstream แบบ linear แล้ว — restructure เป็น project-folder + sidebar tabs + crate ใหม่ (`koharu-project`) ทำให้ rebase ตรงๆ ชนทุกที่. แนะนำ cherry-pick เฉพาะตัวที่ต้องการ:

```bash
git fetch upstream
git log <last-synced>..upstream/main --oneline --grep="^fix"   # หา bug fix candidates
git show <sha>                                                  # ดูก่อน apply
git cherry-pick -x <sha>                                        # บันทึก SHA เดิมใน commit body
```

ตอน backport ให้ cite upstream SHA ใน commit body (ดูตัวอย่างเดิมด้วย `git log --grep="cherry-picked from"`) เพื่อให้ audit trail ติดตามได้

## Roadmap

ไม่ใช่สัญญา แค่สิ่งที่กำลังพิจารณา

**Shipped — 1.1.x (detector + OCR engine + storage management):**

- [x] **Anime Text YOLO** เป็น opt-in detector ทางเลือก (`mayocream/anime-text-yolo`) — จับ SFX, ตัวอักษรประดับ, ข้อความนอก bubble ที่ default detector พลาด. 5 size variants N → X (~10 MB → ~250 MB), lazy-load ตอนที่เลือก
- [x] **Confidence slider** สำหรับ Anime YOLO ใน Settings (0.05 – 0.95, default 0.25). มี Reset link เมื่อค่าออกจาก default
- [x] **ปุ่ม Detect / OCR ตัวเดี่ยวเคารพ engine preference** — ก่อนหน้านี้กดแล้วใช้ backend default ตลอด ไม่ว่า Settings จะเลือกอะไร. ตอนนี้ `DetectPayload` / `OcrPayload` ส่งค่าครบทาง
- [x] **Cloud Vision OCR ส่ง per-bubble crops** แทนภาพเต็มหน้า + bbox list — รุ่นเล็กอย่าง `gemini-2.5-flash-lite` จะ map text ไป index ผิดไม่ได้อีก แม้ user ลบ box หลายอันแล้ว
- [x] **Settings → Storage panel** แสดงทุก on-disk artefact ที่ koharu จัดการนอก project folders (CUDA libs, model cache, custom fonts, recent-projects list) พร้อม size + path + ปุ่ม Clear แต่ละ row + "Preferences → Reset to defaults"
- [x] **Windows NSIS uninstaller hook** ถามว่าจะลบ `%LOCALAPPDATA%\Koharu\` (cached models + CUDA libs) ด้วยตอน uninstall ไหม. มี 4 safety belts: refuse ถ้า `$LOCALAPPDATA` ว่าง, ต้องมี marker file ของเราก่อนถึงจะลบ, ลบเฉพาะชื่อ subfolder (ไม่ recursive ที่ parent), ลบ parent ด้วย `RMDir` non-recursive. Blast radius bounded — กันบั๊กแบบที่ค่ายเกมไทยเคยทำพลาด (uninstaller ลบทั้งไดรฟ์)

**Shipped — 1.0.3 (chat polish + portable release แรก):**

- [x] Markdown rendering ใน AI Chat (tables, code fences, lists, blockquotes — renderer เดียวกันสำหรับ streaming + persisted)
- [x] Chat text เลือก / copy ได้ (เดิม global `select-none` ของ canvas)
- [x] Token usage log ทุก chat round (`use_case='chat'` ใน cost dashboard, per-provider parsing)
- [x] Portable Windows release — `.msi`, `.exe` (NSIS), `.zip` artifacts; path local ของ maintainer scrub ออกจาก binary

**Shipped — Tier 1 (UX wins ใน AI Chat):**

- [x] Vision ใน AI Chat — แนบหน้า canvas ปัจจุบันหรือรูปอื่น, multi-modal blocks ครบ 4 providers
- [x] Streaming chat responses (SSE token deltas + ปุ่ม ⏹ Stop ผ่าน AbortController)

**Shipped — Tier 2 (workflow polish):**

- [x] Cost dashboard — by profile / chapter / 30 วัน / use case อยู่ใน Project sidebar
- [x] QC consistency checker — `qc_chapter_consistency` tool + `/qc-consistency` slash (scan glossary + character mismatches เสนอแก้)
- [x] Thai bubble-fit warnings — badge amber/rose ในหัว text-block panel เมื่อข้อความ tight หรือ overflow ฟอง
- [x] Auto-extract characters + glossary — ปุ่ม wand ที่ chapter row: เปิด chapter → OCR ทุกหน้า → extract → bulk-add

**Shipped — Tier 3 (interchange + power-user):**

- [x] CBZ multi-chapter export พร้อม `ComicInfo.xml` (Kavita / Komga / YACReader compatible)
- [x] Cmd+K / Ctrl+K command palette — jump chapter, สลับ profile, export, slash commands
- [x] Vector-embedding TM + cosine semantic search + ปุ่ม backfill + `/tm-semantic` slash
- [x] TMX 1.4 import/export (Trados / OmegaT / MemoQ interchange)
- [x] Thai spell / grammar check ผ่าน `/check-thai` slash

**Shipped ก่อนหน้านี้:**

- [x] Series project format + glossary + TM + custom prompt templates
- [x] OpenRouter + Local LLM · 5-provider live model search
- [x] OS keyring สำหรับ API keys
- [x] Bundled-font support สำหรับไทย
- [x] Rolling-context summaries จาก chapter ก่อนหน้า
- [x] Folder-based chapters (`source/` + `render/`) + auto-wrap legacy single-file
- [x] MCP server ~60 tools ครอบคลุม project ทั้งหมด

**1.2.x — วางแผนไว้ (sync กับ upstream backend changes):**

- [ ] **PTX JIT สำหรับ CUDA** — adopt upstream's single-binary approach (compute 8.0 base + forward-JIT PTX) เพื่อ ship installer เดียวสำหรับ RTX 30xx/40xx/50xx แทน per-generation. Trade-off: RTX 20xx (Turing 7.5) จะหลุดจาก GPU acceleration — fall back CPU
- [ ] **Vulkan backend** — pull จาก upstream สำหรับ OCR + local LLM. AMD / Intel GPUs ได้ partial acceleration โดยไม่ต้อง ZLUDA
- [ ] **ZLUDA (experimental, Windows)** — re-add upstream's CUDA-compat layer สำหรับ AMD บน Windows. เราเอาออกตอน fork; เอากลับมาเปิดทาง AMD users ให้ Detect / Inpaint accelerated ด้วย
- [ ] **GitHub Actions release matrix** — ปิดอยู่เพื่อประหยัด macOS minutes (10×) และเพราะ upstream's matrix CI ยิงทุก push. เปิดใหม่พร้อม per-cap split job เมื่อ upstream PTX path landed (กลับเป็น binary เดียวต่อ platform)

**ยังไม่ ship (อื่นๆ ที่พิจารณา):**

- [ ] Batch chapter translation queue (background worker, progress UI)
- [ ] Pre-built macOS releases (code compile + มี custom Metal kernels อยู่ แต่ยังไม่ distribute)
- [ ] Pre-built Linux releases (CI groundwork พร้อม)
- [ ] Cloud sync สำหรับ project folders (Google Drive / Dropbox / S3)
- [ ] Multi-project workspace + shared TM / glossary pool ข้าม series
- [ ] Translator collaboration (multi-user, comments, approve workflow)
- [ ] Thai OCR (ตอนนี้ JP-only ผ่าน manga-ocr; Cloud Vision OCR ใช้กับไทยได้แล้ว)
- [ ] Cloud Vision OCR ใน batch queue (ตอนนี้ frontend dispatch only; queue fall back MIT-48px)

## ข้อจำกัดที่ทราบ

- **Anthropic ใน pure-browser headless mode** — CORS block direct calls; desktop Tauri build เพิ่ม `anthropic-dangerous-direct-browser-access: true` ทำงานได้ปกติ
- **OpenAI JSON mode** gated ด้วย `model.includes('gpt')` Model ใหม่ของ OpenAI (`o3`, `o4`) และ OpenRouter-routed models ส่วนมากข้าม JSON mode — handle ได้ แต่คุณภาพต่างกันตาม model
- **Thai font fallback** ขึ้นกับ OS มี font ใน list (Leelawadee UI / Tahoma บน Windows · Thonburi / Krungthep บน macOS · Noto Sans Thai บน Linux) ถ้าไม่มี ให้วาง Thai TTF ลงใน bundled-fonts directory
- **Translation result streaming** (path แปลทีละ block) ยังรอจน response เสร็จก้อน — AI Chat stream แล้ว, แต่ translate per-block ยัง
- **OCR รองรับเฉพาะ JP** — model ตอนนี้คือ manga-ocr; Thai OCR ยังไม่รองรับ
- **Semantic TM embeddings** ต้องมี key บน OpenAI-compatible profile (OpenAI / OpenRouter / Local / Gemini). Anthropic ไม่มี native embeddings API

## Credits

Build บน [mayocream/koharu](https://github.com/mayocream/koharu) งาน ML pipeline / Tauri shell / renderer ทั้งหมดเป็นของ upstream — ช่วย support upstream ได้ที่:

- [GitHub Sponsors](https://github.com/sponsors/mayocream)
- [Patreon](https://www.patreon.com/mayocream)

<a href="https://github.com/mayocream/koharu/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=mayocream/koharu" />
</a>

## License

Koharu application licensed under [GNU General Public License v3.0](LICENSE-GPL) Fork นี้สืบทอด license เดียวกัน

Sub-crates ของ Koharu licensed under [Apache License 2.0](LICENSE-APACHE)
