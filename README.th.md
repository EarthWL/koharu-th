# Koharu-TH

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Upstream](https://img.shields.io/badge/upstream-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [English](./README.md)
>
> Fork ส่วนตัวของ [mayocream/koharu](https://github.com/mayocream/koharu) จากที่เริ่มต้นเป็นแค่ patch รองรับภาษาไทย ตอนนี้กลายเป็น **series translation studio** เต็มตัว — SQLite ต่อ project เก็บ characters / glossary / TM / prompt templates / cost log, ระบบ LLM Profile 5 provider, AI Chat agentic ที่สรุปข้อมูลจาก wiki URL เข้าโปรเจคให้ได้, และ MCP server ~60 tools สำหรับ external agents

โปรแกรมแปลมังงะด้วย ML เขียนด้วย **Rust**

ภายในใช้ [candle](https://github.com/huggingface/candle) สำหรับ ML inference ความเร็วสูง และ [Tauri](https://github.com/tauri-apps/tauri) สำหรับ GUI ทุกส่วน native เขียนด้วย Rust

> [!NOTE]
> Koharu รัน ML models บน **เครื่อง local** เป็นค่าเริ่มต้น ถ้าคุณบันทึก Cloud LLM Profile แล้วกด Apply (OpenAI / Claude / Gemini / OpenRouter / Local LLM server) ข้อความที่แปลจะถูกส่งไป provider นั้น — ส่วนอื่นยังรันบนเครื่องอยู่ ต้อง opt-in ผ่าน Profiles sidebar tab เท่านั้น

---

![screenshot](assets/koharu-screenshot-en.png)

## สิ่งที่ฉีกจาก upstream

| มิติ | Upstream | Koharu-TH |
|---|---|---|
| Workflow | เปิด `.khr` → detect → OCR → inpaint → แปล → render | **เปิด Project → Chapter (folder source+render) → แปลพร้อม context ทั้ง series → log cost → TM** |
| State | In-memory + ไฟล์ .khr | + per-project SQLite (`series.db`) มี 11 tables |
| LLM | Local 7B GGUF อย่างเดียว | Local + **5 cloud profile types** (OpenAI / Claude / Gemini / OpenRouter / Local LLM server) พร้อม live model search |
| Sidebar | Page thumbnails | **8 tabs**: Pages · Chapters · Project · Characters · Glossary · Prompts · Profiles · AI Chat |
| Renderer | CJK fonts | + Thai-aware fonts + text-block rotation + line-height / letter-spacing / vertical-align / min-font-size |
| MCP server | 25 tools | **~60 tools** ครอบคลุม project ทั้งหมด + agentic web fetch |
| AI assistant | — | **AI Chat ในแอป** ใช้ native function-calling, 7 slash commands, ใช้ tools ชุดเดียวกับ MCP |

## ฟีเจอร์หลัก

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

### AI Chat (agentic)

Sidebar tab ที่คุยกับ **active profile** ผ่าน native function-calling รองรับทั้ง 4 cloud providers มี tools สำหรับทุก project entity (series_meta / chapters / characters / glossary / TM / prompt_render) บวก server-side `web_fetch_url` ที่ bypass browser CORS

**Slash commands** (autocomplete กด `/`):
- `/fetch-wiki <url>` — ดึงหน้า Fandom/wiki, เสนอ update synopsis + characters + glossary
- `/draft-synopsis`, `/draft-style-notes` — brainstorm context fields
- `/suggest-character <name>` — เสนอ Thai name / speech style / role
- `/extract-glossary <text>` — ดึง terms จาก source text
- `/summarize-chapter [id]` — สร้าง chapter summary (ป้อน rolling context)
- `/preview-prompt <text>` — แสดง prompt จริงที่ใช้แปล

Chat history เก็บต่อ project ใน `series.db` (`chat_messages` table) panel แสดง 50 messages ล่าสุด + page back ได้

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

### Translation memory + cost log

- Exact-match + **Jaccard fuzzy** TM lookup (threshold ปรับได้, default 0.85)
- เจอ TM = ข้าม cloud call ไปเลย
- ทุก LLM call log ใน `llm_call_log` พร้อม token counts, duration, success, USD cost — `llmCostStats` aggregate ให้ (UI dashboard ยังไม่มี)

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

```bash
git fetch upstream
git diff upstream/main         # ดูว่าฉีกไปเยอะแค่ไหน (เยอะแล้ว)
```

Rebase ตรงๆ จาก upstream จะยุ่งเพราะการ restructure เป็น project-folder + sidebar tabs — แนะนำ cherry-pick commit ทีละตัว

## Roadmap

ไม่ใช่สัญญา แค่สิ่งที่กำลังพิจารณา ลิสต์ tier ละเอียดอยู่ใน `memory/roadmap_next_features.md` (private)

**Tier 1 (แนะนำทำต่อ):**

- [ ] Vision ใน AI Chat — แนบหน้าปัจจุบันให้ model เห็นฟอง + glyph จริง
- [ ] Streaming chat responses (token-by-token + ปุ่ม stop)
- [ ] Batch chapter translation queue (background + progress UI)

**Tier 2:**

- [ ] Cost dashboard (data มีแล้ว, UI ยังไม่มี)
- [ ] QC consistency checker (AI scan chapter เทียบ glossary)
- [ ] Thai bubble-fit warnings (ไทยมักยาวกว่าต้นฉบับ 1.5–2x)
- [ ] Auto-extract characters + glossary ตอน import chapter แรก

**Tier 3:**

- [ ] Cmd+K command palette
- [ ] Vector-embedding TM (semantic search เกิน fuzzy)
- [ ] TMX import/export (แลก CAT-tool)
- [ ] Multi-chapter export เป็น CBZ / PDF (`<chapter>/render/` พร้อมแล้ว)
- [ ] Thai spell / grammar check output

**ขึ้น main แล้ว (เคยอยู่ใน roadmap):**

- [x] Series project format + glossary + TM + custom prompt templates
- [x] OpenRouter + Local LLM support
- [x] Cost tracking (storage + stats; UI ยังไม่มี)
- [x] Bundled-font support สำหรับไทย
- [x] Rolling-context summaries จาก chapter ก่อนหน้า

## ข้อจำกัดที่ทราบ

- **Anthropic ใน pure-browser headless mode** — CORS block direct calls; desktop Tauri build เพิ่ม `anthropic-dangerous-direct-browser-access: true` ทำงานได้ปกติ
- **OpenAI JSON mode** gated ด้วย `model.includes('gpt')` Model ใหม่ของ OpenAI (`o3`, `o4`) และ OpenRouter-routed models ส่วนมากข้าม JSON mode — handle ได้ แต่คุณภาพต่างกันตาม model
- **Thai font fallback** ขึ้นกับ OS มี font ใน list (Leelawadee UI / Tahoma บน Windows · Thonburi / Krungthep บน macOS · Noto Sans Thai บน Linux) ถ้าไม่มี ให้วาง Thai TTF ลงใน bundled-fonts directory
- **ยังไม่มี translation streaming** — translations โผล่เมื่อ cloud request เสร็จเต็มก้อน (streaming chat อยู่ใน roadmap)
- **OCR รองรับเฉพาะ JP** — model ตอนนี้คือ manga-ocr; Thai OCR ยังไม่รองรับ

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
