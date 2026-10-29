// per-member minimal distinguishing suffix for same-named projects. when two or more
// *visible* results share a display name, each gets the smallest
// run of leaf-ward ancestor directories that makes it unique within the group: k=1 is the
// parent (the common case), k=2 adds the grandparent, and so on. unique names get no
// label. the result is rendered as `label · /full/path`.

export interface DisambiguationItem {
	id: string;
	displayName: string;
	path: string;
}

// the join separator for a collision key. it must be a char that can never appear in a
// path segment, so two different segment lists can't collapse to the same key. segments
// are split on "/" and backslash, so "/" can never occur inside one, which makes it a
// safe sentinel (an earlier version used a raw NUL byte, which made this file binary and
// undiffable).
const SEG_SEP = "/";

// splits a windows or linux path into segments, dropping the final one (the project
// folder, which *is* the colliding name) and returning the ancestors leaf-first so
// slicing from the front walks parent -> grandparent.
function ancestorsLeafFirst(path: string): string[] {
	const segments = path.split(/[/\\]+/).filter(Boolean);
	segments.pop();
	return segments.reverse();
}

/**
 * Builds a map of id -> disambiguation label. Empty string means "no collision, show the
 * bare path". Operates on whatever list is currently visible, so the context is exactly
 * what the user can see.
 */
export function computeDisambiguation(
	items: DisambiguationItem[],
): Map<string, string> {
	const labels = new Map<string, string>();

	// group by the displayed name; only groups of 2+ need disambiguating.
	const groups = new Map<string, DisambiguationItem[]>();
	for (const item of items) {
		const key = item.displayName.toLowerCase();
		const bucket = groups.get(key);
		if (bucket) bucket.push(item);
		else groups.set(key, [item]);
	}

	for (const group of groups.values()) {
		if (group.length < 2) {
			for (const item of group) labels.set(item.id, "");
			continue;
		}

		const ancestors = group.map((item) => ancestorsLeafFirst(item.path));

		group.forEach((item, i) => {
			const mine = ancestors[i];
			let label = mine.slice().reverse().join("/"); // fallback: the full ancestor path
			for (let k = 1; k <= mine.length; k++) {
				const myKey = mine.slice(0, k).join(SEG_SEP);
				const collides = group.some(
					(_, j) => j !== i && ancestors[j].slice(0, k).join(SEG_SEP) === myKey,
				);
				if (!collides) {
					// render leaf-ward segments back in path order (grandparent/parent).
					label = mine.slice(0, k).reverse().join("/");
					break;
				}
			}
			labels.set(item.id, label);
		});
	}

	return labels;
}
