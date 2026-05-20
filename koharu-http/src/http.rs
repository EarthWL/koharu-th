use once_cell::sync::Lazy;
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::{RetryTransientMiddleware, policies::ExponentialBackoff};

const USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

/// Creates a `reqwest::ClientBuilder` configured with the default user agent
/// and global HTTP/Socks5 proxy settings read from standard environment variables.
pub fn create_client_builder() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT);

    // Read proxies from environment
    if let Ok(proxy_str) = std::env::var("KOHARU_PROXY")
        .or_else(|_| std::env::var("ALL_PROXY"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .or_else(|_| std::env::var("HTTPS_PROXY"))
    {
        if !proxy_str.trim().is_empty() {
            match reqwest::Proxy::all(&proxy_str) {
                Ok(proxy) => {
                    tracing::info!("Using global proxy: {}", proxy_str);
                    builder = builder.proxy(proxy);
                }
                Err(e) => {
                    tracing::error!("Failed to parse global proxy from env '{}': {:?}", proxy_str, e);
                }
            }
        }
    }

    builder
}

static HTTP_CLIENT: Lazy<ClientWithMiddleware> = Lazy::new(|| {
    ClientBuilder::new(
        create_client_builder()
            .build()
            .expect("build reqwest client"),
    )
    .with(RetryTransientMiddleware::new_with_policy(
        ExponentialBackoff::builder().build_with_max_retries(3),
    ))
    .build()
});

pub fn http_client() -> &'static ClientWithMiddleware {
    &HTTP_CLIENT
}

