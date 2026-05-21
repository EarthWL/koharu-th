use std::sync::Arc;

use anyhow::Result;
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager, tower::StreamableHttpServerConfig,
};
use tokio::net::TcpListener;

use crate::mcp::KoharuMcp;
use crate::rpc::{self, WsState};
use crate::shared::SharedResources;

/// An asset returned by the resolver: raw bytes + MIME type.
pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

/// A function that resolves a path to an asset.
pub type SharedAssetResolver = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

use axum::extract::{Path, State};

fn build_router(shared: SharedResources, resolver: SharedAssetResolver) -> Router {
    let ws_state = WsState {
        resources: shared.clone(),
    };

    let mcp_service = StreamableHttpService::new(
        {
            let shared = shared.clone();
            move || Ok(KoharuMcp::new(shared.clone()))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig {
            sse_retry: None,
            ..Default::default()
        },
    );

    Router::new()
        .route("/ws", get(rpc::ws_handler))
        .route("/api/thumbnail/{index}", get(serve_thumbnail_route))
        .route("/api/image/{index}/{layer}", get(serve_image_route))
        .with_state(ws_state)
        .nest_service("/mcp", mcp_service)
        .fallback(move |uri: Uri| {
            let resolver = resolver.clone();
            async move { serve_asset(&resolver, uri) }
        })
}

async fn serve_thumbnail_route(
    State(state): State<WsState>,
    Path(index): Path<usize>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let resources = match crate::shared::get_resources(&state.resources) {
        Ok(res) => res,
        Err(_) => {
            return (StatusCode::SERVICE_UNAVAILABLE, "Resources not initialized").into_response();
        }
    };

    let guard = resources.state.read().await;
    let doc = match guard.documents.get(index) {
        Some(d) => d,
        None => return (StatusCode::NOT_FOUND, "Document not found").into_response(),
    };

    let thumbnail = doc
        .image
        .resize(180, 240, image::imageops::FilterType::Triangle);
    let etag = get_image_etag("thumb", &doc.id, &thumbnail);

    if let Some(if_none_match) = headers.get(header::IF_NONE_MATCH) {
        if if_none_match == etag.as_str() {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400"),
            );
            response
                .headers_mut()
                .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
            return response.into_response();
        }
    }

    let mut buf = std::io::Cursor::new(Vec::new());
    if let Err(_) = thumbnail.write_to(&mut buf, image::ImageFormat::WebP) {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Encoding failed").into_response();
    }

    let mut response = Response::new(Body::from(buf.into_inner()));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    response.into_response()
}

async fn serve_image_route(
    State(state): State<WsState>,
    Path((index, layer)): Path<(usize, String)>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let resources = match crate::shared::get_resources(&state.resources) {
        Ok(res) => res,
        Err(_) => {
            return (StatusCode::SERVICE_UNAVAILABLE, "Resources not initialized").into_response();
        }
    };

    let guard = resources.state.read().await;
    let doc = match guard.documents.get(index) {
        Some(d) => d,
        None => return (StatusCode::NOT_FOUND, "Document not found").into_response(),
    };

    let img = match layer.as_str() {
        "base" | "image" => &doc.image,
        "inpainted" => match &doc.inpainted {
            Some(i) => i,
            None => return (StatusCode::NOT_FOUND, "Inpainted image not found").into_response(),
        },
        "rendered" => match &doc.rendered {
            Some(r) => r,
            None => return (StatusCode::NOT_FOUND, "Rendered image not found").into_response(),
        },
        "brush" | "brush_layer" => match &doc.brush_layer {
            Some(b) => b,
            None => return (StatusCode::NOT_FOUND, "Brush layer not found").into_response(),
        },
        _ => return (StatusCode::BAD_REQUEST, "Invalid layer").into_response(),
    };

    let etag = get_image_etag(&layer, &doc.id, &img.0);

    if let Some(if_none_match) = headers.get(header::IF_NONE_MATCH) {
        if if_none_match == etag.as_str() {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400"),
            );
            response
                .headers_mut()
                .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
            return response.into_response();
        }
    }

    let mut buf = std::io::Cursor::new(Vec::new());
    if let Err(_) = img.0.write_to(&mut buf, image::ImageFormat::WebP) {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Encoding failed").into_response();
    }

    let mut response = Response::new(Body::from(buf.into_inner()));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    response.into_response()
}

fn serve_asset(resolver: &SharedAssetResolver, uri: Uri) -> Response {
    let path = uri.path();
    let target = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    resolve_asset(resolver, target)
        .or_else(|| resolve_asset(resolver, "index.html"))
        .unwrap_or_else(|| (StatusCode::NOT_FOUND, "Not Found").into_response())
}

fn resolve_asset(resolver: &SharedAssetResolver, path: &str) -> Option<Response> {
    let asset = resolver(path)?;
    let mut response = Response::new(Body::from(asset.bytes));
    if let Ok(ct) = HeaderValue::from_str(&asset.mime_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    Some(response)
}

pub async fn serve_with_listener(
    listener: TcpListener,
    shared: SharedResources,
    resolver: SharedAssetResolver,
) -> Result<()> {
    let router = build_router(shared, resolver);
    tracing::info!("HTTP server listening on http://{}", listener.local_addr()?);
    axum::serve(listener, router.into_make_service()).await?;
    Ok(())
}

fn get_image_etag(prefix: &str, doc_id: &str, img: &image::DynamicImage) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    prefix.hash(&mut hasher);
    doc_id.hash(&mut hasher);
    img.width().hash(&mut hasher);
    img.height().hash(&mut hasher);
    img.color().hash(&mut hasher);

    let bytes = img.as_bytes();
    if !bytes.is_empty() {
        bytes.len().hash(&mut hasher);
        let head_len = 100.min(bytes.len());
        bytes[..head_len].hash(&mut hasher);
        let tail_start = bytes.len().saturating_sub(100);
        bytes[tail_start..].hash(&mut hasher);
        let mid = bytes.len() / 2;
        let mid_start = mid.saturating_sub(50);
        let mid_end = (mid + 50).min(bytes.len());
        bytes[mid_start..mid_end].hash(&mut hasher);
    }
    format!("W/\"{:x}\"", hasher.finish())
}
