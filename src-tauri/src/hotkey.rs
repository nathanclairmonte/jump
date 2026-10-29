//! Binary-side glue between jump-core's neutral `ParsedHotkey` and the global-shortcut
//! plugin's `Shortcut`/`Code`/`Modifiers`. All testable parsing and validation stays in
//! `jump_core::hotkey`; this module only performs the native type mapping.

use std::str::FromStr;

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use jump_core::hotkey::{parse_hotkey, HotkeyModifier, ParsedHotkey};
use jump_core::model::DEFAULT_HOTKEY;

/// The currently-bound hotkey plus whether the OS actually accepted its registration. Held
/// in `AppState` so the shortcut handler compares presses against the *live* combo (not a
/// captured constant) and the Shortcuts panel can report honest status.
pub struct ActiveHotkey {
    pub shortcut: Shortcut,
    /// The canonical combo string, mirrored into `settings.hotkey`.
    pub combo: String,
    /// False when registration was rejected (combo already taken by another app), so we keep
    /// running without the hotkey rather than silently rebinding to something else.
    pub registered: bool,
}

/// Maps a validated core hotkey onto the plugin's `Shortcut`. The `Code` lookup reuses the
/// plugin's own `FromStr` (keyboard-types), whose names are identical to our `Code`-name key
/// tokens, so there's no second key grammar to keep in sync.
fn to_shortcut(parsed: &ParsedHotkey) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    for m in &parsed.mods {
        mods |= match m {
            HotkeyModifier::Ctrl => Modifiers::CONTROL,
            HotkeyModifier::Alt => Modifiers::ALT,
            HotkeyModifier::Shift => Modifiers::SHIFT,
            HotkeyModifier::Meta => Modifiers::META,
        };
    }
    let code = Code::from_str(&parsed.key).map_err(|_| format!("unsupported key: {}", parsed.key))?;
    Ok(Shortcut::new(Some(mods), code))
}

/// Parses + validates a combo string and maps it to a `Shortcut`, returning the canonical
/// string alongside so the caller can persist/display one normalized spelling.
pub fn resolve(combo: &str) -> Result<(Shortcut, String), String> {
    let parsed = parse_hotkey(combo).map_err(|e| e.to_string())?;
    let shortcut = to_shortcut(&parsed)?;
    Ok((shortcut, parsed.canonical()))
}

/// The built-in default hotkey, for when `settings.hotkey` is absent or hand-edited into
/// something invalid. `DEFAULT_HOTKEY` is a known-good constant, so a failure here is a real
/// programming invariant, not a user-input case.
pub fn default_resolved() -> (Shortcut, String) {
    resolve(DEFAULT_HOTKEY).expect("the built-in default hotkey must always be valid")
}
