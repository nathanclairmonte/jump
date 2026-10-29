import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./format";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe("formatRelativeTime", () => {
	it("renders a placeholder for never-opened", () => {
		expect(formatRelativeTime(null, NOW)).toBe("Never");
	});

	it("buckets recent spans into minutes, hours, and days", () => {
		expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe("5m ago");
		expect(formatRelativeTime(NOW - 3 * HR, NOW)).toBe("3h ago");
		expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe("2d ago");
	});

	it("rolls up into months and years past the day range", () => {
		expect(formatRelativeTime(NOW - 45 * DAY, NOW)).toBe("1mo ago");
		expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe("1y ago");
	});

	it("crosses the month/year boundary without a '0y ago' dead zone", () => {
		// 360-364 days: 12 thirty-day months, which must read as a year, not "0y ago".
		expect(formatRelativeTime(NOW - 362 * DAY, NOW)).toBe("1y ago");
		expect(formatRelativeTime(NOW - 359 * DAY, NOW)).toBe("11mo ago");
	});

	it("treats clock skew (future timestamp) as just now, not a negative span", () => {
		expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe("just now");
	});
});
