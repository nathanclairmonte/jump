// the Projects-table view-model: a pure join of the rust-owned index with settings, plus tab
// classification, counts, and search. distinct from the launcher's joinCandidates (which is
// shaped for the palette: it drops excluded and is section-oriented). this one keeps *every*
// project and tags each row with its full state so the settings table can filter by tab.
//
// rust stays the source of truth; this is derived ui state. ranking lives in the launcher's
// scorer; the settings search is a plain substring filter (the table is browse-first, not
// keystroke-ranked).

import type {
	LocationKind,
	Platform,
	ProjectColor,
	ProjectsIndex,
	Settings,
} from "@/lib/api";

/** The six tabs in the Projects panel. They are overlapping *filters*, not disjoint buckets. */
export type ProjectTab =
	| "active"
	| "pinned"
	| "recent"
	| "explicit"
	| "missing"
	| "excluded";

export const PROJECT_TABS: ProjectTab[] = [
	"active",
	"pinned",
	"recent",
	"explicit",
	"missing",
	"excluded",
];

export interface ProjectRow {
	id: string;
	// folder name + optional alias; display is alias-or-folder.
	name: string;
	alias: string | null;
	displayName: string;
	path: string;
	kind: LocationKind;
	distro: string | null;
	markers: string[];
	githubUrl: string | null;
	// user metadata
	color: ProjectColor | null;
	editorOverride: string | null;
	tags: string[];
	// states (built-in)
	pinned: boolean;
	// position in pinnedOrder (-1 when unpinned), so the Pinned tab keeps user order.
	pinIndex: number;
	excluded: boolean;
	missing: boolean;
	explicit: boolean;
	recent: boolean;
	openCount: number;
	lastOpenedAt: number | null;
}

/**
 * Joins the index with settings into the table's rows, keeping excluded projects (the launcher
 * join drops them). Sorted by display name, case-insensitive, so the default table order is
 * stable; tab views re-sort where order matters (Pinned by pin index, Recent by last opened).
 */
export function joinProjectRows(
	index: ProjectsIndex,
	settings: Settings,
): ProjectRow[] {
	const pinIndexById = new Map<string, number>(
		settings.pinnedOrder.map((id, i) => [id, i]),
	);
	const recentById = new Map(settings.recents.map((r) => [r.id, r]));

	const rows = index.projects.map((project) => {
		const override = settings.projectOverrides[project.id];
		const recent = recentById.get(project.id) ?? null;
		const pinIndex = pinIndexById.get(project.id) ?? -1;
		const alias = override?.alias ?? null;
		return {
			id: project.id,
			name: project.name,
			alias,
			displayName: alias ?? project.name,
			path: project.path,
			kind: project.kind,
			distro: project.distro,
			markers: project.markers,
			githubUrl: project.githubUrl,
			color: override?.color ?? null,
			editorOverride: override?.editorOverride ?? null,
			tags: override?.tags ?? [],
			pinned: pinIndex >= 0,
			pinIndex,
			excluded: override?.excluded ?? false,
			missing: project.missing,
			explicit: project.explicit,
			recent: recent != null,
			openCount: recent?.openCount ?? 0,
			lastOpenedAt: recent?.lastOpenedAt ?? null,
		};
	});

	rows.sort((a, b) =>
		a.displayName.localeCompare(b.displayName, undefined, {
			sensitivity: "base",
		}),
	);
	return rows;
}

/**
 * Whether a row belongs to a tab. Excluded projects live *only* in the Excluded tab; everything
 * else operates on non-excluded rows, and Active plus its sub-views (Pinned / Recent / Explicit)
 * are all "working" projects, so they exclude the broken (missing) ones too. A missing project
 * therefore surfaces in the Missing tab until it is restored by a rescan or removed.
 */
export function rowInTab(row: ProjectRow, tab: ProjectTab): boolean {
	if (tab === "excluded") return row.excluded;
	if (row.excluded) return false;
	switch (tab) {
		case "missing":
			return row.missing;
		case "active":
			return !row.missing;
		case "pinned":
			return row.pinned && !row.missing;
		case "recent":
			return row.recent && !row.missing;
		case "explicit":
			return row.explicit && !row.missing;
	}
}

/** Rows in a tab, ordered for that tab (Pinned by pin index, Recent newest-first, else by name). */
export function rowsForTab(rows: ProjectRow[], tab: ProjectTab): ProjectRow[] {
	const inTab = rows.filter((r) => rowInTab(r, tab));
	if (tab === "pinned") {
		return inTab.sort((a, b) => a.pinIndex - b.pinIndex);
	}
	if (tab === "recent") {
		return inTab.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
	}
	return inTab; // already display-name sorted by joinProjectRows
}

/** A user-chosen column sort that overrides a tab's natural order (Pinned excepted). */
export type SortCol = "name" | "env" | "time";
export interface TableSort {
	col: SortCol;
	dir: "asc" | "desc";
}

export interface ProjectTableColumn {
	label: string;
	col: SortCol;
}

// every column the table can show, in render order. macOS drops env because there is only
// one environment there, so it filters this list rather than restating the shared columns.
const ALL_COLUMNS: ProjectTableColumn[] = [
	{ label: "Project", col: "name" },
	{ label: "Environment", col: "env" },
	{ label: "Last Opened", col: "time" },
];

/** The sortable project columns visible on a host platform. */
export function projectTableColumns(platform: Platform): ProjectTableColumn[] {
	return platform === "macos"
		? ALL_COLUMNS.filter((c) => c.col !== "env")
		: ALL_COLUMNS;
}

// the direction a column lands on at first click: names read A->Z, env A->Z (Windows before WSL),
// but "last opened" is far more useful newest-first, so time defaults to descending.
const DEFAULT_DIR: Record<SortCol, "asc" | "desc"> = {
	name: "asc",
	env: "asc",
	time: "desc",
};

/**
 * Three-state header toggle: a fresh column starts at its sensible default direction, a second
 * click flips it, and a third returns to the tab's natural order (null).
 */
export function cycleSort(
	prev: TableSort | null,
	col: SortCol,
): TableSort | null {
	const def = DEFAULT_DIR[col];
	if (!prev || prev.col !== col) return { col, dir: def };
	if (prev.dir === def) return { col, dir: def === "asc" ? "desc" : "asc" };
	return null;
}

/** Applies a column sort, with display name as a stable (always-ascending) secondary key. */
export function sortRows(rows: ProjectRow[], sort: TableSort): ProjectRow[] {
	const byName = (a: ProjectRow, b: ProjectRow) =>
		a.displayName.localeCompare(b.displayName, undefined, {
			sensitivity: "base",
		});
	const mul = sort.dir === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		if (sort.col === "name") return byName(a, b) * mul;
		const primary =
			sort.col === "env"
				? a.kind.localeCompare(b.kind)
				: (a.lastOpenedAt ?? 0) - (b.lastOpenedAt ?? 0);
		if (primary !== 0) return primary * mul;
		return byName(a, b);
	});
}

/** Per-tab counts for the tab strip badges. */
export function tabCounts(rows: ProjectRow[]): Record<ProjectTab, number> {
	const counts = {} as Record<ProjectTab, number>;
	for (const tab of PROJECT_TABS) counts[tab] = 0;
	// one pass over the rows (a row can count toward several tabs) instead of re-walking the
	// whole list once per tab.
	for (const row of rows) {
		for (const tab of PROJECT_TABS) {
			if (rowInTab(row, tab)) counts[tab] += 1;
		}
	}
	return counts;
}

/**
 * Filters rows by a free-text query over display name, folder name, path, and tags
 * (case-insensitive substring). An empty/whitespace query returns the input unchanged.
 */
export function filterRows(rows: ProjectRow[], query: string): ProjectRow[] {
	const q = query.trim().toLowerCase();
	if (q === "") return rows;
	return rows.filter(
		(r) =>
			r.displayName.toLowerCase().includes(q) ||
			r.name.toLowerCase().includes(q) ||
			r.path.toLowerCase().includes(q) ||
			r.tags.some((t) => t.toLowerCase().includes(q)),
	);
}
