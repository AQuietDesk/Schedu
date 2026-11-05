use super::{api, oauth, sync};
use crate::db::{self, DbPathState};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

fn open_conn(state: &State<DbPathState>) -> Result<rusqlite::Connection, String> {
    db::init(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_upcoming_calendar_events(
    state: State<DbPathState>,
) -> Result<Vec<api::CalendarEvent>, String> {
    let conn = open_conn(&state)?;
    let access_token = oauth::get_valid_access_token(&conn)?;
    api::list_upcoming_events(&access_token, 10)
}

#[tauri::command]
pub fn list_upcoming_google_tasks(state: State<DbPathState>) -> Result<Vec<api::Task>, String> {
    let conn = open_conn(&state)?;
    let access_token = oauth::get_valid_access_token(&conn)?;
    api::list_upcoming_tasks(&access_token, 10)
}

#[tauri::command]
pub fn list_calendar_events_in_range(
    state: State<DbPathState>,
    calendar_id: String,
    time_min: String,
    time_max: String,
) -> Result<Vec<api::CalendarEvent>, String> {
    let conn = open_conn(&state)?;
    let access_token = oauth::get_valid_access_token(&conn)?;
    api::list_events_in_range(&access_token, &calendar_id, &time_min, &time_max)
}

#[tauri::command]
pub fn list_calendars(state: State<DbPathState>) -> Result<Vec<api::CalendarListEntry>, String> {
    let conn = open_conn(&state)?;
    let access_token = oauth::get_valid_access_token(&conn)?;
    api::list_calendars(&access_token)
}

#[derive(Debug, Serialize)]
pub struct SyncConflict {
    pub id: String,
    pub item_id: String,
    pub source: String,
    pub local_snapshot: serde_json::Value,
    pub remote_snapshot: serde_json::Value,
    /// Only the fields the two snapshots actually disagree on, computed
    /// server-side (`sync::diff_snapshots`) so the frontend never needs its
    /// own copy of "what does Calendar vs Tasks actually support" — see
    /// Phase 2's "only display fields that differ."
    pub diff: Vec<sync::SnapshotFieldDiff>,
    pub created_at: String,
}

/// Per-item sync state for the items list (Phase 4/6) — kept as its own
/// lightweight command rather than a field on `Item` itself, since `Item` is
/// also the shape `update_item` deserializes from the frontend and a derived
/// (non-persisted) status has no business round-tripping through a save.
#[derive(Debug, Serialize)]
pub struct ItemSyncStatus {
    pub item_id: String,
    pub status: sync::SyncStatus,
    pub last_sync_error: Option<String>,
}

#[tauri::command]
pub fn list_item_sync_statuses(state: State<DbPathState>) -> Result<Vec<ItemSyncStatus>, String> {
    let conn = open_conn(&state)?;
    let mut item_stmt = conn
        .prepare(&format!(
            "SELECT {} FROM item WHERE deleted_at IS NULL",
            crate::commands::ITEM_COLUMNS
        ))
        .map_err(|e| e.to_string())?;
    let items: Vec<crate::models::Item> = item_stmt
        .query_map([], crate::commands::row_to_item)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut conflict_stmt = conn
        .prepare("SELECT DISTINCT item_id FROM sync_conflict")
        .map_err(|e| e.to_string())?;
    let conflicted: std::collections::HashSet<String> = conflict_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(items
        .into_iter()
        .map(|item| {
            let status = sync::derive_sync_status(&item, conflicted.contains(&item.id));
            ItemSyncStatus {
                item_id: item.id.clone(),
                status,
                last_sync_error: item.last_sync_error.clone(),
            }
        })
        .collect())
}

#[tauri::command]
pub fn is_google_connected(state: State<DbPathState>) -> Result<bool, String> {
    let conn = open_conn(&state)?;
    Ok(oauth::is_connected(&conn))
}

/// Blocks for up to ~3 minutes waiting on the browser sign-in — deliberately
/// opens its own connection (see oauth::run_installed_app_flow's doc comment)
/// rather than touching the shared DbState mutex used by the rest of the app.
#[tauri::command]
pub fn connect_google(state: State<DbPathState>) -> Result<(), String> {
    let tokens = oauth::run_installed_app_flow()?;
    let conn = open_conn(&state)?;
    oauth::store_tokens(&conn, &tokens);
    Ok(())
}

#[tauri::command]
pub fn disconnect_google(state: State<DbPathState>) -> Result<(), String> {
    let conn = open_conn(&state)?;
    oauth::disconnect(&conn);
    Ok(())
}

/// Routed through `SyncTrigger::run_sync_exclusive` rather than calling
/// `sync::run_sync` directly — see that method's docs for why: without it,
/// this could interleave with the background loop's own tick and both would
/// end up pushing the same not-yet-linked item, creating a duplicate Google
/// Calendar event or Task.
#[tauri::command]
pub fn sync_now(state: State<DbPathState>, sync_trigger: State<sync::SyncTrigger>) -> Result<(), String> {
    let conn = open_conn(&state)?;
    sync_trigger.run_sync_exclusive(&conn)
}

/// Per-item "Push to Google" / "Retry Sync" (Phase 5) — pushes exactly this
/// item instead of running a whole-app sync. Routed through the same
/// `run_lock` as `sync_now`/the background loop/the debouncer for the same
/// duplicate-push reason documented on `SyncTrigger`.
#[tauri::command]
pub fn push_item_now(
    state: State<DbPathState>,
    sync_trigger: State<sync::SyncTrigger>,
    item_id: String,
) -> Result<(), String> {
    let conn = open_conn(&state)?;
    let access_token = oauth::get_valid_access_token(&conn)?;
    sync_trigger.run_exclusive(|| sync::push_item_by_id(&conn, &access_token, &item_id))
}

#[tauri::command]
pub fn list_sync_conflicts(state: State<DbPathState>) -> Result<Vec<SyncConflict>, String> {
    let conn = open_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, item_id, source, local_snapshot, remote_snapshot, created_at \
             FROM sync_conflict ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let local_snapshot_text: String = row.get(3)?;
            let remote_snapshot_text: String = row.get(4)?;
            let local: sync::SyncSnapshot =
                serde_json::from_str(&local_snapshot_text).unwrap_or_default();
            let remote: sync::SyncSnapshot =
                serde_json::from_str(&remote_snapshot_text).unwrap_or_default();
            let diff = sync::diff_snapshots(&local, &remote);
            Ok(SyncConflict {
                id: row.get(0)?,
                item_id: row.get(1)?,
                source: row.get(2)?,
                local_snapshot: serde_json::from_str(&local_snapshot_text)
                    .unwrap_or(serde_json::Value::Null),
                remote_snapshot: serde_json::from_str(&remote_snapshot_text)
                    .unwrap_or(serde_json::Value::Null),
                diff,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// `resolution` is `"mine"` (discard the remote snapshot; the next push cycle
/// sends the local version, since it's already newer than last_synced_at — that
/// was the whole reason this was a conflict), `"google"` (apply the remote
/// snapshot's fields to the local Item), or `"dismiss"` (change neither side —
/// just stop flagging this specific divergence by advancing last_synced_at to
/// now, so a *future* change on either side will surface normally).
#[tauri::command]
pub fn resolve_conflict(
    state: State<DbPathState>,
    id: String,
    resolution: String,
) -> Result<(), String> {
    let conn = open_conn(&state)?;

    let (item_id, source, remote_snapshot_text): (String, String, String) = conn
        .query_row(
            "SELECT item_id, source, remote_snapshot FROM sync_conflict WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    if resolution == "google" {
        // Full restore of every field the remote source has an opinion on —
        // not just title/due_date/status (Phase 2's "Keep Google's must
        // restore the complete supported remote state" requirement).
        let remote: sync::SyncSnapshot =
            serde_json::from_str(&remote_snapshot_text).unwrap_or_default();
        let item: crate::models::Item = conn
            .query_row(
                &format!(
                    "SELECT {} FROM item WHERE id = ?1",
                    crate::commands::ITEM_COLUMNS
                ),
                params![item_id],
                crate::commands::row_to_item,
            )
            .map_err(|e| e.to_string())?;
        let resolved = sync::apply_remote_snapshot_to_item(&item, &remote);

        // Only the conflict's own source channel's last_synced_at advances —
        // the other channel's timeline is untouched (see db.rs / sync.rs).
        let last_synced_column = if source == "calendar" {
            "last_synced_at_calendar"
        } else {
            "last_synced_at_tasks"
        };
        let ts = crate::commands::now();
        let _ = conn.execute(
            &format!(
                "UPDATE item SET title = ?2, notes = ?3, due_date = ?4, due_time = ?5, \
                 status = ?6, location = ?7, estimated_duration = ?8, updated_at = ?9, \
                 {last_synced_column} = ?9 WHERE id = ?1"
            ),
            params![
                item_id,
                resolved.title,
                resolved.notes,
                resolved.due_date,
                resolved.due_time,
                resolved.status,
                resolved.location,
                resolved.estimated_duration,
                ts,
            ],
        );
    } else if resolution == "dismiss" {
        let last_synced_column = if source == "calendar" {
            "last_synced_at_calendar"
        } else {
            "last_synced_at_tasks"
        };
        let ts = crate::commands::now();
        let _ = conn.execute(
            &format!("UPDATE item SET {last_synced_column} = ?2 WHERE id = ?1"),
            params![item_id, ts],
        );
    } else if resolution == "mine" {
        // Push the local copy to Google right now instead of leaving it to
        // "the next push cycle": last_synced_at for this channel is stale
        // (that's why this was flagged), so if we only deleted the conflict
        // row, the very next pull would see the exact same stale cursor and
        // recreate this conflict immediately, before push_items ever ran.
        let access_token = oauth::get_valid_access_token(&conn)?;
        let item: crate::models::Item = conn
            .query_row(
                &format!(
                    "SELECT {} FROM item WHERE id = ?1",
                    crate::commands::ITEM_COLUMNS
                ),
                params![item_id],
                crate::commands::row_to_item,
            )
            .map_err(|e| e.to_string())?;
        let ts = crate::commands::now();

        if source == "calendar" {
            let due_date = item
                .due_date
                .as_ref()
                .ok_or("Item has no due_date to push as a calendar event")?;
            let body = api::event_body(
                &item.title,
                item.notes.as_deref(),
                due_date,
                item.due_time.as_deref(),
                item.estimated_duration,
                item.location.as_deref(),
            );
            let event = match &item.google_calendar_id {
                Some(gid) => api::update_event(&access_token, gid, &body),
                None => api::create_event(&access_token, &body),
            }?;
            conn.execute(
                "UPDATE item SET google_calendar_id = ?2, last_synced_at_calendar = ?3 WHERE id = ?1",
                params![item_id, event.id, ts],
            )
            .map_err(|e| e.to_string())?;
        } else {
            let body = api::task_body(
                &item.title,
                item.notes.as_deref(),
                item.due_date.as_deref(),
                item.status == "Completed",
            );
            let task = match &item.google_task_id {
                Some(gid) => api::update_task(&access_token, gid, &body),
                None => api::create_task(&access_token, &body),
            }?;
            conn.execute(
                "UPDATE item SET google_task_id = ?2, last_synced_at_tasks = ?3 WHERE id = ?1",
                params![item_id, task.id, ts],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    conn.execute("DELETE FROM sync_conflict WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
