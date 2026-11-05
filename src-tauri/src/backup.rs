use crate::db::DbPathState;
use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, State};
use uuid::Uuid;

const CHECK_INTERVAL: Duration = Duration::from_secs(60);
const QUIET_PERIOD: chrono::Duration = chrono::Duration::minutes(5);

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

/// Stable per-install identifier, generated once and copied verbatim into
/// every backup snapshot (VACUUM INTO copies the whole `preference` table
/// as-is) — this is how a device recognizes "that's my own backup" and
/// skips prompting to restore its own just-pushed snapshot back onto itself.
fn ensure_device_id(conn: &Connection) -> String {
    if let Some(id) = get_pref(conn, "device_id") {
        return id;
    }
    let id = Uuid::new_v4().to_string();
    set_pref(conn, "device_id", &id);
    id
}

fn backup_path(folder: &str) -> PathBuf {
    Path::new(folder).join("life-os-backup.sqlite3")
}

/// Snapshots the whole DB to `<folder>/life-os-backup.sqlite3` via SQLite's
/// own VACUUM INTO — safe to run against a live WAL-mode connection, unlike
/// copying the raw .sqlite3/-wal/-shm files by hand, which can race a
/// concurrent writer and produce an inconsistent copy. There's no cloud
/// backend by design, so pointing `folder` at a Drive/Dropbox/OneDrive
/// folder is what gives this its actual off-machine safety net.
pub fn run_backup(conn: &Connection, folder: &str) -> Result<(), String> {
    if folder.trim().is_empty() {
        return Err("No backup folder configured".to_string());
    }
    ensure_device_id(conn);
    // Set *before* VACUUM INTO so the snapshot's own copy of this row already
    // reflects the exact moment it was taken. Setting it after would leave
    // the file that lands in the shared folder carrying the *previous*
    // backup's timestamp, and the other device's "is this newer than what
    // I've already seen" check (check_remote_backup, below) would then never
    // recognize it as new.
    set_pref(conn, "last_backup_at", &Utc::now().to_rfc3339());
    let dest = backup_path(folder);
    // Snapshot to a temp file first and rename into place: deleting `dest` up
    // front meant a failed VACUUM (disk full, folder gone) destroyed the last
    // good backup, and a cloud client could upload a half-written file.
    let tmp = dest.with_extension("sqlite3.tmp");
    let _ = std::fs::remove_file(&tmp); // VACUUM INTO refuses to write over an existing file
    conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy()])
        .and_then(|_| strip_secrets(&tmp))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
    if dest.exists() {
        // One generation of history, in case a bad push overwrites a good one.
        let previous = previous_backup_path(folder);
        if std::fs::rename(&dest, &previous).is_ok() && strip_secrets(&previous).is_err() {
            // Snapshots from before secrets were stripped may still carry them;
            // better no history than a credential left in the shared folder.
            let _ = std::fs::remove_file(&previous);
        }
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

/// Per-device credentials that must never land in the shared folder: anyone
/// with access to it (or a cloud provider breach) would get the user's Google
/// account. Each device signs in on its own; `apply_pending_restore` keeps the
/// local copies across a restore so loading a snapshot doesn't sign it out.
const SECRET_PREFS: [&str; 3] = [
    "google_access_token",
    "google_refresh_token",
    "google_token_expiry",
];

/// Removes `SECRET_PREFS` from a snapshot file. Switches it to rollback-journal
/// mode first so the edit can't leave -wal/-shm sidecars in the shared folder.
fn strip_secrets(snapshot: &Path) -> rusqlite::Result<()> {
    let conn = Connection::open(snapshot)?;
    conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
    for key in SECRET_PREFS {
        conn.execute("DELETE FROM preference WHERE key = ?1", params![key])?;
    }
    Ok(())
}

fn previous_backup_path(folder: &str) -> PathBuf {
    Path::new(folder).join("life-os-backup.previous.sqlite3")
}

/// Latest timestamp across the tables a user actually edits day-to-day.
fn parse_rfc3339(s: Option<String>) -> Option<chrono::DateTime<Utc>> {
    s.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .map(|d| d.with_timezone(&Utc))
}

/// Pure decision logic (no I/O), kept separate from `tick` so it can be unit
/// tested directly against fixed timestamps — the same split google::sync
/// uses for `decide_pull_action`.
///
/// `last_activity_at` comes from `preference.last_activity_at`, which every
/// mutating command touches (see commands::touch_activity) — deliberately
/// *not* derived by scanning table timestamp columns, which is what this
/// replaced: `context` (Class/Project/Program) has no timestamp columns of
/// its own, so that approach silently never counted editing a class as
/// "activity," and the automatic backup could go stale for that data
/// specifically. An explicit touch-on-write doesn't have that blind spot,
/// for this table or any future one.
fn is_backup_due(
    now: chrono::DateTime<Utc>,
    last_backup_at: Option<chrono::DateTime<Utc>>,
    last_activity_at: Option<chrono::DateTime<Utc>>,
    interval_hours: i64,
) -> bool {
    let interval_due = match last_backup_at {
        Some(last) => now - last >= chrono::Duration::hours(interval_hours),
        None => true,
    };

    // Backs up roughly QUIET_PERIOD after the user stops editing, in addition
    // to the fixed interval above, so the shared folder is rarely more than a
    // few minutes stale for whichever device picks it up next (see
    // check_remote_backup / restore_from_backup).
    let activity_due = match (last_activity_at, last_backup_at) {
        (Some(activity), Some(last)) if activity > last => now - activity >= QUIET_PERIOD,
        (Some(_), None) => true,
        _ => false,
    };

    interval_due || activity_due
}

fn tick(conn: &Connection) {
    let Some(folder) = get_pref(conn, "backup_folder_path").filter(|f| !f.trim().is_empty()) else {
        return; // not configured yet
    };
    let interval_hours: i64 = get_pref(conn, "backup_interval_hours")
        .and_then(|v| v.parse().ok())
        .unwrap_or(24);
    let last_backup_at = parse_rfc3339(get_pref(conn, "last_backup_at"));
    let last_activity_at = parse_rfc3339(get_pref(conn, "last_activity_at"));

    // Another device's snapshot the user hasn't loaded or dismissed yet: pushing
    // now would overwrite it unseen. Hold off until the prompt is resolved.
    if check_remote_backup_impl(conn, &folder).is_some() {
        return;
    }

    if is_backup_due(Utc::now(), last_backup_at, last_activity_at, interval_hours) {
        if let Err(e) = run_backup(conn, &folder) {
            eprintln!("[backup] failed: {e}");
        }
    }
}

/// Runs on its own OS thread with its own SQLite connection, matching
/// notifications::spawn / google::sync::spawn. Polls once a minute (rather
/// than sleeping a full interval) so both the daily fallback and the
/// activity-quiet-period backup fire promptly once they're actually due.
pub fn spawn(db_path: PathBuf) {
    std::thread::spawn(move || {
        let conn = match crate::db::init(&db_path) {
            Ok(c) => c,
            Err(_) => return,
        };
        loop {
            tick(&conn);
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

#[tauri::command]
pub fn backup_now(state: State<DbPathState>) -> Result<(), String> {
    let conn = crate::db::init(&state.0).map_err(|e| e.to_string())?;
    let folder = get_pref(&conn, "backup_folder_path").unwrap_or_default();
    run_backup(&conn, &folder)
}

#[derive(Serialize)]
pub struct RemoteBackupStatus {
    pub written_at: String,
}

/// Opens the shared-folder snapshot read-only (never writes to it, never
/// creates -wal/-shm sidecars for it) and compares its embedded
/// `last_backup_at`/`device_id` against what this device has already seen.
/// Returns `Ok(None)` for every "nothing to do" case (no folder configured,
/// no file yet, it's this device's own last push, or it's a snapshot already
/// offered and dismissed) rather than an error — a cloud client mid-download
/// or a stale/partial file is an expected, transient state here, not a
/// failure worth surfacing to the UI.
/// Free of Tauri's `State`/command plumbing so it can be exercised directly
/// against real temp files in tests, the same way google::sync separates its
/// decision logic from the command wrapper around it.
fn check_remote_backup_impl(local: &Connection, folder: &str) -> Option<RemoteBackupStatus> {
    if folder.trim().is_empty() {
        return None;
    }
    let local_device_id = ensure_device_id(local);
    let last_remote_seen_at = get_pref(local, "last_remote_seen_at").unwrap_or_default();

    let path = backup_path(folder);
    if !path.exists() {
        return None;
    }
    let remote = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let remote_device_id = get_pref(&remote, "device_id")?;
    let remote_written_at = get_pref(&remote, "last_backup_at")?;

    if remote_device_id == local_device_id {
        // A matching id alone doesn't prove it's our own push: two installs can
        // end up sharing one (e.g. one was set up by restoring the other's
        // snapshot before apply_pending_restore preserved device_id), and then
        // every push from either side looks like "ours" and is never offered.
        // Our own push always carries exactly our last_backup_at, so a snapshot
        // newer than anything we've written came from another device — take a
        // fresh id so the two stop colliding, and offer it like any other.
        let local_written_at = parse_rfc3339(get_pref(local, "last_backup_at"));
        let is_newer_than_ours = match (parse_rfc3339(Some(remote_written_at.clone())), local_written_at) {
            (Some(remote), Some(ours)) => remote > ours,
            (Some(_), None) => true,
            _ => false,
        };
        if !is_newer_than_ours {
            return None; // our own last push (or an older one of ours)
        }
        set_pref(local, "device_id", &Uuid::new_v4().to_string());
    }
    if remote_written_at <= last_remote_seen_at {
        return None; // already offered (and either accepted or dismissed)
    }
    if get_pref(local, "last_backup_at").as_deref() == Some(remote_written_at.as_str()) {
        return None; // that exact snapshot is what's already loaded here
    }
    Some(RemoteBackupStatus {
        written_at: remote_written_at,
    })
}

#[tauri::command]
pub fn check_remote_backup(
    state: State<DbPathState>,
) -> Result<Option<RemoteBackupStatus>, String> {
    let local = crate::db::init(&state.0).map_err(|e| e.to_string())?;
    let folder = get_pref(&local, "backup_folder_path").unwrap_or_default();
    Ok(check_remote_backup_impl(&local, &folder))
}

/// Records that the user has been offered this snapshot — whether they
/// loaded it or chose "keep local" — so check_remote_backup stops
/// re-prompting for the same one on every poll/launch.
#[tauri::command]
pub fn dismiss_remote_backup(state: State<DbPathState>, written_at: String) -> Result<(), String> {
    let conn = crate::db::init(&state.0).map_err(|e| e.to_string())?;
    set_pref(&conn, "last_remote_seen_at", &written_at);
    Ok(())
}

/// Stages the shared-folder snapshot next to the live DB and marks it for
/// the *next* launch to pick up, then restarts the app. Applying it live
/// right now would mean swapping the file out from under this process's own
/// open connection plus the notifications/Google-sync/backup threads'
/// independent connections; a restart sidesteps that entirely — the marker
/// is applied in `lib.rs` (`apply_pending_restore`) before any connection to
/// the file is opened for the new run.
/// Stages the shared-folder snapshot and writes the marker `apply_pending_restore`
/// looks for, without touching Tauri's `State`/`AppHandle` — kept separate so
/// the staging step can be tested directly, and so the (untestable, process-
/// exiting) `app.restart()` call is the last thing the command wrapper does.
fn stage_restore(db_path: &Path, folder: &str, written_at: &str) -> Result<(), String> {
    let remote_path = backup_path(folder);
    let remote = Connection::open_with_flags(&remote_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let actual_written_at = get_pref(&remote, "last_backup_at").unwrap_or_default();
    drop(remote);
    if actual_written_at != written_at {
        return Err(
            "The backup in the shared folder changed since it was found — try again.".to_string(),
        );
    }

    let staging_path = db_path.with_extension("sqlite3.incoming");
    std::fs::copy(&remote_path, &staging_path).map_err(|e| e.to_string())?;
    let marker_path = db_path.with_extension("sqlite3.pending-restore");
    std::fs::write(&marker_path, staging_path.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn restore_from_backup(
    app: AppHandle,
    state: State<DbPathState>,
    written_at: String,
) -> Result<(), String> {
    let db_path = state.0.clone();
    let conn = crate::db::init(&db_path).map_err(|e| e.to_string())?;
    let folder = get_pref(&conn, "backup_folder_path").unwrap_or_default();
    set_pref(&conn, "last_remote_seen_at", &written_at);
    drop(conn);

    stage_restore(&db_path, &folder, &written_at)?;
    app.restart();
}

/// If `restore_from_backup` staged a snapshot on the previous run, swap it
/// into place now — called from `lib.rs::setup()` before any connection to
/// `db_path` exists for this process, which is what makes the swap safe: no
/// live connection or background thread has the old file open to be confused
/// by it disappearing out from under them mid-run.
///
/// Preserves this device's own `device_id` across the swap rather than
/// letting the restored snapshot's copy win. Without this, a device set up
/// by restoring someone else's backup (the Settings copy literally
/// recommends this as "how to move everything to a new device") ends up with
/// the *source* device's `device_id`, since VACUUM INTO copies the whole
/// `preference` table verbatim. From then on this device and the one it
/// restored from are indistinguishable to check_remote_backup's "skip if
/// it's my own last push" guard, so every future push from either side gets
/// silently treated as the other's own and never offered — sync looks like
/// it "already up to date" forever, even though real data is going stale.
pub fn apply_pending_restore(db_path: &Path) {
    let marker_path = db_path.with_extension("sqlite3.pending-restore");
    let Ok(staged) = std::fs::read_to_string(&marker_path) else {
        return;
    };
    let staged_path = PathBuf::from(staged.trim());
    if staged_path.exists() {
        let (local_device_id, local_secrets) = Connection::open(db_path)
            .ok()
            .map(|c| {
                // Keep the about-to-be-replaced data recoverable (VACUUM INTO reads
                // the WAL too, unlike copying the bare file).
                let safety = db_path.with_extension("sqlite3.before-restore");
                let _ = std::fs::remove_file(&safety);
                let _ = c.execute("VACUUM INTO ?1", params![safety.to_string_lossy()]);
                let secrets: Vec<(&str, String)> = SECRET_PREFS
                    .into_iter()
                    .filter_map(|k| get_pref(&c, k).map(|v| (k, v)))
                    .collect();
                (get_pref(&c, "device_id"), secrets)
            })
            .unwrap_or_default();

        let _ = std::fs::remove_file(db_path);
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-shm"));
        let _ = std::fs::rename(&staged_path, db_path);

        if let Ok(conn) = Connection::open(db_path) {
            let id = local_device_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            set_pref(&conn, "device_id", &id);
            // restore_from_backup marked this snapshot seen in the DB we just
            // replaced; the restored file carries the source device's own
            // last_remote_seen_at instead, which would re-offer the very
            // snapshot that's now loaded on every launch.
            if let Some(written_at) = get_pref(&conn, "last_backup_at") {
                set_pref(&conn, "last_remote_seen_at", &written_at);
            }
            // Snapshots carry no credentials (see strip_secrets); put this
            // device's own back so the restore doesn't sign it out of Google.
            for (key, value) in &local_secrets {
                set_pref(&conn, key, value);
            }
        }
    }
    let _ = std::fs::remove_file(&marker_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh, uniquely-named scratch directory under the OS temp dir — each
    /// test gets its own so `cargo test`'s parallel execution can't collide.
    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("life-os-backup-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn insert_marker_item(conn: &Connection, id: &str, title: &str) {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO item (id, title, category, created_at, updated_at) VALUES (?1, ?2, 'Personal', ?3, ?3)",
            params![id, title, now],
        )
        .unwrap();
    }

    fn t(minute: u32) -> chrono::DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(2026, 1, 1, 12, minute, 0).unwrap()
    }

    #[test]
    fn never_backed_up_before_is_always_due() {
        assert!(is_backup_due(t(0), None, None, 24));
    }

    #[test]
    fn quiet_period_not_yet_elapsed_is_not_due() {
        let last_backup = t(0);
        let activity = t(1); // changed 1 minute after the last backup
        let now = t(4); // only 4 minutes since that change — QUIET_PERIOD is 5
        assert!(!is_backup_due(now, Some(last_backup), Some(activity), 24));
    }

    #[test]
    fn quiet_period_elapsed_since_activity_is_due() {
        let last_backup = t(0);
        let activity = t(1);
        let now = t(10); // 9 minutes of quiet since the change
        assert!(is_backup_due(now, Some(last_backup), Some(activity), 24));
    }

    #[test]
    fn activity_at_or_before_last_backup_does_not_force_a_backup() {
        // Nothing changed since the last backup — the daily interval alone governs.
        let last_backup = t(10);
        let activity = t(5); // stale — predates the last backup
        let now = t(30);
        assert!(!is_backup_due(now, Some(last_backup), Some(activity), 24));
    }

    #[test]
    fn daily_interval_forces_a_backup_even_without_activity() {
        let last_backup = t(0);
        let now = last_backup + chrono::Duration::hours(25);
        assert!(is_backup_due(now, Some(last_backup), None, 24));
    }

    /// Regression test for the reported bug: creating a Class (a `context`
    /// row) alone must mark activity, even though that table has no
    /// timestamp columns of its own to be scanned for. This exercises
    /// commands::touch_activity directly against a real DB, not just
    /// is_backup_due's pure logic above.
    #[test]
    fn creating_a_context_alone_counts_as_activity() {
        let conn = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        conn.execute(
            "INSERT INTO context (id, type, name) VALUES ('ctx-1', 'Class', 'CS 101')",
            [],
        )
        .unwrap();
        assert!(get_pref(&conn, "last_activity_at").is_none()); // not touched yet

        crate::commands::touch_activity(&conn);

        let last_activity_at = get_pref(&conn, "last_activity_at");
        assert!(last_activity_at.is_some());
        // With no backup yet at all, that alone should make a backup due.
        assert!(is_backup_due(
            Utc::now(),
            None,
            parse_rfc3339(last_activity_at),
            24
        ));
    }

    #[test]
    fn check_remote_backup_sees_another_devices_push_but_not_its_own() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();

        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        let b = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();

        run_backup(&a, &folder).expect("backup should succeed");

        // The device that just pushed shouldn't be offered its own backup back.
        assert!(check_remote_backup_impl(&a, &folder).is_none());

        // A different device should see it as new.
        let status = check_remote_backup_impl(&b, &folder).expect("b should see a's push");
        assert_eq!(status.written_at, get_pref(&a, "last_backup_at").unwrap());

        // Once dismissed (or restored — restore_from_backup sets the same
        // pref before staging), the same snapshot shouldn't resurface.
        set_pref(&b, "last_remote_seen_at", &status.written_at);
        assert!(check_remote_backup_impl(&b, &folder).is_none());
    }

    #[test]
    fn stage_restore_and_apply_pending_restore_replace_local_db_with_remote_snapshot() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();

        let a_dir = scratch_dir();
        let a_db_path = a_dir.join("life-os.sqlite3");
        let a = crate::db::init(&a_db_path).unwrap();
        insert_marker_item(&a, "item-a", "From device A");
        run_backup(&a, &folder).unwrap();
        let written_at = get_pref(&a, "last_backup_at").unwrap();
        let a_device_id = get_pref(&a, "device_id").unwrap();
        drop(a);

        let b_dir = scratch_dir();
        let b_db_path = b_dir.join("life-os.sqlite3");
        let b = crate::db::init(&b_db_path).unwrap();
        insert_marker_item(&b, "item-b", "From device B, should be gone after restore");
        let b_device_id = ensure_device_id(&b);
        drop(b);

        stage_restore(&b_db_path, &folder, &written_at).expect("staging should succeed");
        apply_pending_restore(&b_db_path);

        let restored = crate::db::init(&b_db_path).unwrap();
        // The data comes from A's snapshot...
        let titles: Vec<String> = restored
            .prepare("SELECT title FROM item ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(titles, vec!["From device A".to_string()]);
        // ...but B keeps its own device identity rather than adopting A's,
        // otherwise every future push from either device would look like
        // "my own last push" to the other and never sync again (see the
        // regression test below).
        assert_ne!(get_pref(&restored, "device_id").unwrap(), a_device_id);
        assert_eq!(get_pref(&restored, "device_id").unwrap(), b_device_id);
        // ...and the snapshot it just loaded isn't offered again after the restart.
        assert_eq!(get_pref(&restored, "last_remote_seen_at").unwrap(), written_at);
        assert!(check_remote_backup_impl(&restored, &folder).is_none());
    }

    /// Regression test for the reported bug: a device set up by restoring
    /// another device's backup (the Settings copy calls this out as "how to
    /// move everything to a new device") must still see that other device's
    /// *later* pushes as new, rather than being stuck at "already up to
    /// date" forever because it inherited that device's `device_id`.
    #[test]
    fn syncing_still_works_after_restoring_to_set_up_a_new_device() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();

        let a_db_path = scratch_dir().join("life-os.sqlite3");
        let a = crate::db::init(&a_db_path).unwrap();
        insert_marker_item(&a, "item-1", "First class");
        run_backup(&a, &folder).unwrap();
        let first_written_at = get_pref(&a, "last_backup_at").unwrap();
        drop(a);

        // B is set up fresh, then immediately restores A's snapshot to move
        // everything over — the documented new-device flow.
        let b_db_path = scratch_dir().join("life-os.sqlite3");
        crate::db::init(&b_db_path).unwrap();
        stage_restore(&b_db_path, &folder, &first_written_at).expect("staging should succeed");
        apply_pending_restore(&b_db_path);
        let b = crate::db::init(&b_db_path).unwrap();
        set_pref(&b, "last_remote_seen_at", &first_written_at); // restore_from_backup does this too
        drop(b);

        // Later, A adds another class and backs up again.
        let a = crate::db::init(&a_db_path).unwrap();
        insert_marker_item(&a, "item-2", "Second class");
        run_backup(&a, &folder).unwrap();
        let second_written_at = get_pref(&a, "last_backup_at").unwrap();
        assert_ne!(first_written_at, second_written_at);

        // B should see it as new, not silently skip it as its own.
        let b = crate::db::init(&b_db_path).unwrap();
        let status = check_remote_backup_impl(&b, &folder)
            .expect("b should still detect a's later push after the earlier restore");
        assert_eq!(status.written_at, second_written_at);
    }

    /// Two installs that already share a device_id (from a restore made before
    /// apply_pending_restore preserved it) must still see each other's pushes.
    #[test]
    fn devices_sharing_a_device_id_still_see_each_others_pushes() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();

        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        let b = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        let shared_id = ensure_device_id(&a);
        set_pref(&b, "device_id", &shared_id);

        run_backup(&b, &folder).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        insert_marker_item(&a, "item-1", "Only on A");
        run_backup(&a, &folder).unwrap();

        // A's own push is still not offered back to A.
        assert!(check_remote_backup_impl(&a, &folder).is_none());

        // B's last push is older than A's snapshot, so it isn't B's own.
        let status = check_remote_backup_impl(&b, &folder).expect("b should see a's push despite the shared id");
        assert_eq!(status.written_at, get_pref(&a, "last_backup_at").unwrap());
        assert_ne!(get_pref(&b, "device_id").unwrap(), shared_id, "b should take a fresh id");

        // After B pushes with its new id, A sees B's push too.
        set_pref(&b, "last_remote_seen_at", &status.written_at);
        std::thread::sleep(Duration::from_millis(5));
        run_backup(&b, &folder).unwrap();
        assert!(check_remote_backup_impl(&a, &folder).is_some());
    }

    #[test]
    fn a_second_push_keeps_the_first_as_previous_and_leaves_no_temp_file() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();
        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();

        run_backup(&a, &folder).unwrap();
        let first = get_pref(&a, "last_backup_at").unwrap();
        run_backup(&a, &folder).unwrap();
        let second = get_pref(&a, "last_backup_at").unwrap();
        assert_ne!(first, second);

        let open =
            |p: PathBuf| Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let prev = open(previous_backup_path(&folder));
        assert_eq!(get_pref(&prev, "last_backup_at").unwrap(), first);
        let current = open(backup_path(&folder));
        assert_eq!(get_pref(&current, "last_backup_at").unwrap(), second);
        assert!(!backup_path(&folder).with_extension("sqlite3.tmp").exists());
    }

    fn seed_secrets(conn: &Connection, suffix: &str) {
        for key in SECRET_PREFS {
            set_pref(conn, key, &format!("{key}-{suffix}"));
        }
    }

    #[test]
    fn snapshots_never_contain_google_credentials_but_local_db_keeps_them() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();
        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        seed_secrets(&a, "a");

        // A snapshot written by an older build still has them; the next push
        // rotates it into `.previous`, which must be scrubbed as well.
        a.execute(
            "VACUUM INTO ?1",
            params![backup_path(&folder).to_string_lossy()],
        )
        .unwrap();
        run_backup(&a, &folder).unwrap();

        let open =
            |p: PathBuf| Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        for path in [backup_path(&folder), previous_backup_path(&folder)] {
            let snap = open(path);
            for key in SECRET_PREFS {
                assert!(
                    get_pref(&snap, key).is_none(),
                    "{key} leaked into the shared folder"
                );
            }
            assert!(get_pref(&snap, "device_id").is_some()); // the rest of the prefs survive
        }
        for key in SECRET_PREFS {
            assert_eq!(get_pref(&a, key).unwrap(), format!("{key}-a")); // live DB untouched
        }
        let sidecars = std::fs::read_dir(&folder)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.ends_with("-wal") || n.ends_with("-shm") || n.ends_with(".tmp")
            })
            .count();
        assert_eq!(sidecars, 0);
    }

    #[test]
    fn restore_keeps_this_devices_own_google_credentials() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();
        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        seed_secrets(&a, "a");
        run_backup(&a, &folder).unwrap();
        let written_at = get_pref(&a, "last_backup_at").unwrap();

        let b_db_path = scratch_dir().join("life-os.sqlite3");
        let b = crate::db::init(&b_db_path).unwrap();
        seed_secrets(&b, "b");
        drop(b);

        stage_restore(&b_db_path, &folder, &written_at).unwrap();
        apply_pending_restore(&b_db_path);

        let restored = crate::db::init(&b_db_path).unwrap();
        for key in SECRET_PREFS {
            assert_eq!(get_pref(&restored, key).unwrap(), format!("{key}-b"));
        }
    }

    #[test]
    fn automatic_backup_does_not_overwrite_another_devices_unseen_snapshot() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();
        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        run_backup(&a, &folder).unwrap();
        let a_written_at = get_pref(&a, "last_backup_at").unwrap();

        // B has never backed up (so a push is due) but hasn't seen A's snapshot.
        let b = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        set_pref(&b, "backup_folder_path", &folder);
        tick(&b);
        let remote =
            Connection::open_with_flags(backup_path(&folder), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(get_pref(&remote, "last_backup_at").unwrap(), a_written_at);
        assert!(get_pref(&b, "last_backup_at").is_none());

        // Once B has dismissed it, B's automatic push goes through.
        set_pref(&b, "last_remote_seen_at", &a_written_at);
        tick(&b);
        assert!(get_pref(&b, "last_backup_at").is_some());
    }

    #[test]
    fn restore_keeps_a_copy_of_the_local_data_it_replaces() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();
        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        run_backup(&a, &folder).unwrap();
        let written_at = get_pref(&a, "last_backup_at").unwrap();

        let b_db_path = scratch_dir().join("life-os.sqlite3");
        let b = crate::db::init(&b_db_path).unwrap();
        insert_marker_item(&b, "item-b", "Unsynced local edit");
        drop(b);

        stage_restore(&b_db_path, &folder, &written_at).unwrap();
        apply_pending_restore(&b_db_path);

        let safety = Connection::open(b_db_path.with_extension("sqlite3.before-restore")).unwrap();
        let title: String = safety
            .query_row("SELECT title FROM item WHERE id = 'item-b'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Unsynced local edit");
    }

    #[test]
    fn stage_restore_rejects_a_snapshot_that_changed_since_it_was_found() {
        let shared = scratch_dir();
        let folder = shared.to_string_lossy().to_string();
        let a = crate::db::init(&scratch_dir().join("life-os.sqlite3")).unwrap();
        run_backup(&a, &folder).unwrap();

        let b_db_path = scratch_dir().join("life-os.sqlite3");
        let err = stage_restore(&b_db_path, &folder, "2020-01-01T00:00:00Z")
            .expect_err("stale written_at should be rejected");
        assert!(err.contains("changed since it was found"));
    }
}
