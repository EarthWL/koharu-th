//! `ProjectOp` — the unit of project-entity state change.
//!
//! Mirror of [`Op`](crate::op::Op) but for entities that live in
//! `koharu-project`'s SQLite store (characters, glossary, prompt
//! templates, series metadata) rather than the in-memory `Scene`.
//!
//! Engines return [`EngineResult`] carrying both `Vec<Op>` and
//! `Vec<ProjectOp>`. The driver in `koharu-app` applies them under
//! one SQLite transaction so an "extract entities" run's undo
//! reverses Scene changes (added translations) AND project changes
//! (added character / glossary rows) atomically.
//!
//! ## Why separate from `Op`
//!
//! - Scene state is in-memory; project state is SQLite-backed.
//! - Op application paths differ — Scene applies via direct write
//!   under `RwLock`; project applies via a SQLite transaction. Mixing
//!   the two in one enum would force every Op apply through both
//!   code paths even when only one side mutated.
//! - Inverse computation also differs: Scene reads pre-state from
//!   memory; project reads pre-state via SELECT. Keeping the enums
//!   separate keeps each apply path coherent.
//!
//! ## Why not just write to SQLite directly from engines
//!
//! Same reason engines don't mutate `Scene` directly — undo support.
//! Every mutation must go through the apply layer so an inverse is
//! captured for the history ring. Engines emit ops; driver applies.
//! Plus: cross-cutting subscribers (event bus, cost-dashboard
//! invalidation, autosave coordinator) get notified uniformly.
//!
//! ## Payload typing
//!
//! Field types here are intentionally **primitives + simple enums**,
//! not `koharu-project`-internal types — keeps `koharu-core` free of
//! a dep on `koharu-project`. The project crate consumes `ProjectOp`
//! at apply time and converts to its own `CharacterInsert` /
//! `GlossaryInsert` / etc. shapes.
//!
//! ## TM caches are deliberately NOT here
//!
//! Translation-memory cache writes are append-only side effects of
//! the translate engine. They should NOT consume undo slots — undoing
//! a translation shouldn't evict the cached pair (the user might
//! retry and want the cached result). TM updates flow through the
//! event bus as `SessionEvent::TmHit` and the engine's own cache
//! writer, not through `ProjectOp`.

use serde::{Deserialize, Serialize};

/// Forward declarations for double-option patches. The pattern
/// matches `TextBlockPatch` — `None` = leave unchanged,
/// `Some(None)` = explicitly clear, `Some(Some(v))` = set to v.
/// See [`crate::op::TextBlockPatch`] for the rationale + the
/// `double_option` deserializer.
use crate::op::double_option;

/// Stable identifiers used by `koharu-project`'s SQLite schema.
/// Newtypes for the same reason `PageId` etc. are newtypes — catches
/// "passed a character id where a glossary id was wanted" at compile
/// time.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct CharacterId(pub i64);

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct GlossaryEntryId(pub i64);

/// Glossary entry categories. Mirrors the enum in
/// `koharu-project`'s glossary table — duplicated here so
/// `koharu-core` doesn't depend on `koharu-project`. If a new
/// category lands in `koharu-project`, add it here AND in the
/// project crate's enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlossaryCategory {
    Character,
    Place,
    Term,
    Skill,
    Honorific,
    Item,
    Org,
    Sfx,
}

/// Confidence tag on a glossary entry. Same duplication note as
/// `GlossaryCategory`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlossaryConfidence {
    /// User entered manually.
    Manual,
    /// Extracted by the AI Chat / extract-entities engine.
    Extracted,
    /// Imported from a CSV / JSON file.
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterAlias {
    pub source: String,
    pub target: String,
}

/// New-character payload. Mirrors `CharacterAddInput` from
/// `koharu-api::commands` minus the id (assigned by SQLite).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterAdd {
    pub original_name: String,
    pub translated_name: String,
    #[serde(default)]
    pub aliases: Vec<CharacterAlias>,
    pub role: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub speech_style: Option<String>,
    pub personality: Option<String>,
    pub notes: Option<String>,
    pub is_main: bool,
    pub sort_order: Option<i32>,
}

/// Partial character update. Field-by-field choice between two
/// shapes depending on the column's nullability in `series.db`:
///
/// - **Required column** (NOT NULL in SQL) → `Option<T>`:
///   `None` = leave unchanged, `Some(v)` = set. Can't be cleared,
///   so the three-state shape would let a caller construct a Patch
///   that violates the schema and surfaces as an apply-time error
///   far from the bug source. Making "clear" unrepresentable in the
///   type keeps the error at the API boundary.
/// - **Nullable column** → `Option<Option<T>>`:
///   `None` = leave unchanged, `Some(None)` = clear (write NULL),
///   `Some(Some(v))` = set. Three-state via the `double_option`
///   deserializer (see [`crate::op::TextBlockPatch`]).
///
/// Nullability per migration V001 (`characters` table):
/// required: `original_name`, `translated_name`, `is_main`.
/// nullable: `aliases`, `role`, `gender`, `age`, `speech_style`,
/// `personality`, `notes`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CharacterPatch {
    // ── Required columns (single Option) ─────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translated_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_main: Option<bool>,

    // ── Nullable columns (double Option) ─────────────────────
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Option<Vec<CharacterAlias>>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub role: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub gender: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub age: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub speech_style: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub personality: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub notes: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlossaryAdd {
    pub source_text: String,
    pub target_text: String,
    pub category: GlossaryCategory,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub context_note: Option<String>,
    pub confidence: GlossaryConfidence,
    pub approved: bool,
}

/// Partial glossary update. Same field-by-field nullability split
/// as `CharacterPatch` — see that doc for the rationale.
///
/// Nullability per migration V001 (`glossary` table):
/// required: `source_text`, `target_text`, `category`, `approved`
/// (also `confidence` but it's not in the patch surface — confidence
/// reflects HOW the entry was created, mutating it post-hoc is
/// nonsense). nullable: `aliases`, `context_note`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlossaryPatch {
    // ── Required columns (single Option) ─────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<GlossaryCategory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,

    // ── Nullable columns (double Option) ─────────────────────
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub context_note: Option<Option<String>>,
}

/// Series-meta patch. Same field-by-field nullability split as
/// `CharacterPatch`.
///
/// Nullability per migration V001 (`series_meta` table, single row):
/// required: `title`, `source_language`, `target_language` (the
/// last two have NOT NULL DEFAULTs in SQL but the row can't carry
/// a NULL once it exists — patching with NULL would violate the
/// constraint). nullable: everything else.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SeriesMetaPatch {
    // ── Required columns (single Option) ─────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_language: Option<String>,

    // ── Nullable columns (double Option) ─────────────────────
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub title_original: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub synopsis: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub genre: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub target_audience: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub tone: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub formality_level: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub style_notes: Option<Option<String>>,
}

/// Sum type covering every legal mutation of project state.
///
/// Variant additions are non-breaking (old op logs stay readable);
/// variant removals are a breaking change requiring a schema bump.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProjectOp {
    /// Multiple project-ops applied atomically. Always wraps the
    /// project-side of an `EngineResult`; engines don't emit Batch
    /// directly.
    Batch(Vec<ProjectOp>),

    // ── Characters ───────────────────────────────────────────
    AddCharacter {
        input: CharacterAdd,
    },
    UpdateCharacter {
        id: CharacterId,
        patch: CharacterPatch,
    },
    RemoveCharacter {
        id: CharacterId,
    },

    // ── Glossary ─────────────────────────────────────────────
    AddGlossaryEntry {
        input: GlossaryAdd,
    },
    UpdateGlossaryEntry {
        id: GlossaryEntryId,
        patch: GlossaryPatch,
    },
    RemoveGlossaryEntry {
        id: GlossaryEntryId,
    },

    // ── Series meta ──────────────────────────────────────────
    UpdateSeriesMeta {
        patch: SeriesMetaPatch,
    },

    // ── Prompt templates ─────────────────────────────────────
    /// Replace the prompt body for a given use case (e.g.
    /// `"translate"` / `"extract_entities"` / `"summarize_chapter"`).
    UpdatePromptTemplate {
        use_case: String,
        body: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glossary_category_round_trip_lowercase() {
        let cat = GlossaryCategory::Honorific;
        let s = serde_json::to_string(&cat).unwrap();
        assert_eq!(s, "\"honorific\"");
        let cat2: GlossaryCategory = serde_json::from_str(&s).unwrap();
        assert_eq!(cat, cat2);
    }

    #[test]
    fn character_patch_empty_serializes_to_open_brace() {
        let p = CharacterPatch::default();
        let s = serde_json::to_string(&p).unwrap();
        // All fields skip when outer None, so an empty patch is `{}`.
        assert_eq!(s, "{}");
    }

    #[test]
    fn character_patch_explicit_clear_round_trips_on_nullable_field() {
        // outer Some(None) on the wire = "role": null. Works on
        // nullable columns (role, personality, etc.) — but the patch
        // SHAPE forbids it on required columns: original_name is
        // Option<String>, so you can't construct
        // `CharacterPatch { original_name: Some(None), .. }` — won't
        // typecheck.
        let mut p = CharacterPatch::default();
        p.role = Some(None);
        p.personality = Some(Some("calm".into()));
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"role\":null"));
        assert!(s.contains("\"personality\":\"calm\""));
        assert!(!s.contains("\"original_name\""));

        let p2: CharacterPatch = serde_json::from_str(&s).unwrap();
        assert!(matches!(p2.role, Some(None)));
        assert!(matches!(p2.personality, Some(Some(ref v)) if v == "calm"));
        assert!(matches!(p2.original_name, None));
    }

    #[test]
    fn character_patch_required_field_uses_single_option() {
        // Set a required field (original_name) to a value. The type
        // is Option<String>, not Option<Option<String>> — making
        // "clear the required field" unrepresentable so the schema
        // constraint is enforced at the API boundary, not at apply
        // time.
        let mut p = CharacterPatch::default();
        p.original_name = Some("新しい名前".into());
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"original_name\":\"新しい名前\""));

        let p2: CharacterPatch = serde_json::from_str(&s).unwrap();
        assert_eq!(p2.original_name.as_deref(), Some("新しい名前"));
    }

    #[test]
    fn glossary_patch_required_fields_cant_be_cleared_by_type() {
        // Same shape contract on the glossary side. source_text /
        // target_text / category / approved are required → single
        // Option. aliases / context_note are nullable → double Option.
        let mut p = GlossaryPatch::default();
        p.source_text = Some("魔法剣".into());
        p.context_note = Some(None); // explicit clear of nullable field
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"source_text\":\"魔法剣\""));
        assert!(s.contains("\"context_note\":null"));
        assert!(!s.contains("\"target_text\""));
    }

    #[test]
    fn project_op_round_trip() {
        let op = ProjectOp::Batch(vec![
            ProjectOp::AddCharacter {
                input: CharacterAdd {
                    original_name: "ヤマト".into(),
                    translated_name: "ยามาโตะ".into(),
                    aliases: vec![],
                    role: Some("protagonist".into()),
                    gender: None,
                    age: None,
                    speech_style: Some("casual".into()),
                    personality: None,
                    notes: None,
                    is_main: true,
                    sort_order: Some(0),
                },
            },
            ProjectOp::AddGlossaryEntry {
                input: GlossaryAdd {
                    source_text: "魔法剣".into(),
                    target_text: "ดาบเวทย์".into(),
                    category: GlossaryCategory::Term,
                    aliases: vec!["magic sword".into()],
                    context_note: Some("Main character's weapon".into()),
                    confidence: GlossaryConfidence::Manual,
                    approved: true,
                },
            },
        ]);
        let s = serde_json::to_string(&op).unwrap();
        let op2: ProjectOp = serde_json::from_str(&s).unwrap();
        // Compare by re-serialization (ProjectOp doesn't derive PartialEq
        // because nested patches use f-able types in the future).
        assert_eq!(s, serde_json::to_string(&op2).unwrap());
    }
}
