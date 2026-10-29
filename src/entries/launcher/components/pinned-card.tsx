import { Star } from "lucide-react";
import {
	type CSSProperties,
	forwardRef,
	type HTMLAttributes,
	type MouseEvent,
	type PointerEvent,
} from "react";
import type { Platform } from "@/lib/api";
import type { Candidate } from "@/lib/search/join";
import { cn } from "@/lib/utils";
import { pinnedSpineClass } from "./project-spine";

export interface PinnedCardProps {
	candidate: Candidate;
	platform: Platform;
	selected: boolean;
	onSelect: () => void;
	onLaunch: () => void;
	onTogglePin: () => void;
	// opens the action menu on this card (the ⋯ affordance).
	onOpenMenu?: () => void;
	style?: CSSProperties;
	// the whole card is the drag source now that the grip is gone; these are the dnd-kit
	// sortable attributes/listeners, spread onto the card root.
	dragHandleProps?: HTMLAttributes<HTMLElement>;
}

// keep a press on an interactive child (star, ⋯) from arming the card's drag sensor.
const swallowPointerDown = (e: PointerEvent) => e.stopPropagation();

/**
 * A single pinned project as a compact, single-line boxed card for the 3-across grid. No path
 * and no drag grip; the ⋯ menu affordance only shows on the active card but its slot is always
 * reserved (before the star) so the star stays flush-right and the row never reflows on hover.
 */
export const PinnedCard = forwardRef<HTMLDivElement, PinnedCardProps>(
	function PinnedCard(props, ref) {
		const {
			candidate: c,
			platform,
			selected,
			onSelect,
			onLaunch,
			onTogglePin,
			onOpenMenu,
			style,
			dragHandleProps,
		} = props;

		const handlePin = (e: MouseEvent) => {
			// the star sits inside the clickable card; don't also fire the card's launch.
			e.stopPropagation();
			onTogglePin();
		};

		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the card is a pointer convenience; keyboard launch is handled by the search input (Enter on the selected card)
			// biome-ignore lint/a11y/useKeyWithClickEvents: same reason; keyboard activation lives on the input, not per-card
			<div
				ref={ref}
				style={style}
				{...dragHandleProps}
				// marks the selected card: the action menu anchors to it and keyboard nav
				// scrolls it into view, both by querying this marker.
				data-action-anchor={selected ? "" : undefined}
				onMouseEnter={onSelect}
				onClick={onLaunch}
				className={cn(
					"flex min-w-0 cursor-grab items-center gap-[9px] overflow-hidden rounded-row border px-[11px] py-[9px] transition-colors duration-[120ms] active:cursor-grabbing",
					selected
						? "border-transparent bg-selection shadow-[inset_0_0_0_1px_var(--color-selection-ring)]"
						: "border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.018)]",
				)}
			>
				{/* color spine: doubles as the WSL/Windows indicator here (the badge is dropped to
				    save width), unless the project has its own assigned color. */}
				<span
					className={cn(
						"h-[17px] w-[3px] flex-none rounded-[2px]",
						pinnedSpineClass(c.color, c.kind, platform),
					)}
				/>

				{/* name (truncates at ~3-across width) */}
				<span className="min-w-0 flex-1 truncate font-medium text-[13.5px] text-ink">
					{c.displayName}
				</span>

				{/* reserved ⋯ slot: glyph only fades in on the active card, but its space is always
				    held so nothing reflows on hover. sits before the star so the star is flush-right
				    and resting cards don't show a trailing gap. cursor-default so it doesn't inherit
				    the card's grab cursor. */}
				<button
					type="button"
					tabIndex={-1}
					aria-label="Open actions"
					onPointerDown={swallowPointerDown}
					onClick={(e) => {
						e.stopPropagation();
						onOpenMenu?.();
					}}
					className={cn(
						"flex h-4 w-4 flex-none cursor-default items-center justify-center text-[14px] leading-none text-[#cfcdc8] transition-opacity duration-[120ms]",
						selected ? "opacity-100" : "pointer-events-none opacity-0",
					)}
				>
					⋯
				</button>

				{/* star (pinned -> always filled orange; clicking unpins) */}
				<button
					type="button"
					onPointerDown={swallowPointerDown}
					onClick={handlePin}
					aria-label="Unpin"
					aria-pressed
					className="flex h-[18px] w-[18px] flex-none items-center justify-center"
				>
					<Star size={15} className="fill-accent-orange text-accent-orange" />
				</button>
			</div>
		);
	},
);
