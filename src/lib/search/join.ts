// joins the rust-owned index with settings into the launcher's view-models. rust stays
// the source of truth; this is pure derived ui state. the join
// resolves alias/color/editor-override, marks pinned/recent, and applies the launcher's
// visibility filters. ranking (search) and the section selectors (empty state) consume
// the candidates this produces.

import type {
	LocationKind,
	ProjectColor,
	ProjectsIndex,
	Settings,
} from "@/lib/api";

export interface Candidate {
	id: string;
	// the real folder name and the optional alias; display is alias-or-folder. both are
	// searchable, but only the displayed string is highlighted.
	name: string;
	alias: string | null;
	displayName: string;
	path: string;
	kind: LocationKind;
	distro: string | null;
	color: ProjectColor | null;
	editorOverride: string | null;
	tags: string[];
	missing: boolean;
	pinned: boolean;
	// position in pinnedOrder (-1 when unpinned), so the Pinned section keeps user order.
	pinIndex: number;
	openCount: number;
	lastOpenedAt: number | null;
	// the project's GitHub web URL (scan-resolved), or null. drives the action menu's
	// "Open in GitHub" item visibility.
	githubUrl: string | null;
}

/**
 * Builds the candidate list. Drops excluded projects everywhere and silently skips
 * orphaned pin/recent ids (no index entry, e.g. their location was removed). Missing
 * projects are kept here; callers decide visibility (kept in pins/recents, dropped from
 * search) via `searchable`.
 */
export function joinCandidates(
	index: ProjectsIndex,
	settings: Settings,
): Candidate[] {
	const pinIndexById = new Map<string, number>(
		settings.pinnedOrder.map((id, i) => [id, i]),
	);
	const recentById = new Map(settings.recents.map((r) => [r.id, r]));

	const out: Candidate[] = [];
	for (const project of index.projects) {
		const override = settings.projectOverrides[project.id];
		if (override?.excluded) continue; // excluded -> hidden everywhere

		const recent = recentById.get(project.id) ?? null;
		const pinIndex = pinIndexById.get(project.id) ?? -1;
		const alias = override?.alias ?? null;

		out.push({
			id: project.id,
			name: project.name,
			alias,
			displayName: alias ?? project.name,
			path: project.path,
			kind: project.kind,
			distro: project.distro,
			color: override?.color ?? null,
			editorOverride: override?.editorOverride ?? null,
			tags: override?.tags ?? [],
			missing: project.missing,
			pinned: pinIndex >= 0,
			pinIndex,
			openCount: recent?.openCount ?? 0,
			lastOpenedAt: recent?.lastOpenedAt ?? null,
			githubUrl: project.githubUrl,
		});
	}
	return out;
}

/**
 * Applies a pin toggle to the pinned-order list: pinning appends (when absent), unpinning
 * removes. Pure so the launcher's optimistic update and the dev mock share one rule; rust
 * owns the authoritative copy.
 */
export function applyPin(
	order: string[],
	id: string,
	pinned: boolean,
): string[] {
	if (!pinned) return order.filter((p) => p !== id);
	return order.includes(id) ? order : [...order, id];
}

/** Pinned projects in user-chosen order, for the empty state's Pinned section. */
export function pinnedCandidates(candidates: Candidate[]): Candidate[] {
	return candidates
		.filter((c) => c.pinned)
		.sort((a, b) => a.pinIndex - b.pinIndex);
}

/**
 * Recent projects for the empty state's Recent section: most-recent first, pinned ones
 * excluded (they already show above), capped at `limit`.
 */
export function recentCandidates(
	candidates: Candidate[],
	// the launcher scrolls now, so the recent list can run long; cap generously rather
	// than render every project ever opened.
	limit = 50,
): Candidate[] {
	return candidates
		.filter((c) => !c.pinned && c.lastOpenedAt != null)
		.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
		.slice(0, limit);
}

/** The set searchable during an active query: missing projects are excluded. */
export function searchable(candidates: Candidate[]): Candidate[] {
	return candidates.filter((c) => !c.missing);
}
