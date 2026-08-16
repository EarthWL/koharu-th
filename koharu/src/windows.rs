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

/// Expose the system CUDA Toolkit `bin` directory (cuBLAS, cudart, etc.)
/// to the Windows DLL loader. `cuda_is_available()` finds cuBLAS via the
/// process PATH during its probe, but `add_dll_directory` then narrows the
/// loader's default search to USER_DIRS|SYSTEM32 — dropping PATH — so the
/// first real cuBLAS call would otherwise panic inside cudarc on a
/// standalone build. Adding the toolkit bin as a user dir keeps it
/// reachable. Best-effort: logs and returns when no toolkit is found,
/// leaving the CPU fallback intact.
pub fn register_cuda_toolkit_dll_path() {
    for bin in cuda_toolkit_bin_candidates() {
        if dir_has_cublas(&bin) {
            match add_dll_directory(&bin) {
                Ok(()) => {
                    tracing::info!("Registered CUDA Toolkit DLL dir: {}", bin.display());
                    return;
                }
                Err(err) => {
                    tracing::warn!(
                        ?err,
                        dir = %bin.display(),
                        "Failed to register CUDA Toolkit DLL dir"
                    );
                }
            }
        }
    }
    tracing::warn!("CUDA Toolkit bin with cuBLAS not found; cuBLAS calls may fail");
}

/// Candidate CUDA Toolkit `bin` directories in priority order: the
/// installer-exported `CUDA_PATH` / `CUDA_PATH_V*` env vars first, then any
/// `PATH` entry (the loader searches PATH before we restrict it, so that is
/// exactly where `cuda_is_available()`'s probe found cuBLAS), then the
/// default install root scanned newest-version-first. The caller only adds
/// the entries that actually contain a cuBLAS DLL, so listing all of PATH
/// is safe and covers non-standard CUDA layouts.
fn cuda_toolkit_bin_candidates() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut out: Vec<PathBuf> = Vec::new();

    for (key, val) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key == "CUDA_PATH" || key.starts_with("CUDA_PATH_V") {
            let bin = PathBuf::from(val).join("bin");
            if !out.contains(&bin) {
                out.push(bin);
            }
        }
    }

    // PATH entries verbatim — these dirs are already the loader's view, so a
    // cuBLAS-bearing one here is precisely what the startup probe matched.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if !out.contains(&dir) {
                out.push(dir);
            }
        }
    }

    let root = PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA");
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut versions: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        versions.sort();
        versions.reverse();
        for v in versions {
            let bin = v.join("bin");
            if !out.contains(&bin) {
                out.push(bin);
            }
        }
    }

    out
}

/// Whether `dir` contains a versioned cuBLAS DLL (`cublas64_*.dll`).
fn dir_has_cublas(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        name.starts_with("cublas64_") && name.ends_with(".dll")
    })
}
