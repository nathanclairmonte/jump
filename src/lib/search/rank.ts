// drives uFuzzy over the candidate names and layers the composite scorer on top.
// uFuzzy earns its keep on fuzzy *name* matching + highlight ranges; the
// lower tiers (path/tag, env/editor) only need classification, so a substring test does.
// the result is a ranked list with the ranges the row component highlights.

import uFuzzy from "@leeoniya/ufuzzy";
import type { Platform } from "@/lib/api";
import { editorLabel } from "@/lib/editors";
import type { Candidate } from "./join";
import { classifyTier, compositeScore, type Tier } from "./score";

export interface RankedRow {
	candidate: Candidate;
	tier: Tier;
	score: number;
	// flat uFuzzy ranges [s,e,s,e,...] into the *display* name; empty when the match came
	// from the folder name (alias shown) or a non-name field.
	nameRanges: number[];
	// contiguous substring range into the path, or null.
	pathRange: [number, number] | null;
}

// allow up to one extra char within a term, forgiving of a stray typo without getting
// noisy. a plain numeric option, so it avoids uFuzzy's const-enum modes.
const uf = new uFuzzy({ intraIns: 1 });

// runs one uFuzzy pass and maps haystack index -> its match ranges + start offset.
function fuzzyPass(
	haystack: string[],
	needle: string,
): Map<number, { ranges: number[]; start: number }> {
	const result = new Map<number, { ranges: number[]; start: number }>();
	const idxs = uf.filter(haystack, needle);
	if (!idxs || idxs.length === 0) return result;
	const info = uf.info(idxs, haystack, needle);
	for (let i = 0; i < info.idx.length; i++) {
		result.set(info.idx[i], { ranges: info.ranges[i], start: info.start[i] });
	}
	return result;
}

// env/editor are coarse metadata filters, the lowest tier. require at least this many
// chars so a single common letter (e.g. "s", "w") that happens to sit inside "wsl"/
// "windows" doesn't pull every row into the metadata tier and bury the zero-results state.
const MIN_METADATA_QUERY = 2;

// matches the environment keyword as a *prefix* (not any substring), so "win"/"wsl" filter
// by env but incidental substrings like "in" or "do" inside "windows" do not.
function envMatches(kind: Candidate["kind"], q: string): boolean {
	if (kind === "windows") return "windows".startsWith(q);
	if (kind === "wsl") return "wsl".startsWith(q);
	return false;
}

/**
 * Ranks candidates for an active query. Returns [] for an empty query (the empty state
 * renders sections instead). `now` is injected so the frecency boost is testable.
 */
export function rank(
	candidates: Candidate[],
	query: string,
	now: number,
	platform: Platform,
): RankedRow[] {
	const needle = query.trim();
	const q = needle.toLowerCase();
	if (q === "") return [];

	const displayNames = candidates.map((c) => c.displayName);
	const folderNames = candidates.map((c) => c.name);
	const nameFuzzy = fuzzyPass(displayNames, needle);
	const folderFuzzy = fuzzyPass(folderNames, needle);

	const rows: RankedRow[] = [];
	candidates.forEach((c, i) => {
		const display = c.displayName.toLowerCase();
		const folder = c.name.toLowerCase();

		const exactName = display === q || folder === q;
		const prefixName = display.startsWith(q) || folder.startsWith(q);
		const fuzzyName = nameFuzzy.has(i) || folderFuzzy.has(i);

		const pathIdx = c.path.toLowerCase().indexOf(q);
		const pathOrTag =
			pathIdx >= 0 || c.tags.some((t) => t.toLowerCase().includes(q));

		const editorMatch =
			c.editorOverride != null &&
			editorLabel(c.editorOverride).toLowerCase().includes(q);
		const metadata =
			q.length >= MIN_METADATA_QUERY &&
			((platform === "windows" && envMatches(c.kind, q)) || editorMatch);

		const tier = classifyTier({
			exactName,
			prefixName,
			fuzzyName,
			pathOrTag,
			metadata,
		});
		if (tier == null) return;

		const score = compositeScore(tier, {
			openCount: c.openCount,
			lastOpenedAt: c.lastOpenedAt,
			pinned: c.pinned,
			now,
		});

		rows.push({
			candidate: c,
			tier,
			score,
			// highlight the displayed name only; if it didn't match (folder-only hit), leave
			// it unhighlighted (Q8).
			nameRanges: nameFuzzy.get(i)?.ranges ?? [],
			pathRange: pathIdx >= 0 ? [pathIdx, pathIdx + q.length] : null,
		});
	});

	rows.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		// equal score (same tier + boosts): earlier name-match start, then shorter name,
		// then alphabetical. deterministic and good enough at a personal-index scale.
		const sa = a.nameRanges.length ? a.nameRanges[0] : Number.POSITIVE_INFINITY;
		const sb = b.nameRanges.length ? b.nameRanges[0] : Number.POSITIVE_INFINITY;
		if (sa !== sb) return sa - sb;
		if (a.candidate.displayName.length !== b.candidate.displayName.length) {
			return a.candidate.displayName.length - b.candidate.displayName.length;
		}
		return a.candidate.displayName.localeCompare(b.candidate.displayName);
	});

	return rows;
}
