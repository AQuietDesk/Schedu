// Mirrors the hardcoded fallbacks in src-tauri/src/notifications.rs's get_pref()
// calls. The Rust scheduler applies these same defaults when a preference row
// doesn't exist yet, so a freshly-installed app behaves sensibly with no
// Settings interaction at all — this file just needs to agree with Rust's
// constants, not replace them.
export const NOTIFICATION_DEFAULTS = {
  morning_briefing_enabled: "true",
  morning_briefing_time: "08:00",
  evening_review_enabled: "true",
  evening_review_time: "20:00",
  weekly_planning_enabled: "true",
  weekly_planning_day: "0",
  weekly_planning_time: "18:00",
  upcoming_deadline_enabled: "true",
  upcoming_deadline_lead_hours: "24",
  overdue_enabled: "true",
  sync_interval_minutes: "5",
  backup_folder_path: "",
  backup_interval_hours: "24",
  obsidian_vault_path: "",
  obsidian_scan_folder: "",
  weather_location: "",
  user_name: "",
} as const;

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
