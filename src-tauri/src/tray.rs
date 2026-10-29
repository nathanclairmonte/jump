use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::{platform, window};

// builds the persistent menu bar or system tray entry with platform-native click behaviour.
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open_launcher", "Open Launcher", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let rescan = MenuItem::with_id(app, "rescan", "Rescan Projects", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    // "launch at startup" (with a checkmark) lands with the general settings later;
    // rescan is wired now that the scanner exists.
    let menu = Menu::with_items(app, &[&open, &settings, &rescan, &separator, &quit])?;

    // the coloured squircle keeps Jump recognizable as an app among other status items.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    // windows keeps its direct left-click launcher shortcut; macOS sends both mouse buttons
    // through the native menu, so the click handler below must stand down there.
    let menu_on_left_click = platform::TRAY_MENU_ON_LEFT_CLICK;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("Jump")
        .menu(&menu)
        .show_menu_on_left_click(menu_on_left_click)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_launcher" => window::show_launcher(app),
            "settings" => window::open_settings(app, None),
            "rescan" => crate::scan_engine::trigger_scan(app.clone()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if menu_on_left_click {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::show_launcher(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
