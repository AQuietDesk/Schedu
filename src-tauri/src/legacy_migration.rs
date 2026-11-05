//! One-time move of local data from the app's old ID.
//!
//! The app ID decides the data folder (`%APPDATA%\<id>`). v0.4 moved to
//! `app.schedu.desktop`, so on the first launch under the new ID the data
//! folder is empty while the old one still holds everything. This copies it
//! across before anything opens the database.
//!
//! The old folder is found by what it holds (a sibling folder with this app's
//! database file), not by its name, so no earlier ID needs to live in the code.
//!
//! The old folder is left exactly as it was: if the copy fails partway, the
//! next launch tries again, and nothing is ever deleted that can't be recovered.

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const DB_FILE: &str = "life-os.sqlite3";

/// Files that sit next to the database and are worth keeping. The restore
/// safety copy is the only one: a pending restore is applied in the old folder
/// before copying, so its staging files never need to move.
const SIDE_FILES: &[&str] = &["life-os.sqlite3.before-restore"];

/// The sibling of `new_dir` whose database was written most recently.
fn legacy_dir(new_dir: &Path) -> Option<PathBuf> {
    let modified = |dir: &Path| -> Option<SystemTime> {
        // The WAL is written before the main file, so check both.
        [DB_FILE, "life-os.sqlite3-wal"]
            .iter()
            .filter_map(|f| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok())
            .max()
    };
    std::fs::read_dir(new_dir.parent()?)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p != new_dir && p.join(DB_FILE).is_file())
        .filter_map(|p| modified(&p).map(|t| (t, p)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

/// The old ID's database, if there is one. Used as a fallback for one run
/// when copying it across fails.
pub fn legacy_db_path(new_dir: &Path) -> Option<PathBuf> {
    let db = legacy_dir(new_dir)?.join(DB_FILE);
    db.exists().then_some(db)
}

/// Copies the old ID's data into `new_dir` if `new_dir` has no database yet.
/// Returns whether anything was copied.
pub fn migrate_from_legacy_dir(new_dir: &Path) -> Result<bool, String> {
    match legacy_dir(new_dir) {
        Some(old_dir) => migrate_between(&old_dir, new_dir),
        None => Ok(false),
    }
}

fn migrate_between(old_dir: &Path, new_dir: &Path) -> Result<bool, String> {
    let new_db = new_dir.join(DB_FILE);
    let old_db = old_dir.join(DB_FILE);
    if new_db.exists() || !old_db.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(new_dir).map_err(|e| e.to_string())?;

    // A restore the old build staged but never got to apply would otherwise be
    // lost (its marker holds an absolute path into the old folder).
    crate::backup::apply_pending_restore(&old_db);

    // VACUUM INTO folds the WAL in and writes one consistent file, the same way
    // backups are taken; copying the raw .sqlite3/-wal/-shm trio could tear.
    // It goes to a temp name first so a half-written copy never looks finished.
    let tmp = new_dir.join(format!("{DB_FILE}.migrating"));
    let _ = std::fs::remove_file(&tmp);
    {
        let src = Connection::open(&old_db).map_err(|e| e.to_string())?;
        src.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &new_db).map_err(|e| e.to_string())?;

    for name in SIDE_FILES {
        let from = old_dir.join(name);
        if from.exists() {
            std::fs::copy(&from, new_dir.join(name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn scratch_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("schedu-migrate-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn item_count(db: &Path) -> i64 {
        Connection::open(db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM preference WHERE key = 'migration_marker'", [], |r| r.get(0))
            .unwrap()
    }

    fn seed_old_db(old_dir: &Path) {
        std::fs::create_dir_all(old_dir).unwrap();
        let conn = crate::db::init(&old_dir.join(DB_FILE)).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO preference (key, value) VALUES ('migration_marker', 'kept')",
            [],
        )
        .unwrap();
        // Connection stays open (WAL not checkpointed) like a live old install.
        std::mem::forget(conn);
    }

    #[test]
    fn copies_db_and_safety_copy_and_leaves_old_folder_alone() {
        let root = scratch_root();
        let old_dir = root.join("old.app.id");
        let new_dir = root.join("app.schedu.desktop");
        seed_old_db(&old_dir);
        std::fs::write(old_dir.join("life-os.sqlite3.before-restore"), b"safety").unwrap();

        assert!(migrate_from_legacy_dir(&new_dir).unwrap());
        assert_eq!(item_count(&new_dir.join(DB_FILE)), 1);
        assert_eq!(
            std::fs::read(new_dir.join("life-os.sqlite3.before-restore")).unwrap(),
            b"safety"
        );
        assert!(!new_dir.join(format!("{DB_FILE}.migrating")).exists());
        assert_eq!(item_count(&old_dir.join(DB_FILE)), 1, "old data must stay");
    }

    #[test]
    fn does_nothing_once_the_new_folder_has_a_database() {
        let root = scratch_root();
        let old_dir = root.join("old.app.id");
        let new_dir = root.join("app.schedu.desktop");
        seed_old_db(&old_dir);
        std::fs::create_dir_all(&new_dir).unwrap();
        crate::db::init(&new_dir.join(DB_FILE)).unwrap();

        assert!(!migrate_from_legacy_dir(&new_dir).unwrap());
        assert_eq!(item_count(&new_dir.join(DB_FILE)), 0);
    }

    #[test]
    fn picks_the_most_recent_sibling_and_ignores_unrelated_folders() {
        let root = scratch_root();
        std::fs::create_dir_all(root.join("some.other.app")).unwrap();
        std::fs::write(root.join("some.other.app").join("settings.json"), b"{}").unwrap();
        let stale = root.join("older.app.id");
        std::fs::create_dir_all(&stale).unwrap();
        crate::db::init(&stale.join(DB_FILE)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let old_dir = root.join("old.app.id");
        seed_old_db(&old_dir);
        let new_dir = root.join("app.schedu.desktop");

        assert!(migrate_from_legacy_dir(&new_dir).unwrap());
        assert_eq!(item_count(&new_dir.join(DB_FILE)), 1, "should copy the newer folder");
    }

    #[test]
    fn does_nothing_on_a_clean_install() {
        let root = scratch_root();
        let new_dir = root.join("app.schedu.desktop");
        assert!(!migrate_from_legacy_dir(&new_dir).unwrap());
        assert!(!new_dir.join(DB_FILE).exists());
    }
}
