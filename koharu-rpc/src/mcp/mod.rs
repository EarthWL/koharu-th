mod helpers;

use std::path::PathBuf;

use image::DynamicImage;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, Content, ErrorData, Implementation, ServerCapabilities, ServerInfo,
    ToolsCapability,
};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};

use koharu_api::commands::{
    AddTextBlockPayload, ChapterCreatePayload, ChapterIdPayload,
    ChapterUpdatePayload, CharacterAddPayload, CharacterIdPayload, CharacterUpdatePayload,
    DetectPayload, OcrPayload, WebFetchPayload,
    ExportDocumentParams, FileEntry, GlossaryAddPayload, GlossaryBulkAddPayload,
    GlossaryBumpUsagePayload, GlossaryIdPayload, GlossaryUpdatePayload, IndexPayload,
    InpaintPartialPayload, InpaintRegion, InpaintRegionParams, LlmCallLogPayload,
    LlmGenerateParams, LlmGeneratePayload, LlmListPayload, LlmLoadParams, LlmLoadPayload,
    MaskMorphPayload, OpenDocumentsParams, OpenDocumentsPayload, ProcessParams, ProcessRequest,
    ProjectCreatePayload, ProjectOpenPayload, PromptRenderPayload, PromptTemplateAddPayload,
    PromptTemplateIdPayload, PromptTemplateUpdatePayload, ProviderProfileAddPayload,
    ProviderProfileIdPayload, ProviderProfileUpdatePayload, RecentProjectRemovePayload,
    RemoveTextBlockPayload, RenderParams, RenderPayload, SeriesMetaUpdatePayload, TmInsertPayload,
    TmLookupFuzzyPayload, TmLookupPayload, UpdateTextBlockPayload, ViewImageParams,
    ViewTextBlockParams,
};
use koharu_api::views::to_doc_info;
use koharu_pipeline::AppResources;
use koharu_pipeline::operations;

use crate::shared::SharedResources;

use helpers::encode_png_base64;

/// MCP-only payload for `chapter_add_pages_from_paths`. The HTTP/Tauri
/// variant pops a file picker which can't be driven from an agent, so
/// the MCP tool takes absolute paths directly.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterAddPagesFromPathsParams {
    pub chapter_id: i64,
    /// Absolute paths to image files (.png/.jpg/.jpeg/.webp/.bmp/.khr).
    pub paths: Vec<String>,
}

#[derive(Clone)]
pub struct KoharuMcp {
    pub shared: SharedResources,
    tool_router: ToolRouter<Self>,
}

impl KoharuMcp {
    pub fn new(shared: SharedResources) -> Self {
        Self {
            shared,
            tool_router: Self::tool_router(),
        }
    }

    fn resources(&self) -> Result<AppResources, String> {
        self.shared
            .get()
            .cloned()
            .ok_or_else(|| "Resources not initialized yet".to_string())
    }
}

#[tool_router]
impl KoharuMcp {
    #[tool(description = "Get the application version")]
    async fn app_version(&self) -> Result<String, String> {
        let res = self.resources()?;
        operations::app_version(res)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Get device information (ML device, GPU info)")]
    async fn device(&self) -> Result<String, String> {
        let res = self.resources()?;
        let info = operations::device(res).await.map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(description = "Get the number of loaded documents")]
    async fn get_documents(&self) -> Result<String, String> {
        let res = self.resources()?;
        let count = operations::get_documents(res)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("{count} document(s) loaded"))
    }

    #[tool(
        description = "Get document metadata and text blocks (no images). Returns name, dimensions, processing state, and all text block details."
    )]
    async fn get_document(
        &self,
        Parameters(p): Parameters<IndexPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let doc = operations::get_document(res, p)
            .await
            .map_err(|e| e.to_string())?;
        let info = to_doc_info(&doc);
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(description = "List available font families for text rendering")]
    async fn list_font_families(&self) -> Result<String, String> {
        let res = self.resources()?;
        let fonts = operations::list_font_families(res)
            .await
            .map_err(|e| e.to_string())?;
        Ok(fonts.join(", "))
    }

    #[tool(description = "List available LLM translation models with supported languages")]
    async fn llm_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let models = operations::llm_list(res, LlmListPayload { language: None })
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&models).map_err(|e| e.to_string())
    }

    #[tool(description = "Check if an LLM model is loaded and ready")]
    async fn llm_ready(&self) -> Result<String, String> {
        let res = self.resources()?;
        let ready = operations::llm_ready(res)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if ready {
            "LLM is ready".to_string()
        } else {
            "LLM is not loaded".to_string()
        })
    }

    #[tool(
        description = "View a document image layer. Returns the image so you can see the manga page, detection mask, inpainted result, or final rendered output."
    )]
    async fn view_image(
        &self,
        Parameters(p): Parameters<ViewImageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let res = self
            .resources()
            .map_err(|e| ErrorData::internal_error(e, None))?;
        let doc = operations::get_document(res, IndexPayload { index: p.index })
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let max_size = p.max_size.unwrap_or(1024);

        let img: &DynamicImage = match p.layer.as_str() {
            "original" => &doc.image,
            "segment" => doc.segment.as_ref().ok_or_else(|| {
                ErrorData::internal_error("No segment mask available. Run detect first.", None)
            })?,
            "inpainted" => doc.inpainted.as_ref().ok_or_else(|| {
                ErrorData::internal_error("No inpainted image available. Run inpaint first.", None)
            })?,
            "rendered" => doc.rendered.as_ref().ok_or_else(|| {
                ErrorData::internal_error("No rendered image available. Run render first.", None)
            })?,
            other => {
                return Err(ErrorData::internal_error(
                    format!(
                        "Unknown layer: {other}. Valid: original, segment, inpainted, rendered"
                    ),
                    None,
                ));
            }
        };

        let b64 = encode_png_base64(img, max_size);
        Ok(CallToolResult::success(vec![
            Content::text(format!(
                "Viewing '{}' layer of document '{}' ({}x{})",
                p.layer, doc.name, doc.width, doc.height
            )),
            Content::image(b64, "image/png"),
        ]))
    }

    #[tool(
        description = "View a cropped region of a specific text block. Useful for inspecting OCR results or rendered text quality."
    )]
    async fn view_text_block(
        &self,
        Parameters(p): Parameters<ViewTextBlockParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let res = self
            .resources()
            .map_err(|e| ErrorData::internal_error(e, None))?;
        let doc = operations::get_document(res, IndexPayload { index: p.index })
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let block = doc.text_blocks.get(p.text_block_index).ok_or_else(|| {
            ErrorData::internal_error(format!("Text block {} not found", p.text_block_index), None)
        })?;

        let layer = p.layer.as_deref().unwrap_or("original");
        let source: &DynamicImage = match layer {
            "original" => &doc.image,
            "rendered" => doc.rendered.as_ref().ok_or_else(|| {
                ErrorData::internal_error("No rendered image. Run render first.", None)
            })?,
            other => {
                return Err(ErrorData::internal_error(
                    format!("Unknown layer: {other}. Valid: original, rendered"),
                    None,
                ));
            }
        };

        let x = (block.x.max(0.0) as u32).min(doc.width.saturating_sub(1));
        let y = (block.y.max(0.0) as u32).min(doc.height.saturating_sub(1));
        let w = (block.width as u32).min(doc.width.saturating_sub(x));
        let h = (block.height as u32).min(doc.height.saturating_sub(y));

        if w == 0 || h == 0 {
            return Err(ErrorData::internal_error(
                "Text block has zero dimensions",
                None,
            ));
        }

        let crop = source.crop_imm(x, y, w, h);
        let b64 = encode_png_base64(&crop, 512);

        let mut desc = format!(
            "Text block [{}] at ({},{}) {}x{}",
            p.text_block_index, x, y, w, h
        );
        if let Some(ref text) = block.text {
            desc.push_str(&format!("\nOCR: {text}"));
        }
        if let Some(ref tr) = block.translation {
            desc.push_str(&format!("\nTranslation: {tr}"));
        }

        Ok(CallToolResult::success(vec![
            Content::text(desc),
            Content::image(b64, "image/png"),
        ]))
    }

    #[tool(
        description = "Open image files from disk paths. Replaces any currently loaded documents."
    )]
    async fn open_documents(
        &self,
        Parameters(p): Parameters<OpenDocumentsParams>,
    ) -> Result<String, String> {
        let res = self.resources()?;

        let files: Result<Vec<FileEntry>, String> = p
            .paths
            .iter()
            .map(|path| {
                let data =
                    std::fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
                let name = PathBuf::from(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                Ok(FileEntry { name, data })
            })
            .collect();

        let count = operations::open_documents(res.clone(), OpenDocumentsPayload { files: files? })
            .await
            .map_err(|e| e.to_string())?;

        let guard = res.state.read().await;
        let names: Vec<&str> = guard.documents.iter().map(|d| d.name.as_str()).collect();
        Ok(format!("Loaded {count} document(s): {}", names.join(", ")))
    }

    #[tool(description = "Export the rendered document to a file on disk")]
    async fn export_document(
        &self,
        Parameters(p): Parameters<ExportDocumentParams>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let result = operations::export_document(res, IndexPayload { index: p.index })
            .await
            .map_err(|e| e.to_string())?;

        std::fs::write(&p.output_path, &result.data)
            .map_err(|e| format!("Failed to write {}: {e}", p.output_path))?;

        Ok(format!("Exported to {}", p.output_path))
    }

    #[tool(
        description = "Detect text blocks and fonts in a manga page. Finds speech bubbles, text regions, and predicts font properties."
    )]
    async fn detect(&self, Parameters(p): Parameters<IndexPayload>) -> Result<String, String> {
        let res = self.resources()?;
        operations::detect(
            res.clone(),
            DetectPayload {
                index: p.index,
                detector_engine: None,
                anime_yolo_variant: None,
                anime_yolo_confidence: None,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        let doc = operations::get_document(res, p)
            .await
            .map_err(|e| e.to_string())?;

        let mut lines = vec![format!("Detected {} text block(s):", doc.text_blocks.len())];
        for (i, b) in doc.text_blocks.iter().enumerate() {
            lines.push(format!(
                "  [{}] ({:.0},{:.0}) {:.0}x{:.0} conf={:.2}",
                i, b.x, b.y, b.width, b.height, b.confidence
            ));
        }
        Ok(lines.join("\n"))
    }

    #[tool(
        description = "Run OCR (optical character recognition) on detected text blocks to extract the original text."
    )]
    async fn ocr(&self, Parameters(p): Parameters<IndexPayload>) -> Result<String, String> {
        let res = self.resources()?;
        operations::ocr(
            res.clone(),
            OcrPayload {
                index: p.index,
                ocr_engine: None,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        let doc = operations::get_document(res, p)
            .await
            .map_err(|e| e.to_string())?;

        let mut lines = vec!["OCR results:".to_string()];
        for (i, b) in doc.text_blocks.iter().enumerate() {
            let text = b.text.as_deref().unwrap_or("(empty)");
            lines.push(format!("  [{i}] {text}"));
        }
        Ok(lines.join("\n"))
    }

    #[tool(
        description = "Inpaint (remove) text from the image using the detection mask. Fills text regions with surrounding background."
    )]
    async fn inpaint(&self, Parameters(p): Parameters<IndexPayload>) -> Result<String, String> {
        let res = self.resources()?;
        operations::inpaint(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok("Inpainting complete".to_string())
    }

    #[tool(
        description = "Render translated text onto the inpainted image. Applies font styling, layout, and shader effects."
    )]
    async fn render(&self, Parameters(p): Parameters<RenderParams>) -> Result<String, String> {
        let res = self.resources()?;
        let effect = p
            .shader_effect
            .as_deref()
            .map(str::parse)
            .transpose()
            .map_err(|e: anyhow::Error| e.to_string())?;

        operations::render(
            res,
            RenderPayload {
                index: p.index,
                text_block_index: p.text_block_index,
                shader_effect: effect,
                shader_stroke: None,
                font_family: p.font_family,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        Ok("Render complete".to_string())
    }

    #[tool(
        description = "Load an LLM translation model. This downloads and initializes the model."
    )]
    async fn llm_load(&self, Parameters(p): Parameters<LlmLoadParams>) -> Result<String, String> {
        let res = self.resources()?;
        operations::llm_load(res, LlmLoadPayload { id: p.id.clone() })
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Loading model '{}'...", p.id))
    }

    #[tool(description = "Unload the current LLM model from memory")]
    async fn llm_offload(&self) -> Result<String, String> {
        let res = self.resources()?;
        operations::llm_offload(res)
            .await
            .map_err(|e| e.to_string())?;
        Ok("LLM offloaded".to_string())
    }

    #[tool(
        description = "Generate translations for text blocks using the loaded LLM. Returns the translated text."
    )]
    async fn llm_generate(
        &self,
        Parameters(p): Parameters<LlmGenerateParams>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        operations::llm_generate(
            res.clone(),
            LlmGeneratePayload {
                index: p.index,
                text_block_index: p.text_block_index,
                language: p.language,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        let doc = operations::get_document(res, IndexPayload { index: p.index })
            .await
            .map_err(|e| e.to_string())?;

        let mut lines = vec!["Translations:".to_string()];
        for (i, b) in doc.text_blocks.iter().enumerate() {
            let src = b.text.as_deref().unwrap_or("?");
            let tr = b.translation.as_deref().unwrap_or("(none)");
            lines.push(format!("  [{i}] {src} -> {tr}"));
        }
        Ok(lines.join("\n"))
    }

    #[tool(
        description = "Run the full processing pipeline: detect -> OCR -> inpaint -> translate -> render. Processes all steps automatically."
    )]
    async fn process(&self, Parameters(p): Parameters<ProcessParams>) -> Result<String, String> {
        let res = self.resources()?;
        let effect = p
            .shader_effect
            .as_deref()
            .map(str::parse)
            .transpose()
            .map_err(|e: anyhow::Error| e.to_string())?;

        operations::process(
            res,
            ProcessRequest {
                index: p.index,
                llm_model_id: p.llm_model_id,
                language: p.language,
                shader_effect: effect,
                shader_stroke: None,
                font_family: p.font_family,
                // MCP callers use the backend default OCR engine.
                // Cloud Vision OCR is frontend-orchestrated, no
                // exposed MCP entry point for it (see roadmap
                // Tier B #3 for the backend-port plan).
                ocr_engine: None,
                skip_ocr: None,
                skip_detect: None,
                skip_inpaint: None,
                detector_engine: None,
                anime_yolo_variant: None,
                anime_yolo_confidence: None,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        Ok("Pipeline started".to_string())
    }

    #[tool(
        description = "Update a text block's properties. Only the fields you provide will be changed."
    )]
    async fn update_text_block(
        &self,
        Parameters(p): Parameters<UpdateTextBlockPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let info = operations::update_text_block(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(description = "Add a new empty text block at the specified position")]
    async fn add_text_block(
        &self,
        Parameters(p): Parameters<AddTextBlockPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let index = operations::add_text_block(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Added text block at index {index}"))
    }

    #[tool(description = "Remove a text block by index")]
    async fn remove_text_block(
        &self,
        Parameters(p): Parameters<RemoveTextBlockPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let remaining = operations::remove_text_block(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Removed text block. {remaining} remaining."))
    }

    #[tool(description = "Dilate the text detection mask by radius")]
    async fn dilate_mask(
        &self,
        Parameters(p): Parameters<MaskMorphPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        operations::dilate_mask(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok("Dilated mask".to_string())
    }

    #[tool(description = "Erode the text detection mask by radius")]
    async fn erode_mask(
        &self,
        Parameters(p): Parameters<MaskMorphPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        operations::erode_mask(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok("Eroded mask".to_string())
    }

    #[tool(description = "Re-inpaint a specific rectangular region")]
    async fn inpaint_region(
        &self,
        Parameters(p): Parameters<InpaintRegionParams>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        operations::inpaint_partial(
            res,
            InpaintPartialPayload {
                index: p.index,
                region: InpaintRegion {
                    x: p.x,
                    y: p.y,
                    width: p.width,
                    height: p.height,
                },
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        Ok(format!(
            "Inpainted region ({},{}) {}x{}",
            p.x, p.y, p.width, p.height
        ))
    }

    // ============================================================
    // Project lifecycle
    // ============================================================

    #[tool(
        description = "Create a new Koharu project at the given absolute directory path. Returns project info."
    )]
    async fn project_create(
        &self,
        Parameters(p): Parameters<ProjectCreatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let info = operations::project_create(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Open an existing project. Path can be the project root directory or the series.koharuproj manifest file."
    )]
    async fn project_open(
        &self,
        Parameters(p): Parameters<ProjectOpenPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let info = operations::project_open(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(description = "Close the currently open project (no-op if none open)")]
    async fn project_close(&self) -> Result<String, String> {
        let res = self.resources()?;
        operations::project_close(res)
            .await
            .map_err(|e| e.to_string())?;
        Ok("Project closed".to_string())
    }

    #[tool(description = "Return info about the currently-open project (null if none)")]
    async fn project_current(&self) -> Result<String, String> {
        let res = self.resources()?;
        let info = operations::project_current(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(description = "List recently-opened projects (path, name, last opened timestamp)")]
    async fn recent_projects_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let list = operations::recent_projects_list(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
    }

    #[tool(description = "Remove a path from the recent-projects list")]
    async fn recent_projects_remove(
        &self,
        Parameters(p): Parameters<RecentProjectRemovePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let removed = operations::recent_projects_remove(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if removed {
            "Removed".to_string()
        } else {
            "Not in list".to_string()
        })
    }

    // ============================================================
    // Series metadata
    // ============================================================

    #[tool(
        description = "Get the series metadata for the open project (title, languages, tone, style notes, etc.)"
    )]
    async fn series_meta_get(&self) -> Result<String, String> {
        let res = self.resources()?;
        let meta = operations::series_meta_get(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Update series metadata. Only provided fields are changed. Returns the new state."
    )]
    async fn series_meta_update(
        &self,
        Parameters(p): Parameters<SeriesMetaUpdatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let meta = operations::series_meta_update(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())
    }

    // ============================================================
    // Chapters
    // ============================================================

    #[tool(description = "List all chapters in the open project, sorted by chapter number")]
    async fn chapters_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let list = operations::chapters_list(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Create a new chapter. Auto-creates <project>/chapters/<name>/source/ and render/ subfolders. Use chapter_add_pages_from_paths to add page images."
    )]
    async fn chapter_create(
        &self,
        Parameters(p): Parameters<ChapterCreatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::chapter_create(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Copy one or more page image files from disk into a chapter's source/ folder. Refreshes page_count. Returns count of added/skipped."
    )]
    async fn chapter_add_pages_from_paths(
        &self,
        Parameters(p): Parameters<ChapterAddPagesFromPathsParams>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let paths: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
        let result = operations::chapter_add_pages_from_paths(res, p.chapter_id, paths)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "Added {} page(s), skipped {}",
            result.added, result.skipped
        ))
    }

    #[tool(
        description = "Open a chapter into the editor: enumerates pages in source/ and loads them all as documents. Returns the page count."
    )]
    async fn chapter_open(
        &self,
        Parameters(p): Parameters<ChapterIdPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let count = operations::chapter_open(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Opened chapter — {count} page(s) loaded"))
    }

    #[tool(
        description = "Update a chapter's fields (title, chapter_number, volume, status, summary, notes, page_count). Only provided fields are changed."
    )]
    async fn chapter_update(
        &self,
        Parameters(p): Parameters<ChapterUpdatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::chapter_update(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Remove a chapter from the index (files on disk are not deleted)")]
    async fn chapter_remove(
        &self,
        Parameters(p): Parameters<ChapterIdPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let removed = operations::chapter_remove(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if removed { "Removed" } else { "Not found" }.to_string())
    }

    // ============================================================
    // Characters
    // ============================================================

    #[tool(description = "List all characters defined in the open project")]
    async fn characters_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let list = operations::characters_list(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
    }

    #[tool(description = "Add a character (original + translated name, aliases, role, etc.)")]
    async fn character_add(
        &self,
        Parameters(p): Parameters<CharacterAddPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::character_add(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Update a character. Only provided fields are changed.")]
    async fn character_update(
        &self,
        Parameters(p): Parameters<CharacterUpdatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::character_update(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Remove a character by id")]
    async fn character_remove(
        &self,
        Parameters(p): Parameters<CharacterIdPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let removed = operations::character_remove(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if removed { "Removed" } else { "Not found" }.to_string())
    }

    // ============================================================
    // Glossary
    // ============================================================

    #[tool(description = "List all glossary entries (source/target/category/aliases/usage count)")]
    async fn glossary_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let list = operations::glossary_list(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Add a glossary entry. Category must be one of: character, place, term, skill, honorific, item, org, sfx."
    )]
    async fn glossary_add(
        &self,
        Parameters(p): Parameters<GlossaryAddPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::glossary_add(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Bulk-add glossary entries — atomic insert with duplicate detection. Returns counts."
    )]
    async fn glossary_bulk_add(
        &self,
        Parameters(p): Parameters<GlossaryBulkAddPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let result = operations::glossary_bulk_add(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
    }

    #[tool(description = "Update a glossary entry. Only provided fields are changed.")]
    async fn glossary_update(
        &self,
        Parameters(p): Parameters<GlossaryUpdatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::glossary_update(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Remove a glossary entry by id")]
    async fn glossary_remove(
        &self,
        Parameters(p): Parameters<GlossaryIdPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let removed = operations::glossary_remove(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if removed { "Removed" } else { "Not found" }.to_string())
    }

    #[tool(
        description = "Bump usage_count for a batch of glossary entries — call after a successful translation that used them."
    )]
    async fn glossary_bump_usage(
        &self,
        Parameters(p): Parameters<GlossaryBumpUsagePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        operations::glossary_bump_usage(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok("Usage counts bumped".to_string())
    }

    // ============================================================
    // Prompt templates + rendering
    // ============================================================

    #[tool(description = "List all prompt templates (name, use_case, is_default)")]
    async fn prompt_templates_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let list = operations::prompt_templates_list(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Add a prompt template. use_case ∈ {translate, extract_entities, summarize_chapter}. Template is Handlebars-rendered with series + character + glossary + rolling-summary context."
    )]
    async fn prompt_template_add(
        &self,
        Parameters(p): Parameters<PromptTemplateAddPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::prompt_template_add(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Update a prompt template. Only provided fields are changed.")]
    async fn prompt_template_update(
        &self,
        Parameters(p): Parameters<PromptTemplateUpdatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::prompt_template_update(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Remove a prompt template by id")]
    async fn prompt_template_remove(
        &self,
        Parameters(p): Parameters<PromptTemplateIdPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let removed = operations::prompt_template_remove(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if removed { "Removed" } else { "Not found" }.to_string())
    }

    #[tool(
        description = "Render a prompt: resolves the template (by name or use_case default), assembles series + main characters + glossary-filtered + rolling-summary context, and returns the rendered prompt plus glossary entry IDs that matched."
    )]
    async fn prompt_render(
        &self,
        Parameters(p): Parameters<PromptRenderPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let result = operations::prompt_render(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
    }

    // ============================================================
    // Translation memory
    // ============================================================

    #[tool(
        description = "Exact-match TM lookup. Returns the cached translation if source_text + target_lang match a previous entry."
    )]
    async fn tm_lookup(
        &self,
        Parameters(p): Parameters<TmLookupPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::tm_lookup(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Fuzzy TM lookup using Jaccard similarity. min_similarity is 0.0..1.0 (0.85 is a sane default). Returns entry + similarity score."
    )]
    async fn tm_lookup_fuzzy(
        &self,
        Parameters(p): Parameters<TmLookupFuzzyPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let hit = operations::tm_lookup_fuzzy(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&hit).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Insert a TM entry — call after a confirmed translation so future identical/near-identical source matches the cached target."
    )]
    async fn tm_insert(
        &self,
        Parameters(p): Parameters<TmInsertPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::tm_insert(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    // ============================================================
    // Provider profiles
    // ============================================================

    #[tool(description = "List all saved LLM provider profiles (api_key is never returned)")]
    async fn provider_profiles_list(&self) -> Result<String, String> {
        let res = self.resources()?;
        let list = operations::provider_profiles_list(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Add a provider profile. provider ∈ {openai, openrouter, gemini, anthropic}. api_key is stored in the OS keyring server-side and never written to the DB. Empty api_key leaves the keyring entry unset."
    )]
    async fn provider_profile_add(
        &self,
        Parameters(p): Parameters<ProviderProfileAddPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::provider_profile_add(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Update a provider profile. api_key: omit to leave alone, '' to clear, non-empty to (re)write the keyring entry."
    )]
    async fn provider_profile_update(
        &self,
        Parameters(p): Parameters<ProviderProfileUpdatePayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let dto = operations::provider_profile_update(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&dto).map_err(|e| e.to_string())
    }

    #[tool(description = "Remove a provider profile (also deletes its keyring entry)")]
    async fn provider_profile_remove(
        &self,
        Parameters(p): Parameters<ProviderProfileIdPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let removed = operations::provider_profile_remove(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok(if removed { "Removed" } else { "Not found" }.to_string())
    }

    // ============================================================
    // LLM cost log + stats
    // ============================================================

    #[tool(
        description = "Record an LLM call in the cost log (token counts, cost, duration, success/failure)."
    )]
    async fn llm_call_log(
        &self,
        Parameters(p): Parameters<LlmCallLogPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        operations::llm_call_log(res, p)
            .await
            .map_err(|e| e.to_string())?;
        Ok("Logged".to_string())
    }

    #[tool(
        description = "Aggregate stats from the LLM cost log: total calls, successes, total tokens, total USD cost."
    )]
    async fn llm_cost_stats(&self) -> Result<String, String> {
        let res = self.resources()?;
        let stats = operations::llm_cost_stats(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())
    }

    #[tool(
        description = "LLM cost breakdown: lists per-profile, per-chapter, per-day (last 30 days), and per-use-case spend with token counts. Use to diagnose where translation cost is concentrated."
    )]
    async fn llm_cost_breakdown(&self) -> Result<String, String> {
        let res = self.resources()?;
        let bd = operations::llm_cost_breakdown(res)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&bd).map_err(|e| e.to_string())
    }

    // ============================================================
    // Web fetch (agentic tool — for wiki / fandom summarisation)
    // ============================================================

    #[tool(
        description = "Fetch a URL and return its text content (HTML stripped to readable text, with title). Use this to pull manga wikis / fandom pages / blog posts into context so you can summarise into series_meta + characters + glossary. 12s timeout, 1.5MB cap, 5 redirects."
    )]
    async fn web_fetch_url(
        &self,
        Parameters(p): Parameters<WebFetchPayload>,
    ) -> Result<String, String> {
        let res = self.resources()?;
        let result = operations::web_fetch_url(res, p)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
    }
}

#[tool_handler]
impl ServerHandler for KoharuMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            server_info: Implementation {
                name: "koharu".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                ..Default::default()
            },
            capabilities: ServerCapabilities {
                tools: Some(ToolsCapability::default()),
                ..Default::default()
            },
            instructions: Some(
                "Koharu manga translation tools. Use open_documents to load images, then detect -> ocr -> inpaint -> llm_generate -> render to translate.".to_string(),
            ),
            ..Default::default()
        }
    }
}
