// keyboard navigation for the empty state, where a `cols`-wide pinned grid sits on top of a
// 1-D recents list. selection is a single flat index into [...pinned, ...recent]; this pure
// helper maps an arrow press to the next index. `column` is the remembered horizontal lane:
// it survives the trip down into recents and back, and it survives a clamp into a ragged
// bottom row, so a short row can't permanently pull selection out of its lane.

export const GRID_COLS = 3;

export type GridDirection = "up" | "down" | "left" | "right";

export interface GridGeom {
	// pinned grid cell count (flat indices 0..pinned-1).
	pinned: number;
	// recents row count (flat indices pinned..pinned+recent-1).
	recent: number;
	cols: number;
}

export interface NavState {
	index: number;
	column: number;
}

const clamp = (n: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, n));

/**
 * Resolves one arrow press over the pinned-grid + recents layout. Horizontal moves clamp at
 * row edges (no reading-order wrap) and reset the remembered lane to the new column; vertical
 * moves travel along the remembered lane so ragged rows and the recents detour don't lose it.
 */
export function navigateGrid(
	state: NavState,
	dir: GridDirection,
	geom: GridGeom,
): NavState {
	const { pinned: P, recent: R, cols } = geom;
	const total = P + R;
	if (total === 0) return state;

	const i = clamp(state.index, 0, total - 1);
	const lane = clamp(state.column, 0, cols - 1);
	const inGrid = i < P;
	// index of the (possibly partial) last grid row; -1 when there is no grid.
	const lastGridRow = P > 0 ? Math.floor((P - 1) / cols) : -1;

	if (dir === "left") {
		if (inGrid) {
			const col = i % cols;
			if (col > 0) return { index: i - 1, column: col - 1 };
		}
		// recents and the left edge have nowhere leftward to go.
		return { index: i, column: lane };
	}

	if (dir === "right") {
		if (inGrid) {
			const col = i % cols;
			// stop at the row's right edge and at the grid's final (ragged) cell.
			if (col < cols - 1 && i + 1 < P) return { index: i + 1, column: col + 1 };
		}
		return { index: i, column: lane };
	}

	if (dir === "down") {
		if (inGrid) {
			const row = Math.floor(i / cols);
			if (row < lastGridRow) {
				// drop straight down the lane; a ragged target row clamps to its last cell but
				// keeps the lane so a later up-press climbs back into it.
				const target = (row + 1) * cols + lane;
				return { index: Math.min(target, P - 1), column: lane };
			}
			// past the bottom grid row: cross into recents, remembering the lane to return to.
			if (R > 0) return { index: P, column: lane };
			return { index: i, column: lane };
		}
		if (i + 1 < total) return { index: i + 1, column: lane };
		return { index: i, column: lane };
	}

	// up
	if (inGrid) {
		const row = Math.floor(i / cols);
		// rows above the last are always full, so the lane cell always exists.
		if (row > 0) return { index: (row - 1) * cols + lane, column: lane };
		return { index: i, column: lane };
	}
	// within recents: step up the list until the top, then re-enter the grid's bottom row.
	if (i > P) return { index: i - 1, column: lane };
	if (P > 0) {
		const lastRowStart = lastGridRow * cols;
		const lastRowCount = P - lastRowStart;
		// clamp the landing to the ragged row's width, but keep the intended lane in memory.
		const col = Math.min(lane, lastRowCount - 1);
		return { index: lastRowStart + col, column: lane };
	}
	return { index: i, column: lane };
}
