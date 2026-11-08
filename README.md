# Schedu

A planner for school and everyday life, for Windows. Your tasks, classes and grades live in a
database on your own PC. They only leave it if you turn on Google sync or backups.

Made by [AQuietDesk](https://aquietdesk.com).

## What's in it

- **Today**: a greeting, today's tasks, the next 7 days, a 24-hour Day Ring, focus time and quick notes.
- **Tasks**: everything in one list, grouped by when it's due. Filter by School, Personal or a list. Click a task to edit it in the side panel.
- **School**: each class gets its own page with assignments, weighted grades and notes. Letter grades and GPA points come from the grade scale in **Settings → School**. Any class can override it.
- **Calendar**: week and month views, with your Google Calendar events if you connect it. Drag unscheduled tasks onto the week to block out time.
- **Focus**: start a timed session from any task. The timer survives restarts.
- **Stats**: completions, on-time rate, focus time and class progress.
- **Ctrl K**: one box to search everything or add a task in plain language.
  `Lab 5 #chem tue 11:59pm !high` adds a task due Tuesday at 11:59 PM, in your Chemistry class, at high priority.
  Press **N** anywhere to open it.

## Install

1. Download `Schedu_x.y.z_x64-setup.exe` from the [latest release](https://github.com/AQuietDesk/Schedu/releases/latest).
2. Run it. Schedu installs for your user account only, so it doesn't need admin rights.
3. Updates install themselves. Schedu checks for a new version each time it starts.

### "Windows protected your PC"

Schedu isn't code-signed yet, so Windows SmartScreen may warn you the first time you run the
installer. To continue:

1. Click **More info**.
2. Check that the app is `Schedu_x.y.z_x64-setup.exe`. The publisher will show as **Unknown publisher**.
3. Click **Run anyway**.

You only see this once per installer. Only download Schedu from the releases page above.

## Your data

- Everything is stored in `%APPDATA%\app.schedu.desktop\life-os.sqlite3` on your PC.
- **Backups (optional):** in **Settings → Backup**, choose a folder (a Google Drive, OneDrive or
  Dropbox folder works well). Schedu saves a full copy there on a schedule and keeps the previous
  copy too. To move to a new PC, install Schedu, choose the same folder, and restore from it.
  Backups never include your Google sign-in.
- **Google Calendar and Tasks (optional, beta):** when you connect your Google account, Schedu
  keeps your items in sync with your own Google Tasks, and shows your Google Calendar events
  next to them (read-only: it never changes your calendar). It asks Google only for Tasks access
  and read-only Calendar access. It never sees your password.
- **Weather (optional):** if you set a city in Settings, that city name is sent to
  [Open-Meteo](https://open-meteo.com) to look up the forecast.

- **Updates:** each time it starts, Schedu asks GitHub whether a newer version exists. That
  request carries no data from the app.

Schedu has no accounts, analytics or tracking.

Full details: [privacy notice](docs/PRIVACY.md).

## Support

Email [discover@aquietdesk.com](mailto:discover@aquietdesk.com). Refunds and support terms:
[docs/TERMS.md](docs/TERMS.md). New to Schedu? See the [getting started guide](docs/BUYER-GUIDE.md).

## Develop

```sh
npm install
npm run tauri dev
```

Tests: `npm test` for the frontend and `cargo test` in `src-tauri`. The Rust build needs
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set at compile time (see `src-tauri/.env.example`).
Any value works for tests.

Some internal names predate the Schedu name and are kept so existing installs keep working: the
database file `life-os.sqlite3`, the backup file `life-os-backup.sqlite3` and the Rust package
`tauri-app`. A raw `cargo build` produces `tauri-app.exe`. The installer names it `Schedu.exe`.

Seeing "localhost refused to connect" after a build, or the app won't open from its shortcut?
See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## License

[MIT](LICENSE) © 2026 AQuietDesk
