//! API key storage in the OS keyring.
//!
//! Each provider profile gets a stable keyring entry identified by the
//! profile's UUID-shaped reference (stored as `provider_profiles.api_key_ref`).
//! The service name is fixed per platform.
//!
//! On platforms where the keyring backend is unavailable (headless Linux
//! without `secret-service`, sandboxed environments, …), `put` and `get`
//! return an error and the caller is expected to fall back to whatever
//! the user typed in directly.

use uuid::Uuid;

const SERVICE: &str = "koharu-th";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keyring backend unavailable: {0}")]
    Backend(#[from] keyring::Error),
}

pub type SecretResult<T> = std::result::Result<T, SecretError>;

/// Build a fresh keyring reference for a brand-new profile.
pub fn new_ref() -> String {
    format!("profile:{}", Uuid::new_v4())
}

/// Store `secret` under `ref_id`. Replaces any prior value.
pub fn put(ref_id: &str, secret: &str) -> SecretResult<()> {
    let entry = keyring::Entry::new(SERVICE, ref_id)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Read the secret stored under `ref_id`. Returns `Ok(None)` when the
/// entry doesn't exist (vs. `Err` for actual backend failures).
pub fn get(ref_id: &str) -> SecretResult<Option<String>> {
    let entry = keyring::Entry::new(SERVICE, ref_id)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Delete the entry. No-op when the entry doesn't exist.
pub fn delete(ref_id: &str) -> SecretResult<()> {
    let entry = keyring::Entry::new(SERVICE, ref_id)?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
