//! Secrets kept in the operating system's credential store (Windows
//! Credential Manager), never in the SQLite database. That keeps the Schedu
//! Pro licence key and the user's Anthropic API key out of backups, which
//! copy the database file to a folder the user picks (often a cloud folder).

use keyring::Entry;

const SERVICE: &str = "app.schedu.desktop";

pub const LICENSE_KEY: &str = "pro-license-key";
pub const ACTIVATION: &str = "pro-activation";
pub const AI_KEY: &str = "anthropic-api-key";
pub const DEVICE_ID: &str = "pro-device-id";

/// The demo profile (SCHEDU_DEMO=1) gets its own entries so screenshots never
/// show, use or overwrite the real licence or API key.
fn service() -> String {
    if crate::demo::enabled() {
        format!("{SERVICE}.demo")
    } else {
        SERVICE.to_string()
    }
}

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(&service(), name).map_err(|e| format!("Couldn't open the credential store: {e}"))
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Couldn't read from the credential store: {e}")),
    }
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?
        .set_password(value)
        .map_err(|e| format!("Couldn't save to the credential store: {e}"))
}

pub fn remove(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Couldn't remove from the credential store: {e}")),
    }
}
