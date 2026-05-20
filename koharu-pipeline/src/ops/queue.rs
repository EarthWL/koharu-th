//! Translation-queue worker.
//!
//! The queue itself (CRUD + state machine) lives in
//! `koharu-project::queue`. This module is the **driver**: a tokio task
//! that pulls the oldest `pending` entry, opens the chapter, kicks the
//! existing pipeline, watches it to completion, and loops.
//!
//! Singleton: only one worker runs per `AppResources`. The Tauri layer
//! calls `ensure_running()` after every enqueue and at app startup;
//! the worker exits on its own once the pending queue is empty, and
//! `ensure_running()` re-spawns it next time there's work.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicI64, Ordering},
};
use std::time::Duration;

use anyhow::Context;
use koharu_api::commands::{
    ProcessRequest, QueueClearResult, QueueEnqueuePayload, QueueEntryDto, QueueIdPayload,
};
use koharu_api::events::{PipelineProgress, PipelineStatus};
use koharu_project::queue::{self, QueueEntry};
use tokio::sync::broadcast;

use crate::pipeline;
use crate::AppResources;

/// Per-worker handle stored on `AppResources`. Allows callers to
/// observe whether a worker is running and to cancel the currently
/// in-flight entry.
pub struct QueueWorkerHandle {
    /// Set to `true` to make the worker bail out of the current entry
    /// (cancels the underlying pipeline too) and then exit the loop.
    /// The worker clears this when it picks up the next entry.
    pub cancel_current: Arc<AtomicBool>,
    /// ID of the queue entry currently being processed (`0` while the
    /// worker is between entries). Lets the UI know which row is "live".
    pub current_entry_id: Arc<AtomicI64>,
}

/// Spawn the queue worker if it isn't already running. Idempotent —
/// safe to call from every enqueue command and from app startup.
///
/// Takes the write lock on `queue_worker` for the spawn-decision so
/// the worker's own "no more work, exit" check (which runs under the
/// same lock) can't race with a freshly enqueued entry stranding it.
pub async fn ensure_running(state: AppResources) -> anyhow::Result<()> {
    let mut guard = state.queue_worker.write().await;
    if guard.is_some() {
        return Ok(());
    }
    // Only spawn if there's actually work to do — avoids burning a
    // task just to query the DB and exit.
    if !has_pending_work(&state).await? {
        return Ok(());
    }

    let cancel_current = Arc::new(AtomicBool::new(false));
    let current_entry_id = Arc::new(AtomicI64::new(0));
    *guard = Some(QueueWorkerHandle {
        cancel_current: cancel_current.clone(),
        current_entry_id: current_entry_id.clone(),
    });
    drop(guard);

    let res = state.clone();
    tokio::spawn(async move {
        let outcome = worker_loop(res.clone(), cancel_current, current_entry_id).await;
        if let Err(err) = outcome {
            tracing::error!("queue worker exited with error: {err:#}");
            // On error we still must clear the handle so the next
            // ensure_running can spawn a fresh worker — the normal
            // exit path does this atomically under the lock; the error
            // path does it unconditionally here.
            let mut guard = res.queue_worker.write().await;
            *guard = None;
        }
    });
    Ok(())
}

/// Request cancellation of the entry the worker is currently running.
/// No-op if the worker isn't running or is between entries. The DB
/// status update is the responsibility of the caller (Tauri command
/// flips the entry to `cancelled` before calling this) — this signal
/// just makes the worker bail out of the pipeline early.
pub async fn cancel_active(state: &AppResources, entry_id: i64) {
    let guard = state.queue_worker.read().await;
    if let Some(handle) = guard.as_ref() {
        let current = handle.current_entry_id.load(Ordering::Relaxed);
        if current == entry_id {
            handle.cancel_current.store(true, Ordering::Relaxed);
        }
    }
}

async fn has_pending_work(state: &AppResources) -> anyhow::Result<bool> {
    let project = state
        .project
        .read()
        .await
        .clone()
        .context("No project is currently open")?;
    let next = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = project.pool().get()?;
        Ok(queue::next_pending(&conn)?.is_some())
    })
    .await??;
    Ok(next)
}

async fn worker_loop(
    state: AppResources,
    cancel_current: Arc<AtomicBool>,
    current_entry_id: Arc<AtomicI64>,
) -> anyhow::Result<()> {
    loop {
        let project = match state.project.read().await.clone() {
            Some(p) => p,
            None => {
                // Project was closed under us. Clear the handle and
                // exit; another ensure_running on the next project
                // will start a fresh one.
                tracing::info!("queue worker exiting: no project open");
                let mut guard = state.queue_worker.write().await;
                *guard = None;
                return Ok(());
            }
        };

        // Pull next pending entry inside spawn_blocking — rusqlite is sync.
        let entry = {
            let p = project.clone();
            tokio::task::spawn_blocking(move || -> anyhow::Result<Option<queue::QueueEntry>> {
                let conn = p.pool().get()?;
                Ok(queue::next_pending(&conn)?)
            })
            .await??
        };

        if entry.is_none() {
            // Atomic "exit or pick up new work" under the write lock —
            // pairs with ensure_running's write-lock spawn so we can't
            // exit while a new entry is being enqueued.
            let mut guard = state.queue_worker.write().await;
            let recheck = {
                let p = project.clone();
                tokio::task::spawn_blocking(move || -> anyhow::Result<Option<queue::QueueEntry>> {
                    let conn = p.pool().get()?;
                    Ok(queue::next_pending(&conn)?)
                })
                .await??
            };
            if recheck.is_some() {
                // Someone enqueued between our two checks. Don't clear
                // the handle — loop and grab it next iteration.
                drop(guard);
                continue;
            }
            tracing::info!("queue worker exiting: no more pending entries");
            *guard = None;
            return Ok(());
        }
        let entry = entry.unwrap();

        // Reset per-entry signal + advertise current entry to observers.
        cancel_current.store(false, Ordering::Relaxed);
        current_entry_id.store(entry.id, Ordering::Relaxed);

        if let Err(err) = process_entry(&state, &project, &entry, &cancel_current).await {
            tracing::warn!(entry = entry.id, "queue entry failed: {err:#}");
            let err_msg = format!("{err:#}");
            let p = project.clone();
            let id = entry.id;
            let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let conn = p.pool().get()?;
                queue::mark_failed(&conn, id, &err_msg)?;
                Ok(())
            })
            .await;
        }

        current_entry_id.store(0, Ordering::Relaxed);
    }
}

async fn process_entry(
    state: &AppResources,
    project: &koharu_project::Project,
    entry: &queue::QueueEntry,
    cancel_current: &Arc<AtomicBool>,
) -> anyhow::Result<()> {
    use koharu_api::commands::ChapterIdPayload;

    // Try to stamp running. If the row is no longer `pending`, the
    // user cancelled it in the gap between next_pending() and now —
    // skip without doing any work or touching its final status.
    let p = project.clone();
    let id = entry.id;
    let claimed = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = p.pool().get()?;
        Ok(queue::mark_running(&conn, id)?)
    })
    .await??;
    if !claimed {
        tracing::info!(entry = id, "queue: entry was cancelled before worker claimed it");
        return Ok(());
    }

    if cancel_current.load(Ordering::Relaxed) {
        let p = project.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let conn = p.pool().get()?;
            queue::cancel(&conn, id)?;
            Ok(())
        })
        .await??;
        return Ok(());
    }

    // Wait for any in-flight pipeline to drain before we kick our own.
    // `process()` enforces one pipeline at a time; rather than racing
    // we politely yield.
    while state.pipeline.read().await.is_some() {
        if cancel_current.load(Ordering::Relaxed) {
            let p = project.clone();
            tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let conn = p.pool().get()?;
                queue::cancel(&conn, id)?;
                Ok(())
            })
            .await??;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // Open the chapter — replaces currently-loaded docs in res.state.
    let chapter_id = entry.chapter_id;
    super::chapter_open(state.clone(), ChapterIdPayload { id: chapter_id }).await?;

    // Subscribe to pipeline events BEFORE kicking so we don't miss the
    // first Running tick.
    let mut rx = pipeline::subscribe();

    super::process(
        state.clone(),
        ProcessRequest {
            index: None,
            language: None,
            llm_model_id: None,
            shader_effect: None,
            shader_stroke: None,
            font_family: None,
            // Queue worker uses backend default OCR engine — when we
            // grow per-project engine preferences, read from the
            // project DB here instead.
            ocr_engine: None,
            // Cloud Vision OCR is frontend-orchestrated, so the queue
            // worker never sets skip_ocr / skip_detect — local OCR
            // always runs in batch. See roadmap_next_features Tier B
            // #3 for the backend-port plan that would change this.
            skip_ocr: None,
            skip_detect: None,
            // Queue uses default detector — if user wants AnimeText
            // YOLO in batch, read it from project prefs here.
            detector_engine: None,
            anime_yolo_variant: None,
            anime_yolo_confidence: None,
            // Queue uses the default "do everything" pipeline; no
            // user-driven re-translate flow here, so always inpaint.
            skip_inpaint: None,
            // Batch always translates locally (Cloud LLM translate is a
            // per-page frontend flow, like Cloud Vision OCR).
            skip_translate: None,
        },
    )
    .await?;

    // Drain pipeline events for THIS run until it reports terminal status.
    loop {
        if cancel_current.load(Ordering::Relaxed) {
            super::process_cancel(state.clone()).await?;
            // Let pipeline reach its own terminal event so the guard clears.
            // Fall through and keep recv()-ing until we see Cancelled.
        }
        match rx.recv().await {
            Ok(progress) => {
                update_entry_progress(project, entry.id, &progress).await?;
                match &progress.status {
                    PipelineStatus::Completed => {
                        let p = project.clone();
                        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                            let conn = p.pool().get()?;
                            queue::mark_completed(&conn, id)?;
                            Ok(())
                        })
                        .await??;
                        return Ok(());
                    }
                    PipelineStatus::Failed(msg) => {
                        let msg = msg.clone();
                        let p = project.clone();
                        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                            let conn = p.pool().get()?;
                            queue::mark_failed(&conn, id, &msg)?;
                            Ok(())
                        })
                        .await??;
                        return Ok(());
                    }
                    PipelineStatus::Cancelled => {
                        // DB row was already flipped to 'cancelled' by
                        // the UI Tauri command before signalling us; but
                        // for safety idempotently re-mark.
                        let p = project.clone();
                        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                            let conn = p.pool().get()?;
                            queue::cancel(&conn, id)?;
                            Ok(())
                        })
                        .await??;
                        return Ok(());
                    }
                    PipelineStatus::Running => {
                        // Keep draining.
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // Pipeline is emitting faster than we can drain — fine,
                // we'll just miss intermediate progress ticks. Keep
                // listening for terminal status.
            }
            Err(broadcast::error::RecvError::Closed) => {
                // Channel is global Lazy — closed should never happen.
                // Bail just in case so the worker isn't pinned forever.
                anyhow::bail!("pipeline event channel closed unexpectedly");
            }
        }
    }
}

async fn update_entry_progress(
    project: &koharu_project::Project,
    entry_id: i64,
    progress: &PipelineProgress,
) -> anyhow::Result<()> {
    let done = progress.current_document as i64;
    let total = progress.total_documents as i64;
    let p = project.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = p.pool().get()?;
        queue::update_progress(&conn, entry_id, done, total)?;
        Ok(())
    })
    .await??;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────
// Tauri command handlers (called from koharu-rpc dispatch).
// ─────────────────────────────────────────────────────────────────

fn entry_to_dto(e: QueueEntry) -> QueueEntryDto {
    QueueEntryDto {
        id: e.id,
        chapter_id: e.chapter_id,
        status: e.status.as_ref().to_string(),
        total_pages: e.total_pages,
        done_pages: e.done_pages,
        error_message: e.error_message,
        enqueued_at: e.enqueued_at,
        started_at: e.started_at,
        finished_at: e.finished_at,
    }
}

async fn require_project_for_queue(
    state: &AppResources,
) -> anyhow::Result<koharu_project::Project> {
    state
        .project
        .read()
        .await
        .clone()
        .context("No project is currently open")
}

pub async fn queue_list(state: AppResources) -> anyhow::Result<Vec<QueueEntryDto>> {
    let project = require_project_for_queue(&state).await?;
    let entries = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<QueueEntryDto>> {
        let conn = project.pool().get()?;
        Ok(queue::list(&conn)?.into_iter().map(entry_to_dto).collect())
    })
    .await??;
    Ok(entries)
}

pub async fn queue_enqueue(
    state: AppResources,
    payload: QueueEnqueuePayload,
) -> anyhow::Result<QueueEntryDto> {
    let project = require_project_for_queue(&state).await?;
    let chapter_id = payload.chapter_id;
    let entry = {
        let p = project.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<QueueEntry> {
            let conn = p.pool().get()?;
            Ok(queue::enqueue(&conn, chapter_id)?)
        })
        .await??
    };
    // Kick the worker so the new entry doesn't sit forever waiting for
    // someone else to notice it. Cheap if a worker is already running.
    ensure_running(state.clone()).await?;
    Ok(entry_to_dto(entry))
}

pub async fn queue_cancel(
    state: AppResources,
    payload: QueueIdPayload,
) -> anyhow::Result<()> {
    let project = require_project_for_queue(&state).await?;
    let id = payload.id;
    {
        let p = project.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let conn = p.pool().get()?;
            queue::cancel(&conn, id)?;
            Ok(())
        })
        .await??;
    }
    // If the worker is currently running this entry, signal it to
    // bail out of the pipeline early. Otherwise the DB update is
    // enough — a pending entry that's now `cancelled` won't be
    // returned by `next_pending`.
    cancel_active(&state, id).await;
    Ok(())
}

pub async fn queue_clear_finished(
    state: AppResources,
) -> anyhow::Result<QueueClearResult> {
    let project = require_project_for_queue(&state).await?;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        let conn = project.pool().get()?;
        Ok(queue::clear_finished(&conn)?)
    })
    .await??;
    Ok(QueueClearResult { removed })
}
