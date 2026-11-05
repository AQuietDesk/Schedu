use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CALENDAR_BASE: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const TASKS_BASE: &str = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

// Calendar IDs are frequently email addresses (secondary/shared calendars use
// the owner's address as the id). `@` itself is a valid, unencoded character
// in a URL path segment (RFC 3986's pchar), so it passes through as-is —
// `Url::path_segments_mut` is still used over string interpolation because it
// correctly encodes whatever *does* need it (spaces, `#`, `?`, etc.), which a
// hand-built format! string would not.
fn events_url_for(calendar_id: &str) -> String {
    // No trailing slash on the base — path_segments_mut() treats a trailing
    // "/" as an existing empty final segment and appends *after* it rather
    // than replacing it, producing "calendars//primary/events" (a 404) instead
    // of "calendars/primary/events".
    let mut url = url::Url::parse("https://www.googleapis.com/calendar/v3/calendars").unwrap();
    url.path_segments_mut()
        .unwrap()
        .push(calendar_id)
        .push("events");
    url.to_string()
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::new()
}

fn auth(
    builder: reqwest::blocking::RequestBuilder,
    access_token: &str,
) -> reqwest::blocking::RequestBuilder {
    builder.bearer_auth(access_token)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CalendarEvent {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub updated: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub start: Option<EventDateTime>,
    #[serde(default)]
    pub end: Option<EventDateTime>,
    // Google's per-event color override (one of the fixed "1".."11" event
    // palette ids) — absent when the event just uses its calendar's default
    // color. See https://developers.google.com/calendar/api/v3/reference/colors.
    // deserialize-only rename: incoming Google JSON is camelCase, but this
    // struct's own Serialize impl feeds the frontend too (via Tauri IPC) and
    // that side needs to stay snake_case to match GoogleCalendarEvent.color_id
    // in src/types/index.ts — a plain `rename = "colorId"` would apply to
    // both directions and silently serialize this out as `colorId`, which
    // `event.color_id` on the frontend would never see (exactly the bug that
    // made `background_color` below always resolve to null).
    #[serde(rename(deserialize = "colorId"), default)]
    pub color_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EventDateTime {
    #[serde(default)]
    pub date: Option<String>,
    #[serde(rename = "dateTime", default)]
    pub date_time: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CalendarListEntry {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    // deserialize-only rename — see the comment on CalendarEvent::color_id
    // above for why this can't be a plain `rename = "backgroundColor"`. This
    // was that exact bug: every calendar's color silently came back as
    // `undefined` on the frontend (GoogleCalendarListEntry.background_color),
    // so DayRingCard/Calendar.tsx/Settings.tsx all fell back to their
    // default/gray color for every Google calendar, regardless of its real one.
    #[serde(rename(deserialize = "backgroundColor"), default)]
    pub background_color: Option<String>,
    #[serde(default)]
    pub primary: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct CalendarListResponse {
    #[serde(default)]
    items: Vec<CalendarListEntry>,
    #[serde(rename = "nextPageToken", default)]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EventListResponse {
    #[serde(default)]
    items: Vec<CalendarEvent>,
    #[serde(rename = "nextSyncToken", default)]
    next_sync_token: Option<String>,
    #[serde(rename = "nextPageToken", default)]
    next_page_token: Option<String>,
}

pub fn create_event(access_token: &str, body: &Value) -> Result<CalendarEvent, String> {
    auth(client().post(CALENDAR_BASE), access_token)
        .json(body)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())
}

pub fn update_event(
    access_token: &str,
    event_id: &str,
    body: &Value,
) -> Result<CalendarEvent, String> {
    auth(
        client().put(format!("{CALENDAR_BASE}/{event_id}")),
        access_token,
    )
    .json(body)
    .send()
    .map_err(|e| e.to_string())?
    .error_for_status()
    .map_err(|e| e.to_string())?
    .json()
    .map_err(|e| e.to_string())
}

pub fn delete_event(access_token: &str, event_id: &str) -> Result<(), String> {
    let res = auth(
        client().delete(format!("{CALENDAR_BASE}/{event_id}")),
        access_token,
    )
    .send()
    .map_err(|e| e.to_string())?;
    // 410 Gone means it's already deleted on Google's side — treat as success.
    if res.status().is_success() || res.status().as_u16() == 410 || res.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(format!("Calendar delete failed: {}", res.status()))
    }
}

/// Returns (events, next_sync_token). Pass `sync_token: None` for a full initial
/// sync; pass the previously-returned token thereafter for incremental pulls.
pub fn list_events(
    access_token: &str,
    sync_token: Option<&str>,
) -> Result<(Vec<CalendarEvent>, Option<String>), String> {
    let mut all_items = Vec::new();
    let mut page_token: Option<String> = None;
    let mut final_sync_token = None;

    loop {
        let mut query: Vec<(&str, &str)> = vec![("showDeleted", "true"), ("singleEvents", "true")];
        if let Some(token) = &sync_token {
            query.push(("syncToken", token));
        }
        if let Some(token) = &page_token {
            query.push(("pageToken", token));
        }

        let res = auth(client().get(CALENDAR_BASE), access_token)
            .query(&query)
            .send()
            .map_err(|e| e.to_string())?;

        if res.status().as_u16() == 410 {
            // Sync token expired/invalid — caller should retry with sync_token: None.
            return Err("SYNC_TOKEN_INVALID".to_string());
        }
        let parsed: EventListResponse = res
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        all_items.extend(parsed.items);
        if let Some(next) = parsed.next_sync_token {
            final_sync_token = Some(next);
        }
        page_token = parsed.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok((all_items, final_sync_token))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Task {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub updated: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub deleted: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TaskListResponse {
    #[serde(default)]
    items: Vec<Task>,
    #[serde(rename = "nextPageToken", default)]
    next_page_token: Option<String>,
}

pub fn create_task(access_token: &str, body: &Value) -> Result<Task, String> {
    auth(client().post(TASKS_BASE), access_token)
        .json(body)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())
}

pub fn update_task(access_token: &str, task_id: &str, body: &Value) -> Result<Task, String> {
    auth(
        client().patch(format!("{TASKS_BASE}/{task_id}")),
        access_token,
    )
    .json(body)
    .send()
    .map_err(|e| e.to_string())?
    .error_for_status()
    .map_err(|e| e.to_string())?
    .json()
    .map_err(|e| e.to_string())
}

pub fn delete_task(access_token: &str, task_id: &str) -> Result<(), String> {
    let res = auth(
        client().delete(format!("{TASKS_BASE}/{task_id}")),
        access_token,
    )
    .send()
    .map_err(|e| e.to_string())?;
    if res.status().is_success() || res.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(format!("Tasks delete failed: {}", res.status()))
    }
}

/// `updated_min: None` performs an initial full list; pass the previous sync
/// timestamp thereafter (Tasks API has no sync-token concept, unlike Calendar).
pub fn list_tasks(access_token: &str, updated_min: Option<&str>) -> Result<Vec<Task>, String> {
    let mut all_items = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut query: Vec<(&str, &str)> = vec![("showCompleted", "true"), ("showHidden", "true")];
        if let Some(min) = &updated_min {
            query.push(("updatedMin", min));
        }
        if let Some(token) = &page_token {
            query.push(("pageToken", token));
        }

        let parsed: TaskListResponse = auth(client().get(TASKS_BASE), access_token)
            .query(&query)
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        all_items.extend(parsed.items);
        page_token = parsed.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok(all_items)
}

/// Read-only "what's coming up" listing for the Dashboard preview / Calendar
/// page — distinct from `list_events`, which serves the incremental sync loop
/// and has different (syncToken-based) semantics.
pub fn list_upcoming_events(
    access_token: &str,
    max_results: i64,
) -> Result<Vec<CalendarEvent>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let max_results_str = max_results.to_string();
    let query = [
        ("timeMin", now.as_str()),
        ("singleEvents", "true"),
        ("orderBy", "startTime"),
        ("maxResults", max_results_str.as_str()),
    ];
    let parsed: EventListResponse = auth(client().get(CALENDAR_BASE), access_token)
        .query(&query)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    Ok(parsed.items)
}

/// Lists every calendar in the user's CalendarList — their own secondary
/// calendars as well as ones other people have shared with them, exactly what
/// shows up in the calendar-picker sidebar on calendar.google.com. Requires
/// the calendar.readonly scope (calendar.events alone doesn't cover this).
pub fn list_calendars(access_token: &str) -> Result<Vec<CalendarListEntry>, String> {
    let mut all_items = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut query: Vec<(&str, &str)> = vec![];
        if let Some(token) = &page_token {
            query.push(("pageToken", token));
        }

        let parsed: CalendarListResponse = auth(client().get(CALENDAR_LIST_URL), access_token)
            .query(&query)
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        all_items.extend(parsed.items);
        page_token = parsed.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok(all_items)
}

/// Read-only listing of events within [time_min, time_max) (both RFC3339) on
/// a given calendar — backs the Calendar page's month/week grid, which needs
/// "everything in this visible range" rather than `list_upcoming_events`'s
/// "next N from now" or `list_events`'s sync-token-based incremental
/// semantics. Takes an explicit `calendar_id` (not just "primary") so the
/// grid can also show other/shared calendars from the user's CalendarList.
pub fn list_events_in_range(
    access_token: &str,
    calendar_id: &str,
    time_min: &str,
    time_max: &str,
) -> Result<Vec<CalendarEvent>, String> {
    list_events_in_range_at(
        &events_url_for(calendar_id),
        access_token,
        time_min,
        time_max,
    )
}

// A calendar that was deleted or unshared since it was selected 404s on every
// request; treat that as "no events" so one stale calendar can't fail the
// whole grid. Other statuses (401/403/5xx) still surface as errors.
fn list_events_in_range_at(
    url: &str,
    access_token: &str,
    time_min: &str,
    time_max: &str,
) -> Result<Vec<CalendarEvent>, String> {
    let mut all_items = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut query: Vec<(&str, &str)> = vec![
            ("timeMin", time_min),
            ("timeMax", time_max),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
        ];
        if let Some(token) = &page_token {
            query.push(("pageToken", token));
        }

        let res = auth(client().get(url), access_token)
            .query(&query)
            .send()
            .map_err(|e| e.to_string())?;
        if res.status().as_u16() == 404 {
            return Ok(Vec::new());
        }
        let parsed: EventListResponse = res
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        all_items.extend(parsed.items);
        page_token = parsed.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok(all_items)
}

/// Read-only "what's outstanding" listing for the Dashboard's Tasks preview.
pub fn list_upcoming_tasks(access_token: &str, max_results: i64) -> Result<Vec<Task>, String> {
    let max_results_str = max_results.to_string();
    let query = [
        ("showCompleted", "false"),
        ("maxResults", max_results_str.as_str()),
    ];
    let parsed: TaskListResponse = auth(client().get(TASKS_BASE), access_token)
        .query(&query)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    Ok(parsed.items)
}

pub fn event_body(
    title: &str,
    description: Option<&str>,
    due_date: &str,
    due_time: Option<&str>,
    duration_minutes: Option<i64>,
    location: Option<&str>,
) -> Value {
    let (start, end) = match due_time {
        Some(time) => {
            // Calendar requires either a `timeZone` field or an explicit UTC
            // offset on the dateTime itself — a bare naive string like
            // "2026-07-25T14:00:00" is rejected with "Missing time zone
            // definition." `due_date`/`due_time` are local wall-clock values,
            // so the system's current local offset is the correct one to
            // attach (avoids needing an IANA zone-name lookup).
            let offset = chrono::Local::now().format("%:z").to_string();
            let naive_start = format!("{due_date}T{time}:00");
            // Calendar also rejects a zero-duration event (start == end), so a
            // timed event always needs an end strictly after its start — fall
            // back to a sensible default when the Item has no estimated_duration.
            let duration = chrono::Duration::minutes(duration_minutes.unwrap_or(30).max(1));
            let naive_end =
                chrono::NaiveDateTime::parse_from_str(&naive_start, "%Y-%m-%dT%H:%M:%S")
                    .map(|naive| (naive + duration).format("%Y-%m-%dT%H:%M:%S").to_string())
                    .unwrap_or_else(|_| naive_start.clone());
            (
                json!({ "dateTime": format!("{naive_start}{offset}") }),
                json!({ "dateTime": format!("{naive_end}{offset}") }),
            )
        }
        None => {
            let next_day = chrono::NaiveDate::parse_from_str(due_date, "%Y-%m-%d")
                .map(|d| d.succ_opt().unwrap_or(d))
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|_| due_date.to_string());
            (json!({ "date": due_date }), json!({ "date": next_day }))
        }
    };
    json!({
        "summary": title,
        "description": description,
        "location": location,
        "start": start,
        "end": end,
    })
}

pub fn task_body(
    title: &str,
    notes: Option<&str>,
    due_date: Option<&str>,
    completed: bool,
) -> Value {
    json!({
        "title": title,
        "notes": notes,
        "due": due_date.map(|d| format!("{d}T00:00:00.000Z")),
        "status": if completed { "completed" } else { "needsAction" },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serves exactly one canned HTTP response, then returns the base URL.
    fn serve_once(status_line: &'static str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://{addr}/events")
    }

    #[test]
    fn list_events_in_range_treats_missing_calendar_as_empty() {
        let url = serve_once("404 Not Found", r#"{"error":{"code":404}}"#);
        let events = list_events_in_range_at(
            &url,
            "token",
            "2026-10-25T06:00:00Z",
            "2026-11-01T06:00:00Z",
        );
        assert!(events.unwrap().is_empty());
    }

    #[test]
    fn list_events_in_range_still_errors_on_forbidden() {
        let url = serve_once("403 Forbidden", r#"{"error":{"code":403}}"#);
        let events = list_events_in_range_at(
            &url,
            "token",
            "2026-10-25T06:00:00Z",
            "2026-11-01T06:00:00Z",
        );
        assert!(events.is_err());
    }

    #[test]
    fn list_events_in_range_parses_items_on_success() {
        let url = serve_once("200 OK", r#"{"items":[{"id":"abc","summary":"Hi"}]}"#);
        let events = list_events_in_range_at(
            &url,
            "token",
            "2026-10-25T06:00:00Z",
            "2026-11-01T06:00:00Z",
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "abc");
    }

    #[test]
    fn events_url_for_primary_has_no_double_slash() {
        assert_eq!(
            events_url_for("primary"),
            "https://www.googleapis.com/calendar/v3/calendars/primary/events"
        );
    }

    #[test]
    fn events_url_for_handles_email_like_ids() {
        // Secondary/shared calendar ids are frequently the owner's email
        // address. '@' is valid unencoded in a URL path segment (RFC 3986),
        // so it passes through as-is — this just confirms the id lands as one
        // clean path segment, not split or mangled.
        let url = events_url_for("someone@example.com");
        assert_eq!(
            url,
            "https://www.googleapis.com/calendar/v3/calendars/someone@example.com/events"
        );
    }

    #[test]
    fn events_url_for_encodes_characters_that_need_it() {
        // Unlike '@', a space does need percent-encoding in a path segment —
        // this is what actually justifies path_segments_mut over a hand-built
        // format! string.
        let url = events_url_for("a b");
        assert_eq!(
            url,
            "https://www.googleapis.com/calendar/v3/calendars/a%20b/events"
        );
    }
}
