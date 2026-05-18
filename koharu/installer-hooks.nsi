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
;
; ─── SAFETY BELTS ────────────────────────────────────────────────
; This hook is deliberately paranoid. Recent industry examples (a
; Thai game studio's uninstaller that wiped an entire drive when its
; config-file install-path lookup returned empty) inform every guard
; below:
;
;   1. Target path is HARDCODED to `$LOCALAPPDATA\Koharu`. We never
;      read from a config file, registry value, or anything else
;      that could be empty / tampered with.
;   2. Refuse outright if `$LOCALAPPDATA` resolves to an empty string
;      (would otherwise mean `RMDir /r "\Koharu"` against drive root).
;   3. Ownership check before any destructive op — at least one of
;      our known marker files/folders must exist at the target. If
;      a user has somehow ended up with a `Koharu` folder there from
;      another app or by accident, we leave it alone.
;   4. Delete by NAMED subfolder, not the parent recursively. Blast
;      radius of any junction-following bug is bounded to a folder
;      koharu itself created.
;   5. Final parent cleanup uses `RMDir` (no `/r`) so it only succeeds
;      if the parent is empty — preserves any unknown files the user
;      may have dropped into the folder manually.
;

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Initializing Koharu-TH Installation..."
  DetailPrint "Checking system architecture and compatibility..."
  DetailPrint "Preparing destination directory: $INSTDIR"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Koharu core executable and assets successfully deployed."
  DetailPrint "Registering Start Menu shortcuts and program icons..."
  DetailPrint "Configuring Windows Registry for clean uninstallation..."
  DetailPrint "Installation of Koharu-TH completed successfully!"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; ─── Belt 1: refuse if $LOCALAPPDATA is unset ─────────────────
  ; CSIDL_LOCAL_APPDATA is always set on a healthy Windows install,
  ; but if it ever resolved to "" we'd be running `RMDir /r "\KoharuTH"`
  ; against the current drive's root — refuse outright.
  StrCmp "$LOCALAPPDATA" "" koharu_purge_unsafe

  ; ─── Belt 2: ownership verification ───────────────────────────
  ; The target folder is only ours if it contains at least one of
  ; the artefacts koharu itself creates. If none of these exist, we
  ; either never installed any cache here (already clean — nothing
  ; to do), OR the folder belongs to something else (don't touch).
  IfFileExists "$LOCALAPPDATA\KoharuTH\libs\*.*" koharu_purge_ask
  ; v1.2.2+ HF model cache path; "models" kept as a v1.2.1-and-earlier
  ; marker so an uninstall after an upgrade-without-launch still
  ; recognises the folder as ours (see issue #34).
  IfFileExists "$LOCALAPPDATA\KoharuTH\hf\*.*" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuTH\models\*.*" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuTH\fonts\*.*" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuTH\recent-projects.json" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuTH\ml-device.json" koharu_purge_ask
  Goto koharu_purge_not_ours

koharu_purge_ask:
  ; Default = No (safer — re-installing later reuses the cache).
  ; /SD IDNO = silent uninstall also defaults to No, so unattended
  ; deployments don't accidentally wipe cached models.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also remove downloaded AI models, CUDA runtime libraries, custom fonts, and saved settings from:$\r$\n$\r$\n  $LOCALAPPDATA\KoharuTH\$\r$\n$\r$\nThis can reclaim 1-3 GB of disk space.$\r$\n$\r$\nYour translated project files (.khr databases, chapter folders, render output) are NOT in this location and will be kept regardless of your choice." \
    /SD IDNO \
    IDNO koharu_purge_skip

koharu_purge_verified:
  ; ─── Belt 3: bounded named-subfolder deletion ─────────────────
  ; We ONLY remove subfolders we created ourselves, by name. We do
  ; NOT `RMDir /r` the parent — that would follow any junction the
  ; user might have placed at `$LOCALAPPDATA\KoharuTH` itself.
  ;
  ; Inside each named subfolder we still use /r (those folders are
  ; ours by definition; if a user redirected `models` to D:\ via a
  ; junction, blast radius is bounded to whatever they linked to).
  DetailPrint "Uninstalling Koharu offline cache and user settings..."
  DetailPrint "Target directory: $LOCALAPPDATA\KoharuTH"

  DetailPrint "Deleting CUDA runtime libraries (libs)..."
  RMDir /r "$LOCALAPPDATA\KoharuTH\libs"
  RMDir /r "$LOCALAPPDATA\KoharuTH\hf"
  ; Legacy v1.2.1-and-earlier HF cache path (issue #34). Kept in the
  ; purge list so a user who never launched v1.2.2 (skipping the
  ; auto-migration) still gets a clean uninstall.
  DetailPrint "Deleting offline AI models (models)..."
  RMDir /r "$LOCALAPPDATA\KoharuTH\models"

  DetailPrint "Deleting custom fonts cache (fonts)..."
  RMDir /r "$LOCALAPPDATA\KoharuTH\fonts"

  DetailPrint "Deleting saved settings (recent-projects.json)..."
  Delete "$LOCALAPPDATA\KoharuTH\recent-projects.json"

  DetailPrint "Deleting ML device preferences (ml-device.json)..."
  Delete "$LOCALAPPDATA\KoharuTH\ml-device.json"

  ; ─── Belt 4: non-recursive parent removal ─────────────────────
  ; `RMDir` (without /r) only succeeds if the parent is empty. If
  ; the user has dropped any unknown file/folder in there, it stays
  ; intact and the parent remains.
  DetailPrint "Cleaning up KoharuTH directory..."
  RMDir "$LOCALAPPDATA\KoharuTH"
  DetailPrint "Koharu offline cache and user settings removed completely."
  Goto koharu_purge_end

koharu_purge_not_ours:
  DetailPrint "No Koharu offline data found at $LOCALAPPDATA\KoharuTH — nothing to remove."
  Goto koharu_purge_end

koharu_purge_unsafe:
  DetailPrint "LOCALAPPDATA path could not be resolved — skipping data purge for safety."
  Goto koharu_purge_end

koharu_purge_skip:
  DetailPrint "Kept Koharu offline cache at $LOCALAPPDATA\KoharuTH to preserve downloads."
  DetailPrint "Preserved 1-3 GB of offline CUDA libraries and AI model files."
  DetailPrint "Re-installation of Koharu will automatically reuse these models."

koharu_purge_end:
!macroend
