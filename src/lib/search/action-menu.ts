// the launcher action menu's item model: a pure mapping from a Candidate (+ the current drill
// level) to the rows to render and navigate. lives here beside the other launcher-interaction
// helpers (grid-nav) so it's react/tauri-free and directly unit-testable. the component renders
// these rows and the store maps the selected row to an action.

import {
	EDITOR_KINDS,
	type EditorKind,
	type Platform,
	type ProjectColor,
} from "@/lib/api";
import { editorLabel } from "@/lib/editors";
import { showInFileManagerLabel } from "@/lib/platform-labels";
import type { Candidate } from "./join";

// the menu's drill levels: the root list, the three submenus, and the Remove from Recents
// confirmation, which reuses the submenu drill so back/Esc land on the row that opened it.
export type MenuLevel =
	| "root"
	| "openWith"
	| "editor"
	| "color"
	| "confirmRemoveRecent";

// every selectable kind. submenu *openers* (openWith/setEditor/setColor) carry `opensSubmenu`;
// submenu *leaves* (pickOpenWith/pickEditor/pickColor) carry the chosen value.
export type ActionKind =
	| "open"
	| "openWith"
	| "pin"
	| "setEditor"
	| "clearEditor"
	| "setColor"
	| "copyPath"
	| "openGithub"
	| "showInExplorer"
	| "removeRecent"
	| "exclude"
	| "pickOpenWith"
	| "pickEditor"
	| "pickColor"
	| "confirmRemoveRecent"
	| "cancel";

export interface MenuRow {
	kind: ActionKind;
	label: string;
	// exclude renders clay-red.
	danger?: boolean;
	// Open shows the ↵ chip.
	enterChip?: boolean;
	// pin/unpin shows the star (filled when pinned).
	star?: boolean;
	pinned?: boolean;
	// a root opener drills into this submenu on activate.
	opensSubmenu?: MenuLevel;
	// lowercase single-key shortcut that activates this row within its level.
	hotkey?: string;
	// submenu-leaf payloads.
	editor?: EditorKind;
	color?: ProjectColor | null;
	// a check is shown beside the currently-applied submenu choice.
	current?: boolean;
}

// the four color presets plus the Unset choice, for the Set Color submenu.
export const COLOR_OPTIONS: { label: string; value: ProjectColor | null }[] = [
	{ label: "Teal", value: "teal" },
	{ label: "Amber", value: "amber" },
	{ label: "Rose", value: "rose" },
	{ label: "Green", value: "green" },
	{ label: "Unset", value: null },
];

/**
 * The root menu as dividered groups (launch / metadata / extras / danger). Conditional items
 * appear only when applicable: Clear Override when an override exists, Open in GitHub when a
 * GitHub remote was resolved, Remove from Recents when the project is in recents (keyed on
 * recents membership, not which section it is displayed in). Rows carry their letter hotkey
 * here so rendering and key dispatch share one registry; Remove from Recents drills into a
 * confirmation rather than acting.
 */
export function rootMenuGroups(c: Candidate, platform: Platform): MenuRow[][] {
	return [
		[
			{ kind: "open", label: "Open", enterChip: true },
			{ kind: "openWith", label: "Open With…", opensSubmenu: "openWith" },
		],
		[
			{
				kind: "pin",
				label: c.pinned ? "Unpin" : "Pin",
				star: true,
				pinned: c.pinned,
				hotkey: c.pinned ? "u" : "p",
			},
			{
				kind: "setEditor",
				label: "Set Editor Override…",
				opensSubmenu: "editor",
			},
			...(c.editorOverride
				? [{ kind: "clearEditor", label: "Clear Override" } as MenuRow]
				: []),
			{ kind: "setColor", label: "Set Color…", opensSubmenu: "color" },
		],
		[
			{ kind: "copyPath", label: "Copy path", hotkey: "c" },
			...(c.githubUrl
				? [
						{
							kind: "openGithub",
							label: "Open in GitHub",
							hotkey: "g",
						} as MenuRow,
					]
				: []),
			{
				kind: "showInExplorer",
				label: showInFileManagerLabel(platform),
				hotkey: "f",
			},
			...(c.lastOpenedAt != null
				? [
						{
							kind: "removeRecent",
							label: "Remove from Recents",
							hotkey: "r",
							opensSubmenu: "confirmRemoveRecent",
						} as MenuRow,
					]
				: []),
		],
		[{ kind: "exclude", label: "Exclude from Search", danger: true }],
	];
}

/** A submenu's rows. Marks the currently-applied choice for editor/color. */
export function submenuRows(c: Candidate, level: MenuLevel): MenuRow[] {
	switch (level) {
		case "openWith":
			return EDITOR_KINDS.map((e) => ({
				kind: "pickOpenWith",
				label: editorLabel(e),
				editor: e,
			}));
		case "editor":
			return EDITOR_KINDS.map((e) => ({
				kind: "pickEditor",
				label: editorLabel(e),
				editor: e,
				current: c.editorOverride === e,
			}));
		case "color":
			return COLOR_OPTIONS.map((o) => ({
				kind: "pickColor",
				label: o.label,
				color: o.value,
				current: c.color === o.value,
			}));
		// no hotkeys here, so a repeated R can't confirm by accident
		case "confirmRemoveRecent":
			return [
				{
					kind: "confirmRemoveRecent",
					label: "Remove",
					danger: true,
					enterChip: true,
				},
				{ kind: "cancel", label: "Cancel" },
			];
		default:
			return [];
	}
}

/** The flat, navigable row list for the active level (root groups flattened, or a submenu). */
export function menuRows(
	c: Candidate,
	level: MenuLevel,
	platform: Platform,
): MenuRow[] {
	return level === "root"
		? rootMenuGroups(c, platform).flat()
		: submenuRows(c, level);
}

/** The header title shown when drilled into a submenu. */
export function submenuTitle(level: MenuLevel): string {
	switch (level) {
		case "openWith":
			return "Open With";
		case "editor":
			return "Set Editor Override";
		case "color":
			return "Set Color";
		case "confirmRemoveRecent":
			return "Remove from Recents?";
		default:
			return "";
	}
}
