// the typed door to the rust-owned source of truth. every shape here mirrors a serde
// struct in jump-core (camelCase on the wire); the rust side stays canonical.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LocationKind = "windows" | "wsl" | "mac";

// the host OS Jump is running on, mirroring jump-core's `Platform`. distinct from
// LocationKind: a windows host holds both windows and wsl locations. the macOS UI collapses
// the environment axis; the windows UI is unchanged.
export type Platform = "windows" | "macos";

export interface SearchLocation {
	kind: LocationKind;
	path: string;
	distro: string | null;
	maxDepth: number;
}

// a user-added project that always appears in the index, independent of the scan.
// identity only (kind/distro/path); its derived id matches the synthesized index entry.
export interface ExplicitProject {
	kind: LocationKind;
	path: string;
	distro: string | null;
}

export interface Recent {
	id: string;
	lastOpenedAt: number;
	openCount: number;
}

export type ProjectColor = "teal" | "amber" | "rose" | "green";

// app-only metadata layered onto a project by id; never touches disk under the project
// folder. mirrors jump-core's ProjectOverride.
export interface ProjectOverride {
	alias?: string | null;
	tags?: string[];
	color?: ProjectColor | null;
	editorOverride?: string | null;
	excluded?: boolean;
}

export interface Settings {
	schemaVersion: number;
	launchAtStartup: boolean;
	rescanOnStartup: boolean;
	theme: "dark";
	defaultEditor: string | null;
	includeNestedProjects: boolean;
	defaultScanDepth: number;
	hotkey: string;
	searchLocations: SearchLocation[];
	explicitProjects: ExplicitProject[];
	editors: Record<string, { command: string | null }>;
	pinnedOrder: string[];
	projectOverrides: Record<string, ProjectOverride>;
	recents: Recent[];
}

// one entry in the generated index: scanned facts only. app-only state (pinned/recent/
// excluded) is derived by joining against settings in the launcher, never stored here.
export interface Project {
	id: string;
	kind: LocationKind;
	distro: string | null;
	path: string;
	name: string;
	markers: string[];
	sourceLocationIds: string[];
	missing: boolean;
	// true when seeded by an ExplicitProject; the entry always appears even if the scan wouldn't
	// find it. a scan-discovered folder that is also a seed carries both its facts and this flag.
	explicit: boolean;
	// the project's GitHub web URL, resolved at scan time from .git/config; null when there is
	// no GitHub remote. drives the action menu's "Open in GitHub" visibility.
	githubUrl: string | null;
}

export interface ScanReport {
	lastScanAt: number | null;
	durationMs: number | null;
	totalCount: number;
	locations: unknown[];
}

export interface ProjectsIndex {
	schemaVersion: number;
	projects: Project[];
	scan: ScanReport;
}

export type LocationStatusState =
	| "ok"
	| "distroStopped"
	| "distroMissing"
	| "error"
	| "permissionDenied"
	| "platformForeign"
	| "pending";

// a configured location joined with its latest per-location scan status, built on the
// rust side because the frontend can't recompute the derived id.
export interface SearchLocationRow {
	id: string;
	kind: LocationKind;
	path: string;
	distro: string | null;
	maxDepth: number;
	projectCount: number;
	state: LocationStatusState;
	error: string | null;
	unreadablePaths: string[];
	unreadablePathCount: number;
	lastScanAt: number | null;
}

export interface DistroDto {
	name: string;
	isDefault: boolean;
	state: "running" | "stopped";
}

// the live global-hotkey status: the bound combo plus whether the OS actually accepted its
// registration (false after a conflict, so the Shortcuts panel can be honest about it).
export interface HotkeyStatus {
	combo: string;
	registered: boolean;
}

export interface ClassifyResult {
	kind: "wsl" | "wslNeedsDistro" | "windows";
	distro: string | null;
	linuxPath: string | null;
	windowsPath: string | null;
}

export interface ScanCompletePayload {
	totalCount: number;
	errorCount: number;
	lastScanAt: number | null;
}

// the three editors v0 supports, as the single TS source of both the list and the type so
// they can't drift. keep in sync with jump_core::editor::EditorKind, the wire source of
// truth (from_key rejects any key not in this set).
export const EDITOR_KINDS = ["vscode", "cursor", "zed"] as const;
export type EditorKind = (typeof EDITOR_KINDS)[number];

// live detection for one editor, recomputed on demand and never persisted.
export interface EditorDetection {
	kind: EditorKind;
	detected: boolean;
	resolvedPath: string | null;
	source: "override" | "probe" | "none";
}

// the ephemeral result of a Test launch; shown until re-tested, never written to disk.
export interface TestResult {
	ok: boolean;
	detail: string;
}

// a launch failure, shaped for the launcher's inline error card. mirrors the rust Err.
export interface LaunchError {
	kind: "noEditorConfigured" | "editorUnavailable" | "spawnFailed";
	message: string;
	detail: string;
	// the editor we resolved and tried (when one resolved), so the card can offer fallbacks
	// that exclude it. null for "noEditorConfigured" and pre-resolution failures.
	editor: EditorKind | null;
}

// thin-signal events: a nudge to re-fetch, never the payload of record.
export const EVENT_SCAN_COMPLETE = "scan-complete";
export const EVENT_SCAN_STARTED = "scan-started";
export const EVENT_SETTINGS_CHANGED = "settings-changed";
// fired at the launcher each time it is revealed (reset query/selection + refresh).
export const EVENT_LAUNCHER_SHOWN = "launcher-shown";
// fired at an already-open settings window to deep-link it to a section.
export const EVENT_SETTINGS_NAVIGATE = "settings-navigate";

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) =>
	invoke<void>("save_settings", { settings });
export const getIndex = () => invoke<ProjectsIndex>("get_index");
export const getSearchLocations = () =>
	invoke<SearchLocationRow[]>("get_search_locations");
export const requestLocationAccess = (locationId: string) =>
	invoke<void>("request_location_access", { locationId });
export const openFilesAndFoldersSettings = () =>
	invoke<void>("open_files_and_folders_settings");
export const rescan = () => invoke<void>("rescan");
// launcher mutations: field-scoped so a concurrent settings-window edit isn't clobbered.
export const setPinned = (id: string, pinned: boolean) =>
	invoke<void>("set_pinned", { id, pinned });
export const setPinOrder = (ids: string[]) =>
	invoke<void>("set_pin_order", { ids });
// opens settings, optionally deep-linking to a section.
export const openSettings = (section?: string) =>
	invoke<void>("open_settings", { section: section ?? null });
// routes every launcher close through Rust so macOS can restore the previous application.
export const dismissLauncher = () => invoke<void>("dismiss_launcher");
// Projects-table metadata edits: field-scoped like the pin commands. alias null/blank
// clears (falls back to folder name); tags is a normalized whole-list replace.
export const setProjectAlias = (id: string, alias: string | null) =>
	invoke<void>("set_project_alias", { id, alias });
export const setProjectTags = (id: string, tags: string[]) =>
	invoke<void>("set_project_tags", { id, tags });
// explicit projects: add verifies the folder exists then rescans; remove strips
// the seed then rescans. both land via scan-complete.
export const addExplicitProject = (project: ExplicitProject) =>
	invoke<void>("add_explicit_project", { project });
export const removeExplicitProject = (id: string) =>
	invoke<void>("remove_explicit_project", { id });
// forgets a missing project: strips all settings references (pins/recents/overrides/explicit
// seed) and rescans so the stale index entry drops.
export const forgetProject = (id: string) =>
	invoke<void>("forget_project", { id });
// action-menu mutations: field-scoped like the pin commands. editor/color null clears.
export const setProjectEditorOverride = (
	id: string,
	editor: EditorKind | null,
) => invoke<void>("set_project_editor_override", { id, editor });
export const setProjectColor = (id: string, color: ProjectColor | null) =>
	invoke<void>("set_project_color", { id, color });
export const setProjectExcluded = (id: string, excluded: boolean) =>
	invoke<void>("set_project_excluded", { id, excluded });
export const removeFromRecents = (id: string) =>
	invoke<void>("remove_from_recents", { id });
// action-menu external actions: rust resolves path/url from the index by id.
export const showInFileExplorer = (id: string) =>
	invoke<void>("show_in_file_explorer", { id });
export const openGithubUrl = (id: string) =>
	invoke<void>("open_github_url", { id });
// identity matching uses the real derived id on the rust side, so the frontend never
// reimplements the hash. `replaceId` is the edited row's id (null when adding).
export const upsertSearchLocation = (
	location: SearchLocation,
	replaceId: string | null,
) => invoke<void>("upsert_search_location", { location, replaceId });
export const removeSearchLocation = (locationId: string) =>
	invoke<void>("remove_search_location", { locationId });
export const listWslDistros = () => invoke<DistroDto[]>("list_wsl_distros");
export const classifyPath = (input: string) =>
	invoke<ClassifyResult>("classify_path_cmd", { input });
export const getConfigDir = () => invoke<string>("get_config_dir");
// the running host platform, used by platform-aware window and environment presentation.
export const getPlatform = () => invoke<Platform>("get_platform");
export const openConfigDir = () => invoke<void>("open_config_dir");
// general -> data: discards the cached index and rescans from scratch (dropping stale
// missing/ghost entries). settings (pins/tags/etc.) are untouched and re-attach by id.
export const rebuildIndex = () => invoke<void>("rebuild_index");
// general -> startup: registers/unregisters Jump at Windows startup. persists only after the
// OS call succeeds, so the stored flag can't drift from what the OS actually holds.
export const setLaunchAtStartup = (enabled: boolean) =>
	invoke<void>("set_launch_at_startup", { enabled });
// general -> startup: field-scoped toggle for the background rescan-on-startup flag, so a
// concurrent launch-at-startup write isn't clobbered by a full-document save round-trip.
export const setRescanOnStartup = (enabled: boolean) =>
	invoke<void>("set_rescan_on_startup", { enabled });
// shortcuts: the live hotkey status, and the rebind. rebind validates + canonicalizes in
// rust, registers the new combo before dropping the old, and rejects a conflict (old stays).
export const getHotkeyStatus = () => invoke<HotkeyStatus>("get_hotkey_status");
export const rebindHotkey = (combo: string) =>
	invoke<HotkeyStatus>("rebind_hotkey", { combo });
// editors: detection is live; default/command are dedicated mutations like the pin
// commands; test_launch is ephemeral; launch_project is the one real launch entry point
// and rejects with a LaunchError on failure.
export const detectEditors = () => invoke<EditorDetection[]>("detect_editors");
export const setDefaultEditor = (editor: EditorKind) =>
	invoke<void>("set_default_editor", { editor });
export const setEditorCommand = (editor: EditorKind, command: string | null) =>
	invoke<void>("set_editor_command", { editor, command });
export const testLaunch = (editor: EditorKind, env: LocationKind) =>
	invoke<TestResult>("test_launch", { editor, env });
// editorOverride is the Open-With pick; null uses the resolved default.
export const launchProject = (id: string, editorOverride?: EditorKind | null) =>
	invoke<void>("launch_project", {
		id,
		editorOverride: editorOverride ?? null,
	});

/** Subscribes to a backend event; returns the unlisten function. */
export function onEvent<T>(name: string, handler: (payload: T) => void) {
	return listen<T>(name, (event) => handler(event.payload));
}
