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

pub fn is_connected(conn: &Connection) -> bool {
    get_pref(conn, "google_refresh_token").is_some()
}

pub fn disconnect(conn: &Connection) {
    clear_pref(conn, "google_access_token");
    clear_pref(conn, "google_refresh_token");
    clear_pref(conn, "google_token_expiry");
}

pub fn store_tokens(conn: &Connection, tokens: &TokenResult) {
    set_pref(conn, "google_access_token", &tokens.access_token);
    if let Some(refresh) = &tokens.refresh_token {
        set_pref(conn, "google_refresh_token", refresh);
    }
    set_pref(
        conn,
        "google_token_expiry",
        &(now_unix() + tokens.expires_in).to_string(),
    );
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
    // and Google's 400 response body is exactly where `invalid_grant` shows
    // up — the only way to tell "dead refresh token, stop retrying" apart
    // from an ordinary transient failure.
    if res.status().as_u16() == 400 {
        let body = res.text().unwrap_or_default();
        if body.contains("invalid_grant") {
            disconnect(conn); // clear the dead tokens so is_connected() goes false
            return Err(RECONNECT_REQUIRED.to_string());
        }
        return Err(format!("Google token refresh failed: {body}"));
    }

    let token_res: TokenResponse = res
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    set_pref(conn, "google_access_token", &token_res.access_token);
    set_pref(
        conn,
        "google_token_expiry",
        &(now_unix() + token_res.expires_in).to_string(),
    );
    Ok(token_res.access_token)
}

/// Returns a currently-valid access token, refreshing it first if it has
/// expired (or is within 60s of expiring).
pub fn get_valid_access_token(conn: &Connection) -> Result<String, String> {
    let refresh_token = get_pref(conn, "google_refresh_token").ok_or("Not connected to Google")?;
    let expiry: u64 = get_pref(conn, "google_token_expiry")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if now_unix() + 60 >= expiry {
        return refresh_access_token(conn, &refresh_token);
    }

    get_pref(conn, "google_access_token").ok_or_else(|| "Not connected to Google".to_string())
}
