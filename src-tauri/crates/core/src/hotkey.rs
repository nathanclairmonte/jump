//! Pure parsing, validation, and canonicalization of a global-hotkey combo.
//!
//! This module deliberately avoids Tauri's shortcut types. It works in neutral terms
//! (`HotkeyModifier` plus a key token string), which keeps parsing independent from the
//! native registration adapter in the shell.
//!
//! The key token uses keyboard-types `Code` names (`Space`, `KeyA`, `Digit1`, `F5`, ...),
//! which are exactly what the browser's `KeyboardEvent.code` emits, so capture in the UI ->
//! this parser -> the plugin's `Code` is a 1:1 passthrough with no second grammar.

use std::fmt;

/// A keyboard modifier in a hotkey combo. The neutral counterpart to the plugin's
/// `Modifiers` bitflags; the shell maps one to the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyModifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

impl HotkeyModifier {
    /// The canonical sort rank, so a combo always renders modifiers in one fixed order
    /// (`Ctrl` < `Alt` < `Shift` < `Meta`) regardless of the order they were pressed in.
    fn order(self) -> u8 {
        match self {
            HotkeyModifier::Ctrl => 0,
            HotkeyModifier::Alt => 1,
            HotkeyModifier::Shift => 2,
            HotkeyModifier::Meta => 3,
        }
    }

    /// The canonical label used in the stored/displayed combo string.
    pub fn label(self) -> &'static str {
        match self {
            HotkeyModifier::Ctrl => "Ctrl",
            HotkeyModifier::Alt => "Alt",
            HotkeyModifier::Shift => "Shift",
            HotkeyModifier::Meta => "Meta",
        }
    }
}

/// A parsed, validated hotkey: at least one modifier plus exactly one non-modifier key.
/// `mods` is in canonical order; `key` is a keyboard-types `Code` name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHotkey {
    pub mods: Vec<HotkeyModifier>,
    pub key: String,
}

impl ParsedHotkey {
    /// The canonical combo string (e.g. `"Ctrl+Alt+Space"`), used for storage and display.
    /// Idempotent: re-parsing the output yields the same value.
    pub fn canonical(&self) -> String {
        let mut parts: Vec<&str> = self.mods.iter().map(|m| m.label()).collect();
        parts.push(&self.key);
        parts.join("+")
    }
}

/// Why a combo string could not be turned into a valid hotkey. A global hotkey must combine
/// at least one modifier with a single ordinary key, so chords that can't actually be bound
/// are rejected rather than persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyError {
    /// The string was empty or all whitespace.
    Empty,
    /// An empty segment between separators (e.g. `"Ctrl++Space"` or a trailing `+`).
    MalformedToken,
    /// A token matched neither a known modifier nor a supported key.
    UnknownToken(String),
    /// No modifier was present; a bare key can't be a global hotkey.
    NoModifier,
    /// No ordinary key was present; modifiers alone can't be bound.
    NoKey,
    /// More than one ordinary key was present.
    MultipleKeys,
}

impl fmt::Display for HotkeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HotkeyError::Empty => write!(f, "no shortcut was provided"),
            HotkeyError::MalformedToken => write!(f, "the shortcut has an empty key segment"),
            HotkeyError::UnknownToken(t) => write!(f, "unrecognized key: {t}"),
            HotkeyError::NoModifier => {
                write!(f, "add a modifier (Ctrl, Alt, Shift, or Meta)")
            }
            HotkeyError::NoKey => write!(f, "add a key besides the modifiers"),
            HotkeyError::MultipleKeys => write!(f, "use only one key besides the modifiers"),
        }
    }
}

impl std::error::Error for HotkeyError {}

/// Parses and validates a combo string into a canonical `ParsedHotkey`.
///
/// Accepts the canonical `Code`-name spelling the UI sends, and is also tolerant of
/// hand-edited `settings.json`: modifier and key tokens are matched case-insensitively, and a
/// lone letter/digit (e.g. `A`, `7`) resolves to its `Code` name (`KeyA`, `Digit7`). The
/// returned `key` is always the exact `Code` spelling.
pub fn parse_hotkey(input: &str) -> Result<ParsedHotkey, HotkeyError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(HotkeyError::Empty);
    }

    let mut mods: Vec<HotkeyModifier> = Vec::new();
    let mut key: Option<String> = None;

    for raw in trimmed.split('+') {
        let tok = raw.trim();
        if tok.is_empty() {
            return Err(HotkeyError::MalformedToken);
        }
        if let Some(m) = parse_modifier(tok) {
            // dedupe so "Ctrl+Ctrl+Space" still has one Ctrl rather than two.
            if !mods.contains(&m) {
                mods.push(m);
            }
            continue;
        }
        if let Some(canon) = canonical_key(tok) {
            if key.is_some() {
                return Err(HotkeyError::MultipleKeys);
            }
            key = Some(canon);
            continue;
        }
        return Err(HotkeyError::UnknownToken(tok.to_string()));
    }

    let key = key.ok_or(HotkeyError::NoKey)?;
    if mods.is_empty() {
        return Err(HotkeyError::NoModifier);
    }
    // canonical, press-order-independent modifier ordering.
    mods.sort_by_key(|m| m.order());
    Ok(ParsedHotkey { mods, key })
}

/// Resolves a token to a modifier, accepting the common spellings a user might hand-type.
fn parse_modifier(token: &str) -> Option<HotkeyModifier> {
    match token.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some(HotkeyModifier::Ctrl),
        "alt" | "option" | "opt" => Some(HotkeyModifier::Alt),
        "shift" => Some(HotkeyModifier::Shift),
        "meta" | "super" | "cmd" | "command" | "win" | "windows" => Some(HotkeyModifier::Meta),
        _ => None,
    }
}

/// Resolves a token to the exact keyboard-types `Code` name, or `None` if it isn't a
/// supported bindable key. A single letter/digit is an ergonomic alias for its `Code` family.
fn canonical_key(token: &str) -> Option<String> {
    // ergonomic single-char aliases for hand-edited combos (the UI always sends Code names).
    if token.chars().count() == 1 {
        let c = token.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{}", c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
    }
    // otherwise it must be one of the curated Code names, compared case-insensitively but
    // returned in its exact spelling.
    SUPPORTED_KEYS
        .iter()
        .find(|c| c.eq_ignore_ascii_case(token))
        .map(|c| c.to_string())
}

/// The curated set of bindable keys, as keyboard-types `Code` names. Covers the realistically
/// bindable keys; an exotic key outside this set is rejected rather than silently mapped.
static SUPPORTED_KEYS: &[&str] = &[
    // letters and digits.
    "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL",
    "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX",
    "KeyY", "KeyZ", //
    "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
    "Digit9", //
    // function keys.
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15",
    "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24", //
    // whitespace / editing.
    "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", //
    // navigation.
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", //
    // punctuation.
    "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon",
    "Quote", "Comma", "Period", "Slash", //
    // numpad.
    "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7",
    "Numpad8", "Numpad9", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
    "NumpadDecimal", "NumpadEnter",
];

#[cfg(test)]
mod tests {
    use super::*;
    use HotkeyModifier::*;

    #[test]
    fn parses_the_default_combo() {
        let h = parse_hotkey("Ctrl+Alt+Space").unwrap();
        assert_eq!(h.mods, vec![Ctrl, Alt]);
        assert_eq!(h.key, "Space");
        assert_eq!(h.canonical(), "Ctrl+Alt+Space");
    }

    #[test]
    fn rejects_a_bare_key_with_no_modifier() {
        assert_eq!(parse_hotkey("Space"), Err(HotkeyError::NoModifier));
        assert_eq!(parse_hotkey("F5"), Err(HotkeyError::NoModifier));
    }

    #[test]
    fn rejects_modifier_only_combos() {
        assert_eq!(parse_hotkey("Ctrl+Alt"), Err(HotkeyError::NoKey));
        assert_eq!(parse_hotkey("Shift"), Err(HotkeyError::NoKey));
    }

    #[test]
    fn rejects_multiple_keys() {
        assert_eq!(parse_hotkey("Ctrl+Space+Enter"), Err(HotkeyError::MultipleKeys));
    }

    #[test]
    fn rejects_empty_and_malformed() {
        assert_eq!(parse_hotkey(""), Err(HotkeyError::Empty));
        assert_eq!(parse_hotkey("   "), Err(HotkeyError::Empty));
        assert_eq!(parse_hotkey("Ctrl++Space"), Err(HotkeyError::MalformedToken));
        assert_eq!(parse_hotkey("Ctrl+Space+"), Err(HotkeyError::MalformedToken));
    }

    #[test]
    fn rejects_unknown_token() {
        assert!(matches!(
            parse_hotkey("Ctrl+Banana"),
            Err(HotkeyError::UnknownToken(_))
        ));
    }

    #[test]
    fn canonicalizes_modifier_order_independent_of_input() {
        // pressed in a different order, the same chord canonicalizes identically.
        let a = parse_hotkey("Alt+Ctrl+Space").unwrap().canonical();
        let b = parse_hotkey("Ctrl+Alt+Space").unwrap().canonical();
        assert_eq!(a, b);
        assert_eq!(a, "Ctrl+Alt+Space");

        let all = parse_hotkey("Meta+Shift+Alt+Ctrl+KeyJ").unwrap();
        assert_eq!(all.canonical(), "Ctrl+Alt+Shift+Meta+KeyJ");
    }

    #[test]
    fn canonical_is_idempotent() {
        let once = parse_hotkey("alt+ctrl+a").unwrap().canonical();
        let twice = parse_hotkey(&once).unwrap().canonical();
        assert_eq!(once, twice);
        assert_eq!(once, "Ctrl+Alt+KeyA");
    }

    #[test]
    fn dedupes_repeated_modifiers() {
        let h = parse_hotkey("Ctrl+Ctrl+Shift+KeyK").unwrap();
        assert_eq!(h.mods, vec![Ctrl, Shift]);
        assert_eq!(h.key, "KeyK");
    }

    #[test]
    fn tolerates_aliases_and_case_in_hand_edits() {
        // single-char letter/digit aliases resolve to their Code family.
        assert_eq!(parse_hotkey("Ctrl+j").unwrap().key, "KeyJ");
        assert_eq!(parse_hotkey("Ctrl+7").unwrap().key, "Digit7");
        // modifier spellings and key case are forgiving; the key returns its exact spelling.
        assert_eq!(parse_hotkey("control+alt+space").unwrap().key, "Space");
        assert_eq!(parse_hotkey("Win+Shift+arrowup").unwrap().canonical(), "Shift+Meta+ArrowUp");
    }

    #[test]
    fn supported_key_families_resolve_to_exact_code_names() {
        for (input, expected) in [
            ("Ctrl+f5", "Ctrl+F5"),
            ("Ctrl+numpad0", "Ctrl+Numpad0"),
            ("Ctrl+pageup", "Ctrl+PageUp"),
            ("Ctrl+Backquote", "Ctrl+Backquote"),
        ] {
            assert_eq!(parse_hotkey(input).unwrap().canonical(), expected);
        }
    }
}
