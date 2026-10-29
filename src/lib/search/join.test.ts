import { describe, expect, it } from "vitest";
import type { Project, ProjectsIndex, Settings } from "@/lib/api";
import {
	joinCandidates,
	pinnedCandidates,
	recentCandidates,
	searchable,
} from "./join";

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

describe("joinCandidates", () => {
	it("drops excluded projects everywhere", () => {
		const cands = joinCandidates(
			index([project({ id: "keep" }), project({ id: "gone" })]),
			settings({ projectOverrides: { gone: { excluded: true } } }),
		);
		expect(cands.map((c) => c.id)).toEqual(["keep"]);
	});

	it("skips orphaned pin/recent ids with no index entry", () => {
		const cands = joinCandidates(
			index([project({ id: "real" })]),
			settings({
				pinnedOrder: ["real", "ghost"],
				recents: [{ id: "ghost2", lastOpenedAt: 1, openCount: 1 }],
			}),
		);
		expect(cands.map((c) => c.id)).toEqual(["real"]);
	});

	it("resolves alias as the display name but keeps the folder name searchable", () => {
		const [c] = joinCandidates(
			index([project({ id: "p", name: "repo" })]),
			settings({ projectOverrides: { p: { alias: "Cool Project" } } }),
		);
		expect(c.displayName).toBe("Cool Project");
		expect(c.name).toBe("repo");
	});

	it("marks pinned + recent state from settings", () => {
		const [c] = joinCandidates(
			index([project({ id: "p" })]),
			settings({
				pinnedOrder: ["p"],
				recents: [{ id: "p", lastOpenedAt: 123, openCount: 4 }],
			}),
		);
		expect(c.pinned).toBe(true);
		expect(c.openCount).toBe(4);
		expect(c.lastOpenedAt).toBe(123);
	});
});

describe("section selectors", () => {
	const idx = index([
		project({ id: "p1" }),
		project({ id: "p2" }),
		project({ id: "r1" }),
		project({ id: "miss", missing: true }),
	]);
	const set = settings({
		pinnedOrder: ["p2", "p1"], // user order: p2 before p1
		recents: [
			{ id: "r1", lastOpenedAt: 200, openCount: 1 },
			{ id: "p1", lastOpenedAt: 300, openCount: 1 }, // pinned -> excluded from Recent
			{ id: "miss", lastOpenedAt: 100, openCount: 1 }, // missing but recent -> kept
		],
	});
	const cands = joinCandidates(idx, set);

	it("orders the Pinned section by user pin order", () => {
		expect(pinnedCandidates(cands).map((c) => c.id)).toEqual(["p2", "p1"]);
	});

	it("orders Recent by lastOpenedAt desc, excludes pinned, keeps missing", () => {
		expect(recentCandidates(cands).map((c) => c.id)).toEqual(["r1", "miss"]);
	});

	it("excludes missing projects from the searchable set", () => {
		expect(searchable(cands).some((c) => c.id === "miss")).toBe(false);
	});
});
