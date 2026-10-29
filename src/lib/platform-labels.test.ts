import { describe, expect, it } from "vitest";
import { isLocationKindSupported } from "./platform-labels";

describe("isLocationKindSupported", () => {
	it("uses the persisted kind rather than scan state to identify foreign locations", () => {
		expect(isLocationKindSupported("macos", "mac")).toBe(true);
		expect(isLocationKindSupported("macos", "windows")).toBe(false);
		expect(isLocationKindSupported("macos", "wsl")).toBe(false);
		expect(isLocationKindSupported("windows", "windows")).toBe(true);
		expect(isLocationKindSupported("windows", "wsl")).toBe(true);
		expect(isLocationKindSupported("windows", "mac")).toBe(false);
	});
});
