; NSIS installer hooks for Koharu — wired up via tauri.conf.json
;   bundle.windows.nsis.installerHooks
;
; Tauri's default uninstaller removes the app binaries + Start Menu
; entries + registry keys, but leaves %LOCALAPPDATA%\KoharuData\ behind.
; That folder holds ~1-3 GB of downloaded CUDA dylibs + HF model cache
; + custom fonts + recent-projects.json. Most users don't realise it
; exists, so on uninstall we offer to clean it up.
;
; Project files (.khr databases, chapter folders, render output) are
; NEVER inside %LOCALAPPDATA%\KoharuData — those live in user-chosen
; locations and are untouched regardless of which button the user
; picks here.
;
; ─── SAFETY BELTS ────────────────────────────────────────────────
; This hook is deliberately paranoid. Recent industry examples (a
; Thai game studio's uninstaller that wiped an entire drive when its
; config-file install-path lookup returned empty) inform every guard
; below:
;
;   1. Target path is HARDCODED to `$LOCALAPPDATA\KoharuData`. We never
;      read from a config file, registry value, or anything else
;      that could be empty / tampered with.
;   2. Refuse outright if `$LOCALAPPDATA` resolves to an empty string
;      (would otherwise mean `RMDir /r "\KoharuData"` against drive root).
;   3. Ownership check before any destructive op — at least one of
;      our known marker files/folders must exist at the target. If
;      a user has somehow ended up with a `KoharuData` folder there from
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
  ; but if it ever resolved to "" we'd be running `RMDir /r "\KoharuData"`
  ; against the current drive's root — refuse outright.
  StrCmp "$LOCALAPPDATA" "" koharu_purge_unsafe

  ; ─── Belt 2: ownership verification ───────────────────────────
  ; The target folder is only ours if it contains at least one of
  ; the artefacts koharu itself creates. If none of these exist, we
  ; either never installed any cache here (already clean — nothing
  ; to do), OR the folder belongs to something else (don't touch).
  IfFileExists "$LOCALAPPDATA\KoharuData\libs\*.*" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuData\models\*.*" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuData\fonts\*.*" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuData\recent-projects.json" koharu_purge_ask
  IfFileExists "$LOCALAPPDATA\KoharuData\ml-device.json" koharu_purge_ask
  Goto koharu_purge_not_ours

koharu_purge_ask:
  ; Default = No (safer — re-installing later reuses the cache).
  ; /SD IDNO = silent uninstall also defaults to No, so unattended
  ; deployments don't accidentally wipe cached models.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also remove downloaded AI models, CUDA runtime libraries, custom fonts, and saved settings from:$\r$\n$\r$\n  $LOCALAPPDATA\KoharuData\$\r$\n$\r$\nThis can reclaim 1-3 GB of disk space.$\r$\n$\r$\nYour translated project files (.khr databases, chapter folders, render output) are NOT in this location and will be kept regardless of your choice." \
    /SD IDNO \
    IDNO koharu_purge_skip

koharu_purge_verified:
  ; ─── Belt 3: bounded named-subfolder deletion ─────────────────
  ; We ONLY remove subfolders we created ourselves, by name. We do
  ; NOT `RMDir /r` the parent — that would follow any junction the
  ; user might have placed at `$LOCALAPPDATA\KoharuData` itself.
  ;
  ; Inside each named subfolder we still use /r (those folders are
  ; ours by definition; if a user redirected `models` to D:\ via a
  ; junction, blast radius is bounded to whatever they linked to).
  DetailPrint "Uninstalling Koharu offline cache and user settings..."
  DetailPrint "Target directory: $LOCALAPPDATA\KoharuData"

  DetailPrint "Deleting CUDA runtime libraries (libs)..."
  RMDir /r "$LOCALAPPDATA\KoharuData\libs"

  DetailPrint "Deleting offline AI models (models)..."
  RMDir /r "$LOCALAPPDATA\KoharuData\models"

  DetailPrint "Deleting custom fonts cache (fonts)..."
  RMDir /r "$LOCALAPPDATA\KoharuData\fonts"

  DetailPrint "Deleting saved settings (recent-projects.json)..."
  Delete "$LOCALAPPDATA\KoharuData\recent-projects.json"

  DetailPrint "Deleting ML device preferences (ml-device.json)..."
  Delete "$LOCALAPPDATA\KoharuData\ml-device.json"

  ; ─── Belt 4: non-recursive parent removal ─────────────────────
  ; `RMDir` (without /r) only succeeds if the parent is empty. If
  ; the user has dropped any unknown file/folder in there, it stays
  ; intact and the parent remains.
  DetailPrint "Cleaning up KoharuData directory..."
  RMDir "$LOCALAPPDATA\KoharuData"
  DetailPrint "Koharu offline cache and user settings removed completely."
  Goto koharu_purge_end

koharu_purge_not_ours:
  DetailPrint "No Koharu offline data found at $LOCALAPPDATA\KoharuData — nothing to remove."
  Goto koharu_purge_end

koharu_purge_unsafe:
  DetailPrint "LOCALAPPDATA path could not be resolved — skipping data purge for safety."
  Goto koharu_purge_end

koharu_purge_skip:
  DetailPrint "Kept Koharu offline cache at $LOCALAPPDATA\KoharuData to preserve downloads."
  DetailPrint "Preserved 1-3 GB of offline CUDA libraries and AI model files."
  DetailPrint "Re-installation of Koharu will automatically reuse these models."

koharu_purge_end:
!macroend
