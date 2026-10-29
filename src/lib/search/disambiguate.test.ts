import { describe, expect, it } from "vitest";
import { computeDisambiguation } from "./disambiguate";

describe("computeDisambiguation", () => {
	it("gives no label when names are unique", () => {
		const labels = computeDisambiguation([
			{ id: "a", displayName: "alpha", path: "/home/me/alpha" },
			{ id: "b", displayName: "beta", path: "/home/me/beta" },
		]);
		expect(labels.get("a")).toBe("");
		expect(labels.get("b")).toBe("");
	});

	it("uses the parent dir when the name collides", () => {
		const labels = computeDisambiguation([
			{ id: "a", displayName: "app", path: "/home/me/work/app" },
			{ id: "b", displayName: "app", path: "/home/me/personal/app" },
		]);
		expect(labels.get("a")).toBe("work");
		expect(labels.get("b")).toBe("personal");
	});

	it("walks up to the grandparent when parents also collide", () => {
		const labels = computeDisambiguation([
			{ id: "a", displayName: "app", path: "/x/shared/app" },
			{ id: "b", displayName: "app", path: "/y/shared/app" },
		]);
		// parent "shared" collides; the grandparent (x vs y) disambiguates, rendered in
		// path order grandparent/parent.
		expect(labels.get("a")).toBe("x/shared");
		expect(labels.get("b")).toBe("y/shared");
	});

	it("handles windows paths and is case-insensitive on the name", () => {
		const labels = computeDisambiguation([
			{ id: "a", displayName: "App", path: "C:\\Users\\me\\work\\app" },
			{ id: "b", displayName: "app", path: "C:\\Users\\me\\play\\app" },
		]);
		expect(labels.get("a")).toBe("work");
		expect(labels.get("b")).toBe("play");
	});

	it("only labels the colliding group, not unique neighbours", () => {
		const labels = computeDisambiguation([
			{ id: "a", displayName: "app", path: "/one/app" },
			{ id: "b", displayName: "app", path: "/two/app" },
			{ id: "c", displayName: "solo", path: "/three/solo" },
		]);
		expect(labels.get("a")).toBe("one");
		expect(labels.get("b")).toBe("two");
		expect(labels.get("c")).toBe("");
	});
});
