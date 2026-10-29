import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { HTMLAttributes } from "react";
import type { Platform } from "@/lib/api";
import type { Candidate } from "@/lib/search/join";
import { PinnedCard } from "./pinned-card";

interface PinnedSectionProps {
	items: Candidate[];
	platform: Platform;
	// the pinned grid sits at the top of the empty-state nav list, so a card's global
	// selection index is just its position here.
	selectedIndex: number;
	// onSelect carries the card's grid column so keyboard nav can resume in the right lane.
	onSelect: (index: number, column: number) => void;
	onLaunch: (id: string) => void;
	onTogglePin: (id: string, pinned: boolean) => void;
	onOpenMenu: (id: string) => void;
	onReorder: (ids: string[]) => void;
	cols: number;
}

/**
 * The draggable Pinned grid. The whole card is the drag source (no grip); a 4px activation
 * distance keeps a plain click from being read as a drag. Reordering is mouse-only by design,
 * so there's no KeyboardSensor. The launch-error card is rendered outside this grid (a grid
 * cell can't host a full-width row), so there is no per-card trailing slot here.
 */
export function PinnedSection({
	items,
	platform,
	selectedIndex,
	onSelect,
	onLaunch,
	onTogglePin,
	onOpenMenu,
	onReorder,
	cols,
}: PinnedSectionProps) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	const onDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const oldIndex = items.findIndex((i) => i.id === active.id);
		const newIndex = items.findIndex((i) => i.id === over.id);
		if (oldIndex < 0 || newIndex < 0) return;
		onReorder(
			arrayMove(
				items.map((i) => i.id),
				oldIndex,
				newIndex,
			),
		);
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={onDragEnd}
		>
			<SortableContext
				items={items.map((i) => i.id)}
				strategy={rectSortingStrategy}
			>
				{/* grid-cols-3 must stay in sync with GRID_COLS (tailwind needs the literal class). */}
				<div className="grid grid-cols-3 gap-[7px] px-[5px] pb-[4px]">
					{items.map((candidate, i) => (
						<SortablePinnedCard
							key={candidate.id}
							candidate={candidate}
							platform={platform}
							selected={i === selectedIndex}
							onSelect={() => onSelect(i, i % cols)}
							onLaunch={() => onLaunch(candidate.id)}
							onTogglePin={() => onTogglePin(candidate.id, candidate.pinned)}
							onOpenMenu={() => onOpenMenu(candidate.id)}
						/>
					))}
				</div>
			</SortableContext>
		</DndContext>
	);
}

function SortablePinnedCard({
	candidate,
	platform,
	selected,
	onSelect,
	onLaunch,
	onTogglePin,
	onOpenMenu,
}: {
	candidate: Candidate;
	platform: Platform;
	selected: boolean;
	onSelect: () => void;
	onLaunch: () => void;
	onTogglePin: () => void;
	onOpenMenu: () => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: candidate.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.6 : undefined,
		zIndex: isDragging ? 10 : undefined,
	};

	return (
		<PinnedCard
			ref={setNodeRef}
			style={style}
			candidate={candidate}
			platform={platform}
			selected={selected}
			dragHandleProps={
				{
					...attributes,
					...listeners,
				} as unknown as HTMLAttributes<HTMLElement>
			}
			onSelect={onSelect}
			onLaunch={onLaunch}
			onTogglePin={onTogglePin}
			onOpenMenu={onOpenMenu}
		/>
	);
}
