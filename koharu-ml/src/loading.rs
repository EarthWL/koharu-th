use std::future::Future;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use candle_core::{DType, Device};
use candle_nn::VarBuilder;
use serde::de::DeserializeOwned;

pub async fn resolve_manifest_path<F>(manifest: F) -> Result<PathBuf>
where
    F: Future<Output = Result<PathBuf>>,
{
    let path = manifest.await?;

    // 1. Verify file exists
    if !path.exists() {
        anyhow::bail!("Model file does not exist: {}", path.display());
    }

    // 2. Check metadata and non-zero size
    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("Failed to get metadata for model: {}", path.display()))?;
    let file_size = metadata.len();
    if file_size == 0 {
        anyhow::bail!("Model file is empty (0 bytes): {}", path.display());
    }

    // 3. Calculate Blake3 hash in a blocking task for maximum performance
    let hash = {
        let path_clone = path.clone();
        tokio::task::spawn_blocking(move || -> Result<String> {
            let mut file = std::fs::File::open(&path_clone)?;
            let mut hasher = blake3::Hasher::new();
            std::io::copy(&mut file, &mut hasher)?;
            Ok(hasher.finalize().to_hex().to_string())
        })
        .await??
    };

    tracing::info!(
        path = ?path,
        size_bytes = file_size,
        blake3 = %hash,
        "Model file integrity verified successfully."
    );

    // 4. Safetensors header pre-flight structural validation
    if path.extension().map_or(false, |ext| ext == "safetensors") {
        if file_size < 8 {
            anyhow::bail!(
                "Safetensors file is too small (less than 8 bytes): {}",
                path.display()
            );
        }
        let mut file = std::fs::File::open(&path)?;
        use std::io::Read;
        let mut header_size_bytes = [0u8; 8];
        file.read_exact(&mut header_size_bytes)?;
        let header_size = u64::from_le_bytes(header_size_bytes);
        if header_size == 0 || header_size > file_size - 8 {
            anyhow::bail!(
                "Safetensors file header size is invalid: {} (file size: {}). File is likely corrupted.",
                header_size,
                file_size
            );
        }
    }

    Ok(path)
}

pub async fn load_mmaped_safetensors<F, T, Build, E>(
    manifest: F,
    device: &Device,
    build: Build,
) -> Result<T>
where
    F: Future<Output = Result<PathBuf>>,
    Build: FnOnce(VarBuilder) -> std::result::Result<T, E>,
    E: Into<anyhow::Error>,
{
    let weights = resolve_manifest_path(manifest).await?;
    let vb = unsafe { VarBuilder::from_mmaped_safetensors(&[weights], DType::F32, device)? };
    build(vb).map_err(Into::into)
}

pub async fn load_buffered_safetensors<F, T, Build, E>(
    manifest: F,
    device: &Device,
    build: Build,
) -> Result<T>
where
    F: Future<Output = Result<PathBuf>>,
    Build: FnOnce(VarBuilder) -> std::result::Result<T, E>,
    E: Into<anyhow::Error>,
{
    let weights = resolve_manifest_path(manifest).await?;
    let data =
        std::fs::read(&weights).with_context(|| format!("failed to read {}", weights.display()))?;
    let vb = VarBuilder::from_buffered_safetensors(data, DType::F32, device)?;
    build(vb).map_err(Into::into)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let data = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let parsed = serde_json::from_str(&data)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(parsed)
}
