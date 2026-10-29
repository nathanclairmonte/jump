// ui state for the launcher window. rust owns persistence; this store mirrors
// the index + settings for rendering and routes every mutation back through a command.
// the join + ranking live in pure modules under @/lib/search and are recomputed here as
// derived state whenever the index or settings change.

import { create } from "zustand";
import * as api from "@/lib/api";
import { type MenuLevel, menuRows } from "@/lib/search/action-menu";
import {
	type GridDirection,
	type GridGeom,
	navigateGrid,
} from "@/lib/search/grid-nav";
import { applyPin, type Candidate, joinCandidates } from "@/lib/search/join";

interface LauncherState {
	loading: boolean;
	loadError: string | null;
	// raw rust-owned documents, kept so either can be refreshed independently and rejoined.
	index: api.ProjectsIndex | null;
	settings: api.Settings | null;
	// the immutable host platform is fetched once for platform-aware launcher presentation.
	platform: api.Platform | null;
	// derived: index ∩ settings, recomputed on every index/settings change.
	candidates: Candidate[];
	query: string;
	selectedIndex: number;
	// the empty state's pinned grid is 2-D, so selection remembers a horizontal lane: it
	// survives the trip into recents and back, and a clamp into a ragged bottom row.
	gridColumn: number;
	// true between scan-started and scan-complete; drives the indexing indicator while the
	// cached list stays usable.
	isIndexing: boolean;
	// set when a launch fails: the launcher stays open and renders an inline error card
	// beneath the row it's keyed to. cleared on a new attempt, query change, or re-show.
	launchError: LaunchErrorState | null;
	// true while a launch (or an error-card fallback) is in flight, so the card can disable
	// its buttons and show the in-progress one instead of letting a second click stack.
	launchPending: boolean;
	// the open action menu (Tab / ⋯ on the selected row), or null. `level` is the drill
	// depth; `index` is the highlighted row within that level. keyed to a project id so a
	// background refresh that drops the row can close it.
	actionMenu: ActionMenuState | null;
	// true briefly after Copy path so the footer can confirm the silent clipboard write.
	justCopied: boolean;

	load: () => Promise<void>;
	refresh: () => Promise<void>;
	reloadIndex: () => Promise<void>;
	reloadSettings: () => Promise<void>;
	onShown: () => Promise<void>;
	setIndexing: (value: boolean) => void;
	setQuery: (query: string) => void;
	setSelectedIndex: (index: number) => void;
	moveSelection: (delta: number, count: number) => void;
	// 2-D arrow nav over the empty state's pinned grid + recents list.
	navigateEmpty: (dir: GridDirection, geom: GridGeom) => void;
	// hover/click selection in the empty state; pinned cards pass their column, recents omit it.
	selectEmpty: (index: number, column?: number) => void;
	togglePin: (id: string, pinned: boolean) => Promise<void>;
	reorderPins: (ids: string[]) => Promise<void>;
	launch: (id: string, editorOverride?: api.EditorKind) => Promise<void>;
	clearLaunchError: () => void;
	// action menu: open/close, keyboard nav, drill in/out, and activate the highlighted item.
	openActionMenu: (id: string) => void;
	closeActionMenu: () => void;
	moveActionMenu: (delta: number) => void;
	setActionIndex: (index: number) => void;
	drillInActionItem: () => void;
	actionMenuBack: () => void;
	enterActionItem: () => void;
	// mouse: highlight then activate in one go.
	activateActionIndex: (index: number) => void;
}

// the open action menu's model. `id` is the targeted project; `level` the drill depth.
export interface ActionMenuState {
	id: string;
	level: MenuLevel;
	index: number;
}

// the inline error card's model: which row it sits under, the rust LaunchError fields, plus
// the installed editors to offer as one-shot fallbacks (the failed editor excluded).
export interface LaunchErrorState extends api.LaunchError {
	id: string;
	fallbacks: api.EditorKind[];
}

export const useLauncherStore = create<LauncherState>((set, get) => {
	// recompute the joined candidates from whatever index + settings we currently hold.
	const rejoin = () => {
		const { index, settings, launchError, actionMenu } = get();
		if (index && settings) {
			const candidates = joinCandidates(index, settings);
			// a launch error / open menu is keyed to a row; if a background refresh dropped that
			// project from the list, the reference is stale, so clear it rather than leave a card
			// or menu pointing at a row that no longer renders.
			const patch: Partial<LauncherState> = { candidates };
			if (launchError && !candidates.some((c) => c.id === launchError.id)) {
				patch.launchError = null;
			}
			if (actionMenu && !candidates.some((c) => c.id === actionMenu.id)) {
				patch.actionMenu = null;
			}
			set(patch);
		}
	};

	// optimistic per-project override mutation: patch the local settings, rejoin so the row
	// updates immediately, fire the field-scoped command, and re-read the truth on failure.
	// mirrors `togglePin`'s pattern for the other action-menu metadata edits.
	const mutateOverride = async (
		id: string,
		patch: Partial<api.ProjectOverride>,
		fire: () => Promise<void>,
	) => {
		const cur = get().settings;
		if (!cur) return;
		const next = { ...cur.projectOverrides[id], ...patch };
		set({
			settings: {
				...cur,
				projectOverrides: { ...cur.projectOverrides, [id]: next },
			},
			launchError: null,
		});
		rejoin();
		try {
			await fire();
		} catch {
			await get().reloadSettings();
		}
	};

	// copies a path to the clipboard and flashes the footer confirmation (the write is
	// otherwise silent, per the no-toast rule).
	const copyPath = async (path: string) => {
		try {
			await navigator.clipboard.writeText(path);
		} catch {
			// clipboard can reject without focus / permission; skip the confirmation rather
			// than claim a copy that didn't happen.
			return;
		}
		set({ justCopied: true });
		setTimeout(() => {
			if (get().justCopied) set({ justCopied: false });
		}, 1400);
	};

	// the action menu can be driven before `load` resolves, so it needs a host to label rows
	// against; one owner for that default keeps the four menu call sites from restating it.
	const rowsFor = (c: Candidate, level: MenuLevel) =>
		menuRows(c, level, get().platform ?? "windows");

	// fetch both documents and rejoin, without toggling `loading` (so a background refresh
	// or a re-show doesn't flash a loading state over usable cached rows).
	const fetchBoth = async () => {
		const [index, settings] = await Promise.all([
			api.getIndex(),
			api.getSettings(),
		]);
		set({ index, settings });
		rejoin();
	};

	return {
		loading: true,
		loadError: null,
		index: null,
		settings: null,
		platform: null,
		candidates: [],
		query: "",
		selectedIndex: 0,
		gridColumn: 0,
		isIndexing: false,
		launchError: null,
		launchPending: false,
		actionMenu: null,
		justCopied: false,

		async load() {
			// catch so a rejected command doesn't strand the launcher on a blank loading state.
			set({ loading: true, loadError: null });
			try {
				// platform is immutable per process, so it rides the initial load only, not the
				// repeatable fetchBoth path (refresh / re-show).
				const [platform] = await Promise.all([api.getPlatform(), fetchBoth()]);
				set({ platform, loading: false });
			} catch (err) {
				set({ loading: false, loadError: String(err) });
			}
		},

		async refresh() {
			try {
				await fetchBoth();
			} catch {
				// keep the last-good candidates; a transient command failure shouldn't blank the
				// launcher.
			}
		},

		async reloadIndex() {
			try {
				set({ index: await api.getIndex() });
				rejoin();
			} catch {}
		},

		async reloadSettings() {
			try {
				set({ settings: await api.getSettings() });
				rejoin();
			} catch {}
		},

		async onShown() {
			// every open is a fresh start: query resets, selection returns to the top, any
			// stale launch error / open menu clears, and we re-read in case the index changed
			// while hidden.
			set({
				query: "",
				selectedIndex: 0,
				gridColumn: 0,
				launchError: null,
				actionMenu: null,
				justCopied: false,
			});
			await get().refresh();
		},

		setIndexing(value) {
			set({ isIndexing: value });
		},

		setQuery(query) {
			// selection always resets to the top result as the query changes; a stale launch
			// error from a different row clears as the list changes underneath it. the grid lane
			// resets too so returning to the empty state starts from the first card. (typing is
			// disabled while the menu is open, but close it defensively.)
			set({
				query,
				selectedIndex: 0,
				gridColumn: 0,
				launchError: null,
				actionMenu: null,
			});
		},

		setSelectedIndex(index) {
			set({ selectedIndex: index });
		},

		moveSelection(delta, count) {
			if (count <= 0) return;
			const next = Math.max(
				0,
				Math.min(count - 1, get().selectedIndex + delta),
			);
			set({ selectedIndex: next });
		},

		navigateEmpty(dir, geom) {
			const { selectedIndex, gridColumn } = get();
			const next = navigateGrid(
				{ index: selectedIndex, column: gridColumn },
				dir,
				geom,
			);
			set({ selectedIndex: next.index, gridColumn: next.column });
		},

		selectEmpty(index, column) {
			// a pinned card hover refreshes the lane so keyboard nav resumes from it; a recent
			// hover leaves the lane untouched (the 1-D list has no column).
			set({ selectedIndex: index, gridColumn: column ?? get().gridColumn });
		},

		async togglePin(id, pinned) {
			const current = get().settings;
			if (!current) return;
			// optimistic: pinning appends, unpinning removes, then rejoin so the row updates
			// immediately. the command persists and echoes settings-changed, which reconciles.
			const order = applyPin(current.pinnedOrder, id, pinned);
			// restructuring the list invalidates a stale launch error keyed to a moved row.
			set({ settings: { ...current, pinnedOrder: order }, launchError: null });
			rejoin();
			try {
				await api.setPinned(id, pinned);
			} catch {
				// the write never landed; re-read the truth rather than keep an optimistic lie.
				await get().reloadSettings();
			}
		},

		async reorderPins(ids) {
			const current = get().settings;
			if (!current) return;
			set({ settings: { ...current, pinnedOrder: ids }, launchError: null });
			rejoin();
			try {
				await api.setPinOrder(ids);
			} catch {
				await get().reloadSettings();
			}
		},

		async launch(id, editorOverride) {
			// the real launch: rust resolves editor + environment, spawns, and records
			// the open *only* on a confirmed success. on success we hide; on failure we stay
			// open and surface the structured error inline (the launcher never silently
			// switches editors). `editorOverride` is the error card's one-shot fallback.
			set({ launchPending: true });
			try {
				await api.launchProject(id, editorOverride);
				set({ launchError: null, launchPending: false });
				await api.dismissLauncher();
			} catch (err) {
				const base = toLaunchError(id, err);
				// offer only editors detection says are installed, never the one that just
				// failed, so a fallback can't dead-end on the same missing editor.
				let fallbacks: api.EditorKind[] = [];
				try {
					const detections = await api.detectEditors();
					fallbacks = detections
						.filter((d) => d.detected && d.kind !== base.editor)
						.map((d) => d.kind);
				} catch {}
				set({ launchError: { ...base, fallbacks }, launchPending: false });
			}
		},

		clearLaunchError() {
			set({ launchError: null });
		},

		openActionMenu(id) {
			// opening dims the list; clear any inline error so the dim isn't fighting a card.
			set({ actionMenu: { id, level: "root", index: 0 }, launchError: null });
		},

		closeActionMenu() {
			set({ actionMenu: null });
		},

		moveActionMenu(delta) {
			const { actionMenu, candidates } = get();
			if (!actionMenu) return;
			const c = candidates.find((x) => x.id === actionMenu.id);
			if (!c) {
				set({ actionMenu: null });
				return;
			}
			const len = rowsFor(c, actionMenu.level).length;
			if (len === 0) return;
			const index = Math.max(0, Math.min(len - 1, actionMenu.index + delta));
			set({ actionMenu: { ...actionMenu, index } });
		},

		setActionIndex(index) {
			const { actionMenu } = get();
			if (actionMenu) set({ actionMenu: { ...actionMenu, index } });
		},

		drillInActionItem() {
			// right-arrow: drill into a submenu opener, but never activate a leaf.
			const { actionMenu, candidates } = get();
			if (!actionMenu) return;
			const c = candidates.find((x) => x.id === actionMenu.id);
			if (!c) return;
			const row = rowsFor(c, actionMenu.level)[actionMenu.index];
			if (row?.opensSubmenu) {
				set({
					actionMenu: { ...actionMenu, level: row.opensSubmenu, index: 0 },
				});
			}
		},

		actionMenuBack() {
			// pop a submenu back to root, landing on the opener it drilled from.
			const { actionMenu, candidates } = get();
			if (!actionMenu || actionMenu.level === "root") return;
			const c = candidates.find((x) => x.id === actionMenu.id);
			const parent = c
				? rowsFor(c, "root").findIndex(
						(r) => r.opensSubmenu === actionMenu.level,
					)
				: -1;
			set({
				actionMenu: {
					...actionMenu,
					level: "root",
					index: parent >= 0 ? parent : 0,
				},
			});
		},

		enterActionItem() {
			const { actionMenu, candidates } = get();
			if (!actionMenu) return;
			const c = candidates.find((x) => x.id === actionMenu.id);
			if (!c) {
				set({ actionMenu: null });
				return;
			}
			const row = rowsFor(c, actionMenu.level)[actionMenu.index];
			if (!row) return;
			// a submenu opener drills in rather than acting.
			if (row.opensSubmenu) {
				set({
					actionMenu: { ...actionMenu, level: row.opensSubmenu, index: 0 },
				});
				return;
			}

			const id = c.id;
			const editor = row.editor ?? null;
			const color = row.color ?? null;
			// every leaf action closes the menu; the only non-closing path (a submenu opener)
			// already returned above.
			set({ actionMenu: null });
			switch (row.kind) {
				// launch actions: close the menu so success hides and a failure's error card is
				// visible beneath the row.
				case "open":
					void get().launch(id);
					break;
				case "pickOpenWith":
					void get().launch(id, row.editor);
					break;
				// metadata mutations: run optimistically, close the menu, keep the launcher open.
				case "pin":
					void get().togglePin(id, !c.pinned);
					break;
				case "pickEditor":
					void mutateOverride(id, { editorOverride: editor }, () =>
						api.setProjectEditorOverride(id, editor),
					);
					break;
				case "clearEditor":
					void mutateOverride(id, { editorOverride: null }, () =>
						api.setProjectEditorOverride(id, null),
					);
					break;
				case "pickColor":
					void mutateOverride(id, { color }, () =>
						api.setProjectColor(id, color),
					);
					break;
				case "exclude":
					void mutateOverride(id, { excluded: true }, () =>
						api.setProjectExcluded(id, true),
					);
					break;
				case "removeRecent": {
					const cur = get().settings;
					if (cur) {
						set({
							settings: {
								...cur,
								recents: cur.recents.filter((r) => r.id !== id),
							},
						});
						rejoin();
						api.removeFromRecents(id).catch(() => void get().reloadSettings());
					}
					break;
				}
				case "copyPath":
					void copyPath(c.path);
					break;
				// let the OS accept the external open before hiding Jump so app activation cannot race
				// focus restoration.
				case "openGithub":
					void openExternalAndDismiss(() => api.openGithubUrl(id));
					break;
				case "showInExplorer":
					void openExternalAndDismiss(() => api.showInFileExplorer(id));
					break;
				default:
					break;
			}
		},

		activateActionIndex(index) {
			const { actionMenu } = get();
			if (!actionMenu) return;
			set({ actionMenu: { ...actionMenu, index } });
			get().enterActionItem();
		},
	};
});

async function openExternalAndDismiss(open: () => Promise<void>) {
	try {
		await open();
	} catch {
		return;
	}
	await api.dismissLauncher();
}

// normalizes whatever a rejected launch_project throws into the card's base fields (fallbacks
// are filled in by the caller from live detection). the rust Err is a structured LaunchError;
// anything else (a transport failure) degrades to a generic spawn error so the card still
// renders something useful.
function toLaunchError(
	id: string,
	err: unknown,
): Omit<LaunchErrorState, "fallbacks"> {
	if (err && typeof err === "object" && "message" in err) {
		const e = err as Partial<api.LaunchError>;
		return {
			id,
			kind: e.kind ?? "spawnFailed",
			message: e.message ?? "Launch failed",
			detail: e.detail ?? "",
			editor: e.editor ?? null,
		};
	}
	return {
		id,
		kind: "spawnFailed",
		message: "Launch failed",
		detail: String(err),
		editor: null,
	};
}
