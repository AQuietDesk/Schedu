//! Deterministic Obsidian "Next Steps" / "Action Items" task scanner.
//!
//! Deliberately NOT an AI/NLP system: this module only recognizes two exact
//! `##` headings and standard Markdown checkboxes underneath them. No LLM,
//! embeddings, semantic search, or inference of any kind — a line either
//! matches the explicit syntax or it's ignored, full stop (build spec Phase
//! 15). Reuses search.rs's existing vault-walking/validation (resolve_vault_root,
//! walk_markdown_files) rather than re-implementing vault access, and reuses
//! commands.rs's ITEM_COLUMNS/insert_item_row so a scanned Item is written
//! through the exact same path as one created from the UI.

use crate::commands::{self, now};
use crate::db::DbState;
use crate::models::{Item, ObsidianScanSummary};
use crate::search;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

/// Default configured source folder (build spec Phase 2) — only used the
/// first time, before the user ever sets `obsidian_scan_folder`; from then on
/// it's just an ordinary preference (Phase 3), changeable with no code change.
/// Empty means the whole vault.
const DEFAULT_SCAN_FOLDER: &str = "";

const NEXT_STEPS_HEADING: &str = "Next Steps";
const ACTION_ITEMS_HEADING: &str = "Action Items";

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

// ---------------------------------------------------------------------------
// Parsing — pure, no I/O, so it's directly unit-testable (see tests below).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTask {
    pub section: String,
    pub text: String,
    pub completed: bool,
    /// nth occurrence (0-based, in document order) of this exact (section,
    /// text) pair within the file, counting checked and unchecked lines
    /// together. Exists purely to disambiguate an identical task line
    /// repeated in the same section — see compute_source_id's doc comment.
    pub occurrence_index: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParseResult {
    pub tasks: Vec<ParsedTask>,
    pub actionable_sections: usize,
}

/// Returns `Some((level, heading_text))` if `line` is an ATX Markdown heading
/// (`#` through `######`, followed by whitespace or end-of-line — so `#tag`
/// is correctly not treated as a heading).
fn heading_level_and_text(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let level = trimmed.chars().take_while(|&c| c == '#').count();
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None; // e.g. "###notaheading"
    }
    Some((level, rest.trim().to_string()))
}

/// Matches exactly `- [ ] text` / `- [x] text` / `- [X] text` (arbitrary
/// leading indentation allowed). Returns `Some((completed, text))`. Anything
/// else — prose, a plain `- bullet`, `-[ ]` with no space, `* [ ] text` —
/// deliberately doesn't match: the build spec requires ignoring everything
/// that isn't this exact, explicit syntax.
fn parse_checkbox_line(line: &str) -> Option<(bool, String)> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("- [")?;
    let mut chars = rest.chars();
    let marker = chars.next()?;
    if marker != ' ' && marker != 'x' && marker != 'X' {
        return None;
    }
    let rest = chars.as_str().strip_prefix(']')?;
    let text = rest.strip_prefix(' ')?.trim();
    if text.is_empty() {
        return None;
    }
    Some((marker == 'x' || marker == 'X', text.to_string()))
}

/// Extracts every checkbox task under a `## Next Steps` or `## Action Items`
/// heading. A section runs until the next heading at the same or higher
/// level (i.e. any `#`/`##`); a `###`+ subheading does not end it (build
/// spec Phase 5's "Additional Context" example).
pub fn parse_markdown_tasks(markdown: &str) -> ParseResult {
    let mut current_section: Option<String> = None;
    let mut actionable_sections = 0usize;
    let mut occurrence_counts: HashMap<(String, String), usize> = HashMap::new();
    let mut tasks = Vec::new();

    for line in markdown.lines() {
        if let Some((level, heading_text)) = heading_level_and_text(line) {
            if level <= 2 {
                current_section = if heading_text == NEXT_STEPS_HEADING || heading_text == ACTION_ITEMS_HEADING
                {
                    actionable_sections += 1;
                    Some(heading_text)
                } else {
                    None
                };
            }
            continue;
        }

        let Some(section) = current_section.clone() else {
            continue;
        };
        let Some((completed, text)) = parse_checkbox_line(line) else {
            continue;
        };

        let key = (section.clone(), text.clone());
        let occurrence_index = *occurrence_counts.get(&key).unwrap_or(&0);
        occurrence_counts.insert(key, occurrence_index + 1);

        tasks.push(ParsedTask {
            section,
            text,
            completed,
            occurrence_index,
        });
    }

    ParseResult {
        tasks,
        actionable_sections,
    }
}

/// Deterministic identity for one source checkbox line: the same
/// (vault-relative file, section, task text) always hashes to the same id, so
/// re-scanning an unchanged note can never create a duplicate Item (build
/// spec Phase 7). `occurrence_index` only matters when the exact same task
/// text appears more than once in the same section of the same file — it
/// keeps those from colliding while staying deterministic run to run
/// (re-parsing the same file always encounters duplicate lines in the same
/// order). Checked vs. unchecked is deliberately NOT part of the id, so a
/// task that gets checked off later still resolves to the same Item and can
/// be marked Completed instead of orphaned (Phase 8).
pub fn compute_source_id(relative_file: &str, section: &str, text: &str, occurrence_index: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_file.as_bytes());
    hasher.update([0u8]);
    hasher.update(section.as_bytes());
    hasher.update([0u8]);
    hasher.update(text.as_bytes());
    hasher.update([0u8]);
    hasher.update(occurrence_index.to_string().as_bytes());
    format!("obsidian:{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

fn find_item_id_by_source_id(conn: &Connection, source_id: &str) -> Option<String> {
    // Intentionally not filtered by deleted_at: a soft-deleted Item still
    // "claims" its source id forever, so a task the user removed from the
    // dashboard is never silently recreated on the next scan (Phase 8's
    // "safe synchronization" requirement).
    conn.query_row(
        "SELECT id FROM item WHERE obsidian_source_id = ?1",
        params![source_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// A source checkbox flipped to `[x]`: reflect that on the matching Item, if
/// one exists and is still live and not already Completed. No-op (not an
/// error) when there's no matching Item — a task that was completed before
/// its first scan is never created as an open Item at all (Phase 4).
fn mark_completed_if_open(conn: &Connection, source_id: &str) {
    let _ = conn.execute(
        "UPDATE item SET status = 'Completed', updated_at = ?2 \
         WHERE obsidian_source_id = ?1 AND deleted_at IS NULL AND status != 'Completed'",
        params![source_id, now()],
    );
}

#[allow(clippy::too_many_arguments)]
fn create_scanned_item(
    conn: &Connection,
    source_id: &str,
    vault_path: &str,
    scan_folder: &str,
    relative_file: &str,
    section: &str,
    text: &str,
) {
    let ts = now();
    let item = Item {
        id: Uuid::new_v4().to_string(),
        title: text.to_string(),
        description: None,
        // Not determinable from a bare checkbox line (build spec Phase 6: "do
        // not invent values that cannot be determined from the note"), so it
        // lands in Personal under an "Obsidian" list the user can re-file from.
        category: "Personal".to_string(),
        subcategory_id: None,
        subcategory_text: Some("Obsidian".to_string()),
        due_date: None,
        due_time: None,
        estimated_duration: None,
        priority: "Medium".to_string(),
        status: "Not Started".to_string(),
        repeat_settings: None,
        color: None,
        notes: None,
        tags: None,
        attachments: None,
        location: None,
        google_calendar_id: None,
        google_task_id: None,
        last_synced_at_calendar: None,
        last_synced_at_tasks: None,
        last_sync_error: None,
        last_sync_attempted_at: None,
        sync_failure_count: 0,
        assignment_type: None,
        points_earned: None,
        points_possible: None,
        obsidian_source_id: Some(source_id.to_string()),
        obsidian_vault_path: Some(vault_path.to_string()),
        obsidian_source_folder: Some(scan_folder.to_string()),
        obsidian_source_file: Some(relative_file.to_string()),
        obsidian_source_section: Some(section.to_string()),
        created_at: ts.clone(),
        updated_at: ts,
        deleted_at: None,
    };
    // A UNIQUE-constraint failure here means another write already claimed
    // this source id between our existence check and this insert — treat it
    // the same as "already existed" rather than surfacing an error, since
    // that's exactly what it means (see idx_item_obsidian_source_id in db.rs).
    if let Err(e) = commands::insert_item_row(conn, &item) {
        eprintln!("[obsidian scan] skipped creating item for {source_id}: {e}");
    }
}

fn empty_summary(scan_folder: String, scanned_at: String, error: String) -> ObsidianScanSummary {
    ObsidianScanSummary {
        vault_path: None,
        scan_folder,
        scanned_at,
        files_scanned: 0,
        actionable_sections_found: 0,
        tasks_found: 0,
        new_tasks: 0,
        existing_tasks: 0,
        completed_source_tasks: 0,
        errors: Vec::new(),
        error: Some(error),
    }
}

/// Runs one full scan of the configured folder against `conn`. Pure enough to
/// unit-test directly (see tests below) by pointing it at a scratch DB/vault,
/// without going through the Tauri command layer.
pub fn run_scan(conn: &Connection) -> ObsidianScanSummary {
    let scanned_at = now();
    let scan_folder =
        get_pref(conn, "obsidian_scan_folder").unwrap_or_else(|| DEFAULT_SCAN_FOLDER.to_string());
    let vault_path = get_pref(conn, "obsidian_vault_path").unwrap_or_default();

    let vault_root = match search::resolve_vault_root(&vault_path) {
        Ok(root) => root,
        Err(e) => return empty_summary(scan_folder, scanned_at, e),
    };

    // Resolve the configured folder relative to the vault root (Phase 3:
    // "prefer selecting a folder relative to the configured vault"), and
    // require it to actually resolve inside the vault — same containment
    // guard search::read_obsidian_note uses for note paths.
    let candidate = vault_root.join(&scan_folder);
    let source_root = match std::fs::canonicalize(&candidate) {
        Ok(p) if p.is_dir() && p.starts_with(&vault_root) => p,
        Ok(_) => {
            return empty_summary(
                scan_folder.clone(),
                scanned_at,
                format!("Configured folder '{scan_folder}' is not inside the vault"),
            )
        }
        Err(e) => {
            return empty_summary(
                scan_folder.clone(),
                scanned_at,
                format!("Configured folder '{scan_folder}' not found in vault: {e}"),
            )
        }
    };

    let mut files = Vec::new();
    let mut scanned_count = 0usize;
    search::walk_markdown_files(&source_root, &mut files, &mut scanned_count);

    let mut summary = ObsidianScanSummary {
        vault_path: Some(vault_path.clone()),
        scan_folder: scan_folder.clone(),
        scanned_at: scanned_at.clone(),
        files_scanned: 0,
        actionable_sections_found: 0,
        tasks_found: 0,
        new_tasks: 0,
        existing_tasks: 0,
        completed_source_tasks: 0,
        errors: Vec::new(),
        error: None,
    };

    for path in files {
        summary.files_scanned += 1;
        let relative_file = match path.strip_prefix(&vault_root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                summary.errors.push(format!("{relative_file}: {e}"));
                continue;
            }
        };

        let parsed = parse_markdown_tasks(&content);
        summary.actionable_sections_found += parsed.actionable_sections;

        for task in parsed.tasks {
            let source_id = compute_source_id(&relative_file, &task.section, &task.text, task.occurrence_index);
            if task.completed {
                summary.completed_source_tasks += 1;
                mark_completed_if_open(conn, &source_id);
                continue;
            }
            summary.tasks_found += 1;
            match find_item_id_by_source_id(conn, &source_id) {
                Some(_) => summary.existing_tasks += 1,
                None => {
                    create_scanned_item(
                        conn,
                        &source_id,
                        &vault_path,
                        &scan_folder,
                        &relative_file,
                        &task.section,
                        &task.text,
                    );
                    summary.new_tasks += 1;
                }
            }
        }
    }

    set_pref(conn, "obsidian_scan_last_at", &scanned_at);
    if let Ok(json) = serde_json::to_string(&summary) {
        set_pref(conn, "obsidian_scan_last_summary", &json);
    }

    summary
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Manual "Scan Now" entry point (build spec Phase 11). Locks the same
/// `DbState` mutex every other item-mutating command uses, so two scans (or a
/// scan racing a manual edit) can't interleave — this is what keeps
/// re-scanning from ever double-creating an Item, the same class of race that
/// required a dedicated fix for the Google sync loop (see
/// google::sync::SyncTrigger::run_sync_exclusive) — here it's free because
/// there's no separate background connection to race against.
#[tauri::command]
pub fn scan_obsidian_tasks(state: State<DbState>) -> Result<ObsidianScanSummary, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(run_scan(&conn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    // ---- pure parser tests -------------------------------------------------

    #[test]
    fn basic_extraction_under_next_steps() {
        let md = "## Next Steps\n\n- [ ] Review Chapter 6\n- [ ] Complete questions 1-10\n";
        let result = parse_markdown_tasks(md);
        assert_eq!(result.actionable_sections, 1);
        assert_eq!(result.tasks.len(), 2);
        assert_eq!(result.tasks[0].text, "Review Chapter 6");
        assert_eq!(result.tasks[1].text, "Complete questions 1-10");
        assert!(result.tasks.iter().all(|t| !t.completed));
    }

    #[test]
    fn basic_extraction_under_action_items() {
        let md = "## Action Items\n\n- [ ] Email professor\n- [ ] Submit assignment\n";
        let result = parse_markdown_tasks(md);
        assert_eq!(result.tasks.len(), 2);
        assert_eq!(result.tasks[0].text, "Email professor");
        assert_eq!(result.tasks[1].text, "Submit assignment");
    }

    #[test]
    fn completed_checkbox_is_not_an_open_task() {
        let md = "## Next Steps\n\n- [x] Already completed\n- [ ] Still required\n";
        let result = parse_markdown_tasks(md);
        let open: Vec<_> = result.tasks.iter().filter(|t| !t.completed).collect();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].text, "Still required");
        let completed: Vec<_> = result.tasks.iter().filter(|t| t.completed).collect();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].text, "Already completed");
    }

    #[test]
    fn section_ends_at_next_heading_same_or_higher_level() {
        let md = "## Next Steps\n\n- [ ] Real task\n\n## Questions\n\n- [ ] This is NOT a task\n\n## Action Items\n\n- [ ] Another task\n";
        let result = parse_markdown_tasks(md);
        assert_eq!(result.tasks.len(), 2);
        assert_eq!(result.tasks[0].text, "Real task");
        assert_eq!(result.tasks[1].text, "Another task");
    }

    #[test]
    fn subheading_does_not_end_an_actionable_section() {
        let md = "## Action Items\n\n- [ ] Email professor\n- [ ] Submit assignment\n\n### Additional Context\n\nSome explanatory text.\n";
        let result = parse_markdown_tasks(md);
        assert_eq!(result.tasks.len(), 2);
    }

    #[test]
    fn prose_is_never_interpreted_as_a_task() {
        let md = "## Notes\n\nI should probably review Chapter 8.\n\nIt would be good to email the professor.\n";
        let result = parse_markdown_tasks(md);
        assert_eq!(result.tasks.len(), 0);
        assert_eq!(result.actionable_sections, 0);
    }

    #[test]
    fn duplicate_task_text_in_one_section_gets_distinct_occurrence_indices() {
        let md = "## Next Steps\n\n- [ ] Follow up\n- [ ] Follow up\n";
        let result = parse_markdown_tasks(md);
        assert_eq!(result.tasks[0].occurrence_index, 0);
        assert_eq!(result.tasks[1].occurrence_index, 1);
        let id0 = compute_source_id("f.md", "Next Steps", "Follow up", result.tasks[0].occurrence_index);
        let id1 = compute_source_id("f.md", "Next Steps", "Follow up", result.tasks[1].occurrence_index);
        assert_ne!(id0, id1);
    }

    #[test]
    fn source_id_is_deterministic_across_repeated_parses() {
        let md = "## Next Steps\n\n- [ ] Review Chapter 6\n";
        let a = parse_markdown_tasks(md);
        let b = parse_markdown_tasks(md);
        let id_a = compute_source_id("x.md", &a.tasks[0].section, &a.tasks[0].text, a.tasks[0].occurrence_index);
        let id_b = compute_source_id("x.md", &b.tasks[0].section, &b.tasks[0].text, b.tasks[0].occurrence_index);
        assert_eq!(id_a, id_b);
    }

    // ---- scan integration tests (scratch DB + scratch vault on disk) ------

    fn scratch_env() -> (Connection, PathBuf) {
        let dir = std::env::temp_dir().join(format!("obsidian-scan-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("life-os.sqlite3");
        let conn = crate::db::init(&db_path).unwrap();
        let vault_dir = dir.join("vault");
        std::fs::create_dir_all(&vault_dir).unwrap();
        set_pref(&conn, "obsidian_vault_path", &vault_dir.to_string_lossy());
        (conn, vault_dir)
    }

    fn write_note(vault_dir: &Path, relative: &str, content: &str) {
        let path = vault_dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn write_note_bytes(vault_dir: &Path, relative: &str, content: &[u8]) {
        let path = vault_dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn scanning_twice_creates_zero_duplicates() {
        let (conn, vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        write_note(
            &vault_dir,
            "Term-1/ECON101/Week4.md",
            "## Next Steps\n\n- [ ] Review Chapter 6\n- [ ] Complete practice questions\n",
        );

        let first = run_scan(&conn);
        assert_eq!(first.new_tasks, 2);
        assert_eq!(first.existing_tasks, 0);

        let second = run_scan(&conn);
        assert_eq!(second.new_tasks, 0);
        assert_eq!(second.existing_tasks, 2);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM item WHERE obsidian_source_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn checking_a_box_completes_the_existing_item_without_duplicating() {
        let (conn, vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        write_note(
            &vault_dir,
            "Term-1/note.md",
            "## Next Steps\n\n- [ ] Review Chapter 6\n",
        );
        let first = run_scan(&conn);
        assert_eq!(first.new_tasks, 1);

        write_note(
            &vault_dir,
            "Term-1/note.md",
            "## Next Steps\n\n- [x] Review Chapter 6\n",
        );
        let second = run_scan(&conn);
        assert_eq!(second.new_tasks, 0);
        assert_eq!(second.completed_source_tasks, 1);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM item WHERE obsidian_source_id IS NOT NULL", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1, "must not create a second item for the now-completed task");

        let status: String = conn
            .query_row("SELECT status FROM item WHERE obsidian_source_id IS NOT NULL", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "Completed");
    }

    #[test]
    fn deleting_a_dashboard_task_is_never_undone_by_a_rescan() {
        let (conn, vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        write_note(
            &vault_dir,
            "Term-1/note.md",
            "## Next Steps\n\n- [ ] Review Chapter 6\n",
        );
        run_scan(&conn);
        conn.execute(
            "UPDATE item SET deleted_at = ?1 WHERE obsidian_source_id IS NOT NULL",
            params![now()],
        )
        .unwrap();

        let second = run_scan(&conn);
        assert_eq!(second.new_tasks, 0, "a soft-deleted task must not be recreated");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM item", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn recursive_nested_folders_are_scanned() {
        let (conn, vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        write_note(
            &vault_dir,
            "Term-1/ECON101/Week1/deep.md",
            "## Action Items\n\n- [ ] Nested task\n",
        );
        let summary = run_scan(&conn);
        assert_eq!(summary.new_tasks, 1);
        assert_eq!(summary.files_scanned, 1);
    }

    #[test]
    fn only_the_configured_folder_is_scanned() {
        let (conn, vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        write_note(
            &vault_dir,
            "Term-1/in-scope.md",
            "## Next Steps\n\n- [ ] In scope task\n",
        );
        write_note(
            &vault_dir,
            "other-folder/out-of-scope.md",
            "## Next Steps\n\n- [ ] Out of scope task\n",
        );
        let summary = run_scan(&conn);
        assert_eq!(summary.files_scanned, 1);
        assert_eq!(summary.new_tasks, 1);
    }

    #[test]
    fn changing_the_configured_folder_changes_what_gets_scanned() {
        let (conn, vault_dir) = scratch_env();
        write_note(
            &vault_dir,
            "Term-1/note.md",
            "## Next Steps\n\n- [ ] Fall task\n",
        );
        write_note(
            &vault_dir,
            "Term-2/note.md",
            "## Next Steps\n\n- [ ] Winter task\n",
        );

        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        let fall = run_scan(&conn);
        assert_eq!(fall.new_tasks, 1);

        set_pref(&conn, "obsidian_scan_folder", "Term-2");
        let winter = run_scan(&conn);
        assert_eq!(winter.new_tasks, 1, "changing the folder pref must change the scan source with no code change");

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM item", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn missing_configured_folder_fails_safely() {
        let (conn, _vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "does-not-exist");
        let summary = run_scan(&conn);
        assert!(summary.error.is_some());
        assert_eq!(summary.files_scanned, 0);
    }

    #[test]
    fn one_unreadable_file_does_not_abort_the_rest_of_the_scan() {
        let (conn, vault_dir) = scratch_env();
        set_pref(&conn, "obsidian_scan_folder", "Term-1");
        write_note(
            &vault_dir,
            "Term-1/good.md",
            "## Next Steps\n\n- [ ] Good task\n",
        );
        // Invalid UTF-8 makes read_to_string fail deterministically and
        // cross-platform — exercises the per-file error path without relying
        // on OS-specific permission APIs.
        write_note_bytes(&vault_dir, "Term-1/broken.md", &[0xFF, 0xFE, 0x00, 0x01]);

        let summary = run_scan(&conn);
        assert_eq!(summary.new_tasks, 1);
        assert_eq!(summary.errors.len(), 1);
        assert!(summary.error.is_none(), "a per-file error must not be a whole-scan failure");
    }
}
