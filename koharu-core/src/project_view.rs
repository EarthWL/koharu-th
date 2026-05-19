//! `ProjectView` — read-only handle to project-level data.
//!
//! Engines receive `&ProjectView` via `EngineCtx` (Phase 3) so they
//! can read glossary entries, characters, and series metadata while
//! they run. Engines **never** mutate project state through this
//! handle — all writes flow back to the driver as `ProjectOp`s
//! inside `EngineResult`. The driver applies them under one SQLite
//! transaction (alongside any `Scene` `Op`s) so undo reverses
//! scene + project changes atomically.
//!
//! See `docs/v2-arch.md` §4.4 (re-review issue E resolution): the
//! original `EngineCtx.project: &ProjectSession` exposed `apply()`
//! and `undo()` — engines could bypass the Op pipeline. Splitting
//! `ProjectView` (reads) off `ProjectSession` (mutations) makes the
//! type system enforce the read-only contract.
//!
//! ## Phase 1.2 scope — stub
//!
//! This module ships the types only — `ProjectView::empty()` for
//! tests, owned-data rows that don't depend on `koharu-project`.
//! Phase 5 will replace the owned-`Vec` backing with a borrowed
//! view over `ProjectSession`'s SQLite-backed caches once that
//! crate exists.
//!
//! ## What's deliberately NOT here yet
//!
//! - **TM lookup** — Translation-memory primitive (semantic + exact
//!   match against historical translations). Needs the
//!   `koharu-project` `TmStore` to land first. Engine-side trait
//!   shape will be added when the translate engine is ported in
//!   Phase 4.
//! - **PromptTemplate** — Lives in `koharu-project`; the translate
//!   engine reads it via the prompt-render RPC today. Phase 4 will
//!   surface a `prompt_template(use_case)` lookup here.
//! - **Char/glossary aliases + extra metadata** — only the fields
//!   needed by NER + the QC consistency flow are exposed. Adding
//!   more is additive when an engine needs it.

use serde::{Deserialize, Serialize};

use crate::op_project::{CharacterId, GlossaryCategory, GlossaryEntryId};

/// A character row as seen from an engine. Mirror of the SQLite
/// `characters` table but read-only and owned (no SQLite borrow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharacterRow {
    pub id: CharacterId,
    pub original_name: String,
    pub translated_name: String,
    pub is_main: bool,
}

/// A glossary row as seen from an engine. Mirror of the SQLite
/// `glossary` table but read-only and owned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlossaryRow {
    pub id: GlossaryEntryId,
    pub source_text: String,
    pub target_text: String,
    pub category: GlossaryCategory,
}

/// Series-level metadata visible to engines. Source/target language
/// drive the translate engine's prompt; title goes into context
/// headers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeriesMetaRow {
    pub title: String,
    pub source_language: String,
    pub target_language: String,
}

/// Read-only project-level handle threaded into `EngineCtx`.
///
/// Phase 1.2 stub: holds owned rows so engines can call simple
/// lookup helpers (`find_character_by_original_name`, etc.) without
/// a `koharu-project` dep. Phase 5 will refactor the backing to
/// borrow from `ProjectSession`'s caches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectView {
    pub characters: Vec<CharacterRow>,
    pub glossary: Vec<GlossaryRow>,
    pub series_meta: Option<SeriesMetaRow>,
}

impl ProjectView {
    /// Empty view — useful in tests + for engines that don't need
    /// project state (detector, segmentation, OCR, render). The
    /// translate engine will require a populated view.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Find a character by the original (source-language) name.
    /// O(n) — fine for the small N typical of a manga series
    /// (tens to low hundreds). If a future engine hot-loops this,
    /// we can build an index then.
    pub fn find_character_by_original_name(&self, name: &str) -> Option<&CharacterRow> {
        self.characters.iter().find(|c| c.original_name == name)
    }

    /// Find a glossary entry by source text. Case-sensitive; the
    /// engine handles its own normalization before lookup.
    pub fn find_glossary_by_source(&self, source_text: &str) -> Option<&GlossaryRow> {
        self.glossary.iter().find(|g| g.source_text == source_text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_view_has_no_rows() {
        let view = ProjectView::empty();
        assert!(view.characters.is_empty());
        assert!(view.glossary.is_empty());
        assert!(view.series_meta.is_none());
        assert!(view.find_character_by_original_name("Alice").is_none());
        assert!(view.find_glossary_by_source("剣").is_none());
    }

    #[test]
    fn character_lookup_finds_owned_row() {
        let view = ProjectView {
            characters: vec![
                CharacterRow {
                    id: CharacterId(1),
                    original_name: "アリス".into(),
                    translated_name: "อลิซ".into(),
                    is_main: true,
                },
                CharacterRow {
                    id: CharacterId(2),
                    original_name: "ボブ".into(),
                    translated_name: "บ๊อบ".into(),
                    is_main: false,
                },
            ],
            ..Default::default()
        };
        let alice = view.find_character_by_original_name("アリス").unwrap();
        assert_eq!(alice.id, CharacterId(1));
        assert!(alice.is_main);
        assert!(view.find_character_by_original_name("missing").is_none());
    }

    #[test]
    fn glossary_lookup_finds_by_source_text() {
        let view = ProjectView {
            glossary: vec![GlossaryRow {
                id: GlossaryEntryId(7),
                source_text: "魔法".into(),
                target_text: "เวทมนตร์".into(),
                category: GlossaryCategory::Term,
            }],
            ..Default::default()
        };
        let entry = view.find_glossary_by_source("魔法").unwrap();
        assert_eq!(entry.id, GlossaryEntryId(7));
        assert_eq!(entry.category, GlossaryCategory::Term);
    }

    #[test]
    fn project_view_round_trips_through_json() {
        let view = ProjectView {
            characters: vec![CharacterRow {
                id: CharacterId(42),
                original_name: "テスト".into(),
                translated_name: "เทสต์".into(),
                is_main: false,
            }],
            glossary: vec![],
            series_meta: Some(SeriesMetaRow {
                title: "Sample Title".into(),
                source_language: "ja".into(),
                target_language: "th".into(),
            }),
        };
        let json = serde_json::to_string(&view).unwrap();
        let parsed: ProjectView = serde_json::from_str(&json).unwrap();
        assert_eq!(view, parsed);
    }
}
