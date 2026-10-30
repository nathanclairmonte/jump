import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectsIndex, Settings } from "@/lib/api";
import * as api from "@/lib/api";
import { menuRows } from "@/lib/search/action-menu";
import { joinCandidates } from "@/lib/search/join";
import { useLauncherStore } from "./store";

// keep the pure exports (EDITOR_KINDS) and stub the tauri commands the menu fires
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	removeFromRecents: vi.fn(() => Promise.resolve()),
	setPinned: vi.fn(() => Promise.resolve()),
}));

const project: Project = {
	id: "p1",
	kind: "mac",
	distro: null,
	path: "/Users/me/proj",
	name: "proj",
	markers: [],
	sourceLocationIds: [],
	missing: false,
	explicit: false,
	githubUrl: null,
};

const index: ProjectsIndex = {
	schemaVersion: 1,
	projects: [project],
	scan: { lastScanAt: null, durationMs: null, totalCount: 1, locations: [] },
};

function settings(pinned: boolean): Settings {
	return {
		schemaVersion: 1,
		launchAtStartup: false,
		rescanOnStartup: false,
		theme: "dark",
		defaultEditor: null,
		includeNestedProjects: false,
		defaultScanDepth: 3,
		hotkey: "",
		searchLocations: [],
		explicitProjects: [],
		editors: {},
		pinnedOrder: pinned ? ["p1"] : [],
		projectOverrides: {},
		recents: [{ id: "p1", lastOpenedAt: 123, openCount: 1 }],
	};
}

// seeds a recent project with the action menu open at root
function seed({ pinned = false } = {}) {
	const s = settings(pinned);
	useLauncherStore.setState({
		index,
		settings: s,
		platform: "macos",
		candidates: joinCandidates(index, s),
		actionMenu: { id: "p1", level: "root", index: 0 },
	});
}

const store = () => useLauncherStore.getState();

beforeEach(() => {
	vi.clearAllMocks();
});

describe("action menu hotkeys", () => {
	it("R opens the confirmation with Remove highlighted, and Enter removes", () => {
		seed();
		expect(store().pressActionHotkey("r")).toBe(true);
		expect(store().actionMenu).toEqual({
			id: "p1",
			level: "confirmRemoveRecent",
			index: 0,
		});
		expect(store().settings?.recents).toHaveLength(1);

		store().enterActionItem();
		expect(store().actionMenu).toBeNull();
		expect(store().settings?.recents).toEqual([]);
		expect(api.removeFromRecents).toHaveBeenCalledWith("p1");
	});

	it("R does not confirm from inside the confirmation", () => {
		seed();
		store().pressActionHotkey("r");
		expect(store().pressActionHotkey("r")).toBe(false);
		expect(api.removeFromRecents).not.toHaveBeenCalled();
	});

	it("Cancel returns to root on the Remove from Recents row", () => {
		seed();
		store().pressActionHotkey("R");
		store().moveActionMenu(1);
		store().enterActionItem();
		const menu = store().actionMenu;
		expect(menu?.level).toBe("root");
		const rows = menuRows(store().candidates[0], "root", "macos");
		expect(rows[menu?.index ?? -1]?.kind).toBe("removeRecent");
		expect(store().settings?.recents).toHaveLength(1);
		expect(api.removeFromRecents).not.toHaveBeenCalled();
	});

	it("P on a pinned project does nothing", () => {
		seed({ pinned: true });
		expect(store().pressActionHotkey("p")).toBe(false);
		expect(store().actionMenu?.level).toBe("root");
		expect(store().settings?.pinnedOrder).toEqual(["p1"]);
		expect(api.setPinned).not.toHaveBeenCalled();
	});

	it("U unpins a pinned project", () => {
		seed({ pinned: true });
		expect(store().pressActionHotkey("u")).toBe(true);
		expect(store().actionMenu).toBeNull();
		expect(store().settings?.pinnedOrder).toEqual([]);
		expect(api.setPinned).toHaveBeenCalledWith("p1", false);
	});
});
