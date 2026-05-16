use std::sync::Arc;
use std::time::Duration;

use koharu_pipeline::AppResources;
use tokio::sync::OnceCell;

pub type SharedResources = Arc<OnceCell<AppResources>>;

pub fn get_resources(shared: &SharedResources) -> anyhow::Result<AppResources> {
    shared
        .get()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Resources not initialized"))
}

/// Same as `get_resources` but polls every 100ms up to `timeout` for the
/// OnceCell to be set. Used by the WS RPC dispatch so requests issued
/// during the app's init window (UI connects immediately, backend is
/// still loading models / CUDA libs / pipeline) don't get bounced with
/// the scary "Resources not initialized" error — they just queue
/// briefly. tokio's `OnceCell` doesn't ship a wait() in our version, so
/// we poll.
pub async fn get_resources_wait(
    shared: &SharedResources,
    timeout: Duration,
) -> anyhow::Result<AppResources> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(res) = shared.get() {
            return Ok(res.clone());
        }
        if std::time::Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "Resources not initialized (timed out waiting {}s)",
                timeout.as_secs(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
