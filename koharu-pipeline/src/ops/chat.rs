//! Chat ops — backed by the per-project `chat_messages` table, plus
//! `web_fetch_url` (Rust-side HTTP fetch + crude HTML→text strip) so
//! the in-app AI Chat can pull wiki / blog pages into context without
//! hitting browser CORS.

use std::time::Duration;

use anyhow::Context;
use koharu_api::commands::{
    ChatClearResult, ChatListPayload, ChatMessageAddPayload, ChatMessageDeleteFromPayload,
    ChatMessageDeletePayload, ChatMessageDto, WebFetchPayload, WebFetchResult,
};
use koharu_project::chat::{self as chat_ops, ChatMessage, ChatMessageInsert};

use crate::AppResources;

// ---------------------------------------------------------------
// chat history
// ---------------------------------------------------------------

pub async fn chat_messages_list(
    state: AppResources,
    payload: ChatListPayload,
) -> anyhow::Result<Vec<ChatMessageDto>> {
    let project = require_project(&state).await?;
    let list = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ChatMessageDto>> {
        let conn = project.pool().get()?;
        let limit = payload.limit.unwrap_or(50);
        let rows = chat_ops::list_recent(&conn, limit, payload.before_id)?;
        Ok(rows.into_iter().map(to_dto).collect())
    })
    .await??;
    Ok(list)
}

pub async fn chat_message_add(
    state: AppResources,
    payload: ChatMessageAddPayload,
) -> anyhow::Result<ChatMessageDto> {
    let project = require_project(&state).await?;
    let dto = tokio::task::spawn_blocking(move || -> anyhow::Result<ChatMessageDto> {
        let conn = project.pool().get()?;
        let inserted = chat_ops::insert(
            &conn,
            ChatMessageInsert {
                role: payload.role,
                content: payload.content,
                tool_calls: payload.tool_calls,
                tool_call_id: payload.tool_call_id,
                model: payload.model,
                attachments: payload.attachments,
            },
        )?;
        Ok(to_dto(inserted))
    })
    .await??;
    Ok(dto)
}

pub async fn chat_messages_clear(state: AppResources) -> anyhow::Result<ChatClearResult> {
    let project = require_project(&state).await?;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        let conn = project.pool().get()?;
        Ok(chat_ops::clear(&conn)?)
    })
    .await??;
    Ok(ChatClearResult {
        removed: removed as u32,
    })
}

pub async fn chat_message_delete(
    state: AppResources,
    payload: ChatMessageDeletePayload,
) -> anyhow::Result<ChatClearResult> {
    let project = require_project(&state).await?;
    let id = payload.id;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        let conn = project.pool().get()?;
        Ok(chat_ops::delete(&conn, id)?)
    })
    .await??;
    Ok(ChatClearResult {
        removed: removed as u32,
    })
}

pub async fn chat_messages_delete_from(
    state: AppResources,
    payload: ChatMessageDeleteFromPayload,
) -> anyhow::Result<ChatClearResult> {
    let project = require_project(&state).await?;
    let from_id = payload.from_id;
    let removed = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        let conn = project.pool().get()?;
        Ok(chat_ops::delete_from(&conn, from_id)?)
    })
    .await??;
    Ok(ChatClearResult {
        removed: removed as u32,
    })
}

fn to_dto(m: ChatMessage) -> ChatMessageDto {
    ChatMessageDto {
        id: m.id,
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
        model: m.model,
        attachments: m.attachments,
        created_at: m.created_at.to_rfc3339(),
    }
}

async fn require_project(
    state: &AppResources,
) -> anyhow::Result<koharu_project::Project> {
    let guard = state.project.read().await;
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    drop(guard);

    let mut write_guard = state.project.write().await;
    if let Some(p) = write_guard.as_ref() {
        return Ok(p.clone());
    }

    let app_root = state.lib_root.parent().unwrap_or(&state.lib_root);
    let global_project_path = app_root.join("global_project");
    std::fs::create_dir_all(&global_project_path).ok();

    let project = if global_project_path.join("series.koharuproj").exists() {
        koharu_project::Project::open(&global_project_path)?
    } else {
        koharu_project::Project::create(&global_project_path, "Global Scratchpad", state.version)?
    };

    *write_guard = Some(project.clone());
    Ok(project)
}



// ---------------------------------------------------------------
// web_fetch_url — agentic tool for the AI Chat. Lets the assistant
// pull a manga wiki / fandom page into context so it can summarise
// into project metadata + characters + glossary.
// ---------------------------------------------------------------

const MAX_BYTES: usize = 1_500_000; // ~1.5 MB cap
const TIMEOUT_SECS: u64 = 12;

pub async fn web_fetch_url(
    _state: AppResources,
    payload: WebFetchPayload,
) -> anyhow::Result<WebFetchResult> {
    let url = payload.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        anyhow::bail!("URL must start with http:// or https://");
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("koharu-ai-chat/0.1 (manga translation assistant)")
        .build()?;

    let res = client.get(url).send().await?;
    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = res.bytes().await?;
    let truncated = bytes.len() > MAX_BYTES;
    let slice = if truncated { &bytes[..MAX_BYTES] } else { &bytes[..] };
    let raw = String::from_utf8_lossy(slice).to_string();

    let (title, text) = if content_type.contains("html") || looks_like_html(&raw) {
        let title = extract_title(&raw);
        let text = strip_html(&raw);
        (title, text)
    } else {
        (None, raw)
    };

    Ok(WebFetchResult {
        url: final_url,
        status,
        content_type,
        title,
        text,
        truncated,
    })
}

fn looks_like_html(s: &str) -> bool {
    let head = &s[..s.len().min(2048)].to_ascii_lowercase();
    head.contains("<html") || head.contains("<!doctype html")
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after_open = lower[start..].find('>')?;
    let content_start = start + after_open + 1;
    let end = lower[content_start..].find("</title>")?;
    Some(
        html[content_start..content_start + end]
            .trim()
            .replace('\n', " "),
    )
}

/// Minimal HTML→text — strips script/style blocks, then everything
/// between `<` and `>`, then collapses whitespace. Good enough for an
/// LLM to read; not trying to preserve structure.
fn strip_html(html: &str) -> String {
    let no_scripts = strip_block(html, "<script", "</script>");
    let no_styles = strip_block(&no_scripts, "<style", "</style>");
    let no_noscript = strip_block(&no_styles, "<noscript", "</noscript>");

    let mut out = String::with_capacity(no_noscript.len() / 2);
    let mut in_tag = false;
    for ch in no_noscript.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    // Decode the handful of HTML entities that matter for readability.
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");

    // Collapse runs of whitespace and blank lines.
    let mut lines: Vec<String> = decoded
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect();
    lines.dedup();
    lines.join("\n")
}

fn strip_block(s: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let lower = s.to_ascii_lowercase();
    let mut i = 0;
    while i < s.len() {
        match lower[i..].find(open) {
            Some(rel) => {
                let start = i + rel;
                out.push_str(&s[i..start]);
                match lower[start..].find(close) {
                    Some(rel_end) => {
                        i = start + rel_end + close.len();
                    }
                    None => {
                        // Unterminated — drop the rest defensively.
                        return out;
                    }
                }
            }
            None => {
                out.push_str(&s[i..]);
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{extract_title, strip_html};

    #[test]
    fn strip_html_drops_scripts_styles_and_tags() {
        let html = r#"<!doctype html><html><head>
            <title>The Sample Page</title>
            <style>body{color:red}</style>
            <script>alert("hi");</script>
        </head><body>
            <h1>Heading</h1>
            <p>First paragraph &amp; <b>bold</b> text.</p>
            <p>Second paragraph.</p>
        </body></html>"#;
        let text = strip_html(html);
        assert!(text.contains("Heading"));
        assert!(text.contains("First paragraph & bold text."));
        assert!(text.contains("Second paragraph."));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
        assert!(!text.contains("<"));
    }

    #[test]
    fn title_extraction_picks_title_tag() {
        let html = "<html><head><title>  Hello  </title></head></html>";
        assert_eq!(extract_title(html).as_deref(), Some("Hello"));
    }
}
