mod bert;
mod model;
mod tokenizer;

use anyhow::{Context, Result};
use candle_core::{DType, Device, Tensor};
use image::GenericImageView;
use tokenizers::Tokenizer;
use tracing::instrument;

use model::{PreprocessorConfig, VisionEncoderDecoder, VisionEncoderDecoderConfig};
use tokenizer::load_tokenizer;

use crate::{define_models, device, loading};

define_models! {
    Config => ("mayocream/manga-ocr", "config.json"),
    PreprocessorConfig => ("mayocream/manga-ocr", "preprocessor_config.json"),
    Vocab => ("mayocream/manga-ocr", "vocab.txt"),
    SpecialTokensMap => ("mayocream/manga-ocr", "special_tokens_map.json"),
    Model => ("mayocream/manga-ocr", "model.safetensors"),
    OnnxEncoder => ("mayocream/manga-ocr-onnx", "encoder.onnx"),
    OnnxDecoder => ("mayocream/manga-ocr-onnx", "decoder.onnx"),
}

pub enum MangaBackend {
    Candle {
        model: VisionEncoderDecoder,
        device: Device,
    },
    #[cfg(feature = "dml")]
    Onnx {
        encoder: ort::Session,
        decoder: ort::Session,
    },
}

pub struct MangaOcr {
    backend: MangaBackend,
    tokenizer: Tokenizer,
    preprocessor: PreprocessorConfig,
    max_length: usize,
    decoder_start_token_id: u32,
    eos_token_id: u32,
    pad_token_id: u32,
}

impl MangaOcr {
    pub async fn load(use_cpu: bool) -> Result<Self> {
        #[cfg(feature = "dml")]
        {
            if !use_cpu && crate::dml_is_available() {
                match Self::load_onnx().await {
                    Ok(ocr) => return Ok(ocr),
                    Err(err) => {
                        tracing::warn!("Failed to load ONNX MangaOcr under DirectML: {err}. Falling back to native Candle CPU/GPU...");
                    }
                }
            }
        }

        let device = device(use_cpu)?;
        let config_path = loading::resolve_manifest_path(Manifest::Config.get()).await?;
        let preprocessor_path =
            loading::resolve_manifest_path(Manifest::PreprocessorConfig.get()).await?;
        let vocab_path = loading::resolve_manifest_path(Manifest::Vocab.get()).await?;
        let special_tokens_path =
            loading::resolve_manifest_path(Manifest::SpecialTokensMap.get()).await?;

        let config: VisionEncoderDecoderConfig =
            loading::read_json(&config_path).context("failed to parse model config")?;
        let preprocessor: PreprocessorConfig = loading::read_json(&preprocessor_path)
            .context("failed to parse preprocessor config")?;
        let tokenizer = load_tokenizer(None, &vocab_path, &special_tokens_path)?;
        let model_device = device.clone();
        let model = loading::load_mmaped_safetensors(Manifest::Model.get(), &device, move |vb| {
            VisionEncoderDecoder::from_config(config, vb, model_device.clone())
        })
        .await?;

        let max_length = model.max_length;
        let decoder_start_token_id = model.decoder_start_token_id;
        let eos_token_id = model.eos_token_id;
        let pad_token_id = model.pad_token_id;

        Ok(Self {
            backend: MangaBackend::Candle { model, device },
            tokenizer,
            preprocessor,
            max_length,
            decoder_start_token_id,
            eos_token_id,
            pad_token_id,
        })
    }

    #[cfg(feature = "dml")]
    async fn load_onnx() -> Result<Self> {
        let config_path = loading::resolve_manifest_path(Manifest::Config.get()).await?;
        let preprocessor_path =
            loading::resolve_manifest_path(Manifest::PreprocessorConfig.get()).await?;
        let vocab_path = loading::resolve_manifest_path(Manifest::Vocab.get()).await?;
        let special_tokens_path =
            loading::resolve_manifest_path(Manifest::SpecialTokensMap.get()).await?;

        let config: VisionEncoderDecoderConfig =
            loading::read_json(&config_path).context("failed to parse model config")?;
        let preprocessor: PreprocessorConfig = loading::read_json(&preprocessor_path)
            .context("failed to parse preprocessor config")?;
        let tokenizer = load_tokenizer(None, &vocab_path, &special_tokens_path)?;

        let encoder_path = loading::resolve_manifest_path(Manifest::OnnxEncoder.get()).await?;
        let decoder_path = loading::resolve_manifest_path(Manifest::OnnxDecoder.get()).await?;

        let encoder = ort::Session::builder()?
            .with_execution_providers([ort::DirectMLExecutionProvider::default().build()])?
            .commit_from_file(encoder_path)?;
        let decoder = ort::Session::builder()?
            .with_execution_providers([ort::DirectMLExecutionProvider::default().build()])?
            .commit_from_file(decoder_path)?;

        let max_length = config.max_length;
        let decoder_start_token_id = config.decoder_start_token_id;
        let eos_token_id = config.eos_token_id;
        let pad_token_id = config.pad_token_id;

        Ok(Self {
            backend: MangaBackend::Onnx { encoder, decoder },
            tokenizer,
            preprocessor,
            max_length,
            decoder_start_token_id,
            eos_token_id,
            pad_token_id,
        })
    }

    fn device(&self) -> &Device {
        match &self.backend {
            MangaBackend::Candle { device, .. } => device,
            #[cfg(feature = "dml")]
            MangaBackend::Onnx { .. } => &Device::Cpu,
        }
    }

    #[instrument(level = "debug", skip_all)]
    pub fn inference(&self, images: &[image::DynamicImage]) -> Result<Vec<String>> {
        if images.is_empty() {
            return Ok(Vec::new());
        }

        let pixel_values = preprocess_images(
            images,
            self.preprocessor.size,
            &self.preprocessor.image_mean,
            &self.preprocessor.image_std,
            self.preprocessor.do_resize,
            self.preprocessor.do_normalize,
            self.device(),
        )?;
        let token_ids = self.forward(&pixel_values)?;
        let texts = token_ids
            .into_iter()
            .map(|ids| {
                let text = self.tokenizer.decode(&ids, true).unwrap_or_default();
                post_process(&text)
            })
            .collect();
        Ok(texts)
    }

    #[instrument(level = "debug", skip_all)]
    fn forward(&self, pixel_values: &Tensor) -> Result<Vec<Vec<u32>>> {
        match &self.backend {
            MangaBackend::Candle { model, .. } => model.forward(pixel_values),
            #[cfg(feature = "dml")]
            MangaBackend::Onnx { encoder, decoder } => {
                let batch_size = pixel_values.dim(0)?;
                
                let pixel_shape = pixel_values.shape().dims();
                let pixel_flat = pixel_values.flatten_all()?.to_vec1::<f32>()?;
                let input_pixel_values = ndarray::Array4::from_shape_vec(
                    (pixel_shape[0], pixel_shape[1], pixel_shape[2], pixel_shape[3]),
                    pixel_flat,
                )?;
                
                let encoder_outputs = encoder.run(ort::inputs![
                    "pixel_values" => input_pixel_values
                ]?)?;
                
                let encoder_hidden_states_view = encoder_outputs[0].try_extract_tensor::<f32>()?;
                let encoder_shape = encoder_hidden_states_view.shape();
                let enc_seq_len = encoder_shape[1];
                let enc_hidden_size = encoder_shape[2];
                let encoder_hidden_states_vec = encoder_hidden_states_view.to_slice().ok_or_else(|| anyhow::anyhow!("failed to slice encoder_hidden_states"))?.to_vec();
                let input_encoder_hidden_states = ndarray::Array3::from_shape_vec(
                    (batch_size, enc_seq_len, enc_hidden_size),
                    encoder_hidden_states_vec,
                )?;

                let mut has_token_type = false;
                let mut has_enc_mask = false;
                let mut has_attn_mask = false;
                let mut attn_mask_is_i64 = true;
                let mut enc_mask_is_i64 = true;

                for input in decoder.inputs() {
                    match input.name.as_str() {
                        "token_type_ids" => has_token_type = true,
                        "encoder_attention_mask" => {
                            has_enc_mask = true;
                            if format!("{:?}", input.input_type).contains("F32") {
                                enc_mask_is_i64 = false;
                            }
                        }
                        "attention_mask" => {
                            has_attn_mask = true;
                            if format!("{:?}", input.input_type).contains("F32") {
                                attn_mask_is_i64 = false;
                            }
                        }
                        _ => {}
                    }
                }

                let mut token_ids = vec![vec![self.decoder_start_token_id]; batch_size];
                let mut is_finished = vec![false; batch_size];
                let mut sampler = candle_transformers::generation::LogitsProcessor::new(0, None, None);

                for _ in 0..self.max_length {
                    let seq_lengths: Vec<usize> = token_ids.iter().map(Vec::len).collect();
                    let max_len = *seq_lengths.iter().max().unwrap_or(&0);
                    if max_len == 0 {
                        break;
                    }

                    let mut flat_tokens = vec![self.pad_token_id; batch_size * max_len];
                    let mut flat_attention = vec![0f32; batch_size * max_len];
                    for (batch_idx, seq) in token_ids.iter().enumerate() {
                        let offset = batch_idx * max_len;
                        flat_tokens[offset..offset + seq.len()].copy_from_slice(seq);
                        flat_attention[offset..offset + seq.len()].fill(1.0);
                    }

                    let input_ids_array = ndarray::Array2::from_shape_vec(
                        (batch_size, max_len),
                        flat_tokens.iter().map(|&t| t as i64).collect(),
                    )?;

                    let token_type_ids_array = ndarray::Array2::from_shape_vec(
                        (batch_size, max_len),
                        vec![0i64; batch_size * max_len],
                    )?;

                    let outputs = match (has_token_type, has_attn_mask, has_enc_mask) {
                        (true, true, true) => {
                            let attention_mask = if attn_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.iter().map(|&a| a as i64).collect())?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.clone())?.into()
                            };
                            let encoder_attention_mask = if enc_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1i64; batch_size * enc_seq_len])?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1.0f32; batch_size * enc_seq_len])?.into()
                            };
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "attention_mask" => attention_mask,
                                "token_type_ids" => token_type_ids_array,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                                "encoder_attention_mask" => encoder_attention_mask,
                            ]?)?
                        }
                        (false, true, true) => {
                            let attention_mask = if attn_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.iter().map(|&a| a as i64).collect())?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.clone())?.into()
                            };
                            let encoder_attention_mask = if enc_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1i64; batch_size * enc_seq_len])?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1.0f32; batch_size * enc_seq_len])?.into()
                            };
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "attention_mask" => attention_mask,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                                "encoder_attention_mask" => encoder_attention_mask,
                            ]?)?
                        }
                        (true, false, true) => {
                            let encoder_attention_mask = if enc_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1i64; batch_size * enc_seq_len])?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1.0f32; batch_size * enc_seq_len])?.into()
                            };
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "token_type_ids" => token_type_ids_array,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                                "encoder_attention_mask" => encoder_attention_mask,
                            ]?)?
                        }
                        (false, false, true) => {
                            let encoder_attention_mask = if enc_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1i64; batch_size * enc_seq_len])?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, enc_seq_len), vec![1.0f32; batch_size * enc_seq_len])?.into()
                            };
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                                "encoder_attention_mask" => encoder_attention_mask,
                            ]?)?
                        }
                        (true, true, false) => {
                            let attention_mask = if attn_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.iter().map(|&a| a as i64).collect())?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.clone())?.into()
                            };
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "attention_mask" => attention_mask,
                                "token_type_ids" => token_type_ids_array,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                            ]?)?
                        }
                        (false, true, false) => {
                            let attention_mask = if attn_mask_is_i64 {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.iter().map(|&a| a as i64).collect())?.into()
                            } else {
                                ndarray::Array2::from_shape_vec((batch_size, max_len), flat_attention.clone())?.into()
                            };
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "attention_mask" => attention_mask,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                            ]?)?
                        }
                        (true, false, false) => {
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "token_type_ids" => token_type_ids_array,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                            ]?)?
                        }
                        (false, false, false) => {
                            decoder.run(ort::inputs![
                                "input_ids" => input_ids_array,
                                "encoder_hidden_states" => input_encoder_hidden_states.clone(),
                            ]?)?
                        }
                    };

                    let logits_view = outputs[0].try_extract_tensor::<f32>()?;
                    let logits_shape = logits_view.shape();
                    let vocab_size = logits_shape[2];
                    let logits_slice = logits_view.to_slice().ok_or_else(|| anyhow::anyhow!("failed to slice logits"))?;

                    let mut has_active = false;
                    for (batch_idx, seq) in token_ids.iter_mut().enumerate() {
                        if is_finished[batch_idx] {
                            continue;
                        }

                        let last_idx = seq_lengths[batch_idx].saturating_sub(1);
                        let offset = (batch_idx * max_len + last_idx) * vocab_size;
                        let last_logits_slice = &logits_slice[offset..offset + vocab_size];

                        let last_logits = Tensor::from_slice(last_logits_slice, (vocab_size,), &Device::Cpu)?;
                        let next_id = sampler.sample(&last_logits)?;
                        seq.push(next_id);
                        if next_id == self.eos_token_id {
                            is_finished[batch_idx] = true;
                        } else {
                            has_active = true;
                        }
                    }

                    if !has_active {
                        break;
                    }
                }

                Ok(token_ids)
            }
        }
    }
}

#[instrument(level = "debug", skip_all)]
fn preprocess_images(
    images: &[image::DynamicImage],
    image_size: u32,
    image_mean: &[f32; 3],
    image_std: &[f32; 3],
    do_resize: bool,
    do_normalize: bool,
    device: &Device,
) -> Result<Tensor> {
    let mut batch = Vec::with_capacity(images.len());
    for image in images {
        let processed = preprocess_single_image(
            image,
            image_size,
            image_mean,
            image_std,
            do_resize,
            do_normalize,
            device,
        )?;
        batch.push(processed);
    }

    Ok(Tensor::cat(&batch, 0)?)
}

#[instrument(level = "debug", skip_all)]
fn preprocess_single_image(
    image: &image::DynamicImage,
    image_size: u32,
    image_mean: &[f32; 3],
    image_std: &[f32; 3],
    do_resize: bool,
    do_normalize: bool,
    device: &Device,
) -> Result<Tensor> {
    let (orig_w, orig_h) = image.dimensions();
    let (width, height) = if do_resize {
        (image_size as usize, image_size as usize)
    } else {
        (orig_w as usize, orig_h as usize)
    };

    let tensor = Tensor::from_vec(
        image.grayscale().to_rgb8().into_raw(),
        (1, orig_h as usize, orig_w as usize, 3),
        device,
    )?
    .permute((0, 3, 1, 2))?
    .to_dtype(DType::F32)?;

    let tensor = if do_resize {
        tensor.interpolate2d(height, width)?
    } else {
        tensor
    };

    let tensor = (tensor * (1.0 / 255.0))?;
    let tensor = if do_normalize {
        let std = [
            if image_std[0] == 0.0 {
                1.0
            } else {
                image_std[0]
            },
            if image_std[1] == 0.0 {
                1.0
            } else {
                image_std[1]
            },
            if image_std[2] == 0.0 {
                1.0
            } else {
                image_std[2]
            },
        ];
        let mean_t = Tensor::from_slice(image_mean, (1, 3, 1, 1), device)?;
        let std_t = Tensor::from_slice(&std, (1, 3, 1, 1), device)?;
        tensor.broadcast_sub(&mean_t)?.broadcast_div(&std_t)?
    } else {
        tensor
    };

    Ok(tensor)
}

#[instrument(level = "debug", skip_all)]
fn post_process(text: &str) -> String {
    let mut clean = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    clean = clean.replace('\u{2026}', "...");
    clean = collapse_dots(&clean);
    halfwidth_to_fullwidth(&clean)
}

fn collapse_dots(text: &str) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        if ch == '.' || ch == '\u{30fb}' {
            count += 1;
        } else {
            if count > 0 {
                for _ in 0..count {
                    out.push('.');
                }
                count = 0;
            }
            out.push(ch);
        }
    }
    if count > 0 {
        for _ in 0..count {
            out.push('.');
        }
    }
    out
}

fn halfwidth_to_fullwidth(text: &str) -> String {
    text.chars()
        .map(|ch| match ch {
            '!'..='~' => char::from_u32(ch as u32 + 0xFEE0).unwrap_or(ch),
            ' ' => '\u{3000}',
            _ => ch,
        })
        .collect()
}
