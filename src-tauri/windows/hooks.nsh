; Extra steps for OTO's Tauri installer (tauri.conf.json: bundle.windows.nsis.installerHooks), in place of installer/installer.nsh.
;
; 1. Closing a running OTO the polite way: "OTO.exe --quit" saves the match and the database first. Tauri's own check, which
;    comes right after, only has to end it if it is still there.
; 2. Moving over from the Electron app: its uninstaller is run silently first, which never deletes what OTO saved
;    (%APPDATA%\obs-tcg-overlay is shared by both apps), and is run before this installer makes its shortcuts, which have the same names.
; 3. Deleting what OTO saved only when the person ticks "Delete the application data" in the uninstaller (never in an update),
;    or with "uninstall.exe /S --destroy".
;
; This file is read before the installer defines its names, so everything is inside macros, which it expands afterwards.

!macro OTO_CLOSE_APP
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${MAINBINARYNAME}.exe\""`
    Pop $0
    ${If} $0 == "0"
      DetailPrint "Asking OTO to save and quit..."
      nsExec::Exec `"$INSTDIR\${MAINBINARYNAME}.exe" --quit`
      Pop $0
      StrCpy $1 0
      ${Do}
        Sleep 500
        IntOp $1 $1 + 1
        nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${MAINBINARYNAME}.exe\""`
        Pop $0
        ${If} $0 != "0"
        ${OrIf} $1 >= 30
          ${Break}
        ${EndIf}
      ${Loop}
    ${EndIf}
  ${EndIf}
!macroend

; The Electron app (electron-builder) registers its uninstaller under HKCU ...\Uninstall\<a GUID>, with "Uninstall OTO.exe"
!macro OTO_REMOVE_ELECTRON_APP
  StrCpy $2 0
  ${Do}
    EnumRegKey $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $2
    ${If} $3 == ""
      ${Break}
    ${EndIf}
    IntOp $2 $2 + 1
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$3" "DisplayName"
    ReadRegStr $5 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$3" "InstallLocation"
    ; (electron-builder's default folders, if the key has no InstallLocation)
    ${If} $5 == ""
      StrCpy $5 "$LOCALAPPDATA\Programs\OTO"
      ${IfNot} ${FileExists} "$5\Uninstall OTO.exe"
        StrCpy $5 "$LOCALAPPDATA\Programs\obs-tcg-overlay"
      ${EndIf}
    ${EndIf}
    ; its name is "OTO" or "OTO <version>"
    StrCpy $6 $4 4
    ${If} $4 == "OTO"
      StrCpy $6 "OTO "
    ${EndIf}
    ${If} $6 == "OTO "
    ${AndIf} ${FileExists} "$5\Uninstall OTO.exe"
      DetailPrint "Removing the previous OTO (your matches, designs and settings stay)..."
      ; it closes the old OTO the polite way itself; /S never deletes data, _?= makes it wait
      ExecWait `"$5\Uninstall OTO.exe" /S /currentuser _?=$5`
      Delete "$5\Uninstall OTO.exe"
      RMDir "$5"
      ${Break}
    ${EndIf}
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OTO_REMOVE_ELECTRON_APP
  !insertmacro OTO_CLOSE_APP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OTO_CLOSE_APP
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${GetOptions} $CMDLINE "--destroy" $0
  ${If} ${Errors}
    StrCpy $0 $DeleteAppDataCheckboxState
  ${Else}
    StrCpy $0 1
  ${EndIf}
  ${If} $0 = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\obs-tcg-overlay"
    RMDir /r "$LOCALAPPDATA\obs-tcg-overlay-updater"
    DetailPrint "Everything OTO had saved was deleted."
  ${EndIf}
!macroend
