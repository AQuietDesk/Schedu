// Per Google's OAuth 2.0 for installed/desktop apps guidance, this client
// secret is not treated as confidential the way a web-app secret is (it ships
// inside the distributed binary either way). Values are baked in at compile
// time from `src-tauri/.env` (gitignored — see `.env.example`) via build.rs,
// so they never land in source control.
pub const GOOGLE_CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");
pub const GOOGLE_CLIENT_SECRET: &str = env!("GOOGLE_CLIENT_SECRET");

pub const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
// Two scopes, both "sensitive" (not "restricted"):
// - tasks: two-way sync between Schedu items and the user's default Google
//   Tasks list (only tasks Schedu created are read back or changed);
// - calendar.readonly: list the user's calendars and read their events live
//   to display them. Schedu never saves, creates or changes calendar events;
//   0.4.1 dropped calendar.events along with the old two-way Calendar sync.
// No openid/email/profile: Schedu never needs to know who the user is.
pub const GOOGLE_SCOPES: &str = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks";
