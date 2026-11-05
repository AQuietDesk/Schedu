use crate::db::DbState;
use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Spawns the background poll loop on its own OS thread (not tied to the main
/// window), so scheduled notifications keep firing while the window is hidden.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        tick(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

fn get_pref(conn: &Connection, key: &str, default: &str) -> String {
    conn.query_row(
        "SELECT value FROM preference WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_else(|| default.to_string())
}

fn set_pref(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO preference (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

fn already_logged(conn: &Connection, item_id: &str, kind: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM notification_log WHERE item_id = ?1 AND notification_type = ?2",
        params![item_id, kind],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn mark_logged(conn: &Connection, item_id: &str, kind: &str) {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO notification_log (item_id, notification_type, fired_at) \
         VALUES (?1, ?2, ?3)",
        params![item_id, kind, chrono::Utc::now().to_rfc3339()],
    );
}

pub(crate) fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Ad hoc OS notification for frontend-driven events (currently just the
/// Focus Timer's phase changes) — everything else in this file fires on its
/// own schedule from the background poll loop.
#[tauri::command]
pub fn notify_now(app: AppHandle, title: String, body: String) -> Result<(), String> {
    notify(&app, &title, &body);
    Ok(())
}

fn time_reached(now_time: NaiveTime, target_hhmm: &str) -> bool {
    match NaiveTime::parse_from_str(target_hhmm, "%H:%M") {
        Ok(target) => now_time >= target,
        Err(_) => false,
    }
}

fn parse_due_datetime(date: &str, time: Option<&str>) -> Option<NaiveDateTime> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let t = time
        .and_then(|t| NaiveTime::parse_from_str(t, "%H:%M").ok())
        .unwrap_or_else(|| NaiveTime::from_hms_opt(23, 59, 0).unwrap());
    Some(d.and_time(t))
}

fn count_due_today(conn: &Connection, today: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM item WHERE due_date = ?1 AND status != 'Completed' AND deleted_at IS NULL",
        params![today],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn tick(app: &AppHandle) {
    let state = app.state::<DbState>();
    let conn = match state.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };

    let now = Local::now();
    let today_key = now.format("%Y-%m-%d").to_string();
    let now_time = now.time();

    if get_pref(&conn, "morning_briefing_enabled", "true") == "true" {
        let target = get_pref(&conn, "morning_briefing_time", "08:00");
        if time_reached(now_time, &target)
            && get_pref(&conn, "last_morning_briefing_date", "") != today_key
        {
            let due_today = count_due_today(&conn, &today_key);
            notify(
                app,
                "Morning Briefing",
                &format!("{due_today} item(s) due today."),
            );
            set_pref(&conn, "last_morning_briefing_date", &today_key);
        }
    }

    if get_pref(&conn, "evening_review_enabled", "true") == "true" {
        let target = get_pref(&conn, "evening_review_time", "20:00");
        if time_reached(now_time, &target)
            && get_pref(&conn, "last_evening_review_date", "") != today_key
        {
            notify(
                app,
                "Evening Review",
                "Take a moment to review today and plan tomorrow.",
            );
            set_pref(&conn, "last_evening_review_date", &today_key);
        }
    }

    if get_pref(&conn, "weekly_planning_enabled", "true") == "true" {
        let target_day: u32 = get_pref(&conn, "weekly_planning_day", "0")
            .parse()
            .unwrap_or(0);
        let target_time = get_pref(&conn, "weekly_planning_time", "18:00");
        let is_target_day = now.weekday().num_days_from_sunday() == target_day;
        if is_target_day
            && time_reached(now_time, &target_time)
            && get_pref(&conn, "last_weekly_planning_date", "") != today_key
        {
            notify(app, "Weekly Planning", "Plan out your week ahead.");
            set_pref(&conn, "last_weekly_planning_date", &today_key);
        }
    }

    let upcoming_enabled = get_pref(&conn, "upcoming_deadline_enabled", "true") == "true";
    let overdue_enabled = get_pref(&conn, "overdue_enabled", "true") == "true";

    if upcoming_enabled || overdue_enabled {
        let lead_hours: i64 = get_pref(&conn, "upcoming_deadline_lead_hours", "24")
            .parse()
            .unwrap_or(24);

        let mut stmt = match conn.prepare(
            "SELECT id, title, due_date, due_time FROM item \
             WHERE due_date IS NOT NULL AND status != 'Completed' AND deleted_at IS NULL",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows: Vec<(String, String, String, Option<String>)> = match stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        }) {
            Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
            Err(_) => return,
        };
        drop(stmt);

        let now_naive = now.naive_local();
        for (id, title, due_date, due_time) in rows {
            let Some(due) = parse_due_datetime(&due_date, due_time.as_deref()) else {
                continue;
            };

            if overdue_enabled && due < now_naive && !already_logged(&conn, &id, "overdue") {
                notify(
                    app,
                    "Overdue",
                    &format!("\"{title}\" was due and is still not complete."),
                );
                mark_logged(&conn, &id, "overdue");
            }

            if upcoming_enabled {
                let lead_start = due - chrono::Duration::hours(lead_hours);
                if now_naive >= lead_start
                    && now_naive < due
                    && !already_logged(&conn, &id, "upcoming_deadline")
                {
                    notify(
                        app,
                        "Upcoming Deadline",
                        &format!("\"{title}\" is due soon."),
                    );
                    mark_logged(&conn, &id, "upcoming_deadline");
                }
            }
        }
    }
}
