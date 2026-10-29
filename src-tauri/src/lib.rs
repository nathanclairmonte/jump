mod commands;
mod editor;
mod hotkey;
mod platform;
mod scan_engine;
mod state;
mod tray;
mod window;

use std::path::Path;

use tauri::Manager;
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use hotkey::ActiveHotkey;
use jump_core::persist::Store;
use state::AppState;

// file logging into the config dir's logs/, plus stderr for `tauri dev`. the worker is
// intentionally leaked so it lives for the whole process; a tray app exits via tray Quit
// and we accept losing the last unflushed lines rather than thread a guard everywhere.
fn init_logging(logs_dir: &Path) {
    let file_appender = tracing_appender::rolling::daily(logs_dir, "jump.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    std::mem::forget(guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(non_blocking),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();
}

// Reports a fatal startup failure and exits. This runs before the tauri app (and its dialog
// plugin) exists and before logging is up, and a release build has no console, so the native
// dialog is the user's only signal; the stderr line covers `tauri dev` and is the fallback if
// the dialog can't show.
fn fatal_start_error(detail: &str) -> ! {
    eprintln!("Jump cannot start: {detail}");
    platform::show_fatal_dialog(detail);
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // resolve the config dir and create it + logs/ before anything logs. creating the dir
    // does not write settings.json, so the "absent -> first-run" trigger stays intact (the
    // default settings file is written lazily on first change).
    //
    // failure is fatal, never a silent temp-dir fallback: a config dir Jump cannot name or
    // cannot write to would leave it writing the user's data somewhere the OS is free to
    // delete. a release build has no console (windows_subsystem on windows, menu-bar accessory
    // on macos) and this fires before logging, so the only way the user hears about it is a
    // native dialog.
    let store = match platform::config_dir() {
        Ok(dir) => Store::new(dir),
        // the error already reads "config dir could not be resolved: ...", so don't re-wrap it.
        Err(err) => fatal_start_error(&err.to_string()),
    };
    if let Err(err) = store.ensure_dirs() {
        fatal_start_error(&format!(
            "could not create the config directory at {}: {err}",
            store.dir().display()
        ));
    }
    init_logging(&store.logs_dir());

    let first_run = !store.settings_exist();
    let mut settings = store.load_settings();

    // resolve the bound hotkey from settings up front. a hand-edited or otherwise invalid
    // combo falls back to the built-in default rather than leaving the app with no hotkey.
    // `registered` starts false and is set when the actual registration succeeds in setup.
    let (shortcut, combo) = match hotkey::resolve(&settings.hotkey) {
        Ok(resolved) => resolved,
        Err(err) => {
            tracing::warn!(error = %err, hotkey = %settings.hotkey, "invalid hotkey in settings; using default");
            let resolved = hotkey::default_resolved();
            // rewrite the stored value to the canonical default so the parse failure doesn't
            // recur on every launch and the file reflects what's actually bound. only reached
            // when the file already exists (someone hand-edited it), so first-run stays lazy.
            settings.hotkey = resolved.1.clone();
            if let Err(err) = store.save_settings(&settings) {
                tracing::warn!(error = %err, "could not persist hotkey fallback");
            }
            resolved
        }
    };
    let app_state = AppState::new(
        store,
        settings,
        ActiveHotkey {
            shortcut,
            combo,
            registered: false,
        },
    );

    tauri::Builder::default()
        // single-instance must be registered first so a second launch is intercepted
        // before it spins up its own windows; we just surface the existing launcher.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::show_launcher(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // compare against the *currently bound* hotkey in state, not a captured
                    // constant, so a rebind takes effect without restarting the handler.
                    let st = app.state::<AppState>();
                    let matches = {
                        let active = st.hotkey.lock().unwrap_or_else(|e| e.into_inner());
                        shortcut == &active.shortcut
                    };
                    if matches {
                        window::toggle_launcher(app);
                    }
                })
                .build(),
        )
        // registered so the startup toggle can flip it later; not enabled here.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_index,
            commands::rescan,
            commands::set_pinned,
            commands::set_pin_order,
            commands::set_project_alias,
            commands::set_project_tags,
            commands::set_project_editor_override,
            commands::set_project_color,
            commands::set_project_excluded,
            commands::remove_from_recents,
            commands::add_explicit_project,
            commands::remove_explicit_project,
            commands::forget_project,
            commands::show_in_file_explorer,
            commands::open_github_url,
            commands::open_settings,
            commands::dismiss_launcher,
            commands::upsert_search_location,
            commands::remove_search_location,
            commands::list_wsl_distros,
            commands::classify_path_cmd,
            commands::get_config_dir,
            commands::open_config_dir,
            commands::get_platform,
            commands::get_search_locations,
            commands::request_location_access,
            commands::open_files_and_folders_settings,
            commands::rebuild_index,
            commands::get_hotkey_status,
            commands::rebind_hotkey,
            commands::set_launch_at_startup,
            commands::set_rescan_on_startup,
            editor::detect_editors,
            editor::set_default_editor,
            editor::set_editor_command,
            editor::test_launch,
            editor::launch_project,
        ])
        .setup(move |app| {
            platform::configure_app(app)?;
            tray::create_tray(app.handle())?;

            // hide the launcher on focus loss (click-outside), so it never sits open and
            // unfocused where Esc can't reach it.
            if let Some(launcher) = app.get_webview_window(window::LAUNCHER_LABEL) {
                platform::configure_launcher(&launcher)?;
                window::install_blur_hide(&launcher);
            }

            // register the hotkey resolved from settings. a conflict (combo already taken)
            // must not crash or silently rebind: keep running, record that it stayed
            // unregistered so the Shortcuts panel can say so honestly, and log. richer tray
            // surfacing comes in S9.
            {
                let st = app.state::<AppState>();
                let shortcut = st.hotkey.lock().unwrap_or_else(|e| e.into_inner()).shortcut;
                match app.global_shortcut().register(shortcut) {
                    Ok(()) => {
                        st.hotkey.lock().unwrap_or_else(|e| e.into_inner()).registered = true;
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "could not register global hotkey; it stays unbound");
                    }
                }
            }

            // reconcile the persisted launch-at-startup flag to the OS truth: the user can
            // toggle Jump's startup entry outside the app (Task Manager), and the OS is what
            // actually runs at boot, so settings follows the OS rather than re-asserting itself.
            {
                let st = app.state::<AppState>();
                match app.autolaunch().is_enabled() {
                    Ok(os_enabled) => {
                        let mut settings = st.settings.lock().unwrap_or_else(|e| e.into_inner());
                        if settings.launch_at_startup != os_enabled {
                            settings.launch_at_startup = os_enabled;
                            if let Err(err) = st.store.save_settings(&settings) {
                                tracing::warn!(error = %err, "could not persist autostart reconcile");
                            }
                        }
                    }
                    Err(err) => tracing::warn!(error = %err, "could not read autostart state"),
                }
            }

            // background-on-startup scan: non-blocking, only when enabled and there is
            // something to scan. the cached index is already usable; this refreshes it.
            let handle = app.handle().clone();
            let should_scan = {
                let st = handle.state::<AppState>();
                let s = st.settings.lock().unwrap_or_else(|e| e.into_inner());
                s.rescan_on_startup && !s.search_locations.is_empty()
            };
            if should_scan {
                scan_engine::trigger_scan(handle);
            }

            // a tray-only app otherwise gives a fresh install no visible next step. the absent
            // settings file is checked before defaults are loaded, preserving the lazy-write
            // contract while taking the user straight to the first required configuration.
            if first_run {
                window::open_settings(app.handle(), Some("searchLocations"));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // tray-resident: when the last window closes (code is None), prevent the
            // default exit so the app keeps living in the tray. an explicit tray Quit
            // calls app.exit(0), which carries a code and is allowed through.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
