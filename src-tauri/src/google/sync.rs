use super::api::{self, CalendarEvent, Task};
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
    if calendar_push_needed(item) || task_push_needed(item) {
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

/// Google Calendar has no concept of an Item's completion `status` (an
/// event's own `status` field means confirmed/tentative/cancelled, not
/// done/not-done) and no `priority` — both are left `None` here rather than
/// mapped to something misleading.
fn calendar_remote_snapshot(event: &CalendarEvent) -> SyncSnapshot {
    let (due_date, due_time) = calendar_due_date_time(event);
    SyncSnapshot {
        title: event.summary.clone(),
        notes: event.description.clone(),
        due_date,
        due_time,
        status: None,
        priority: None,
        estimated_duration: calendar_estimated_duration(event),
        location: event.location.clone(),
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

fn calendar_due_date_time(event: &CalendarEvent) -> (Option<String>, Option<String>) {
    match &event.start {
        Some(s) if s.date_time.is_some() => {
            let dt = s.date_time.clone().unwrap();
            let mut parts = dt.splitn(2, 'T');
            let date = parts.next().unwrap_or_default().to_string();
            let time = parts
                .next()
                .map(|t| t.chars().take(5).collect::<String>())
                .unwrap_or_default();
            (Some(date), Some(time))
        }
        Some(s) if s.date.is_some() => (s.date.clone(), None),
        _ => (None, None),
    }
}

/// Derives an Item's `estimated_duration` (minutes) from a timed event's
/// start/end — the pull-side mirror of `api::event_body`'s push-side
/// duration → end-time math. `None` for an all-day event (no time component
/// to measure) or a malformed pair, so the caller falls back to preserving
/// whatever the Item already had rather than clobbering it with a guess.
fn calendar_estimated_duration(event: &CalendarEvent) -> Option<i64> {
    let start = event.start.as_ref()?.date_time.as_deref()?;
    let end = event.end.as_ref()?.date_time.as_deref()?;
    let start_dt = DateTime::parse_from_rfc3339(start).ok()?;
    let end_dt = DateTime::parse_from_rfc3339(end).ok()?;
    let minutes = (end_dt - start_dt).num_minutes();
    if minutes > 0 {
        Some(minutes)
    } else {
        None
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
    fn calendar_remote_snapshot_omits_status_and_priority() {
        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()),
            description: Some("Prepare financial analysis and send to team".into()),
            location: Some("Room 100".into()),
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("confirmed".into()),
            start: None,
            end: None,
            color_id: None,
        };
        let snap = calendar_remote_snapshot(&event);
        assert_eq!(snap.status, None, "Calendar has no completion-status concept");
        assert_eq!(snap.priority, None, "Calendar has no priority field");
        assert_eq!(
            snap.notes.as_deref(),
            Some("Prepare financial analysis and send to team")
        );
        assert_eq!(snap.location.as_deref(), Some("Room 100"));
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
        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()), // same as local — no diff
            description: Some("Prepare financial analysis and send to team".into()), // differs
            location: Some("Room 100".into()),        // differs
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("confirmed".into()),
            start: None,
            end: None,
            color_id: None,
        };
        let remote = calendar_remote_snapshot(&event);
        let diffs = diff_snapshots(&local, &remote);
        let fields: Vec<&str> = diffs.iter().map(|d| d.field).collect();
        assert!(fields.contains(&"Notes"));
        assert!(fields.contains(&"Location"));
        assert!(!fields.contains(&"Title"), "title matches, shouldn't be reported");
        assert!(!fields.contains(&"Status"), "calendar can't compare status");
        assert!(!fields.contains(&"Due date"), "remote had no start, nothing to compare");
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
        // A Calendar event with no description in the JSON payload (key
        // omitted) must never be mistaken for "the user cleared their notes."
        let item = sample_item();
        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()),
            description: None, // omitted by Google
            location: None,    // omitted by Google
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("confirmed".into()),
            start: None,
            end: None,
            color_id: None,
        };
        let remote = calendar_remote_snapshot(&event);
        let resolved = apply_remote_snapshot_to_item(&item, &remote);
        assert_eq!(resolved.notes, item.notes, "absent description must not clear local notes");
        assert_eq!(resolved.location, item.location, "absent location must not clear local location");
    }

    #[test]
    fn remote_field_explicitly_cleared_to_empty_string_does_clear_local() {
        // Distinct from the above: Google *did* include the key, with an
        // empty value — that's a real explicit clear, not an omission.
        let item = sample_item();
        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()),
            description: Some("".into()),
            location: Some("".into()),
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("confirmed".into()),
            start: None,
            end: None,
            color_id: None,
        };
        let remote = calendar_remote_snapshot(&event);
        let resolved = apply_remote_snapshot_to_item(&item, &remote);
        assert_eq!(resolved.notes.as_deref(), Some(""));
        assert_eq!(resolved.location.as_deref(), Some(""));
    }

    #[test]
    fn calendar_estimated_duration_derives_minutes_from_timed_event() {
        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: None,
            description: None,
            location: None,
            updated: None,
            status: None,
            start: Some(super::super::api::EventDateTime {
                date: None,
                date_time: Some("2026-03-05T14:00:00-07:00".into()),
            }),
            end: Some(super::super::api::EventDateTime {
                date: None,
                date_time: Some("2026-03-05T14:45:00-07:00".into()),
            }),
            color_id: None,
        };
        assert_eq!(calendar_estimated_duration(&event), Some(45));
    }

    #[test]
    fn calendar_estimated_duration_is_none_for_all_day_event() {
        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: None,
            description: None,
            location: None,
            updated: None,
            status: None,
            start: Some(super::super::api::EventDateTime {
                date: Some("2026-03-05".into()),
                date_time: None,
            }),
            end: Some(super::super::api::EventDateTime {
                date: Some("2026-03-06".into()),
                date_time: None,
            }),
            color_id: None,
        };
        assert_eq!(calendar_estimated_duration(&event), None);
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
    fn calendar_push_not_needed_for_unlinked_item() {
        let mut item = sample_item();
        item.google_calendar_id = None;
        item.last_synced_at_calendar = None;
        assert!(!calendar_push_needed(&item));
    }

    #[test]
    fn calendar_push_not_needed_without_due_date() {
        let mut item = sample_item();
        item.due_date = None;
        item.last_synced_at_calendar = None;
        assert!(!calendar_push_needed(&item));
    }

    #[test]
    fn push_not_needed_once_last_synced_at_is_after_updated_at() {
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into();
        item.last_synced_at_calendar = Some("2026-03-02T00:00:00Z".into());
        item.last_synced_at_tasks = Some("2026-03-02T00:00:00Z".into());
        assert!(!calendar_push_needed(&item));
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
        let msg = friendly_push_error("calendar", "HTTP status client error (404 Not Found) for url ...");
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
    fn apply_remote_calendar_event_round_trips_notes_and_location_on_pull() {
        let conn = temp_conn();
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into(); // unchanged locally since last sync
        item.last_synced_at_calendar = Some("2026-03-01T00:00:00Z".into());
        insert_test_item(&conn, &item);

        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()),
            description: Some("Updated from Google".into()),
            location: Some("Conference Room B".into()),
            updated: Some("2026-03-02T00:00:00Z".into()), // after last_synced_at_calendar
            status: Some("confirmed".into()),
            start: Some(super::super::api::EventDateTime {
                date: None,
                date_time: Some("2026-03-05T14:00:00-07:00".into()),
            }),
            end: Some(super::super::api::EventDateTime {
                date: None,
                date_time: Some("2026-03-05T14:45:00-07:00".into()),
            }),
            color_id: None,
        };

        apply_remote_calendar_event(&conn, &event);

        let updated = find_item_by_id(&conn, "item-1").expect("item still present");
        assert_eq!(updated.notes.as_deref(), Some("Updated from Google"));
        assert_eq!(updated.location.as_deref(), Some("Conference Room B"));
        assert_eq!(updated.estimated_duration, Some(45));
        assert!(updated.last_synced_at_calendar.is_some());
    }

    #[test]
    fn apply_remote_calendar_event_never_erases_notes_when_google_omits_description() {
        let conn = temp_conn();
        let mut item = sample_item();
        item.updated_at = "2026-03-01T00:00:00Z".into();
        item.last_synced_at_calendar = Some("2026-03-01T00:00:00Z".into());
        insert_test_item(&conn, &item);

        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()),
            description: None, // omitted, not cleared
            location: None,
            updated: Some("2026-03-02T00:00:00Z".into()),
            status: Some("confirmed".into()),
            start: None,
            end: None,
            color_id: None,
        };

        apply_remote_calendar_event(&conn, &event);

        let updated = find_item_by_id(&conn, "item-1").expect("item still present");
        assert_eq!(updated.notes, item.notes, "notes must survive an omitted description");
        assert_eq!(updated.location, item.location, "location must survive an omitted location");
    }

    #[test]
    fn apply_remote_calendar_event_records_full_snapshot_conflict_when_both_sides_changed() {
        let conn = temp_conn();
        let mut item = sample_item();
        item.updated_at = "2026-03-03T00:00:00Z".into(); // changed locally after last sync
        item.last_synced_at_calendar = Some("2026-03-01T00:00:00Z".into());
        insert_test_item(&conn, &item);

        let event = CalendarEvent {
            id: "evt-1".into(),
            summary: Some("Finish analysis".into()),
            description: Some("Prepare financial analysis and send to team".into()),
            location: Some("Room 100".into()),
            updated: Some("2026-03-02T00:00:00Z".into()), // also changed after last sync
            status: Some("confirmed".into()),
            start: None,
            end: None,
            color_id: None,
        };

        apply_remote_calendar_event(&conn, &event);

        assert!(item_has_open_conflict(&conn, "item-1"));
        let (local_text, remote_text): (String, String) = conn
            .query_row(
                "SELECT local_snapshot, remote_snapshot FROM sync_conflict WHERE item_id = 'item-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let local: SyncSnapshot = serde_json::from_str(&local_text).unwrap();
        let remote: SyncSnapshot = serde_json::from_str(&remote_text).unwrap();
        assert_eq!(local.priority.as_deref(), Some("High"), "local snapshot keeps full field set");
        assert_eq!(remote.notes.as_deref(), Some("Prepare financial analysis and send to team"));
        assert_eq!(remote.location.as_deref(), Some("Room 100"));
        assert_eq!(remote.priority, None, "calendar source has no priority to report");
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
        record_conflict(&conn, &item, "calendar", &SyncSnapshot::default());

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
         AND (google_calendar_id IS NOT NULL OR google_task_id IS NOT NULL)"
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

fn pull_calendar(conn: &Connection, access_token: &str) -> Result<(), String> {
    let stored_token = get_pref(conn, "google_calendar_sync_token");
    let (events, next_sync_token) = match api::list_events(access_token, stored_token.as_deref()) {
        Ok(res) => res,
        Err(e) if e == "SYNC_TOKEN_INVALID" => api::list_events(access_token, None)?,
        Err(e) => return Err(e),
    };

    for event in events {
        apply_remote_calendar_event(conn, &event);
    }

    if let Some(token) = next_sync_token {
        set_pref(conn, "google_calendar_sync_token", &token);
    }
    Ok(())
}

fn apply_remote_calendar_event(conn: &Connection, event: &CalendarEvent) {
    let Some(item) = find_item_by_column(conn, "google_calendar_id", &event.id) else {
        return; // Not one of ours (or already purged) — out of scope, see sync.rs docs.
    };
    let Some(remote_updated_at) = event.updated.as_deref().and_then(parse_rfc3339) else {
        return;
    };
    let last_synced_at = item
        .last_synced_at_calendar
        .as_deref()
        .and_then(parse_rfc3339);
    let local_updated_at = match parse_rfc3339(&item.updated_at) {
        Some(t) => t,
        None => return,
    };

    match decide_pull_action(local_updated_at, remote_updated_at, last_synced_at) {
        PullDecision::NoOp => {}
        PullDecision::Conflict => {
            let remote = calendar_remote_snapshot(event);
            record_conflict(conn, &item, "calendar", &remote);
        }
        PullDecision::ApplyRemote => {
            if event.status.as_deref() == Some("cancelled") {
                // deliberately doesn't touch updated_at — see the comment below.
                let _ = conn.execute(
                    "UPDATE item SET deleted_at = ?2, last_synced_at_calendar = ?2 WHERE id = ?1",
                    params![item.id, now()],
                );
                return;
            }
            let remote = calendar_remote_snapshot(event);
            let resolved = apply_remote_snapshot_to_item(&item, &remote);
            let ts = now();
            // Deliberately does NOT bump `updated_at`: that column is read
            // elsewhere as "did the user locally edit this" (both by
            // apply_remote_task's own conflict check and by push_items'
            // needs_*_push gate). A calendar-only field sync isn't a local
            // edit, and bumping updated_at here previously caused a routine,
            // content-free calendar re-apply (e.g. right after item creation,
            // before the sync token had caught up) to make a genuinely
            // slightly-earlier Tasks-side change look like a same-cycle local
            // edit — turning a clean ApplyRemote into a false Conflict. Only
            // last_synced_at_calendar advances here.
            let _ = conn.execute(
                "UPDATE item SET title = ?2, notes = ?3, due_date = ?4, due_time = ?5, \
                 location = ?6, estimated_duration = ?7, last_synced_at_calendar = ?8 WHERE id = ?1",
                params![
                    item.id,
                    resolved.title,
                    resolved.notes,
                    resolved.due_date,
                    resolved.due_time,
                    resolved.location,
                    resolved.estimated_duration,
                    ts,
                ],
            );
        }
    }
}

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

/// Pure dirty-state check reused everywhere a decision to push is made (the
/// full sweep, the debounced single-item push, and the manual "Push
/// Now"/"Retry Sync" command) — see PHASE 1's "reuse the existing dirty
/// mechanism" requirement. Items mirror to Google Tasks only (which already
/// shows on Google Calendar via "My Tasks"), so no new Calendar events are
/// created. An Item that was linked to a Calendar event before that change
/// keeps that existing event up to date, as long as it has a due_date.
fn calendar_push_needed(item: &Item) -> bool {
    let Some(local_updated_at) = parse_rfc3339(&item.updated_at) else {
        return false;
    };
    item.google_calendar_id.is_some()
        && item.due_date.is_some()
        && match item
            .last_synced_at_calendar
            .as_deref()
            .and_then(parse_rfc3339)
        {
            Some(ts) => local_updated_at > ts,
            None => true,
        }
}

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
    let needs_calendar_push = calendar_push_needed(item);
    let needs_task_push = task_push_needed(item);
    if !needs_calendar_push && !needs_task_push {
        return;
    }

    let mut new_calendar_id = item.google_calendar_id.clone();
    let mut new_task_id = item.google_task_id.clone();
    let mut calendar_result: Option<Result<(), String>> = None;
    let mut task_result: Option<Result<(), String>> = None;

    if needs_calendar_push {
        if let Some(due_date) = &item.due_date {
            let body = api::event_body(
                &item.title,
                item.notes.as_deref(),
                due_date,
                item.due_time.as_deref(),
                item.estimated_duration,
                item.location.as_deref(),
            );
            let result = match &item.google_calendar_id {
                Some(id) => api::update_event(access_token, id, &body),
                None => api::create_event(access_token, &body),
            };
            match result {
                Ok(event) => {
                    new_calendar_id = Some(event.id);
                    calendar_result = Some(Ok(()));
                    log_push(item, "calendar", "update", "success", None);
                }
                // A 404 on an *update* (never on a create) means the remote
                // event was deleted directly in Google Calendar. The app's
                // own pull-side precedent for that (apply_remote_calendar_event's
                // "cancelled" handling) is "the whole Item is gone" — not
                // "silently make a fresh replacement event" — so mirror that
                // here rather than inventing a second, inconsistent policy
                // for the same real-world event (Phase 6: "respect existing
                // semantics... do not blindly recreate").
                Err(e) if item.google_calendar_id.is_some() && is_not_found_error(&e) => {
                    log_push(item, "calendar", "update", "deleted_remotely", Some(&e));
                    mark_item_deleted_locally(conn, &item.id);
                    return;
                }
                Err(e) => {
                    log_push(item, "calendar", "update", "failed", Some(&e));
                    calendar_result = Some(Err(e));
                }
            }
        }
    }

    if needs_task_push {
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
        match result {
            Ok(task) => {
                new_task_id = Some(task.id);
                task_result = Some(Ok(()));
                log_push(item, "tasks", "update", "success", None);
            }
            // Same reasoning as the calendar branch above, mirroring
            // apply_remote_task's `task.deleted` handling instead. The
            // calendar branch may have already succeeded this same call
            // (e.g. created a brand new event) — persist that before
            // returning, or a task-side 404 here would silently drop a
            // freshly-created google_calendar_id and orphan a duplicate on
            // the next cycle.
            Err(e) if item.google_task_id.is_some() && is_not_found_error(&e) => {
                log_push(item, "tasks", "update", "deleted_remotely", Some(&e));
                if calendar_result == Some(Ok(())) {
                    let ts = now();
                    let _ = conn.execute(
                        "UPDATE item SET google_calendar_id = ?2, last_synced_at_calendar = ?3 WHERE id = ?1",
                        params![item.id, new_calendar_id, ts],
                    );
                }
                mark_item_deleted_locally(conn, &item.id);
                return;
            }
            Err(e) => {
                log_push(item, "tasks", "update", "failed", Some(&e));
                task_result = Some(Err(e));
            }
        }
    }

    // Persist whichever id(s) did succeed either way, but only advance each
    // channel's own last_synced_at when that channel's push actually
    // succeeded — a failed push must keep retrying next cycle, and a channel
    // that wasn't attempted this cycle must not have its timestamp touched.
    let ts = now();
    let _ = conn.execute(
        "UPDATE item SET google_calendar_id = ?2, google_task_id = ?3 WHERE id = ?1",
        params![item.id, new_calendar_id, new_task_id],
    );
    if let Some(Ok(())) = calendar_result {
        let _ = conn.execute(
            "UPDATE item SET last_synced_at_calendar = ?2 WHERE id = ?1",
            params![item.id, ts],
        );
    }
    if let Some(Ok(())) = task_result {
        let _ = conn.execute(
            "UPDATE item SET last_synced_at_tasks = ?2 WHERE id = ?1",
            params![item.id, ts],
        );
    }

    let mut errors: Vec<String> = Vec::new();
    if let Some(Err(e)) = &calendar_result {
        errors.push(friendly_push_error("calendar", e));
    }
    if let Some(Err(e)) = &task_result {
        errors.push(friendly_push_error("tasks", e));
    }

    if errors.is_empty() {
        let _ = conn.execute(
            "UPDATE item SET last_sync_error = NULL, sync_failure_count = 0, last_sync_attempted_at = ?2 WHERE id = ?1",
            params![item.id, ts],
        );
    } else {
        let message = errors.join(" ");
        let _ = conn.execute(
            "UPDATE item SET last_sync_error = ?2, sync_failure_count = sync_failure_count + 1, \
             last_sync_attempted_at = ?3 WHERE id = ?1",
            params![item.id, message, ts],
        );
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
        let mut ok = true;
        if let Some(id) = &item.google_calendar_id {
            ok &= api::delete_event(access_token, id).is_ok();
        }
        if let Some(id) = &item.google_task_id {
            ok &= api::delete_task(access_token, id).is_ok();
        }
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

    pull_calendar(conn, &access_token)?;
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
