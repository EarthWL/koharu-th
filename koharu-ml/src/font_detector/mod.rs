use std::{fs, path::PathBuf};

use crate::{define_models, device, loading};
use anyhow::{Context, Result};
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::ops::{sigmoid, softmax};
use image::{DynamicImage, GenericImageView, imageops::FilterType};

mod models;
pub use models::ModelKind;

const FONT_COUNT: usize = 6_150;
const REGRESSION_START: usize = FONT_COUNT + 2;
const REGRESSION_DIM: usize = 10;

define_models! {
    FontWeights => ("fffonion/yuzumarker-font-detection", "yuzumarker-font-detection.safetensors"),
    FontNames => ("fffonion/yuzumarker-font-detection", "font-labels-ex.json"),
    OnnxModel => ("fffonion/yuzumarker-font-detection", "model.onnx"),
}

pub use koharu_types::{FontPrediction, NamedFontPrediction, TextDirection};

pub enum FontBackend {
    Candle {
        model: models::Model,
        device: Device,
    },
    #[cfg(feature = "dml")]
    Onnx {
        session: ort::Session,
    },
}

pub struct FontDetector {
    backend: FontBackend,
    labels: FontLabels,
}

impl FontDetector {
    pub async fn load(use_cpu: bool) -> Result<Self> {
        Self::load_with_kind(use_cpu, ModelKind::default()).await
    }

    pub async fn load_with_kind(use_cpu: bool, kind: ModelKind) -> Result<Self> {
        #[cfg(feature = "dml")]
        {
            if !use_cpu && crate::dml_is_available() {
                match Self::load_onnx().await {
                    Ok(detector) => return Ok(detector),
                    Err(err) => {
                        tracing::warn!("Failed to load ONNX FontDetector under DirectML: {err}. Falling back to native Candle CPU/GPU...");
                    }
                }
            }
        }

        let device = device(use_cpu)?;
        let model =
            loading::load_mmaped_safetensors(Manifest::FontWeights.get(), &device, move |vb| {
                models::Model::load(vb.pp("model._orig_mod.model"), kind)
            })
            .await?;
        let labels = FontLabels::load().await?;

        Ok(Self {
            backend: FontBackend::Candle { model, device },
            labels,
        })
    }

    #[cfg(feature = "dml")]
    async fn load_onnx() -> Result<Self> {
        let onnx_path = loading::resolve_manifest_path(Manifest::OnnxModel.get()).await?;
        let session = ort::Session::builder()?
            .with_execution_providers([ort::DirectMLExecutionProvider::default().build()])?
            .commit_from_file(onnx_path)?;
        let labels = FontLabels::load().await?;
        Ok(Self {
            backend: FontBackend::Onnx { session },
            labels,
        })
    }

    fn device(&self) -> &Device {
        match &self.backend {
            FontBackend::Candle { device, .. } => device,
            #[cfg(feature = "dml")]
            FontBackend::Onnx { .. } => &Device::Cpu,
        }
    }

    fn input_size(&self) -> usize {
        match &self.backend {
            FontBackend::Candle { model, .. } => model.input_size(),
            #[cfg(feature = "dml")]
            FontBackend::Onnx { .. } => 512,
        }
    }

    pub fn inference(&self, images: &[DynamicImage], top_k: usize) -> Result<Vec<FontPrediction>> {
        if images.is_empty() {
            return Ok(Vec::new());
        }

        let mut processed = Vec::with_capacity(images.len());
        let mut original_sizes = Vec::with_capacity(images.len());
        let input_size = self.input_size();
        for image in images {
            let (w, _h) = image.dimensions();
            original_sizes.push(w);
            processed.push(preprocess_image(image, input_size, self.device())?);
        }
        let batch = Tensor::stack(&processed, 0)?;
        
        let logits = match &self.backend {
            FontBackend::Candle { model, .. } => model.forward(&batch, false)?,
            #[cfg(feature = "dml")]
            FontBackend::Onnx { session } => {
                let inputs = session.inputs();
                let input_name = inputs.get(0).map(|i| i.name.as_str()).unwrap_or("input");

                let shape = batch.shape().dims();
                let flat_vec = batch.flatten_all()?.to_vec1::<f32>()?;
                let input_array = ndarray::Array4::from_shape_vec(
                    (shape[0], shape[1], shape[2], shape[3]),
                    flat_vec,
                )?;

                let outputs = session.run(ort::inputs![
                    input_name => input_array
                ]?)?;

                let output_view = outputs[0].try_extract_tensor::<f32>()?;
                let out_shape = output_view.shape();
                let out_vec = output_view.to_slice().ok_or_else(|| anyhow::anyhow!("failed to slice output"))?.to_vec();
                Tensor::from_vec(
                    out_vec,
                    (out_shape[0], out_shape[1]),
                    &Device::Cpu,
                )?
            }
        };

        let mut predictions = Vec::with_capacity(images.len());
        for (index, width) in original_sizes.into_iter().enumerate() {
            let example = logits.i(index)?;
            let font_logits = example.narrow(0, 0, FONT_COUNT)?;
            let font_probs = softmax(&font_logits, 0)?;
            let font_probs_vec: Vec<f32> = font_probs.to_vec1()?;
            let mut ranked: Vec<(usize, f32)> = font_probs_vec.into_iter().enumerate().collect();
            // total_cmp instead of partial_cmp().unwrap(): inference
            // logits can contain NaN (CUDA OOM partial exec, corrupt
            // weights, denorm underflow). partial_cmp returns None on
            // NaN → unwrap panics; total_cmp defines a total order.
            ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
            ranked.truncate(top_k.min(FONT_COUNT));

            let named_fonts = ranked
                .iter()
                .filter_map(|(idx, prob)| {
                    self.labels.entry(*idx).map(|label| NamedFontPrediction {
                        index: *idx,
                        name: label.name.clone(),
                        language: label.language.clone(),
                        probability: *prob,
                        serif: label.serif,
                    })
                })
                .collect();

            let direction_logits = example.narrow(0, FONT_COUNT, 2)?;
            let direction_vec: Vec<f32> = direction_logits.to_vec1()?;
            let direction = if direction_vec.len() == 2 && direction_vec[1] > direction_vec[0] {
                TextDirection::Vertical
            } else {
                TextDirection::Horizontal
            };

            let regression = example.narrow(0, REGRESSION_START, REGRESSION_DIM)?;
            // Regression head is trained on normalized values; bring logits into [0, 1].
            let regression = sigmoid(&regression)?;
            let mut regression: Vec<f32> = regression.to_vec1()?;
            regression.resize(REGRESSION_DIM, 0.0);
            let clamp01 = |v: f32| v.clamp(0.0, 1.0);
            let text_color = [
                (clamp01(regression[0]) * 255.0).round() as u8,
                (clamp01(regression[1]) * 255.0).round() as u8,
                (clamp01(regression[2]) * 255.0).round() as u8,
            ];
            let font_size_px = clamp01(regression[3]) * width as f32;
            let stroke_width_px = clamp01(regression[4]) * width as f32;
            let stroke_color = [
                (clamp01(regression[5]) * 255.0).round() as u8,
                (clamp01(regression[6]) * 255.0).round() as u8,
                (clamp01(regression[7]) * 255.0).round() as u8,
            ];
            let line_spacing_px = clamp01(regression[8]) * width as f32;
            let line_height = if font_size_px > 0.0 {
                1.0 + line_spacing_px / font_size_px
            } else {
                1.2
            };
            let angle_deg = (regression[9] - 0.5) * 180.0;

            predictions.push(FontPrediction {
                top_fonts: ranked,
                named_fonts,
                direction,
                text_color,
                stroke_color,
                font_size_px,
                stroke_width_px,
                line_height,
                angle_deg,
            });
        }

        Ok(predictions)
    }
}

#[derive(Debug, Clone)]
pub struct FontLabel {
    pub name: String,
    pub language: Option<String>,
    pub serif: bool,
}

#[derive(Debug, Clone)]
pub struct FontLabels {
    labels: Vec<FontLabel>,
}

impl FontLabels {
    pub async fn load() -> Result<Self> {
        let path = loading::resolve_manifest_path(Manifest::FontNames.get()).await?;
        Self::from_path(&path)
    }

    pub fn from_path(path: &PathBuf) -> Result<Self> {
        let data = fs::read_to_string(path)
            .with_context(|| format!("Failed to read labels file {}", path.display()))?;
        let entries: Vec<FontLabelEntry> = serde_json::from_str(&data)
            .with_context(|| format!("Failed to parse labels file {}", path.display()))?;
        let mut labels = Vec::with_capacity(entries.len());
        for entry in entries {
            labels.push(FontLabel {
                name: entry.path,
                language: entry.language,
                serif: entry.serif,
            });
        }
        Ok(Self { labels })
    }

    pub fn entry(&self, idx: usize) -> Option<&FontLabel> {
        self.labels.get(idx)
    }

    pub fn name(&self, idx: usize) -> Option<&str> {
        self.entry(idx).map(|label| label.name.as_str())
    }

    pub fn language(&self, idx: usize) -> Option<&str> {
        self.entry(idx).and_then(|label| label.language.as_deref())
    }
}

#[derive(serde::Deserialize)]
struct FontLabelEntry {
    path: String,
    language: Option<String>,
    serif: bool,
}

fn preprocess_image(image: &DynamicImage, target: usize, device: &Device) -> Result<Tensor> {
    let resized = image.resize_exact(target as u32, target as u32, FilterType::CatmullRom);
    let data = resized.to_rgb8().into_raw();
    let tensor = Tensor::from_vec(
        data,
        (target, target, 3),
        &Device::Cpu,
    )?
    .to_dtype(DType::F32)?
    .permute((2, 0, 1))? // (3, H, W)
    * (1.0 / 255.0);
    let tensor = tensor?;
    Ok(tensor.to_device(device)?)
}
