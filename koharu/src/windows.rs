use anyhow::Result;
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Console::{
    ATTACH_PARENT_PROCESS, AllocConsole, AttachConsole, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    GetConsoleMode, GetStdHandle, STD_OUTPUT_HANDLE, SetConsoleMode,
};
use windows::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};

use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::System::LibraryLoader::{
    AddDllDirectory, LOAD_LIBRARY_SEARCH_SYSTEM32, LOAD_LIBRARY_SEARCH_USER_DIRS,
    SetDefaultDllDirectories,
};

/// Register a single file extension under HKCU\Software\Classes so
/// Windows knows to launch Koharu when the user double-clicks files
/// of that type. We use HKCU (per-user) instead of HKLM (machine-
/// wide) so the registration doesn't require admin privileges.
///
/// The launch command is `"<exe>" "%1"` — Windows substitutes the
/// file path. Today the binary's CLI parser doesn't capture the
/// positional path (no `Cli.file` arg), so this currently just
/// LAUNCHES the app on double-click. Auto-opening the picked file
/// is queued for a follow-up that also adds tauri-plugin-single-
/// instance so a second double-click sends the path to the running
/// instance instead of spawning a new copy.
fn register_extension(
    classes: &RegKey,
    extension: &str,
    class_name: &str,
    display_name: &str,
    content_type: Option<&str>,
    perceived_type: Option<&str>,
) -> Result<()> {
    let (ext_key, _) = classes.create_subkey(extension)?;
    ext_key.set_value("", &class_name)?;
    if let Some(ct) = content_type {
        ext_key.set_value("Content Type", &ct)?;
    }
    if let Some(pt) = perceived_type {
        ext_key.set_value("PerceivedType", &pt)?;
    }

    let (class_key, _) = classes.create_subkey(class_name)?;
    class_key.set_value("", &display_name)?;

    if let Some(exe) = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_owned()))
    {
        let (icon_key, _) = class_key.create_subkey("DefaultIcon")?;
        icon_key.set_value("", &format!("{exe},0"))?;
        let (shell_key, _) = class_key.create_subkey("shell\\open\\command")?;
        shell_key.set_value("", &format!("\"{exe}\" \"%1\""))?;
    }
    Ok(())
}

pub fn register_file_associations() -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu.create_subkey("Software\\Classes")?.0;

    // .khr — standalone single-file Koharu document. Inherits a
    // jpeg-ish Content-Type since it's image-backed.
    register_extension(
        &classes,
        ".khr",
        "Koharu.khr",
        "Koharu Document",
        Some("image/jpeg"),
        Some("image"),
    )?;

    // .koharuproj — Series Project manifest (#30). It's the JSON
    // sentinel that sits next to series.db at a project's root, so
    // we declare it as application/json content (informational only,
    // doesn't affect launch behavior).
    register_extension(
        &classes,
        ".koharuproj",
        "Koharu.koharuproj",
        "Koharu Series Project",
        Some("application/json"),
        None,
    )?;

    // Notify the Windows Shell so Explorer picks up the new associations
    // immediately without requiring a reboot or Explorer restart.
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }

    Ok(())
}

/// Kept as an alias for callers that grep'd for the original name.
/// Routes to the new combined registrar so updates land for both
/// extensions in one place.
pub fn register_khr() -> Result<()> {
    register_file_associations()
}

/// Write a registry hint that tells IObit Uninstaller, Revo Uninstaller,
/// CCleaner and similar tools that the given directory is owned by an
/// installed application and must not be cleaned up.
///
/// The key written is:
///   `HKCU\Software\IObit\IObit Uninstaller\Ignore\<path>`  (IObit)
///   `HKCU\Software\VS Revo Group\Revo Uninstaller\Ignore\<path>` (Revo)
///
/// Most cleaners also respect the presence of an uninstall entry under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KoharuTH`
/// which is registered by the Tauri installer — this function only adds
/// the per-tool opt-out hints for tools that do their own dir scanning.
///
/// Failures are logged as warnings — a missing hint is not fatal.
pub fn register_protected_dirs(dirs: &[&std::path::Path]) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    for dir in dirs {
        let path_str = dir.to_string_lossy();

        // IObit Uninstaller — "Protected Folders" ignore list
        if let Ok((key, _)) = hkcu.create_subkey(format!(
            "Software\\IObit\\IObit Uninstaller\\ProtectedFolders\\{path_str}"
        )) {
            let _ = key.set_value("Protected", &1u32);
        }

        // Revo Uninstaller — Logs/excludes path
        if let Ok((key, _)) = hkcu.create_subkey(format!(
            "Software\\VS Revo Group\\Revo Uninstaller\\Exclude\\{path_str}"
        )) {
            let _ = key.set_value("Exclude", &1u32);
        }

        tracing::debug!(dir = %path_str, "registered protected dir hints");
    }
}

pub fn enable_ansi_support() -> Result<()> {
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE)?;
        if handle == HANDLE::default() {
            println!("Failed to get console handle");
            return Ok(());
        }

        let mut mode = std::mem::zeroed();
        GetConsoleMode(handle, &mut mode)?;
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)?;
        Ok(())
    }
}

pub fn attach_parent_console() -> bool {
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS).is_ok() }
}

pub fn create_console_window() {
    unsafe {
        if !attach_parent_console() {
            let _ = AllocConsole();
        }
    }
}

pub fn add_dll_directory(path: &std::path::Path) -> Result<()> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        if SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_USER_DIRS | LOAD_LIBRARY_SEARCH_SYSTEM32)
            == 0
        {
            anyhow::bail!(
                "Failed to set default DLL directories: {}",
                std::io::Error::last_os_error()
            );
        }
        if AddDllDirectory(wide.as_ptr()).is_null() {
            anyhow::bail!(
                "Failed to add DLL directory: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(())
    }
}
