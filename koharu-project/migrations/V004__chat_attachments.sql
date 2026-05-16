-- Multimodal chat: attach images to chat messages so the active LLM
-- can see the manga page being worked on.
--
-- `attachments` is a JSON array of objects: [{ dataUrl, mimeType,
-- width, height }]. We downsize to ≤1024px JPEG q85 client-side
-- before insert so DB stays reasonable (~50-200KB per image).

ALTER TABLE chat_messages ADD COLUMN attachments TEXT;
