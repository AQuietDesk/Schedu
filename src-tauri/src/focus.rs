use crate::commands::{now, touch_activity};
use crate::db::DbState;
use crate::models::{FocusSession, StartFocusSessionInput};
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;
use uuid::Uuid;

const FOCUS_SESSION_COLUMNS: &str =
    "id, intent, goal, item_id, category, planned_duration_seconds, \
     break_duration_seconds, phase, running_since, accumulated_seconds, started_at, ended_at, \
     actual_duration_seconds, session_state, outcome, reflection_note, created_at";

fn row_to_focus_session(row: &Row) -> rusqlite::Result<FocusSession> {
    Ok(FocusSession {
        id: row.get("id")?,
        intent: row.get("intent")?,
        goal: row.get("goal")?,
        item_id: row.get("item_id")?,
        category: row.get("category")?,
        planned_duration_seconds: row.get("planned_duration_seconds")?,
        break_duration_seconds: row.get("break_duration_seconds")?,
        phase: row.get("phase")?,
        running_since: row.get("running_since")?,
        accumulated_seconds: row.get("accumulated_seconds")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        actual_duration_seconds: row.get("actual_duration_seconds")?,
        session_state: row.get("session_state")?,
        outcome: row.get("outcome")?,
        reflection_note: row.get("reflection_note")?,
        created_at: row.get("created_at")?,
    })
}

fn fetch_focus_session(conn: &Connection, id: &str) -> Result<FocusSession, String> {
    conn.query_row(
        &format!("SELECT {FOCUS_SESSION_COLUMNS} FROM focus_session WHERE id = ?1"),
        params![id],
        row_to_focus_session,
    )
    .map_err(|e| e.to_string())
}

/// Whole seconds between two RFC3339 timestamps, floored at 0 so clock skew
/// or a same-instant read/write pair never produces a negative elapsed value.
fn seconds_between(earlier: &str, later: &str) -> Result<i64, String> {
    let earlier = chrono::DateTime::parse_from_rfc3339(earlier).map_err(|e| e.to_string())?;
    let later = chrono::DateTime::parse_from_rfc3339(later).map_err(|e| e.to_string())?;
    Ok((later - earlier).num_seconds().max(0))
}

/// Elapsed seconds for whichever phase is currently running, whether the
/// session is actively ticking or sitting paused — the single source of
/// truth `pause`/`complete_focus_phase`/`abandon` all freeze against.
fn current_elapsed(session: &FocusSession, at: &str) -> Result<i64, String> {
    let extra = match &session.running_since {
        Some(running_since) => seconds_between(running_since, at)?,
        None => 0,
    };
    Ok(session.accumulated_seconds + extra)
}

fn start_focus_session_impl(
    conn: &Connection,
    input: StartFocusSessionInput,
) -> Result<FocusSession, String> {
    let ts = now();
    let session = FocusSession {
        id: Uuid::new_v4().to_string(),
        intent: input.intent,
        goal: input.goal,
        item_id: input.item_id,
        category: input.category,
        planned_duration_seconds: input.planned_duration_seconds,
        break_duration_seconds: input.break_duration_seconds,
        phase: "focus".to_string(),
        running_since: Some(ts.clone()),
        accumulated_seconds: 0,
        started_at: ts.clone(),
        ended_at: None,
        actual_duration_seconds: None,
        session_state: "active".to_string(),
        outcome: None,
        reflection_note: None,
        created_at: ts,
    };
    conn.execute(
        &format!(
            "INSERT INTO focus_session ({FOCUS_SESSION_COLUMNS}) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)"
        ),
        params![
            session.id,
            session.intent,
            session.goal,
            session.item_id,
            session.category,
            session.planned_duration_seconds,
            session.break_duration_seconds,
            session.phase,
            session.running_since,
            session.accumulated_seconds,
            session.started_at,
            session.ended_at,
            session.actual_duration_seconds,
            session.session_state,
            session.outcome,
            session.reflection_note,
            session.created_at,
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            "A focus session is already active".to_string()
        } else {
            e.to_string()
        }
    })?;
    touch_activity(conn);
    Ok(session)
}

fn get_active_focus_session_impl(conn: &Connection) -> Result<Option<FocusSession>, String> {
    conn.query_row(
        &format!(
            "SELECT {FOCUS_SESSION_COLUMNS} FROM focus_session WHERE session_state = 'active'"
        ),
        [],
        row_to_focus_session,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn pause_focus_session_impl(conn: &Connection, id: &str) -> Result<FocusSession, String> {
    let session = fetch_focus_session(conn, id)?;
    if let Some(running_since) = &session.running_since {
        let elapsed = seconds_between(running_since, &now())?;
        conn.execute(
            "UPDATE focus_session SET accumulated_seconds = accumulated_seconds + ?1, running_since = NULL \
             WHERE id = ?2",
            params![elapsed, id],
        )
        .map_err(|e| e.to_string())?;
        touch_activity(conn);
    }
    fetch_focus_session(conn, id)
}

fn resume_focus_session_impl(conn: &Connection, id: &str) -> Result<FocusSession, String> {
    let session = fetch_focus_session(conn, id)?;
    if session.running_since.is_none() {
        conn.execute(
            "UPDATE focus_session SET running_since = ?1 WHERE id = ?2",
            params![now(), id],
        )
        .map_err(|e| e.to_string())?;
        touch_activity(conn);
    }
    fetch_focus_session(conn, id)
}

/// Called when the focus countdown naturally reaches zero, or the user hits
/// Finish on an Open Focus session. Freezes the focus portion's elapsed time
/// as `actual_duration_seconds`, defaults `outcome` to 'completed' (so
/// history looks sane even if the reflection prompt is dismissed unanswered
/// — see `submit_reflection`), and flips the row into its own break
/// countdown rather than closing it — the session stays 'active' through the
/// break so a reload mid-break still rehydrates correctly.
fn complete_focus_phase_impl(conn: &Connection, id: &str) -> Result<FocusSession, String> {
    let session = fetch_focus_session(conn, id)?;
    let ts = now();
    let final_elapsed = current_elapsed(&session, &ts)?;
    conn.execute(
        "UPDATE focus_session SET actual_duration_seconds = ?1, ended_at = ?2, outcome = 'completed', \
         phase = 'break', running_since = ?2, accumulated_seconds = 0 WHERE id = ?3",
        params![final_elapsed, ts, id],
    )
    .map_err(|e| e.to_string())?;
    touch_activity(conn);
    fetch_focus_session(conn, id)
}

fn submit_reflection_impl(
    conn: &Connection,
    id: &str,
    outcome: &str,
    note: Option<String>,
) -> Result<FocusSession, String> {
    conn.execute(
        "UPDATE focus_session SET outcome = ?1, reflection_note = ?2 WHERE id = ?3",
        params![outcome, note, id],
    )
    .map_err(|e| e.to_string())?;
    touch_activity(conn);
    fetch_focus_session(conn, id)
}

/// Ends the break — used both when the break countdown reaches zero and for
/// an explicit "Skip Break". Whatever `outcome` was already set (defaulted
/// by `complete_focus_phase`, possibly overwritten by `submit_reflection`)
/// is left untouched.
fn end_break_impl(conn: &Connection, id: &str) -> Result<FocusSession, String> {
    conn.execute(
        "UPDATE focus_session SET session_state = 'closed', running_since = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    touch_activity(conn);
    fetch_focus_session(conn, id)
}

/// Explicit "End Session" during either phase. Mid-focus, this is the only
/// way a session ends up 'interrupted': elapsed time is frozen at whatever
/// was actually focused, same as a natural completion. Mid-break, the focus
/// work already finished normally (frozen by `complete_focus_phase`), so
/// abandoning the break just closes the session — behaviorally identical to
/// `end_break`, and must not overwrite an outcome reflection already set.
fn abandon_focus_session_impl(conn: &Connection, id: &str) -> Result<FocusSession, String> {
    let session = fetch_focus_session(conn, id)?;
    let ts = now();

    if session.phase == "focus" {
        let final_elapsed = current_elapsed(&session, &ts)?;
        conn.execute(
            "UPDATE focus_session SET actual_duration_seconds = ?1, ended_at = ?2, outcome = 'interrupted', \
             session_state = 'closed', running_since = NULL WHERE id = ?3",
            params![final_elapsed, ts, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE focus_session SET session_state = 'closed', running_since = NULL WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    touch_activity(conn);
    fetch_focus_session(conn, id)
}

fn list_focus_sessions_impl(conn: &Connection) -> Result<Vec<FocusSession>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {FOCUS_SESSION_COLUMNS} FROM focus_session WHERE session_state = 'closed' \
             ORDER BY started_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_focus_session)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn delete_focus_session_impl(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM focus_session WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    touch_activity(conn);
    Ok(())
}

#[tauri::command]
pub fn start_focus_session(
    state: State<DbState>,
    input: StartFocusSessionInput,
) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    start_focus_session_impl(&conn, input)
}

#[tauri::command]
pub fn get_active_focus_session(state: State<DbState>) -> Result<Option<FocusSession>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    get_active_focus_session_impl(&conn)
}

#[tauri::command]
pub fn pause_focus_session(state: State<DbState>, id: String) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    pause_focus_session_impl(&conn, &id)
}

#[tauri::command]
pub fn resume_focus_session(state: State<DbState>, id: String) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    resume_focus_session_impl(&conn, &id)
}

#[tauri::command]
pub fn complete_focus_phase(state: State<DbState>, id: String) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    complete_focus_phase_impl(&conn, &id)
}

#[tauri::command]
pub fn submit_reflection(
    state: State<DbState>,
    id: String,
    outcome: String,
    note: Option<String>,
) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    submit_reflection_impl(&conn, &id, &outcome, note)
}

#[tauri::command]
pub fn end_break(state: State<DbState>, id: String) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    end_break_impl(&conn, &id)
}

#[tauri::command]
pub fn abandon_focus_session(state: State<DbState>, id: String) -> Result<FocusSession, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    abandon_focus_session_impl(&conn, &id)
}

#[tauri::command]
pub fn list_focus_sessions(state: State<DbState>) -> Result<Vec<FocusSession>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    list_focus_sessions_impl(&conn)
}

#[tauri::command]
pub fn delete_focus_session(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delete_focus_session_impl(&conn, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_db() -> Connection {
        let dir = std::env::temp_dir().join(format!("life-os-focus-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path: PathBuf = dir.join("life-os.sqlite3");
        crate::db::init(&path).unwrap()
    }

    fn preset_input(minutes: i64) -> StartFocusSessionInput {
        StartFocusSessionInput {
            intent: "CFA — Quant".to_string(),
            goal: Some("Complete 20 questions".to_string()),
            item_id: None,
            category: Some("School".to_string()),
            planned_duration_seconds: Some(minutes * 60),
            break_duration_seconds: 300,
        }
    }

    #[test]
    fn starting_a_session_blocks_a_second_concurrent_start() {
        let conn = scratch_db();
        start_focus_session_impl(&conn, preset_input(25)).unwrap();
        let err = start_focus_session_impl(&conn, preset_input(25)).unwrap_err();
        assert_eq!(err, "A focus session is already active");
    }

    #[test]
    fn get_active_returns_none_when_nothing_started() {
        let conn = scratch_db();
        assert!(get_active_focus_session_impl(&conn).unwrap().is_none());
    }

    #[test]
    fn pause_freezes_elapsed_and_resume_starts_a_fresh_running_since() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();

        // Simulate 10 real seconds having passed before pausing.
        conn.execute(
            "UPDATE focus_session SET running_since = ?1 WHERE id = ?2",
            params![
                (chrono::Utc::now() - chrono::Duration::seconds(10)).to_rfc3339(),
                session.id
            ],
        )
        .unwrap();

        let paused = pause_focus_session_impl(&conn, &session.id).unwrap();
        assert!(paused.running_since.is_none());
        assert!(paused.accumulated_seconds >= 10);

        let resumed = resume_focus_session_impl(&conn, &session.id).unwrap();
        assert!(resumed.running_since.is_some());
        assert_eq!(resumed.accumulated_seconds, paused.accumulated_seconds);
    }

    #[test]
    fn complete_focus_phase_freezes_duration_defaults_outcome_and_starts_break() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();

        let done = complete_focus_phase_impl(&conn, &session.id).unwrap();
        assert_eq!(done.phase, "break");
        assert_eq!(done.session_state, "active");
        assert_eq!(done.outcome.as_deref(), Some("completed"));
        assert!(done.actual_duration_seconds.is_some());
        assert!(done.ended_at.is_some());
        assert_eq!(done.accumulated_seconds, 0);
        assert!(done.running_since.is_some());
    }

    #[test]
    fn submit_reflection_updates_outcome_without_touching_timing() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();
        let done = complete_focus_phase_impl(&conn, &session.id).unwrap();

        let reflected =
            submit_reflection_impl(&conn, &session.id, "partial", Some("17/20".to_string()))
                .unwrap();
        assert_eq!(reflected.outcome.as_deref(), Some("partial"));
        assert_eq!(reflected.reflection_note.as_deref(), Some("17/20"));
        assert_eq!(reflected.phase, "break");
        assert_eq!(
            reflected.actual_duration_seconds,
            done.actual_duration_seconds
        );
    }

    #[test]
    fn end_break_closes_the_session_and_frees_up_starting_a_new_one() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();
        complete_focus_phase_impl(&conn, &session.id).unwrap();

        let closed = end_break_impl(&conn, &session.id).unwrap();
        assert_eq!(closed.session_state, "closed");

        // A new session can now start, and the closed one shows up in history.
        start_focus_session_impl(&conn, preset_input(15)).unwrap();
        let history = list_focus_sessions_impl(&conn).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, closed.id);
    }

    #[test]
    fn abandon_mid_focus_records_interrupted_with_partial_elapsed() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();

        let abandoned = abandon_focus_session_impl(&conn, &session.id).unwrap();
        assert_eq!(abandoned.session_state, "closed");
        assert_eq!(abandoned.outcome.as_deref(), Some("interrupted"));
        assert_eq!(abandoned.phase, "focus");
        assert!(abandoned.actual_duration_seconds.is_some());
    }

    #[test]
    fn abandon_mid_break_preserves_the_reflection_outcome() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();
        complete_focus_phase_impl(&conn, &session.id).unwrap();
        submit_reflection_impl(&conn, &session.id, "completed", None).unwrap();

        let abandoned = abandon_focus_session_impl(&conn, &session.id).unwrap();
        assert_eq!(abandoned.session_state, "closed");
        assert_eq!(abandoned.outcome.as_deref(), Some("completed"));
    }

    #[test]
    fn open_focus_has_no_planned_duration() {
        let conn = scratch_db();
        let input = StartFocusSessionInput {
            intent: "Coding — Dashboard".to_string(),
            goal: None,
            item_id: None,
            category: None,
            planned_duration_seconds: None,
            break_duration_seconds: 300,
        };
        let session = start_focus_session_impl(&conn, input).unwrap();
        assert!(session.planned_duration_seconds.is_none());
    }

    #[test]
    fn delete_focus_session_removes_it_from_history() {
        let conn = scratch_db();
        let session = start_focus_session_impl(&conn, preset_input(25)).unwrap();
        complete_focus_phase_impl(&conn, &session.id).unwrap();
        end_break_impl(&conn, &session.id).unwrap();

        delete_focus_session_impl(&conn, &session.id).unwrap();
        assert!(list_focus_sessions_impl(&conn).unwrap().is_empty());
    }
}
