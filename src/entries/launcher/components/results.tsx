import type { ReactNode } from "react";
import type { Platform } from "@/lib/api";
import type { RankedRow } from "@/lib/search/rank";
import { ProjectRow } from "./project-row";
import { RowSlot } from "./row-slot";

interface ResultsProps {
	rows: RankedRow[];
	platform: Platform;
	selectedIndex: number;
	// id -> disambiguation prefix (empty string when the name is unique in the list).
	labels: Map<string, string>;
	onSelectIndex: (index: number) => void;
	onLaunch: (id: string) => void;
	onTogglePin: (id: string, pinned: boolean) => void;
	onOpenMenu: (id: string) => void;
	// optional slot rendered right after a given row (the inline launch-error card).
	renderAfter?: (id: string) => ReactNode;
}

/** The single unified ranked search list: no section headers, no grip column. */
export function Results({
	rows,
	platform,
	selectedIndex,
	labels,
	onSelectIndex,
	onLaunch,
	onTogglePin,
	onOpenMenu,
	renderAfter,
}: ResultsProps) {
	return (
		<div className="p-2">
			{rows.map((row, i) => {
				const c = row.candidate;
				const label = labels.get(c.id);
				return (
					<RowSlot key={c.id} id={c.id} renderAfter={renderAfter}>
						<ProjectRow
							candidate={c}
							platform={platform}
							selected={i === selectedIndex}
							disambiguation={label || undefined}
							nameRanges={row.nameRanges}
							pathRange={row.pathRange}
							onSelect={() => onSelectIndex(i)}
							onLaunch={() => onLaunch(c.id)}
							onTogglePin={() => onTogglePin(c.id, c.pinned)}
							onOpenMenu={() => onOpenMenu(c.id)}
						/>
					</RowSlot>
				);
			})}
		</div>
	);
}
