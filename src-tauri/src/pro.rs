//! Commands for Schedu Pro: licence, the user's own Anthropic API key, and
//! moving from the free app to the Pro build.
//!
//! The free installer doesn't contain the Pro code at all. After a key is
//! activated, the free app downloads the official Pro build through the same
//! signed updater it already uses, from the Pro release channel, and restarts
//! into it. Data stays where it is (same app ID). The Pro installer is useless
//! without an activated key, and the free one has nothing to unlock.

use crate::license::{self, ProStatus};
use crate::secrets;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Signed Pro builds and their latest.json (see docs/PRO-BUILD.md).
pub const PRO_UPDATE_ENDPOINT: &str =
    "https://github.com/AQuietDesk/schedu-pro-releases/releases/latest/download/latest.json";

pub const MODEL_PREF_KEY: &str = "pro_ai_model";
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pro_status() -> Result<ProStatus, String> {
    blocking(|| Ok(license::status())).await
}

#[tauri::command]
pub async fn pro_activate(key: String) -> Result<ProStatus, String> {
    blocking(move || license::activate(&key)).await
}

#[tauri::command]
pub async fn pro_recheck() -> Result<ProStatus, String> {
    blocking(license::validate_now).await
}

#[tauri::command]
pub async fn pro_deactivate() -> Result<ProStatus, String> {
    blocking(license::deactivate).await
}

/// Free build only: download and install the Pro build, then restart into it.
#[tauri::command]
pub async fn pro_install_upgrade(app: AppHandle) -> Result<(), String> {
    if schedu_pro::is_pro_build() {
        return Ok(());
    }
    let unlocked = blocking(|| Ok(license::ensure_unlocked())).await?;
    if !unlocked {
        return Err("Activate your Schedu Pro licence key first.".into());
    }
    let endpoint = url::Url::parse(PRO_UPDATE_ENDPOINT).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        // The Pro build carries the same version number as the free one, so
        // accept an equal version as well as a newer one.
        .version_comparator(|current, remote| remote.version >= current)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Couldn't reach the Schedu Pro download. Check your internet connection. ({e})"))?
        .ok_or("The Schedu Pro download isn't available yet. Try again later.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("The Schedu Pro download didn't finish: {e}"))?;
    app.restart();
}

/// Opens one of a fixed set of pages; the web view can't open arbitrary URLs.
#[tauri::command]
pub fn pro_open_link(which: String) -> Result<(), String> {
    let url = match which.as_str() {
        "buy" => "https://aquietdesk.com/schedu-pro/buy",
        "portal" => license::PORTAL_URL,
        "learn" => "https://aquietdesk.com/schedu#pro",
        "anthropic_keys" => "https://platform.claude.com/settings/keys",
        "anthropic_billing" => "https://platform.claude.com/settings/billing",
        "privacy" => "https://aquietdesk.com/privacy",
        "terms" => "https://aquietdesk.com/schedu/terms/",
        _ => return Err("Unknown link".into()),
    };
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct AiKeyStatus {
    pub saved: bool,
    pub last4: Option<String>,
}

fn last4(key: &str) -> String {
    key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
}

#[tauri::command]
pub async fn ai_key_status() -> Result<AiKeyStatus, String> {
    blocking(|| {
        let key = secrets::get(secrets::AI_KEY)?;
        Ok(AiKeyStatus { saved: key.is_some(), last4: key.as_deref().map(last4) })
    })
    .await
}

pub fn check_key_shape(key: &str) -> Result<(), String> {
    if !key.starts_with("sk-ant-") || key.len() < 30 || key.chars().any(char::is_whitespace) {
        return Err("That doesn't look like an Anthropic API key. Keys start with “sk-ant-”.".into());
    }
    Ok(())
}

/// The key goes to the credential store and is only ever read by the Rust
/// side; the web view gets back the last four characters.
#[tauri::command]
pub async fn ai_key_save(key: String) -> Result<AiKeyStatus, String> {
    blocking(move || {
        let key = key.trim().to_string();
        check_key_shape(&key)?;
        secrets::set(secrets::AI_KEY, &key)?;
        Ok(AiKeyStatus { saved: true, last4: Some(last4(&key)) })
    })
    .await
}

#[tauri::command]
pub async fn ai_key_remove() -> Result<AiKeyStatus, String> {
    blocking(|| {
        secrets::remove(secrets::AI_KEY)?;
        Ok(AiKeyStatus { saved: false, last4: None })
    })
    .await
}

#[tauri::command]
pub async fn ai_key_test(model: String) -> Result<(), String> {
    blocking(move || {
        let key = secrets::get(secrets::AI_KEY)?.ok_or("Save your API key first.")?;
        schedu_pro::test_api_key(&key, &model).map_err(|e| e.message())
    })
    .await
}

#[tauri::command]
pub fn intake_estimate_cost(file_name: String, size: usize, model: String) -> f64 {
    schedu_pro::estimate_cost_cents(&file_name, size, &model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_shape() {
        assert!(check_key_shape("sk-ant-api03-abcdefghijklmnopqrstuvwxyz").is_ok());
        assert!(check_key_shape("sk-proj-abcdefghijklmnopqrstuvwxyz1234").is_err());
        assert!(check_key_shape("sk-ant-short").is_err());
        assert!(check_key_shape("sk-ant-api03-abc defghijklmnopqrstuvwxyz").is_err());
    }

    #[test]
    fn shows_only_last_four() {
        assert_eq!(last4("sk-ant-api03-xyzWXYZ"), "WXYZ");
    }
}
