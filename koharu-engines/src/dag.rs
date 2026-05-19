//! DAG resolver — derives execution order from each engine's
//! `consumes` / `produces` [`ArtifactKind`](koharu_core::ArtifactKind)
//! declarations.
//!
//! See `docs/v2-arch.md` §4.4 (post-#33 re-review) for the design
//! rationale: dropped `PipelineStage` enum, replaced with artifact-
//! flow declarations so one engine can produce multiple artifacts in
//! one pass (Anime Text YOLO → DetectionBoxes + SegmentationMask) +
//! multiple engines can produce the same artifact (the user picks
//! via Engine Profile UI).
//!
//! ## Usage
//!
//! ```ignore
//! use koharu_engines::dag::{resolve_plan, PlanRequest};
//! use koharu_core::ArtifactKind::*;
//!
//! let plan = resolve_plan(PlanRequest {
//!     targets: vec![Translation, RenderedImage],
//!     prefer: [(OcrText, "mit48px_ocr")].into_iter().collect(),
//! })?;
//! for engine_info in plan {
//!     // ... drive each engine in order
//! }
//! ```
//!
//! Returns engines in topological order: every engine in the list
//! appears AFTER any engine that produces an artifact it consumes.
//! De-duplicated — an engine that produces multiple desired
//! artifacts (e.g. comic_text_detector → DetectionBoxes AND
//! SegmentationMask) appears once.
//!
//! ## Scope of Phase 4.6
//!
//! Pure planning — no execution. The driver in `koharu-pipeline`
//! consumes the returned plan and runs each engine via the bridge.
//! The resolver itself is `&'static EngineInfo`-only so it can run
//! cheaply at planning time without engine instantiation.

use std::collections::{HashMap, HashSet};

use koharu_core::ArtifactKind;

use crate::info::{EngineInfo, all_engines};

/// Inputs to the DAG resolver.
pub struct PlanRequest {
    /// The artifacts the caller wants produced. Resolver walks
    /// backwards from each target to find the engine chain that
    /// produces it.
    pub targets: Vec<ArtifactKind>,

    /// Disambiguation map for artifacts with multiple producers
    /// (e.g. `OcrText` → "mit48px_ocr" or "manga_ocr"). Resolver
    /// picks the engine whose `id` matches the value. Missing entry
    /// for a multi-producer artifact = ambiguous error.
    pub prefer: HashMap<ArtifactKind, &'static str>,
}

/// Reasons resolver might fail. Each variant carries enough detail
/// for the UI to surface a useful error (which engine is missing,
/// which artifact has no producer, etc.).
#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    /// No engine in the inventory produces the requested artifact.
    /// Likely cause: engine crate not linked into the binary
    /// (inventory submission dead-stripped) or the artifact name
    /// is mis-typed in the caller.
    #[error("no engine produces artifact {artifact:?}")]
    NoProducer { artifact: ArtifactKind },

    /// Multiple engines produce this artifact but the
    /// `PlanRequest.prefer` map didn't pick one. UI should surface
    /// the candidates so the user can choose.
    #[error("multiple engines produce {artifact:?}: {candidates:?}; pass `prefer` to disambiguate")]
    AmbiguousProducer {
        artifact: ArtifactKind,
        candidates: Vec<&'static str>,
    },

    /// The user passed an engine id in `prefer` that doesn't exist
    /// in the inventory. Typo or stale saved profile.
    #[error("preferred engine `{engine_id}` for {artifact:?} not found in inventory")]
    UnknownPreferredEngine {
        artifact: ArtifactKind,
        engine_id: &'static str,
    },

    /// The `prefer` map picked an engine that exists but doesn't
    /// produce the requested artifact. Programmer error in the UI
    /// layer.
    #[error("engine `{engine_id}` does not produce {artifact:?}")]
    PreferredEngineWrongOutput {
        artifact: ArtifactKind,
        engine_id: &'static str,
    },

    /// Engine A consumes B's output and B consumes A's output — the
    /// declarations form a cycle. Almost certainly a declaration
    /// bug; document the offending chain so it's fixable.
    #[error("cycle in engine dependency graph: {stack:?}")]
    Cycle { stack: Vec<&'static str> },
}

/// Resolve a [`PlanRequest`] into an ordered list of engines.
pub fn resolve_plan(
    request: PlanRequest,
) -> Result<Vec<&'static EngineInfo>, ResolveError> {
    let mut state = ResolveState {
        prefer: request.prefer,
        plan: Vec::new(),
        plan_ids: HashSet::new(),
        in_progress: Vec::new(),
    };
    for target in request.targets {
        state.resolve_artifact(target)?;
    }
    Ok(state.plan)
}

/// Internal walk state. Lives only for one `resolve_plan` call.
struct ResolveState {
    prefer: HashMap<ArtifactKind, &'static str>,
    /// Engines in topological order. Producer of an artifact
    /// appears BEFORE every engine that consumes it.
    plan: Vec<&'static EngineInfo>,
    /// Set of engine ids already in `plan`. Skips re-adding the
    /// same engine when it produces multiple desired artifacts
    /// (e.g. comic_text_detector emits boxes + mask in one run).
    plan_ids: HashSet<&'static str>,
    /// Stack of engine ids currently being resolved. Used for
    /// cycle detection: if an engine in `in_progress` is asked to
    /// resolve itself, we've found a cycle.
    in_progress: Vec<&'static str>,
}

impl ResolveState {
    fn resolve_artifact(&mut self, target: ArtifactKind) -> Result<(), ResolveError> {
        // SourceImage is always present (the page image the user
        // imported); no engine produces it. Walking past it is
        // valid + means "skip, dep satisfied".
        if target.is_source() {
            return Ok(());
        }

        let producer = self.pick_producer(target)?;

        // Already in the plan? Done — the engine that produces this
        // artifact ran (or will run) earlier in the chain.
        if self.plan_ids.contains(producer.id) {
            return Ok(());
        }

        // Cycle: this engine asks for an artifact that one of its
        // ancestors produces. Defensive — engine declarations
        // shouldn't make this possible, but a bug would otherwise
        // recurse forever.
        if self.in_progress.contains(&producer.id) {
            let mut stack = self.in_progress.clone();
            stack.push(producer.id);
            return Err(ResolveError::Cycle { stack });
        }

        self.in_progress.push(producer.id);

        // Recursively resolve each input artifact of `producer`
        // BEFORE adding `producer` to the plan — topological order.
        for &input in producer.consumes {
            self.resolve_artifact(input)?;
        }

        self.in_progress.pop();
        self.plan.push(producer);
        self.plan_ids.insert(producer.id);
        Ok(())
    }

    fn pick_producer(&self, artifact: ArtifactKind) -> Result<&'static EngineInfo, ResolveError> {
        let candidates: Vec<&'static EngineInfo> = all_engines()
            .filter(|info| info.produces.contains(&artifact))
            .collect();

        match candidates.len() {
            0 => Err(ResolveError::NoProducer { artifact }),
            1 => Ok(candidates[0]),
            _ => {
                let preferred_id = self.prefer.get(&artifact).copied().ok_or_else(|| {
                    ResolveError::AmbiguousProducer {
                        artifact,
                        candidates: candidates.iter().map(|i| i.id).collect(),
                    }
                })?;

                let preferred = all_engines().find(|info| info.id == preferred_id).ok_or(
                    ResolveError::UnknownPreferredEngine {
                        artifact,
                        engine_id: preferred_id,
                    },
                )?;

                if !preferred.produces.contains(&artifact) {
                    return Err(ResolveError::PreferredEngineWrongOutput {
                        artifact,
                        engine_id: preferred_id,
                    });
                }

                Ok(preferred)
            }
        }
    }
}

// NOTE: integration tests live in `koharu-pipeline/src/engine_bridge.rs`
// because they need access to the registered engines (which submit
// from `koharu-pipeline::engines::*`). When run as
// `cargo test -p koharu-engines`, the inventory is empty — no engines
// are linked — so any test calling `resolve_plan` here would see
// `NoProducer` for every request. Keep the resolver unit-test-free
// at this layer; the pipeline tests are the real coverage.
