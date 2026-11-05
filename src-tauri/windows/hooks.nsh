; Installer hooks (tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; v0.4 renamed the product from "tauri-app" to Schedu. Tauri's
; installer keys the install folder, Start menu shortcut, uninstall entry and the
; start-at-login Run value to the product name, so without this hook a v0.3 install
; would stay behind next to Schedu: two copies, the old one still starting at login
; and still trying to update itself.
;
; On the first Schedu install over a "tauri-app" install, this:
;   1. carries start-at-login over to Schedu.exe if it was on, and
;   2. silently runs the old uninstaller. Run without /UPDATE, it removes the old
;      program folder, shortcuts, uninstall entry and Run value. It never deletes
;      app data unless its "delete app data" box is ticked, which can't happen in
;      silent mode. (v0.4 also changed the app ID; the app itself copies the old
;      data folder across on first launch, see src-tauri/src/legacy_migration.rs.)
;
; Later Schedu installs and updates find no "tauri-app" entry and skip all of this.

!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\tauri-app"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "${LEGACY_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    ; Old install folder, stored with surrounding quotes.
    ReadRegStr $R1 HKCU "${LEGACY_UNINSTKEY}" "InstallLocation"
    StrCpy $R3 $R1 1
    ${If} $R3 == '"'
      StrCpy $R1 $R1 -1 1
    ${EndIf}

    ; Keep start-at-login on, now pointing at Schedu.exe.
    ReadRegStr $R2 HKCU "${RUNKEY}" "tauri-app"
    ${If} $R2 != ""
      WriteRegStr HKCU "${RUNKEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --autostart'
    ${EndIf}

    ; _?= makes the uninstaller run in place and wait, instead of copying itself to
    ; a temp folder and returning at once. It must be the last argument, unquoted.
    ${If} $R1 != ""
    ${AndIf} $R1 != $INSTDIR
      ExecWait '$R0 /S _?=$R1'
      Delete "$R1\uninstall.exe"
      RMDir "$R1"
    ${EndIf}
  ${EndIf}
!macroend
