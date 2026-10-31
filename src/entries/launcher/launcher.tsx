import { ChevronUp, Search } from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AppMark } from "@/components/brand/app-mark";
import { Keycap } from "@/components/keycap";
import * as api from "@/lib/api";
import { isLocationKindSupported } from "@/lib/platform-labels";
import { computeDisambiguation } from "@/lib/search/disambiguate";
import { GRID_COLS } from "@/lib/search/grid-nav";
import {
	pinnedCandidates,
	recentCandidates,
	searchable,
} from "@/lib/search/join";
import { rank } from "@/lib/search/rank";
import { cn } from "@/lib/utils";
import { ActionMenu } from "./components/action-menu";
import { EmptyState } from "./components/empty-state";
import { IndexingPill, IndexingShimmer } from "./components/indexing-pill";
import { LaunchErrorCard } from "./components/launch-error-card";
import { NoSearchLocations } from "./components/no-search-locations";
import { Results } from "./components/results";
import { ZeroResults } from "./components/zero-results";
import { useLauncherStore } from "./store";
import { useLauncherAutosize } from "./use-launcher-autosize";
import { useLauncherData } from "./use-launcher-data";
import { useLauncherWindow } from "./use-launcher-window";

// how far the search results must scroll before the back-to-top button appears (roughly one
// row past the top), so a tiny scroll doesn't flash it in and out.
const BACK_TO_TOP_SCROLL = 96;

export function Launcher() {
	const inputRef = useLauncherWindow();
	const { frameRef, panelRef } = useLauncherAutosize();
	useLauncherData();

	const candidates = useLauncherStore((s) => s.candidates);
	const settings = useLauncherStore((s) => s.settings);
	const platform = useLauncherStore((s) => s.platform);
	const loadError = useLauncherStore((s) => s.loadError);
	const load = useLauncherStore((s) => s.load);
	const query = useLauncherStore((s) => s.query);
	const selectedIndex = useLauncherStore((s) => s.selectedIndex);
	const isIndexing = useLauncherStore((s) => s.isIndexing);
	const setQuery = useLauncherStore((s) => s.setQuery);
	const setSelectedIndex = useLauncherStore((s) => s.setSelectedIndex);
	const moveSelection = useLauncherStore((s) => s.moveSelection);
	const navigateEmpty = useLauncherStore((s) => s.navigateEmpty);
	const selectEmpty = useLauncherStore((s) => s.selectEmpty);
	const togglePin = useLauncherStore((s) => s.togglePin);
	const reorderPins = useLauncherStore((s) => s.reorderPins);
	const launch = useLauncherStore((s) => s.launch);
	const launchError = useLauncherStore((s) => s.launchError);
	const launchPending = useLauncherStore((s) => s.launchPending);
	const actionMenu = useLauncherStore((s) => s.actionMenu);
	const justCopied = useLauncherStore((s) => s.justCopied);
	const openActionMenu = useLauncherStore((s) => s.openActionMenu);
	const closeActionMenu = useLauncherStore((s) => s.closeActionMenu);
	const moveActionMenu = useLauncherStore((s) => s.moveActionMenu);
	const setActionIndex = useLauncherStore((s) => s.setActionIndex);
	const drillInActionItem = useLauncherStore((s) => s.drillInActionItem);
	const actionMenuBack = useLauncherStore((s) => s.actionMenuBack);
	const pressActionHotkey = useLauncherStore((s) => s.pressActionHotkey);
	const enterActionItem = useLauncherStore((s) => s.enterActionItem);
	const activateActionIndex = useLauncherStore((s) => s.activateActionIndex);

	const q = query.trim();
	const searching = q !== "";

	const pinned = useMemo(() => pinnedCandidates(candidates), [candidates]);
	const recent = useMemo(() => recentCandidates(candidates), [candidates]);
	const results = useMemo(
		() =>
			searching && platform
				? rank(searchable(candidates), query, Date.now(), platform)
				: [],
		[candidates, query, searching, platform],
	);
	const labels = useMemo(
		() =>
			computeDisambiguation(
				results.map((r) => ({
					id: r.candidate.id,
					displayName: r.candidate.displayName,
					path: r.candidate.path,
				})),
			),
		[results],
	);

	// the flat nav list backing keyboard selection: Pinned then Recent in the empty state,
	// otherwise the ranked results.
	const visibleIds = searching
		? results.map((r) => r.candidate.id)
		: [...pinned, ...recent].map((c) => c.id);
	const count = visibleIds.length;
	const effectiveIndex = count > 0 ? Math.min(selectedIndex, count - 1) : 0;

	// the scrollable results region; keyboard nav and the back-to-top control both drive it.
	const scrollRef = useRef<HTMLDivElement>(null);
	const [backToTopVisible, setBackToTopVisible] = useState(false);

	// keyboard and mouse both move the selection, so this marks which input is in charge.
	// while keyboard-driven, selection changes auto-scroll into view and hover is ignored (so
	// the list scrolling under a still cursor can't hijack the selection); a genuine pointer
	// move hands control back to the mouse.
	const keyboardNavRef = useRef(false);
	const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		const onPointerMove = (event: PointerEvent) => {
			// a programmatic scroll under a still cursor fires a synthetic move at the same
			// coords; only a move to *different* coords than a known previous point counts as real
			// and hands control back to hover. the first move of a session (last === null) has
			// nothing to compare against, so it seeds the position without releasing keyboard nav,
			// keeping the synthetic move right after an open-and-arrow from hijacking the selection.
			const last = lastPointerRef.current;
			const moved =
				!!last && (last.x !== event.clientX || last.y !== event.clientY);
			lastPointerRef.current = { x: event.clientX, y: event.clientY };
			if (moved) keyboardNavRef.current = false;
		};
		window.addEventListener("pointermove", onPointerMove);
		return () => window.removeEventListener("pointermove", onPointerMove);
	}, []);

	// every reveal is a fresh start (rust re-focuses, the store resets selection): clear the
	// keyboard-nav latch and stale pointer position so a cursor already resting over a row can
	// hover-select right away, instead of staying inert until the mouse is jogged.
	useEffect(() => {
		const off = api.onEvent(api.EVENT_LAUNCHER_SHOWN, () => {
			keyboardNavRef.current = false;
			lastPointerRef.current = null;
		});
		return () => void off.then((unlisten) => unlisten());
	}, []);

	// keep the selected row in view as arrow keys walk past the visible edge. only follows
	// keyboard nav (mouse hover selecting a clipped row must not yank the list). block:"nearest"
	// scrolls only when the row is actually clipped, so a visible selection never jumps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: effectiveIndex + searching are intentional re-scroll triggers (they move which row is selected); they aren't read in the body.
	useLayoutEffect(() => {
		if (!keyboardNavRef.current) return;
		// the selected row carries data-action-anchor (also used to anchor the action menu).
		const el = scrollRef.current?.querySelector<HTMLElement>(
			"[data-action-anchor]",
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [effectiveIndex, searching]);

	// hover selection, gated so it's inert while keyboard nav owns the selection. the row
	// components fire these on mouseenter; suppressing them keeps a row sliding under a still
	// cursor (as the list scrolls) from stealing the keyboard's place.
	const hoverSelectEmpty = (index: number, column?: number) => {
		if (keyboardNavRef.current) return;
		selectEmpty(index, column);
	};
	const hoverSelectResult = (index: number) => {
		if (keyboardNavRef.current) return;
		setSelectedIndex(index);
	};

	// the back-to-top button surfaces once the list has scrolled away from the top. recomputed
	// on scroll and whenever the list's shape changes underneath it.
	const syncBackToTop = useCallback(() => {
		const container = scrollRef.current;
		if (!container || actionMenu) {
			setBackToTopVisible(false);
			return;
		}
		// search results have no pinned anchor, so fall back to a plain scroll distance; the
		// empty state waits until the pinned section is fully out of view.
		if (searching) {
			setBackToTopVisible(container.scrollTop > BACK_TO_TOP_SCROLL);
			return;
		}
		const marker = container.querySelector<HTMLElement>("[data-pinned-end]");
		setBackToTopVisible(
			!!marker &&
				marker.getBoundingClientRect().bottom <=
					container.getBoundingClientRect().top,
		);
	}, [searching, actionMenu]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: these are intentional re-check triggers (each changes the scroll content's height without firing a scroll event: pinned/recent counts, a swapped result set, an inline error card); none are read in the body.
	useEffect(() => {
		syncBackToTop();
	}, [syncBackToTop, pinned.length, recent.length, results, launchError]);

	// the scroll handler reads layout (getBoundingClientRect), so coalesce a burst of scroll
	// events into one recompute per frame rather than forcing a reflow on every event.
	const scrollFrameRef = useRef<number | null>(null);
	const onScroll = useCallback(() => {
		if (scrollFrameRef.current != null) return;
		scrollFrameRef.current = requestAnimationFrame(() => {
			scrollFrameRef.current = null;
			syncBackToTop();
		});
	}, [syncBackToTop]);
	useEffect(
		() => () => {
			if (scrollFrameRef.current != null)
				cancelAnimationFrame(scrollFrameRef.current);
		},
		[],
	);

	// shared by the button and Cmd/Ctrl+ArrowUp: jump straight to the top. scrolls imperatively
	// so it works even when selection never moved (e.g. after a mouse-wheel scroll), and resets
	// selection so the next ArrowDown doesn't immediately yank the view back down. the keyboard
	// shortcut keeps the keyboard-nav latch set; a button click stays mouse-driven so hover keeps
	// working afterward without needing a pointer jog.
	const jumpToTop = (viaKeyboard: boolean) => {
		keyboardNavRef.current = viaKeyboard;
		scrollRef.current?.scrollTo({ top: 0 });
		selectEmpty(0, 0);
	};

	const launchSelected = () => {
		const id = visibleIds[effectiveIndex];
		if (id) void launch(id);
	};

	// the project the open menu targets (null when closed or its row was dropped by a refresh).
	const menuCandidate = actionMenu
		? (candidates.find((c) => c.id === actionMenu.id) ?? null)
		: null;

	// renders the inline error card beneath the row it failed on, in whichever list is
	// showing. each Open-with button is a one-shot launch into an installed editor that never
	// rewrites the saved editor; Editor Settings deep-links to the Editors section.
	const renderRowError = (id: string) =>
		launchError?.id === id ? (
			<LaunchErrorCard
				error={launchError}
				pending={launchPending}
				onOpenWith={(editor) => void launch(id, editor)}
				onEditorSettings={() => void api.openSettings("editors")}
			/>
		) : null;

	// the empty state's pinned grid + recents geometry, for 2-D arrow nav.
	const geom = {
		pinned: pinned.length,
		recent: recent.length,
		cols: GRID_COLS,
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// while the action menu is open it owns arrows / Enter / Tab; Esc is handled by the
		// window-level ladder (use-launcher-window), which steps submenu -> root -> close.
		if (actionMenu) {
			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					moveActionMenu(1);
					break;
				case "ArrowUp":
					event.preventDefault();
					moveActionMenu(-1);
					break;
				case "ArrowRight":
					event.preventDefault();
					drillInActionItem();
					break;
				case "ArrowLeft":
					event.preventDefault();
					actionMenuBack();
					break;
				case "Enter":
					event.preventDefault();
					enterActionItem();
					break;
				case "Tab":
					event.preventDefault();
					closeActionMenu();
					break;
				default:
					if (
						!event.metaKey &&
						!event.ctrlKey &&
						!event.altKey &&
						event.key.length === 1 &&
						pressActionHotkey(event.key)
					) {
						event.preventDefault();
					}
					break;
			}
			return;
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				keyboardNavRef.current = true;
				if (searching) moveSelection(1, count);
				else navigateEmpty("down", geom);
				break;
			case "ArrowUp":
				event.preventDefault();
				keyboardNavRef.current = true;
				// Ctrl+ArrowUp jumps to the top of the list, mirroring the back-to-top button
				// whether or not it's currently visible.
				if (event.metaKey || event.ctrlKey) {
					jumpToTop(true);
				} else if (searching) {
					moveSelection(-1, count);
				} else {
					navigateEmpty("up", geom);
				}
				break;
			case "ArrowLeft":
				// only hijack left/right for grid nav in the empty state; while searching they
				// move the text caret as usual.
				if (!searching) {
					event.preventDefault();
					keyboardNavRef.current = true;
					navigateEmpty("left", geom);
				}
				break;
			case "ArrowRight":
				if (!searching) {
					event.preventDefault();
					keyboardNavRef.current = true;
					navigateEmpty("right", geom);
				}
				break;
			case "Enter":
				event.preventDefault();
				launchSelected();
				break;
			case "Tab":
				// Tab opens the action menu on the selected row.
				event.preventDefault();
				{
					const id = visibleIds[effectiveIndex];
					if (id) openActionMenu(id);
				}
				break;
			default:
				break;
		}
	};

	// clicking the transparent gutter dismisses, matching the focus-loss hide rust owns.
	const dismissOnBackdrop = (event: MouseEvent) => {
		if (event.target === event.currentTarget) void api.dismissLauncher();
	};

	const hasSearchLocations = (settings?.searchLocations.length ?? 0) > 0;
	const hasUsableSearchLocation =
		!!platform &&
		settings?.searchLocations.some((location) =>
			isLocationKindSupported(platform, location.kind),
		);
	const needsSearchLocation =
		!!settings && !hasUsableSearchLocation && candidates.length === 0;

	// early returns keep the mutually exclusive body states from becoming a ternary chain.
	const renderBody = () => {
		// gating the whole component here instead would withhold the frame and panel refs on
		// the first commit, and the autosize effect only ever looks for them once.
		if (loadError) {
			return (
				<div className="flex flex-col items-center px-7 py-11 text-center">
					<div className="text-[15px] font-medium text-ink-body">
						Could not load Jump
					</div>
					<div className="mt-1.5 max-w-96 break-words font-mono text-[11.5px] leading-relaxed text-ink-tertiary">
						{loadError}
					</div>
					<button
						type="button"
						onClick={() => void load()}
						className="mt-4 rounded-button border border-hairline bg-white/[0.03] px-3 py-1.75 text-[12.5px] text-ink-body hover:bg-row-hover"
					>
						Retry
					</button>
				</div>
			);
		}
		if (!platform) return null;
		if (needsSearchLocation) {
			return (
				<NoSearchLocations
					foreignOnly={hasSearchLocations}
					onOpenSettings={() => void api.openSettings("searchLocations")}
					onAddLocation={() =>
						void api.openSettings("searchLocations:addLocation")
					}
				/>
			);
		}
		if (!searching) {
			return (
				<EmptyState
					pinned={pinned}
					platform={platform}
					recent={recent}
					selectedIndex={effectiveIndex}
					onSelect={hoverSelectEmpty}
					onLaunch={(id) => void launch(id)}
					onTogglePin={(id, pinned) => void togglePin(id, !pinned)}
					onOpenMenu={openActionMenu}
					onReorder={(ids) => void reorderPins(ids)}
					renderAfter={renderRowError}
				/>
			);
		}
		if (results.length === 0) {
			return (
				<ZeroResults
					query={q}
					onRescan={() => void api.rescan()}
					onAddProject={() => void api.openSettings("projects")}
				/>
			);
		}
		return (
			<Results
				rows={results}
				platform={platform}
				selectedIndex={effectiveIndex}
				labels={labels}
				onSelectIndex={hoverSelectResult}
				onLaunch={(id) => void launch(id)}
				onTogglePin={(id, pinned) => void togglePin(id, !pinned)}
				onOpenMenu={openActionMenu}
				renderAfter={renderRowError}
			/>
		);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a dismiss target, not a control; Esc handles keyboard dismiss
		<div
			onMouseDown={dismissOnBackdrop}
			className="flex h-screen w-screen items-start justify-center pt-2"
		>
			{/* frame: wraps the panel and the action menu and is what the window sizes to. it
			    isn't clipped, so a menu taller than a short result list can hang below the panel
			    instead of being cut off, while the panel keeps hugging its rows. */}
			<div ref={frameRef} className="relative w-150">
				<div
					ref={panelRef}
					className="relative flex w-full flex-col overflow-hidden rounded-panel border border-hairline bg-panel shadow-panel backdrop-blur-xl"
				>
					{/* search header */}
					<div className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-4.5">
						<Search
							size={18}
							strokeWidth={2}
							className={cn(
								"shrink-0",
								searching ? "text-ink-secondary" : "text-ink-faint",
							)}
						/>
						<input
							ref={inputRef}
							type="text"
							aria-label="Search projects"
							placeholder="Search projects…"
							spellCheck={false}
							autoComplete="off"
							value={query}
							// typing is suspended while the menu owns the keyboard.
							readOnly={!!actionMenu}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={onKeyDown}
							className="flex-1 bg-transparent text-[17px] text-ink caret-accent-orange outline-none placeholder:text-ink-faint"
						/>
						{isIndexing ? (
							<IndexingPill />
						) : searching ? (
							<span className="flex-none font-mono text-[10.5px] text-ink-tertiary">
								{results.length} result{results.length === 1 ? "" : "s"}
							</span>
						) : (
							<Keycap>esc</Keycap>
						)}
					</div>
					{isIndexing ? <IndexingShimmer /> : null}

					{/* body: the only growable region, so a long list scrolls here once the window
				    hits its on-screen cap while the header and footer stay pinned. dims behind an
				    open action menu. */}
					<div className="relative flex min-h-0 flex-1 flex-col">
						<div
							ref={scrollRef}
							onScroll={onScroll}
							className={cn(
								"min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
								actionMenu && "pointer-events-none opacity-45",
							)}
						>
							{renderBody()}
						</div>

						{/* floats at the body's top-right once the list scrolls away from the top.
						    tabIndex -1 + onMouseDown keep focus on the search input so keyboard nav
						    still works after a click. the keycaps double as a reminder of the
						    Ctrl+ArrowUp shortcut that does the same thing. */}
						<button
							type="button"
							tabIndex={-1}
							aria-label="Back to top"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => jumpToTop(false)}
							className={cn(
								"absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-hairline bg-panel py-1 pr-1.5 pl-2.5 text-[11px] text-ink-secondary shadow-panel backdrop-blur-xl transition-opacity duration-150",
								backToTopVisible
									? "opacity-100"
									: "pointer-events-none opacity-0",
							)}
						>
							<ChevronUp size={13} strokeWidth={2.5} />
							Back to top
							<span className="flex items-center gap-0.5">
								<Keycap>{platform === "macos" ? "⌘" : "Ctrl"}</Keycap>
								<Keycap>↑</Keycap>
							</span>
						</button>
					</div>

					{/* footer */}
					<div className="flex shrink-0 items-center justify-between border-t border-hairline bg-[rgba(255,255,255,0.012)] px-4 py-2.75">
						<div className="flex items-center gap-2">
							<AppMark size={18} />
							<span className="font-semibold text-[12.5px] tracking-tight text-[#a8a6a1]">
								jump
							</span>
						</div>
						{launchError ? (
							<span className="text-[11.5px] text-ink-tertiary">
								Pick a fallback above. Your editor setting is unchanged.
							</span>
						) : actionMenu ? (
							<div className="flex items-center gap-3 text-[11px] text-ink-faint">
								<span className="flex items-center gap-1">
									<Keycap>↑</Keycap>
									<Keycap>↓</Keycap>
									navigate
								</span>
								<span className="flex items-center gap-1">
									<Keycap>↵</Keycap>
									select
								</span>
								<span className="flex items-center gap-1">
									<Keycap>esc</Keycap>
									{actionMenu.level === "root" ? "close" : "back"}
								</span>
							</div>
						) : justCopied ? (
							<span className="text-[11.5px] text-ink-tertiary">
								Copied path
							</span>
						) : isIndexing ? (
							<span className="text-[11.5px] text-ink-tertiary">
								Showing cached results, refreshing in the background.
							</span>
						) : (
							<div className="flex items-center gap-3 text-[11px] text-ink-faint">
								{searching ? (
									<span className="flex items-center gap-1">
										<Keycap>↑</Keycap>
										<Keycap>↓</Keycap>
										move
									</span>
								) : (
									<span className="flex items-center gap-1">
										<Keycap>tab</Keycap>
										actions
									</span>
								)}
								<span className="flex items-center gap-1">
									<Keycap>↵</Keycap>
									open
								</span>
							</div>
						)}
					</div>
				</div>

				{/* the floating action menu, a sibling of the panel (not a child) so the panel's
				    overflow-hidden can't clip it. anchored to the selected row, overlaying the
				    dimmed body, and able to hang below a short panel. only renders when a menu is
				    open against a still-present row. */}
				{actionMenu && menuCandidate && platform ? (
					<ActionMenu
						candidate={menuCandidate}
						platform={platform}
						menu={actionMenu}
						frameRef={frameRef}
						panelRef={panelRef}
						onHover={setActionIndex}
						onActivate={activateActionIndex}
						onBack={actionMenuBack}
						onClose={closeActionMenu}
					/>
				) : null}
			</div>
		</div>
	);
}
