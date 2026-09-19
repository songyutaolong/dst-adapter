; Remove installations and shortcuts created under the legacy product name.

!macro DST_ADAPTER_CLEAN_LEGACY_SHORTCUTS
  SetShellVarContext current
  Delete "$DESKTOP\大算头适配器.lnk"
  Delete "$SMPROGRAMS\大算头适配器.lnk"
  RMDir "$SMPROGRAMS\大算头适配器"

  SetShellVarContext all
  Delete "$DESKTOP\大算头适配器.lnk"
  Delete "$SMPROGRAMS\大算头适配器.lnk"
  RMDir "$SMPROGRAMS\大算头适配器"

  ${if} $installMode == "all"
    SetShellVarContext all
  ${else}
    SetShellVarContext current
  ${endif}
!macroend

!macro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY DIR
  ${if} ${FileExists} "${DIR}"
  ${andIf} "${DIR}" != "$INSTDIR"
    RMDir /r "${DIR}"
  ${endif}
!macroend

!macro DST_ADAPTER_CLEAN_LEGACY_DIRECTORIES
  !insertmacro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY "$LOCALAPPDATA\Programs\大算头适配器"
  !insertmacro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY "$PROGRAMFILES\大算头适配器"
  !insertmacro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY "$PROGRAMFILES32\大算头适配器"
  !insertmacro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY "$LOCALAPPDATA\Programs\dst-adapter"
  !insertmacro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY "$PROGRAMFILES\dst-adapter"
  !insertmacro DST_ADAPTER_REMOVE_LEGACY_DIRECTORY "$PROGRAMFILES32\dst-adapter"
!macroend

!macro customInstall
  Delete "$INSTDIR\大算头适配器.exe"
  Delete "$INSTDIR\Uninstall 大算头适配器.exe"
  !insertmacro DST_ADAPTER_CLEAN_LEGACY_SHORTCUTS
  !insertmacro DST_ADAPTER_CLEAN_LEGACY_DIRECTORIES
!macroend

!macro customUnInstall
  !insertmacro DST_ADAPTER_CLEAN_LEGACY_SHORTCUTS
  !insertmacro DST_ADAPTER_CLEAN_LEGACY_DIRECTORIES
!macroend
