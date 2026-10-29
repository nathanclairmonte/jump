// the Projects panel: search + tabbed table over the index×settings join (projects-model).
// the table is a display surface; discrete actions live in a per-row ⋯ dropdown and the rich
// free-text editing (alias/tags) in a dialog. the Pinned tab is drag-reorderable, reusing the
// same dnd-kit setup as the launcher's pinned grid. on scroll the tab strip + column header pin
// and the search field collapses (scroll-linked) into a magnifier that opens a floating search.

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
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ArrowDown,
	ArrowUp,
	MoreHorizontal,
	Search,
	Star,
	X,
} from "lucide-react";
import {
	motion,
	useMotionValue,
	useMotionValueEvent,
	useTransform,
} from "motion/react";
import {
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { EnvBadge } from "@/components/env-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheck,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	PROJECT_COLORS,
	SPINE_CLASS,
} from "@/entries/launcher/components/project-spine";
import {
	type EditorKind,
	openGithubUrl,
	type Platform,
	showInFileExplorer,
} from "@/lib/api";
import { EDITOR_KINDS, editorLabel } from "@/lib/editors";
import { formatRelativeTime } from "@/lib/format";
import { showInFileManagerLabel } from "@/lib/platform-labels";
import { cn } from "@/lib/utils";
import { AddExplicitDialog } from "../components/add-explicit-dialog";
import { ProjectEditForm } from "../components/project-edit-dialog";
import {
	cycleSort,
	filterRows,
	joinProjectRows,
	PROJECT_TABS,
	type ProjectRow,
	type ProjectTab,
	projectTableColumns,
	rowsForTab,
	type SortCol,
	sortRows,
	type TableSort,
	tabCounts,
} from "../projects-model";
import { useSettingsStore } from "../store";

const TAB_LABEL: Record<ProjectTab, string> = {
	active: "Active",
	pinned: "Pinned",
	recent: "Recent",
	explicit: "Explicit",
	missing: "Missing",
	excluded: "Excluded",
};

// the table grid: star(+spine) · name+path · env · last-opened · ⋯. the editor column was dropped
// (it was almost always "Default"; the override still lives in the row menu + edit dialog). the
// first track is widened so the 3px spine + star never get squeezed.
const GRID: Record<Platform, string> = {
	macos: "grid items-center gap-3.5 grid-cols-[28px_minmax(0,1fr)_92px_26px]",
	windows:
		"grid items-center gap-3.5 grid-cols-[28px_minmax(0,1fr)_96px_92px_26px]",
};

// scroll distance (px) over which the search field collapses into the magnifier.
const COLLAPSE = 64;

/** The per-row ⋯ menu: discrete actions, with rich editing delegated to the edit dialog. */
function RowMenu({
	row,
	platform,
	onEdit,
}: {
	row: ProjectRow;
	platform: Platform;
	onEdit: () => void;
}) {
	const setProjectColor = useSettingsStore((s) => s.setProjectColor);
	const setProjectEditorOverride = useSettingsStore(
		(s) => s.setProjectEditorOverride,
	);
	const setProjectPinned = useSettingsStore((s) => s.setProjectPinned);
	const setProjectExcluded = useSettingsStore((s) => s.setProjectExcluded);
	const removeFromRecents = useSettingsStore((s) => s.removeFromRecents);
	const removeExplicitProject = useSettingsStore(
		(s) => s.removeExplicitProject,
	);
	const forgetProject = useSettingsStore((s) => s.forgetProject);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Project actions"
					className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-row-hover hover:text-ink-body data-[state=open]:bg-row-hover data-[state=open]:text-ink-body"
				>
					<MoreHorizontal size={16} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={onEdit}>Edit details…</DropdownMenuItem>

				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Set color</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						{PROJECT_COLORS.map((c) => (
							<DropdownMenuItem
								key={c}
								onSelect={() => void setProjectColor(row.id, c)}
							>
								<span className="flex items-center gap-2">
									<span
										className={cn(
											"h-[11px] w-[11px] rounded-[3px]",
											SPINE_CLASS[c],
										)}
									/>
									<span className="capitalize">{c}</span>
								</span>
								<DropdownMenuCheck shown={row.color === c} />
							</DropdownMenuItem>
						))}
						<DropdownMenuItem
							onSelect={() => void setProjectColor(row.id, null)}
						>
							<span className="flex items-center gap-2">
								<span className="h-[11px] w-[11px] rounded-[3px] border border-white/20" />
								Unset
							</span>
							<DropdownMenuCheck shown={row.color === null} />
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>

				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Editor override</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuItem
							onSelect={() => void setProjectEditorOverride(row.id, null)}
						>
							Default
							<DropdownMenuCheck shown={row.editorOverride === null} />
						</DropdownMenuItem>
						{EDITOR_KINDS.map((k) => (
							<DropdownMenuItem
								key={k}
								onSelect={() =>
									void setProjectEditorOverride(row.id, k as EditorKind)
								}
							>
								{editorLabel(k)}
								<DropdownMenuCheck shown={row.editorOverride === k} />
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>

				<DropdownMenuSeparator />

				<DropdownMenuItem
					onSelect={() => void setProjectPinned(row.id, !row.pinned)}
				>
					{row.pinned ? "Unpin" : "Pin"}
					<Star
						size={13}
						className={cn(
							row.pinned
								? "fill-accent-orange text-accent-orange"
								: "text-ink-faint",
						)}
					/>
				</DropdownMenuItem>
				{row.recent && (
					<DropdownMenuItem onSelect={() => void removeFromRecents(row.id)}>
						Remove from Recents
					</DropdownMenuItem>
				)}

				{!row.missing && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void showInFileExplorer(row.id)}>
							{showInFileManagerLabel(platform)}
						</DropdownMenuItem>
						{row.githubUrl && (
							<DropdownMenuItem onSelect={() => void openGithubUrl(row.id)}>
								Open in GitHub
							</DropdownMenuItem>
						)}
					</>
				)}

				<DropdownMenuSeparator />
				{row.excluded ? (
					<DropdownMenuItem
						onSelect={() => void setProjectExcluded(row.id, false)}
					>
						Restore to Search
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem
						variant="danger"
						onSelect={() => void setProjectExcluded(row.id, true)}
					>
						Exclude from Search
					</DropdownMenuItem>
				)}
				{row.explicit && (
					<DropdownMenuItem
						variant="danger"
						onSelect={() => void removeExplicitProject(row.id)}
					>
						Remove Explicit Project
					</DropdownMenuItem>
				)}
				{row.missing && (
					<DropdownMenuItem
						variant="danger"
						onSelect={() => void forgetProject(row.id)}
					>
						Remove
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * One table row (display only; mutations go through the star and the ⋯ menu). Memoized with a
 * stable `now` and `onEdit` so unrelated state changes (opening a dialog, switching the active
 * editor) don't re-render the whole list. `striped` is passed by position rather than derived from
 * a CSS nth-child so dnd's injected announcer node can't throw off the zebra parity.
 */
const RowView = memo(function RowView({
	row,
	platform,
	now,
	striped,
	onEdit,
	dragRef,
	dragStyle,
	dragHandle,
}: {
	row: ProjectRow;
	platform: Platform;
	now: number;
	striped: boolean;
	onEdit: (row: ProjectRow) => void;
	dragRef?: (node: HTMLElement | null) => void;
	dragStyle?: React.CSSProperties;
	dragHandle?: React.HTMLAttributes<HTMLElement>;
}) {
	const setProjectPinned = useSettingsStore((s) => s.setProjectPinned);

	return (
		<div
			ref={dragRef}
			style={dragStyle}
			className={cn(
				GRID[platform],
				// full-bleed coloring: the stripe/hover fill the table width (padding sits inside the
				// background box) while the content stays inset from the border.
				"px-3 py-2.5",
				striped && "bg-row-alt",
				"hover:bg-row-hover",
				dragHandle && "cursor-grab active:cursor-grabbing",
			)}
			{...dragHandle}
		>
			{/* color spine (inset pill) + star. shrink-0 keeps the 3px bar from being crushed when
			    the column is tight. */}
			<div className="flex items-center gap-1.5">
				<span
					className={cn(
						"h-[18px] w-[3px] shrink-0 rounded-[2px]",
						row.color ? SPINE_CLASS[row.color] : "bg-transparent",
					)}
				/>
				<button
					type="button"
					aria-label={row.pinned ? "Unpin" : "Pin"}
					onClick={() => void setProjectPinned(row.id, !row.pinned)}
					className="flex items-center justify-center"
				>
					<Star
						size={15}
						className={cn(
							row.pinned
								? "fill-accent-orange text-accent-orange"
								: "text-ink-faint opacity-50 hover:opacity-100",
						)}
					/>
				</button>
			</div>

			{/* name + tags, path */}
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-[14px] font-medium text-ink">
						{row.displayName}
					</span>
					{row.tags.map((tag) => (
						<Badge
							key={tag}
							variant="ghost"
							className="flex-none rounded-badge bg-white/[0.06] px-1.5 py-[1px] text-[10.5px] font-normal text-ink-secondary"
						>
							{tag}
						</Badge>
					))}
				</div>
				<div className="truncate font-mono text-[11.5px] text-ink-tertiary">
					{row.path}
				</div>
			</div>

			{platform === "windows" ? <EnvBadge kind={row.kind} /> : null}

			<span className="truncate font-mono text-[11.5px] text-ink-tertiary">
				{formatRelativeTime(row.lastOpenedAt, now)}
			</span>

			<RowMenu row={row} platform={platform} onEdit={() => onEdit(row)} />
		</div>
	);
});

/** A drag-sortable wrapper around RowView, used only in the Pinned tab. */
function SortableRow({
	row,
	platform,
	now,
	striped,
	onEdit,
}: {
	row: ProjectRow;
	platform: Platform;
	now: number;
	striped: boolean;
	onEdit: (row: ProjectRow) => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: row.id });
	return (
		<RowView
			row={row}
			platform={platform}
			now={now}
			striped={striped}
			onEdit={onEdit}
			dragRef={setNodeRef}
			dragStyle={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.6 : undefined,
				zIndex: isDragging ? 10 : undefined,
			}}
			dragHandle={
				{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLElement>
			}
		/>
	);
}

/** A column header cell: clickable to sort (three-state), with an arrow on the active column. */
function SortHeader({
	label,
	col,
	sort,
	sortable,
	onSort,
}: {
	label: string;
	col: SortCol;
	sort: TableSort | null;
	sortable: boolean;
	onSort: (col: SortCol) => void;
}) {
	const active = sortable && sort?.col === col;
	return (
		<button
			type="button"
			onClick={() => onSort(col)}
			className={cn(
				"flex items-center gap-1 text-left uppercase outline-none transition-colors",
				active ? "text-ink-secondary" : "hover:text-ink-tertiary",
			)}
		>
			<span>{label}</span>
			{active &&
				(sort.dir === "asc" ? (
					<ArrowUp size={11} strokeWidth={2.5} />
				) : (
					<ArrowDown size={11} strokeWidth={2.5} />
				))}
		</button>
	);
}

export function Projects({
	scrollRef,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
}) {
	const settings = useSettingsStore((s) => s.settings);
	const index = useSettingsStore((s) => s.index);
	const setPinOrder = useSettingsStore((s) => s.setPinOrder);
	const platform = useSettingsStore((s) => s.platform);

	const [tab, setTab] = useState<ProjectTab>("active");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<TableSort | null>(null);
	const [editing, setEditing] = useState<ProjectRow | null>(null);
	const [adding, setAdding] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchH, setSearchH] = useState(54);
	const searchInnerRef = useRef<HTMLDivElement>(null);
	const searchFieldRef = useRef<HTMLInputElement>(null);

	// scroll-linked collapse: track the container's scrollTop into a motion value, then derive the
	// search field's height/opacity and the magnifier's opacity from it. a manual listener (rather
	// than useScroll) sidesteps the ancestor-ref-timing problem: this passive effect runs after the
	// parent's ref is attached, so scrollRef.current is always live here.
	const scrollY = useMotionValue(0);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => scrollY.set(el.scrollTop);
		onScroll();
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [scrollRef, scrollY]);
	useMotionValueEvent(scrollY, "change", (v) => {
		const next = v > COLLAPSE * 0.7;
		setCollapsed((prev) => (prev === next ? prev : next));
	});
	const searchHeight = useTransform(scrollY, [0, COLLAPSE], [searchH, 0]);
	const searchOpacity = useTransform(scrollY, [0, COLLAPSE * 0.7], [1, 0]);
	const magOpacity = useTransform(scrollY, [COLLAPSE * 0.55, COLLAPSE], [0, 1]);

	// re-stamped only when the index changes (a settings window is short-lived, so relative times
	// don't need to tick); keeping it stable lets RowView memoize across dialog open/close.
	// biome-ignore lint/correctness/useExhaustiveDependencies: index is an intentional re-stamp trigger, not a value the callback reads.
	const now = useMemo(() => Date.now(), [index]);

	const allRows = useMemo(
		() => (index && settings ? joinProjectRows(index, settings) : []),
		[index, settings],
	);
	const counts = useMemo(() => tabCounts(allRows), [allRows]);
	const tabRows = useMemo(() => rowsForTab(allRows, tab), [allRows, tab]);
	const visibleRows = useMemo(() => {
		const base = filterRows(tabRows, query);
		// a column sort overrides the tab's natural order everywhere except Pinned, which is always
		// the user's manual drag order.
		return sort && tab !== "pinned" ? sortRows(base, sort) : base;
	}, [tabRows, query, sort, tab]);

	const handleEdit = useCallback((r: ProjectRow) => setEditing(r), []);

	// measure the search field's natural height so the collapse animates to a real number, and keep
	// it synced if fonts/layout reflow.
	useLayoutEffect(() => {
		const el = searchInnerRef.current;
		if (!el) return;
		const update = () => setSearchH(el.offsetHeight);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	if (!settings || !index || !platform) return null;

	const columns = projectTableColumns(platform);

	const onDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		// reorder within the *full* pinned order, not just the visible rows: a pinned project
		// hidden from this tab (currently missing) is absent from visibleRows, so rebuilding the
		// order from those alone would drop its id from pinnedOrder and silently unpin it.
		const order = settings.pinnedOrder;
		const oldIndex = order.indexOf(String(active.id));
		const newIndex = order.indexOf(String(over.id));
		if (oldIndex < 0 || newIndex < 0) return;
		void setPinOrder(arrayMove(order, oldIndex, newIndex));
	};

	const onSort = (col: SortCol) => {
		// Pinned has one meaningful order (the manual one), so its headers don't sort; nudge the
		// user toward dragging instead.
		if (tab === "pinned") {
			toast("Pinned projects display in pinned order. Drag rows to reorder.", {
				duration: 2000,
			});
			return;
		}
		setSort((prev) => cycleSort(prev, col));
	};

	const draggable = tab === "pinned" && query.trim() === "";
	const queryActive = query.trim() !== "";
	const sortable = tab !== "pinned";

	return (
		<div className="flex flex-col p-[26px_30px]">
			<div className="mb-5 flex items-center justify-between">
				<div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
					Projects
				</div>
				<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
					<span className="text-[15px] leading-none">+</span>Add Explicit
					Project
				</Button>
			</div>

			{/* sticky chrome: the search collapses while the tabs + column header pin to the top.
			    opaque bg so rows scroll cleanly underneath; pt-3 keeps the tabs off the titlebar
			    once pinned. */}
			<div className="sticky top-0 z-20 bg-window pt-3">
				{/* while the floating search is open we freeze the field in its collapsed end-state:
				    narrowing the query can shrink the list below the scroll threshold (scrollTop snaps
				    to 0), and letting the chrome re-expand mid-type would yank the popover around. */}
				<motion.div
					style={
						searchOpen
							? { height: 0, opacity: 0 }
							: { height: searchHeight, opacity: searchOpacity }
					}
					className="overflow-hidden"
				>
					<div ref={searchInnerRef} className="pb-4">
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search projects by name, path, or tag…"
							className="h-auto w-full rounded-[8px] border-hairline bg-black/20 px-3 py-2 text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
						/>
					</div>
				</motion.div>

				{/* tab strip + the collapsed-search magnifier */}
				<div className="flex flex-wrap items-center gap-1 pb-3">
					{PROJECT_TABS.map((t) => {
						const active = t === tab;
						return (
							<button
								key={t}
								type="button"
								onClick={() => setTab(t)}
								className={cn(
									"flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] transition-colors",
									active
										? "bg-selection text-ink"
										: "text-ink-secondary hover:bg-row-hover hover:text-ink-body",
								)}
							>
								{TAB_LABEL[t]}
								<Badge
									variant="ghost"
									className={cn(
										"rounded-badge px-1.5 py-0 text-[11px] font-normal tabular-nums",
										t === "missing" && counts.missing > 0
											? "bg-warning-bg text-warning"
											: "bg-white/[0.06] text-ink-tertiary",
									)}
								>
									{counts[t]}
								</Badge>
							</button>
						);
					})}

					{/* the magnifier stays put (and interactive) for as long as the search is open, even
					    if the underlying list shrank back below the scroll threshold. */}
					<motion.div
						style={searchOpen ? { opacity: 1 } : { opacity: magOpacity }}
						className={cn(
							"ml-auto",
							collapsed || searchOpen ? "" : "pointer-events-none",
						)}
					>
						<Popover open={searchOpen} onOpenChange={setSearchOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									aria-label="Search projects"
									className={cn(
										"flex h-7 w-7 items-center justify-center rounded-[8px] transition-colors hover:bg-row-hover",
										queryActive
											? "text-accent-orange"
											: "text-ink-secondary hover:text-ink-body",
									)}
								>
									<span className="relative">
										<Search size={15} />
										{queryActive && (
											<span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent-orange" />
										)}
									</span>
								</button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								className="w-72"
								// move focus straight to the search field on open (the popover exists for it).
								onOpenAutoFocus={(e) => {
									e.preventDefault();
									searchFieldRef.current?.focus();
								}}
							>
								<div className="flex items-center gap-2 px-1">
									<Search size={14} className="shrink-0 text-ink-faint" />
									<input
										ref={searchFieldRef}
										value={query}
										onChange={(e) => setQuery(e.target.value)}
										onKeyDown={(e) => {
											// Enter commits the (still-live) filter and leaves the search.
											if (e.key === "Enter") {
												e.preventDefault();
												setSearchOpen(false);
											}
										}}
										placeholder="Search projects…"
										className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-body outline-none placeholder:text-ink-faint"
									/>
									{queryActive && (
										<button
											type="button"
											aria-label="Clear search"
											// X both clears the query and leaves the search (a clean "cancel").
											onClick={() => {
												setQuery("");
												setSearchOpen(false);
											}}
											className="shrink-0 rounded-[4px] p-0.5 text-ink-tertiary hover:bg-white/10 hover:text-ink"
										>
											<X size={13} strokeWidth={2.2} />
										</button>
									)}
								</div>
							</PopoverContent>
						</Popover>
					</motion.div>
				</div>

				{/* column header = the top edge of the bordered table. */}
				<div
					className={cn(
						GRID[platform],
						"rounded-t-[12px] border border-hairline bg-window px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint",
					)}
				>
					<span />
					{columns.map((column) => (
						<SortHeader
							key={column.col}
							label={column.label}
							col={column.col}
							sort={sort}
							sortable={sortable}
							onSort={onSort}
						/>
					))}
					<span />
				</div>
			</div>

			{/* rows: the sides + bottom of the bordered table (the header carries the top). */}
			<div className="overflow-hidden rounded-b-[12px] border-x border-b border-hairline">
				{visibleRows.length === 0 ? (
					<div className="px-3 py-8 text-center text-[13px] text-ink-tertiary">
						{query.trim()
							? "No projects match your search."
							: `No ${TAB_LABEL[tab].toLowerCase()} projects.`}
					</div>
				) : draggable ? (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={onDragEnd}
					>
						<SortableContext
							items={visibleRows.map((r) => r.id)}
							strategy={verticalListSortingStrategy}
						>
							{visibleRows.map((row, i) => (
								<SortableRow
									key={row.id}
									row={row}
									platform={platform}
									now={now}
									striped={i % 2 === 1}
									onEdit={handleEdit}
								/>
							))}
						</SortableContext>
					</DndContext>
				) : (
					visibleRows.map((row, i) => (
						<RowView
							key={row.id}
							row={row}
							platform={platform}
							now={now}
							striped={i % 2 === 1}
							onEdit={handleEdit}
						/>
					))
				)}
			</div>

			{/* rich edit dialog */}
			<Dialog
				open={editing !== null}
				onOpenChange={(open) => {
					if (!open) setEditing(null);
				}}
			>
				<DialogContent className="max-w-md gap-3.5 bg-elevated">
					{editing && (
						<ProjectEditForm
							key={editing.id}
							row={editing}
							onClose={() => setEditing(null)}
						/>
					)}
				</DialogContent>
			</Dialog>

			<AddExplicitDialog
				open={adding}
				platform={platform}
				onClose={() => setAdding(false)}
			/>
		</div>
	);
}
