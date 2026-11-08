mod backup;
mod commands;
mod db;
mod demo;
mod focus;
mod google;
mod intake;
mod license;
mod legacy_migration;
mod models;
mod notifications;
mod obsidian_tasks;
mod pro;
mod search;
mod secrets;

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;

/// Arg the autostart plugin re-launches the app with at login (see the
/// plugin::init call below) — lets setup() tell "the user double-clicked the
/// icon" apart from "Windows started this at login," so autostart can open
/// straight to the tray instead of popping a window every login.
const AUTOSTART_ARG: &str = "--autostart";

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn enable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    app.autolaunch().enable().map_err(|e| e.to_string())
}

#[tauri::command]
fn disable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    app.autolaunch().disable().map_err(|e| e.to_string())
}

/// Checks the GitHub Releases `latest.json` (see tauri.conf.json's updater
/// endpoint) for a newer signed build. Fully silent by design: no dialog,
/// no progress UI — if a newer version exists it's downloaded, installed,
/// and the app restarts itself onto it without asking. Only tagged releases
/// (see .github/workflows/release.yml) ever appear here, so this can't pick
/// up an untagged/broken commit from main.
async fn check_for_update(app: tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            eprintln!("updater unavailable: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                eprintln!("update download/install failed: {e}");
                return;
            }
            app.restart();
        }
        Ok(None) => {}
        Err(e) => eprintln!("update check failed: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered (Tauri requirement) — without this,
        // double-clicking the icon (or an OS "start" shortcut) while the app is
        // already running in the tray spawns a second process pointed at the same
        // WebView2 profile folder. That second WebView2 environment fails to
        // initialize (profile lock contention) and can leave orphaned
        // msedgewebview2.exe processes behind, which then block the *next* launch
        // too — the app looks alive in Task Manager but never renders a window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            // First launch under the new app ID: bring the old ID's data over
            // before anything opens the database. If that fails, run from the
            // old folder this time instead of starting on an empty database
            // (which would also stop the next launch from retrying).
            let demo = demo::enabled();
            let db_path = if demo {
                // Its own folder, so a demo run never reads or changes real data.
                let demo_dir = app_data_dir.join("demo");
                std::fs::create_dir_all(&demo_dir)?;
                demo_dir.join(legacy_migration::DB_FILE)
            } else {
                match legacy_migration::migrate_from_legacy_dir(&app_data_dir) {
                    Ok(_) => app_data_dir.join(legacy_migration::DB_FILE),
                    Err(e) => {
                        eprintln!("moving data from the old app folder failed: {e}");
                        legacy_migration::legacy_db_path(&app_data_dir)
                            .unwrap_or_else(|| app_data_dir.join(legacy_migration::DB_FILE))
                    }
                }
            };
            backup::apply_pending_restore(&db_path);
            let conn = db::init(&db_path)?;
            if demo {
                demo::seed_if_empty(&conn)?;
            }
            app.manage(db::DbState(Mutex::new(conn)));
            app.manage(db::DbPathState(db_path.clone()));

            // The window starts hidden (tauri.conf.json's `visible: false`) so
            // an autostart-triggered launch can go straight to the tray; any
            // other launch (double-clicking the icon, the OS "start" shortcut)
            // shows it immediately, same as before this was added.
            let launched_at_login = std::env::args().any(|a| a == AUTOSTART_ARG);
            if !launched_at_login {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Show Schedu", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            notifications::spawn(app.handle().clone());
            let (sync_trigger, push_debouncer) = google::sync::spawn(app.handle().clone(), db_path.clone());
            app.manage(sync_trigger);
            app.manage(push_debouncer);
            backup::spawn(db_path.clone());
            license::spawn_background_check();

            // Silent update check on every launch (autostart or manual) — see
            // check_for_update below. Errors (offline, no release yet, etc.)
            // are swallowed: a failed check should never block startup.
            tauri::async_runtime::spawn(check_for_update(app.handle().clone()));

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide instead of closing so the tray/background process (and
            // its scheduled notifications) keeps running with the window closed.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_item,
            commands::update_item,
            commands::soft_delete_item,
            commands::list_items,
            commands::create_context,
            commands::update_context,
            commands::list_contexts,
            commands::create_quick_note,
            commands::list_quick_notes,
            commands::delete_quick_note,
            commands::create_note,
            commands::list_notes_for_context,
            commands::delete_note,
            commands::get_preference,
            commands::set_preference,
            commands::list_preferences,
            focus::start_focus_session,
            focus::get_active_focus_session,
            focus::pause_focus_session,
            focus::resume_focus_session,
            focus::complete_focus_phase,
            focus::submit_reflection,
            focus::end_break,
            focus::abandon_focus_session,
            focus::list_focus_sessions,
            focus::delete_focus_session,
            google::commands::is_google_connected,
            google::commands::google_reconnect_needed,
            google::commands::connect_google,
            google::commands::disconnect_google,
            google::commands::sync_now,
            google::commands::push_item_now,
            google::commands::list_item_sync_statuses,
            google::commands::list_sync_conflicts,
            google::commands::resolve_conflict,
            google::commands::list_calendar_events_in_range,
            google::commands::list_calendars,
            backup::backup_now,
            backup::check_remote_backup,
            backup::dismiss_remote_backup,
            backup::restore_from_backup,
            is_autostart_enabled,
            enable_autostart,
            disable_autostart,
            notifications::notify_now,
            search::search_obsidian_vault,
            search::read_obsidian_note,
            search::test_obsidian_vault,
            obsidian_tasks::scan_obsidian_tasks,
            pro::pro_status,
            pro::pro_activate,
            pro::pro_recheck,
            pro::pro_deactivate,
            pro::pro_install_upgrade,
            pro::pro_open_link,
            pro::ai_key_status,
            pro::ai_key_save,
            pro::ai_key_remove,
            pro::ai_key_test,
            pro::intake_estimate_cost,
            intake::intake_extract,
            intake::intake_get,
            intake::intake_list,
            intake::intake_commit,
            intake::intake_undo,
            intake::intake_discard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
