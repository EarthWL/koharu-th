use std::future::Future;
use std::time::Duration;

use anyhow::Result;
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use koharu_api::Method;
use koharu_pipeline::AppResources;
use koharu_pipeline::operations;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::sync::{broadcast, mpsc};

use crate::shared::{SharedResources, get_resources_wait};

#[derive(Debug, Deserialize)]
struct RawIncoming {
    id: u32,
    method: String,
    params: Option<rmpv::Value>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum OutgoingMessage {
    #[serde(rename = "res")]
    Response {
        id: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<rmpv::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "ntf")]
    Notification { method: String, params: rmpv::Value },
}

fn ok_response(id: u32, result: rmpv::Value) -> OutgoingMessage {
    OutgoingMessage::Response {
        id,
        result: Some(result),
        error: None,
    }
}

fn err_response(id: u32, msg: &str) -> OutgoingMessage {
    OutgoingMessage::Response {
        id,
        result: None,
        error: Some(msg.to_string()),
    }
}

fn to_value<T: Serialize>(val: &T) -> Result<rmpv::Value> {
    let bytes = rmp_serde::to_vec_named(val)?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

fn from_value<T: DeserializeOwned>(val: rmpv::Value) -> Result<T> {
    let bytes = rmp_serde::to_vec_named(&val)?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

async fn call<F, Fut, P, T>(f: F, state: AppResources, params: rmpv::Value) -> Result<rmpv::Value>
where
    F: FnOnce(AppResources, P) -> Fut,
    Fut: Future<Output = Result<T>>,
    P: DeserializeOwned,
    T: Serialize,
{
    to_value(&f(state, from_value(params)?).await?)
}

async fn call0<F, Fut, T>(f: F, state: AppResources) -> Result<rmpv::Value>
where
    F: FnOnce(AppResources) -> Fut,
    Fut: Future<Output = Result<T>>,
    T: Serialize,
{
    to_value(&f(state).await?)
}

async fn dispatch(method: Method, params: rmpv::Value, state: AppResources) -> Result<rmpv::Value> {
    match method {
        Method::AppVersion => call0(operations::app_version, state).await,
        Method::Device => call0(operations::device, state).await,
        Method::GetDocuments => call0(operations::get_documents, state).await,
        Method::ListFontFamilies => call0(operations::list_font_families, state).await,
        Method::LlmList => call(operations::llm_list, state, params).await,
        Method::LlmReady => call0(operations::llm_ready, state).await,
        Method::LlmOffload => call0(operations::llm_offload, state).await,
        Method::ProcessCancel => call0(operations::process_cancel, state).await,
        Method::GetDocument => call(operations::get_document, state, params).await,
        Method::GetThumbnail => call(operations::get_thumbnail, state, params).await,
        Method::ExportDocument => call(operations::export_document, state, params).await,
        Method::ExportAllInpainted => call0(operations::export_all_inpainted, state).await,
        Method::ExportAllRendered => call0(operations::export_all_rendered, state).await,
        Method::AddDocuments => call(operations::add_documents, state, params).await,
        Method::OpenDocuments => call(operations::open_documents, state, params).await,
        Method::OpenExternal => call(operations::open_external, state, params).await,
        Method::Detect => call(operations::detect, state, params).await,
        Method::Ocr => call(operations::ocr, state, params).await,
        Method::Inpaint => call(operations::inpaint, state, params).await,
        Method::UpdateInpaintMask => call(operations::update_inpaint_mask, state, params).await,
        Method::UpdateBrushLayer => call(operations::update_brush_layer, state, params).await,
        Method::InpaintPartial => call(operations::inpaint_partial, state, params).await,
        Method::Render => call(operations::render, state, params).await,
        Method::UpdateTextBlocks => call(operations::update_text_blocks, state, params).await,
        Method::TextBlockFitToBubble => {
            call(operations::text_block_fit_to_bubble, state, params).await
        }
        Method::LlmLoad => call(operations::llm_load, state, params).await,
        Method::LlmGenerate => call(operations::llm_generate, state, params).await,
        Method::Process => call(operations::process, state, params).await,
        Method::ProjectCreate => call(operations::project_create, state, params).await,
        Method::ProjectCreatePicker => {
            call(operations::project_create_picker, state, params).await
        }
        Method::ProjectOpen => call(operations::project_open, state, params).await,
        Method::ProjectOpenPicker => call0(operations::project_open_picker, state).await,
        Method::ProjectClose => call0(operations::project_close, state).await,
        Method::ProjectCurrent => call0(operations::project_current, state).await,
        Method::ProjectBackupPicker => {
            call0(operations::project_backup_picker, state).await
        }
        Method::RecentProjectsList => call0(operations::recent_projects_list, state).await,
        Method::RecentProjectsRemove => {
            call(operations::recent_projects_remove, state, params).await
        }
        Method::AppStorageStats => call0(operations::app_storage_stats, state).await,
        Method::AppStorageClear => call(operations::app_storage_clear, state, params).await,
        Method::SeriesMetaGet => call0(operations::series_meta_get, state).await,
        Method::SeriesMetaUpdate => call(operations::series_meta_update, state, params).await,
        Method::ChaptersList => call0(operations::chapters_list, state).await,
        Method::ChapterCreate => call(operations::chapter_create, state, params).await,
        Method::ChapterAddPages => call(operations::chapter_add_pages, state, params).await,
        Method::ChapterOpen => call(operations::chapter_open, state, params).await,
        Method::ChapterGetPageBytes => {
            call(operations::chapter_get_page_bytes, state, params).await
        }
        Method::ChapterUpdate => call(operations::chapter_update, state, params).await,
        Method::ChapterRemove => call(operations::chapter_remove, state, params).await,
        Method::ChapterClearPages => {
            call(operations::chapter_clear_pages, state, params).await
        }
        Method::ChapterExportCbz => {
            call(operations::chapter_export_cbz, state, params).await
        }
        Method::CharactersList => call0(operations::characters_list, state).await,
        Method::CharacterAdd => call(operations::character_add, state, params).await,
        Method::CharacterUpdate => call(operations::character_update, state, params).await,
        Method::CharacterRemove => call(operations::character_remove, state, params).await,
        Method::GlossaryList => call0(operations::glossary_list, state).await,
        Method::GlossaryAdd => call(operations::glossary_add, state, params).await,
        Method::GlossaryBulkAdd => call(operations::glossary_bulk_add, state, params).await,
        Method::GlossaryUpdate => call(operations::glossary_update, state, params).await,
        Method::GlossaryRemove => call(operations::glossary_remove, state, params).await,
        Method::GlossaryBumpUsage => call(operations::glossary_bump_usage, state, params).await,
        Method::PromptTemplatesList => call0(operations::prompt_templates_list, state).await,
        Method::PromptTemplateAdd => call(operations::prompt_template_add, state, params).await,
        Method::PromptTemplateUpdate => {
            call(operations::prompt_template_update, state, params).await
        }
        Method::PromptTemplateRemove => {
            call(operations::prompt_template_remove, state, params).await
        }
        Method::PromptRender => call(operations::prompt_render, state, params).await,
        Method::TmLookup => call(operations::tm_lookup, state, params).await,
        Method::TmLookupFuzzy => call(operations::tm_lookup_fuzzy, state, params).await,
        Method::TmInsert => call(operations::tm_insert, state, params).await,
        Method::TmExportTmx => call0(operations::tm_export_tmx, state).await,
        Method::TmImportTmx => call0(operations::tm_import_tmx, state).await,
        Method::TmPendingEmbeddings => {
            call(operations::tm_pending_embeddings, state, params).await
        }
        Method::TmPendingCount => call(operations::tm_pending_count, state, params).await,
        Method::TmSetEmbedding => call(operations::tm_set_embedding, state, params).await,
        Method::TmLookupSemantic => {
            call(operations::tm_lookup_semantic, state, params).await
        }
        Method::ProviderProfilesList => {
            call0(operations::provider_profiles_list, state).await
        }
        Method::ProviderProfileAdd => {
            call(operations::provider_profile_add, state, params).await
        }
        Method::ProviderProfileUpdate => {
            call(operations::provider_profile_update, state, params).await
        }
        Method::ProviderProfileRemove => {
            call(operations::provider_profile_remove, state, params).await
        }
        Method::ProviderProfileSecretGet => {
            call(operations::provider_profile_secret_get, state, params).await
        }
        Method::LlmCallLog => call(operations::llm_call_log, state, params).await,
        Method::LlmCostStats => call0(operations::llm_cost_stats, state).await,
        Method::LlmCostBreakdown => call0(operations::llm_cost_breakdown, state).await,
        Method::ChatMessagesList => {
            call(operations::chat_messages_list, state, params).await
        }
        Method::ChatMessageAdd => call(operations::chat_message_add, state, params).await,
        Method::ChatMessagesClear => call0(operations::chat_messages_clear, state).await,
        Method::WebFetchUrl => call(operations::web_fetch_url, state, params).await,
        Method::QueueList => call0(operations::queue_list, state).await,
        Method::QueueEnqueue => call(operations::queue_enqueue, state, params).await,
        Method::QueueCancel => call(operations::queue_cancel, state, params).await,
        Method::QueueClearFinished => call0(operations::queue_clear_finished, state).await,
    }
}

#[derive(Clone)]
pub struct WsState {
    pub resources: SharedResources,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<WsState>) -> impl IntoResponse {
    ws.max_message_size(1024 * 1024 * 1024)
        .on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: WsState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut send_rx) = mpsc::channel::<OutgoingMessage>(256);

    spawn_notification_forwarder(
        "download_progress",
        koharu_http::download::subscribe(),
        tx.clone(),
    );
    spawn_notification_forwarder(
        "process_progress",
        koharu_pipeline::pipeline::subscribe(),
        tx.clone(),
    );

    let send_task = tokio::spawn(async move {
        while let Some(msg) = send_rx.recv().await {
            let Ok(bytes) = rmp_serde::to_vec_named(&msg) else {
                continue;
            };
            if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        let data = match msg {
            Message::Binary(data) => data,
            Message::Close(_) => break,
            _ => continue,
        };

        let raw: RawIncoming = match rmp_serde::from_slice(&data) {
            Ok(value) => value,
            Err(err) => {
                let _ = tx
                    .send(err_response(0, &format!("Decode error: {err}")))
                    .await;
                continue;
            }
        };

        let id = raw.id;
        let tx = tx.clone();
        let resources = state.resources.clone();

        tokio::spawn(async move {
            // Wait up to 20s for AppResources to be initialised. The UI
            // connects to /ws immediately on launch but model / CUDA /
            // pipeline init takes a couple of seconds — without this
            // wait, the very first RPC of the session pops a scary
            // "Resources not initialized" error in the UI.
            let response = match get_resources_wait(
                &resources,
                Duration::from_secs(20),
            )
            .await
            {
                Ok(res) => {
                    let parsed_method: Result<Method> = raw.method.parse();
                    let method = match parsed_method {
                        Ok(method) => method,
                        Err(err) => {
                            let _ = tx.send(err_response(id, &format!("{err:#}"))).await;
                            return;
                        }
                    };

                    let params = raw.params.unwrap_or(rmpv::Value::Nil);
                    match tokio::time::timeout(
                        Duration::from_secs(300),
                        dispatch(method, params, res),
                    )
                    .await
                    {
                        Ok(Ok(result)) => ok_response(id, result),
                        Ok(Err(err)) => err_response(id, &format!("{err:#}")),
                        Err(_) => err_response(id, "Request timed out"),
                    }
                }
                Err(err) => err_response(id, &format!("{err:#}")),
            };
            let _ = tx.send(response).await;
        });
    }

    send_task.abort();
}

fn spawn_notification_forwarder<T: Serialize + Clone + Send + 'static>(
    method: &'static str,
    mut rx: broadcast::Receiver<T>,
    tx: mpsc::Sender<OutgoingMessage>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(payload) => {
                    let params = to_value(&payload).unwrap_or(rmpv::Value::Nil);
                    let msg = OutgoingMessage::Notification {
                        method: method.to_string(),
                        params,
                    };
                    if tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use koharu_api::Method;

    #[test]
    fn method_registry_supports_all_dispatched_methods() {
        for method in Method::ALL {
            let parsed: Method = method.as_str().parse().expect("method should parse");
            assert_eq!(*method, parsed);
        }
    }

    #[test]
    fn unknown_method_returns_stable_error() {
        let err = "unknown_method_name"
            .parse::<Method>()
            .expect_err("unknown method should fail");
        assert_eq!(err.to_string(), "Unknown method: unknown_method_name");
    }
}
