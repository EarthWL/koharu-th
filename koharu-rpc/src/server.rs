use std::sync::Arc;

use anyhow::Result;
use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use koharu_core::BlobId;
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

    // Phase 2 blob transport. The /blob/:hex route is split out as
    // its own little router with the AppResources as state so the
    // handler can pull from the BlobStore directly. Merging into
    // the main Router preserves the existing /ws + /mcp + fallback
    // wiring untouched.
    let blob_router = Router::new()
        .route("/blob/{hex}", get(serve_blob))
        .with_state(shared.clone());

    Router::new()
        .route("/ws", get(rpc::ws_handler))
        .with_state(ws_state)
        .nest_service("/mcp", mcp_service)
        .merge(blob_router)
        .fallback(move |uri: Uri| {
            let resolver = resolver.clone();
            async move { serve_asset(&resolver, uri) }
        })
}

/// Serve a content-addressed blob.
///
/// URL: `GET /blob/<64-hex-chars>` where the hex is the blake3 hash
/// of the bytes. Returns:
/// - **200** with the bytes + `Cache-Control: private,
///   max-age=31536000, immutable` if found. Content is immutable
///   by construction (the URL IS the content hash), so the browser
///   can cache forever. `private` keeps intermediary caches out of
///   user-owned content.
/// - **400** + `Cache-Control: no-store` if the hex is malformed.
/// - **404** + `Cache-Control: no-store` if the blob isn't in the
///   store. The explicit no-store matters: some HTTP cache
///   implementations heuristic-cache 404 responses when no
///   directive is set, which means a fetch that races ahead of the
///   `BlobStore::put` would pin a "not found" in the browser cache
///   even after the blob becomes available. With `no-store` a
///   later retry (e.g. via `<img>` reload after a state update on
///   the frontend) goes back to the network and gets the bytes.
/// - **503** + `Cache-Control: no-store` if resources aren't
///   initialised yet (rare; only possible if a request beats the
///   splash window's close).
///
/// Zero-copy body: `BlobStore::get` returns `bytes::Bytes` which is
/// reference-counted — `Body::from(bytes)` is an O(1) refcount bump,
/// no whole-buffer clone per request. Previous version did
/// `bytes.to_vec()` which copied the full payload (2–5 MB per manga
/// page) on every fetch.
///
/// Credit: this transport choice was proposed by @HetCreep in
/// koharu-th#33; see docs/v2-arch.md §2 (Locked Decisions, blob
/// transport row) + §5 Phase 2 + §12 design changelog on main.
async fn serve_blob(
    State(shared): State<SharedResources>,
    Path(hex): Path<String>,
) -> Response {
    let Some(id) = parse_blob_hex(&hex) else {
        return no_store_error(StatusCode::BAD_REQUEST, "malformed blob hash");
    };
    // SharedResources wraps AppResources in OnceCell — resources
    // init asynchronously after the splash window comes up.
    let Some(res) = shared.get() else {
        return no_store_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "app resources not yet initialized",
        );
    };
    let Some(bytes) = res.blobs.get(id) else {
        // Don't let browser caches pin the 404 — see the doc above.
        return no_store_error(StatusCode::NOT_FOUND, "blob not found");
    };

    // Body::from(Bytes) is O(1) — no buffer clone.
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    // Bytes are stable for the URL forever (it's the content hash),
    // so immutable + 1y max-age is safe.
    //
    // `private` (not `public`): blobs hold user-owned manga pages
    // and the user's translations — potentially copyrighted source
    // material and certainly private work. `private` instructs any
    // intermediary cache (proxy, future cloud-sync layer, dev tools
    // share session) NOT to cache the bytes; only the user's own
    // browser cache holds the copy. For a localhost-only app today
    // this is moot (no intermediary exists), but the principle is
    // correct and `private` doesn't reduce the browser-cache hit
    // rate — the standard immutability + max-age still apply.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    // We don't sniff content type — the consumer (most often <img>)
    // does content sniffing for image types. application/octet-stream
    // is the safe default; a future commit can hint the right MIME
    // when the blob is stored with type metadata.
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    insert_blob_cors(headers);
    response
}

/// CORS allow for `/blob/:hex` so frontend `fetch(blobUrl)` works
/// cross-origin in `next dev` (Next on :3000, Axum on :9999). In
/// Tauri prod the frontend is served by the same Axum router so the
/// header is harmless. Blobs are content-addressed + don't carry
/// credentials, so `*` is correct (not `Access-Control-Allow-
/// Credentials: true` which would forbid the wildcard).
///
/// `<img src>` doesn't need this header at all — the browser fetches
/// the image natively without exposing bytes to JS — so existing
/// `<img>` consumers worked even before this fix. The header
/// matters for `fetch()` paths: `fetchBlobBytes` (AI Chat attach,
/// raw bytes for backend re-encode) and `fetchBlobAsImageBitmap`
/// (mask + brush layer canvas overlays).
fn insert_blob_cors(headers: &mut axum::http::HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
}

/// Error response builder that sets `Cache-Control: no-store` so
/// the browser's HTTP cache doesn't pin transient error states
/// (especially 404s that flip to 200 once a `BlobStore::put` lands
/// after a racing fetch). Also includes the CORS allow header so
/// the frontend can observe the actual status code via `fetch()`
/// (without it, cross-origin errors surface as opaque network
/// failures and we lose the 404-vs-503 distinction in logs).
fn no_store_error(status: StatusCode, body: &'static str) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    insert_blob_cors(headers);
    response
}

/// Parse a 64-character lowercase-hex string into a `BlobId`.
/// Rejects wrong length, non-hex characters, and uppercase
/// (canonical form is lowercase). Hex parsing is hot for blob
/// fetches so we hand-roll the loop instead of pulling in a crate.
fn parse_blob_hex(hex: &str) -> Option<BlobId> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let bytes = hex.as_bytes();
    for i in 0..32 {
        let high = decode_hex_nibble(bytes[i * 2])?;
        let low = decode_hex_nibble(bytes[i * 2 + 1])?;
        out[i] = (high << 4) | low;
    }
    Some(BlobId(out))
}

#[inline]
fn decode_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blob_hex_round_trip() {
        let bytes = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0xff, 0xab, 0xcd, 0xef, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
            0x42, 0x42, 0x42, 0x42,
        ];
        let id = BlobId(bytes);
        let hex = id.to_hex();
        let id2 = parse_blob_hex(&hex).expect("round-trip");
        assert_eq!(id, id2);
    }

    #[test]
    fn parse_blob_hex_rejects_wrong_length() {
        assert!(parse_blob_hex("").is_none());
        assert!(parse_blob_hex("abcd").is_none());
        assert!(parse_blob_hex(&"a".repeat(63)).is_none());
        assert!(parse_blob_hex(&"a".repeat(65)).is_none());
    }

    #[test]
    fn parse_blob_hex_rejects_non_hex_and_uppercase() {
        // 64 chars but contains 'Z' — not a hex digit.
        let bad: String = "Z".repeat(64);
        assert!(parse_blob_hex(&bad).is_none());
        // Uppercase rejected (canonical form is lowercase). Catching
        // this prevents silent cache misses if a caller emits the
        // hash with the wrong case.
        let upper: String = "A".repeat(64);
        assert!(parse_blob_hex(&upper).is_none());
    }
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
