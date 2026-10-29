//! macOS-specific shell operations.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindow, NSWindowCollectionBehavior};
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{App, AppHandle, Manager, Runtime, TitleBarStyle, WebviewWindow, WebviewWindowBuilder};

use jump_core::editor::{ChildHandling, CommandSpec};

use crate::window;

/// Configures Jump as an accessory app and installs native key equivalents.
pub fn configure_app(app: &mut App) -> tauri::Result<()> {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    let settings = MenuItem::with_id(app, "app_settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, "Jump")
        .item(&settings)
        .separator()
        .about(None)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let close = MenuItem::with_id(app, "window_close", "Close", true, Some("CmdOrCtrl+W"))?;
    let minimize = MenuItem::with_id(
        app,
        "window_minimize",
        "Minimize",
        true,
        Some("CmdOrCtrl+M"),
    )?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .items(&[&close, &minimize])
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    // the key equivalents are the macOS-specific part; what closing or minimizing *means* per
    // window is app policy, so it stays in `window`.
    // tauri dispatches every menu event to both this handler and the tray's, so the id has to
    // differ from the tray's "settings" or one click opens settings twice.
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "app_settings" => window::open_settings(app, None),
        "window_close" => window::close_focused(app),
        "window_minimize" => window::minimize_focused(app),
        _ => {}
    });
    Ok(())
}

/// Joins desktop and native fullscreen Spaces while preserving existing window flags.
pub fn configure_launcher(win: &WebviewWindow) -> tauri::Result<()> {
    win.set_visible_on_all_workspaces(true)?;
    let native = unsafe { &*win.ns_window()?.cast::<NSWindow>() };
    let mutually_exclusive = NSWindowCollectionBehavior::FullScreenPrimary
        | NSWindowCollectionBehavior::FullScreenNone
        | NSWindowCollectionBehavior::Primary
        | NSWindowCollectionBehavior::Auxiliary;
    let behavior = (native.collectionBehavior() & !mutually_exclusive)
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::CanJoinAllApplications;
    native.setCollectionBehavior(behavior);
    Ok(())
}

/// Uses native macOS decorations under Jump's HTML titlebar content.
pub fn configure_settings_window<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    builder
        .decorations(true)
        .transparent(false)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .shadow(true)
}

/// Reveals the accessory application before showing one of its windows.
pub fn show_application(app: &AppHandle) {
    let _ = app.show();
    let _ = app.run_on_main_thread(|| {
        let marker = MainThreadMarker::new().expect("activation runs on the main thread");
        #[allow(deprecated)]
        NSApplication::sharedApplication(marker).activateIgnoringOtherApps(true);
    });
}

/// Hides the accessory application, which is what returns focus to the app behind Jump.
pub fn hide_application(app: &AppHandle) {
    let _ = app.hide();
}

/// Opens a folder in Finder, showing its contents. `open <path>` opens a Finder window *at*
/// the folder, matching Windows' `explorer.exe <folder>`, rather than `open -R` which would
/// reveal-and-select the folder inside its parent (the owner wants the contents, not a
/// highlighted icon).
///
/// Waits on `open` rather than fire-and-forget: `open` exits immediately, so the wait is
/// cheap, it reaps the child (this is a long-lived tray process, so a leaked child per reveal
/// would accumulate a zombie), and a non-zero exit surfaces a real failure.
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("could not open Finder: {e}"))?;
    if !status.success() {
        return Err(format!("Finder could not open {path}"));
    }
    Ok(())
}

/// Builds an ordinary macOS child command.
pub fn background_command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

/// Launches an editor and reaps every child process Jump creates.
pub fn spawn_editor(spec: &CommandSpec) -> Result<(), String> {
    let mut command = background_command(&spec.program);
    command.args(&spec.args);
    match spec.child_handling {
        ChildHandling::WaitForExit => {
            let output = command
                .output()
                .map_err(|err| format!("could not start {}: {err}", spec.program))?;
            if output.status.success() {
                return Ok(());
            }
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if detail.is_empty() {
                format!("{} exited with {}", spec.program, output.status)
            } else {
                detail
            })
        }
        ChildHandling::ReapInBackground => {
            let child = command
                .spawn()
                .map_err(|err| format!("could not start {}: {err}", spec.program))?;
            send_to_reaper(child);
            Ok(())
        }
    }
}

/// Sends long-lived children to one reaper so launches do not consume one thread each.
fn send_to_reaper(child: std::process::Child) {
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;

    static REAPER: OnceLock<mpsc::Sender<std::process::Child>> = OnceLock::new();
    let sender = REAPER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<std::process::Child>();
        std::thread::spawn(move || {
            let mut children = Vec::new();
            loop {
                if children.is_empty() {
                    match receiver.recv() {
                        Ok(child) => children.push(child),
                        Err(_) => break,
                    }
                } else {
                    match receiver.recv_timeout(Duration::from_millis(250)) {
                        Ok(child) => children.push(child),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                while let Ok(child) = receiver.try_recv() {
                    children.push(child);
                }
                children.retain_mut(|child| match child.try_wait() {
                    Ok(Some(_)) => false,
                    Ok(None) => true,
                    Err(err) => {
                        tracing::warn!(error = %err, "could not reap editor child");
                        false
                    }
                });
            }
        });
        sender
    });

    if let Err(mpsc::SendError(mut child)) = sender.send(child) {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// Accepts application bundles and executable files as editor targets. One `stat` serves
/// both questions, since this runs once per PATH entry on every bare-command resolution.
pub fn is_launchable_path(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if metadata.is_dir() {
        return path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    }
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

/// macOS probe templates are home-relative. `HOME` cannot change for the process, so it is
/// read once rather than per candidate template.
pub fn expand_probe_template(template: &str) -> Option<String> {
    static HOME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

    let home = HOME.get_or_init(|| std::env::var("HOME").ok());
    jump_core::editor::expand_home(template, home.as_deref())
}

/// macOS executables carry no extension, so a bare-command lookup tries the name alone.
pub fn path_ext() -> String {
    String::new()
}

/// WSL is unavailable on macOS without attempting to spawn anything.
pub fn wsl_output(_args: &[&str]) -> std::io::Result<std::process::Output> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "WSL is only available on Windows",
    ))
}

/// Reads one directory entry, which is enough to trigger a pending macOS folder prompt.
pub fn request_folder_access(path: &str) -> Result<(), String> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|err| format!("could not read {path}: {err}"))?;
    if let Some(entry) = entries.next() {
        entry.map_err(|err| format!("could not read {path}: {err}"))?;
    }
    Ok(())
}

/// Opens System Settings directly at Privacy and Security, Files and Folders.
pub fn open_files_and_folders_settings() -> Result<(), String> {
    const URL: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
    let status = background_command("open")
        .arg(URL)
        .status()
        .map_err(|err| format!("could not open Privacy Settings: {err}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "System Settings could not open Files and Folders privacy".to_string())
}

/// Shows a fatal-error dialog via `osascript`. Spawning it as a separate process sidesteps the
/// need for an `NSApplication`, which does not yet exist when this fires (before the Tauri app
/// is built). Best-effort: a failure to show is swallowed, since the caller already logged.
///
/// The leading `activate` asks the script's host forward so the dialog is the key window and
/// immediately clickable; without it, a dialog put up by this un-bundled binary can sit
/// unfocused for a few seconds. Once macOS runs Jump as a real `.app` with its accessory
/// activation policy, the app itself is frontmost and this fully settles.
pub fn show_fatal_dialog(detail: &str) {
    // escape for an applescript string literal (paths can in principle contain either char).
    let escaped = detail.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog \"{escaped}\" with title \"Jump cannot start\" with icon stop buttons {{\"OK\"}} default button \"OK\""
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg("activate")
        .arg("-e")
        .arg(script)
        .status();
}
