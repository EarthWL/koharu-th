; NSIS installer hooks for Koharu — wired up via tauri.conf.json
;   bundle.windows.nsis.installerHooks
;
; Tauri's default uninstaller removes the app binaries + Start Menu
; entries + registry keys, but leaves %LOCALAPPDATA%\Koharu\ behind.
; That folder holds ~1-3 GB of downloaded CUDA dylibs + HF model cache
; + custom fonts + recent-projects.json. Most users don't realise it
; exists, so on uninstall we offer to clean it up.
;
; Project files (.khr databases, chapter folders, render output) are
; NEVER inside %LOCALAPPDATA%\Koharu — those live in user-chosen
; locations and are untouched regardless of which button the user
; picks here.

!macro NSIS_HOOK_PREUNINSTALL
  ; Default = No (safer — re-installing later reuses the cache).
  ; User actively picks Yes to reclaim disk space.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also remove downloaded AI models, CUDA runtime libraries, custom fonts, and saved settings from:$\r$\n$\r$\n  $LOCALAPPDATA\Koharu\$\r$\n$\r$\nThis can reclaim 1-3 GB of disk space.$\r$\n$\r$\nYour translated project files (.khr databases, chapter folders, render output) are NOT in this location and will be kept regardless of your choice." \
    /SD IDNO \
    IDNO koharu_skip_data_purge
    DetailPrint "Removing Koharu application data..."
    RMDir /r "$LOCALAPPDATA\Koharu"
    DetailPrint "Done."
    Goto koharu_data_purge_end
  koharu_skip_data_purge:
    DetailPrint "Kept Koharu application data at $LOCALAPPDATA\Koharu (re-install will reuse cached models)."
  koharu_data_purge_end:
!macroend
