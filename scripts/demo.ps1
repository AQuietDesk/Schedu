# Opens Schedu with the fictional demo profile, for screenshots and recordings.
#
# Uses its own database in %APPDATA%\app.schedu.desktop\demo, so your real data
# is never touched. Delete that folder to start the demo over with fresh dates.
#
#   .\scripts\demo.ps1            run the installed Schedu
#   .\scripts\demo.ps1 -Dev       run `npm run tauri dev` instead
#
# Quit any running Schedu first (tray icon > Quit): only one copy can run at a
# time, and a second launch just brings the running one to the front.

param([switch]$Dev)

$env:SCHEDU_DEMO = "1"
if ($Dev) {
  Set-Location (Join-Path $PSScriptRoot "..")
  npm run tauri dev
} else {
  $exe = Join-Path $env:LOCALAPPDATA "Schedu\Schedu.exe"
  if (-not (Test-Path $exe)) { throw "Schedu isn't installed at $exe. Use -Dev to run from source." }
  & $exe
}
