//! Windows-specific shell operations.

use tauri::{App, AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

use jump_core::editor::CommandSpec;

/// Keeps the existing Windows application presentation unchanged.
pub fn configure_app(_app: &mut App) -> tauri::Result<()> {
    Ok(())
}

/// Keeps the existing Windows launcher workspace behavior unchanged.
pub fn configure_launcher(_win: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

/// Keeps the existing borderless Windows Settings window unchanged.
pub fn configure_settings_window<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    builder.decorations(false).transparent(true)
}

/// Windows windows can be shown without changing application visibility.
pub fn show_application(_app: &AppHandle) {}

/// Windows dismissal remains a window-only operation.
pub fn hide_application(_app: &AppHandle) {}

/// Opens a folder in File Explorer, showing its contents. Unchanged from the original
/// single-branch `open_in_explorer`: `explorer.exe <path>` opens the folder, and for a WSL
/// project the caller passes the `\\wsl.localhost\<distro>\…` UNC path.
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|e| format!("could not open File Explorer: {e}"))?;
    Ok(())
}

/// Builds a child command without flashing a console window.
pub fn background_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Keeps the existing detached Windows editor launch behavior.
pub fn spawn_editor(spec: &CommandSpec) -> Result<(), String> {
    background_command(&spec.program)
        .args(&spec.args)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("could not start {}: {err}", spec.program))
}

/// Windows launch targets are executable files.
pub fn is_launchable_path(path: &std::path::Path) -> bool {
    path.is_file()
}

/// Windows probe templates are `%VAR%`-based, resolved against the process environment.
pub fn expand_probe_template(template: &str) -> Option<String> {
    jump_core::editor::expand_vars(template, |var| std::env::var(var).ok())
}

/// Honors the user's `PATHEXT`, falling back to the stock list when it is unset.
pub fn path_ext() -> String {
    std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
}

/// Runs a WSL operation without flashing a console window.
pub fn wsl_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    background_command("wsl.exe").args(args).output()
}

/// Folder-consent prompts are a macOS-only recovery path.
pub fn request_folder_access(_path: &str) -> Result<(), String> {
    Err("folder access requests are only available on macOS".to_string())
}

/// Files and Folders privacy settings are a macOS-only recovery path.
pub fn open_files_and_folders_settings() -> Result<(), String> {
    Err("Files and Folders privacy settings are only available on macOS".to_string())
}

/// Shows a fatal-error dialog via a Win32 message box (rfd). A release build sets
/// `windows_subsystem = "windows"` and so has no console, making this the only user-visible
/// signal. rfd's Win32 backend needs no app object, so it works this early. Best-effort.
pub fn show_fatal_dialog(detail: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Jump cannot start")
        .set_description(detail)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
