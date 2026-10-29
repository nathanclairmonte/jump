import { describe, expect, it } from "vitest";
import { type GridGeom, type NavState, navigateGrid } from "./grid-nav";

// a 7-pin grid (rows: [0,1,2] [3,4,5] [6]) over 3 recents (indices 7,8,9). the bottom grid
// row is ragged (one cell) so the column-memory cases have something to clamp against.
const geom: GridGeom = { pinned: 7, recent: 3, cols: 3 };

const at = (index: number, column: number): NavState => ({ index, column });

describe("navigateGrid horizontal", () => {
	it("moves within a row and tracks the lane", () => {
		expect(navigateGrid(at(0, 0), "right", geom)).toEqual({
			index: 1,
			column: 1,
		});
		expect(navigateGrid(at(1, 1), "left", geom)).toEqual({
			index: 0,
			column: 0,
		});
	});

	it("clamps at row edges instead of wrapping", () => {
		// right edge of the top row does not jump to the next row.
		expect(navigateGrid(at(2, 2), "right", geom)).toEqual({
			index: 2,
			column: 2,
		});
		// left edge of a row stays put.
		expect(navigateGrid(at(3, 0), "left", geom)).toEqual({
			index: 3,
			column: 0,
		});
	});

	it("clamps at the grid's final ragged cell", () => {
		// index 6 is alone on the bottom row; right has no cell to move to.
		expect(navigateGrid(at(6, 0), "right", geom)).toEqual({
			index: 6,
			column: 0,
		});
	});

	it("does nothing horizontally in recents", () => {
		expect(navigateGrid(at(8, 1), "left", geom)).toEqual({
			index: 8,
			column: 1,
		});
		expect(navigateGrid(at(8, 1), "right", geom)).toEqual({
			index: 8,
			column: 1,
		});
	});
});

describe("navigateGrid vertical within the grid", () => {
	it("moves down the lane between full rows", () => {
		expect(navigateGrid(at(1, 1), "down", geom)).toEqual({
			index: 4,
			column: 1,
		});
		expect(navigateGrid(at(4, 1), "up", geom)).toEqual({
			index: 1,
			column: 1,
		});
	});

	it("clamps into a ragged row but keeps the intended lane", () => {
		// from (row1, col2) down: the bottom row has only col0, so land on it but remember 2.
		const landed = navigateGrid(at(5, 2), "down", geom);
		expect(landed).toEqual({ index: 6, column: 2 });
		// pressing up again climbs back to col2 of the row above, lane intact.
		expect(navigateGrid(landed, "up", geom)).toEqual({ index: 5, column: 2 });
	});

	it("stays put at the top row on up", () => {
		expect(navigateGrid(at(2, 2), "up", geom)).toEqual({
			index: 2,
			column: 2,
		});
	});
});

describe("navigateGrid grid <-> recents boundary", () => {
	it("crosses from the bottom grid row into recents, remembering the lane", () => {
		const intoRecents = navigateGrid(at(6, 2), "down", geom);
		expect(intoRecents).toEqual({ index: 7, column: 2 });
	});

	it("returns from the top recent into the grid at the remembered lane", () => {
		// came down from lane 2; going back up clamps to the ragged row but the lane survives.
		expect(navigateGrid(at(7, 2), "up", geom)).toEqual({ index: 6, column: 2 });
	});

	it("returns into a full bottom row at the exact lane", () => {
		// 6 pins => bottom row is full ([3,4,5]); lane 1 returns to index 4.
		const full: GridGeom = { pinned: 6, recent: 2, cols: 3 };
		expect(navigateGrid(at(6, 1), "up", full)).toEqual({ index: 4, column: 1 });
	});

	it("steps through recents and stops at the bottom", () => {
		expect(navigateGrid(at(7, 2), "down", geom)).toEqual({
			index: 8,
			column: 2,
		});
		expect(navigateGrid(at(9, 2), "down", geom)).toEqual({
			index: 9,
			column: 2,
		});
	});
});

describe("navigateGrid degenerate layouts", () => {
	it("no-ops on an empty layout", () => {
		const empty: GridGeom = { pinned: 0, recent: 0, cols: 3 };
		expect(navigateGrid(at(0, 0), "down", empty)).toEqual({
			index: 0,
			column: 0,
		});
	});

	it("treats a recents-only layout as a plain list", () => {
		const recentsOnly: GridGeom = { pinned: 0, recent: 3, cols: 3 };
		expect(navigateGrid(at(0, 0), "down", recentsOnly)).toEqual({
			index: 1,
			column: 0,
		});
		// up at the top of a grid-less list stays put.
		expect(navigateGrid(at(0, 0), "up", recentsOnly)).toEqual({
			index: 0,
			column: 0,
		});
	});

	it("stays in the grid when there are no recents to drop into", () => {
		const pinsOnly: GridGeom = { pinned: 4, recent: 0, cols: 3 };
		// index 3 is the lone bottom-row cell; down has nowhere to go.
		expect(navigateGrid(at(3, 0), "down", pinsOnly)).toEqual({
			index: 3,
			column: 0,
		});
	});
});
