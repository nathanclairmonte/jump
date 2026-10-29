import { describe, expect, it } from "vitest";
import {
	type ComboEventLike,
	comboFromEvent,
	formatCombo,
	isModifierCode,
	prettyKey,
	splitCombo,
} from "./hotkey-display";

function ev(
	partial: Partial<ComboEventLike> & { code: string },
): ComboEventLike {
	return {
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		...partial,
	};
}

describe("splitCombo", () => {
	it("splits the default combo into per-key pills", () => {
		expect(splitCombo("Ctrl+Alt+Space", "windows")).toEqual([
			"Ctrl",
			"Alt",
			"Space",
		]);
		expect(splitCombo("Ctrl+Alt+Space", "macos")).toEqual(["⌃", "⌥", "Space"]);
	});

	it("prettifies letter and digit Code tokens", () => {
		expect(splitCombo("Ctrl+KeyJ", "windows")).toEqual(["Ctrl", "J"]);
		expect(splitCombo("Ctrl+Shift+Digit5", "windows")).toEqual([
			"Ctrl",
			"Shift",
			"5",
		]);
	});

	it("maps Meta to the Windows key and arrows to glyphs", () => {
		expect(splitCombo("Meta+Shift+ArrowUp", "windows")).toEqual([
			"Win",
			"Shift",
			"↑",
		]);
		expect(splitCombo("Meta+Shift+ArrowUp", "macos")).toEqual(["⌘", "⇧", "↑"]);
	});

	it("returns an empty list for an empty combo", () => {
		expect(splitCombo("", "macos")).toEqual([]);
	});
});

describe("formatCombo", () => {
	it("uses the host platform's shortcut separator", () => {
		expect(formatCombo("Ctrl+Alt+Space", "windows")).toBe("Ctrl + Alt + Space");
		expect(formatCombo("Ctrl+Alt+Space", "macos")).toBe("⌃ ⌥ Space");
	});
});

describe("prettyKey", () => {
	it("maps Code families and named keys", () => {
		expect(prettyKey("KeyA")).toBe("A");
		expect(prettyKey("Digit0")).toBe("0");
		expect(prettyKey("Numpad7")).toBe("Num 7");
		expect(prettyKey("PageDown")).toBe("PgDn");
		expect(prettyKey("Backquote")).toBe("`");
	});

	it("passes through an unknown token unchanged", () => {
		expect(prettyKey("F13")).toBe("F13");
	});
});

describe("comboFromEvent", () => {
	it("previews modifiers while only modifiers are held", () => {
		const r = comboFromEvent(ev({ code: "ControlLeft", ctrlKey: true }));
		expect(r).toEqual({ combo: "Ctrl", complete: false, needsModifier: false });
	});

	it("completes once a real key lands", () => {
		const r = comboFromEvent(
			ev({ code: "Space", ctrlKey: true, altKey: true }),
		);
		expect(r.combo).toBe("Ctrl+Alt+Space");
		expect(r.complete).toBe(true);
		expect(r.needsModifier).toBe(false);
	});

	it("flags a bare key with no modifier", () => {
		const r = comboFromEvent(ev({ code: "KeyK" }));
		expect(r).toEqual({
			combo: "KeyK",
			complete: true,
			needsModifier: true,
		});
	});

	it("orders modifiers Ctrl, Alt, Shift, Meta", () => {
		const r = comboFromEvent(
			ev({
				code: "KeyJ",
				metaKey: true,
				shiftKey: true,
				altKey: true,
				ctrlKey: true,
			}),
		);
		expect(r.combo).toBe("Ctrl+Alt+Shift+Meta+KeyJ");
	});
});

describe("isModifierCode", () => {
	it("recognizes modifier-key Codes", () => {
		expect(isModifierCode("ShiftLeft")).toBe(true);
		expect(isModifierCode("MetaRight")).toBe(true);
		expect(isModifierCode("KeyA")).toBe(false);
	});
});
