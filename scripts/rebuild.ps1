# Rebuilds the Schedu release exe (frontend first, then Rust, per docs/TROUBLESHOOTING.md),
# confirms every shortcut that points at tauri-app.exe uses the fresh build, then relaunches.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'src-tauri\target\release\tauri-app.exe'
Set-Location $root

Write-Host '== Stopping running app =='
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object {
  (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue).Name -eq 'tauri-app.exe'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process -Name tauri-app -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

Write-Host '== Building frontend =='
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }

Write-Host '== Building Rust release (a few minutes) =='
Push-Location (Join-Path $root 'src-tauri')
cargo build --release
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'cargo build failed' }

$built = Get-Item $exe
Write-Host ("Built: {0}  ({1})" -f $built.FullName, $built.LastWriteTime)

Write-Host '== Checking shortcuts =='
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) }
$sh = New-Object -ComObject WScript.Shell
$found = $false
foreach ($lnk in Get-ChildItem $dirs -Filter *.lnk -Recurse -ErrorAction SilentlyContinue) {
  $t = $sh.CreateShortcut($lnk.FullName).TargetPath
  if ($t -match 'tauri-app\.exe$|schedu|lifeos|life os') {
    $found = $true
    $ok = ($t -ieq $exe)
    Write-Host ("{0} -> {1}  [{2}]" -f $lnk.FullName, $t, $(if ($ok) {'OK, uses new build'} else {'DIFFERENT TARGET'}))
  }
}
if (-not $found) { Write-Host 'No shortcuts to tauri-app.exe found in Desktop/Start Menu/Taskbar.' }

Write-Host '== Launching =='
Start-Process $exe
Write-Host 'Done.'
