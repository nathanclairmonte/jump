import { Star } from "lucide-react";
import { type CSSProperties, forwardRef, type MouseEvent } from "react";
import { EnvBadge } from "@/components/env-badge";
import type { Platform } from "@/lib/api";
import { editorLabel } from "@/lib/editors";
import type { Candidate } from "@/lib/search/join";
import { cn } from "@/lib/utils";
import { Highlight } from "./highlight";
import { SPINE_CLASS } from "./project-spine";

export interface ProjectRowProps {
	candidate: Candidate;
	platform: Platform;
	selected: boolean;
	// search-mode extras; ignored in the empty state.
	disambiguation?: string;
	nameRanges?: number[];
	pathRange?: [number, number] | null;
	onSelect: () => void;
	onLaunch: () => void;
	onTogglePin: () => void;
	// opens the action menu on this row (the ⋯ affordance).
	onOpenMenu?: () => void;
	style?: CSSProperties;
}

export const ProjectRow = forwardRef<HTMLDivElement, ProjectRowProps>(
	function ProjectRow(props, ref) {
		const {
			candidate: c,
			platform,
			selected,
			disambiguation,
			nameRanges = [],
			pathRange = null,
			onSelect,
			onLaunch,
			onTogglePin,
			onOpenMenu,
			style,
		} = props;

		const handlePin = (e: MouseEvent) => {
			// the star sits inside a clickable row; don't also fire the row's launch.
			e.stopPropagation();
			onTogglePin();
		};

		const pathRanges = pathRange ?? [];

		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the row is a pointer convenience; keyboard launch is handled by the search input (Enter on the selected row)
			// biome-ignore lint/a11y/useKeyWithClickEvents: same reason; keyboard activation lives on the input, not per-row
			<div
				ref={ref}
				style={style}
				// marks the selected row: the action menu anchors to it and keyboard nav
				// scrolls it into view, both by querying this marker.
				data-action-anchor={selected ? "" : undefined}
				onMouseEnter={onSelect}
				onClick={onLaunch}
				className={cn(
					"flex items-center gap-3 rounded-row px-3 py-[11px]",
					selected
						? "bg-selection shadow-[inset_0_0_0_1px_var(--color-selection-ring)]"
						: "hover:bg-row-hover",
				)}
			>
				{/* color spine */}
				<span
					className={cn(
						"h-[22px] w-[3px] flex-none rounded-[2px]",
						c.color ? SPINE_CLASS[c.color] : "bg-transparent",
					)}
				/>

				{/* name + path (both truncate) */}
				<div className="min-w-0 flex-1">
					<div className="truncate font-medium text-[14.5px] text-ink">
						<Highlight
							text={c.displayName}
							ranges={nameRanges}
							className="text-accent-soft"
						/>
					</div>
					<div className="mt-[2px] truncate font-mono text-[12px] text-ink-path">
						{disambiguation ? (
							<>
								<span className="text-ink-faint">{disambiguation}</span>
								<span> · </span>
							</>
						) : null}
						<Highlight
							text={c.path}
							ranges={pathRanges}
							className="text-[#b0aea8]"
						/>
					</div>
				</div>

				{/* environment badge + optional editor-override suffix */}
				<span className="flex flex-none items-center gap-[7px]">
					{platform === "windows" ? <EnvBadge kind={c.kind} /> : null}
					{c.editorOverride ? (
						<span className="text-[11.5px] text-ink-tertiary">
							{editorLabel(c.editorOverride)}
						</span>
					) : null}
				</span>

				{/* reserved ⋯ slot: glyph only fades in on the active row, but its space is always
				    held (and sits before the star) so the star stays flush-right and nothing
				    reflows on hover. clicking it opens the action menu (only reachable on the
				    selected row, which is pointer-active). */}
				<button
					type="button"
					tabIndex={-1}
					aria-label="Open actions"
					onClick={(e) => {
						e.stopPropagation();
						onOpenMenu?.();
					}}
					className={cn(
						"flex h-6 w-4 flex-none items-center justify-center text-[17px] leading-none text-[#cfcdc8] transition-opacity duration-[120ms]",
						selected ? "opacity-100" : "pointer-events-none opacity-0",
					)}
				>
					⋯
				</button>

				{/* star toggle */}
				<button
					type="button"
					onClick={handlePin}
					aria-label={c.pinned ? "Unpin" : "Pin"}
					aria-pressed={c.pinned}
					className="flex h-[22px] w-[22px] flex-none items-center justify-center"
				>
					<Star
						size={15}
						className={cn(
							c.pinned
								? "fill-accent-orange text-accent-orange"
								: "text-ink-faint opacity-50",
						)}
					/>
				</button>
			</div>
		);
	},
);
