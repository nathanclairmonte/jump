import { Check, ChevronLeft, ChevronRight, Star } from "lucide-react";
import {
	Fragment,
	type MouseEvent,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Platform } from "@/lib/api";
import {
	type MenuRow,
	rootMenuGroups,
	submenuRows,
	submenuTitle,
} from "@/lib/search/action-menu";
import type { Candidate } from "@/lib/search/join";
import { cn } from "@/lib/utils";
import type { ActionMenuState } from "../store";
import { SPINE_CLASS } from "./project-spine";

interface ActionMenuProps {
	candidate: Candidate;
	platform: Platform;
	menu: ActionMenuState;
	// the frame is the positioning context and the element we grow to host the menu; the panel
	// is the visible box that carries the on-screen height cap and the selected-row anchor.
	frameRef: RefObject<HTMLDivElement | null>;
	panelRef: RefObject<HTMLDivElement | null>;
	onHover: (index: number) => void;
	onActivate: (index: number) => void;
	onBack: () => void;
	onClose: () => void;
}

/**
 * The launcher's floating action menu. Hand-rolled to live inside the launcher's custom
 * keyboard model: the input keeps focus, so this only renders the highlighted item (driven by
 * `menu.index`) and routes hover/click back to the store. Drill-in submenus (not flyouts) and a
 * row-anchored position, with the body dimmed behind it (done by the caller).
 */
export function ActionMenu({
	candidate,
	platform,
	menu,
	frameRef,
	panelRef,
	onHover,
	onActivate,
	onBack,
	onClose,
}: ActionMenuProps) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState(8);

	// anchor the menu to the selected row (the one carrying data-action-anchor), opening
	// downward from its top. when the result list is too short to contain the menu we grow the
	// frame (via min-height) so the window grows with it and the menu hangs below the panel,
	// rather than the whole panel stretching. growth is capped at the on-screen limit autosize
	// wrote on the panel, so a long list near the bottom still flips up instead of running
	// off-screen. recomputed when the target row or the drill level (which changes the menu's
	// height) change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: candidate.id + menu.level are intentional re-anchor triggers (the level changes the menu height); they aren't read in the body.
	useLayoutEffect(() => {
		const frame = frameRef.current;
		const panel = panelRef.current;
		const box = boxRef.current;
		if (!frame || !panel || !box) return;
		const frameRect = frame.getBoundingClientRect();
		const anchor = frame.querySelector("[data-action-anchor]");
		// fall back to just below the search header if the row can't be measured.
		let t = 56;
		if (anchor) t = anchor.getBoundingClientRect().top - frameRect.top;
		const GAP = 8;
		const boxH = box.offsetHeight;
		// the on-screen height cap autosize stamped on the panel; the menu can't grow the
		// window past it. absent (early reveal) means no cap yet.
		const cap =
			Number.parseFloat(panel.style.maxHeight) || Number.POSITIVE_INFINITY;
		// flip up only when even the capped window can't fit the menu opening downward.
		const top = Math.max(GAP, Math.min(t, cap - boxH - GAP));
		setTop(top);
		// grow the frame just enough to host the menu (never past the cap); taller content keeps
		// its natural height since min-height is only a floor.
		frame.style.minHeight = `${Math.min(cap, top + boxH + GAP)}px`;
		return () => {
			frame.style.minHeight = "";
		};
	}, [frameRef, panelRef, candidate.id, menu.level]);

	const isRoot = menu.level === "root";
	const groups = isRoot
		? rootMenuGroups(candidate, platform)
		: [submenuRows(candidate, menu.level)];
	// flat offset of each group's first row, so a row's display index matches the store's.
	const offsets: number[] = [];
	let acc = 0;
	for (const g of groups) {
		offsets.push(acc);
		acc += g.length;
	}

	const stop = (e: MouseEvent) => e.stopPropagation();

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss target; keyboard dismiss is the Esc ladder
		<div className="absolute inset-0 z-20" onMouseDown={onClose}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: this only stops a click inside the menu from reaching the backdrop's dismiss; it's not itself a control */}
			<div
				ref={boxRef}
				onMouseDown={stop}
				style={{ top }}
				className="absolute right-3.5 w-62 rounded-[13px] border border-white/11 bg-elevated p-1.5 shadow-[0_24px_60px_-14px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.05)]"
			>
				{!isRoot ? (
					// biome-ignore lint/a11y/noStaticElementInteractions: submenu header doubles as the back affordance; ‹/Esc also go back
					// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard back is the Esc/← ladder
					<div
						onClick={onBack}
						className="mb-0.5 flex cursor-default items-center gap-1 px-2.5 py-1.5 text-[11px] text-ink-faint"
					>
						<ChevronLeft size={13} strokeWidth={2.5} />
						<span className="font-semibold uppercase tracking-[0.06em]">
							{submenuTitle(menu.level)}
						</span>
					</div>
				) : null}

				{groups.map((group, gi) => (
					<Fragment key={offsets[gi]}>
						{gi > 0 ? <div className="mx-2 my-[5px] h-px bg-white/7" /> : null}
						{group.map((row, ri) => {
							const index = offsets[gi] + ri;
							return (
								<MenuItem
									key={`${row.kind}-${row.editor ?? String(row.color)}`}
									row={row}
									selected={index === menu.index}
									onHover={() => onHover(index)}
									onActivate={() => onActivate(index)}
								/>
							);
						})}
					</Fragment>
				))}
			</div>
		</div>
	);
}

interface MenuItemProps {
	row: MenuRow;
	selected: boolean;
	onHover: () => void;
	onActivate: () => void;
}

function MenuItem({ row, selected, onHover, onActivate }: MenuItemProps) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a menu item driven by the search input's keyboard model; pointer is a convenience
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is Enter on the input, not per-item
		<div
			onMouseEnter={onHover}
			onClick={onActivate}
			className={cn(
				"flex cursor-default items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px]",
				row.danger
					? "text-danger-text"
					: selected
						? "text-ink"
						: "text-[#d8d6d1]",
				selected && "bg-white/7",
			)}
		>
			<span className="flex min-w-0 items-center gap-2">
				{row.color !== undefined ? <ColorSwatch color={row.color} /> : null}
				<span className="truncate">{row.label}</span>
			</span>
			<MenuItemTrailing row={row} />
		</div>
	);
}

// the right-edge affordance per row kind: ↵ chip (Open), › chevron (submenu opener), star
// (pin/unpin), or a check (the applied submenu choice).
function MenuItemTrailing({ row }: { row: MenuRow }) {
	if (row.enterChip) {
		return (
			<span className="rounded-[5px] bg-white/8 px-1.5 py-0.5 font-mono text-[10.5px] text-[#cfcdc8]">
				↵
			</span>
		);
	}
	if (row.opensSubmenu) {
		return <ChevronRight size={14} className="text-ink-faint" />;
	}
	if (row.star) {
		return (
			<Star
				size={13}
				className={cn(
					row.pinned
						? "fill-accent-orange text-accent-orange"
						: "text-ink-faint opacity-50",
				)}
			/>
		);
	}
	if (row.current) {
		return <Check size={13} strokeWidth={2.5} className="text-accent-soft" />;
	}
	return null;
}

// a small swatch for the Set Color submenu: the preset tint, or a hollow ring for Unset.
function ColorSwatch({ color }: { color: MenuRow["color"] }) {
	return (
		<span
			className={cn(
				"h-[11px] w-[11px] flex-none rounded-[3px]",
				color ? SPINE_CLASS[color] : "border border-white/20",
			)}
		/>
	);
}
