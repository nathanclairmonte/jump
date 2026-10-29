import { describe, expect, it } from "vitest";
import {
	COLOR_OPTIONS,
	menuRows,
	rootMenuGroups,
	submenuRows,
} from "./action-menu";
import type { Candidate } from "./join";

// a minimal plain candidate (unpinned, no override, no github, never opened); each test
// overrides only the field under test.
function candidate(over: Partial<Candidate> = {}): Candidate {
	return {
		id: "p1",
		name: "proj",
		alias: null,
		displayName: "proj",
		path: "/home/me/proj",
		kind: "wsl",
		distro: "Ubuntu",
		color: null,
		editorOverride: null,
		tags: [],
		missing: false,
		pinned: false,
		pinIndex: -1,
		openCount: 0,
		lastOpenedAt: null,
		githubUrl: null,
		...over,
	};
}

const kinds = (c: Candidate) =>
	menuRows(c, "root", "windows").map((r) => r.kind);

describe("rootMenuGroups conditional items", () => {
	it("a plain project shows the lean set, no conditional items", () => {
		const k = kinds(candidate());
		expect(k).toEqual([
			"open",
			"openWith",
			"pin",
			"setEditor",
			"setColor",
			"copyPath",
			"showInExplorer",
			"exclude",
		]);
		expect(k).not.toContain("clearEditor");
		expect(k).not.toContain("openGithub");
		expect(k).not.toContain("removeRecent");
	});

	it("pin flips to Unpin and carries the pinned star when pinned", () => {
		const pin = menuRows(candidate({ pinned: true }), "root", "windows").find(
			(r) => r.kind === "pin",
		);
		expect(pin?.label).toBe("Unpin");
		expect(pin?.pinned).toBe(true);
		expect(
			menuRows(candidate(), "root", "windows").find((r) => r.kind === "pin")
				?.label,
		).toBe("Pin");
	});

	it("Clear Override appears only when an override is set", () => {
		expect(kinds(candidate({ editorOverride: "cursor" }))).toContain(
			"clearEditor",
		);
		expect(kinds(candidate())).not.toContain("clearEditor");
	});

	it("Open in GitHub appears only when a github url is resolved", () => {
		expect(
			kinds(candidate({ githubUrl: "https://github.com/me/proj" })),
		).toContain("openGithub");
		expect(kinds(candidate())).not.toContain("openGithub");
	});

	it("Remove from Recents appears only for projects in recents", () => {
		expect(kinds(candidate({ lastOpenedAt: 123 }))).toContain("removeRecent");
		expect(kinds(candidate())).not.toContain("removeRecent");
	});

	it("Exclude is the lone danger item", () => {
		const danger = menuRows(candidate(), "root", "windows").filter(
			(r) => r.danger,
		);
		expect(danger.map((r) => r.kind)).toEqual(["exclude"]);
	});

	it("groups are divided launch / metadata / extras / danger", () => {
		expect(rootMenuGroups(candidate(), "windows").length).toBe(4);
	});

	it("labels the file manager for the host platform", () => {
		const label = (platform: "windows" | "macos") =>
			menuRows(candidate(), "root", platform).find(
				(r) => r.kind === "showInExplorer",
			)?.label;
		expect(label("windows")).toBe("Show in File Explorer");
		expect(label("macos")).toBe("Show in Finder");
	});
});

describe("submenuRows", () => {
	it("Open With lists all three editors, none marked current", () => {
		const rows = submenuRows(
			candidate({ editorOverride: "cursor" }),
			"openWith",
		);
		expect(rows.map((r) => r.editor)).toEqual(["vscode", "cursor", "zed"]);
		expect(rows.every((r) => !r.current)).toBe(true);
	});

	it("Set Editor Override marks the current override", () => {
		const rows = submenuRows(candidate({ editorOverride: "cursor" }), "editor");
		expect(rows.find((r) => r.editor === "cursor")?.current).toBe(true);
		expect(rows.find((r) => r.editor === "vscode")?.current).toBe(false);
	});

	it("Set Color lists the presets plus Unset and marks the current color", () => {
		const rows = submenuRows(candidate({ color: "rose" }), "color");
		expect(rows.map((r) => r.color)).toEqual([
			"teal",
			"amber",
			"rose",
			"green",
			null,
		]);
		expect(rows.find((r) => r.color === "rose")?.current).toBe(true);
		// the last option (Unset = null) is current only when no color is set.
		expect(submenuRows(candidate(), "color").at(-1)?.current).toBe(true);
	});

	it("COLOR_OPTIONS ends with the Unset (null) choice", () => {
		expect(COLOR_OPTIONS.at(-1)).toEqual({ label: "Unset", value: null });
	});
});
