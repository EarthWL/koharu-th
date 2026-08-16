use std::path::{Path, PathBuf};

use image::ImageFormat;
use koharu_api::commands::{
    DeviceInfo, FileResult, IndexPayload, OpenDocumentsPayload, OpenExternalPayload,
    ThumbnailResult,
};
use rfd::FileDialog;

use crate::{AppResources, state_tx};

use super::utils::{encode_image, load_documents, mime_from_ext};

fn next_available_path(output_dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = output_dir.join(format!("{stem}.{ext}"));
    let mut suffix = 2usize;
    while candidate.exists() {
        candidate = output_dir.join(format!("{stem}_{suffix}.{ext}"));
        suffix += 1;
    }
    candidate
}

async fn pick_output_dir() -> anyhow::Result<Option<PathBuf>> {
    Ok(tokio::task::spawn_blocking(|| FileDialog::new().pick_folder()).await?)
}

/// If every loaded document was opened from a chapter folder's
/// `source/` subdirectory and they all share the same parent chapter
/// folder, return that chapter's sibling `render/` directory. Otherwise
/// `None` — caller should fall back to the folder picker.
fn chapter_render_dir(documents: &[koharu_types::Document]) -> Option<PathBuf> {
    let mut chapter_root: Option<PathBuf> = None;
    for doc in documents {
        let parent = doc.path.parent()?;
        if parent.file_name().and_then(|s| s.to_str()) != Some("source") {
            return None;
        }
        let root = parent.parent()?.to_path_buf();
        match &chapter_root {
            Some(existing) if existing != &root => return None,
            None => chapter_root = Some(root),
            _ => {}
        }
    }
    let root = chapter_root?;
    let render = root.join("render");
    std::fs::create_dir_all(&render).ok();
    Some(render)
}

fn document_ext(document: &koharu_types::Document) -> String {
    document
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jpg")
        .to_string()
}

fn export_documents_matching(
    documents: &[koharu_types::Document],
    output_dir: &Path,
    suffix: &str,
    missing_error: &str,
    image: impl Fn(&koharu_types::Document) -> Option<&koharu_types::SerializableDynamicImage>,
) -> anyhow::Result<usize> {
    let mut exported = 0usize;

    for document in documents {
        let Some(image) = image(document) else {
            continue;
        };

        let ext = document_ext(document);
        let output_path =
            next_available_path(output_dir, &format!("{}_{}", document.name, suffix), &ext);
        let bytes = encode_image(image, &ext)?;
        std::fs::write(&output_path, bytes)?;
        exported += 1;
    }

    anyhow::ensure!(exported > 0, "{missing_error}");
    Ok(exported)
}

pub async fn app_version(state: AppResources) -> anyhow::Result<String> {
    Ok(state.version.to_string())
}

pub async fn device(state: AppResources) -> anyhow::Result<DeviceInfo> {
    Ok(DeviceInfo {
        ml_device: match state.device {
            koharu_ml::Device::Cpu => "CPU".to_string(),
            koharu_ml::Device::Cuda(_) => "CUDA".to_string(),
            koharu_ml::Device::Metal(_) => "Metal".to_string(),
        },
    })
}

pub async fn open_external(
    _state: AppResources,
    payload: OpenExternalPayload,
) -> anyhow::Result<()> {
    open::that(&payload.url)?;
    Ok(())
}

pub async fn get_documents(state: AppResources) -> anyhow::Result<usize> {
    let guard = state.state.read().await;
    Ok(guard.documents.len())
}

pub async fn get_document(
    state: AppResources,
    payload: IndexPayload,
) -> anyhow::Result<koharu_types::Document> {
    state_tx::read_doc(&state.state, payload.index).await
}

pub async fn get_thumbnail(
    state: AppResources,
    payload: IndexPayload,
) -> anyhow::Result<ThumbnailResult> {
    let doc = state_tx::read_doc(&state.state, payload.index).await?;

    let source = doc.rendered.as_ref().unwrap_or(&doc.image);
    let thumbnail = source.thumbnail(200, 200);

    let mut buf = std::io::Cursor::new(Vec::new());
    thumbnail.write_to(&mut buf, ImageFormat::WebP)?;

    Ok(ThumbnailResult {
        data: buf.into_inner(),
        content_type: "image/webp".to_string(),
    })
}

pub async fn open_documents(
    state: AppResources,
    payload: OpenDocumentsPayload,
) -> anyhow::Result<usize> {
    let mut inputs: Vec<(PathBuf, Vec<u8>)> = payload
        .files
        .into_iter()
        .map(|f| (PathBuf::from(f.name), f.data))
        .collect();

    if inputs.is_empty() {
        let chosen = tokio::task::spawn_blocking(|| {
            FileDialog::new()
                .add_filter("Koharu / Images", &["khr", "png", "jpg", "jpeg", "webp"])
                .pick_files()
        })
        .await?;
        if let Some(files) = chosen {
            for path in files {
                let data = std::fs::read(&path)?;
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                inputs.push((PathBuf::from(name), data));
            }
        }
    }

    if inputs.is_empty() {
        anyhow::bail!("No files selected");
    }

    let docs = load_documents(inputs)?;
    let count = docs.len();
    let mut guard = state.state.write().await;
    guard.documents = docs;
    Ok(count)
}

pub async fn add_documents(
    state: AppResources,
    payload: OpenDocumentsPayload,
) -> anyhow::Result<usize> {
    let mut inputs: Vec<(PathBuf, Vec<u8>)> = payload
        .files
        .into_iter()
        .map(|f| (PathBuf::from(f.name), f.data))
        .collect();

    if inputs.is_empty() {
        let chosen = tokio::task::spawn_blocking(|| {
            FileDialog::new()
                .add_filter("Koharu / Images", &["khr", "png", "jpg", "jpeg", "webp"])
                .pick_files()
        })
        .await?;
        if let Some(files) = chosen {
            for path in files {
                let data = std::fs::read(&path)?;
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                inputs.push((PathBuf::from(name), data));
            }
        }
    }

    if inputs.is_empty() {
        anyhow::bail!("No files selected");
    }

    let docs = load_documents(inputs)?;
    let mut guard = state.state.write().await;
    guard.documents.extend(docs);
    Ok(guard.documents.len())
}

pub async fn export_document(
    state: AppResources,
    payload: IndexPayload,
) -> anyhow::Result<FileResult> {
    let document = state_tx::read_doc(&state.state, payload.index).await?;

    let ext = document
        .path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();

    let (rendered, suffix) = if let Some(r) = document.rendered.as_ref() {
        (r, "rendered")
    } else if let Some(i) = document.inpainted.as_ref() {
        (i, "inpainted")
    } else {
        (&document.image, "original")
    };

    let bytes = encode_image(rendered, &ext)?;
    let filename = format!("{}_{}.{}", document.name, suffix, ext);
    let content_type = mime_from_ext(&ext).to_string();

    Ok(FileResult {
        filename,
        data: bytes,
        content_type,
    })
}

pub async fn export_all_inpainted(state: AppResources) -> anyhow::Result<usize> {
    let guard = state.state.read().await;
    let output_dir = match chapter_render_dir(&guard.documents) {
        Some(dir) => dir,
        None => {
            drop(guard);
            let Some(dir) = pick_output_dir().await? else {
                return Ok(0);
            };
            // Re-acquire after the await.
            return {
                let guard = state.state.read().await;
                export_documents_matching(
                    &guard.documents,
                    &dir,
                    "inpainted",
                    "No inpainted images found to export",
                    |document| document.inpainted.as_ref(),
                )
            };
        }
    };
    export_documents_matching(
        &guard.documents,
        &output_dir,
        "inpainted",
        "No inpainted images found to export",
        |document| document.inpainted.as_ref(),
    )
}

pub async fn export_all_rendered(state: AppResources) -> anyhow::Result<usize> {
    let guard = state.state.read().await;
    let output_dir = match chapter_render_dir(&guard.documents) {
        Some(dir) => dir,
        None => {
            drop(guard);
            let Some(dir) = pick_output_dir().await? else {
                return Ok(0);
            };
            return {
                let guard = state.state.read().await;
                export_documents_matching(
                    &guard.documents,
                    &dir,
                    "rendered",
                    "No rendered images found to export",
                    |document| document.rendered.as_ref(),
                )
            };
        }
    };
    export_documents_matching(
        &guard.documents,
        &output_dir,
        "rendered",
        "No rendered images found to export",
        |document| document.rendered.as_ref(),
    )
}
