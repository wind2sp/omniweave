; Omniweave installer template (tauri.conf.json bundle.windows.nsis.template).
;
; Based on the Tauri 2.1.0 NSIS template (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi,
; https://github.com/tauri-apps/tauri, Apache-2.0 OR MIT, Copyright (c) 2017 - Present Tauri Programme within
; The Commons Conservancy). The install, update, uninstall, WebView2, file association and shortcut logic is
; Tauri's; the user interface is replaced with Omniweave's own one-screen flow (docs/design/INSTALLER_UX.md):
;
;   install    one screen (Install) with folded options (language, folder, desktop shortcut) -> progress -> done
;   update     /P /UPDATE (the updater): a small progress window only, no question, no language dialog
;   silent     /S: no window at all
;   uninstall  one screen (Uninstall?) -> progress -> done, in the same look
;
; Everything is drawn with plain Win32 controls (nsDialogs + a few user32/gdi32 calls): no bitmaps, no extra
; plug-ins, so the installer stays the same size. Coordinates below are in device-independent pixels (96 DPI)
; and scaled with the window DPI, and fonts are created at that DPI, so 125/150/200% stay sharp.
Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2
XPStyle on

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define PLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUPRODUCTKEY "Software\${MANUFACTURER}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
Var AppStartMenuFolder
Var DeleteAppDataCheckboxState

Name "${PRODUCTNAME}"
BrandingText " "
OutFile "${OUTFILE}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

; Plugins path, currently exists for linux only
!if "${PLUGINSPATH}" != ""
    !addplugindir "${PLUGINSPATH}"
!endif

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; This template supports the per-user and per-machine modes Omniweave can use (no MultiUser page).
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel highest
!else
  RequestExecutionLevel user
!endif

; The app icon is the installer's and the uninstaller's icon; the window also draws it (resource 103) at the exact
; pixel size the DPI needs, so it never gets blurry.
!if "${INSTALLERICON}" != ""
  Icon "${INSTALLERICON}"
  UninstallIcon "${INSTALLERICON}"
!endif

; Languages: the NSIS language files give LANG_* ids and the system strings; Tauri's .nsh files give the strings its
; install logic uses (app running, WebView2); the window's own words are in OmwStrings below.
{{#each languages}}
LoadLanguageFile "${NSISDIR}\Contrib\Language files\\{{this}}.nlf"
{{/each}}
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; ---------------------------------------------------------------------------------------------------------------
; Look (docs/design/INSTALLER_UX.md). Colours are the app's design tokens (docs/design/VISUAL_DESIGN.md,
; src/ui/styles.css): the band is the dark --bg-1, the body the light --bg-2, the one strong colour is the light
; --accent (loom blue) for the main action, focus and progress; the icon's three threads (--brand-violet/teal/coral)
; appear only as the hairline under the band. Controls have 4 px corners (--r-sm).
; SetCtlColors needs literal colours, so they are written out where used:
;   band 0x1C1D20, band text 0xECECEE, band muted 0xB7B8BD, body 0xFFFFFF, text 0x1B1C1F, text-2 0x45474D,
;   text-3 0x62646B, accent 0x1F62CF (hover 0x1A57BB), quiet button --bg-3 0xEBEBED (hover --bg-4 0xDFE0E3),
;   danger 0xC4303F (hover 0xA82835), link --accent-text 0x1B58C0 (hover 0x154A9F), line 0xDADBDE,
;   hairline 0x7C5CFF / 0x22D3C5 / 0xFF6B81.
; ---------------------------------------------------------------------------------------------------------------
!define OMW_W 560          ; client width
!define OMW_HERO 132       ; dark band height
!define OMW_BODY 184       ; body height (options folded)
!define OMW_OPTS 158       ; extra height when the options are open (they sit under the buttons, see OmwWelcomeCreate)
!define OMW_PAD 36         ; side padding
!define OMW_FOOT 124       ; footer (buttons) top inside the body
!define OMW_BTN_H 38
!define OMW_ANIM_MS 180    ; options open/close: window height eases out over this time
!define OMW_PW 420         ; passive (update) window: width
!define OMW_PHERO 76       ; passive: band with icon + text
!define OMW_PBODY 36       ; passive: progress strip
!define /math OMW_SIZE_T ${ESTIMATEDSIZE} + 1023
!define /math OMW_SIZE_MB ${OMW_SIZE_T} / 1024
!define OMW_STYLE_LABEL 0x50000180   ; WS_CHILD|WS_VISIBLE|SS_NOTIFY|SS_NOPREFIX
!define OMW_STYLE_BTN 0x50000381     ; ... |SS_CENTER|SS_CENTERIMAGE
!define OMW_STYLE_HERO 0x50004080    ; WS_CHILD|WS_VISIBLE|SS_NOPREFIX|SS_ENDELLIPSIS
!define OMW_STYLE_ICON 0x50000203    ; WS_CHILD|WS_VISIBLE|SS_ICON|SS_CENTERIMAGE

Var OmwDpi
Var OmwX
Var OmwY
Var OmwCW
Var OmwCH
Var OmwT
Var OmwFace
Var OmwFontTitle
Var OmwFontTag
Var OmwFontHead
Var OmwFontBody
Var OmwFontSmall
Var OmwFontBtn
Var OmwFontUi
Var OmwHeroIcon
Var OmwHeroTitle
Var OmwHeroTag
Var OmwClientW
Var OmwHeroH
Var OmwBodyH
Var OmwPageH
Var OmwBrowseBtn
Var OmwLocked
Var OmwPlaced
Var OmwDlg
Var OmwBtnA
Var OmwBtnAKind
Var OmwBtnB
Var OmwLinkA
Var OmwHot
Var OmwOpt
Var OmwReloading
Var OmwKind        ; 0 new install, 1 update (older installed), 2 same version, 3 newer installed
Var OmwOldVer
Var OmwDesktop
Var OmwCombo
Var OmwDirEdit
Var OmwDeskCheck
Var OmwDataCheck
; words (OmwStrings)
Var L_Caption
Var L_Tag
Var L_Head
Var L_Text
Var L_Meta
Var L_Go
Var L_Options
Var L_Lang
Var L_Dir
Var L_Change
Var L_DirLocked
Var L_Desktop
Var L_PickDir
Var L_BadDir
Var L_Working
Var L_Copying
Var L_Registering
Var L_DoneHead
Var L_DoneText
Var L_Launch
Var L_Close
Var L_Failed
Var L_UnCaption
Var L_UnHead
Var L_UnText
Var L_UnData
Var L_UnGo
Var L_Cancel
Var L_UnWorking
Var L_UnDoneHead
Var L_UnDoneText
Var L_UpdWorking

; DIP -> device pixels
!macro OMW_PX OUT V
  IntOp ${OUT} ${V} * $OmwDpi
  IntOp ${OUT} ${OUT} / 96
!macroend

; nsDialogs control at DIP coordinates on the current page
!macro OMW_CTL OUT CLASS STYLE EXSTYLE X Y W H TEXT
  !insertmacro OMW_PX $OmwX ${X}
  !insertmacro OMW_PX $OmwY ${Y}
  !insertmacro OMW_PX $OmwCW ${W}
  !insertmacro OMW_PX $OmwCH ${H}
  nsDialogs::CreateControl ${CLASS} ${STYLE} ${EXSTYLE} $OmwX $OmwY $OmwCW $OmwCH "${TEXT}"
  Pop ${OUT}
!macroend

; text on the light body
!macro OMW_LABEL OUT X Y W H TEXT FONT
  !insertmacro OMW_CTL ${OUT} STATIC ${OMW_STYLE_LABEL} 0 ${X} ${Y} ${W} ${H} "${TEXT}"
  SendMessage ${OUT} ${WM_SETFONT} ${FONT} 1
!macroend

; a static used as a flat button: rounded, filled, hover handled by OmwHoverTick
!macro OMW_BUTTON OUT X Y W H TEXT
  !insertmacro OMW_CTL ${OUT} STATIC ${OMW_STYLE_BTN} 0 ${X} ${Y} ${W} ${H} "${TEXT}"
  SendMessage ${OUT} ${WM_SETFONT} $OmwFontBtn 1
  IntOp $OmwX $OmwCW + 1
  IntOp $OmwY $OmwCH + 1
  !insertmacro OMW_PX $OmwT 8
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $OmwX, i $OmwY, i $OmwT, i $OmwT) p .s'
  Pop $OmwT
  System::Call 'user32::SetWindowRgn(p ${OUT}, p $OmwT, i 1)'
!macroend

; a static on the main window (the dark band), outside the page dialogs
!macro OMW_HERO_CTL OUT STYLE X Y W H TEXT
  !insertmacro OMW_PX $OmwX ${X}
  !insertmacro OMW_PX $OmwY ${Y}
  !insertmacro OMW_PX $OmwCW ${W}
  !insertmacro OMW_PX $OmwCH ${H}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${STYLE}, i $OmwX, i $OmwY, i $OmwCW, i $OmwCH, p $HWNDPARENT, p 0, p 0, p 0) p .s'
  Pop ${OUT}
!macroend

!macro OMW_FONT OUT FACE PX WEIGHT
  IntOp $OmwT ${PX} * $OmwDpi
  IntOp $OmwT $OmwT / 96
  IntOp $OmwT 0 - $OmwT
  System::Call 'gdi32::CreateFontW(i $OmwT, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${FACE}") p .s'
  Pop ${OUT}
!macroend

; move a control (device pixels already in $OmwX.. or DIP via OMW_PX first)
!macro OMW_PLACE HWND X Y W H
  !insertmacro OMW_PX $OmwX ${X}
  !insertmacro OMW_PX $OmwY ${Y}
  !insertmacro OMW_PX $OmwCW ${W}
  !insertmacro OMW_PX $OmwCH ${H}
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i $OmwX, i $OmwY, i $OmwCW, i $OmwCH, i 0x14)'
!macroend

!macro OMW_SHARED un
  ; Picks the language: the one remembered from the last install, else the Windows display language, else English.
  Function ${un}OmwPickLanguage
    StrCpy $0 0
    System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
    IntOp $0 $0 & 0x3FF
    ${If} $0 = 0x12
      StrCpy $LANGUAGE 1042
    ${ElseIf} $0 = 0x11
      StrCpy $LANGUAGE 1041
    ${ElseIf} $0 = 0x04
      StrCpy $LANGUAGE 2052
    ${Else}
      StrCpy $LANGUAGE 1033
    ${EndIf}
    ReadRegStr $0 HKCU "${MANUPRODUCTKEY}" "Installer Language"
    ${If} $0 == 1042
    ${OrIf} $0 == 1033
    ${OrIf} $0 == 2052
    ${OrIf} $0 == 1041
      StrCpy $LANGUAGE $0
    ${EndIf}
  FunctionEnd

  ; The window's words. Kept in variables (not LangString) so the language can change while the window is open.
  Function ${un}OmwStrings
    ${If} $LANGUAGE == 1033
      StrCpy $OmwFace "Segoe UI"
      StrCpy $L_Caption "Omniweave Setup"
      StrCpy $L_Tag "Images, vectors, PDF, Word, HWPX and slides on one canvas"
      StrCpy $L_Options "Options"
      StrCpy $L_Lang "Language"
      StrCpy $L_Dir "Install location"
      StrCpy $L_Change "Change…"
      StrCpy $L_DirLocked "Omniweave is updated where it is installed now."
      StrCpy $L_Desktop "Create a desktop shortcut"
      StrCpy $L_PickDir "Choose a folder for Omniweave"
      StrCpy $L_BadDir "Enter the full path of a folder, for example D:\Apps\Omniweave."
      StrCpy $L_Copying "Copying files"
      StrCpy $L_Registering "Adding shortcuts and file types"
      StrCpy $L_Launch "Start Omniweave"
      StrCpy $L_Close "Close"
      StrCpy $L_Failed "Omniweave could not be installed. The reason is shown in the window."
      StrCpy $L_UnCaption "Uninstall Omniweave"
      StrCpy $L_UnHead "Uninstall Omniweave?"
      StrCpy $L_UnText "This removes the app and its shortcuts. Your documents stay where they are."
      StrCpy $L_UnData "Also delete settings and cache"
      StrCpy $L_UnGo "Uninstall"
      StrCpy $L_Cancel "Cancel"
      StrCpy $L_UnWorking "Uninstalling…"
      StrCpy $L_UnDoneHead "Omniweave has been uninstalled"
      StrCpy $L_UnDoneText "Thank you for using Omniweave."
      StrCpy $L_UpdWorking "Updating Omniweave…"
      ${If} $OmwKind = 1
        StrCpy $L_Head "Ready to update"
        StrCpy $L_Text "Your documents and settings stay as they are."
        StrCpy $L_Meta "Version $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "Update"
        StrCpy $L_Working "Updating…"
        StrCpy $L_DoneHead "Update complete"
      ${ElseIf} $OmwKind = 2
        StrCpy $L_Head "This version is already installed"
        StrCpy $L_Text "Install it again to repair the app files. Your documents and settings stay."
        StrCpy $L_Meta "Version ${VERSION}"
        StrCpy $L_Go "Reinstall"
        StrCpy $L_Working "Installing…"
        StrCpy $L_DoneHead "Installation complete"
      ${ElseIf} $OmwKind = 3
        StrCpy $L_Head "A newer version is installed"
        StrCpy $L_Text "This replaces it with the older version below."
        StrCpy $L_Meta "Version $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "Install this version"
        StrCpy $L_Working "Installing…"
        StrCpy $L_DoneHead "Installation complete"
      ${Else}
        StrCpy $L_Head "Ready to install"
        StrCpy $L_Text "Installs for this account only. No administrator rights needed."
        StrCpy $L_Meta "Version ${VERSION}  ·  About ${OMW_SIZE_MB} MB"
        StrCpy $L_Go "Install"
        StrCpy $L_Working "Installing…"
        StrCpy $L_DoneHead "Installation complete"
      ${EndIf}
      StrCpy $L_DoneText "You can open Omniweave from the Start menu at any time."
    ${ElseIf} $LANGUAGE == 2052
      StrCpy $OmwFace "Microsoft YaHei UI"
      StrCpy $L_Caption "Omniweave 安装"
      StrCpy $L_Tag "在一块画布上处理图像、矢量、PDF、Word、HWPX 和幻灯片"
      StrCpy $L_Options "安装选项"
      StrCpy $L_Lang "语言"
      StrCpy $L_Dir "安装位置"
      StrCpy $L_Change "更改…"
      StrCpy $L_DirLocked "将在当前安装位置更新 Omniweave。"
      StrCpy $L_Desktop "创建桌面快捷方式"
      StrCpy $L_PickDir "选择 Omniweave 的安装文件夹"
      StrCpy $L_BadDir "请输入文件夹的完整路径，例如 D:\Apps\Omniweave。"
      StrCpy $L_Copying "正在复制文件"
      StrCpy $L_Registering "正在添加快捷方式和文件关联"
      StrCpy $L_Launch "启动 Omniweave"
      StrCpy $L_Close "关闭"
      StrCpy $L_Failed "无法安装 Omniweave。原因显示在窗口中。"
      StrCpy $L_UnCaption "卸载 Omniweave"
      StrCpy $L_UnHead "要卸载 Omniweave 吗？"
      StrCpy $L_UnText "将删除程序及其快捷方式，您的文档会保留。"
      StrCpy $L_UnData "同时删除设置和缓存"
      StrCpy $L_UnGo "卸载"
      StrCpy $L_Cancel "取消"
      StrCpy $L_UnWorking "正在卸载…"
      StrCpy $L_UnDoneHead "Omniweave 已卸载"
      StrCpy $L_UnDoneText "感谢您使用 Omniweave。"
      StrCpy $L_UpdWorking "正在更新 Omniweave…"
      ${If} $OmwKind = 1
        StrCpy $L_Head "准备更新"
        StrCpy $L_Text "您的文档和设置将保持不变。"
        StrCpy $L_Meta "版本 $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "更新"
        StrCpy $L_Working "正在更新…"
        StrCpy $L_DoneHead "更新完成"
      ${ElseIf} $OmwKind = 2
        StrCpy $L_Head "已安装此版本"
        StrCpy $L_Text "重新安装可修复程序文件，文档和设置会保留。"
        StrCpy $L_Meta "版本 ${VERSION}"
        StrCpy $L_Go "重新安装"
        StrCpy $L_Working "正在安装…"
        StrCpy $L_DoneHead "安装完成"
      ${ElseIf} $OmwKind = 3
        StrCpy $L_Head "已安装较新的版本"
        StrCpy $L_Text "将用下面的旧版本替换它。"
        StrCpy $L_Meta "版本 $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "安装此版本"
        StrCpy $L_Working "正在安装…"
        StrCpy $L_DoneHead "安装完成"
      ${Else}
        StrCpy $L_Head "准备安装"
        StrCpy $L_Text "仅为当前用户安装，无需管理员权限。"
        StrCpy $L_Meta "版本 ${VERSION}  ·  约 ${OMW_SIZE_MB} MB"
        StrCpy $L_Go "安装"
        StrCpy $L_Working "正在安装…"
        StrCpy $L_DoneHead "安装完成"
      ${EndIf}
      StrCpy $L_DoneText "随时可以从“开始”菜单打开 Omniweave。"
    ${ElseIf} $LANGUAGE == 1041
      StrCpy $OmwFace "Yu Gothic UI"
      StrCpy $L_Caption "Omniweave セットアップ"
      StrCpy $L_Tag "画像・ベクター・PDF・Word・HWPX・スライドをひとつのキャンバスで"
      StrCpy $L_Options "オプション"
      StrCpy $L_Lang "言語"
      StrCpy $L_Dir "インストール先"
      StrCpy $L_Change "変更…"
      StrCpy $L_DirLocked "いまインストールされている場所でアップデートします。"
      StrCpy $L_Desktop "デスクトップにショートカットを作成"
      StrCpy $L_PickDir "Omniweave のインストール先フォルダーを選んでください"
      StrCpy $L_BadDir "フォルダーのフルパスを入力してください（例: D:\Apps\Omniweave）。"
      StrCpy $L_Copying "ファイルをコピーしています"
      StrCpy $L_Registering "ショートカットとファイルの関連付けを追加しています"
      StrCpy $L_Launch "Omniweave を起動"
      StrCpy $L_Close "閉じる"
      StrCpy $L_Failed "Omniweave をインストールできませんでした。理由はウィンドウに表示されています。"
      StrCpy $L_UnCaption "Omniweave のアンインストール"
      StrCpy $L_UnHead "Omniweave をアンインストールしますか？"
      StrCpy $L_UnText "アプリとショートカットを削除します。作成したドキュメントはそのまま残ります。"
      StrCpy $L_UnData "設定とキャッシュも削除する"
      StrCpy $L_UnGo "アンインストール"
      StrCpy $L_Cancel "キャンセル"
      StrCpy $L_UnWorking "アンインストールしています…"
      StrCpy $L_UnDoneHead "アンインストールが完了しました"
      StrCpy $L_UnDoneText "Omniweave をご利用いただきありがとうございました。"
      StrCpy $L_UpdWorking "Omniweave をアップデートしています…"
      ${If} $OmwKind = 1
        StrCpy $L_Head "アップデートの準備ができました"
        StrCpy $L_Text "作成したドキュメントと設定はそのまま残ります。"
        StrCpy $L_Meta "バージョン $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "アップデート"
        StrCpy $L_Working "アップデートしています…"
        StrCpy $L_DoneHead "アップデートが完了しました"
      ${ElseIf} $OmwKind = 2
        StrCpy $L_Head "このバージョンはインストール済みです"
        StrCpy $L_Text "もう一度インストールするとアプリのファイルを修復できます。ドキュメントと設定は残ります。"
        StrCpy $L_Meta "バージョン ${VERSION}"
        StrCpy $L_Go "再インストール"
        StrCpy $L_Working "インストールしています…"
        StrCpy $L_DoneHead "インストールが完了しました"
      ${ElseIf} $OmwKind = 3
        StrCpy $L_Head "より新しいバージョンがインストールされています"
        StrCpy $L_Text "下の古いバージョンに置き換えます。"
        StrCpy $L_Meta "バージョン $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "このバージョンをインストール"
        StrCpy $L_Working "インストールしています…"
        StrCpy $L_DoneHead "インストールが完了しました"
      ${Else}
        StrCpy $L_Head "インストールの準備ができました"
        StrCpy $L_Text "このアカウントだけにインストールします。管理者権限は必要ありません。"
        StrCpy $L_Meta "バージョン ${VERSION}  ·  約 ${OMW_SIZE_MB} MB"
        StrCpy $L_Go "インストール"
        StrCpy $L_Working "インストールしています…"
        StrCpy $L_DoneHead "インストールが完了しました"
      ${EndIf}
      StrCpy $L_DoneText "Omniweave はスタートメニューからいつでも開けます。"
    ${Else}
      StrCpy $OmwFace "Malgun Gothic"
      StrCpy $L_Caption "Omniweave 설치"
      StrCpy $L_Tag "이미지·벡터·PDF·Word·HWPX·슬라이드를 한 캔버스에서"
      StrCpy $L_Options "설치 옵션"
      StrCpy $L_Lang "언어"
      StrCpy $L_Dir "설치 위치"
      StrCpy $L_Change "변경…"
      StrCpy $L_DirLocked "지금 설치된 위치에서 업데이트합니다."
      StrCpy $L_Desktop "바탕 화면에 바로 가기 만들기"
      StrCpy $L_PickDir "Omniweave를 설치할 폴더를 고르세요"
      StrCpy $L_BadDir "폴더의 전체 경로를 적어 주세요. 예: D:\Apps\Omniweave"
      StrCpy $L_Copying "파일을 복사하는 중"
      StrCpy $L_Registering "바로 가기와 파일 연결을 등록하는 중"
      StrCpy $L_Launch "오메 시작"
      StrCpy $L_Close "닫기"
      StrCpy $L_Failed "Omniweave를 설치하지 못했습니다. 까닭은 창에 적혀 있습니다."
      StrCpy $L_UnCaption "Omniweave 제거"
      StrCpy $L_UnHead "Omniweave를 제거할까요?"
      StrCpy $L_UnText "프로그램과 바로 가기를 지웁니다. 만든 문서는 그대로 남습니다."
      StrCpy $L_UnData "설정과 캐시도 지우기"
      StrCpy $L_UnGo "제거"
      StrCpy $L_Cancel "취소"
      StrCpy $L_UnWorking "제거하는 중…"
      StrCpy $L_UnDoneHead "Omniweave를 제거했습니다"
      StrCpy $L_UnDoneText "오메를 써 주셔서 고맙습니다."
      StrCpy $L_UpdWorking "오메를 업데이트하는 중…"
      ${If} $OmwKind = 1
        StrCpy $L_Head "업데이트할 준비가 되었습니다"
        StrCpy $L_Text "만든 문서와 설정은 그대로 둡니다."
        StrCpy $L_Meta "버전 $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "업데이트"
        StrCpy $L_Working "업데이트하는 중…"
        StrCpy $L_DoneHead "업데이트를 마쳤습니다"
      ${ElseIf} $OmwKind = 2
        StrCpy $L_Head "이 버전이 이미 설치되어 있습니다"
        StrCpy $L_Text "다시 설치하면 프로그램 파일을 고칩니다. 문서와 설정은 그대로 둡니다."
        StrCpy $L_Meta "버전 ${VERSION}"
        StrCpy $L_Go "다시 설치"
        StrCpy $L_Working "설치하는 중…"
        StrCpy $L_DoneHead "설치를 마쳤습니다"
      ${ElseIf} $OmwKind = 3
        StrCpy $L_Head "더 새 버전이 설치되어 있습니다"
        StrCpy $L_Text "설치된 버전을 아래의 이전 버전으로 바꿉니다."
        StrCpy $L_Meta "버전 $OmwOldVer → ${VERSION}"
        StrCpy $L_Go "이 버전 설치"
        StrCpy $L_Working "설치하는 중…"
        StrCpy $L_DoneHead "설치를 마쳤습니다"
      ${Else}
        StrCpy $L_Head "설치할 준비가 되었습니다"
        StrCpy $L_Text "이 계정에만 설치하며 관리자 권한이 필요 없습니다."
        StrCpy $L_Meta "버전 ${VERSION}  ·  약 ${OMW_SIZE_MB} MB"
        StrCpy $L_Go "설치"
        StrCpy $L_Working "설치하는 중…"
        StrCpy $L_DoneHead "설치를 마쳤습니다"
      ${EndIf}
      StrCpy $L_DoneText "시작 메뉴에서 언제든 오메를 열 수 있습니다."
    ${EndIf}
  FunctionEnd

  Function ${un}OmwFonts
    !insertmacro OMW_FONT $OmwFontHead $OmwFace 20 700
    !insertmacro OMW_FONT $OmwFontBody $OmwFace 14 400
    !insertmacro OMW_FONT $OmwFontSmall $OmwFace 13 400
    !insertmacro OMW_FONT $OmwFontBtn $OmwFace 14 600
    !insertmacro OMW_FONT $OmwFontTag $OmwFace 14 400
    ; the brand name and the language list (all four scripts) use Segoe UI, which links the CJK fonts
    !insertmacro OMW_FONT $OmwFontTitle "Segoe UI Semibold" 28 400
    !insertmacro OMW_FONT $OmwFontUi "Segoe UI" 14 400
  FunctionEnd

  ; Sizes the main window to $OmwClientW x ($OmwHeroH + $OmwBodyH) DIP and puts the page area under the band.
  ; The first call centres the window where NSIS put it; later calls keep its top-left corner.
  Function ${un}OmwLayout
    System::Call '*(i, i, i, i) p .r8'
    System::Call '*(i, i, i, i) p .r9'
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r8)'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r9)'
    System::Call '*$8(i .r0, i .r1, i .r2, i .r3)'
    System::Call '*$9(i, i, i .r4, i .r5)'
    System::Free $8
    System::Free $9
    IntOp $2 $2 - $0   ; outer width
    IntOp $3 $3 - $1   ; outer height
    IntOp $4 $2 - $4   ; non-client width
    IntOp $5 $3 - $5   ; non-client height
    IntOp $6 $OmwHeroH + $OmwBodyH
    !insertmacro OMW_PX $6 $6
    !insertmacro OMW_PX $7 $OmwClientW
    IntOp $6 $6 + $5
    IntOp $7 $7 + $4
    ${If} $OmwPlaced != 1
      IntOp $8 $2 - $7
      IntOp $8 $8 / 2
      IntOp $0 $0 + $8
      IntOp $8 $3 - $6
      IntOp $8 $8 / 2
      IntOp $1 $1 + $8
      StrCpy $OmwPlaced 1
    ${EndIf}
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i r7, i r6, i 0x14)'
    ; the page area can be taller than the visible body (the install screen keeps its folded options below it)
    ${If} $OmwPageH < $OmwBodyH
      StrCpy $OmwPageH $OmwBodyH
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 1018
    !insertmacro OMW_PLACE $0 0 $OmwHeroH $OmwClientW $OmwPageH
  FunctionEnd

  ; Eases the window height to $OmwHeroH + $OmwBodyH in OMW_ANIM_MS (ease-out cubic). Only the window grows or
  ; shrinks: the page under it is already laid out and simply uncovered or covered, so nothing is re-created or
  ; repainted except the strip that appears. Instant when Windows animations are turned off.
  !if "${un}" == ""
  Function ${un}OmwAnimate
    System::Call '*(i, i, i, i) p .r8'
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r8)'
    System::Call '*$8(i .r0, i .r1, i .r2, i .r3)'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r8)'
    System::Call '*$8(i, i, i, i .r4)'
    System::Free $8
    IntOp $2 $2 - $0       ; outer width
    IntOp $3 $3 - $1       ; outer height
    IntOp $5 $3 - $4       ; non-client height
    IntOp $6 $OmwHeroH + $OmwBodyH
    !insertmacro OMW_PX $6 $6
    IntOp $6 $6 + $5       ; target outer height
    StrCpy $7 1
    System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i .r7, i 0)'   ; SPI_GETCLIENTAREAANIMATION
    ${If} $7 <> 0
      IntOp $9 $6 - $3     ; distance
      System::Call 'kernel32::GetTickCount() i .r8'
      ${Do}
        System::Call 'kernel32::GetTickCount() i .r0'
        IntOp $0 $0 - $8
        ${If} $0 >= ${OMW_ANIM_MS}
          ${Break}
        ${EndIf}
        IntOp $0 $0 * 1000
        IntOp $0 $0 / ${OMW_ANIM_MS}
        IntOp $0 1000 - $0          ; u = 1 - t
        IntOp $1 $0 * $0
        IntOp $1 $1 / 1000
        IntOp $1 $1 * $0
        IntOp $1 $1 / 1000          ; u^3
        IntOp $1 1000 - $1          ; ease = 1 - (1 - t)^3
        IntOp $1 $9 * $1
        IntOp $1 $1 / 1000
        IntOp $1 $3 + $1
        System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r2, i r1, i 0x16)'
        System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x180)'   ; RDW_UPDATENOW|RDW_ALLCHILDREN
        System::Call 'kernel32::Sleep(i 1)'
      ${Loop}
    ${EndIf}
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r2, i r6, i 0x16)'
  FunctionEnd
  !endif

  ; Turns the stock NSIS window into Omniweave's: dark caption, no stock buttons, the brand band on top.
  Function ${un}OmwInitWindow
    StrCpy $0 0
    System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
    IntOp $OmwDpi $0 + 0
    ${If} $OmwDpi < 96
      System::Call 'user32::GetDC(p 0) p .r1'
      System::Call 'gdi32::GetDeviceCaps(p r1, i 90) i .r0'
      System::Call 'user32::ReleaseDC(p 0, p r1)'
      IntOp $OmwDpi $0 + 0
    ${EndIf}
    ${If} $OmwDpi < 96
      StrCpy $OmwDpi 96
    ${EndIf}
    ; Windows 11 draws the caption in the band colour (Windows 10 keeps its own caption; both are fine)
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x00201D1C, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00EEECEC, i 4)'
    SetCtlColors $HWNDPARENT 0xECECEE 0x1C1D20
    Push $HWNDPARENT
    Call ${un}OmwClipChildren
    ; The stock controls (Back/Next/Cancel, branding, header) are moved out of sight, not destroyed: Next stays the
    ; default button, so Enter still starts the install and Esc/close still cancels.
    StrCpy $1 0
    ${Do}
      FindWindow $2 "" "" $HWNDPARENT $1
      ${If} $2 = 0
        ${Break}
      ${EndIf}
      System::Call 'user32::SetWindowPos(p r2, p 0, i -6000, i -6000, i 0, i 0, i 0x15)'
      StrCpy $1 $2
    ${Loop}
    Call ${un}OmwStrings
    Call ${un}OmwFonts
    ${If} $PassiveMode = 1
      StrCpy $OmwClientW ${OMW_PW}
      StrCpy $OmwHeroH ${OMW_PHERO}
      StrCpy $OmwBodyH ${OMW_PBODY}
      !insertmacro OMW_HERO_CTL $OmwHeroIcon ${OMW_STYLE_ICON} 24 22 40 40 ""
      StrCpy $3 40
      !insertmacro OMW_HERO_CTL $OmwHeroTitle ${OMW_STYLE_HERO} 80 18 316 26 "Omniweave"
      !insertmacro OMW_HERO_CTL $OmwHeroTag ${OMW_STYLE_HERO} 80 44 316 22 "$L_UpdWorking"
      !insertmacro OMW_FONT $0 "Segoe UI Semibold" 18 400
      SendMessage $OmwHeroTitle ${WM_SETFONT} $0 1
    ${Else}
      StrCpy $OmwClientW ${OMW_W}
      StrCpy $OmwHeroH ${OMW_HERO}
      StrCpy $OmwBodyH ${OMW_BODY}
      !insertmacro OMW_HERO_CTL $OmwHeroIcon ${OMW_STYLE_ICON} ${OMW_PAD} 34 60 60 ""
      StrCpy $3 60
      !insertmacro OMW_HERO_CTL $OmwHeroTitle ${OMW_STYLE_HERO} 116 36 400 38 "Omniweave"
      !insertmacro OMW_HERO_CTL $OmwHeroTag ${OMW_STYLE_HERO} 117 74 410 22 "$L_Tag"
      SendMessage $OmwHeroTitle ${WM_SETFONT} $OmwFontTitle 1
      ; the icon's three threads as a hairline under the band
      IntOp $4 ${OMW_W} * 56
      IntOp $4 $4 / 100
      IntOp $5 ${OMW_W} * 22
      IntOp $5 $5 / 100
      IntOp $6 $4 + $5
      IntOp $7 ${OMW_W} - $6
      !insertmacro OMW_HERO_CTL $0 0x50000000 0 129 $4 3 ""
      SetCtlColors $0 0x7C5CFF 0x7C5CFF
      !insertmacro OMW_HERO_CTL $0 0x50000000 $4 129 $5 3 ""
      SetCtlColors $0 0x22D3C5 0x22D3C5
      !insertmacro OMW_HERO_CTL $0 0x50000000 $6 129 $7 3 ""
      SetCtlColors $0 0xFF6B81 0xFF6B81
    ${EndIf}
    SetCtlColors $OmwHeroIcon 0xECECEE 0x1C1D20
    SetCtlColors $OmwHeroTitle 0xECECEE 0x1C1D20
    SetCtlColors $OmwHeroTag 0xB7B8BD 0x1C1D20
    SendMessage $OmwHeroTag ${WM_SETFONT} $OmwFontTag 1
    ; the app icon from the exe's own icon group, loaded at the exact device size
    !insertmacro OMW_PX $3 $3
    System::Call 'kernel32::GetModuleHandleW(p 0) p .r1'
    System::Call 'user32::LoadImageW(p r1, p 103, i 1, i r3, i r3, i 0) p .r2'
    SendMessage $OmwHeroIcon 0x170 $2 0   ; STM_SETICON
    StrCpy $OmwPlaced 0
    Call ${un}OmwLayout
  FunctionEnd

  ; Window caption follows the chosen language.
  Function ${un}OmwCaption
    !if "${un}" == "un."
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:$L_UnCaption"
    !else
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:$L_Caption"
    !endif
  FunctionEnd

  ; Starts a page dialog filling the body.
  Function ${un}OmwPage
    StrCpy $OmwBtnA 0
    StrCpy $OmwBtnB 0
    StrCpy $OmwLinkA 0
    StrCpy $OmwHot 0
    StrCpy $OmwBtnAKind 1
    Call ${un}OmwCaption
    Call ${un}OmwLayout
    StrCpy $OmwPageH 0
    nsDialogs::Create 1018
    Pop $OmwDlg
    SetCtlColors $OmwDlg 0x1B1C1F 0xFFFFFF
    Push $OmwDlg
    Call ${un}OmwClipChildren
  FunctionEnd

  ; WS_CLIPCHILDREN: a window erasing its background does not paint over its controls (no flash on resize/redraw).
  Function ${un}OmwClipChildren
    Exch $0
    Push $1
    System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
    IntOp $1 $1 | 0x02000000
    System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
    Pop $1
    Pop $0
  FunctionEnd

  ; Hover colours for the flat buttons and the link (Win32 statics have no hover state of their own).
  Function ${un}OmwHoverTick
    System::Call 'user32::GetCursorPos(*l .r1)'
    System::Call 'user32::WindowFromPoint(l r1) p .r2'
    ${If} $2 <> $OmwBtnA
    ${AndIf} $2 <> $OmwBtnB
    ${AndIf} $2 <> $OmwLinkA
      StrCpy $2 0
    ${EndIf}
    ${If} $2 = $OmwHot
      Return
    ${EndIf}
    StrCpy $3 $OmwHot
    StrCpy $OmwHot $2
    ; repaint the one that was hot, then the one that is
    ${If} $3 <> 0
      Push $3
      Push 0
      Call ${un}OmwPaintButton
    ${EndIf}
    ${If} $2 <> 0
      Push $2
      Push 1
      Call ${un}OmwPaintButton
    ${EndIf}
  FunctionEnd

  ; stack: hwnd, hot(0/1)
  Function ${un}OmwPaintButton
    Exch $1   ; hot
    Exch
    Exch $0   ; hwnd
    ${If} $0 = $OmwBtnA
      ${If} $OmwBtnAKind = 3
        ${If} $1 = 1
          SetCtlColors $0 0xFFFFFF 0xA82835
        ${Else}
          SetCtlColors $0 0xFFFFFF 0xC4303F
        ${EndIf}
      ${Else}
        ${If} $1 = 1
          SetCtlColors $0 0xFFFFFF 0x1A57BB
        ${Else}
          SetCtlColors $0 0xFFFFFF 0x1F62CF
        ${EndIf}
      ${EndIf}
    ${ElseIf} $0 = $OmwBtnB
      ${If} $1 = 1
        SetCtlColors $0 0x1B1C1F 0xDFE0E3
      ${Else}
        SetCtlColors $0 0x1B1C1F 0xEBEBED
      ${EndIf}
    ${ElseIf} $0 = $OmwLinkA
      ${If} $1 = 1
        SetCtlColors $0 0x154A9F 0xFFFFFF
      ${Else}
        SetCtlColors $0 0x1B58C0 0xFFFFFF
      ${EndIf}
    ${EndIf}
    System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
    Pop $0
    Pop $1
  FunctionEnd

  ; Primary button: the same as pressing the (hidden) Next / Install / Finish button.
  Function ${un}OmwNext
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
  FunctionEnd

  !if "${un}" == "un."
    Function ${un}OmwCancel
      SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
    FunctionEnd
  !endif

  ; Shared footer: primary button on the right, optional quiet button left of it. $0 = footer top (DIP),
  ; $1 = primary width, $2 = quiet width (0 = none), $R1 / $R2 = labels.
  Function ${un}OmwFooter
    IntOp $3 ${OMW_W} - ${OMW_PAD}
    IntOp $3 $3 - $1
    !insertmacro OMW_BUTTON $OmwBtnA $3 $0 $1 ${OMW_BTN_H} "$R1"
    ${If} $2 > 0
      IntOp $3 $3 - 10
      IntOp $3 $3 - $2
      !insertmacro OMW_BUTTON $OmwBtnB $3 $0 $2 ${OMW_BTN_H} "$R2"
      SetCtlColors $OmwBtnB 0x1B1C1F 0xEBEBED
      ${NSD_OnClick} $OmwBtnB ${un}OmwQuietClick
    ${EndIf}
    ${If} $OmwBtnAKind = 3
      SetCtlColors $OmwBtnA 0xFFFFFF 0xC4303F
    ${Else}
      SetCtlColors $OmwBtnA 0xFFFFFF 0x1F62CF
    ${EndIf}
    ${NSD_OnClick} $OmwBtnA ${un}OmwPrimaryClick
    ${NSD_CreateTimer} ${un}OmwHoverTick 40
  FunctionEnd

  ; Head, text and meta lines of a page. $R3 head, $R4 text, $R5 meta ("" = none)
  Function ${un}OmwTexts
    !insertmacro OMW_LABEL $0 ${OMW_PAD} 26 488 30 "$R3" $OmwFontHead
    SetCtlColors $0 0x1B1C1F 0xFFFFFF
    !insertmacro OMW_LABEL $0 ${OMW_PAD} 62 488 40 "$R4" $OmwFontBody
    SetCtlColors $0 0x45474D 0xFFFFFF
    ${If} $R5 != ""
      !insertmacro OMW_LABEL $0 ${OMW_PAD} 84 488 20 "$R5" $OmwFontSmall
      SetCtlColors $0 0x62646B 0xFFFFFF
    ${EndIf}
  FunctionEnd

  ; Progress page: restyles NSIS's own progress dialog (bar + status line), hides the details list.
  Function ${un}OmwInstShow
    Call ${un}OmwCaption
    ${If} $PassiveMode <> 1
      ; back to the folded height if the options were open
      StrCpy $OmwBodyH ${OMW_BODY}
      Call ${un}OmwLayout
    ${EndIf}
    FindWindow $OmwDlg "#32770" "" $HWNDPARENT
    ; the stock progress dialog keeps its own template size and has more than the bar: fill the body with it and
    ; move everything but the bar (1004) and the status line (1006) out of sight (details list, its button, icon)
    !insertmacro OMW_PLACE $OmwDlg 0 $OmwHeroH $OmwClientW $OmwBodyH
    Push $OmwDlg
    Call ${un}OmwClipChildren
    StrCpy $1 0
    ${Do}
      FindWindow $2 "" "" $OmwDlg $1
      ${If} $2 = 0
        ${Break}
      ${EndIf}
      System::Call 'user32::GetDlgCtrlID(p r2) i .r3'
      ${If} $3 <> 1004
      ${AndIf} $3 <> 1006
        System::Call 'user32::SetWindowPos(p r2, p 0, i -6000, i -6000, i 0, i 0, i 0x15)'
      ${EndIf}
      StrCpy $1 $2
    ${Loop}
    GetDlgItem $1 $OmwDlg 1004
    GetDlgItem $2 $OmwDlg 1006
    ; flat bar: no theme, no border, smooth, brand colours
    System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
    System::Call 'user32::GetWindowLongW(p r1, i -16) i .r3'
    IntOp $3 $3 & 0xFF7FFFFF
    IntOp $3 $3 | 1
    System::Call 'user32::SetWindowLongW(p r1, i -16, i r3)'
    System::Call 'user32::SetWindowLongW(p r1, i -20, i 0)'
    SendMessage $1 0x0409 0 0x00CF621F   ; PBM_SETBARCOLOR (BGR of 0x1F62CF)
    SendMessage $2 ${WM_SETFONT} $OmwFontSmall 1
    ${If} $PassiveMode = 1
      SetCtlColors $OmwDlg 0xECECEE 0x1C1D20
      SendMessage $1 0x2001 0 0x00322E2D   ; PBM_SETBKCOLOR (BGR of 0x272A33)
      SendMessage $1 0x0409 0 0x00DC6F2F   ; the dark band's accent (0x7C5CFF)
      !insertmacro OMW_PLACE $1 24 6 372 4
      System::Call 'user32::SetWindowPos(p r2, p 0, i -6000, i -6000, i 0, i 0, i 0x15)'
    ${Else}
      SetCtlColors $OmwDlg 0x1B1C1F 0xFFFFFF
      SetCtlColors $2 0x62646B 0xFFFFFF
      SendMessage $1 0x2001 0 0x00EDEBEB   ; PBM_SETBKCOLOR (BGR of 0xEBEBED)
      !insertmacro OMW_PLACE $1 ${OMW_PAD} 102 488 6
      !insertmacro OMW_PLACE $2 ${OMW_PAD} 64 488 22
      ; the page's own head line
      !insertmacro OMW_PX $OmwX ${OMW_PAD}
      !insertmacro OMW_PX $OmwY 26
      !insertmacro OMW_PX $OmwCW 488
      !insertmacro OMW_PX $OmwCH 30
      !if "${un}" == "un."
        StrCpy $3 $L_UnWorking
      !else
        StrCpy $3 $L_Working
      !endif
      System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "$3", i ${OMW_STYLE_HERO}, i $OmwX, i $OmwY, i $OmwCW, i $OmwCH, p $OmwDlg, p 0, p 0, p 0) p .r3'
      SendMessage $3 ${WM_SETFONT} $OmwFontHead 1
      SetCtlColors $3 0x1B1C1F 0xFFFFFF
    ${EndIf}
    System::Call 'user32::SetWindowPos(p r1, p 0, i 0, i 0, i 0, i 0, i 0x37)'   ; SWP_FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
  FunctionEnd
!macroend

!insertmacro OMW_SHARED ""
!insertmacro OMW_SHARED "un."

; ---------------------------------------------------------------------------------------------------------------
; Installer pages: one screen -> progress -> done
; ---------------------------------------------------------------------------------------------------------------
Page custom OmwWelcomeCreate OmwWelcomeLeave
Page instfiles "" OmwInstShow ""
Page custom OmwFinishCreate OmwFinishLeave

Function .onGUIInit
  Call OmwInitWindow
FunctionEnd

; The install screen. The options (language, folder, desktop shortcut) are always built, under the buttons, and the
; window only shows them when they are open: opening or closing them eases the window height (OmwAnimate) and
; nothing on the page is rebuilt, so there is no flash. (Rebuilding the page on each toggle repainted the whole
; window at the new size and flickered.)
Function OmwWelcomeCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  StrCpy $OmwReloading 0
  ${If} $OmwOpt = 1
    IntOp $OmwBodyH ${OMW_BODY} + ${OMW_OPTS}
  ${Else}
    StrCpy $OmwBodyH ${OMW_BODY}
  ${EndIf}
  IntOp $OmwPageH ${OMW_BODY} + ${OMW_OPTS}
  Call OmwPage
  StrCpy $R3 $L_Head
  StrCpy $R4 $L_Text
  StrCpy $R5 $L_Meta
  Call OmwTexts

  ; footer: options toggle on the left, the one button on the right
  !insertmacro OMW_CTL $OmwLinkA STATIC 0x50000380 0 ${OMW_PAD} ${OMW_FOOT} 220 ${OMW_BTN_H} ""
  SendMessage $OmwLinkA ${WM_SETFONT} $OmwFontBody 1
  SetCtlColors $OmwLinkA 0x1B58C0 0xFFFFFF
  Call OmwOptionsArrow
  ${NSD_OnClick} $OmwLinkA OmwToggleOptions
  StrCpy $0 ${OMW_FOOT}
  StrCpy $1 148
  StrCpy $2 0
  StrCpy $R1 $L_Go
  Call OmwFooter

  ; options, below the fold
  !insertmacro OMW_CTL $1 STATIC 0x50000000 0 ${OMW_PAD} ${OMW_BODY} 488 1 ""
  SetCtlColors $1 0xDADBDE 0xDADBDE
  ; language
  !insertmacro OMW_LABEL $1 ${OMW_PAD} 206 120 24 "$L_Lang" $OmwFontBody
  SetCtlColors $1 0x45474D 0xFFFFFF
  !insertmacro OMW_CTL $OmwCombo COMBOBOX 0x50210003 0 160 202 220 200 ""
  SendMessage $OmwCombo ${WM_SETFONT} $OmwFontUi 1
  ${NSD_CB_AddString} $OmwCombo "한국어"
  ${NSD_CB_AddString} $OmwCombo "English"
  ${NSD_CB_AddString} $OmwCombo "简体中文"
  ${NSD_CB_AddString} $OmwCombo "日本語"
  ${If} $LANGUAGE == 1033
    SendMessage $OmwCombo ${CB_SETCURSEL} 1 0
  ${ElseIf} $LANGUAGE == 2052
    SendMessage $OmwCombo ${CB_SETCURSEL} 2 0
  ${ElseIf} $LANGUAGE == 1041
    SendMessage $OmwCombo ${CB_SETCURSEL} 3 0
  ${Else}
    SendMessage $OmwCombo ${CB_SETCURSEL} 0 0
  ${EndIf}
  ${NSD_OnChange} $OmwCombo OmwLanguageChanged
  ; folder
  !insertmacro OMW_LABEL $1 ${OMW_PAD} 246 120 24 "$L_Dir" $OmwFontBody
  SetCtlColors $1 0x45474D 0xFFFFFF
  ${If} $OmwKind <> 0
    ; An existing install is updated where it is: the folder is plain read-only text (the middle of a long path is
    ; shortened with …), not a greyed-out field.
    StrCpy $OmwDirEdit 0
    StrCpy $OmwBrowseBtn 0
    !insertmacro OMW_CTL $1 STATIC 0x50008280 0 160 244 364 26 "$INSTDIR"   ; SS_PATHELLIPSIS|SS_CENTERIMAGE
    SendMessage $1 ${WM_SETFONT} $OmwFontUi 1
    SetCtlColors $1 0x1B1C1F 0xFFFFFF
    !insertmacro OMW_LABEL $1 160 270 364 20 "$L_DirLocked" $OmwFontSmall
    SetCtlColors $1 0x62646B 0xFFFFFF
  ${Else}
    !insertmacro OMW_CTL $OmwDirEdit EDIT 0x50010080 0x200 160 242 266 28 "$INSTDIR"
    SendMessage $OmwDirEdit ${WM_SETFONT} $OmwFontUi 1
    ${NSD_OnChange} $OmwDirEdit OmwDirChanged
    !insertmacro OMW_CTL $OmwBrowseBtn BUTTON 0x50010000 0 434 241 90 30 "$L_Change"
    SendMessage $OmwBrowseBtn ${WM_SETFONT} $OmwFontBody 1
    ${NSD_OnClick} $OmwBrowseBtn OmwBrowse
  ${EndIf}
  ; desktop shortcut
  ${If} $OmwKind <> 0
    StrCpy $0 300
  ${Else}
    StrCpy $0 286
  ${EndIf}
  !insertmacro OMW_CTL $OmwDeskCheck BUTTON 0x50012C03 0 160 $0 364 26 "$L_Desktop"
  SendMessage $OmwDeskCheck ${WM_SETFONT} $OmwFontBody 1
  SetCtlColors $OmwDeskCheck 0x1B1C1F 0xFFFFFF
  ${If} $OmwDesktop = 1
    ${NSD_Check} $OmwDeskCheck
  ${EndIf}
  ${NSD_OnClick} $OmwDeskCheck OmwDeskChanged
  Call OmwOptionsEnable

  ; after a language change the page was rebuilt with drawing locked: show it in one go
  ${If} $OmwLocked = 1
    StrCpy $OmwLocked 0
    System::Call 'user32::LockWindowUpdate(p 0)'
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x585)'   ; ERASE|FRAME|INVALIDATE|ALLCHILDREN|UPDATENOW
  ${EndIf}
  nsDialogs::Show
FunctionEnd

; ▾ when folded (more below), ▴ when open
Function OmwOptionsArrow
  ${If} $OmwOpt = 1
    SendMessage $OmwLinkA ${WM_SETTEXT} 0 "STR:$L_Options  ▴"
  ${Else}
    SendMessage $OmwLinkA ${WM_SETTEXT} 0 "STR:$L_Options  ▾"
  ${EndIf}
FunctionEnd

; Folded options cannot take the keyboard focus (they are out of sight).
Function OmwOptionsEnable
  EnableWindow $OmwCombo $OmwOpt
  EnableWindow $OmwDeskCheck $OmwOpt
  ${If} $OmwDirEdit <> 0
    EnableWindow $OmwDirEdit $OmwOpt
    EnableWindow $OmwBrowseBtn $OmwOpt
  ${EndIf}
FunctionEnd

Function OmwPrimaryClick
  Call OmwNext
FunctionEnd

Function OmwQuietClick
  ; finish page: Close
  Call OmwNext
FunctionEnd

Function OmwToggleOptions
  ${If} $OmwOpt = 1
    StrCpy $OmwOpt 0
    IntOp $OmwBodyH ${OMW_BODY} + 0
    Call OmwOptionsArrow
    ; move the focus off the options before they are covered
    GetDlgItem $0 $HWNDPARENT 1
    System::Call 'user32::SetFocus(p r0)'
    Call OmwAnimate
    Call OmwOptionsEnable
  ${Else}
    StrCpy $OmwOpt 1
    IntOp $OmwBodyH ${OMW_BODY} + ${OMW_OPTS}
    Call OmwOptionsArrow
    Call OmwOptionsEnable
    Call OmwAnimate
  ${EndIf}
FunctionEnd

; The language changes every word on the page and its font, so the page is rebuilt — with drawing locked until the
; new page is complete (OmwWelcomeCreate unlocks it), so it appears at once instead of control by control.
Function OmwLanguageChanged
  SendMessage $OmwCombo ${CB_GETCURSEL} 0 0 $0
  ${If} $0 = 1
    StrCpy $LANGUAGE 1033
  ${ElseIf} $0 = 2
    StrCpy $LANGUAGE 2052
  ${ElseIf} $0 = 3
    StrCpy $LANGUAGE 1041
  ${Else}
    StrCpy $LANGUAGE 1042
  ${EndIf}
  System::Call 'user32::LockWindowUpdate(p $HWNDPARENT)'
  StrCpy $OmwLocked 1
  Call OmwStrings
  Call OmwFonts
  SendMessage $OmwHeroTag ${WM_SETTEXT} 0 "STR:$L_Tag"
  SendMessage $OmwHeroTag ${WM_SETFONT} $OmwFontTag 0
  StrCpy $OmwReloading 1
  ${NSD_KillTimer} OmwHoverTick
  SendMessage $HWNDPARENT 0x408 0 0   ; WM_NOTIFY_OUTER_NEXT, 0 = show this page again
FunctionEnd

Function OmwDirChanged
  ${NSD_GetText} $OmwDirEdit $INSTDIR
FunctionEnd

Function OmwDeskChanged
  ${NSD_GetState} $OmwDeskCheck $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $OmwDesktop 1
  ${Else}
    StrCpy $OmwDesktop 0
  ${EndIf}
FunctionEnd

Function OmwBrowse
  nsDialogs::SelectFolderDialog "$L_PickDir" "$INSTDIR"
  Pop $0
  ${If} $0 == error
  ${OrIf} $0 == ""
    Return
  ${EndIf}
  ; like the stock directory page: a chosen parent folder gets the product folder appended
  ${GetFileName} $0 $1
  ${If} $1 != "${PRODUCTNAME}"
    StrCpy $0 "$0\${PRODUCTNAME}"
    ; "C:\" + name would give "C:\\Omniweave"
    ${WordReplace} $0 "\\" "\" "+" $0
  ${EndIf}
  StrCpy $INSTDIR $0
  ${NSD_SetText} $OmwDirEdit $INSTDIR
FunctionEnd

Function OmwWelcomeLeave
  ${If} $OmwReloading = 1
    StrCpy $OmwReloading 0
    ${NSD_KillTimer} OmwHoverTick
    Return
  ${EndIf}
  ${If} $INSTDIR == ""
    ; an emptied folder field goes back to the default instead of doing nothing
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    ${NSD_SetText} $OmwDirEdit $INSTDIR
    Abort
  ${EndIf}
  ; only a full path (D:\... or \\server\...): a typed "C" or "Apps\x" would install relative to the current folder
  StrCpy $1 $INSTDIR 2 1
  StrCpy $2 $INSTDIR 2
  ${If} $1 != ":\"
  ${AndIf} $2 != "\\"
    MessageBox MB_ICONINFORMATION|MB_OK "$L_BadDir"
    System::Call 'user32::SetFocus(p $OmwDirEdit)'
    Abort
  ${EndIf}
  ${NSD_KillTimer} OmwHoverTick
FunctionEnd

Function OmwFinishCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  StrCpy $OmwBodyH ${OMW_BODY}
  Call OmwPage
  StrCpy $R3 $L_DoneHead
  StrCpy $R4 $L_DoneText
  StrCpy $R5 ""
  Call OmwTexts
  StrCpy $0 ${OMW_FOOT}
  StrCpy $1 168
  StrCpy $2 96
  StrCpy $R1 $L_Launch
  StrCpy $R2 $L_Close
  Call OmwFooter
  ${NSD_OnClick} $OmwBtnA OmwLaunchClick
  nsDialogs::Show
FunctionEnd

Function OmwLaunchClick
  Call RunMainBinary
  Call OmwNext
FunctionEnd

Function OmwFinishLeave
  ${NSD_KillTimer} OmwHoverTick
FunctionEnd

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

Function .onInstFailed
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
    MessageBox MB_ICONEXCLAMATION|MB_OK "$L_Failed"
  ${EndIf}
FunctionEnd

; Existing install: 0 none, 1 older (update), 2 same version, 3 newer installed. Its folder is kept.
Function OmwDetectExisting
  StrCpy $OmwKind 0
  StrCpy $OmwOldVer ""
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $0 == ""
    Return
  ${EndIf}
  ReadRegStr $OmwOldVer SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $OmwOldVer == ""
    StrCpy $OmwKind 1
    Return
  ${EndIf}
  nsis_tauri_utils::SemverCompare "${VERSION}" $OmwOldVer
  Pop $0
  ${If} $0 = 0
    StrCpy $OmwKind 2
  ${ElseIf} $0 = -1
    StrCpy $OmwKind 3
  ${Else}
    StrCpy $OmwKind 1
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------
; Uninstaller pages: one question -> progress -> done
; ---------------------------------------------------------------------------------------------------------------
UninstPage custom un.OmwConfirmCreate un.OmwConfirmLeave
UninstPage instfiles "" un.OmwInstShow ""
UninstPage custom un.OmwDoneCreate un.OmwDoneLeave

Function un.onGUIInit
  Call un.OmwInitWindow
FunctionEnd

Function un.OmwConfirmCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  StrCpy $OmwBodyH ${OMW_BODY}
  Call un.OmwPage
  StrCpy $R3 $L_UnHead
  StrCpy $R4 $L_UnText
  StrCpy $R5 ""
  Call un.OmwTexts
  !insertmacro OMW_CTL $OmwDataCheck BUTTON 0x50012C03 0 ${OMW_PAD} 88 488 26 "$L_UnData"
  SendMessage $OmwDataCheck ${WM_SETFONT} $OmwFontBody 1
  SetCtlColors $OmwDataCheck 0x1B1C1F 0xFFFFFF
  StrCpy $OmwBtnAKind 3
  StrCpy $0 ${OMW_FOOT}
  StrCpy $1 128
  StrCpy $2 96
  StrCpy $R1 $L_UnGo
  StrCpy $R2 $L_Cancel
  Call un.OmwFooter
  nsDialogs::Show
FunctionEnd

Function un.OmwPrimaryClick
  Call un.OmwNext
FunctionEnd

Function un.OmwQuietClick
  ; confirm page: Cancel; done page has no quiet button
  Call un.OmwCancel
FunctionEnd

Function un.OmwConfirmLeave
  ${NSD_KillTimer} un.OmwHoverTick
  ${NSD_GetState} $OmwDataCheck $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $DeleteAppDataCheckboxState 1
  ${Else}
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
FunctionEnd

Function un.OmwDoneCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  StrCpy $OmwBodyH ${OMW_BODY}
  Call un.OmwPage
  StrCpy $R3 $L_UnDoneHead
  StrCpy $R4 $L_UnDoneText
  StrCpy $R5 ""
  Call un.OmwTexts
  StrCpy $0 ${OMW_FOOT}
  StrCpy $1 128
  StrCpy $2 0
  StrCpy $R1 $L_Close
  Call un.OmwFooter
  nsDialogs::Show
FunctionEnd

Function un.OmwDoneLeave
  ${NSD_KillTimer} un.OmwHoverTick
FunctionEnd

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; No language dialog, ever (an update must not stop on a question): the remembered or the system language is
  ; used, and the language can be changed under Options on the install screen.
  Call OmwPickLanguage

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}

  Call OmwDetectExisting
  StrCpy $OmwDesktop 1
  StrCpy $OmwOpt 0
  StrCpy $WixMode 0
FunctionEnd

Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning

  ; The status line under the bar shows plain steps, not every file and registry write.
  SetDetailsPrint textonly
  DetailPrint "$L_Copying"
  SetDetailsPrint none

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{@key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{@key}}"
  {{/each}}

  SetDetailsPrint textonly
  DetailPrint "$L_Registering"
  SetDetailsPrint none

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"
  ; GetSize leaves its own "Size: … Files: …" in the status line; put the step back
  SetDetailsPrint textonly
  DetailPrint "$L_Registering"
  SetDetailsPrint none

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut (no start menu page: the folder is the configured one)
  StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
  Call CreateOrUpdateStartMenuShortcut

  ; Desktop shortcut: the Options checkbox in the window (on by default); always for silent and passive installers.
  ; CreateOrUpdateDesktopShortcut itself skips updates (/UPDATE) and /NS.
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
  ${OrIf} $OmwDesktop = 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Close the progress page by itself: passive installs end there, the window goes on to the done page.
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      ; the updater passes the old run's arguments; a QA `--update-test` run restarts as a normal launch
      ; (its first check then is the ordinary 4-second one, as for every user)
      ${WordReplace} $R0 "--update-test" "" "+" $R0
      ; RunAsUser starts the app under explorer (never elevated). An install run from a packaged app (Claude Desktop
      ; in QA) lands in that app's private %LOCALAPPDATA% copy, so the app started here cannot resolve its own path
      ; and every update check of that run fails ("os error 3") — QA installs from outside it (docs/RELEASING.md).
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  ; the language of the install (remembered by installer-hooks.nsh), else the system language; no dialog
  Call un.OmwPickLanguage

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  StrCpy $OmwKind 0
FunctionEnd

Section Uninstall
  SetDetailsPrint none

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Close the progress page by itself: passive/update uninstalls end there, the window goes on to the done page.
  SetAutoClose true
SectionEnd
Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
