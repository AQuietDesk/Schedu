use crate::db::DbState;
use crate::models::{ObsidianNote, ObsidianVaultStatus};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_VAULT_RESULTS: usize = 30;
const MAX_FILES_SCANNED: usize = 20_000;
const SNIPPET_RADIUS: usize = 80;

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

/// Extracts a trimmed, single-line window of text around the first
/// case-insensitive occurrence of `query` in `text`, for use as a result
/// preview. Falls back to the start of `text` if there's no match (callers
/// only use this once they already know a source field matched, but the
/// match may be in a sibling field).
fn snippet_around(text: &str, query: &str) -> String {
    let lower = text.to_lowercase();
    let needle = query.to_lowercase();
    let idx = lower.find(&needle).unwrap_or(0);

    let raw_start = idx.saturating_sub(SNIPPET_RADIUS);
    let raw_end = (idx + query.len() + SNIPPET_RADIUS).min(text.len());
    // `text` may contain multi-byte UTF-8, so the radius offsets above can
    // land mid-character — nudge both ends out to the nearest char boundary.
    let start = (0..=raw_start)
        .rev()
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(0);
    let end = (raw_end..=text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(text.len());

    let core = text[start..end].trim().replace('\n', " ");
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    format!("{prefix}{core}{suffix}")
}

fn is_hidden_dir(name: &str) -> bool {
    // Covers .obsidian (vault config), .git, .trash, and any other dotfolder
    // a user might have inside their vault — none of these hold real notes.
    name.starts_with('.')
}

/// Recursively collects every `.md` file under `dir`. Deliberately skips
/// symlinks (via `DirEntry::file_type`, which — unlike `Path::is_dir` —
/// doesn't follow them) so a symlink cycle inside the vault can't spin this
/// into an infinite loop, and caps total entries visited at
/// `MAX_FILES_SCANNED` as a second guard against a misconfigured path
/// (e.g. pointing the vault at a whole drive).
pub(crate) fn walk_markdown_files(dir: &Path, out: &mut Vec<PathBuf>, scanned: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *scanned >= MAX_FILES_SCANNED {
            return;
        }
        *scanned += 1;

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_hidden_dir);
            if !hidden {
                walk_markdown_files(&path, out, scanned);
            }
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
}

/// Canonicalizes and validates a candidate vault folder. Canonicalizing (not
/// just checking `is_dir`) is what makes the containment check in
/// `read_obsidian_note` sound — it resolves `..` segments and symlinks up
/// front so a later prefix comparison can't be fooled by them.
pub(crate) fn resolve_vault_root(vault_path: &str) -> Result<PathBuf, String> {
    let trimmed = vault_path.trim();
    if trimmed.is_empty() {
        return Err("No Obsidian vault folder configured".to_string());
    }
    let canonical =
        std::fs::canonicalize(trimmed).map_err(|e| format!("Can't access vault folder: {e}"))?;
    if !canonical.is_dir() {
        return Err("Vault path is not a folder".to_string());
    }
    Ok(canonical)
}

fn configured_vault_path(conn: &Connection) -> String {
    get_pref(conn, "obsidian_vault_path").unwrap_or_default()
}

/// Searches the configured Obsidian vault by filename and file content.
/// Returns an empty list (not an error) when no vault is configured yet —
/// an unset vault just means this section of results is empty, same as an
/// Item search with zero matches.
#[tauri::command]
pub fn search_obsidian_vault(
    state: State<DbState>,
    query: String,
) -> Result<Vec<ObsidianNote>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let vault_path = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        configured_vault_path(&conn)
    };
    if vault_path.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root = resolve_vault_root(&vault_path)?;

    let mut files = Vec::new();
    let mut scanned = 0usize;
    walk_markdown_files(&root, &mut files, &mut scanned);

    let needle = trimmed.to_lowercase();
    let mut results = Vec::new();
    for path in files {
        if results.len() >= MAX_VAULT_RESULTS {
            break;
        }
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| relative_str.clone());

        let title_matches = title.to_lowercase().contains(&needle);
        let content = std::fs::read_to_string(&path).ok();
        let content_matches = content
            .as_deref()
            .is_some_and(|c| c.to_lowercase().contains(&needle));
        if !title_matches && !content_matches {
            continue;
        }

        let modified = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
        let snippet = content
            .as_deref()
            .filter(|_| content_matches)
            .map(|c| snippet_around(c, trimmed));

        results.push(ObsidianNote {
            path: relative_str,
            title,
            snippet,
            modified,
        });
    }
    Ok(results)
}

/// Reads one note's raw markdown by vault-relative path. `relative_path`
/// values only ever come back from `search_obsidian_vault`'s own output, but
/// this is a Tauri command any script in the webview could call directly —
/// the canonicalize-then-prefix-check keeps a crafted `../../etc/passwd`
/// style path from escaping the configured vault folder.
#[tauri::command]
pub fn read_obsidian_note(state: State<DbState>, relative_path: String) -> Result<String, String> {
    let vault_path = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        configured_vault_path(&conn)
    };
    let root = resolve_vault_root(&vault_path)?;
    let candidate = root.join(&relative_path);
    let resolved =
        std::fs::canonicalize(&candidate).map_err(|e| format!("Can't read note: {e}"))?;
    if !resolved.starts_with(&root) {
        return Err("Note path is outside the configured vault".to_string());
    }
    std::fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

/// Probes a candidate vault folder from the Settings page before it's saved
/// as a preference — lets the user confirm the path is right (and see how
/// many notes it holds) without first committing it.
#[tauri::command]
pub fn test_obsidian_vault(path: String) -> Result<ObsidianVaultStatus, String> {
    let root = match resolve_vault_root(&path) {
        Ok(root) => root,
        Err(error) => {
            return Ok(ObsidianVaultStatus {
                valid: false,
                note_count: 0,
                error: Some(error),
            })
        }
    };
    let mut files = Vec::new();
    let mut scanned = 0usize;
    walk_markdown_files(&root, &mut files, &mut scanned);
    Ok(ObsidianVaultStatus {
        valid: true,
        note_count: files.len(),
        error: None,
    })
}
