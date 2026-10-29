import { describe, expect, it } from "vitest";
import {
	classifyTier,
	compositeScore,
	FRECENCY_BOOST_MAX,
	frecencyBoost,
	MAX_TOTAL_BOOST,
	PINNED_BOOST,
	type ScoreParams,
	TIER,
	TIER_GAP,
} from "./score";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const noBoost: ScoreParams = {
	openCount: 0,
	lastOpenedAt: null,
	pinned: false,
	now: NOW,
};

describe("classifyTier", () => {
	it("picks the highest matching tier", () => {
		expect(
			classifyTier({
				exactName: true,
				prefixName: true,
				fuzzyName: true,
				pathOrTag: true,
				metadata: true,
			}),
		).toBe(TIER.exactName);
		expect(
			classifyTier({
				exactName: false,
				prefixName: false,
				fuzzyName: false,
				pathOrTag: true,
				metadata: true,
			}),
		).toBe(TIER.pathOrTag);
	});

	it("returns null when nothing matched", () => {
		expect(
			classifyTier({
				exactName: false,
				prefixName: false,
				fuzzyName: false,
				pathOrTag: false,
				metadata: false,
			}),
		).toBeNull();
	});
});

describe("tier dominance", () => {
	it("orders exact > prefix > fuzzy > path/tag > metadata with no boosts", () => {
		const exact = compositeScore(TIER.exactName, noBoost);
		const prefix = compositeScore(TIER.prefixName, noBoost);
		const fuzzy = compositeScore(TIER.fuzzyName, noBoost);
		const path = compositeScore(TIER.pathOrTag, noBoost);
		const meta = compositeScore(TIER.metadataOnly, noBoost);
		expect(exact).toBeGreaterThan(prefix);
		expect(prefix).toBeGreaterThan(fuzzy);
		expect(fuzzy).toBeGreaterThan(path);
		expect(path).toBeGreaterThan(meta);
	});

	it("keeps the total boost budget under one tier gap (the scoring contract)", () => {
		expect(MAX_TOTAL_BOOST).toBeLessThan(TIER_GAP);
	});

	it("a maxed-out frequent + pinned fuzzy match never outranks a bare prefix match", () => {
		const maxedFuzzy = compositeScore(TIER.fuzzyName, {
			openCount: 1_000_000,
			lastOpenedAt: NOW,
			pinned: true,
			now: NOW,
		});
		const barePrefix = compositeScore(TIER.prefixName, noBoost);
		expect(maxedFuzzy).toBeLessThan(barePrefix);
	});
});

describe("frecency boost", () => {
	it("is zero for a never-opened candidate", () => {
		expect(frecencyBoost(0, null, NOW)).toBe(0);
	});

	it("rises with open count", () => {
		expect(frecencyBoost(10, NOW, NOW)).toBeGreaterThan(
			frecencyBoost(1, NOW, NOW),
		);
	});

	it("rewards more-recent opens (zoxide buckets)", () => {
		const recent = frecencyBoost(5, NOW - HOUR / 2, NOW); // within the hour: x4
		const stale = frecencyBoost(5, NOW - 2 * WEEK, NOW); // older than a week: /4
		expect(recent).toBeGreaterThan(stale);
	});

	it("stays strictly below its cap no matter how frequent", () => {
		expect(frecencyBoost(1e9, NOW, NOW)).toBeLessThan(FRECENCY_BOOST_MAX);
	});
});

describe("pinned boost", () => {
	it("adds exactly PINNED_BOOST within a tier", () => {
		const pinned = compositeScore(TIER.fuzzyName, { ...noBoost, pinned: true });
		const unpinned = compositeScore(TIER.fuzzyName, noBoost);
		expect(pinned - unpinned).toBe(PINNED_BOOST);
	});
});
