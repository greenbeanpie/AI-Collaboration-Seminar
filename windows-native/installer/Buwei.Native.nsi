Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
Name "补位 Windows 原生客户端"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Buwei.Windows.Native"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Buwei Windows Native"
VIAddVersionKey "FileDescription" "补位 Windows 原生客户端安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此版本需要 Windows x64。"
    Abort
  ${EndIf}
FunctionEnd
Section "补位"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=WindowsAppRuntimeInstall.exe "${RUNTIME_INSTALLER}"
  ExecWait '"$PLUGINSDIR\WindowsAppRuntimeInstall.exe" --quiet' $0
  ${If} $0 != 0
    ${If} $0 != 3010
      MessageBox MB_ICONSTOP "Windows App Runtime 安装失败（$0）。现有客户端和数据未被替换。"
      Abort
    ${EndIf}
  ${EndIf}
  # Stage a new version independently. Failure never overwrites the active version.
  IfFileExists "$INSTDIR\versions\${APP_VERSION}\Buwei.Windows.exe" 0 newVersion
  MessageBox MB_ICONSTOP "此版本已存在。请先通过设置卸载该版本后重装；本地数据将保留。"
  Abort
  newVersion:
  ClearErrors
  SetOutPath "$INSTDIR\versions\${APP_VERSION}"
  File /r "${PUBLISH_DIR}\*.*"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "新版本写入失败。旧版本和数据仍被保留。"
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\补位原生客户端"
  CreateShortcut "$SMPROGRAMS\补位原生客户端\补位.lnk" "$INSTDIR\versions\${APP_VERSION}\Buwei.Windows.exe"
  WriteRegStr HKCU "Software\Classes\buwei-windows-native" "" "URL:Buwei Windows Native"
  WriteRegStr HKCU "Software\Classes\buwei-windows-native" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\buwei-windows-native\shell\open\command" "" '$\"$INSTDIR\versions\${APP_VERSION}\Buwei.Windows.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Buwei.Windows.Native" "DisplayName" "补位 Windows 原生客户端"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Buwei.Windows.Native" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Buwei.Windows.Native" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Classes\buwei-windows-native"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Buwei.Windows.Native"
  RMDir /r "$SMPROGRAMS\补位原生客户端"
  RMDir /r "$INSTDIR"
  # Account databases, drafts and capture recovery files under LocalAppData are preserved.
SectionEnd
