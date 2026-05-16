# Koharu-TH

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE-GPL)
[![Upstream](https://img.shields.io/badge/upstream-mayocream%2Fkoharu%200.37.0-purple.svg)](https://github.com/mayocream/koharu)
[![Rust](https://img.shields.io/badge/rust-1.92%2B-orange.svg)](https://www.rust-lang.org/)

> [English](./README.md)
>
> Fork ส่วนตัวของ [mayocream/koharu](https://github.com/mayocream/koharu) — เพิ่ม **Cloud LLM translation**, **รองรับฟอนต์/เลย์เอาต์ภาษาไทย**, และ **หมุน text block** ทับบน upstream 0.37.0

โปรแกรมแปลมังงะด้วย ML เขียนด้วย **Rust** ทั้งหมด

Koharu เสนอ workflow ใหม่ในการแปลมังงะ โดยใช้พลังของ ML มาช่วยทำงานให้อัตโนมัติ รวมความสามารถของ object detection, OCR, inpainting, และ LLM เข้าด้วยกันให้แปลได้แบบลื่นไหล

เบื้องหลังใช้ [candle](https://github.com/huggingface/candle) สำหรับ inference ที่เร็ว และใช้ [Tauri](https://github.com/tauri-apps/tauri) ทำ GUI ทุกส่วนเขียนด้วย Rust จึงปลอดภัยและไว

> [!NOTE]
> โดย default Koharu รัน ML models **บนเครื่องตัวเอง** ทั้งหมด ถ้าเลือกใช้ cloud LLM provider (OpenAI / Gemini / Anthropic / OpenAI-compatible) เฉพาะข้อความที่จะแปลเท่านั้นที่ถูกส่งไปยัง provider — งานอย่างอื่นยังรันบนเครื่อง การใช้ cloud เป็น opt-in ผ่านหน้า Settings

---

![screenshot](assets/koharu-screenshot-en.png)

## สิ่งที่เพิ่มเข้ามาใน fork นี้

Fork นี้ต่อยอดจาก upstream 0.37.0 ด้วย 3 ฟีเจอร์หลัก เน้นการแปลเป็นภาษาไทยและการใช้ API ภายนอก:

- **☁️  Cloud LLM translation** — แปลผ่าน OpenAI (หรือ endpoint ที่ compatible กับ OpenAI เช่น OpenRouter หรือ local server), Google Gemini, หรือ Anthropic Claude เป็นทางเลือกแทน local LLM ที่มากับโปรแกรม รองรับทั้งแบบทีละ block และแบบ batch JSON สำหรับทั้งหน้า ถ้าไม่ได้ตั้ง provider จะ fallback ไปใช้ local LLM อัตโนมัติ
- **🇹🇭 รองรับ Thai script** ใน renderer — มี font fallback สำหรับภาษาไทย (Leelawadee UI / Tahoma / Noto Sans Thai ตาม OS) เพื่อให้ตัวอักษรไทยแสดงผลถูกต้องในลูกโป่ง ภาษา default ของ cloud target คือไทย
- **🔄 หมุน text block ได้** — เพิ่ม `rotation_deg` ทะลุตั้งแต่ API → pipeline → renderer → UI ใช้เอียงกล่องข้อความเพื่อจัดให้พอดีกับลูกโป่งทรงเฉียงหรือ SFX แบบสไตล์ๆ ได้

ตั้งค่า cloud provider ได้ที่ **Settings → Cloud AI** ถ้าเลือก *None* จะกลับมาใช้ local LLM ตามเดิม

## ฟีเจอร์

- ตรวจจับและ segment ลูกโป่งคำพูดอัตโนมัติ
- OCR สำหรับอ่านข้อความในมังงะ
- Inpainting ลบข้อความต้นฉบับออกจากภาพ
- แปลด้วย LLM (ทั้ง local **และ** cloud — *ของเพิ่มใน fork*)
- จัดข้อความแนวตั้งสำหรับภาษา CJK
- Font fallback ที่เข้าใจภาษาไทย (*ของเพิ่มใน fork*)
- หมุน text block ได้ (*ของเพิ่มใน fork*)
- MCP server สำหรับ AI agent

## การใช้งาน

### Hot keys

- <kbd>Ctrl</kbd> + Mouse Wheel: ซูมเข้า/ออก
- <kbd>Ctrl</kbd> + Drag: เลื่อน canvas
- <kbd>Del</kbd>: ลบ text block ที่เลือกอยู่

### ตั้งค่า Cloud AI translation

เปิด **Settings → Cloud AI** แล้วเลือก provider:

| Provider | สิ่งที่ต้องกรอก |
|---|---|
| **OpenAI** (หรือ compatible) | API Key · ชื่อโมเดล (เช่น `gpt-4o`, `gpt-4o-mini`) · Base URL (default `https://api.openai.com/v1` เปลี่ยนได้เป็น Together, local llama.cpp / vLLM server ฯลฯ) |
| **OpenRouter** | ใส่แค่ API Key — ระบบจะ fetch รายการโมเดลสดจาก OpenRouter ขึ้นเป็น picker ที่พิมพ์ค้นหาได้ พร้อมแสดง pricing + context length ของแต่ละโมเดล |
| **Google Gemini** | API Key · ชื่อโมเดล (เช่น `gemini-2.5-pro`, `gemini-2.5-flash`) |
| **Anthropic Claude** | API Key · ชื่อโมเดล (เช่น `claude-3-5-sonnet`, `claude-opus-4-5`) |

หลังตั้งค่าเสร็จ ปุ่ม LLM translate จะใช้ cloud provider แทน local model ถ้าอยากกลับไปใช้ local ก็เปลี่ยน provider เป็น *None*

> [!NOTE]
> API ของ Anthropic บล็อก request ที่มาจาก browser โดย default fork นี้ส่ง header `anthropic-dangerous-direct-browser-access: true` เพื่อให้ทำงานใน Tauri webview ได้ ถ้ารัน Koharu แบบ headless / web mode บน browser ปกติ CORS อาจ block — ใช้ OpenAI-compatible หรือ Gemini แทนได้

### MCP Server

Koharu มี MCP server ฝังในตัว ใช้เชื่อมกับ AI agent ได้ default จะ listen ที่ port แบบสุ่ม กำหนดเองได้ด้วย flag `--port`

```bash
# macOS / Linux
koharu --port 9999
# Windows
koharu.exe --port 9999
```

ใส่ `http://localhost:9999/mcp` เป็น MCP server URL ใน AI agent ที่ใช้

### Headless Mode

รันแบบ headless ผ่าน command line ได้

```bash
# macOS / Linux
koharu --port 4000 --headless
# Windows
koharu.exe --port 4000 --headless
```

แล้วเข้า Koharu Web UI ที่ `http://localhost:4000`

### File association

บน Windows Koharu ผูกกับไฟล์ `.khr` ให้อัตโนมัติ เปิดด้วยการ double-click ได้เลย และไฟล์ `.khr` ยังเปิดเป็นรูปภาพเพื่อดู thumbnail ของรูปข้างในได้ด้วย

## GPU acceleration

รองรับทั้ง CUDA และ Metal เร่งความเร็วได้มากบนฮาร์ดแวร์ที่รองรับ

### CUDA

Koharu มี CUDA toolkit 13.1 และ cuDNN 9.19 รวมมาให้ — dylibs จะถูก extract ไปยังโฟลเดอร์ application data อัตโนมัติตอนรันครั้งแรก

> [!NOTE]
> ต้องลง NVIDIA driver เวอร์ชันล่าสุด แนะนำลงผ่าน [NVIDIA App](https://www.nvidia.com/en-us/software/nvidia-app/)

รองรับ: NVIDIA GPU ที่มี compute capability **7.5 ขึ้นไป** เช็คได้ที่ [CUDA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus) และ [cuDNN Support Matrix](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/support-matrix.html)

### Metal

รองรับ Metal GPU acceleration บน macOS ที่ใช้ Apple Silicon (M1, M2, ฯลฯ)

### CPU fallback

ถ้าอยากบังคับให้ใช้ CPU:

```bash
# macOS / Linux
koharu --cpu
# Windows
koharu.exe --cpu
```

## ML Models

### Computer Vision Models

- [comic-text-detector](https://github.com/dmMaze/comic-text-detector)
- [manga-ocr](https://github.com/kha-white/manga-ocr)
- [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting)
- [YuzuMarker.FontDetection](https://github.com/JeffersonQin/YuzuMarker.FontDetection)

โมเดลจะถูกดาวน์โหลดให้อัตโนมัติตอนรันครั้งแรก น้ำหนัก safetensors ที่แปลงแล้วโฮสต์อยู่ที่ [Hugging Face](https://huggingface.co/mayocream)

### Local Large Language Models

Koharu รองรับ LLM แบบ quantized GGUF หลายตัวผ่าน [candle](https://github.com/huggingface/candle) และเลือกโมเดล default ตาม locale ของระบบ

แปลเป็น **ภาษาอังกฤษ**:

- [vntl-llama3-8b-v2](https://huggingface.co/lmg-anon/vntl-llama3-8b-v2-gguf) — ~8.5 GB Q8_0 ต้องใช้ VRAM ≥10 GB (หรือ RAM เยอะถ้ารัน CPU); ดีที่สุดเรื่องความแม่นยำ
- [lfm2-350m-enjp-mt](https://huggingface.co/LiquidAI/LFM2-350M-ENJP-MT-GGUF) — เบามาก (~350M, Q8_0) รันบน CPU และ GPU ที่ RAM น้อยได้

แปลเป็น **ภาษาจีน**:

- [sakura-galtransl-7b-v3.7](https://huggingface.co/SakuraLLM/Sakura-GalTransl-7B-v3.7) — ~6.3 GB พอดี VRAM 8 GB
- [sakura-1.5b-qwen2.5-v1.0](https://huggingface.co/shing3232/Sakura-1.5B-Qwen2.5-v1.0-GGUF-IMX) — เบา (~1.5B, Q5KS) สำหรับ GPU 4–6 GB หรือ CPU

แปลเป็น **ภาษาอื่น (รวมไทย)**:

- [hunyuan-7b-mt-v1.0](https://huggingface.co/Mungert/Hunyuan-MT-7B-GGUF) — ~6.3 GB บน VRAM 8 GB คุณภาพ multi-language โอเค
- หรือใช้ **cloud provider** (ดู [Cloud AI translation](#ตั้งค่า-cloud-ai-translation)) — แนะนำสำหรับภาษาไทย ถ้าโมเดล local 7B/8B ให้ผลลัพธ์ที่อ่อน

LLM จะถูกดาวน์โหลดตอนเลือกโมเดลใน Settings

## Installation

Fork นี้ยังไม่มี pre-built binaries — ต้อง build จาก source (ดูด้านล่าง) หรือใช้ binary จาก [upstream release ของ mayocream/koharu](https://github.com/mayocream/koharu/releases/latest) ถ้าไม่ได้ต้องการฟีเจอร์เฉพาะของ fork นี้

## Development

### ของที่ต้องมี

- [Rust](https://www.rust-lang.org/tools/install) (1.92 ขึ้นไป)
- [Bun](https://bun.sh/) (1.0 ขึ้นไป)

### ติดตั้ง dependencies

```bash
bun install
```

### Build

```bash
bun run build
```

ไบนารีที่ build เสร็จจะอยู่ใน `target/release`

### Sync กับ upstream

```bash
git fetch upstream
git diff upstream/main         # ดูว่าต่างจาก upstream ยังไงบ้าง
git merge upstream/main        # หรือ rebase ก็แล้วแต่
```

## Roadmap

ไม่ใช่สัญญา — แค่ของที่กำลังคิดจะทำต่อใน fork นี้

- [ ] บันเดิลฟอนต์ไทย (เช่น Noto Sans Thai) มากับแอป เพื่อให้แสดงผลได้แม้เครื่องไม่มีฟอนต์ไทยลง
- [ ] Streaming response จาก cloud provider เพื่อให้รู้สึกแปลเร็วขึ้น
- [ ] Glossary / consistency ของ term ข้ามหน้าในเอกสารเดียวกัน
- [ ] Translation memory / caching ไม่ต้องแปลซ้ำข้อความเดิม
- [ ] Custom prompt template ต่อเอกสาร (genre, ชื่อตัวละคร, ระดับความเป็นทางการ)
- [ ] เพิ่ม cloud provider อื่น (xAI Grok, Mistral, DeepSeek)
- [ ] ทำ i18n keys ของ UI ใน Cloud AI settings ให้ครบ (ตอนนี้ใช้ string ภาษาอังกฤษ fallback)
- [ ] รองรับ OCR ภาษาไทย (OCR ปัจจุบันรองรับเฉพาะภาษาญี่ปุ่น)
- [ ] ปรับเลย์เอาต์แนวตั้งสำหรับภาษาไทยในลูกโป่งที่สูงและแคบมาก

## ข้อจำกัดที่รู้แล้ว

- **Anthropic ใน browser headless mode** — ดูหมายเหตุใน [Cloud AI translation](#ตั้งค่า-cloud-ai-translation) CORS จะบล็อก request โดยตรง ใช้ได้ปกติใน Tauri desktop build
- **การตรวจ JSON mode ของ OpenAI** ตอนนี้ใช้ check `model.includes('gpt')` โมเดล OpenAI ใหม่ๆ (`o3`, `o4`, ฯลฯ) และโมเดลส่วนใหญ่ที่ route ผ่าน OpenRouter จะข้าม JSON mode ไป และอาจคืน text ที่ต้อง parse แบบยืดหยุ่น — handle ไว้แล้ว แต่คุณภาพขึ้นกับโมเดล
- **Thai font fallback** ขึ้นกับ OS ว่ามีฟอนต์ในลิสต์ลงไว้หรือเปล่า (Leelawadee UI / Tahoma บน Windows · Thonburi / Krungthep บน macOS · Noto Sans Thai บน Linux) ถ้าไม่มีเลย renderer จะ fallback ไป default และอาจขึ้น tofu (□)
- **ยังไม่มี translation streaming** — ผลการแปลจะขึ้นต่อเมื่อ request เสร็จสมบูรณ์
- **ยังไม่มี glossary / consistency ข้ามหน้า** — แต่ละ block (หรือแต่ละ batch) ถูกแปลแยกกัน ชื่อตัวละครและคำศัพท์อาจไม่ตรงข้ามหน้า

## Credits

Fork นี้ต่อยอดจากงานของ [mayocream/koharu](https://github.com/mayocream/koharu) และทีม contributor งาน ML pipeline, Tauri shell, และ renderer หลักทั้งหมดเป็นของทีม upstream — ถ้าใช้แล้วชอบ พิจารณา support upstream ได้ที่:

- [GitHub Sponsors](https://github.com/sponsors/mayocream)
- [Patreon](https://www.patreon.com/mayocream)

<a href="https://github.com/mayocream/koharu/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=mayocream/koharu" />
</a>

## License

ตัวแอป Koharu ใช้ license [GNU General Public License v3.0](LICENSE-GPL) — fork นี้ inherit license เดียวกัน

Sub-crates ของ Koharu ใช้ license [Apache License 2.0](LICENSE-APACHE)
