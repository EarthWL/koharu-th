use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    AppVersion,
    Device,
    GetDocuments,
    ListFontFamilies,
    LlmList,
    LlmReady,
    LlmOffload,
    ProcessCancel,
    GetDocument,
    GetThumbnail,
    ExportDocument,
    ExportAllInpainted,
    ExportAllRendered,
    AddDocuments,
    OpenDocuments,
    OpenExternal,
    Detect,
    Ocr,
    Inpaint,
    UpdateInpaintMask,
    UpdateBrushLayer,
    InpaintPartial,
    Render,
    UpdateTextBlocks,
    LlmLoad,
    LlmGenerate,
    Process,
    // Phase 1: project lifecycle
    ProjectCreate,
    ProjectCreatePicker,
    ProjectOpen,
    ProjectOpenPicker,
    ProjectClose,
    ProjectCurrent,
    // Phase 2: series metadata + chapter index
    SeriesMetaGet,
    SeriesMetaUpdate,
    ChaptersList,
    ChapterAdd,
    ChapterUpdate,
    ChapterRemove,
    // Phase 3: characters + glossary
    CharactersList,
    CharacterAdd,
    CharacterUpdate,
    CharacterRemove,
    GlossaryList,
    GlossaryAdd,
    GlossaryUpdate,
    GlossaryRemove,
}

impl Method {
    pub const ALL: &[Method] = &[
        Method::AppVersion,
        Method::Device,
        Method::GetDocuments,
        Method::ListFontFamilies,
        Method::LlmList,
        Method::LlmReady,
        Method::LlmOffload,
        Method::ProcessCancel,
        Method::GetDocument,
        Method::GetThumbnail,
        Method::ExportDocument,
        Method::ExportAllInpainted,
        Method::ExportAllRendered,
        Method::AddDocuments,
        Method::OpenDocuments,
        Method::OpenExternal,
        Method::Detect,
        Method::Ocr,
        Method::Inpaint,
        Method::UpdateInpaintMask,
        Method::UpdateBrushLayer,
        Method::InpaintPartial,
        Method::Render,
        Method::UpdateTextBlocks,
        Method::LlmLoad,
        Method::LlmGenerate,
        Method::Process,
        Method::ProjectCreate,
        Method::ProjectCreatePicker,
        Method::ProjectOpen,
        Method::ProjectOpenPicker,
        Method::ProjectClose,
        Method::ProjectCurrent,
        Method::SeriesMetaGet,
        Method::SeriesMetaUpdate,
        Method::ChaptersList,
        Method::ChapterAdd,
        Method::ChapterUpdate,
        Method::ChapterRemove,
        Method::CharactersList,
        Method::CharacterAdd,
        Method::CharacterUpdate,
        Method::CharacterRemove,
        Method::GlossaryList,
        Method::GlossaryAdd,
        Method::GlossaryUpdate,
        Method::GlossaryRemove,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Method::AppVersion => "app_version",
            Method::Device => "device",
            Method::GetDocuments => "get_documents",
            Method::ListFontFamilies => "list_font_families",
            Method::LlmList => "llm_list",
            Method::LlmReady => "llm_ready",
            Method::LlmOffload => "llm_offload",
            Method::ProcessCancel => "process_cancel",
            Method::GetDocument => "get_document",
            Method::GetThumbnail => "get_thumbnail",
            Method::ExportDocument => "export_document",
            Method::ExportAllInpainted => "export_all_inpainted",
            Method::ExportAllRendered => "export_all_rendered",
            Method::AddDocuments => "add_documents",
            Method::OpenDocuments => "open_documents",
            Method::OpenExternal => "open_external",
            Method::Detect => "detect",
            Method::Ocr => "ocr",
            Method::Inpaint => "inpaint",
            Method::UpdateInpaintMask => "update_inpaint_mask",
            Method::UpdateBrushLayer => "update_brush_layer",
            Method::InpaintPartial => "inpaint_partial",
            Method::Render => "render",
            Method::UpdateTextBlocks => "update_text_blocks",
            Method::LlmLoad => "llm_load",
            Method::LlmGenerate => "llm_generate",
            Method::Process => "process",
            Method::ProjectCreate => "project_create",
            Method::ProjectCreatePicker => "project_create_picker",
            Method::ProjectOpen => "project_open",
            Method::ProjectOpenPicker => "project_open_picker",
            Method::ProjectClose => "project_close",
            Method::ProjectCurrent => "project_current",
            Method::SeriesMetaGet => "series_meta_get",
            Method::SeriesMetaUpdate => "series_meta_update",
            Method::ChaptersList => "chapters_list",
            Method::ChapterAdd => "chapter_add",
            Method::ChapterUpdate => "chapter_update",
            Method::ChapterRemove => "chapter_remove",
            Method::CharactersList => "characters_list",
            Method::CharacterAdd => "character_add",
            Method::CharacterUpdate => "character_update",
            Method::CharacterRemove => "character_remove",
            Method::GlossaryList => "glossary_list",
            Method::GlossaryAdd => "glossary_add",
            Method::GlossaryUpdate => "glossary_update",
            Method::GlossaryRemove => "glossary_remove",
        }
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Method {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let method = match s {
            "app_version" => Method::AppVersion,
            "device" => Method::Device,
            "get_documents" => Method::GetDocuments,
            "list_font_families" => Method::ListFontFamilies,
            "llm_list" => Method::LlmList,
            "llm_ready" => Method::LlmReady,
            "llm_offload" => Method::LlmOffload,
            "process_cancel" => Method::ProcessCancel,
            "get_document" => Method::GetDocument,
            "get_thumbnail" => Method::GetThumbnail,
            "export_document" => Method::ExportDocument,
            "export_all_inpainted" => Method::ExportAllInpainted,
            "export_all_rendered" => Method::ExportAllRendered,
            "add_documents" => Method::AddDocuments,
            "open_documents" => Method::OpenDocuments,
            "open_external" => Method::OpenExternal,
            "detect" => Method::Detect,
            "ocr" => Method::Ocr,
            "inpaint" => Method::Inpaint,
            "update_inpaint_mask" => Method::UpdateInpaintMask,
            "update_brush_layer" => Method::UpdateBrushLayer,
            "inpaint_partial" => Method::InpaintPartial,
            "render" => Method::Render,
            "update_text_blocks" => Method::UpdateTextBlocks,
            "llm_load" => Method::LlmLoad,
            "llm_generate" => Method::LlmGenerate,
            "process" => Method::Process,
            "project_create" => Method::ProjectCreate,
            "project_create_picker" => Method::ProjectCreatePicker,
            "project_open" => Method::ProjectOpen,
            "project_open_picker" => Method::ProjectOpenPicker,
            "project_close" => Method::ProjectClose,
            "project_current" => Method::ProjectCurrent,
            "series_meta_get" => Method::SeriesMetaGet,
            "series_meta_update" => Method::SeriesMetaUpdate,
            "chapters_list" => Method::ChaptersList,
            "chapter_add" => Method::ChapterAdd,
            "chapter_update" => Method::ChapterUpdate,
            "chapter_remove" => Method::ChapterRemove,
            "characters_list" => Method::CharactersList,
            "character_add" => Method::CharacterAdd,
            "character_update" => Method::CharacterUpdate,
            "character_remove" => Method::CharacterRemove,
            "glossary_list" => Method::GlossaryList,
            "glossary_add" => Method::GlossaryAdd,
            "glossary_update" => Method::GlossaryUpdate,
            "glossary_remove" => Method::GlossaryRemove,
            _ => anyhow::bail!("Unknown method: {s}"),
        };
        Ok(method)
    }
}

#[cfg(test)]
mod tests {
    use super::Method;

    #[test]
    fn round_trip() {
        for method in Method::ALL {
            let parsed: Method = method.as_str().parse().expect("method should parse");
            assert_eq!(*method, parsed);
        }
    }
}
