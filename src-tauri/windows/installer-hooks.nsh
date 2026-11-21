; Omniweave NSIS hooks (tauri.conf.json bundle.windows.nsis.installerHooks).
; The language picked in the installer becomes the app's first-run UI language: it is written next to the exe
; and read once by the `installer_language` command (src-tauri/src/lib.rs) when no language was chosen in the app.
; LCIDs: 1042 Korean, 1033 English, 2052 Simplified Chinese, 1041 Japanese.

!macro NSIS_HOOK_POSTINSTALL
  FileOpen $0 "$INSTDIR\language.txt" w
  ${If} $LANGUAGE == 1033
    FileWrite $0 "en"
  ${ElseIf} $LANGUAGE == 2052
    FileWrite $0 "zh"
  ${ElseIf} $LANGUAGE == 1041
    FileWrite $0 "ja"
  ${Else}
    FileWrite $0 "ko"
  ${EndIf}
  FileClose $0
  ; Remember the installer language (also after a silent /S install): the next installer, the auto-update and the
  ; uninstaller start in it (windows/installer.nsi OmwPickLanguage). Before the custom template, a missing value made
  ; the auto-update's passive installer stop at the stock "Please select a language" dialog.
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "Installer Language" $LANGUAGE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\language.txt"
!macroend
