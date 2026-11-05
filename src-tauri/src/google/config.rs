// Per Google's OAuth 2.0 for installed/desktop apps guidance, this client
// secret is not treated as confidential the way a web-app secret is (it ships
// inside the distributed binary either way). Values are baked in at compile
// time from `src-tauri/.env` (gitignored — see `.env.example`) via build.rs,
// so they never land in source control.
pub const GOOGLE_CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");
pub const GOOGLE_CLIENT_SECRET: &str = env!("GOOGLE_CLIENT_SECRET");

pub const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
// calendar.readonly (in addition to calendar.events, which only covers
// read/write on events the app itself manages) is what lets the app list the
// user's other/shared calendars (CalendarList) and read events from them for
// display — the two-way sync (push/pull) still only ever touches the primary
// calendar via calendar.events, this only adds read access to *other*
// calendars' events for the Calendar page's grid.
pub const GOOGLE_SCOPES: &str = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks";
