use crate::secrets;
use super::config::{
    GOOGLE_AUTH_ENDPOINT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_SCOPES,
    GOOGLE_TOKEN_ENDPOINT,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

fn get_pref(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM preference WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

#[cfg(test)]
fn set_pref(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO preference (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

fn clear_pref(conn: &Connection, key: &str) {
    let _ = conn.execute("DELETE FROM preference WHERE key = ?1", params![key]);
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn random_url_safe_string(len: usize) -> String {
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..len).map(|_| rng.random::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge_for(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

pub struct TokenResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

// Google tokens live in Windows Credential Manager (see secrets.rs), not in the
// database. Versions up to 0.4.0 kept them in the `preference` table under
// these keys; `migrate_legacy_tokens` moves them over once and deletes the rows.
const LEGACY_TOKEN_PREFS: [(&str, &str); 3] = [
    ("google_access_token", secrets::GOOGLE_ACCESS_TOKEN),
    ("google_refresh_token", secrets::GOOGLE_REFRESH_TOKEN),
    ("google_token_expiry", secrets::GOOGLE_TOKEN_EXPIRY),
];

const GOOGLE_REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";

/// Moves any token rows left in the database into the secret store. A value
/// already in the store wins (it's newer than a row brought back by restoring
/// an old backup). A row is deleted only once its value is safely stored, so a
/// failed write is retried next time instead of losing the sign-in.
fn migrate_tokens_with(
    conn: &Connection,
    mut stored: impl FnMut(&str) -> Result<Option<String>, String>,
    mut store: impl FnMut(&str, &str) -> Result<(), String>,
) {
    for (pref, name) in LEGACY_TOKEN_PREFS {
        let Some(value) = get_pref(conn, pref) else { continue };
        let saved = match stored(name) {
            Ok(Some(_)) => true,
            Ok(None) => store(name, &value).is_ok(),
            Err(_) => false,
        };
        if saved {
            clear_pref(conn, pref);
        }
    }
}

fn migrate_legacy_tokens(conn: &Connection) {
    migrate_tokens_with(conn, secrets::get, secrets::set);
}

fn token(name: &str) -> Result<Option<String>, String> {
    secrets::get(name)
}

pub fn is_connected(conn: &Connection) -> bool {
    migrate_legacy_tokens(conn);
    matches!(token(secrets::GOOGLE_REFRESH_TOKEN), Ok(Some(_)))
}

/// Deletes the tokens from this PC only (the secret store, plus any legacy
/// rows). Used on its own when Google has already rejected the refresh token.
fn clear_tokens(conn: &Connection) -> Result<(), String> {
    for (pref, name) in LEGACY_TOKEN_PREFS {
        clear_pref(conn, pref);
        secrets::remove(name)?;
    }
    Ok(())
}

/// Asks Google to revoke Schedu's access. Revoking the refresh token ends the
/// whole grant, so Schedu disappears from the user's Google account
/// permissions. Best effort: offline, or a token Google already dropped, is
/// ignored, because the local tokens are deleted either way.
fn revoke_at_google(token: &str) {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    else {
        return;
    };
    let _ = client.post(GOOGLE_REVOKE_ENDPOINT).form(&[("token", token)]).send();
}

/// Settings → Google → Disconnect: deletes the tokens from this PC, then
/// revokes Schedu's access at Google.
pub fn disconnect(conn: &Connection) -> Result<(), String> {
    migrate_legacy_tokens(conn);
    let grant = token(secrets::GOOGLE_REFRESH_TOKEN)
        .ok()
        .flatten()
        .or_else(|| token(secrets::GOOGLE_ACCESS_TOKEN).ok().flatten());
    clear_tokens(conn)?;
    set_reconnect_needed(conn, false);
    if let Some(grant) = grant {
        revoke_at_google(&grant);
    }
    Ok(())
}

pub fn store_tokens(conn: &Connection, tokens: &TokenResult) -> Result<(), String> {
    for (pref, _) in LEGACY_TOKEN_PREFS {
        clear_pref(conn, pref);
    }
    secrets::set(secrets::GOOGLE_ACCESS_TOKEN, &tokens.access_token)?;
    if let Some(refresh) = &tokens.refresh_token {
        secrets::set(secrets::GOOGLE_REFRESH_TOKEN, refresh)?;
    }
    secrets::set(
        secrets::GOOGLE_TOKEN_EXPIRY,
        &(now_unix() + tokens.expires_in).to_string(),
    )?;
    set_reconnect_needed(conn, false);
    Ok(())
}

/// Runs the full installed-app (loopback + PKCE) OAuth flow: opens the system
/// browser and blocks waiting for the redirect on a local listener (up to
/// three minutes), then exchanges the code for tokens. Deliberately takes no
/// database connection — the caller stores the result afterward with
/// `store_tokens`, so this long wait never holds a DB lock.
pub fn run_installed_app_flow() -> Result<TokenResult, String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().ok_or("no local port")?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let code_verifier = random_url_safe_string(64);
    let code_challenge = code_challenge_for(&code_verifier);
    let state = random_url_safe_string(16);

    let auth_url = url::Url::parse_with_params(
        GOOGLE_AUTH_ENDPOINT,
        &[
            ("client_id", GOOGLE_CLIENT_ID),
            ("redirect_uri", &redirect_uri),
            ("response_type", "code"),
            ("scope", GOOGLE_SCOPES),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("state", &state),
            ("code_challenge", &code_challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|e| e.to_string())?;

    tauri_plugin_opener::open_url(auth_url.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    let request = server
        .recv_timeout(std::time::Duration::from_secs(180))
        .map_err(|e| e.to_string())?
        .ok_or("Timed out waiting for Google sign-in")?;

    let full_url = format!("http://127.0.0.1{}", request.url());
    let parsed = url::Url::parse(&full_url).map_err(|e| e.to_string())?;
    let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

    let response_body =
        "<html><body>You can close this window and return to Schedu.</body></html>";
    let response = tiny_http::Response::from_string(response_body).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..]).unwrap(),
    );
    let _ = request.respond(response);

    if let Some(err) = params.get("error") {
        return Err(format!("Google sign-in was not completed: {err}"));
    }
    let code = params.get("code").ok_or("No authorization code returned")?;
    let returned_state = params.get("state").ok_or("No state returned")?;
    if returned_state != &state {
        return Err("OAuth state mismatch — possible CSRF, aborting".to_string());
    }

    let client = reqwest::blocking::Client::new();
    let token_res: TokenResponse = client
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", GOOGLE_CLIENT_SECRET),
            ("code", code.as_str()),
            ("code_verifier", &code_verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &redirect_uri),
        ])
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    Ok(TokenResult {
        access_token: token_res.access_token,
        refresh_token: token_res.refresh_token,
        expires_in: token_res.expires_in,
    })
}

/// Returned by `get_valid_access_token`/`refresh_access_token` when Google has
/// rejected the stored refresh token itself (revoked by the user, or — for an
/// app still on an unverified OAuth consent screen — expired after 7 days of
/// inactivity). No amount of retrying fixes this; callers should treat it as
/// "the user needs to reconnect," not a transient failure.
pub const RECONNECT_REQUIRED: &str = "GOOGLE_RECONNECT_REQUIRED";

/// Set when Schedu dropped a Google connection it can't refresh, so Settings
/// shows "Reconnect Google" rather than a plain "Connect" or an error. Cleared
/// on a new sign-in or a deliberate Disconnect.
const RECONNECT_NEEDED_PREF: &str = "google_reconnect_needed";

/// Whether a failed refresh means the stored sign-in can never work again:
/// - `invalid_grant`: the refresh token was revoked, or expired;
/// - `unauthorized_client`: it was issued to a different OAuth client. This is
///   what 0.4.0 installs hit after 0.4.1 moved to the brand Google project;
/// - `invalid_client`: the OAuth client itself is unknown or deleted.
///
/// Anything else (rate limits, server errors, malformed requests) may be
/// temporary, so the tokens are kept and the next sync retries.
fn refresh_needs_reconnect(status: u16, body: &str) -> bool {
    if status != 400 && status != 401 {
        return false;
    }
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned));
    matches!(
        code.as_deref(),
        Some("invalid_grant" | "unauthorized_client" | "invalid_client")
    )
}

fn set_reconnect_needed(conn: &Connection, needed: bool) {
    if needed {
        let _ = conn.execute(
            "INSERT INTO preference (key, value) VALUES (?1, '1') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![RECONNECT_NEEDED_PREF],
        );
    } else {
        clear_pref(conn, RECONNECT_NEEDED_PREF);
    }
}

pub fn reconnect_needed(conn: &Connection) -> bool {
    get_pref(conn, RECONNECT_NEEDED_PREF).is_some() && !is_connected(conn)
}

fn refresh_access_token(conn: &Connection, refresh_token: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let res = client
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", GOOGLE_CLIENT_SECRET),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .map_err(|e| e.to_string())?;

    // Read the body before checking status: `error_for_status` discards it,
    // and Google's 400/401 response body is exactly where the OAuth error
    // code shows up — the only way to tell "dead refresh token, stop
    // retrying" apart from an ordinary transient failure.
    let status = res.status().as_u16();
    if status == 400 || status == 401 {
        let body = res.text().unwrap_or_default();
        if refresh_needs_reconnect(status, &body) {
            // Clear the dead tokens so is_connected() goes false, and
            // remember why, so Settings offers "Reconnect Google" instead of
            // an error. Nothing to revoke: Google won't accept this grant.
            let _ = clear_tokens(conn);
            set_reconnect_needed(conn, true);
            return Err(RECONNECT_REQUIRED.to_string());
        }
        return Err(format!("Google token refresh failed: {body}"));
    }

    let token_res: TokenResponse = res
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    secrets::set(secrets::GOOGLE_ACCESS_TOKEN, &token_res.access_token)?;
    secrets::set(
        secrets::GOOGLE_TOKEN_EXPIRY,
        &(now_unix() + token_res.expires_in).to_string(),
    )?;
    Ok(token_res.access_token)
}

/// Returns a currently-valid access token, refreshing it first if it has
/// expired (or is within 60s of expiring).
pub fn get_valid_access_token(conn: &Connection) -> Result<String, String> {
    migrate_legacy_tokens(conn);
    let refresh_token = token(secrets::GOOGLE_REFRESH_TOKEN)?.ok_or("Not connected to Google")?;
    let expiry: u64 = token(secrets::GOOGLE_TOKEN_EXPIRY)?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if now_unix() + 60 >= expiry {
        return refresh_access_token(conn, &refresh_token);
    }

    token(secrets::GOOGLE_ACCESS_TOKEN)?.ok_or_else(|| "Not connected to Google".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE preference (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn
    }

    #[test]
    fn migration_moves_legacy_rows_into_the_store_and_deletes_them() {
        let conn = db();
        set_pref(&conn, "google_access_token", "at");
        set_pref(&conn, "google_refresh_token", "rt");
        set_pref(&conn, "google_token_expiry", "123");
        set_pref(&conn, "theme", "light");
        let mut store: HashMap<String, String> = HashMap::new();
        let snapshot = store.clone();
        migrate_tokens_with(&conn, |n| Ok(snapshot.get(n).cloned()), |n, v| {
            store.insert(n.into(), v.into());
            Ok(())
        });
        assert_eq!(store.get(secrets::GOOGLE_ACCESS_TOKEN).map(String::as_str), Some("at"));
        assert_eq!(store.get(secrets::GOOGLE_REFRESH_TOKEN).map(String::as_str), Some("rt"));
        assert_eq!(store.get(secrets::GOOGLE_TOKEN_EXPIRY).map(String::as_str), Some("123"));
        for (pref, _) in LEGACY_TOKEN_PREFS {
            assert_eq!(get_pref(&conn, pref), None, "{pref} should be deleted");
        }
        assert_eq!(get_pref(&conn, "theme").as_deref(), Some("light"));
    }

    #[test]
    fn dead_sign_ins_need_a_reconnect_but_temporary_failures_dont() {
        // A 0.4.0 refresh token sent with the new brand client.
        assert!(refresh_needs_reconnect(400, r#"{"error":"unauthorized_client","error_description":"Unauthorized"}"#));
        assert!(refresh_needs_reconnect(400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#));
        assert!(refresh_needs_reconnect(401, r#"{"error":"invalid_client","error_description":"The OAuth client was not found."}"#));
        assert!(!refresh_needs_reconnect(400, r#"{"error":"invalid_request"}"#));
        assert!(!refresh_needs_reconnect(400, "<html>bad gateway</html>"));
        // The error code must be the code, not just mentioned somewhere.
        assert!(!refresh_needs_reconnect(400, r#"{"error":"invalid_request","error_description":"not invalid_grant"}"#));
        assert!(!refresh_needs_reconnect(500, r#"{"error":"invalid_grant"}"#));
    }

    #[test]
    fn reconnect_flag_is_set_and_cleared() {
        let conn = db();
        set_reconnect_needed(&conn, true);
        assert_eq!(get_pref(&conn, RECONNECT_NEEDED_PREF).as_deref(), Some("1"));
        set_reconnect_needed(&conn, false);
        assert_eq!(get_pref(&conn, RECONNECT_NEEDED_PREF), None);
    }

    #[test]
    fn migration_keeps_the_row_when_the_store_write_fails() {
        let conn = db();
        set_pref(&conn, "google_refresh_token", "rt");
        migrate_tokens_with(&conn, |_| Ok(None), |_, _| Err("locked".into()));
        assert_eq!(get_pref(&conn, "google_refresh_token").as_deref(), Some("rt"));
    }

    #[test]
    fn migration_never_overwrites_a_token_already_in_the_store() {
        let conn = db();
        set_pref(&conn, "google_refresh_token", "old-from-backup");
        let mut writes = 0;
        migrate_tokens_with(
            &conn,
            |n| Ok((n == secrets::GOOGLE_REFRESH_TOKEN).then(|| "current".to_string())),
            |_, _| {
                writes += 1;
                Ok(())
            },
        );
        assert_eq!(writes, 0);
        assert_eq!(get_pref(&conn, "google_refresh_token"), None);
    }
}
