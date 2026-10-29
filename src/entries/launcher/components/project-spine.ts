import type { LocationKind, Platform, ProjectColor } from "@/lib/api";

// project spine colors -> the 3px left bar. unset renders transparent (still occupies the
// column so names stay aligned). shared by the recents/results rows and the pinned cards.
export const SPINE_CLASS: Record<ProjectColor, string> = {
	teal: "bg-project-teal",
	amber: "bg-project-amber",
	rose: "bg-project-rose",
	green: "bg-project-green",
};

// the assignable project colors, in palette order. single source of truth so the swatch
// pickers (row menu + edit dialog) can't drift from each other or from SPINE_CLASS.
export const PROJECT_COLORS: ProjectColor[] = [
	"teal",
	"amber",
	"rose",
	"green",
];

// on pinned cards the spine doubles as the environment indicator (the WSL/Windows badge is
// dropped there to reclaim width), tinting violet for WSL and azure for Windows.
const ENV_SPINE_CLASS: Record<LocationKind, string> = {
	wsl: "bg-wsl",
	windows: "bg-windows",
	mac: "bg-transparent",
};

/**
 * The spine color for a pinned card: a user-assigned project color wins when set, otherwise
 * the bar falls back to the environment tint so every pinned card still signals WSL vs
 * Windows without a badge. (Env colors are violet/azure, distinct from every project color,
 * so the two meanings never collide visually.)
 */
export function pinnedSpineClass(
	color: ProjectColor | null,
	kind: LocationKind,
	platform: Platform,
): string {
	if (color) return SPINE_CLASS[color];
	return platform === "macos" ? "bg-transparent" : ENV_SPINE_CLASS[kind];
}
