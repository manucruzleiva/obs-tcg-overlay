; Extra steps for OTO's Windows installer (electron-builder: build.nsis.include).
;
; 1. Closing a running OTO the polite way. The standard check closes its windows, which a tray app
;    answers by hiding, and then ends the process by force, so the match is not saved. This asks OTO to
;    quit ("OTO.exe --quit": it saves the match and the database first) and only forces it if it is
;    still there after about fifteen seconds. The installer, updates and the uninstaller all use it.
;
; 2. When OTO is already installed, the installer opens with a page offering to Repair, Reinstall from
;    scratch, or Uninstall. Nothing of the person's is ever deleted: a fresh start moves the data into a
;    backup folder. Silent runs (automatic updates) never show the page.
;
;    A script can choose without the page:
;        Setup.exe /S --mode=repair        put the program files back (the same as no option)
;        Setup.exe /S --mode=reinstall     as repair, and start with fresh data (the old data is kept in a backup)
;
; Order matters here: electron-builder reads this file before it defines its own names, so everything that
; uses them is written inside macros, which it expands afterwards.

!macro customHeader
  ; ---- closing a running OTO ------------------------------------------------------------------
  !ifdef BUILD_UNINSTALLER
    Function un.OtoCloseApp
  !else
    Function OtoCloseApp
  !endif
    Push $0
    Push $1

    ; Is it running? ("tasklist | findstr" gives 0 when the name is found, as electron-builder's own check does)
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $0
    StrCmp $0 "0" oto_running oto_done

    oto_running:
      ; Ask it to save everything and quit. This starts a short-lived copy that hands the request over.
      IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 oto_wait
        DetailPrint `Asking ${PRODUCT_NAME} to save and quit...`
        nsExec::Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
        Pop $0

    oto_wait:
      StrCpy $1 0
    oto_wait_loop:
      Sleep 500
      nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
      Pop $0
      StrCmp $0 "0" 0 oto_done
      IntOp $1 $1 + 1
      IntCmp $1 30 oto_force oto_wait_loop oto_force

    oto_force:
      ; Still there after fifteen seconds: end it
      DetailPrint `Closing ${PRODUCT_NAME}...`
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $0
      Sleep 800

    oto_done:
      Pop $1
      Pop $0
  FunctionEnd

  ; ---- the page for an existing installation (installer only) ---------------------------------
  !ifndef BUILD_UNINSTALLER
    Var OtoMode
    Var OtoRepair
    Var OtoReinstall
    Var OtoUninstall

    Function OtoMaintenanceCreate
      ; Only when OTO is already here, and only when a person is at the keyboard (not in a silent update)
      ${If} ${Silent}
        Abort
      ${EndIf}
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      ${If} $hasPerUserInstallation != "1"
      ${AndIf} $hasPerMachineInstallation != "1"
        Abort
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "OTO is already installed" "Choose what you would like to do."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 20u "OTO is already on this computer. Your matches, designs and settings are kept in your user folder, apart from the program."
      Pop $0

      ${NSD_CreateRadioButton} 0 28u 100% 12u "Repair"
      Pop $OtoRepair
      ${NSD_Check} $OtoRepair
      ${NSD_CreateLabel} 14u 41u 94% 18u "Put the program files back, and update them if this is a newer version. Everything of yours stays as it is."
      Pop $0

      ${NSD_CreateRadioButton} 0 66u 100% 12u "Reinstall from scratch"
      Pop $OtoReinstall
      ${NSD_CreateLabel} 14u 79u 94% 28u "As Repair, and OTO starts with empty data. What you have now is moved into a backup folder first, not deleted, so it can be put back."
      Pop $0

      ${NSD_CreateRadioButton} 0 114u 100% 12u "Uninstall"
      Pop $OtoUninstall
      ${NSD_CreateLabel} 14u 127u 94% 18u "Remove OTO from this computer. Your matches, designs and settings stay on disk."
      Pop $0

      nsDialogs::Show
    FunctionEnd

    Function OtoMaintenanceLeave
      ${NSD_GetState} $OtoUninstall $0
      ${If} $0 == ${BST_CHECKED}
        ; Run the uninstaller that belongs to this installation, wait for it, then end this setup
        ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
          ExecWait '"$INSTDIR\${UNINSTALL_FILENAME}" _?=$INSTDIR'
          Delete "$INSTDIR\${UNINSTALL_FILENAME}"
          RMDir "$INSTDIR"
        ${Else}
          MessageBox MB_OK|MB_ICONINFORMATION "The uninstaller was not found in $INSTDIR. Use Apps in Windows Settings to remove OTO."
          Abort
        ${EndIf}
        Quit
      ${EndIf}

      ${NSD_GetState} $OtoReinstall $0
      ${If} $0 == ${BST_CHECKED}
        MessageBox MB_YESNO|MB_ICONQUESTION "Start with empty data?$\r$\n$\r$\nWhat OTO has saved is moved into a backup folder first, not deleted." IDYES oto_confirmed
        Abort
        oto_confirmed:
        StrCpy $OtoMode "reinstall"
      ${Else}
        StrCpy $OtoMode "repair"
      ${EndIf}
    FunctionEnd

    ; Called once OTO has been closed: for a fresh start, move the saved data aside (never delete it)
    Function OtoStartFresh
      ${If} $OtoMode == ""
        ${StdUtils.GetParameter} $OtoMode "mode" ""
      ${EndIf}
      ${If} $OtoMode != "reinstall"
        Return
      ${EndIf}

      Push $0
      Push $1
      Push $2
      ; The same place the app uses; OTO_DATA_DIR moves it (for a USB stick, or for testing)
      ReadEnvStr $0 OTO_DATA_DIR
      ${If} $0 == ""
        ReadEnvStr $1 APPDATA
        StrCpy $0 "$1\obs-tcg-overlay"
      ${EndIf}
      ${If} ${FileExists} "$0\data\*.*"
        StrCpy $1 "$0\data-backup"
        StrCpy $2 1
        oto_free_name:
          ${If} ${FileExists} "$1\*.*"
            IntOp $2 $2 + 1
            StrCpy $1 "$0\data-backup-$2"
            Goto oto_free_name
          ${EndIf}
        ClearErrors
        Rename "$0\data" "$1"
        ${If} ${Errors}
          DetailPrint "The saved data could not be moved aside, so it was left where it is."
        ${Else}
          DetailPrint "Your data was moved to $1"
        ${EndIf}
      ${EndIf}
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customWelcomePage
    Page custom OtoMaintenanceCreate OtoMaintenanceLeave
  !macroend
!endif

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.OtoCloseApp
  !else
    Call OtoCloseApp
    Call OtoStartFresh
  !endif
!macroend
