import { Fragment, type ReactNode } from "react";
import type { Platform } from "@/lib/api";
import { GRID_COLS } from "@/lib/search/grid-nav";
import type { Candidate } from "@/lib/search/join";
import { ProjectRow } from "./project-row";
import { RowSlot } from "./row-slot";
import { PinnedSection } from "./sortable-pinned";

interface EmptyStateProps {
	pinned: Candidate[];
	platform: Platform;
	recent: Candidate[];
	selectedIndex: number;
	// onSelect carries the grid column for pinned cards (so keyboard nav resumes in-lane) and
	// just the index for recents (column is meaningless in the 1-D list).
	onSelect: (index: number, column?: number) => void;
	onLaunch: (id: string) => void;
	onTogglePin: (id: string, pinned: boolean) => void;
	onOpenMenu: (id: string) => void;
	onReorder: (ids: string[]) => void;
	// optional slot rendered right after a given row (the inline launch-error card).
	renderAfter?: (id: string) => ReactNode;
}

// the empty state's nav list is Pinned then Recent, so a recent row's global selection
// index is offset by the number of pinned cards.
export function EmptyState({
	pinned,
	platform,
	recent,
	selectedIndex,
	onSelect,
	onLaunch,
	onTogglePin,
	onOpenMenu,
	onReorder,
	renderAfter,
}: EmptyStateProps) {
	if (pinned.length === 0 && recent.length === 0) {
		return (
			<div className="px-4 py-14 text-center text-[13px] text-ink-faint">
				Pin a project, or open one, to see it here.
			</div>
		);
	}

	return (
		<div className="p-2">
			{pinned.length > 0 ? (
				<>
					<div className="flex items-center justify-between px-[11px] pt-[10px] pb-[9px]">
						<span className="font-semibold text-[11px] uppercase tracking-[0.07em] text-ink-faint">
							Pinned
						</span>
						<span className="font-mono text-[10px] text-[#54524d]">
							drag to reorder
						</span>
					</div>
					<PinnedSection
						items={pinned}
						platform={platform}
						selectedIndex={selectedIndex}
						onSelect={onSelect}
						onLaunch={onLaunch}
						onTogglePin={onTogglePin}
						onOpenMenu={onOpenMenu}
						onReorder={onReorder}
						cols={GRID_COLS}
					/>
					{/* a pinned project's launch error can't live inside the grid (a full-width row
					    won't fit a cell), so it renders here, full-width below the grid. only the one
					    failed id yields a card; the rest are null. */}
					{pinned.map((p) => (
						<Fragment key={`pinned-error-${p.id}`}>
							{renderAfter?.(p.id)}
						</Fragment>
					))}
				</>
			) : null}

			{/* boundary the back-to-top button watches: once this scrolls above the viewport
			    top, the pinned section is fully out of sight. rendered even with no pins (where
			    it sits at the very top) so a long recents-only list still surfaces the button. */}
			<div data-pinned-end aria-hidden className="h-0" />

			{recent.length > 0 ? (
				<>
					<div className="px-[11px] pt-[13px] pb-[6px]">
						<span className="font-semibold text-[11px] uppercase tracking-[0.07em] text-ink-faint">
							Recent
						</span>
					</div>
					{recent.map((candidate, j) => {
						const index = pinned.length + j;
						return (
							<RowSlot
								key={candidate.id}
								id={candidate.id}
								renderAfter={renderAfter}
							>
								<ProjectRow
									candidate={candidate}
									platform={platform}
									selected={index === selectedIndex}
									onSelect={() => onSelect(index)}
									onLaunch={() => onLaunch(candidate.id)}
									onTogglePin={() =>
										onTogglePin(candidate.id, candidate.pinned)
									}
									onOpenMenu={() => onOpenMenu(candidate.id)}
								/>
							</RowSlot>
						);
					})}
				</>
			) : null}
		</div>
	);
}
