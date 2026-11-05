use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

pub struct DbState(pub Mutex<Connection>);

/// The DB file path, managed separately from `DbState` so background work
/// (Google OAuth's blocking browser wait, the sync loop) can open its own
/// independent connection instead of holding the single shared Mutex for the
/// duration of a network round-trip — that would freeze every other DB-backed
/// command in the app for as long as sync/auth takes.
pub struct DbPathState(pub PathBuf);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('Class','Project','Program')),
  name TEXT NOT NULL,
  color TEXT,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Archived')),
  term TEXT,
  schedule TEXT,
  owner TEXT,
  grade_scale TEXT,
  grade_cutoffs TEXT
);

CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN
    ('School','Work','Gym','Personal','Finance','Projects','Relationships','Health','Travel','Custom')),
  subcategory_id TEXT REFERENCES context(id),
  subcategory_text TEXT,
  due_date TEXT,
  due_time TEXT,
  estimated_duration INTEGER,
  priority TEXT CHECK (priority IN ('Low','Medium','High')) DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'Not Started' CHECK (status IN ('Not Started','In Progress','Completed')),
  repeat_settings TEXT,
  color TEXT,
  notes TEXT,
  tags TEXT,
  attachments TEXT,
  location TEXT,

  google_calendar_id TEXT,
  google_task_id TEXT,
  -- Kept separate rather than one shared `last_synced_at`: Calendar and Tasks
  -- are independent remote timelines with their own update clocks, and
  -- run_sync pulls calendar before tasks — a shared column let a same-cycle
  -- calendar-side touch (e.g. re-detecting its own just-created event due to
  -- clock skew) advance the timestamp past a genuine, slightly-earlier Tasks
  -- change, permanently hiding it from decide_pull_action. See sync.rs.
  last_synced_at_calendar TEXT,
  last_synced_at_tasks TEXT,

  -- Sync-failure state (see google/sync.rs push_one_item). Item-level rather
  -- than split per-channel like last_synced_at_* above: the UI only ever
  -- shows one "sync failed" indicator per item, and a combined message is
  -- more useful to a user than two independent ones. Cleared (error to NULL,
  -- count to 0) the moment every channel attempted in a push cycle succeeds.
  last_sync_error TEXT,
  last_sync_attempted_at TEXT,
  sync_failure_count INTEGER NOT NULL DEFAULT 0,

  assignment_type TEXT,
  points_earned REAL,
  points_possible REAL,

  -- Set only for Items created by the Obsidian task scanner (obsidian_tasks.rs)
  -- — NULL for everything created directly in the dashboard or from Google.
  -- obsidian_source_id is a deterministic hash of (vault-relative file,
  -- section, task text, occurrence index) so the same source checkbox always
  -- resolves to the same Item and re-scanning can never create a duplicate;
  -- the UNIQUE index below is a DB-level backstop for that guarantee.
  obsidian_source_id TEXT,
  obsidian_vault_path TEXT,
  obsidian_source_folder TEXT,
  obsidian_source_file TEXT,
  obsidian_source_section TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_category ON item(category);
CREATE INDEX IF NOT EXISTS idx_item_subcategory_id ON item(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_item_due_date ON item(due_date);
CREATE INDEX IF NOT EXISTS idx_item_deleted_at ON item(deleted_at);

-- LEGACY (v0.3+): the Inbox page and its commands were removed — capture now
-- goes straight to `item` via the command bar. The table is kept only so
-- existing databases and older backups stay valid; nothing reads or writes it.
-- Raw Inbox captures: title + optional freeform text, no category yet.
-- Kept separate from `item` because item.category is NOT NULL in the locked schema;
-- an inbox_item is promoted into a real Item (via create_item) by the Process flow,
-- then removed from this table.
CREATE TABLE IF NOT EXISTS inbox_item (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- Freeform notes scoped to a Context (e.g. a Class), optionally linked to one
-- specific Item (an assignment). Kept as its own table since neither `context`
-- nor `item` has room for an arbitrary number of freeform notes per assignment.
CREATE TABLE IF NOT EXISTS note (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES context(id),
  item_id TEXT REFERENCES item(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_context_id ON note(context_id);

-- Dashboard "Quick Notes": a freeform scratchpad, unlike `note` which is
-- always scoped to a Context. Add/delete only — no per-note editing, matching
-- how it's used (jot something down, clear it later).
CREATE TABLE IF NOT EXISTS quick_note (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- LEGACY (v0.3+): the Gym page and its commands were removed. Kept only so
-- existing databases and older backups stay valid; nothing reads or writes it.
-- Gym Personal Records: keyed to exercise name + current best value, not date-bound,
-- so (per the build prompt) they don't fit the Item model and get their own table.
CREATE TABLE IF NOT EXISTS personal_record (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES context(id),
  exercise_name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Generic key/value settings store (notification times, lead hours, toggles).
-- Phase 11 (Settings) is the UI on top of this; Phase 9 just needs somewhere
-- to keep the scheduler's configuration and defaults.
CREATE TABLE IF NOT EXISTS preference (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracks which (item, notification type) pairs have already fired, so the
-- background poll loop (which re-evaluates every tick) fires Overdue/Upcoming
-- Deadline notifications exactly once per item rather than every tick.
CREATE TABLE IF NOT EXISTS notification_log (
  item_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  PRIMARY KEY (item_id, notification_type)
);

-- Surfaced when both the local Item and its Google-side counterpart changed
-- since last_synced_at (spec §7.2) — never silently overwritten, resolved by
-- the user picking "keep mine" or "keep Google's" in the Sync Conflicts list.
CREATE TABLE IF NOT EXISTS sync_conflict (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES item(id),
  source TEXT NOT NULL CHECK (source IN ('calendar','tasks')),
  local_snapshot TEXT NOT NULL,
  remote_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Focus sessions (Focus/Pomodoro system). One row per focus session; a break
-- is a `phase` of the same row rather than its own history entry, so Open
-- Focus and preset-duration sessions both "still create a normal session
-- record" (per the build spec) without a second table. `running_since` +
-- `accumulated_seconds` is a stopwatch pair, not a stored countdown: elapsed
-- time is always derived as accumulated_seconds + (running_since is not null
-- ? now - running_since : 0), so pause/resume/app-restart never lose time to
-- drift or a missed tick.
CREATE TABLE IF NOT EXISTS focus_session (
  id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  goal TEXT,
  item_id TEXT REFERENCES item(id),
  category TEXT,
  planned_duration_seconds INTEGER,
  break_duration_seconds INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'focus' CHECK (phase IN ('focus','break')),
  running_since TEXT,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  actual_duration_seconds INTEGER,
  session_state TEXT NOT NULL DEFAULT 'active' CHECK (session_state IN ('active','closed')),
  outcome TEXT CHECK (outcome IN ('completed','partial','not_completed','interrupted')),
  reflection_note TEXT,
  created_at TEXT NOT NULL
);

-- Enforces "only one focus session in flight at a time" at the DB layer
-- rather than trusting the frontend alone — session_state stays 'active'
-- through the break (not just the focus countdown) so a reload mid-break
-- still rehydrates the right state via get_active_focus_session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_session_single_active
  ON focus_session(session_state) WHERE session_state = 'active';
CREATE INDEX IF NOT EXISTS idx_focus_session_started_at ON focus_session(started_at);
"#;

pub fn init(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // WAL mode lets multiple connections to the same file coexist (the
    // frontend's shared connection, the notification thread's, the Google
    // sync thread's) — busy_timeout makes brief writer contention between
    // them wait-and-retry instead of failing immediately with SQLITE_BUSY.
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    migrate_split_last_synced_at(&conn)?;
    migrate_regenerate_device_id(&conn)?;
    migrate_add_obsidian_source_columns(&conn)?;
    migrate_add_location_and_sync_status_columns(&conn)?;
    Ok(conn)
}

/// One-time migration for DBs created before `last_synced_at` was split into
/// per-channel columns (see the comment on `item` above). Safe to run on
/// every startup — it's a no-op once the old column is gone.
fn migrate_split_last_synced_at(conn: &Connection) -> rusqlite::Result<()> {
    let has_old_column: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('item') WHERE name = 'last_synced_at'")?
        .exists([])?;
    if !has_old_column {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE item ADD COLUMN last_synced_at_calendar TEXT;
         ALTER TABLE item ADD COLUMN last_synced_at_tasks TEXT;
         UPDATE item SET last_synced_at_calendar = last_synced_at, last_synced_at_tasks = last_synced_at;
         ALTER TABLE item DROP COLUMN last_synced_at;",
    )
}

/// One-time repair for devices that hit the device_id-collision bug fixed in
/// backup::apply_pending_restore: before that fix, restoring a snapshot to
/// set up a new device (Settings' documented way to "move everything to a
/// new device") copied the source device's `device_id` verbatim, leaving the
/// two devices permanently indistinguishable to check_remote_backup's "skip
/// my own last push" guard — sync would look like "already up to date"
/// forever even for genuinely new data. Updating the code alone doesn't fix
/// an id already inherited that way, so every device gets a fresh,
/// guaranteed-unique `device_id` exactly once here. Harmless for devices
/// that were never affected — it's just a new random identity, and nothing
/// else keys off the specific value.
fn migrate_regenerate_device_id(conn: &Connection) -> rusqlite::Result<()> {
    let already_migrated: bool = conn
        .prepare("SELECT 1 FROM preference WHERE key = 'device_id_migrated_v1'")?
        .exists([])?;
    if already_migrated {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO preference (key, value) VALUES ('device_id', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [Uuid::new_v4().to_string()],
    )?;
    conn.execute(
        "INSERT INTO preference (key, value) VALUES ('device_id_migrated_v1', 'true') \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )?;
    Ok(())
}

/// One-time migration adding the Obsidian source-tracking columns to `item`
/// for DBs created before the Obsidian task scanner existed. `CREATE TABLE IF
/// NOT EXISTS` (in SCHEMA) only helps brand-new databases — an existing
/// `item` table needs these columns added explicitly. Safe to run on every
/// startup: skips the `ALTER TABLE`s once the column exists, and the index
/// creation is separately idempotent (`IF NOT EXISTS`) either way.
fn migrate_add_obsidian_source_columns(conn: &Connection) -> rusqlite::Result<()> {
    let has_column: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('item') WHERE name = 'obsidian_source_id'")?
        .exists([])?;
    if !has_column {
        conn.execute_batch(
            "ALTER TABLE item ADD COLUMN obsidian_source_id TEXT;
             ALTER TABLE item ADD COLUMN obsidian_vault_path TEXT;
             ALTER TABLE item ADD COLUMN obsidian_source_folder TEXT;
             ALTER TABLE item ADD COLUMN obsidian_source_file TEXT;
             ALTER TABLE item ADD COLUMN obsidian_source_section TEXT;",
        )?;
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_item_obsidian_source_id \
         ON item(obsidian_source_id) WHERE obsidian_source_id IS NOT NULL;",
    )
}

/// One-time migration adding `item.location` (Calendar round-trip, see
/// google/sync.rs) and the sync-failure tracking columns (`last_sync_error`,
/// `last_sync_attempted_at`, `sync_failure_count`) for DBs created before
/// they existed. Same idempotent pattern as the other migrate_* functions.
fn migrate_add_location_and_sync_status_columns(conn: &Connection) -> rusqlite::Result<()> {
    let has_column: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('item') WHERE name = 'location'")?
        .exists([])?;
    if !has_column {
        conn.execute_batch(
            "ALTER TABLE item ADD COLUMN location TEXT;
             ALTER TABLE item ADD COLUMN last_sync_error TEXT;
             ALTER TABLE item ADD COLUMN last_sync_attempted_at TEXT;
             ALTER TABLE item ADD COLUMN sync_failure_count INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid as TestUuid;

    fn scratch_db_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("life-os-db-test-{}", TestUuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("life-os.sqlite3")
    }

    fn get_pref(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM preference WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    /// A device that already had another device's `device_id` baked in by
    /// the pre-fix restore bug gets a fresh, unique one on its next launch.
    #[test]
    fn regenerates_an_inherited_device_id_exactly_once() {
        let path = scratch_db_path();
        let conn = init(&path).unwrap();
        // Simulate the pre-fix bug: this device's id collides with another's.
        conn.execute(
            "INSERT INTO preference (key, value) VALUES ('device_id', 'collided-id') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM preference WHERE key = 'device_id_migrated_v1'", [])
            .unwrap();

        migrate_regenerate_device_id(&conn).unwrap();
        let regenerated = get_pref(&conn, "device_id").unwrap();
        assert_ne!(regenerated, "collided-id");

        // Re-running (as happens on every subsequent launch) must not keep
        // reassigning a new id each time.
        migrate_regenerate_device_id(&conn).unwrap();
        assert_eq!(get_pref(&conn, "device_id").unwrap(), regenerated);
    }
}
