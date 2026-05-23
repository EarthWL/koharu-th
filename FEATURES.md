# 🚀 Koharu-TH: Next-Gen Translation Studio Features



อัปเดตครั้งนี้เป็นการพลิกโฉมสถาปัตยกรรมและฟีเจอร์ของโปรแกรมขนานใหญ่ ทั้งในแง่ของความเสถียร (Performance), ประสบการณ์ผู้ใช้ (UI/UX), การใช้งาน AI (AI Chat & Inference) รวมไปถึงการรองรับระบบพหุภาษา (Multilingual Ecosystem) อย่างเต็มรูปแบบ! 

ทุกฟีเจอร์ด้านล่างนี้ **ได้รับการพัฒนาและผสานเข้ากับระบบเสร็จสมบูรณ์ 100%** แล้วครับ

---

### ⚡ Core & Performance (เสถียรภาพและประสิทธิภาพ)
- ✅ **Background AI model warmup**: โหลดโมเดล AI พื้นหลัง (VRAM pre-allocate) ระหว่าง Splash Screen ทำให้ตอนเข้าแอปพร้อมใช้งานทันทีโดยไม่หน้าจอค้าง - Closes #19
- ✅ **Zero-copy file dialog**: ระบบโหลดไฟล์และรูปภาพขนาดใหญ่ผ่าน Native Dialog ของ Windows โดยไม่ก๊อปปี้ Buffer ให้เปลืองแรม
- ✅ **LaMa Inpaint resolution**: เพิ่ม Slider ควบคุมความละเอียดของการลบตัวอักษรภาพ (LaMa) พร้อม Parallel Processing - Closes #18
- ✅ **Candle ML Inference update**: อัปเดตเอนจิน `candle`, `float8`, `ug` เป็นสาขา `cuda-dynamic-loading` ช่วยเร่งความเร็ว CUDA และแก้ปัญหาไดรเวอร์ชนกัน
- ✅ **Backend Panic Removal**: อุดรอยรั่ว `.unwrap()` ในระบบ Rust Queue ป้องกันแอปดับกะทันหัน
- ✅ **Virtualization**: อัปเกรด List Render ในแถบเครื่องมือด้านข้างทั้งหมดด้วย `@tanstack/react-virtual` ลดภาระ DOM เรนเดอร์ลื่นไหลไม่กระตุกแม้มี Text Block นับพัน

---

### 🎨 UI / UX (ประสบการณ์ผู้ใช้ระดับพรีเมียม)
- ✅ **Photoshop-style layer controls**: จัดการ Text Block เหมือนเล่นโปรแกรมแต่งภาพ! มีระบบเปิด-ปิดตา (Visibility), แถบความจาง (Opacity Slider), และระบบลากสลับตำแหน่งเลเยอร์ (Drag & Drop) - Closes #57
- ✅ **Move Up/Down Buttons**: ปุ่มเลื่อนตำแหน่ง Z-Index ของข้อความขึ้น-ลงทีละสเตป
- ✅ **Format Painter (คัดลอก/วาง สไตล์)**: ดูดสไตล์อักษรจากกล่องนึงไปแปะอีกกล่องได้อย่างรวดเร็ว
- ✅ **Bold/Italic Native**: ระบบหนา/เอียง แบบ Native พร้อม Faux-Bold / Faux-Italic เสมือนจริง - Closes #27
- ✅ **Reading Order Dropdown**: เมนูตั้งค่าทิศทางการอ่านอัจฉริยะ (LTR / RTL / Custom)
- ✅ **Font Bookmarking (Favorites)**: หน้าต่างปักหมุดฟอนต์โปรด (ดาวสีเหลือง) ดันฟอนต์ประจำขึ้นด้านบนสุดให้เรียกใช้ง่ายๆ
- ✅ **Zoom system**: อัปเกรดระบบซูมพร้อมคีย์ลัด แพนหน้ากระดาษเทียบเท่า Photoshop พร้อมปุ่ม `Fit Page`, `Fit Width`, `Fit Height`
- ✅ **Smart Bubble fit**: ระบบคำนวณและปรับขนาดฟอนต์ให้พอดีกรอบคำพูดอัตโนมัติ ไม่ล้นขอบ 
- ✅ **Zero-Render Canvas**: ระบบแคช Object URL รูปภาพ แพนกล้องหรือซูมแค่ไหนก็ไม่มีการ Re-render เฟรมเรต 60FPS นิ่งๆ

---

### 💬 AI Chat (แชทบอตช่วยแปลสุดล้ำ)
- ✅ **Context-Aware Selected Block Panel**: แถบแก้วใส (Glassmorphism) บนช่องแชทที่ดึงบล็อกข้อความที่เลือกอยู่บนภาพมาให้ทันที กด Paste Source หรือ Paste Translation ลงแชทได้ในคลิกเดียว หรือกด Ask AI เพื่อให้วิเคราะห์บริบทให้เลย!
- ✅ **Quick Prompt Templates**: เมนูลัดรวมคำสั่ง (Prompts) แปลงโทนเสียง (ทั่วไป, โชเน็น, สุภาพ), ตรวจสอบบริบทวัฒนธรรม และเกลาภาษาไทยแบบเรียลไทม์
- ✅ **Manga SFX Dictionary Helper**: คลังคำศัพท์และเสียงเอฟเฟกต์ (SFX) ญี่ปุ่นแบ่งตามหมวดหมู่ (Action, Emotion, Nature) กดเพื่อสอบถาม AI ถึงคำพ้องและบริบทการใช้งานได้ทันที
- ✅ **Multi-Model Arena Compare**: โหมดประชันคำตอบ! สั่งรัน AI หลายโปรไฟล์พร้อมกันแบบขนานเทียบจอซ้ายขวา และเลือกคำตอบที่ดีที่สุดกดเซฟลงฐานข้อมูลได้เลย
- ✅ **Undo (Revoke)**: ปุ่มย้อนกลับข้อความแชท (ดึงข้อความคืน) แบตช์ลดจำนวน Round-trip
- ✅ **Error Handling & Manual Switch-Retry**: หากเกิด Error ขึ้น (API พัง/โค้ต้าหมด) จะมีปุ่มโผล่มาให้คลิกสลับโปรไฟล์ AI และ Retry คำสั่งเดิมได้ทันทีโดยไม่ต้องพิมพ์ใหม่
- ✅ **Regenerate & Copy**: ปุ่มคัดลอกข้อความด่วนแบบมี Micro-animation และปุ่มกดสร้างคำตอบใหม่ (Regenerate)

---

### 🌐 Multilingual Ecosystem (ระบบเสริมพหุภาษา)
- ✅ **Addon Architecture**: โครงสร้างแบบ Addon ตรวจจับ `addon_{lang}.flag` เพื่อปลดล็อกฟีเจอร์พหุภาษา
- ✅ **Auto OCR Optimization**: สลับไปใช้ Cloud Vision OCR ทันที หากตรวจพบว่าแปลภาษาที่ไม่ใช่ภาษาญี่ปุ่น (เช่น ฝรั่งเศส เกาหลี เยอรมัน)
- ✅ **Dynamic Post-Processor (`smartPostProcess`)**: วิเคราะห์ภาษาปลายทางอัตโนมัติเพื่อจัดช่องว่างและสัญลักษณ์ให้ถูกหลักไวยากรณ์ (เช่น French Guillemets)
- ✅ **Prompt Templates Synchronization**: ระบบซิงค์ Language Dropdown หน้า UI เข้ากับฐานข้อมูล Project Meta ส่งผลให้ AI สร้าง Prompt ยึดตามภาษา Addon ปัจจุบันเสมอ
- ✅ **Translation Memory Integrity**: ระบบเชื่อมโยงฐานข้อมูล TM ค้นหา/บันทึก/ส่งออก (Export TMX) กรองตาม Target Language ที่เลือกใช้งานอย่างแม่นยำ

---

### 🛠️ อื่นๆ (โครงสร้างพื้นฐาน)
- ✅ **Global Scratchpad DB**: ฐานข้อมูลสำรองแบบ thread-safe ป้องกันหน้า UI ค้างเมื่อรันแบบ Standalone - Closes #28
- ✅ **Auto-updater**: ระบบอัปเดตแอปอัตโนมัติเบื้องหลัง
- ✅ **Non-blocking Toasts**: เปลี่ยนระบบแจ้งเตือนแบบ `alert()` ทั้งแอปให้เป็น Toast Animation (Sonner) ที่สวยงามและไม่ขัดจังหวะการทำงาน
- ✅ **Code Cleanup**: ลบ Dead code, `console.log`, และเคลียร์ Local ที่ไม่ได้ใช้ออกทั้งหมด

---

**สรุป**: ฟังก์ชันทั้งหมดใน Project Scope นี้ได้รับการเขียนโค้ด เติมเต็ม และทดสอบจนสมบูรณ์แล้ว ถือเป็นการยกระดับโปรแกรมให้ก้าวสู่งานระดับพรีเมียมอย่างแท้จริงครับ!


## ⚡ Original Features

* Series Project Workspace (per-folder SQLite)
* Translation Memory (Exact, Jaccard, Semantic Embeddings, TMX)
* Cost Tracking Dashboard
* AI Prompt Templates Engine
* CBZ Multi-chapter Export
* MCP Server for external agents
