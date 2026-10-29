// editor key -> human label, used to render the editor-override suffix on a launcher row
// and (later) the Editors settings UI. the *display* label is independent of the
// editor adapter logic, so it can live here and be shared without pulling in that logic.

import type { EditorKind } from "@/lib/api";

// the canonical list + type live in api.ts (next to the wire contract); re-export so UI code
// has one import for both the labels and the iteration order.
export { EDITOR_KINDS } from "@/lib/api";

export const EDITOR_LABELS: Record<EditorKind, string> = {
	vscode: "VS Code",
	cursor: "Cursor",
	zed: "Zed",
};

/** Resolves an editor key to its display label, falling back to the raw key. */
export function editorLabel(key: string): string {
	return EDITOR_LABELS[key as EditorKind] ?? key;
}
