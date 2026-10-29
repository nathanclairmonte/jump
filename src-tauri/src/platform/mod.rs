//! The home of `#[cfg]` in the shell.
//!
//! Every genuinely OS-specific operation should live behind this module so that every other
//! file calls `platform::…` and never learns which OS it is on. The `PLATFORM` constant is
//! resolved from `cfg!(target_os)` here and threaded into `jump-core`'s pure,
//! platform-parameterised functions. This mirrors how `std::sys` is organised, so it reads as
//! idiomatic Rust rather than porting scar tissue.

use std::path::PathBuf;
use std::process::{Command, Output};

use jump_core::editor::CommandSpec;
use jump_core::persist::{self, PersistError};
use jump_core::platform::Platform;
use tauri::{App, AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("the jump shell only supports windows and macos");

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

/// The platform this build runs on, resolved once. This `cfg!(target_os)` is the source of
/// truth for "which OS am I": the `get_platform` command and every core call read this
/// constant rather than re-deriving it.
pub const PLATFORM: Platform = if cfg!(target_os = "macos") {
    Platform::Macos
} else {
    Platform::Windows
};

/// Resolves the config dir for this platform. The impure env reads happen here (the shell's
/// job); the pure path logic lives in `jump-core`. An unresolvable dir is an `Err` the caller
/// must treat as fatal, never a silent temp-dir fallback.
pub fn config_dir() -> Result<PathBuf, PersistError> {
    let appdata = std::env::var("APPDATA").ok();
    let home = std::env::var("HOME").ok();
    persist::config_dir(PLATFORM, appdata.as_deref(), home.as_deref())
}

/// Opens a folder in the OS file manager, showing its contents (Finder on macOS, File
/// Explorer on Windows). The caller passes a native path; for a WSL project that is the
/// `\\wsl.localhost\<distro>\…` UNC path.
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    imp::reveal_in_file_manager(path)
}

/// Builds a child command with the host's background-process policy applied.
pub fn background_command(program: &str) -> Command {
    imp::background_command(program)
}

/// Spawns an editor while applying the host's child-reaping policy.
pub fn spawn_editor(spec: &CommandSpec) -> Result<(), String> {
    imp::spawn_editor(spec)
}

/// Whether a resolved file or application bundle can be launched on this host.
pub fn is_launchable_path(path: &std::path::Path) -> bool {
    imp::is_launchable_path(path)
}

/// Expands one of core's probe-path templates using this host's template syntax. `None` when
/// a referenced variable is unset, so an unformable template is skipped rather than probed
/// with a literal token in it.
pub fn expand_probe_template(template: &str) -> Option<String> {
    imp::expand_probe_template(template)
}

/// The `;`-separated executable extensions a bare-command PATH lookup should try. Empty on
/// hosts where an executable carries no extension.
pub fn path_ext() -> String {
    imp::path_ext()
}

/// Runs a WSL command on Windows and returns unsupported on other hosts.
pub fn wsl_output(args: &[&str]) -> std::io::Result<Output> {
    imp::wsl_output(args)
}

/// Attempts to read a configured folder so macOS can present its consent prompt.
pub fn request_folder_access(path: &str) -> Result<(), String> {
    imp::request_folder_access(path)
}

/// Opens the Files and Folders privacy pane on macOS.
pub fn open_files_and_folders_settings() -> Result<(), String> {
    imp::open_files_and_folders_settings()
}

/// Shows a blocking native error dialog for a fatal startup failure. Best-effort: the caller
/// writes the message to stderr first, so this is purely the extra signal a release build
/// (no console) needs. macOS uses `osascript` (its own process, so no `NSApplication` is
/// required this early); Windows uses a Win32 message box.
pub fn show_fatal_dialog(detail: &str) {
    imp::show_fatal_dialog(detail);
}

/// Installs the platform's application presentation before the app starts handling input.
pub fn configure_app(app: &mut App) -> tauri::Result<()> {
    imp::configure_app(app)
}

/// Applies the platform-specific launcher behavior after its configured window exists.
pub fn configure_launcher(win: &WebviewWindow) -> tauri::Result<()> {
    imp::configure_launcher(win)
}

/// Applies native or custom Settings chrome without leaking target checks into window code.
pub fn configure_settings_window<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    imp::configure_settings_window(builder)
}

/// Makes the application available before one of its windows is revealed.
pub fn show_application(app: &AppHandle) {
    imp::show_application(app);
}

/// Steps the whole application aside so focus returns to where the user came from. The caller
/// decides *when* Jump is idle enough to warrant it; this is only the OS-level half.
pub fn hide_application(app: &AppHandle) {
    imp::hide_application(app);
}

/// Whether a primary click should open the tray menu instead of the launcher directly.
pub const TRAY_MENU_ON_LEFT_CLICK: bool = matches!(PLATFORM, Platform::Macos);
