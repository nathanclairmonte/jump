import { describe, expect, it } from "vitest";
import type { Candidate } from "./join";
import { rank } from "./rank";

const NOW = 1_700_000_000_000;

function cand(over: Partial<Candidate> & { id: string }): Candidate {
	const name = over.name ?? over.id;
	return {
		name,
		alias: null,
		displayName: over.alias ?? name,
		path: `/home/me/${name}`,
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

describe("rank", () => {
	it("returns nothing for an empty query", () => {
		expect(rank([cand({ id: "a" })], "   ", NOW, "windows")).toEqual([]);
	});

	it("ranks an exact name above a prefix match", () => {
		const exact = cand({ id: "e", name: "ledger", path: "/x/ledger" });
		const prefix = cand({ id: "p", name: "ledger-cli", path: "/x/ledger-cli" });
		const rows = rank([prefix, exact], "ledger", NOW, "windows");
		expect(rows[0].candidate.id).toBe("e");
	});

	it("never lets a frequent + pinned weak (path-only) match outrank a prefix match", () => {
		const prefix = cand({ id: "p", name: "ledger-cli", path: "/x/ledger-cli" });
		// name doesn't match; only the path contains the query, yet it's heavily boosted.
		const boostedPath = cand({
			id: "q",
			name: "zzz",
			path: "/home/ledger/zzz",
			pinned: true,
			openCount: 9999,
			lastOpenedAt: NOW,
		});
		const rows = rank([boostedPath, prefix], "ledger", NOW, "windows");
		expect(rows[0].candidate.id).toBe("p");
	});

	it("uses frecency as a within-tier tiebreaker", () => {
		const cold = cand({ id: "cold", name: "ledger-b", path: "/x/ledger-b" });
		const warm = cand({
			id: "warm",
			name: "ledger-a",
			path: "/x/ledger-a",
			openCount: 50,
			lastOpenedAt: NOW,
		});
		const rows = rank([cold, warm], "ledger", NOW, "windows");
		expect(rows[0].candidate.id).toBe("warm");
	});

	it("returns highlight ranges for the name and a substring range for the path", () => {
		const rows = rank(
			[cand({ id: "a", name: "ledger-cli", path: "/x/ledger-cli" })],
			"led",
			NOW,
			"windows",
		);
		expect(rows[0].nameRanges.length).toBeGreaterThan(0);
		expect(rows[0].pathRange).toEqual([3, 6]);
	});

	it("does not flood the metadata tier on a short incidental substring", () => {
		// "in" is a substring of "windows" but not a prefix, and the name/path don't match,
		// so a windows project must not be dragged in via the metadata tier.
		const win = cand({
			id: "w",
			name: "alpha",
			path: "/x/alpha",
			kind: "windows",
		});
		expect(rank([win], "in", NOW, "windows")).toHaveLength(0);
	});

	it("matches the env keyword as a prefix filter", () => {
		const win = cand({
			id: "w",
			name: "alpha",
			path: "/x/alpha",
			kind: "windows",
		});
		const rows = rank([win], "win", NOW, "windows");
		expect(rows).toHaveLength(1);
		expect(rows[0].tier).toBe(1); // metadata tier
		expect(rank([win], "win", NOW, "macos")).toHaveLength(0);
	});

	it("does not classify mac projects as WSL metadata", () => {
		const mac = cand({
			id: "m",
			name: "alpha",
			path: "/Users/me/alpha",
			kind: "mac",
			distro: null,
		});
		expect(rank([mac], "ws", NOW, "windows")).toHaveLength(0);
		expect(rank([mac], "wsl", NOW, "windows")).toHaveLength(0);
	});

	it("matches the folder name even when an alias is displayed", () => {
		const rows = rank(
			[cand({ id: "a", name: "ledger-cli", alias: "My Ledger" })],
			"ledger-cli",
			NOW,
			"windows",
		);
		expect(rows).toHaveLength(1);
		// the match came from the folder name, so the displayed alias stays unhighlighted.
		expect(rows[0].nameRanges).toEqual([]);
	});
});
