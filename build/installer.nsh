; Remove installations and shortcuts created under the legacy product name.

; Versioned installation directories are left to electron-builder's uninstall flow.
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

!macro customInstall
  Delete "$INSTDIR\大算头适配器.exe"
  Delete "$INSTDIR\Uninstall 大算头适配器.exe"
  !insertmacro DST_ADAPTER_CLEAN_LEGACY_SHORTCUTS
!macroend

!macro customUnInstall
  !insertmacro DST_ADAPTER_CLEAN_LEGACY_SHORTCUTS
!macroend
