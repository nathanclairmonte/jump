// the pure composite scorer. a result's score is one dominant text-match
// tier plus two bounded boosts (zoxide-style frecency + a flat pinned bump). the boosts
// only ever reorder *within* a tier: their total is held strictly below one tier gap, so
// a frequent-or-pinned weak match can never outrank a clearly better text match. that
// bound is the tested contract, not the exact constants.

export type Tier = 1 | 2 | 3 | 4 | 5;

// where in a candidate the query landed, highest to lowest. name tiers are computed
// against both the display name and the real folder name (best of the two).
export const TIER: Record<
	"exactName" | "prefixName" | "fuzzyName" | "pathOrTag" | "metadataOnly",
	Tier
> = {
	exactName: 5,
	prefixName: 4,
	fuzzyName: 3,
	pathOrTag: 2,
	metadataOnly: 1,
};

// tier bases are spaced by this gap. the boost budget below must stay under it.
export const TIER_GAP = 1000;

// frecency is asymptotic: it approaches but never reaches this cap, so the true max boost
// is strictly < FRECENCY_BOOST_MAX + PINNED_BOOST. kept well under TIER_GAP.
export const FRECENCY_BOOST_MAX = 600;
export const PINNED_BOOST = 300;

// the contract the suite asserts: no accumulation of boosts can
// jump a tier.
export const MAX_TOTAL_BOOST = FRECENCY_BOOST_MAX + PINNED_BOOST;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// controls how fast frecency saturates toward its cap. ~one same-day open already buys a
// meaningful nudge; many opens approach (never reach) the cap.
const FRECENCY_SATURATION = 4;

export interface MatchFlags {
	exactName: boolean;
	prefixName: boolean;
	fuzzyName: boolean;
	pathOrTag: boolean;
	metadata: boolean;
}

/** Picks the dominant tier for a candidate, or null when nothing matched. */
export function classifyTier(flags: MatchFlags): Tier | null {
	if (flags.exactName) return TIER.exactName;
	if (flags.prefixName) return TIER.prefixName;
	if (flags.fuzzyName) return TIER.fuzzyName;
	if (flags.pathOrTag) return TIER.pathOrTag;
	if (flags.metadata) return TIER.metadataOnly;
	return null;
}

// zoxide's bucketed recency multiplier: a visit today counts for more than one last week.
function recencyMultiplier(lastOpenedAt: number | null, now: number): number {
	if (lastOpenedAt == null) return 0;
	const dt = now - lastOpenedAt;
	if (dt < HOUR_MS) return 4;
	if (dt < DAY_MS) return 2;
	if (dt < WEEK_MS) return 0.5;
	return 0.25;
}

/**
 * The frecency boost: zoxide's `frequency × recencyMultiplier` shape, then squashed
 * through a saturating curve into [0, FRECENCY_BOOST_MAX). Bounded (unlike zoxide's raw
 * score) precisely so it can compete *within* a tier without ever crossing one.
 */
export function frecencyBoost(
	openCount: number,
	lastOpenedAt: number | null,
	now: number,
): number {
	const raw = openCount * recencyMultiplier(lastOpenedAt, now);
	if (raw <= 0) return 0;
	// diminishing returns: 1 - 1/(1 + raw/k) rises fast then flattens, asymptote at 1.
	return FRECENCY_BOOST_MAX * (1 - 1 / (1 + raw / FRECENCY_SATURATION));
}

export interface ScoreParams {
	openCount: number;
	lastOpenedAt: number | null;
	pinned: boolean;
	now: number;
}

/** The composite score: tier base + bounded frecency + bounded pinned bump. */
export function compositeScore(tier: Tier, p: ScoreParams): number {
	const base = tier * TIER_GAP;
	const frecency = frecencyBoost(p.openCount, p.lastOpenedAt, p.now);
	const pinned = p.pinned ? PINNED_BOOST : 0;
	return base + frecency + pinned;
}
