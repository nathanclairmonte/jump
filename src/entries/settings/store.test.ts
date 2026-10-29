import { describe, expect, it } from "vitest";
import { asTarget } from "./store";

describe("asTarget", () => {
	it("parses a plain section and the add-location deep link", () => {
		expect(asTarget("projects")).toEqual({
			section: "projects",
			action: null,
		});
		expect(asTarget("searchLocations:addLocation")).toEqual({
			section: "searchLocations",
			action: "addLocation",
		});
	});

	it("rejects unknown sections and actions on the wrong section", () => {
		expect(asTarget("unknown")).toBeNull();
		expect(asTarget("general:addLocation")).toBeNull();
		expect(asTarget("projects:unknownAction")).toBeNull();
	});
});
