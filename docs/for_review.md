# Koharu-th — AI-Assisted Manga Localization Stack (2026)

## Vision

Koharu-th กำลังไปไกลกว่า “เครื่องมือแปลมังงะ”

Direction ปัจจุบันเริ่มเข้าใกล้:

> AI-native Manga Localization Workstation

ซึ่งรวม:
- OCR
- Translation
- Context Memory
- Typesetting
- Redraw
- Character Consistency
- Agentic Workflow
- Project-aware AI

ไว้ใน workflow เดียว

---

# 1. OCR + Bubble Detection

## Tasks
- Detect speech bubbles
- Detect narration boxes
- OCR Japanese text
- Detect vertical text
- Panel segmentation
- Text direction analysis

---

## Recommended Models

### MangaOCR
https://github.com/kha-white/manga-ocr

### จุดเด่น
- OCR ญี่ปุ่นสำหรับมังงะโดยเฉพาะ
- รองรับ vertical text ดี
- Community ใช้งานเยอะ
- Lightweight

### เหมาะกับ
- Main OCR pipeline
- Fast preprocessing

---

### Florence-2
https://huggingface.co/microsoft/Florence-2-large

### จุดเด่น
- Visual grounding
- Region detection
- Layout understanding
- Dense captioning

### เหมาะกับ
- Bubble detection
- Panel detection
- Scene-aware processing

---

### GOT-OCR 2.0
https://huggingface.co/stepfun-ai/GOT-OCR2_0

### จุดเด่น
- Multilingual OCR
- Arbitrary layouts
- Stylized text handling
- Dense OCR capability

### เหมาะกับ
- Difficult scans
- SFX OCR
- Mixed layouts

---

# 2. Translation Engine

## Goals
- Context-aware translation
- Character consistency
- Emotion-aware dialogue
- Glossary-aware translation

---

## Recommended Models

### Gemini 3.5 Flash
https://ai.google.dev

### จุดเด่น
- Large context
- Multimodal understanding
- Fast reasoning
- Tool calling
- Image-aware translation

### เหมาะกับ
- Main translation engine
- Context-heavy chapters
- Agentic workflow

---

### Claude Sonnet
https://www.anthropic.com/claude

### จุดเด่น
- Emotional nuance
- Natural dialogue
- Character tone consistency
- Writing quality

### เหมาะกับ
- Emotional scenes
- Dialogue polishing
- Story-heavy manga

---

### Qwen 3 / Qwen VL
https://qwenlm.github.io

### จุดเด่น
- Local/self-host
- Strong multilingual support
- Good Japanese handling
- Vision-language capability

### เหมาะกับ
- Offline workflow
- Privacy-focused workflow
- Hybrid local/cloud architecture

---

# 3. Translation Memory + Semantic Retrieval

## Goals
- Character consistency
- Glossary recall
- Previous chapter lookup
- Semantic translation memory

---

## Recommended Embedding Models

### BGE-M3
https://huggingface.co/BAAI/bge-m3

### จุดเด่น
- Strong multilingual embedding
- Semantic retrieval
- Long-context retrieval

### เหมาะกับ
- Translation memory
- Glossary search
- Chapter similarity search

---

### jina-embeddings-v4
https://jina.ai/embeddings/

### จุดเด่น
- Long context embedding
- High-quality multilingual retrieval

### เหมาะกับ
- Large-scale project memory
- Long-running series projects

---

# 4. Bubble Cleanup / Inpainting

## Goals
- Remove original text
- Preserve artwork
- Restore background
- Fast redraw workflow

---

## Recommended Models

### Lama Cleaner
https://github.com/Sanster/lama-cleaner

### จุดเด่น
- Fast inpainting
- Great for manga cleanup
- Lightweight workflow

### เหมาะกับ
- Bubble cleanup
- Text removal
- Background restoration

---

### FLUX Kontext
https://blackforestlabs.ai

### จุดเด่น
- Style-preserving image editing
- Strong composition preservation
- Advanced image editing

### เหมาะกับ
- Advanced redraw
- Art correction
- Effect reconstruction

---

# 5. Advanced Redraw / Img2Img

## Goals
- Preserve manga art style
- Regenerate damaged regions
- Maintain consistency
- Assist typesetting workflow

---

## Recommended Stack

### SDXL + ControlNet
https://stability.ai

### จุดเด่น
- Massive ecosystem
- Strong anime support
- Fine control over generation

### ControlNet Usage
| Control Type | Usage |
|---|---|
| Lineart | Preserve manga lines |
| OpenPose | Preserve pose |
| Depth | Preserve composition |
| Tile | Upscaling |
| Canny | Preserve edges |

---

### IP-Adapter

### จุดเด่น
- Character consistency
- Reference conditioning

### เหมาะกับ
- Character redraw
- Face consistency
- Multi-panel consistency

---

# 6. Sound Effect (SFX) Translation

## Goals
- Detect stylized SFX
- OCR handwritten effects
- Decide whether to translate
- Preserve visual style

---

## Recommended Models

### Florence-2
### Gemini Vision
### Qwen VL

### เหมาะกับ
- SFX detection
- Embedded text analysis
- Stylized text understanding

---

# 7. AI Typesetting Assistant

## Potential Features
- Auto line breaking
- Font sizing
- Bubble fitting
- Text rotation
- Emphasis handling
- Overflow detection

---

## Important Insight

ภาษาไทย:
- ยาวกว่า JP
- Density ต่างจาก JP
- Bubble fit ยากกว่า

ดังนั้น:
- Dynamic layout AI
- Per-block rotation
- Semantic line splitting

คือ feature สำคัญมาก

---

# 8. Style-Aware Translation

## Goals
AI เข้าใจ:
- Tsundere
- Gyaru
- Chuuni
- Fantasy noble
- Delinquent speech
- Archaic speech

และ maintain tone ทั้งเรื่อง

---

## Recommended Models

| Model | Strength |
|---|---|
| Claude Sonnet | Emotional nuance |
| Gemini 3.5 Flash | Context + reasoning |
| Qwen 3 | Local workflow |
| DeepSeek V3 | Cheap reasoning |

---

# 9. Agentic Workflow

## Current Direction (Very Promising)

Koharu-th เริ่มเข้าใกล้:

> AI Translation IDE

มากกว่า translator app

---

## Example MCP-style Tools

- Read chapter metadata
- Search glossary
- Search prior translations
- Fetch character profile
- Detect inconsistency
- Suggest redraw
- Auto-fit text
- Compare terminology usage

---

# 10. ComfyUI Integration

https://github.com/comfyanonymous/ComfyUI

## Why It Matters

ComfyUI ไม่ใช่แค่ UI

มันคือ:
> Node-based AI graphics pipeline engine

---

## Suitable Tasks

- Batch redraw
- Upscaling
- Effect repair
- Consistent img2img
- Multi-pass workflows
- Regional prompting

---

# Suggested Architecture Stack

| Layer | Recommended |
|---|---|
| OCR | MangaOCR + Florence-2 |
| Translation | Gemini 3.5 Flash / Claude |
| Local LLM | Qwen 3 |
| Retrieval | BGE-M3 |
| Cleanup | Lama Cleaner |
| Redraw | FLUX Kontext |
| Advanced Img2Img | SDXL + ControlNet |
| Workflow Engine | ComfyUI |
| Character Consistency | IP-Adapter |
| Agent Runtime | MCP-style tools |

---

# Biggest Opportunities

## 1. Manga-native Translation Memory
CAT tools ปัจจุบันไม่เข้าใจ manga workflow จริง

---

## 2. Character Speech Consistency
AI จำ “น้ำเสียงตัวละคร”

Potential สูงมาก

---

## 3. Visual-aware Translation
แปลโดยดู:
- Panel
- Emotion
- Composition
- SFX
- Expression

ไม่ใช่ OCR text อย่างเดียว

---

## 4. AI Typesetting Assist
Potential สูงมากในวงการ scanlation

---

# Long-Term Direction

Koharu-th มี potential ไปสู่:

> "Cursor for Manga Localization"

เพราะ ecosystem ปัจจุบัน:
- fragmented
- UX แยกส่วน
- script-heavy
- workflow disconnected

แต่ Koharu-th กำลังไปทาง:
- AI-native workflow
- Context-aware tooling
- Project memory
- Agentic localization
- Integrated pipeline

ซึ่งเป็น direction ที่ถูกยุคมาก