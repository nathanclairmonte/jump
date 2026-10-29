import { describe, expect, it } from "vitest";
import { pinnedSpineClass } from "./project-spine";

describe("pinnedSpineClass", () => {
	it("keeps the Windows environment fallback and removes it on macOS", () => {
		expect(pinnedSpineClass(null, "wsl", "windows")).toBe("bg-wsl");
		expect(pinnedSpineClass(null, "windows", "windows")).toBe("bg-windows");
		expect(pinnedSpineClass(null, "mac", "macos")).toBe("bg-transparent");
	});

	it("keeps a user colour on either platform", () => {
		expect(pinnedSpineClass("rose", "mac", "macos")).toBe("bg-project-rose");
		expect(pinnedSpineClass("rose", "wsl", "windows")).toBe("bg-project-rose");
	});
});
