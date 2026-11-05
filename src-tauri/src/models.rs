use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Context {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub name: String,
    pub color: Option<String>,
    pub status: String,
    pub term: Option<String>,
    pub schedule: Option<String>,
    pub owner: Option<String>,
    pub grade_scale: Option<Value>,
    pub grade_cutoffs: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ContextInput {
    #[serde(rename = "type")]
    pub type_: String,
    pub name: String,
    pub color: Option<String>,
    pub status: Option<String>,
    pub term: Option<String>,
    pub schedule: Option<String>,
    pub owner: Option<String>,
    pub grade_scale: Option<Value>,
    pub grade_cutoffs: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub category: String,
    pub subcategory_id: Option<String>,
    pub subcategory_text: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub estimated_duration: Option<i64>,
    pub priority: String,
    pub status: String,
    pub repeat_settings: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    pub attachments: Option<Vec<String>>,
    /// Round-trips with Google Calendar's `location` field (see
    /// google/sync.rs's apply_remote_calendar_event / push_one_item). Has no
    /// Google Tasks equivalent.
    pub location: Option<String>,

    pub google_calendar_id: Option<String>,
    pub google_task_id: Option<String>,
    pub last_synced_at_calendar: Option<String>,
    pub last_synced_at_tasks: Option<String>,

    /// Sync-failure state — see the `item.last_sync_error` column comment in
    /// db.rs. `sync_status` in the frontend Item type is *derived* from these
    /// plus last_synced_at_*/updated_at/open-conflict, not a separate stored
    /// enum (see google/sync.rs::derive_sync_status and its frontend mirror).
    pub last_sync_error: Option<String>,
    pub last_sync_attempted_at: Option<String>,
    pub sync_failure_count: i64,

    pub assignment_type: Option<String>,
    pub points_earned: Option<f64>,
    pub points_possible: Option<f64>,

    /// Non-null only for Items created by the Obsidian task scanner (see
    /// obsidian_tasks.rs) — mirrors the google_calendar_id/google_task_id
    /// pattern above, but for a note-based source instead of a synced one.
    pub obsidian_source_id: Option<String>,
    pub obsidian_vault_path: Option<String>,
    pub obsidian_source_folder: Option<String>,
    pub obsidian_source_file: Option<String>,
    pub obsidian_source_section: Option<String>,

    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}



#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickNote {
    pub id: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QuickNoteInput {
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub context_id: String,
    pub item_id: Option<String>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NoteInput {
    pub context_id: String,
    pub item_id: Option<String>,
    pub body: String,
}



/// One Obsidian note matched by `search::search_obsidian_vault`. `path` is
/// vault-relative (forward-slash separated) so it round-trips back into
/// `search::read_obsidian_note` regardless of host OS path separators.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ObsidianNote {
    pub path: String,
    pub title: String,
    pub snippet: Option<String>,
    pub modified: Option<String>,
}

/// Result of probing a candidate vault folder from the Settings page, before
/// it's saved as the `obsidian_vault_path` preference.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ObsidianVaultStatus {
    pub valid: bool,
    pub note_count: usize,
    pub error: Option<String>,
}

/// Result of one `scan_obsidian_tasks` run (obsidian_tasks.rs). `error` is
/// set only for a scan that couldn't start at all (vault/folder unreachable —
/// every count stays 0); `errors` collects individual file-level failures
/// from a scan that otherwise proceeded, so one bad file never aborts the rest.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ObsidianScanSummary {
    pub vault_path: Option<String>,
    pub scan_folder: String,
    pub scanned_at: String,
    pub files_scanned: usize,
    pub actionable_sections_found: usize,
    /// Unchecked ("- [ ]") checkbox tasks encountered — new_tasks + existing_tasks.
    pub tasks_found: usize,
    pub new_tasks: usize,
    pub existing_tasks: usize,
    /// Checked ("- [x]") checkbox items encountered — counted separately;
    /// never contributes to tasks_found/new_tasks (see Phase 4/8 of the build spec).
    pub completed_source_tasks: usize,
    pub errors: Vec<String>,
    /// Set only when the scan couldn't run at all (e.g. vault or configured
    /// folder unreachable) — distinct from per-file `errors`.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FocusSession {
    pub id: String,
    pub intent: String,
    pub goal: Option<String>,
    pub item_id: Option<String>,
    pub category: Option<String>,
    pub planned_duration_seconds: Option<i64>,
    pub break_duration_seconds: i64,
    pub phase: String,
    pub running_since: Option<String>,
    pub accumulated_seconds: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub actual_duration_seconds: Option<i64>,
    pub session_state: String,
    pub outcome: Option<String>,
    pub reflection_note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartFocusSessionInput {
    pub intent: String,
    pub goal: Option<String>,
    pub item_id: Option<String>,
    pub category: Option<String>,
    pub planned_duration_seconds: Option<i64>,
    pub break_duration_seconds: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ItemInput {
    pub title: String,
    pub description: Option<String>,
    pub category: String,
    pub subcategory_id: Option<String>,
    pub subcategory_text: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub estimated_duration: Option<i64>,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub repeat_settings: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    pub attachments: Option<Vec<String>>,
    pub location: Option<String>,
    pub assignment_type: Option<String>,
    pub points_earned: Option<f64>,
    pub points_possible: Option<f64>,
}
