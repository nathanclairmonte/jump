use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::platform;

// vertical anchor: the launcher's top sits 14% down the active monitor, above
// center (raycast/spotlight convention) so results grow downward from there. tuned
// so a typical recents list lands roughly centered rather than drifting bottom-heavy
// (a longer list caps its height and scrolls internally instead of growing past this).
const LAUNCHER_TOP_ANCHOR_RATIO: f64 = 0.14;

/// The two window labels, declared once here so the platform layer can route menu commands
/// (and anything else) through this module without re-typing a string that only matches by
/// luck.
pub(crate) const LAUNCHER_LABEL: &str = "launcher";
pub(crate) const SETTINGS_LABEL: &str = "settings";

/// Fired each time the launcher is revealed, so its store can reset query/selection and
/// refresh the index. Distinct from window focus, which fires for unrelated reasons.
pub const EVENT_LAUNCHER_SHOWN: &str = "launcher-shown";
/// Fired at an already-open settings window to navigate it to a section. A freshly
/// created window instead reads its section from the URL hash, so there is no race.
pub const EVENT_SETTINGS_NAVIGATE: &str = "settings-navigate";

/// The settings sections a deep-link may target. Kept in sync with the frontend's
/// `SettingsSection` union; an unknown value falls back to the default panel.
const SETTINGS_SECTIONS: [&str; 5] = [
    "general",
    "searchLocations",
    "projects",
    "editors",
    "shortcuts",
];
const SETTINGS_ACTION_TARGETS: [&str; 1] = ["searchLocations:addLocation"];

fn is_settings_target(value: &str) -> bool {
    SETTINGS_SECTIONS.contains(&value) || SETTINGS_ACTION_TARGETS.contains(&value)
}

// Shows the launcher: place it, reveal it, focus it.
pub fn show_launcher(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LAUNCHER_LABEL) else {
        return;
    };
    reveal_launcher(&win);
}

// the place+show+focus contract for surfacing the launcher, pinned in one spot so
// show and the toggle's reveal path can never drift apart.
fn reveal_launcher(win: &WebviewWindow) {
    position_on_active_monitor(win);
    let _ = win.show();
    platform::show_application(win.app_handle());
    let _ = win.set_focus();
    // tell the launcher it was just opened so it can reset its query/selection and
    // refresh against the latest index. emitted after show so a listener that re-renders
    // on it paints into a visible window.
    let _ = win.emit(EVENT_LAUNCHER_SHOWN, ());
}

// Hides the launcher when it loses focus (a click outside, spotlight/raycast style) so it
// never lingers unfocused where Esc can't reach it. The launcher hugs its content, so most
// "outside" clicks land on another app rather than the in-window backdrop the component
// handles; this closes that gap. In debug builds the `JUMP_DEBUG_KEEP_OPEN` env var
// suppresses the hide so devtools can steal focus for inspection without the panel vanishing.
pub fn install_blur_hide(win: &WebviewWindow) {
    let handle = win.app_handle().clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            if *focused {
                return;
            }
            // in debug builds, an env escape hatch keeps the launcher open on blur so devtools
            // can take focus for inspection.
            #[cfg(debug_assertions)]
            if std::env::var_os("JUMP_DEBUG_KEEP_OPEN").is_some() {
                return;
            }
            dismiss_launcher(&handle);
        }
    });
}

// Toggles the launcher: hidden -> show+focus; visible+focused -> hide. blur-hide normally
// collapses the visible+unfocused case (the launcher hides the instant it loses focus), so the
// else-branch's refocus is really a fallback for the brief race where the hotkey fires after
// blur but before hide() lands.
pub fn toggle_launcher(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LAUNCHER_LABEL) else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);
    if visible && focused {
        dismiss_launcher(app);
    } else {
        reveal_launcher(&win);
    }
}

/// Dismisses the launcher and restores the previously active app when appropriate.
pub fn dismiss_launcher(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LAUNCHER_LABEL) else {
        return;
    };
    // hiding drops focus, which re-enters here through the blur handler. the already-hidden
    // check makes that second pass a no-op rather than a second app-level hide.
    if matches!(win.is_visible(), Ok(false)) {
        return;
    }
    let _ = win.hide();
    hide_application_if_idle(app);
}

// the three below serve native menu key equivalents, which only macOS installs today; Windows
// drives the same actions from its HTML titlebar controls. the rules themselves are app policy
// rather than an OS detail, so they live here rather than behind the platform seam, and the
// attribute (not a `cfg`) keeps that single definition compiled on every target.

/// Closes whichever Jump window has focus, honoring each one's own dismissal rule: settings
/// really closes, the launcher hides and hands focus back.
#[allow(dead_code)]
pub(crate) fn close_focused(app: &AppHandle) {
    if let Some(win) = focused_window(app, SETTINGS_LABEL) {
        let _ = win.close();
    } else if focused_window(app, LAUNCHER_LABEL).is_some() {
        dismiss_launcher(app);
    }
}

/// Minimizes the focused window. The launcher is a transient panel with no minimized state,
/// so only settings responds.
#[allow(dead_code)]
pub(crate) fn minimize_focused(app: &AppHandle) {
    if let Some(win) = focused_window(app, SETTINGS_LABEL) {
        let _ = win.minimize();
    }
}

#[allow(dead_code)]
fn focused_window(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
        .filter(|win| win.is_focused().unwrap_or(false))
}

// defer the idle decision until native menu tracking finishes. this also gives destroyed
// windows time to leave Tauri's map before their close handler checks application state.
fn hide_application_if_idle(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if application_is_idle(&app) {
            platform::hide_application(&app);
        }
    });
}

// minimized settings is still a user-owned window even though AppKit reports it as hidden.
fn application_is_idle(app: &AppHandle) -> bool {
    !app
        .webview_windows()
        .values()
        .any(|win| {
            win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false)
        })
}

// Opens (or resurfaces) the settings window, optionally deep-linking to a section.
// created on demand so the idle tray app never holds the settings webview in memory.
// an already-open window is navigated via an event (it is already listening); a fresh
// window carries the section in its URL hash, read before React mounts, so there is no
// listen-before-emit race.
pub fn open_settings(app: &AppHandle, section: Option<&str>) {
    let section = section.and_then(|target| {
        if is_settings_target(target) {
            Some(target)
        } else {
            tracing::warn!(target, "ignored unknown settings target");
            None
        }
    });

    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        reveal_settings(&win);
        if let Some(s) = section {
            let _ = win.emit(EVENT_SETTINGS_NAVIGATE, s);
        }
        return;
    }

    let base_url = format!("settings.html?platform={}", platform::PLATFORM.as_str());
    let url = match section {
        Some(s) => format!("{base_url}#{s}"),
        None => base_url,
    };
    let builder = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App(url.into()))
        .title("Jump Settings")
        .inner_size(900.0, 640.0)
        .min_inner_size(760.0, 520.0)
        .resizable(true)
        .center();
    match platform::configure_settings_window(builder).build() {
        Ok(win) => {
            install_settings_close_hide(&win);
            reveal_settings(&win);
        }
        Err(err) => tracing::error!(error = %err, "could not open settings window"),
    }
}

// the surface contract for settings, pinned in one spot for the same reason `reveal_launcher`
// is: a resurfaced window and a freshly built one must not drift apart.
fn reveal_settings(win: &WebviewWindow) {
    let _ = win.unminimize();
    let _ = win.show();
    platform::show_application(win.app_handle());
    let _ = win.set_focus();
}

// closing the last Jump window should return focus to the app the user came from.
fn install_settings_close_hide(win: &WebviewWindow) {
    let app = win.app_handle().clone();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            hide_application_if_idle(&app);
        }
    });
}

// Centers the launcher horizontally on the monitor under the cursor and anchors its
// top at LAUNCHER_TOP_ANCHOR_RATIO. done before show so it appears already placed.
// reads the window's current outer size, so a future content-driven height change
// keeps centering correct with no rework here.
fn position_on_active_monitor(win: &WebviewWindow) {
    let Some(monitor) = active_monitor(win) else {
        return;
    };
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let Ok(win_size) = win.outer_size() else {
        return;
    };

    let x = m_pos.x + ((m_size.width as i32 - win_size.width as i32) / 2);
    let y = m_pos.y + (m_size.height as f64 * LAUNCHER_TOP_ANCHOR_RATIO) as i32;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

// "active" monitor = the one under the cursor (where the user is looking), falling
// back to the window's current monitor, then the primary.
fn active_monitor(win: &WebviewWindow) -> Option<Monitor> {
    if let Ok(cursor) = win.cursor_position() {
        if let Ok(Some(monitor)) = win.monitor_from_point(cursor.x, cursor.y) {
            return Some(monitor);
        }
    }
    win.current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
}

#[cfg(test)]
mod tests {
    use super::{is_settings_target, SETTINGS_ACTION_TARGETS, SETTINGS_SECTIONS};

    fn frontend_array<'a>(source: &'a str, declaration: &str) -> Vec<&'a str> {
        let start = source
            .find(declaration)
            .unwrap_or_else(|| panic!("`{declaration}` not found in store.ts"));
        let end = source[start..]
            .find(']')
            .unwrap_or_else(|| panic!("unterminated array for `{declaration}`"))
            + start;
        source[start..end].split('"').skip(1).step_by(2).collect()
    }

    #[test]
    fn settings_targets_allow_only_known_sections_and_actions() {
        assert!(is_settings_target("projects"));
        assert!(is_settings_target("searchLocations:addLocation"));
        assert!(!is_settings_target("general:addLocation"));
        assert!(!is_settings_target("projects:unknownAction"));
        assert!(!is_settings_target("unknown"));
    }

    // the section list lives in two places by necessity: this rust allow-list (a runtime
    // filter) and the frontend's `SECTIONS` array + derived union type. they can't share a
    // declaration cheaply, so this test is the drift guard: it parses the frontend array
    // and asserts the two sets match exactly, in either direction.
    #[test]
    fn settings_sections_match_frontend() {
        // cargo runs tests from the crate root (src-tauri), so the frontend sits one up.
        let store = std::fs::read_to_string("../src/entries/settings/store.ts")
            .expect("could not read frontend settings store");

        let mut frontend = frontend_array(&store, "const SECTIONS = [");
        frontend.sort_unstable();

        let mut backend = SETTINGS_SECTIONS.to_vec();
        backend.sort_unstable();

        assert_eq!(
            backend, frontend,
            "settings sections drifted between window.rs and store.ts"
        );
    }

    #[test]
    fn settings_actions_match_frontend() {
        let store = std::fs::read_to_string("../src/entries/settings/store.ts")
            .expect("could not read frontend settings store");
        let mut frontend = frontend_array(&store, "const ACTION_TARGETS = [");
        frontend.sort_unstable();

        let mut backend = SETTINGS_ACTION_TARGETS.to_vec();
        backend.sort_unstable();

        assert_eq!(
            backend, frontend,
            "settings actions drifted between window.rs and store.ts"
        );
    }
}
