// host-specific display copy. the same action can carry a different name per platform, and
// rendering it in more than one surface means the string needs one owner or the surfaces drift.

import type { LocationKind, Platform } from "@/lib/api";

/** Whether a location kind belongs to the host and can be scanned there. */
export function isLocationKindSupported(
	platform: Platform,
	kind: LocationKind,
): boolean {
	return platform === "macos" ? kind === "mac" : kind !== "mac";
}

/** The host's file manager, as the user knows it by name. */
function fileManagerLabel(platform: Platform): string {
	return platform === "macos" ? "Finder" : "File Explorer";
}

/** The reveal-in-file-manager action label, shared by the launcher and settings row menus. */
export function showInFileManagerLabel(platform: Platform): string {
	return `Show in ${fileManagerLabel(platform)}`;
}
