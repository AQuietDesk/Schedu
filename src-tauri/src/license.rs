//! Schedu Pro licence keys, issued by Polar with the yearly subscription.
//!
//! - Activate: the key is registered for this computer with Polar's public
//!   customer-portal endpoint (built for desktop apps; no secret token). The
//!   activation carries a machine condition, so the same activation can't be
//!   copied to another PC: Polar rejects a validation whose condition differs.
//! - The key must belong to the Schedu Pro benefit. Other AQuietDesk products
//!   are sold from the same Polar organization, so this check is what stops a
//!   Money Plan OS key from unlocking Pro.
//! - Re-check at most weekly when online; keep working offline for 30 days
//!   after the last good check. When the subscription ends Polar revokes the
//!   key and Pro turns off at the next check. Imported items stay.
//! - The cached record is sealed with a key that exists only in the private
//!   Pro crate, so hand-editing it (say, moving the last-check date forward)
//!   forces an online check instead of extending the grace period.

use crate::secrets;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const ORGANIZATION_ID: &str = "e9b269e3-330b-4a0d-832c-56ea4e6bac2f";

/// The Polar benefit that issues Schedu Pro keys. Set at build time
/// (SCHEDU_PRO_BENEFIT_ID); until it is, activation explains that Pro isn't
/// on sale yet instead of accepting any key from the organization.
pub const BENEFIT_ID: Option<&str> = option_env!("SCHEDU_PRO_BENEFIT_ID");

const API_BASE: &str = "https://api.polar.sh/v1/customer-portal/license-keys";
const RECHECK_DAYS: i64 = 7;
const GRACE_DAYS: i64 = 30;

pub const PORTAL_URL: &str = "https://aquietdesk.com/portal";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Activation {
    pub activation_id: String,
    pub key_display: String,
    pub device_label: String,
    pub machine: String,
    pub activated_at: String,
    pub last_validated_at: String,
    /// Polar's key status: "granted" while the subscription is active.
    pub status: String,
    pub expires_at: Option<String>,
    pub seal: String,
}

impl Activation {
    fn sealed_fields(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.activation_id,
            self.machine,
            self.last_validated_at,
            self.status,
            self.expires_at.as_deref().unwrap_or("")
        )
    }
    fn reseal(&mut self) {
        self.seal = schedu_pro::seal(&self.sealed_fields());
    }
    fn seal_ok(&self) -> bool {
        self.seal == schedu_pro::seal(&self.sealed_fields())
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LicenseState {
    /// No key on this computer.
    Inactive,
    /// Checked within the last week.
    Active,
    /// Not checked for over a week but within 30 days: still works, re-checks
    /// when online.
    Grace,
    /// Must reach Polar before Pro works again (over 30 days offline, the
    /// record was moved to another PC, or it was edited).
    CheckNeeded,
    /// The subscription ended or the key was revoked.
    Revoked,
}

impl LicenseState {
    pub fn unlocks_pro(self) -> bool {
        matches!(self, LicenseState::Active | LicenseState::Grace)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProStatus {
    /// Whether this installed copy contains the Pro code.
    pub pro_build: bool,
    pub state: LicenseState,
    /// True from the launch date in builds that know the Polar product:
    /// shows the "Get Schedu Pro" buttons.
    pub on_sale: bool,
    /// True in builds that know the Polar product: shows the licence key field
    /// (also before launch, so test purchases can be activated).
    pub accepts_keys: bool,
    pub key_display: Option<String>,
    pub device_label: Option<String>,
    pub last_checked: Option<String>,
    pub grace_until: Option<String>,
    pub expires_at: Option<String>,
}

pub fn evaluate(act: Option<&Activation>, now: DateTime<Utc>, machine: &str) -> LicenseState {
    let Some(act) = act else { return LicenseState::Inactive };
    if !act.seal_ok() || act.machine != machine {
        return LicenseState::CheckNeeded;
    }
    if act.status != "granted" {
        return LicenseState::Revoked;
    }
    let Ok(last) = DateTime::parse_from_rfc3339(&act.last_validated_at) else {
        return LicenseState::CheckNeeded;
    };
    let age = now - last.with_timezone(&Utc);
    if age < Duration::days(-1) {
        // Last check is in the future: the clock was moved back.
        LicenseState::CheckNeeded
    } else if age <= Duration::days(RECHECK_DAYS) {
        LicenseState::Active
    } else if age <= Duration::days(GRACE_DAYS) {
        LicenseState::Grace
    } else {
        LicenseState::CheckNeeded
    }
}

fn grace_until(act: &Activation) -> Option<String> {
    let last = DateTime::parse_from_rfc3339(&act.last_validated_at).ok()?;
    Some((last + Duration::days(GRACE_DAYS)).to_rfc3339())
}

/// Stable per-computer id sent to Polar as the activation's condition. It is
/// a salted hash, so the raw Windows machine id never leaves the PC.
pub fn machine_fingerprint() -> String {
    let raw = os_machine_id().unwrap_or_else(|| {
        // No OS id available: fall back to a random id kept in the credential store.
        match secrets::get(secrets::DEVICE_ID) {
            Ok(Some(id)) => id,
            _ => {
                let id = uuid::Uuid::new_v4().to_string();
                let _ = secrets::set(secrets::DEVICE_ID, &id);
                id
            }
        }
    });
    let digest = Sha256::digest(format!("schedu-pro-machine|{raw}").as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn os_machine_id() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags("SOFTWARE\\Microsoft\\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .ok()?
        .get_value::<String, _>("MachineGuid")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

#[cfg(not(windows))]
fn os_machine_id() -> Option<String> {
    None
}

/// Shown in the buyer's Polar portal so they can tell their computers apart.
fn device_label() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let name: String = name.trim().chars().take(60).collect();
    if name.is_empty() {
        "This computer".into()
    } else {
        name
    }
}

fn load() -> Option<Activation> {
    secrets::get(secrets::ACTIVATION)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn save(act: &mut Activation) -> Result<(), String> {
    act.reseal();
    secrets::set(secrets::ACTIVATION, &serde_json::to_string(act).map_err(|e| e.to_string())?)
}

/// Schedu Pro goes on sale on January 4, 2027 (midnight Eastern time).
pub fn launched(now: DateTime<Utc>) -> bool {
    now >= DateTime::parse_from_rfc3339("2027-01-04T05:00:00Z").expect("valid launch date")
}

pub fn status() -> ProStatus {
    let act = load();
    let state = evaluate(act.as_ref(), Utc::now(), &machine_fingerprint());
    ProStatus {
        pro_build: schedu_pro::is_pro_build(),
        state,
        on_sale: BENEFIT_ID.is_some() && launched(Utc::now()),
        accepts_keys: BENEFIT_ID.is_some(),
        key_display: act.as_ref().map(|a| a.key_display.clone()),
        device_label: act.as_ref().map(|a| a.device_label.clone()),
        last_checked: act.as_ref().map(|a| a.last_validated_at.clone()),
        grace_until: act.as_ref().and_then(grace_until),
        expires_at: act.as_ref().and_then(|a| a.expires_at.clone()),
    }
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

fn detail(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["detail"].as_str().map(str::to_string))
        .unwrap_or_default()
}

fn conditions(machine: &str) -> Value {
    json!({ "machine": machine })
}

fn post(path: &str, body: &Value) -> Result<(u16, String), String> {
    let response = http()?
        .post(format!("{API_BASE}/{path}"))
        .json(body)
        .send()
        .map_err(|e| format!("Couldn't reach the licence server. Check your internet connection. ({e})"))?;
    let status = response.status().as_u16();
    Ok((status, response.text().unwrap_or_default()))
}

/// Registers the key for this computer.
pub fn activate(key: &str) -> Result<ProStatus, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste your licence key first.".into());
    }
    let Some(benefit_id) = BENEFIT_ID else {
        return Err("Schedu Pro isn't on sale yet, so there's no key to activate.".into());
    };
    let machine = machine_fingerprint();
    let label = device_label();
    let (code, body) = post(
        "activate",
        &json!({
            "key": key,
            "organization_id": ORGANIZATION_ID,
            "label": label,
            "conditions": conditions(&machine),
            "meta": { "app": "Schedu", "app_version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS },
        }),
    )?;
    match code {
        200 => {}
        403 => {
            let d = detail(&body).to_ascii_lowercase();
            return Err(if d.contains("limit") {
                format!("This key is already active on the most computers it allows. Free one up on your purchases page ({PORTAL_URL}), then try again.")
            } else {
                "This key has been revoked or has expired. If you renewed recently, wait a minute and try again.".into()
            });
        }
        404 => return Err("That licence key wasn't found. Check that you copied the whole key.".into()),
        422 => return Err("That doesn't look like a licence key. Check that you copied the whole key.".into()),
        _ => return Err(format!("The licence server returned an error ({code}). Try again in a few minutes.")),
    }

    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let activation_id = v["id"].as_str().unwrap_or_default().to_string();
    let lk = &v["license_key"];
    if lk["benefit_id"].as_str() != Some(benefit_id) {
        // A valid key, but for another product. Give the activation slot back.
        let _ = post("deactivate", &json!({ "key": key, "organization_id": ORGANIZATION_ID, "activation_id": activation_id }));
        return Err("That key is for a different AQuietDesk product, not Schedu Pro.".into());
    }
    let now = Utc::now().to_rfc3339();
    let mut act = Activation {
        activation_id,
        key_display: lk["display_key"].as_str().unwrap_or("****").to_string(),
        device_label: label,
        machine,
        activated_at: now.clone(),
        last_validated_at: now,
        status: lk["status"].as_str().unwrap_or("granted").to_string(),
        expires_at: lk["expires_at"].as_str().map(str::to_string),
        seal: String::new(),
    };
    secrets::set(secrets::LICENSE_KEY, key)?;
    save(&mut act)?;
    Ok(status())
}

/// Asks Polar whether the key is still good and refreshes the cached record.
pub fn validate_now() -> Result<ProStatus, String> {
    let (Some(key), Some(mut act)) = (secrets::get(secrets::LICENSE_KEY)?, load()) else {
        return Ok(status());
    };
    let machine = machine_fingerprint();
    let mut body = json!({
        "key": key,
        "organization_id": ORGANIZATION_ID,
        "activation_id": act.activation_id,
        "conditions": conditions(&machine),
    });
    if let Some(benefit_id) = BENEFIT_ID {
        body["benefit_id"] = json!(benefit_id);
    }
    let (code, text) = post("validate", &body)?;
    match code {
        200 => {
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            act.status = v["status"].as_str().unwrap_or("granted").to_string();
            act.expires_at = v["expires_at"].as_str().map(str::to_string);
        }
        // Revoked, expired, wrong benefit, or this activation belongs to
        // another computer (the machine condition didn't match).
        404 => act.status = "revoked".into(),
        _ => return Err(format!("The licence server returned an error ({code}). Try again later.")),
    }
    act.machine = machine;
    act.last_validated_at = Utc::now().to_rfc3339();
    save(&mut act)?;
    Ok(status())
}

/// Frees this computer's activation slot and removes the key from this PC.
pub fn deactivate() -> Result<ProStatus, String> {
    if let (Some(key), Some(act)) = (secrets::get(secrets::LICENSE_KEY)?, load()) {
        let (code, _) = post(
            "deactivate",
            &json!({ "key": key, "organization_id": ORGANIZATION_ID, "activation_id": act.activation_id }),
        )?;
        if !matches!(code, 200 | 204 | 404) {
            return Err(format!("The licence server returned an error ({code}). Try again later."));
        }
    }
    secrets::remove(secrets::ACTIVATION)?;
    secrets::remove(secrets::LICENSE_KEY)?;
    Ok(status())
}

/// Called before every Pro action: re-checks with Polar when due, and says
/// whether Pro is unlocked right now. Being offline never locks Pro inside
/// the grace period.
pub fn ensure_unlocked() -> bool {
    let current = status();
    match current.state {
        LicenseState::Active => true,
        LicenseState::Inactive | LicenseState::Revoked => false,
        LicenseState::Grace | LicenseState::CheckNeeded => match validate_now() {
            Ok(fresh) => fresh.state.unlocks_pro(),
            Err(_) => current.state.unlocks_pro(),
        },
    }
}

/// Background re-check shortly after launch, so an ended subscription is
/// noticed without the user opening Settings.
pub fn spawn_background_check() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if load().is_some() {
            let _ = ensure_unlocked();
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn goes_on_sale_jan_4_2027_eastern() {
        let t = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc);
        assert!(!super::launched(t("2027-01-04T04:59:59Z")));
        assert!(super::launched(t("2027-01-04T05:00:00Z")));
    }

    use super::*;

    fn act(last: DateTime<Utc>) -> Activation {
        let mut a = Activation {
            activation_id: "a1".into(),
            key_display: "****-ABC".into(),
            device_label: "PC".into(),
            machine: "m1".into(),
            activated_at: last.to_rfc3339(),
            last_validated_at: last.to_rfc3339(),
            status: "granted".into(),
            expires_at: None,
            seal: String::new(),
        };
        a.reseal();
        a
    }

    #[test]
    fn no_record_is_inactive() {
        assert_eq!(evaluate(None, Utc::now(), "m1"), LicenseState::Inactive);
    }

    #[test]
    fn weekly_check_then_thirty_day_grace() {
        let now = Utc::now();
        assert_eq!(evaluate(Some(&act(now - Duration::days(2))), now, "m1"), LicenseState::Active);
        assert_eq!(evaluate(Some(&act(now - Duration::days(10))), now, "m1"), LicenseState::Grace);
        assert_eq!(evaluate(Some(&act(now - Duration::days(31))), now, "m1"), LicenseState::CheckNeeded);
        assert!(LicenseState::Grace.unlocks_pro());
        assert!(!LicenseState::CheckNeeded.unlocks_pro());
    }

    #[test]
    fn revoked_key_is_locked() {
        let now = Utc::now();
        let mut a = act(now);
        a.status = "revoked".into();
        a.reseal();
        assert_eq!(evaluate(Some(&a), now, "m1"), LicenseState::Revoked);
    }

    #[test]
    fn edited_or_copied_records_need_an_online_check() {
        let now = Utc::now();
        let mut edited = act(now - Duration::days(40));
        edited.last_validated_at = now.to_rfc3339(); // moved forward by hand, seal not updated
        assert_eq!(evaluate(Some(&edited), now, "m1"), LicenseState::CheckNeeded);
        assert_eq!(evaluate(Some(&act(now)), now, "another-pc"), LicenseState::CheckNeeded);
        assert_eq!(evaluate(Some(&act(now + Duration::days(5))), now, "m1"), LicenseState::CheckNeeded);
    }

    #[test]
    fn fingerprint_is_stable_and_hashed() {
        let a = machine_fingerprint();
        assert_eq!(a, machine_fingerprint());
        assert_eq!(a.len(), 32);
    }
}
