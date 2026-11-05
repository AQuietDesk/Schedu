//! Demo profile for screenshots, store images and screen recordings.
//!
//! Launch with `SCHEDU_DEMO=1` (see `scripts/demo.ps1`). The app then uses a
//! separate database in `<app data>\demo\`, so real data is never read or
//! touched, and fills it with a made-up student on first run. Every date is
//! relative to the day it's seeded, so the Today and Calendar views always
//! look current. Delete the `demo` folder to reseed.
//!
//! All names here are fictional: no real school, course code or person.

use chrono::{Duration, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection};

pub const ENV_VAR: &str = "SCHEDU_DEMO";

pub fn enabled() -> bool {
    std::env::var(ENV_VAR).map(|v| v == "1").unwrap_or(false)
}

struct Class {
    id: &'static str,
    name: &'static str,
    color: &'static str,
    schedule: &'static str,
    owner: &'static str,
    weights: &'static str,
}

const CLASSES: &[Class] = &[
    Class { id: "demo-bio", name: "Intro to Biology", color: "emerald", schedule: "Mon, Wed · 9:00–10:20", owner: "Dr. Okafor", weights: r#"{"Labs":25,"Quizzes":15,"Midterm":25,"Final":35}"# },
    Class { id: "demo-chem", name: "Chemistry Lab", color: "blue", schedule: "Tue · 13:00–15:50", owner: "Prof. Lindqvist", weights: r#"{"Lab reports":60,"Safety quiz":10,"Practical":30}"# },
    Class { id: "demo-hist", name: "World History", color: "amber", schedule: "Tue, Thu · 10:30–11:50", owner: "Dr. Haddad", weights: r#"{"Essays":40,"Participation":10,"Midterm":20,"Final":30}"# },
    Class { id: "demo-stats", name: "Statistics", color: "violet", schedule: "Mon, Wed, Fri · 11:00–11:50", owner: "Prof. Tanaka", weights: r#"{"Problem sets":30,"Quizzes":20,"Midterm":20,"Final":30}"# },
    Class { id: "demo-write", name: "Creative Writing", color: "rose", schedule: "Thu · 18:00–20:50", owner: "M. Delacroix", weights: r#"{"Workshops":50,"Portfolio":50}"# },
];

/// (class id or "" for Personal, Personal list, title, due offset in days,
/// due time, priority, assignment type, points earned/possible if graded,
/// done)
type Row = (&'static str, &'static str, &'static str, i64, Option<&'static str>, &'static str, Option<&'static str>, Option<(f64, f64)>, bool);

const ITEMS: &[Row] = &[
    // Graded work from earlier in the term.
    ("demo-bio", "", "Lab 1: Microscopy", -24, Some("23:59"), "Medium", Some("Labs"), Some((18.0, 20.0)), true),
    ("demo-bio", "", "Quiz 1: Cell structure", -17, Some("09:00"), "Medium", Some("Quizzes"), Some((9.0, 10.0)), true),
    ("demo-bio", "", "Lab 2: Osmosis", -10, Some("23:59"), "Medium", Some("Labs"), Some((17.0, 20.0)), true),
    ("demo-chem", "", "Safety quiz", -28, Some("13:00"), "High", Some("Safety quiz"), Some((10.0, 10.0)), true),
    ("demo-chem", "", "Report 1: Titration", -14, Some("23:59"), "Medium", Some("Lab reports"), Some((42.0, 50.0)), true),
    ("demo-hist", "", "Essay 1: Trade routes", -12, Some("23:59"), "High", Some("Essays"), Some((84.0, 100.0)), true),
    ("demo-stats", "", "Problem set 1", -19, Some("17:00"), "Medium", Some("Problem sets"), Some((27.0, 30.0)), true),
    ("demo-stats", "", "Problem set 2", -12, Some("17:00"), "Medium", Some("Problem sets"), Some((25.0, 30.0)), true),
    ("demo-stats", "", "Quiz 1: Probability", -7, Some("11:00"), "Medium", Some("Quizzes"), Some((16.0, 20.0)), true),
    ("demo-write", "", "Workshop piece: Opening scene", -9, Some("18:00"), "Medium", Some("Workshops"), Some((45.0, 50.0)), true),
    // Done but not graded yet.
    ("demo-chem", "", "Report 2: Reaction rates", -3, Some("23:59"), "Medium", Some("Lab reports"), None, true),
    ("demo-stats", "", "Problem set 3", -5, Some("17:00"), "Medium", Some("Problem sets"), None, true),
    // One overdue item, so the Today view shows how that looks.
    ("demo-hist", "", "Reading response: Chapter 6", -1, Some("23:59"), "Low", Some("Participation"), None, false),
    // Due today and coming up.
    ("demo-bio", "", "Lab 3: Enzyme activity", 0, Some("23:59"), "High", Some("Labs"), None, false),
    ("demo-stats", "", "Problem set 4", 0, Some("17:00"), "Medium", Some("Problem sets"), None, false),
    ("demo-write", "", "Workshop piece: Dialogue", 2, Some("18:00"), "Medium", Some("Workshops"), None, false),
    ("demo-chem", "", "Report 3: Spectroscopy", 4, Some("23:59"), "Medium", Some("Lab reports"), None, false),
    ("demo-hist", "", "Essay 2: Empires compared", 6, Some("23:59"), "High", Some("Essays"), None, false),
    ("demo-bio", "", "Quiz 2: Genetics", 8, Some("09:00"), "Medium", Some("Quizzes"), None, false),
    ("demo-stats", "", "Midterm", 11, Some("11:00"), "High", Some("Midterm"), None, false),
    ("demo-bio", "", "Midterm", 15, Some("09:00"), "High", Some("Midterm"), None, false),
    ("demo-write", "", "Portfolio draft", 20, None, "Medium", Some("Portfolio"), None, false),
    // Personal lists.
    ("", "Errands", "Return library books", 1, None, "Low", None, None, false),
    ("", "Errands", "Pick up lab goggles", -2, None, "Medium", None, None, true),
    ("", "Errands", "Renew transit pass", 5, None, "Medium", None, None, false),
    ("", "Health", "Run 5 km", 0, Some("07:00"), "Low", None, None, false),
    ("", "Health", "Dentist appointment", 9, Some("15:30"), "Medium", None, None, false),
    ("", "Work", "Café shift", 1, Some("16:00"), "Medium", None, None, false),
    ("", "Work", "Café shift", 3, Some("16:00"), "Medium", None, None, false),
    ("", "", "Call grandma", 2, None, "Low", None, None, false),
    ("", "", "Plan weekend hike", 4, None, "Low", None, None, false),
];

const CLASS_NOTES: &[(&str, &str)] = &[
    ("demo-bio", "Office hours moved to Thursday 2–3 pm this week."),
    ("demo-stats", "Midterm covers chapters 1–5. Formula sheet allowed (one page, both sides)."),
    ("demo-hist", "Essay 2: compare at least two empires, 1500 words, Chicago style."),
];

const QUICK_NOTES: &[&str] = &[
    "Ask about group partners for the chem practical",
    "Buy a new notebook for Creative Writing",
];

fn at(date: NaiveDate, hour: u32, minute: u32) -> String {
    let naive = date.and_hms_opt(hour, minute, 0).unwrap();
    Local
        .from_local_datetime(&naive)
        .earliest()
        .unwrap_or_else(|| Local::now())
        .to_rfc3339()
}

/// Fills `conn` with the demo profile if it has no items yet.
pub fn seed_if_empty(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM item", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let today = Local::now().date_naive();
    let created = at(today - Duration::days(30), 9, 0);

    let tx = conn.unchecked_transaction()?;
    for c in CLASSES {
        tx.execute(
            "INSERT INTO context (id, type, name, color, status, term, schedule, owner, grade_scale) \
             VALUES (?1, 'Class', ?2, ?3, 'Active', 'Fall 2026', ?4, ?5, ?6)",
            params![c.id, c.name, c.color, c.schedule, c.owner, c.weights],
        )?;
    }

    for (i, (class, list, title, offset, time, priority, kind, points, done)) in ITEMS.iter().enumerate() {
        let due = today + Duration::days(*offset);
        let category = if class.is_empty() { "Personal" } else { "School" };
        // Stats read completion time from updated_at: finish the evening before.
        let updated = if *done { at(due - Duration::days(1), 20, 15) } else { created.clone() };
        tx.execute(
            "INSERT INTO item (id, title, category, subcategory_id, subcategory_text, due_date, due_time, \
               priority, status, assignment_type, points_earned, points_possible, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                format!("demo-item-{i}"),
                title,
                category,
                (!class.is_empty()).then_some(*class),
                (!list.is_empty()).then_some(*list),
                due.format("%Y-%m-%d").to_string(),
                time,
                priority,
                if *done { "Completed" } else { "Not Started" },
                kind,
                points.map(|p| p.0),
                points.map(|p| p.1),
                created,
                updated,
            ],
        )?;
    }

    for (i, (class, body)) in CLASS_NOTES.iter().enumerate() {
        tx.execute(
            "INSERT INTO note (id, context_id, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![format!("demo-note-{i}"), class, body, created],
        )?;
    }
    for (i, body) in QUICK_NOTES.iter().enumerate() {
        tx.execute(
            "INSERT INTO quick_note (id, body, created_at) VALUES (?1, ?2, ?3)",
            params![format!("demo-quick-{i}"), body, at(today, 8, 30 + i as u32)],
        )?;
    }

    // A week of finished focus sessions so Stats and Today have something to show.
    for day in 0..7i64 {
        for (slot, minutes) in [(0u32, 50i64), (1, 25)] {
            if (day + slot as i64) % 3 == 2 {
                continue;
            }
            let date = today - Duration::days(day);
            let start = at(date, 14 + slot * 2, 0);
            let end = at(date, 14 + slot * 2, minutes as u32);
            tx.execute(
                "INSERT INTO focus_session (id, intent, category, planned_duration_seconds, break_duration_seconds, \
                   phase, accumulated_seconds, started_at, ended_at, actual_duration_seconds, session_state, \
                   outcome, created_at) \
                 VALUES (?1, ?2, 'School', ?3, 300, 'focus', ?3, ?4, ?5, ?3, 'closed', 'completed', ?4)",
                params![
                    format!("demo-focus-{day}-{slot}"),
                    if slot == 0 { "Study for Statistics midterm" } else { "Draft history essay" },
                    minutes * 60,
                    start,
                    end,
                ],
            )?;
        }
    }

    for (key, value) in [("user_name", "Alex"), ("weather_location", "Vancouver, BC")] {
        tx.execute(
            "INSERT OR REPLACE INTO preference (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_once_and_every_item_is_valid() {
        let dir = std::env::temp_dir().join(format!("schedu-demo-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::init(&dir.join("life-os.sqlite3")).unwrap();
        seed_if_empty(&conn).unwrap();
        seed_if_empty(&conn).unwrap(); // second call is a no-op

        let items: i64 = conn.query_row("SELECT COUNT(*) FROM item", [], |r| r.get(0)).unwrap();
        assert_eq!(items as usize, ITEMS.len());
        let classes: i64 = conn.query_row("SELECT COUNT(*) FROM context", [], |r| r.get(0)).unwrap();
        assert_eq!(classes as usize, CLASSES.len());

        // Every graded type must be one of its class's weight categories, or
        // the grade card would ignore it.
        for (class, _, title, _, _, _, kind, _, _) in ITEMS {
            if let (false, Some(kind)) = (class.is_empty(), kind) {
                let c = CLASSES.iter().find(|c| c.id == *class).unwrap();
                let weights: serde_json::Value = serde_json::from_str(c.weights).unwrap();
                assert!(weights.get(kind).is_some(), "{title}: '{kind}' isn't a category of {}", c.name);
            }
        }
    }
}
