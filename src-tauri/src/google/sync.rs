use super::api::{self, Task};
use super::oauth;
use crate::commands::{now, row_to_item, ITEM_COLUMNS};
use crate::models::Item;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const SYNC_INTERVAL_FLOOR: Duration = Duration::from_secs(30);

/// How long to wait after the *last* edit to a given item before pushing it
/// (see PushDebouncer / Phase 1 of the sync-reliability spec). Within the
/// recommended 500-1500ms band: short enough that a single edit reaches
/// Google in about a second, long enough that a rapid run of saves to the
/// same item (e.g. repeated status toggles) collapses into one push of the
/// final state instead of one push per edit.
const PUSH_DEBOUNCE: Duration = Duration::from_millis(800);

/// Lets any Tauri command (e.g. a delete) wake the background sync loop
/// immediately instead of waiting out the rest of its sleep interval, and
/// lets the `sync_now` command run a sync inline without racing the
/// background loop's own tick.
///
/// `run_lock` is what actually prevents duplicates: `push_items` reads an
/// item's `google_calendar_id`/`google_task_id`, makes a network call, and
/// only then writes the id back. If two `run_sync` calls (the periodic loop
/// tick and a manually-triggered "Sync Now", or two overlapping trigger
/// wakes) interleaved during that window, both would see the id as unset and
/// each create their own Google Calendar event / Task for the same item —
/// the second write would just clobber the first id in SQLite, leaving an
/// orphaned duplicate on the Google side that the app can no longer see.
/// Serializing every `run_sync` call through this lock closes that window.
/// `PushDebouncer` (below) shares the same lock for exactly the same reason —
/// a debounced single-item push is just another kind of push cycle.
pub struct SyncTrigger {
    tx: Mutex<mpsc::Sender<()>>,
    run_lock: Arc<Mutex<()>>,
}

impl SyncTrigger {
    /// Best-effort: if the sync thread has somehow gone away, there's no
    /// meaningful error to surface to the caller (a delete succeeded either
    /// way — this only affects how soon it reaches Google).
    pub fn notify(&self) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(());
        }
    }

    /// Runs `f` under the same lock the background sync loop and the push
    /// debouncer use, so it can never execute concurrently with an
    /// in-progress (or about-to-start) push cycle from either of them. Use
    /// this instead of calling `run_sync` / `push_item_by_id` directly from a
    /// command.
    pub fn run_exclusive<F, T>(&self, f: F) -> T
    where
        F: FnOnce() -> T,
    {
        let _guard = self.run_lock.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }

    pub fn run_sync_exclusive(&self, conn: &Connection) -> Result<(), String> {
        self.run_exclusive(|| run_sync(conn))
    }
}

/// Schedules a debounced single-item push (Phase 1). Backed by its own
/// background thread sharing `SyncTrigger`'s `run_lock`, so a debounced push
/// can never interleave with a full sync cycle or another debounced push.
pub struct PushDebouncer {
    tx: Mutex<mpsc::Sender<String>>,
}

impl PushDebouncer {
    /// (Re)schedules `item_id` to be pushed ~`PUSH_DEBOUNCE` from now. Safe
    /// to call on every save regardless of whether anything sync-relevant
    /// actually changed — a scheduled push that turns out to have nothing
    /// new to send is just a no-op (see `push_one_item`'s dirty check).
    /// Calling this again before the debounce fires resets the delay, so a
    /// burst of edits to the same item collapses into one push.
    pub fn schedule_push(&self, item_id: String) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(item_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Pure conflict-detection logic (see spec §7.2) — kept free of any I/O so it
// can be unit-tested directly. This is the highest-risk piece of Phase 7.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullDecision {
    /// Neither side changed since the last sync — nothing to do.
    NoOp,
    /// Only the Google-side copy changed — safe to apply it to the local Item.
    ApplyRemote,
    /// Both sides changed since the last sync — never silently pick one;
    /// surface it in the Sync Conflicts list instead.
    Conflict,
}

pub fn decide_pull_action(
    local_updated_at: DateTime<Utc>,
    remote_updated_at: DateTime<Utc>,
    last_synced_at: Option<DateTime<Utc>>,
) -> PullDecision {
    let remote_changed = match last_synced_at {
        Some(ts) => remote_updated_at > ts,
        None => true,
    };
    if !remote_changed {
        return PullDecision::NoOp;
    }

    let local_changed = match last_synced_at {
        Some(ts) => local_updated_at > ts,
        None => true,
    };

    if local_changed {
        PullDecision::Conflict
    } else {
        PullDecision::ApplyRemote
    }
}

// ---------------------------------------------------------------------------
// Sync status (Phase 4/6) — derived, not stored, so there's exactly one
// source of truth for "is this item dirty" (the existing updated_at vs
// last_synced_at_* comparison) instead of a second status flag that could
// drift from it. Mirrored on the frontend by lib/syncStatus.ts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Synced,
    Pending,
    Failed,
    Conflict,
}

pub fn derive_sync_status(item: &Item, has_open_conflict: bool) -> SyncStatus {
    if has_open_conflict {
        return SyncStatus::Conflict;
    }
    if item.last_sync_error.is_some() {
        return SyncStatus::Failed;
    }
    if task_push_needed(item) {
        return SyncStatus::Pending;
    }
    SyncStatus::Synced
}

// ---------------------------------------------------------------------------
// Canonical sync snapshot (Phase 2) — one shape used for both local and
// remote sides of a conflict, and for restoring a resolution. A field is
// `None` on a remote snapshot when that source genuinely has no concept of
// it (e.g. Tasks has no `location`), not when the value happens to be empty —
// see calendar_remote_snapshot / tasks_remote_snapshot.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncSnapshot {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub estimated_duration: Option<i64>,
    #[serde(default)]
    pub location: Option<String>,
}

/// The local side always has an opinion on every field the app supports.
pub fn local_snapshot(item: &Item) -> SyncSnapshot {
    SyncSnapshot {
        title: Some(item.title.clone()),
        notes: item.notes.clone(),
        due_date: item.due_date.clone(),
        due_time: item.due_time.clone(),
        status: Some(item.status.clone()),
        priority: Some(item.priority.clone()),
        estimated_duration: item.estimated_duration,
        location: item.location.clone(),
    }
}

/// Google Tasks has no `location`, no `priority`, and (practically) no
/// separate due *time* — its `due` field is date-only in the UI/most
/// clients, so it's left out here rather than parsed into a possibly-bogus
/// due_time.
fn tasks_remote_snapshot(task: &Task) -> SyncSnapshot {
    SyncSnapshot {
        title: task.title.clone(),
        notes: task.notes.clone(),
        due_date: task.due.as_deref().map(|d| d.chars().take(10).collect()),
        due_time: None,
        status: task.status.clone(),
        priority: None,
        estimated_duration: None,
        location: None,
    }
}

/// One (field, local, remote) row per field that both snapshots have an
/// opinion on *and* actually differ on — a field the remote source doesn't
/// support (`None`, per calendar/tasks_remote_snapshot above) is never shown,
/// and a field that matches isn't either (Phase 2: "only display fields that
/// differ").
#[derive(Debug, Serialize)]
pub struct SnapshotFieldDiff {
    pub field: &'static str,
    pub local: String,
    pub remote: String,
}

pub fn diff_snapshots(local: &SyncSnapshot, remote: &SyncSnapshot) -> Vec<SnapshotFieldDiff> {
    fn describe(v: &Option<String>) -> String {
        v.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "—".to_string())
    }
    fn describe_opt<T: ToString>(v: &Option<T>) -> String {
        v.as_ref().map(|x| x.to_string()).unwrap_or_else(|| "—".to_string())
    }

    let mut diffs = Vec::new();

    if remote.title.is_some() && local.title != remote.title {
        diffs.push(SnapshotFieldDiff {
            field: "Title",
            local: describe(&local.title),
            remote: describe(&remote.title),
        });
    }
    if remote.notes.is_some() && local.notes != remote.notes {
        diffs.push(SnapshotFieldDiff {
            field: "Notes",
            local: describe(&local.notes),
            remote: describe(&remote.notes),
        });
    }
    if remote.due_date.is_some() && local.due_date != remote.due_date {
        diffs.push(SnapshotFieldDiff {
            field: "Due date",
            local: describe(&local.due_date),
            remote: describe(&remote.due_date),
        });
    }
    if remote.due_time.is_some() && local.due_time != remote.due_time {
        diffs.push(SnapshotFieldDiff {
            field: "Due time",
            local: describe(&local.due_time),
            remote: describe(&remote.due_time),
        });
    }
    if remote.status.is_some() && local.status != remote.status {
        diffs.push(SnapshotFieldDiff {
            field: "Status",
            local: describe(&local.status),
            remote: describe(&remote.status),
        });
    }
    if remote.location.is_some() && local.location != remote.location {
        diffs.push(SnapshotFieldDiff {
            field: "Location",
            local: describe(&local.location),
            remote: describe(&remote.location),
        });
    }
    if remote.estimated_duration.is_some() && local.estimated_duration != remote.estimated_duration
    {
        diffs.push(SnapshotFieldDiff {
            field: "Estimated duration",
            local: describe_opt(&local.estimated_duration),
            remote: describe_opt(&remote.estimated_duration),
        });
    }
    diffs
}

/// Applies every field the remote snapshot has an opinion on to `item`,
/// leaving fields the source doesn't support (`None`) untouched — the "Keep
/// Google's" resolution (Phase 2) must restore the *complete* supported
/// remote state, not the 2-3 fields the old ad hoc snapshot happened to keep.
pub fn apply_remote_snapshot_to_item(item: &Item, remote: &SyncSnapshot) -> Item {
    let mut updated = item.clone();
    if let Some(title) = &remote.title {
        updated.title = title.clone();
    }
    if remote.notes.is_some() {
        updated.notes = remote.notes.clone();
    }
    if remote.due_date.is_some() {
        updated.due_date = remote.due_date.clone();
    }
    if remote.due_time.is_some() {
        updated.due_time = remote.due_time.clone();
    }
    if let Some(status) = &remote.status {
        updated.status = map_tasks_status(status, &item.status);
    }
    if remote.location.is_some() {
        updated.location = remote.location.clone();
    }
    if remote.estimated_duration.is_some() {
        updated.estimated_duration = remote.estimated_duration;
    }
    updated
}

/// Google Tasks only has "needsAction" | "completed"; anything else (or a
/// task flipping back to needsAction while the Item was already Completed)
/// maps to "In Progress" rather than silently forcing "Not Started" — same
/// rule apply_remote_task used before Phase 2.
fn map_tasks_status(remote_status: &str, current_local_status: &str) -> String {
    if remote_status == "completed" {
        "Completed".to_string()
    } else if current_local_status == "Completed" {
        "In Progress".to_string()
    } else {
        current_local_status.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 12, minute, 0).unwrap()
    }

    #[test]
    fn neither_side_changed_is_noop() {
        let last_sync = t(0);
        assert_eq!(
            decide_pull_action(last_sync, last_sync, Some(last_sync)),
            PullDecision::NoOp
        );
    }

    #[test]
    fn remote_changed_only_applies_remote() {
        let last_sync = t(0);
        let local_updated_at = last_sync; // unchanged since last sync
        let remote_updated_at = t(5); // changed after last sync
        assert_eq!(
            decide_pull_action(local_updated_at, remote_updated_at, Some(last_sync)),
            PullDecision::ApplyRemote
        );
    }

    #[test]
    fn local_changed_only_is_noop_for_pull() {
        // Local-only changes are the push path's job, not the pull decision's.
        let last_sync = t(0);
        let local_updated_at = t(5);
        let remote_updated_at = last_sync; // unchanged
        assert_eq!(
            decide_pull_action(local_updated_at, remote_updated_at, Some(last_sync)),
            PullDecision::NoOp
        );
    }

    #[test]
    fn both_sides_changed_is_conflict() {
        let last_sync = t(0);
        let local_updated_at = t(3);
        let remote_updated_at = t(5);
        assert_eq!(
            decide_pull_action(local_updated_at, remote_updated_at, Some(last_sync)),
            PullDecision::Conflict
        );
    }

    #[test]
    fn remote_changed_at_exactly_last_sync_time_is_noop() {
        // Strictly-greater-than, not >=: a remote timestamp equal to last_synced_at
        // means "as of our last sync," not "changed since."
        let last_sync = t(0);
        assert_eq!(
            decide_pull_action(last_sync, last_sync, Some(last_sync)),
            PullDecision::NoOp
        );
    }

    #[test]
    fn never_synced_before_is_treated_as_conflict_defensively() {
        // Shouldn't happen in practice (an item can only be matched to a remote
        // id after a push sets last_synced_at), but if it ever does, refuse to
        // guess rather than silently overwrite either side.
        assert_eq!(decide_pull_action(t(1), t(2), None), PullDecision::Conflict);
    }

    // -----------------------------------------------------------------
    // SyncSnapshot / diffing / resolution (Phase 2)
    // -----------------------------------------------------------------

    fn sample_item() -> Item {
        Item {
            id: "item-1".into(),
            title: "Finish analysis".into(),
            description: None,
            category: "Personal".into(),
            subcategory_id: None,
            subcategory_text: None,
            due_date: Some("2026-03-05".into()),
            due_time: Some("14:00".into()),
            estimated_duration: Some(30),
            priority: "High".into(),
            status: "In Progress".into(),
            repeat_settings: None,
            color: None,
            notes: Some("Prepare revised financial analysis".into()),
            tags: None,
            attachments: None,
            location: Some("Room 204".into()),
            google_calendar_id: Some("evt-1".into()),
            google_task_id: Some("task-1".into()),
            last_synced_at_calendar: Some("2026-03-01T00:00:00Z".into()),
            last_synced_at_tasks: Some("2026-03-01T00:00:00Z".into()),
            last_sync_error: None,
            last_sync_attempted_at: None,
            sync_failure_count: 0,
            assignment_type: None,
            points_earned: None,
            points_possible: None,
            obsidian_source_id: None,
            obsidian_vault_path: None,
            obsidian_source_folder: None,
            obsidian_source_file: None,
            obsidian_source_section: None,
            created_at: "2026-03-01T00:00:00Z".into(),
            updated_at: "2026-03-01T00:00:00Z".into(),
            deleted_at: None,
        }
    }

    #[test]
    fn local_snapshot_captures_every_supported_field() {
        let item = sample_item();
        let snap = local_snapshot(&item);
        assert_eq!(snap.title.as_deref(), Some("Finish analysis"));
        assert_eq!(snap.notes.as_deref(), Some("Prepare revised financial analysis"));
        assert_eq!(snap.due_date.as_deref(), Some("2026-03-05"));
        assert_eq!(snap.due_time.as_deref(), Some("14:00"));
        assert_eq!(snap.status.as_deref(), Some("In Progress"));
        assert_eq!(snap.priority.as_deref(), Some("High"));
        assert_eq!(snap.estimated_duration, Some(30));
        assert_eq!(snap.location.as_deref(), Some("Room 204"));
    }

    #[test]
    fn tasks_remote_snapshot_omits_location_and_priority() {
        let task = Task {
            id: "task-1".into(),
            title: Some("Finish analysis".into()),
            notes: Some("Different notes".into()),
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("needsAction".into()),
            due: Some("2026-03-06T00:00:00.000Z".into()),
            deleted: None,
        };
        let snap = tasks_remote_snapshot(&task);
        assert_eq!(snap.location, None, "Tasks has no location field");
        assert_eq!(snap.priority, None, "Tasks has no priority field");
        assert_eq!(snap.due_date.as_deref(), Some("2026-03-06"));
        assert_eq!(snap.due_time, None);
    }

    #[test]
    fn diff_only_reports_fields_that_actually_differ_and_are_supported() {
        let local = local_snapshot(&sample_item());
        let remote = SyncSnapshot {
            title: Some("Finish analysis".into()), // same as local — no diff
            notes: Some("Prepare financial analysis and send to team".into()), // differs
            location: Some("Room 100".into()), // differs
            ..SyncSnapshot::default() // no opinion on status or due date
        };
        let diffs = diff_snapshots(&local, &remote);
        let fields: Vec<&str> = diffs.iter().map(|d| d.field).collect();
        assert!(fields.contains(&"Notes"));
        assert!(fields.contains(&"Location"));
        assert!(!fields.contains(&"Title"), "title matches, shouldn't be reported");
        assert!(!fields.contains(&"Status"), "remote has no status opinion");
        assert!(!fields.contains(&"Due date"), "remote had no due date, nothing to compare");
    }

    #[test]
    fn keep_googles_restores_full_supported_remote_state_text_and_nontext_field() {
        let item = sample_item();
        let remote = SyncSnapshot {
            title: Some("Finish analysis".into()),
            notes: Some("Prepare financial analysis and send to team".into()), // text field
            due_date: Some("2026-03-06".into()),
            due_time: None,
            status: None,
            priority: None,
            estimated_duration: Some(45), // non-text field
            location: Some("Room 100".into()),
        };
        let resolved = apply_remote_snapshot_to_item(&item, &remote);
        assert_eq!(resolved.notes.as_deref(), Some("Prepare financial analysis and send to team"));
        assert_eq!(resolved.estimated_duration, Some(45));
        assert_eq!(resolved.due_date.as_deref(), Some("2026-03-06"));
        assert_eq!(resolved.location.as_deref(), Some("Room 100"));
        // Fields the calendar source has no opinion on stay exactly as local had them.
        assert_eq!(resolved.priority, item.priority);
        assert_eq!(resolved.status, item.status);
    }

    #[test]
    fn keep_local_preserves_full_local_snapshot_unchanged() {
        let item = sample_item();
        let snap = local_snapshot(&item);
        // "Keep local" never calls apply_remote_snapshot_to_item — the local
        // Item is simply re-pushed as-is. This just documents that its
        // snapshot equals what's already stored, i.e. nothing was dropped.
        assert_eq!(snap.title.as_deref(), Some(item.title.as_str()));
        assert_eq!(snap.notes, item.notes);
        assert_eq!(snap.location, item.location);
        assert_eq!(snap.estimated_duration, item.estimated_duration);
        assert_eq!(snap.priority.as_deref(), Some(item.priority.as_str()));
    }

    #[test]
    fn remote_field_absent_never_overwrites_local_value() {
        // A Google Task with no notes in the JSON payload (key omitted)
        // must never be mistaken for "the user cleared their notes."
        let item = sample_item();
        let task = Task {
            id: "task-1".into(),
            title: Some("Finish analysis".into()),
            notes: None, // omitted by Google
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("needsAction".into()),
            due: None,
            deleted: None,
        };
        let remote = tasks_remote_snapshot(&task);
        let resolved = apply_remote_snapshot_to_item(&item, &remote);
        assert_eq!(resolved.notes, item.notes, "absent description must not clear local notes");
        assert_eq!(resolved.location, item.location, "Tasks has no location, so it must not clear it");
    }

    #[test]
    fn remote_field_explicitly_cleared_to_empty_string_does_clear_local() {
        // Distinct from the above: Google *did* include the key, with an
        // empty value — that's a real explicit clear, not an omission.
        let item = sample_item();
        let task = Task {
            id: "task-1".into(),
            title: Some("Finish analysis".into()),
            notes: Some("".into()),
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("needsAction".into()),
            due: None,
            deleted: None,
        };
        let remote = tasks_remote_snapshot(&task);
        let resolved = apply_remote_snapshot_to_item(&item, &remote);
        assert_eq!(resolved.notes.as_deref(), Some(""));
    }

    // -----------------------------------------------------------------
    // Push-needed gating (Phase 1 dirty-state, existing mechanism reused)
    // -----------------------------------------------------------------

    #[test]
    fn task_push_needed_regardless_of_due_date() {
        let mut item = sample_item();
        item.due_date = None;
        item.last_synced_at_tasks = None;
        assert!(task_push_needed(&item));
    }

    #[test]
    fn push_not_needed_once_last_synced_at_is_after_updated_at() {
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into();
        item.last_synced_at_calendar = Some("2026-03-02T00:00:00Z".into());
        item.last_synced_at_tasks = Some("2026-03-02T00:00:00Z".into());
        assert!(!task_push_needed(&item));
    }

    // -----------------------------------------------------------------
    // derive_sync_status (Phase 4/6) — precedence and each terminal state
    // -----------------------------------------------------------------

    #[test]
    fn derives_synced_when_nothing_is_dirty_or_failing() {
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into();
        item.last_synced_at_calendar = Some("2026-03-02T00:00:00Z".into());
        item.last_synced_at_tasks = Some("2026-03-02T00:00:00Z".into());
        item.last_sync_error = None;
        assert_eq!(derive_sync_status(&item, false), SyncStatus::Synced);
    }

    #[test]
    fn derives_pending_when_dirty() {
        let mut item = sample_item();
        item.updated_at = "2026-03-05T00:00:00Z".into(); // edited after the last push
        assert_eq!(derive_sync_status(&item, false), SyncStatus::Pending);
    }

    #[test]
    fn derives_failed_when_last_sync_error_set() {
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into();
        item.last_synced_at_calendar = Some("2026-03-02T00:00:00Z".into());
        item.last_synced_at_tasks = Some("2026-03-02T00:00:00Z".into());
        item.last_sync_error = Some("Google Task could not be updated.".into());
        assert_eq!(derive_sync_status(&item, false), SyncStatus::Failed);
    }

    #[test]
    fn conflict_takes_precedence_over_failed_and_pending() {
        let mut item = sample_item();
        item.last_sync_error = Some("some earlier failure".into());
        assert_eq!(derive_sync_status(&item, true), SyncStatus::Conflict);
    }

    // -----------------------------------------------------------------
    // Push error classification (Phase 4/8)
    // -----------------------------------------------------------------

    #[test]
    fn classifies_not_found_errors_as_user_actionable() {
        let msg = friendly_push_error("tasks", "HTTP status client error (404 Not Found) for url ...");
        assert!(msg.contains("deleted") || msg.contains("no longer accessible"));
        assert!(!msg.contains("HTTP status client error"), "raw error text shouldn't leak into the UI message");
    }

    #[test]
    fn classifies_auth_errors_distinctly() {
        let msg = friendly_push_error("tasks", "HTTP status client error (401 Unauthorized) for url ...");
        assert!(msg.to_lowercase().contains("reconnect") || msg.to_lowercase().contains("permission"));
    }

    #[test]
    fn is_not_found_matches_404_status() {
        assert!(is_not_found_error("HTTP status client error (404 Not Found) for url https://..."));
        assert!(!is_not_found_error("HTTP status client error (500 Internal Server Error)"));
    }

    // -----------------------------------------------------------------
    // Debounce deadline math (Phase 1) — pure, so the real timing logic in
    // the debounce thread can be exercised without sleeping in a test.
    // -----------------------------------------------------------------

    #[test]
    fn scheduling_always_resets_the_deadline_forward() {
        let first = Instant::now() + PUSH_DEBOUNCE;
        // A later edit's deadline must be >= the first one's, even if it
        // lands before the first deadline elapses (the "reset on additional
        // edits" requirement).
        std::thread::sleep(Duration::from_millis(5));
        let second = Instant::now() + PUSH_DEBOUNCE;
        assert!(second >= first);
    }

    // -----------------------------------------------------------------
    // DB-integration tests — real temp SQLite connection (same pattern as
    // db.rs's tests), no network. Exercises apply_remote_* end to end and
    // push_item_by_id's not-found/conflict/deleted edge cases.
    // -----------------------------------------------------------------

    fn temp_conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("life-os-sync-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::init(&dir.join("life-os.sqlite3")).unwrap()
    }

    fn insert_test_item(conn: &Connection, item: &Item) {
        crate::commands::insert_item_row(conn, item).unwrap();
    }

    #[test]
    fn apply_remote_task_round_trips_notes_and_maps_completed_status() {
        let conn = temp_conn();
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into();
        item.last_synced_at_tasks = Some("2026-03-01T00:00:00Z".into());
        insert_test_item(&conn, &item);

        let task = Task {
            id: "task-1".into(),
            title: Some("Finish analysis".into()),
            notes: Some("Updated notes from Tasks".into()),
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("completed".into()),
            due: None,
            deleted: None,
        };

        apply_remote_task(&conn, &task);

        let updated = find_item_by_id(&conn, "item-1").expect("item still present");
        assert_eq!(updated.notes.as_deref(), Some("Updated notes from Tasks"));
        assert_eq!(updated.status, "Completed");
    }

    #[test]
    fn push_item_by_id_is_a_noop_for_an_item_that_no_longer_exists() {
        let conn = temp_conn();
        // No network access_token needed: find_item_by_id returns None
        // before push_one_item would ever touch the network.
        let result = push_item_by_id(&conn, "unused-token", "does-not-exist");
        assert!(result.is_ok());
    }

    #[test]
    fn mark_item_deleted_locally_soft_deletes_without_touching_last_synced_at() {
        let conn = temp_conn();
        let mut item = sample_item();
        item.last_synced_at_calendar = Some("2026-03-01T00:00:00Z".into());
        insert_test_item(&conn, &item);

        mark_item_deleted_locally(&conn, "item-1");

        let (deleted_at, last_synced): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT deleted_at, last_synced_at_calendar FROM item WHERE id = 'item-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(deleted_at.is_some(), "item should be soft-deleted");
        assert_eq!(
            last_synced.as_deref(),
            Some("2026-03-01T00:00:00Z"),
            "a remote-deletion outcome isn't a successful channel sync"
        );
        assert!(find_item_by_id(&conn, "item-1").is_none(), "non_deleted lookups must exclude it");
    }

    #[test]
    fn push_item_by_id_refuses_to_push_over_an_open_conflict() {
        let conn = temp_conn();
        let item = sample_item();
        insert_test_item(&conn, &item);
        record_conflict(&conn, &item, "tasks", &SyncSnapshot::default());

        let result = push_item_by_id(&conn, "unused-token", "item-1");
        assert!(result.is_err());
    }
}

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

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

fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn non_deleted_items(conn: &Connection) -> Vec<Item> {
    let mut stmt = match conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM item WHERE deleted_at IS NULL"
    )) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], row_to_item)
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

fn deleted_items_with_remote_ids(conn: &Connection) -> Vec<Item> {
    let mut stmt = match conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM item WHERE deleted_at IS NOT NULL \
         AND google_task_id IS NOT NULL"
    )) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], row_to_item)
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

pub(crate) fn find_item_by_id(conn: &Connection, item_id: &str) -> Option<Item> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM item WHERE id = ?1 AND deleted_at IS NULL"),
        params![item_id],
        row_to_item,
    )
    .optional()
    .ok()
    .flatten()
}

fn record_conflict(conn: &Connection, item: &Item, source: &str, remote: &SyncSnapshot) {
    let local = local_snapshot(item);
    let _ = conn.execute(
        "INSERT INTO sync_conflict (id, item_id, source, local_snapshot, remote_snapshot, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            item.id,
            source,
            serde_json::to_string(&local).unwrap_or_default(),
            serde_json::to_string(remote).unwrap_or_default(),
            now()
        ],
    );
}

fn item_has_open_conflict(conn: &Connection, item_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sync_conflict WHERE item_id = ?1 LIMIT 1",
        params![item_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

fn pull_tasks(conn: &Connection, access_token: &str) -> Result<(), String> {
    let last_sync = get_pref(conn, "google_tasks_last_sync");
    let tasks = api::list_tasks(access_token, last_sync.as_deref())?;

    for task in &tasks {
        apply_remote_task(conn, task);
    }

    set_pref(conn, "google_tasks_last_sync", &now());
    Ok(())
}

fn apply_remote_task(conn: &Connection, task: &Task) {
    let Some(item) = find_item_by_column(conn, "google_task_id", &task.id) else {
        return;
    };
    let Some(remote_updated_at) = task.updated.as_deref().and_then(parse_rfc3339) else {
        return;
    };
    let last_synced_at = item.last_synced_at_tasks.as_deref().and_then(parse_rfc3339);
    let local_updated_at = match parse_rfc3339(&item.updated_at) {
        Some(t) => t,
        None => return,
    };

    match decide_pull_action(local_updated_at, remote_updated_at, last_synced_at) {
        PullDecision::NoOp => {}
        PullDecision::Conflict => {
            let remote = tasks_remote_snapshot(task);
            record_conflict(conn, &item, "tasks", &remote);
        }
        PullDecision::ApplyRemote => {
            if task.deleted == Some(true) {
                let ts = now();
                let _ = conn.execute(
                    "UPDATE item SET deleted_at = ?2, updated_at = ?2, last_synced_at_tasks = ?2 WHERE id = ?1",
                    params![item.id, ts],
                );
                return;
            }
            let remote = tasks_remote_snapshot(task);
            let resolved = apply_remote_snapshot_to_item(&item, &remote);
            let ts = now();
            // Only last_synced_at_tasks advances here — see the comment on
            // apply_remote_calendar_event's equivalent write.
            let _ = conn.execute(
                "UPDATE item SET title = ?2, notes = ?3, status = ?4, updated_at = ?5, last_synced_at_tasks = ?5 WHERE id = ?1",
                params![item.id, resolved.title, resolved.notes, resolved.status, ts],
            );
        }
    }
}

fn find_item_by_column(conn: &Connection, column: &str, value: &str) -> Option<Item> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM item WHERE {column} = ?1 AND deleted_at IS NULL"),
        params![value],
        row_to_item,
    )
    .optional()
    .ok()
    .flatten()
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

fn task_push_needed(item: &Item) -> bool {
    let Some(local_updated_at) = parse_rfc3339(&item.updated_at) else {
        return false;
    };
    match item.last_synced_at_tasks.as_deref().and_then(parse_rfc3339) {
        Some(ts) => local_updated_at > ts,
        None => true,
    }
}

fn is_not_found_error(raw: &str) -> bool {
    raw.contains("404")
}

fn is_auth_error(raw: &str) -> bool {
    raw.contains("401") || raw.contains("403")
}

/// Maps a raw reqwest/Google error string to a short, actionable message
/// safe to show in the UI (Phase 4: "avoid exposing raw technical errors").
/// The raw error is still logged in full via SYNC_PUSH (Phase 8) — this is
/// only what gets persisted to `item.last_sync_error`.
fn friendly_push_error(channel: &str, raw: &str) -> String {
    let noun = if channel == "calendar" { "Calendar event" } else { "Task" };
    if is_not_found_error(raw) {
        format!("Google {noun} could not be updated — it may have been deleted or is no longer accessible.")
    } else if is_auth_error(raw) {
        "Google didn't accept the request — try reconnecting your Google account in Settings.".to_string()
    } else {
        format!("Couldn't reach Google to update this {noun}. It will retry automatically.")
    }
}

/// Applies every field the local Item supports to a push request body,
/// pushing one item to Calendar and/or Tasks as needed, and persists the
/// resulting ids, last_synced_at_*, and sync-failure state. Shared by the
/// full periodic sweep, the debounce worker, and the manual per-item push
/// command — see PHASE 1/5's "don't build a second push implementation."
fn push_one_item(conn: &Connection, access_token: &str, item: &Item) {
    if !task_push_needed(item) {
        return;
    }

    let body = api::task_body(
        &item.title,
        item.notes.as_deref(),
        item.due_date.as_deref(),
        item.status == "Completed",
    );
    let result = match &item.google_task_id {
        Some(id) => api::update_task(access_token, id, &body),
        None => api::create_task(access_token, &body),
    };
    let ts = now();
    match result {
        Ok(task) => {
            log_push(item, "tasks", "update", "success", None);
            let _ = conn.execute(
                "UPDATE item SET google_task_id = ?2, last_synced_at_tasks = ?3, last_sync_error = NULL, \
                 sync_failure_count = 0, last_sync_attempted_at = ?3 WHERE id = ?1",
                params![item.id, task.id, ts],
            );
        }
        // A 404 on an *update* (never on a create) means the task was deleted
        // directly in Google Tasks. Mirror apply_remote_task's `deleted`
        // handling (the whole Item is gone) rather than silently making a
        // replacement task.
        Err(e) if item.google_task_id.is_some() && is_not_found_error(&e) => {
            log_push(item, "tasks", "update", "deleted_remotely", Some(&e));
            mark_item_deleted_locally(conn, &item.id);
        }
        // last_synced_at_tasks stays as it was, so the push retries next cycle.
        Err(e) => {
            log_push(item, "tasks", "update", "failed", Some(&e));
            let _ = conn.execute(
                "UPDATE item SET last_sync_error = ?2, sync_failure_count = sync_failure_count + 1, \
                 last_sync_attempted_at = ?3 WHERE id = ?1",
                params![item.id, friendly_push_error("tasks", &e), ts],
            );
        }
    }
}

/// Soft-deletes an Item locally after a push discovers its remote Calendar
/// event or Task is gone (404 on update) — mirrors the pull-side precedent
/// (apply_remote_calendar_event's "cancelled" handling, apply_remote_task's
/// `deleted` handling) so a remote deletion means the same thing regardless
/// of which sync direction happens to notice it first. Bumping updated_at
/// here is harmless (the item is deleted either way) and matches the Tasks
/// pull path; last_synced_at_* is deliberately left untouched — the deletion
/// isn't "this channel's data was successfully synced," it's an end state.
fn mark_item_deleted_locally(conn: &Connection, item_id: &str) {
    let ts = now();
    let _ = conn.execute(
        "UPDATE item SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![item_id, ts],
    );
}

/// Structured, single-line push log (Phase 8) — deliberately omits item
/// title/notes/location (user content); only the id and outcome.
fn log_push(item: &Item, channel: &str, operation: &str, result: &str, error: Option<&str>) {
    match error {
        Some(e) => eprintln!(
            "SYNC_PUSH item={} type={channel} operation={operation} result={result} error={e}",
            item.id
        ),
        None => eprintln!(
            "SYNC_PUSH item={} type={channel} operation={operation} result={result}",
            item.id
        ),
    }
}

fn push_items(conn: &Connection, access_token: &str) -> Result<(), String> {
    for item in non_deleted_items(conn) {
        if item_has_open_conflict(conn, &item.id) {
            continue; // don't push over an unresolved conflict
        }
        push_one_item(conn, access_token, &item);
    }
    Ok(())
}

/// Single-item push used by the debounce worker and the manual "Push
/// Now"/"Retry Sync" command. Silently no-ops (rather than erroring) for an
/// item that's since been deleted locally or no longer exists — both are
/// expected outcomes of "item deleted before the debounce fired," not
/// failures. Returns an error only for a real, user-actionable problem
/// (open conflict, e.g. from the manual command, where the caller should
/// tell the user why the push didn't happen).
pub(crate) fn push_item_by_id(
    conn: &Connection,
    access_token: &str,
    item_id: &str,
) -> Result<(), String> {
    let Some(item) = find_item_by_id(conn, item_id) else {
        return Ok(());
    };
    if item_has_open_conflict(conn, &item.id) {
        return Err(
            "This item has an unresolved sync conflict — resolve it in Sync Conflicts first."
                .to_string(),
        );
    }
    push_one_item(conn, access_token, &item);
    Ok(())
}

fn push_deletions(conn: &Connection, access_token: &str) {
    for item in deleted_items_with_remote_ids(conn) {
        let ok = match &item.google_task_id {
            Some(id) => api::delete_task(access_token, id).is_ok(),
            None => true,
        };
        if ok {
            // Confirmed removed on the Google side — safe to purge locally (spec §7.4).
            let _ = conn.execute("DELETE FROM item WHERE id = ?1", params![item.id]);
        }
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

pub fn run_sync(conn: &Connection) -> Result<(), String> {
    if !oauth::is_connected(conn) {
        return Ok(()); // not connected — silently skip, nothing to sync
    }
    let access_token = oauth::get_valid_access_token(conn)?;

    pull_tasks(conn, &access_token)?;
    push_items(conn, &access_token)?;
    push_deletions(conn, &access_token);

    Ok(())
}

/// Runs on its own OS thread with its own SQLite connection (WAL mode lets it
/// coexist with the frontend's shared connection and the notification
/// thread's) so a slow network round-trip during sync never blocks other
/// DB-backed commands. Fires once immediately on launch, then on the
/// configured interval — matching spec §7.2's triggers (launch + periodic;
/// "Sync now" is the separate `sync_now` command) — or as soon as it's woken
/// early via the returned `SyncTrigger` (e.g. right after a local delete, so
/// the remote event/task doesn't sit orphaned for a full interval).
///
/// Also spawns the debounce worker backing the returned `PushDebouncer` (see
/// its docs) on a second thread sharing this loop's `run_lock`.
pub fn spawn(app: tauri::AppHandle, db_path: PathBuf) -> (SyncTrigger, PushDebouncer) {
    let (tx, rx) = mpsc::channel::<()>();
    let run_lock = Arc::new(Mutex::new(()));
    let thread_run_lock = Arc::clone(&run_lock);
    let debouncer_db_path = db_path.clone();
    std::thread::spawn(move || {
        let conn = match crate::db::init(&db_path) {
            Ok(c) => c,
            Err(_) => return,
        };
        loop {
            // A dead refresh token (revoked, or expired after 7 days on an
            // unverified OAuth consent screen) can't fix itself by retrying —
            // oauth::refresh_access_token already clears the stored tokens
            // when it detects this, so is_connected() goes false and this
            // loop just quietly stops touching Google until reconnected.
            // What it can't do on its own is tell the user *why* sync
            // stopped, since nothing else is watching this background
            // thread — that's what the notification is for.
            //
            // Held for the whole call (not just around individual DB
            // statements) so a concurrent `sync_now` can't interleave its own
            // read-network-write cycle with this one — see SyncTrigger's docs.
            let sync_result = {
                let _guard = thread_run_lock.lock().unwrap_or_else(|e| e.into_inner());
                run_sync(&conn)
            };
            if let Err(e) = sync_result {
                if e == oauth::RECONNECT_REQUIRED {
                    crate::notifications::notify(
                        &app,
                        "Reconnect Google",
                        "Schedu needs you to sign in to Google again to keep syncing. Open Settings → Google and choose Reconnect Google.",
                    );
                }
            }

            let interval_minutes: u64 = get_pref(&conn, "sync_interval_minutes")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5);
            let interval = Duration::from_secs(interval_minutes * 60).max(SYNC_INTERVAL_FLOOR);
            // Waking up on a trigger drains any extra pending signals first
            // (several deletes fired in quick succession shouldn't queue up
            // that many extra sync cycles back to back) then loops straight
            // into another run_sync rather than sleeping out the rest of the
            // interval. A closed channel (should only happen at app
            // shutdown) falls back to a plain sleep instead of busy-looping.
            match rx.recv_timeout(interval) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => while rx.try_recv().is_ok() {},
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    std::thread::sleep(interval);
                }
            }
        }
    });

    let debouncer_run_lock = Arc::clone(&run_lock);
    let (debounce_tx, debounce_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let conn = match crate::db::init(&debouncer_db_path) {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut pending: HashMap<String, Instant> = HashMap::new();
        loop {
            let wait = pending
                .values()
                .min()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(3600));
            match debounce_rx.recv_timeout(wait) {
                Ok(item_id) => {
                    // (Re)schedule — an edit that lands before a pending
                    // item's deadline elapses pushes that deadline forward,
                    // which is exactly "reset the debounce timer."
                    pending.insert(item_id, Instant::now() + PUSH_DEBOUNCE);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            let now_instant = Instant::now();
            let due: Vec<String> = pending
                .iter()
                .filter(|(_, deadline)| **deadline <= now_instant)
                .map(|(id, _)| id.clone())
                .collect();
            for item_id in due {
                pending.remove(&item_id);
                let _guard = debouncer_run_lock.lock().unwrap_or_else(|e| e.into_inner());
                // A stale/expired token or no connection at all just skips
                // this item for now — it stays dirty (updated_at still ahead
                // of last_synced_at_*) so the next periodic sync or manual
                // "Sync Now"/"Retry Sync" picks it up. The background loop's
                // own reconnect notification already covers the "why."
                if let Ok(access_token) = oauth::get_valid_access_token(&conn) {
                    let _ = push_item_by_id(&conn, &access_token, &item_id);
                }
            }
        }
    });

    (
        SyncTrigger {
            tx: Mutex::new(tx),
            run_lock,
        },
        PushDebouncer {
            tx: Mutex::new(debounce_tx),
        },
    )
}
