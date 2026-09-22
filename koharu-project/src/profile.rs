//! Provider profile CRUD.
//!
//! Each profile holds the wire-config for one cloud LLM provider
//! (OpenAI / OpenRouter / Gemini / Anthropic). Users can keep multiple
//! profiles (personal OpenAI key + a free OpenRouter key + a local
//! Ollama, etc.) and switch between them.
//!
//! `api_key_ref` is conceptually a pointer into the OS keyring. For now
//! we just store the literal key there too — keyring integration is a
//! future polish (Phase 9.1).

use chrono::{TimeZone, Utc};
use rusqlite::{OptionalExtension, params};

use crate::db::Conn;
use crate::error::Result;
use crate::types::{Provider, ProviderProfile};

#[derive(Debug, Clone)]
pub struct ProfileInsert {
    pub name: String,
    pub provider: Provider,
    pub api_url: Option<String>,
    pub model_name: String,
    pub api_key_ref: Option<String>,
    pub extra_headers: serde_json::Value,
    pub extra_params: serde_json::Value,
    pub is_default: bool,
    pub cost_input_per_1m: Option<f64>,
    pub cost_output_per_1m: Option<f64>,
}

#[derive(Debug, Default, Clone)]
pub struct ProfilePatch {
    pub name: Option<String>,
    pub provider: Option<Provider>,
    pub api_url: Option<Option<String>>,
    pub model_name: Option<String>,
    pub api_key_ref: Option<Option<String>>,
    pub extra_headers: Option<serde_json::Value>,
    pub extra_params: Option<serde_json::Value>,
    pub is_default: Option<bool>,
    pub cost_input_per_1m: Option<Option<f64>>,
    pub cost_output_per_1m: Option<Option<f64>>,
}

pub fn list(conn: &Conn) -> Result<Vec<ProviderProfile>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, provider, api_url, model_name, api_key_ref,
                extra_headers, extra_params, is_default,
                cost_input_per_1m, cost_output_per_1m, created_at, updated_at
         FROM provider_profiles
         ORDER BY is_default DESC, name ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_profile)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Conn, id: i64) -> Result<Option<ProviderProfile>> {
    let row = conn
        .query_row(
            "SELECT id, name, provider, api_url, model_name, api_key_ref,
                    extra_headers, extra_params, is_default,
                    cost_input_per_1m, cost_output_per_1m, created_at, updated_at
             FROM provider_profiles WHERE id = ?1",
            params![id],
            row_to_profile,
        )
        .optional()?;
    Ok(row)
}

pub fn default(conn: &Conn) -> Result<Option<ProviderProfile>> {
    let row = conn
        .query_row(
            "SELECT id, name, provider, api_url, model_name, api_key_ref,
                    extra_headers, extra_params, is_default,
                    cost_input_per_1m, cost_output_per_1m, created_at, updated_at
             FROM provider_profiles
             ORDER BY is_default DESC, id ASC
             LIMIT 1",
            [],
            row_to_profile,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(conn: &Conn, item: ProfileInsert) -> Result<ProviderProfile> {
    let now = Utc::now().timestamp();
    let headers = serde_json::to_string(&item.extra_headers).unwrap_or("{}".into());
    let params_json = serde_json::to_string(&item.extra_params).unwrap_or("{}".into());

    if item.is_default {
        conn.execute("UPDATE provider_profiles SET is_default = 0", [])?;
    }

    conn.execute(
        "INSERT INTO provider_profiles
            (name, provider, api_url, model_name, api_key_ref,
             extra_headers, extra_params, is_default,
             cost_input_per_1m, cost_output_per_1m, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            item.name,
            item.provider.as_str(),
            item.api_url,
            item.model_name,
            item.api_key_ref,
            headers,
            params_json,
            if item.is_default { 1 } else { 0 },
            item.cost_input_per_1m,
            item.cost_output_per_1m,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("just inserted"))
}

pub fn update(conn: &Conn, id: i64, patch: ProfilePatch) -> Result<Option<ProviderProfile>> {
    let now = Utc::now().timestamp();

    // If the patch is promoting to default, clear other defaults first.
    if matches!(patch.is_default, Some(true)) {
        conn.execute(
            "UPDATE provider_profiles SET is_default = 0 WHERE id <> ?1",
            params![id],
        )?;
    }

    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(v) = patch.name {
        sets.push("name = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.provider {
        sets.push("provider = ?");
        values.push(v.as_str().to_string().into());
    }
    if let Some(v) = patch.api_url {
        sets.push("api_url = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.model_name {
        sets.push("model_name = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.api_key_ref {
        sets.push("api_key_ref = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.extra_headers {
        sets.push("extra_headers = ?");
        values.push(serde_json::to_string(&v).unwrap_or("{}".into()).into());
    }
    if let Some(v) = patch.extra_params {
        sets.push("extra_params = ?");
        values.push(serde_json::to_string(&v).unwrap_or("{}".into()).into());
    }
    if let Some(v) = patch.is_default {
        sets.push("is_default = ?");
        values.push((if v { 1 } else { 0 }).into());
    }
    if let Some(v) = patch.cost_input_per_1m {
        sets.push("cost_input_per_1m = ?");
        values.push(v.into());
    }
    if let Some(v) = patch.cost_output_per_1m {
        sets.push("cost_output_per_1m = ?");
        values.push(v.into());
    }

    if sets.is_empty() {
        return get(conn, id);
    }
    sets.push("updated_at = ?");
    values.push(now.into());
    values.push(id.into());

    let sql = format!(
        "UPDATE provider_profiles SET {} WHERE id = ?",
        sets.join(", ")
    );
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

pub fn remove(conn: &Conn, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM provider_profiles WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderProfile> {
    let provider_str: String = r.get(2)?;
    let extra_headers_str: Option<String> = r.get(6)?;
    let extra_params_str: Option<String> = r.get(7)?;
    let is_default_int: i64 = r.get(8)?;
    Ok(ProviderProfile {
        id: r.get(0)?,
        name: r.get(1)?,
        provider: match provider_str.as_str() {
            // Each variant maps to its own enum value. The legacy
            // "openrouter -> Openai" collapse was leftover from before
            // Provider::Openrouter existed; it forced the frontend to
            // run an effectiveProvider() slash-heuristic in three
            // separate files (cloudLlm.ts, cloudOcr.ts, ProfilesTabPanel.tsx)
            // to recover the truth. Map straight through so the DTO
            // we hand callers actually matches what's in the DB.
            "openrouter" => Provider::Openrouter,
            "gemini" => Provider::Gemini,
            "anthropic" => Provider::Anthropic,
            _ => Provider::Openai,
        },
        api_url: r.get(3)?,
        model_name: r.get(4)?,
        api_key_ref: r.get(5)?,
        extra_headers: extra_headers_str
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(serde_json::json!({})))
            .unwrap_or_else(|| serde_json::json!({})),
        extra_params: extra_params_str
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(serde_json::json!({})))
            .unwrap_or_else(|| serde_json::json!({})),
        is_default: is_default_int != 0,
        cost_input_per_1m: r.get(9)?,
        cost_output_per_1m: r.get(10)?,
        created_at: Utc
            .timestamp_opt(r.get(11)?, 0)
            .single()
            .unwrap_or_else(Utc::now),
        updated_at: Utc
            .timestamp_opt(r.get(12)?, 0)
            .single()
            .unwrap_or_else(Utc::now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Project;
    use tempfile::tempdir;

    #[test]
    fn promoting_default_demotes_others() {
        let dir = tempdir().unwrap();
        let p = Project::create(dir.path(), "Test", "0").unwrap();
        let conn = p.pool().get().unwrap();

        let a = insert(
            &conn,
            ProfileInsert {
                name: "OpenAI personal".into(),
                provider: Provider::Openai,
                api_url: Some("https://api.openai.com/v1".into()),
                model_name: "gpt-4o".into(),
                api_key_ref: None,
                extra_headers: serde_json::json!({}),
                extra_params: serde_json::json!({}),
                is_default: true,
                cost_input_per_1m: Some(2.5),
                cost_output_per_1m: Some(10.0),
            },
        )
        .unwrap();
        let b = insert(
            &conn,
            ProfileInsert {
                name: "OpenRouter free".into(),
                provider: Provider::Openai,
                api_url: Some("https://openrouter.ai/api/v1".into()),
                model_name: "deepseek/deepseek-r1-distill-llama-70b:free".into(),
                api_key_ref: None,
                extra_headers: serde_json::json!({}),
                extra_params: serde_json::json!({}),
                is_default: true,
                cost_input_per_1m: Some(0.0),
                cost_output_per_1m: Some(0.0),
            },
        )
        .unwrap();

        let a2 = get(&conn, a.id).unwrap().unwrap();
        let b2 = get(&conn, b.id).unwrap().unwrap();
        assert!(!a2.is_default, "previous default should be demoted");
        assert!(b2.is_default);
        assert_eq!(default(&conn).unwrap().unwrap().id, b.id);
    }
}
