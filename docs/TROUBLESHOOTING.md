# Troubleshooting

Known local-dev/build gotchas for this app, why they happen, and how to fix them fast.

## "Hmmm... can't reach this page — localhost refused to connect" (ERR_CONNECTION_REFUSED)

**When it happens:** after building, or after running the app in dev mode — including from
the **release** shortcut, which should never depend on a dev server at all.

**Real root cause (fixed 2026-09-20):** Tauri decides whether a compiled app loads its
frontend from the Vite dev server (`devUrl`) or from the embedded `frontendDist` bundle
based on a single thing: whether the `tauri` crate's own `custom-protocol` Cargo feature is
enabled for *this* build (`tauri-build`'s `is_dev()`, `cfg(dev)` in `tauri`'s `manager/mod.rs`
— **not** debug vs. release, not `debug_assertions`). This project's `src-tauri/Cargo.toml`
was missing the `[features]` block that wires that up, so `custom-protocol` was never enabled
for *any* build — debug, release, `cargo build`, or `cargo build --release` all resolved to
"dev mode" and unconditionally tried to load `http://localhost:1420`, whether or not Vite was
running. This is why the release build launched from the taskbar shortcut showed this screen
even though release builds are supposed to be self-contained.

**The fix**, now in `Cargo.toml`:

```toml
[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

`tauri dev` builds with default features disabled (so `custom-protocol` stays off and it
correctly hits Vite for hot-reload); every other build path — `cargo build`,
`cargo build --release`, `npm run tauri build` — uses default features, which now enable
`custom-protocol`, so it correctly embeds and loads `dist/` instead.

**If you ever touch `Cargo.toml`'s `[features]` block again:** don't remove this, and after
any change to it, do a full rebuild (`cargo build --release` in `src-tauri`) — a stale
`target/release/tauri-app.exe` won't pick up the fix on its own. Also remember `dist/` is
embedded at *compile time*: if you rebuild the frontend (`npm run build` / `vite build`)
*after* the last `cargo build --release`, the release exe is now serving a stale bundle and
needs rebuilding again.

### A second, unrelated cause during actual dev-mode work

If this shows up specifically while running `npm run tauri dev` (not the release shortcut),
that's *expected* to use `localhost:1420` — the error there means nothing is actually
listening on it. `vite.config.ts` sets `strictPort: true`, so if a previous dev session's
Vite process didn't fully exit (e.g. the terminal was closed instead of Ctrl+C'd, leaving an
orphaned `node.exe` on Windows), the next dev server can't bind the port and exits, but the
Tauri window still opens and tries to load it anyway.

**Fix (already automated):** `predev` in `package.json` runs
[`scripts/free-dev-port.js`](../scripts/free-dev-port.js) before every `npm run dev` (and
therefore before every `tauri dev`) and kills whatever's squatting on port 1420.

**Manual recovery** if needed:

```powershell
Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# or
node scripts/free-dev-port.js 1420
```

---

## App won't open from the shortcut / taskbar icon (window never appears)

**Symptom:** the icon is pinned to
`src-tauri/target/release/tauri-app.exe`. Clicking it seems to do nothing — Task Manager
shows a `tauri-app.exe` process, but no window appears (or only an invisible helper window
titled `app.schedu.desktop-siw` shows up).

**What it means:** `lib.rs` registers `tauri_plugin_single_instance` specifically to guard
against this: double-clicking the icon while a previous launch is still alive (even
invisibly) spawns a second process pointed at the same WebView2 profile folder
(`%LOCALAPPDATA%\app.schedu.desktop\EBWebView`). The second WebView2 environment fails to
initialize (profile lock contention) and can leave orphaned `msedgewebview2.exe` processes
behind, which then block the *next* launch too.

**Fix:**

```powershell
# 1. Kill the stuck app and any of ITS orphaned webview children
#    (check ParentProcessId first — msedgewebview2.exe is also used by
#    Windows Search and other apps; only kill ones parented by tauri-app.exe)
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  Where-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)").Name -eq 'tauri-app.exe'
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-Process -Name tauri-app -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Relaunch
Start-Process "C:\Users\natha\Projects\Personal-Dashboard-App\src-tauri\target\release\tauri-app.exe"
```

**Caution:** don't blanket-kill every `msedgewebview2.exe` process on the system — most of
them belong to unrelated apps (Windows Search's `SearchHost.exe`, Google Drive, etc.).
Always check `ParentProcessId` first.

---

## General rule of thumb

- **Testing a Rust/frontend change quickly?** Use `npm run tauri dev`. Never run
  `target/debug/tauri-app.exe` standalone.
- **Want the real, installable build?** `npm run tauri build` (or `cargo build --release`
  inside `src-tauri`), then launch `target/release/tauri-app.exe`. As of the `[features]` fix
  above, this one never needs a dev server running — but remember to rebuild it (both
  `vite build` and `cargo build --release`, in that order) any time the frontend or backend
  source changes, since both the bundle and the binary are compile-time snapshots.
- **Always stop a dev session with Ctrl+C** in the terminal it's running in, not by closing
  the window/terminal app — that's what leaves orphaned Vite/WebView2 processes behind for
  next time.
