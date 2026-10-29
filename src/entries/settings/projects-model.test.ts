import { describe, expect, it } from "vitest";
import type { Project, ProjectsIndex, Settings } from "@/lib/api";
import {
	cycleSort,
	filterRows,
	joinProjectRows,
	projectTableColumns,
	rowsForTab,
	sortRows,
	tabCounts,
} from "./projects-model";

function project(over: Partial<Project> & { id: string }): Project {
	return {
		kind: "wsl",
		distro: "Ubuntu",
		path: `/home/me/${over.id}`,
		name: over.id,
		markers: [],
		sourceLocationIds: ["loc"],
		missing: false,
		explicit: false,
		githubUrl: null,
		...over,
	};
}

function settings(over: Partial<Settings> = {}): Settings {
	return {
		schemaVersion: 1,
		launchAtStartup: false,
		rescanOnStartup: true,
		theme: "dark",
		defaultEditor: null,
		includeNestedProjects: false,
		defaultScanDepth: 3,
		hotkey: "Ctrl+Alt+Space",
		searchLocations: [],
		explicitProjects: [],
		editors: {},
		pinnedOrder: [],
		projectOverrides: {},
		recents: [],
		...over,
	};
}

function index(projects: Project[]): ProjectsIndex {
	return {
		schemaVersion: 1,
		projects,
		scan: {
			lastScanAt: null,
			durationMs: null,
			totalCount: projects.length,
			locations: [],
		},
	};
}

describe("joinProjectRows", () => {
	it("keeps excluded projects (unlike the launcher join) and resolves state flags", () => {
		const idx = index([project({ id: "a" }), project({ id: "b" })]);
		const s = settings({
			pinnedOrder: ["a"],
			projectOverrides: {
				b: { excluded: true, alias: "Beta", tags: ["x"] },
			},
			recents: [{ id: "a", lastOpenedAt: 5, openCount: 2 }],
		});
		const rows = joinProjectRows(idx, s);
		expect(rows).toHaveLength(2);
		const a = rows.find((r) => r.id === "a");
		const b = rows.find((r) => r.id === "b");
		expect(a?.pinned).toBe(true);
		expect(a?.recent).toBe(true);
		expect(b?.excluded).toBe(true);
		expect(b?.displayName).toBe("Beta");
		expect(b?.tags).toEqual(["x"]);
	});

	it("sorts by display name case-insensitively", () => {
		const idx = index([project({ id: "zed" }), project({ id: "Alpha" })]);
		const rows = joinProjectRows(idx, settings());
		expect(rows.map((r) => r.id)).toEqual(["Alpha", "zed"]);
	});
});

describe("tab classification", () => {
	const idx = index([
		project({ id: "active1" }),
		project({ id: "pinned1" }),
		project({ id: "missing1", missing: true }),
		project({ id: "excluded1" }),
		project({ id: "explicit1", explicit: true }),
		project({ id: "pinnedMissing", missing: true }),
	]);
	const s = settings({
		pinnedOrder: ["pinned1", "pinnedMissing"],
		projectOverrides: { excluded1: { excluded: true } },
		recents: [{ id: "active1", lastOpenedAt: 10, openCount: 1 }],
	});
	const rows = joinProjectRows(idx, s);

	it("Active excludes missing and excluded, but includes pinned/recent (overlapping)", () => {
		const active = rowsForTab(rows, "active").map((r) => r.id);
		expect(active).toContain("active1");
		expect(active).toContain("pinned1"); // pinned is a subset of active
		expect(active).toContain("explicit1");
		expect(active).not.toContain("missing1");
		expect(active).not.toContain("excluded1");
	});

	it("Pinned and Recent exclude missing rows (subsets of Active)", () => {
		const pinned = rowsForTab(rows, "pinned").map((r) => r.id);
		expect(pinned).toEqual(["pinned1"]); // pinnedMissing is missing -> not here
	});

	it("Missing and Excluded are their own buckets", () => {
		expect(
			rowsForTab(rows, "missing")
				.map((r) => r.id)
				.sort(),
		).toEqual(["missing1", "pinnedMissing"]);
		expect(rowsForTab(rows, "excluded").map((r) => r.id)).toEqual([
			"excluded1",
		]);
	});

	it("an excluded project appears in no tab but Excluded", () => {
		expect(rowsForTab(rows, "active").map((r) => r.id)).not.toContain(
			"excluded1",
		);
		expect(rowsForTab(rows, "pinned").map((r) => r.id)).not.toContain(
			"excluded1",
		);
	});

	it("counts overlap correctly", () => {
		const counts = tabCounts(rows);
		// active = active1, pinned1, explicit1
		expect(counts.active).toBe(3);
		expect(counts.pinned).toBe(1);
		expect(counts.explicit).toBe(1);
		expect(counts.missing).toBe(2);
		expect(counts.excluded).toBe(1);
	});
});

describe("Pinned tab ordering", () => {
	it("follows pin index, not display name", () => {
		const idx = index([project({ id: "zzz" }), project({ id: "aaa" })]);
		const s = settings({ pinnedOrder: ["zzz", "aaa"] });
		const rows = joinProjectRows(idx, s);
		expect(rowsForTab(rows, "pinned").map((r) => r.id)).toEqual(["zzz", "aaa"]);
	});
});

describe("filterRows", () => {
	const idx = index([
		project({ id: "alpha", name: "alpha", path: "/home/me/alpha" }),
		project({ id: "beta", name: "beta", path: "/srv/gamma" }),
	]);
	const s = settings({ projectOverrides: { beta: { tags: ["api"] } } });
	const rows = joinProjectRows(idx, s);

	it("matches name, path, and tags case-insensitively", () => {
		expect(filterRows(rows, "ALPHA").map((r) => r.id)).toEqual(["alpha"]);
		expect(filterRows(rows, "gamma").map((r) => r.id)).toEqual(["beta"]);
		expect(filterRows(rows, "api").map((r) => r.id)).toEqual(["beta"]);
	});

	it("returns all rows for a blank query", () => {
		expect(filterRows(rows, "   ")).toHaveLength(2);
	});
});

describe("cycleSort", () => {
	it("starts a fresh column at its sensible default direction", () => {
		expect(cycleSort(null, "name")).toEqual({ col: "name", dir: "asc" });
		expect(cycleSort(null, "env")).toEqual({ col: "env", dir: "asc" });
		// last-opened is far more useful newest-first.
		expect(cycleSort(null, "time")).toEqual({ col: "time", dir: "desc" });
	});

	it("flips on the second click and clears to natural order on the third", () => {
		const first = cycleSort(null, "name"); // asc
		const second = cycleSort(first, "name");
		expect(second).toEqual({ col: "name", dir: "desc" });
		expect(cycleSort(second, "name")).toBeNull();
	});

	it("switching to a different column restarts at that column's default", () => {
		const onName = cycleSort(null, "name");
		expect(cycleSort(onName, "time")).toEqual({ col: "time", dir: "desc" });
	});
});

describe("projectTableColumns", () => {
	it("keeps Environment on Windows and removes it on macOS", () => {
		expect(projectTableColumns("windows").map((c) => c.col)).toEqual([
			"name",
			"env",
			"time",
		]);
		expect(projectTableColumns("macos").map((c) => c.col)).toEqual([
			"name",
			"time",
		]);
	});
});

describe("sortRows", () => {
	const idx = index([
		project({ id: "beta", kind: "windows" }),
		project({ id: "alpha", kind: "wsl" }),
	]);
	const rows = joinProjectRows(
		idx,
		settings({
			recents: [
				{ id: "beta", lastOpenedAt: 100, openCount: 1 },
				{ id: "alpha", lastOpenedAt: 50, openCount: 1 },
			],
		}),
	);

	it("sorts by name in both directions", () => {
		expect(
			sortRows(rows, { col: "name", dir: "asc" }).map((r) => r.id),
		).toEqual(["alpha", "beta"]);
		expect(
			sortRows(rows, { col: "name", dir: "desc" }).map((r) => r.id),
		).toEqual(["beta", "alpha"]);
	});

	it("sorts by environment (Windows before WSL ascending)", () => {
		expect(
			sortRows(rows, { col: "env", dir: "asc" }).map((r) => r.kind),
		).toEqual(["windows", "wsl"]);
	});

	it("sorts by last-opened time", () => {
		expect(
			sortRows(rows, { col: "time", dir: "desc" }).map((r) => r.id),
		).toEqual(["beta", "alpha"]); // newest first
		expect(
			sortRows(rows, { col: "time", dir: "asc" }).map((r) => r.id),
		).toEqual(["alpha", "beta"]);
	});

	it("does not mutate the input array", () => {
		const before = rows.map((r) => r.id);
		sortRows(rows, { col: "name", dir: "desc" });
		expect(rows.map((r) => r.id)).toEqual(before);
	});
});
