// pure helpers for the Shortcuts panel: assembling a combo from a keyboard event while
// recording, and splitting a canonical combo into human-readable per-key pills. storage stays
// the canonical Code-token form ("Ctrl+Alt+Space"); prettifying is presentation-only and lives
// here so it's unit-testable without the dom.

import type { Platform } from "@/lib/api";

// the modifier-key Codes themselves, so a press of only modifiers can be previewed without
// being mistaken for a complete combo.
const MODIFIER_CODES = new Set([
	"ControlLeft",
	"ControlRight",
	"AltLeft",
	"AltRight",
	"ShiftLeft",
	"ShiftRight",
	"MetaLeft",
	"MetaRight",
]);

/** Whether a KeyboardEvent.code names a modifier key (not a bindable key on its own). */
export function isModifierCode(code: string): boolean {
	return MODIFIER_CODES.has(code);
}

// the subset of a keyboard event the assembler needs, so the helper stays dom-free and testable.
export interface ComboEventLike {
	code: string;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	metaKey: boolean;
}

export interface AssembledCombo {
	// the combo string in canonical Code-token form (modifiers + key), best-effort: rust core
	// is the authoritative validator. while only modifiers are held this is just the modifiers.
	combo: string;
	// true once a non-modifier key has landed (the combo can be committed/saved).
	complete: boolean;
	// true when a key landed but no modifier was held (a bare key can't be a global hotkey).
	needsModifier: boolean;
}

/**
 * Assembles a combo from a keyboard event during recording. Returns the held modifiers while
 * only modifiers are down (for a live preview), and a complete combo once a real key lands.
 */
export function comboFromEvent(e: ComboEventLike): AssembledCombo {
	const mods: string[] = [];
	if (e.ctrlKey) mods.push("Ctrl");
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");
	if (e.metaKey) mods.push("Meta");

	if (isModifierCode(e.code)) {
		return { combo: mods.join("+"), complete: false, needsModifier: false };
	}
	return {
		combo: [...mods, e.code].join("+"),
		complete: true,
		needsModifier: mods.length === 0,
	};
}

const MODIFIER_LABELS: Record<Platform, Record<string, string>> = {
	windows: { Meta: "Win" },
	macos: { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" },
};

const KEY_LABELS: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Space: "Space",
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Del",
	Insert: "Ins",
	Home: "Home",
	End: "End",
	PageUp: "PgUp",
	PageDown: "PgDn",
	Backquote: "`",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
};

/** Prettifies a single Code token for display (e.g. `KeyA` -> `A`, `Digit1` -> `1`). */
export function prettyKey(token: string): string {
	if (token.length > 3 && token.startsWith("Key")) return token.slice(3);
	if (token.length > 5 && token.startsWith("Digit")) return token.slice(5);
	if (token.length > 6 && token.startsWith("Numpad"))
		return `Num ${token.slice(6)}`;
	return KEY_LABELS[token] ?? token;
}

/** Prettifies one combo segment, mapping a modifier to its label or a key via `prettyKey`. */
function prettyToken(token: string, platform: Platform): string {
	return MODIFIER_LABELS[platform][token] ?? prettyKey(token);
}

/**
 * Splits a canonical combo string into display-ready per-key pills (e.g. `"Ctrl+Alt+Space"` ->
 * `["Ctrl", "Alt", "Space"]`). Empty input yields an empty list.
 */
export function splitCombo(combo: string, platform: Platform): string[] {
	if (!combo) return [];
	return combo.split("+").map((token) => prettyToken(token, platform));
}

// macOS separates shortcut glyphs with spaces while Windows spells the combo out with `+`,
// so the joining rule sits beside the splitting rule rather than at each render site.
const COMBO_JOINER: Record<Platform, string> = { windows: " + ", macos: " " };

/** Renders a canonical combo as one display string, joined the way the host platform reads. */
export function formatCombo(combo: string, platform: Platform): string {
	return splitCombo(combo, platform).join(COMBO_JOINER[platform]);
}
