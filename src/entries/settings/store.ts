// ui state for the settings window. the rust side owns persistence; this store mirrors
// it for rendering and routes every mutation back through a command. mutations that
// change discovery (locations, nested toggle) auto-rescan.

import { create } from "zustand";
import * as api from "@/lib/api";

// single source for the known sections; the union type is derived so the two can't drift.
const SECTIONS = [
	"general",
	"searchLocations",
	"projects",
	"editors",
	"shortcuts",
] as const;
const ACTION_TARGETS = ["searchLocations:addLocation"] as const;

export type SettingsSection = (typeof SECTIONS)[number];
type SettingsActionTarget = (typeof ACTION_TARGETS)[number];
export type SettingsAction =
	SettingsActionTarget extends `${string}:${infer Action}` ? Action : never;

export interface SettingsTarget {
	section: SettingsSection;
	action: SettingsAction | null;
}

/** Narrows an arbitrary string (URL hash / deep-link event) to a known section. */
function asSection(value: string): SettingsSection | null {
	return (SECTIONS as readonly string[]).includes(value)
		? (value as SettingsSection)
		: null;
}

/** Parses a section deep-link plus its optional one-shot action. */
export function asTarget(value: string): SettingsTarget | null {
	const [sectionValue, actionValue] = value.split(":", 2);
	const section = asSection(sectionValue);
	if (!section) return null;
	if (actionValue == null) return { section, action: null };
	if (!(ACTION_TARGETS as readonly string[]).includes(value)) return null;
	return { section, action: actionValue as SettingsAction };
}

// a deep-link (e.g. the launcher's "Add Project") opens a fresh window with the section
// in the URL hash, read here before first paint so there's no wrong-panel flash.
function initialTarget(): SettingsTarget {
	const hash = window.location.hash.replace(/^#/, "");
	return asTarget(hash) ?? { section: "searchLocations", action: null };
}

// Rust puts the immutable host platform in the URL so window chrome is correct on first paint
// and remains available even when loading unrelated settings data fails.
function initialPlatform(): api.Platform | null {
	const value = new URLSearchParams(window.location.search).get("platform");
	return value === "windows" || value === "macos" ? value : null;
}

interface SettingsState {
	loading: boolean;
	loadError: string | null;
	section: SettingsSection;
	action: SettingsAction | null;
	settings: api.Settings | null;
	// the generated index, needed by the Projects table (joined with settings client-side).
	index: api.ProjectsIndex | null;
	rows: api.SearchLocationRow[];
	distros: api.DistroDto[];
	configDir: string;
	// the immutable host platform controls native versus HTML window chrome.
	platform: api.Platform | null;

	navigate: (target: SettingsTarget) => void;
	clearAction: () => void;
	load: () => Promise<void>;
	refreshRows: () => Promise<void>;
	refreshIndex: () => Promise<void>;
	reloadSettings: () => Promise<void>;
	setNested: (value: boolean) => Promise<void>;
	setDefaultDepth: (value: number) => Promise<void>;
	setLaunchAtStartup: (value: boolean) => Promise<void>;
	setRescanOnStartup: (value: boolean) => Promise<void>;
	rebuildIndex: () => Promise<void>;
	setDefaultEditor: (editor: api.EditorKind) => Promise<void>;
	setEditorCommand: (
		editor: api.EditorKind,
		command: string | null,
	) => Promise<void>;
	addOrUpdateLocation: (
		next: api.SearchLocation,
		replaceId?: string,
	) => Promise<void>;
	grantLocationAccess: (id: string) => Promise<void>;
	removeLocation: (id: string) => Promise<void>;
	rescan: () => Promise<void>;

	// Projects-table mutations. the optimistic-override edits patch local settings,
	// then fire the field-scoped command and reconcile via settings-changed (matching the
	// launcher store). explicit add/remove + forget land via the scan/settings events.
	setProjectAlias: (id: string, alias: string | null) => Promise<void>;
	setProjectTags: (id: string, tags: string[]) => Promise<void>;
	setProjectColor: (
		id: string,
		color: api.ProjectColor | null,
	) => Promise<void>;
	setProjectEditorOverride: (
		id: string,
		editor: api.EditorKind | null,
	) => Promise<void>;
	setProjectExcluded: (id: string, excluded: boolean) => Promise<void>;
	removeFromRecents: (id: string) => Promise<void>;
	setProjectPinned: (id: string, pinned: boolean) => Promise<void>;
	setPinOrder: (ids: string[]) => Promise<void>;
	addExplicitProject: (project: api.ExplicitProject) => Promise<void>;
	removeExplicitProject: (id: string) => Promise<void>;
	forgetProject: (id: string) => Promise<void>;
}

// pinning appends (when absent), unpinning removes. kept pure + local so the optimistic update
// matches the rust command's rule (commands::set_pinned).
function applyPin(order: string[], id: string, pinned: boolean): string[] {
	if (!pinned) return order.filter((p) => p !== id);
	return order.includes(id) ? order : [...order, id];
}

const target = initialTarget();

export const useSettingsStore = create<SettingsState>((set, get) => ({
	loading: true,
	loadError: null,
	section: target.section,
	action: target.action,
	settings: null,
	index: null,
	rows: [],
	distros: [],
	configDir: "",
	platform: initialPlatform(),

	navigate: (next) => set(next),
	clearAction: () => set({ action: null }),

	async load() {
		// catch so a rejected command doesn't strand the panel on the null/loading state
		// with no error and no way to retry.
		set({ loading: true, loadError: null });
		try {
			const platform = get().platform ?? (await api.getPlatform());
			set({ platform });
			const [settings, index, rows, distros, configDir] = await Promise.all([
				api.getSettings(),
				api.getIndex(),
				api.getSearchLocations(),
				api.listWslDistros(),
				api.getConfigDir(),
			]);
			set({
				settings,
				index,
				rows,
				distros,
				configDir,
				platform,
				loading: false,
			});
		} catch (err) {
			set({ loading: false, loadError: String(err) });
		}
	},

	async refreshRows() {
		set({ rows: await api.getSearchLocations() });
	},

	async refreshIndex() {
		set({ index: await api.getIndex() });
	},

	async reloadSettings() {
		set({ settings: await api.getSettings() });
	},

	async setNested(value) {
		const cur = get().settings;
		if (!cur) return;
		const next = { ...cur, includeNestedProjects: value };
		set({ settings: next });
		try {
			await api.saveSettings(next);
		} catch {
			// the write never landed, so roll the optimistic toggle back rather than show a
			// setting the disk doesn't actually hold.
			set({ settings: cur });
			return;
		}
		// nested changes which projects surface (a post-pass filter), so rescan. the setting
		// is already saved, so a rescan failure must not roll the toggle back.
		void api.rescan();
	},

	async setDefaultDepth(value) {
		const cur = get().settings;
		if (!cur) return;
		// clamped to a sane range; only affects newly-added locations, so no rescan.
		const depth = Math.max(0, Math.min(12, value));
		const next = { ...cur, defaultScanDepth: depth };
		set({ settings: next });
		try {
			await api.saveSettings(next);
		} catch {
			// revert the optimistic value when the save fails.
			set({ settings: cur });
		}
	},

	async setLaunchAtStartup(value) {
		// the command does the OS registration and persists only on success; on rejection the
		// optimistic flip rolls back so the toggle never shows a startup state the OS doesn't
		// actually hold. rethrows so General can surface the OS refusal.
		await optimisticField(get, set, "launchAtStartup", value, () =>
			api.setLaunchAtStartup(value),
		);
	},

	async setRescanOnStartup(value) {
		// field-scoped command (not a full-document save) so a concurrent launch-at-startup write
		// isn't clobbered by a stale whole-document round-trip. no rescan: it only affects the next
		// launch. rethrows so a failed save surfaces instead of the switch silently snapping back.
		await optimisticField(get, set, "rescanOnStartup", value, () =>
			api.setRescanOnStartup(value),
		);
	},

	async rebuildIndex() {
		// fire-and-forget: the rust side clears the cache and rescans, and the resulting
		// scan-complete events refresh the index here (and in the launcher).
		await api.rebuildIndex();
	},

	async setDefaultEditor(editor) {
		const cur = get().settings;
		if (!cur) return;
		// optimistic: the segmented control should feel instant. the command persists and
		// echoes settings-changed, which reconciles. resolution is server-side, so no rescan.
		const next = { ...cur, defaultEditor: editor };
		set({ settings: next });
		try {
			await api.setDefaultEditor(editor);
		} catch {
			set({ settings: cur });
		}
	},

	async setEditorCommand(editor, command) {
		const cur = get().settings;
		if (!cur) return;
		const trimmed = command?.trim() ? command.trim() : null;
		// spread the existing entry so this only touches `command` and can't drop sibling
		// fields if EditorConfig grows.
		const editors = {
			...cur.editors,
			[editor]: { ...cur.editors[editor], command: trimmed },
		};
		const next = { ...cur, editors };
		set({ settings: next });
		try {
			await api.setEditorCommand(editor, trimmed);
		} catch {
			set({ settings: cur });
		}
	},

	async addOrUpdateLocation(nextLoc, replaceId) {
		// the rust command does the identity-keyed replace with the real derived id, then
		// persists + rescans. resync settings now; rows refresh on the scan-complete event.
		await api.upsertSearchLocation(nextLoc, replaceId ?? null);
		await get().reloadSettings();
		await get().refreshRows();
	},

	async grantLocationAccess(id) {
		// access state is scan output rather than persisted settings, so only rows need to
		// reconcile after the backend attempts the read and starts its follow-up scan.
		await api.requestLocationAccess(id);
		await get().refreshRows();
	},

	async removeLocation(id) {
		// instant index mutation on the rust side (no rescan); then resync local state.
		await api.removeSearchLocation(id);
		await get().reloadSettings();
		await get().refreshRows();
	},

	async rescan() {
		await api.rescan();
	},

	// optimistic per-project override edit: patch local settings so the table updates instantly,
	// then fire the field-scoped command; on failure re-read the truth. the command also emits
	// settings-changed, which reconciles (incl. pruning an all-default override). shared by the
	// alias/tags/color/editor/excluded edits below.
	async setProjectAlias(id, alias) {
		await mutateOverride(get, set, id, { alias }, () =>
			api.setProjectAlias(id, alias),
		);
	},
	async setProjectTags(id, tags) {
		await mutateOverride(get, set, id, { tags }, () =>
			api.setProjectTags(id, tags),
		);
	},
	async setProjectColor(id, color) {
		await mutateOverride(get, set, id, { color }, () =>
			api.setProjectColor(id, color),
		);
	},
	async setProjectEditorOverride(id, editor) {
		await mutateOverride(get, set, id, { editorOverride: editor }, () =>
			api.setProjectEditorOverride(id, editor),
		);
	},
	async setProjectExcluded(id, excluded) {
		await mutateOverride(get, set, id, { excluded }, () =>
			api.setProjectExcluded(id, excluded),
		);
	},

	async removeFromRecents(id) {
		const cur = get().settings;
		if (!cur) return;
		set({
			settings: { ...cur, recents: cur.recents.filter((r) => r.id !== id) },
		});
		try {
			await api.removeFromRecents(id);
		} catch {
			await get().reloadSettings();
		}
	},

	async setProjectPinned(id, pinned) {
		const cur = get().settings;
		if (!cur) return;
		set({
			settings: { ...cur, pinnedOrder: applyPin(cur.pinnedOrder, id, pinned) },
		});
		try {
			await api.setPinned(id, pinned);
		} catch {
			await get().reloadSettings();
		}
	},

	async setPinOrder(ids) {
		const cur = get().settings;
		if (!cur) return;
		set({ settings: { ...cur, pinnedOrder: ids } });
		try {
			await api.setPinOrder(ids);
		} catch {
			await get().reloadSettings();
		}
	},

	// explicit add/remove + forget aren't optimistic: they rescan, and land via the
	// scan-complete + settings-changed events. add may reject (folder not found); the caller
	// surfaces that.
	async addExplicitProject(project) {
		await api.addExplicitProject(project);
		await get().reloadSettings();
	},
	async removeExplicitProject(id) {
		await api.removeExplicitProject(id);
		await get().reloadSettings();
	},
	async forgetProject(id) {
		await api.forgetProject(id);
		await get().reloadSettings();
	},
}));

// patches a single project's override locally, fires the field-scoped command, and re-reads the
// truth on failure. defined outside the store so the optimistic edits share one rule.
async function mutateOverride(
	get: () => SettingsState,
	set: (partial: Partial<SettingsState>) => void,
	id: string,
	patch: Partial<api.ProjectOverride>,
	fire: () => Promise<void>,
): Promise<void> {
	const cur = get().settings;
	if (!cur) return;
	const next = { ...cur.projectOverrides[id], ...patch };
	set({
		settings: {
			...cur,
			projectOverrides: { ...cur.projectOverrides, [id]: next },
		},
	});
	try {
		await fire();
	} catch {
		await get().reloadSettings();
	}
}

// optimistically flips one settings field, fires its field-scoped command, and rolls *only* that
// field back on rejection. the rollback targets the *latest* settings (never the stale snapshot
// taken before the await) so a concurrent toggle's already-landed write isn't clobbered. rethrows
// so the caller can surface the failure rather than let the switch silently snap back. shared by
// the two startup toggles, which differ only by field name.
async function optimisticField<K extends keyof api.Settings>(
	get: () => SettingsState,
	set: (partial: Partial<SettingsState>) => void,
	key: K,
	value: api.Settings[K],
	fire: () => Promise<void>,
): Promise<void> {
	const cur = get().settings;
	if (!cur) return;
	const prev = cur[key];
	set({ settings: { ...cur, [key]: value } });
	try {
		await fire();
	} catch (err) {
		const latest = get().settings;
		if (latest) set({ settings: { ...latest, [key]: prev } });
		throw err;
	}
}
