// small pure formatting helpers. `now` is always injected (never read from the clock here) so
// these stay deterministic and unit-testable, matching the search scorer's convention.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Formats an epoch-millis timestamp as a short relative span for the Projects table's
 * "last opened" column. Null (never opened) renders as an em-dash-free placeholder.
 */
export function formatRelativeTime(ms: number | null, now: number): string {
	if (ms == null) return "Never";
	const diff = now - ms;
	if (diff < 0) return "just now"; // a clock skew shouldn't surface a negative span
	if (diff < MINUTE) return "just now";
	if (diff < HOUR) {
		const m = Math.floor(diff / MINUTE);
		return `${m}m ago`;
	}
	if (diff < DAY) {
		const h = Math.floor(diff / HOUR);
		return `${h}h ago`;
	}
	const d = Math.floor(diff / DAY);
	if (d < 30) return `${d}d ago`;
	const months = Math.floor(d / 30);
	if (months < 12) return `${months}mo ago`;
	// derive years from the same 30-day months so the buckets never disagree at the boundary
	// (a separate /365 here would render 360-364 days as a nonsensical "0y ago").
	const years = Math.floor(months / 12);
	return `${years}y ago`;
}
