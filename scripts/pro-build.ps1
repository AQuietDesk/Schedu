<#
.SYNOPSIS
  Swaps the private schedu-pro crate into src-tauri/pro for a local Pro build
  or test run, then puts the public stub back.

.EXAMPLE
  ./scripts/pro-build.ps1 -ProPath ..\schedu-pro -Command test
  ./scripts/pro-build.ps1 -ProPath ..\schedu-pro -Command dev

  Local builds embed this PC's paths, so never ship one: official installers
  come only from the release workflow (see docs/PRO-BUILD.md).
#>
param(
  [Parameter(Mandatory = $true)][string]$ProPath,
  [ValidateSet("test", "check", "dev")][string]$Command = "test"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stub = Join-Path $root "src-tauri/pro"
$lock = Join-Path $root "src-tauri/Cargo.lock"
$private = Resolve-Path $ProPath

$a = Get-FileHash (Join-Path $stub "src/types.rs")
$b = Get-FileHash (Join-Path $private "src/types.rs")
if ($a.Hash -ne $b.Hash) { throw "src/types.rs differs between the stub and the private crate. Make them identical first." }

$backup = Join-Path ([IO.Path]::GetTempPath()) ("schedu-pro-stub-" + [Guid]::NewGuid())
Copy-Item $stub $backup -Recurse
Copy-Item $lock "$backup.lock"
try {
  Remove-Item $stub -Recurse -Force
  New-Item -ItemType Directory $stub | Out-Null
  Copy-Item (Join-Path $private "Cargo.toml") $stub
  Copy-Item (Join-Path $private "src") $stub -Recurse
  Push-Location $root
  switch ($Command) {
    "test"  { Push-Location src-tauri; cargo test; Pop-Location }
    "check" { Push-Location src-tauri; cargo check; Pop-Location }
    "dev"   { npm run tauri dev -- --config src-tauri/tauri.pro.conf.json }
  }
  Pop-Location
}
finally {
  Remove-Item $stub -Recurse -Force
  Copy-Item $backup $stub -Recurse
  Copy-Item "$backup.lock" $lock -Force
  Remove-Item $backup, "$backup.lock" -Recurse -Force
  Write-Host "Public stub restored."
}
