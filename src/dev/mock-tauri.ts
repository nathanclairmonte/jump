// dev-only mock of the tauri ipc bridge so the real settings/launcher uis can render
// in a plain browser (`bun dev`) without the rust backend. seeded with representative
// data, and mutations are kept in memory so add/edit/remove feel live within a session.
// this module is dynamically imported behind an `import.meta.env.DEV` guard, so it is
// dead-code eliminated from production (tauri) builds.

import type {
	DistroDto,
	ExplicitProject,
	Platform,
	Project,
	ProjectColor,
	ProjectOverride,
	ProjectsIndex,
	SearchLocation,
	SearchLocationRow,
	Settings,
} from "@/lib/api";
import { applyPin } from "@/lib/search/join";

const now = Date.now();
const HOUR = 60 * 60 * 1000;

// which platform the mock reports from `get_platform`, so both platforms' UI can be eyeballed
// from either machine. persisted in localStorage and flipped by the dev-only toggle below;
// defaults to macos (the daily driver), with windows a deliberate opt-in for spot-checks.
const PLATFORM_KEY = "jump:devPlatform";
const DATA_KEY = "jump:devData";
function mockPlatform(): Platform {
	return localStorage.getItem(PLATFORM_KEY) === "windows" ? "windows" : "macos";
}

function mockEmpty(): boolean {
	return localStorage.getItem(DATA_KEY) === "empty";
}

// a representative index so the launcher renders pins/recents/search in the browser.
// `github` defaults to a github url so most rows show "Open in GitHub"; pass null to exercise
// the hidden-when-absent case.
function wsl(
	id: string,
	name: string,
	path: string,
	github: string | null = `https://github.com/example/${name}`,
): Project {
	return {
		id,
		kind: "wsl",
		distro: "Ubuntu",
		path,
		name,
		markers: [".git"],
		sourceLocationIds: ["wsl-dev"],
		missing: false,
		explicit: false,
		githubUrl: github,
	};
}
function win(
	id: string,
	name: string,
	path: string,
	github: string | null = `https://github.com/example/${name}`,
): Project {
	return {
		id,
		kind: "windows",
		distro: null,
		path,
		name,
		markers: [".git"],
		sourceLocationIds: ["win-dev"],
		missing: false,
		explicit: false,
		githubUrl: github,
	};
}

const index: ProjectsIndex = {
	schemaVersion: 1,
	projects: [
		wsl("p-studio", "studio-web", "/home/you/dev/studio-web"),
		wsl("p-jump", "jump", "/home/you/dev/jump"),
		// null github exercises the action menu's hidden "Open in GitHub" case.
		wsl("p-atlas", "atlas-api", "/home/you/dev/atlas-api", null),
		win("p-portfolio", "portfolio", "C:\\Users\\you\\dev\\portfolio"),
		wsl("p-ledger", "ledger-cli", "/home/you/dev/ledger-cli"),
		wsl("p-notes", "notes-app", "/home/you/dev/notes-app"),
		wsl("p-scheduler", "scheduler", "/home/you/dev/scheduler"),
		// two same-named projects to exercise the disambiguation prefix on search.
		wsl("p-app-work", "app", "/home/you/work/app"),
		wsl("p-app-personal", "app", "/home/you/personal/app"),
		// a missing project (folder gone, still referenced) to exercise the Missing tab.
		{
			...wsl("p-archived", "archived", "/home/you/dev/archived"),
			missing: true,
		},
		// an explicit, marker-less project outside any scanned location, for the Explicit tab.
		{
			...wsl("p-scratch", "scratch", "/home/you/scratch"),
			markers: [],
			sourceLocationIds: [],
			explicit: true,
			githubUrl: null,
		},
	],
	scan: {
		lastScanAt: now - 2 * 60_000,
		durationMs: 180,
		totalCount: 11,
		locations: [],
	},
};

let settings: Settings = {
	schemaVersion: 1,
	launchAtStartup: false,
	rescanOnStartup: true,
	theme: "dark",
	defaultEditor: null,
	includeNestedProjects: true,
	defaultScanDepth: 3,
	hotkey: "Ctrl+Alt+Space",
	searchLocations: [],
	explicitProjects: [
		{ kind: "wsl", path: "/home/you/scratch", distro: "Ubuntu" },
	],
	editors: {},
	pinnedOrder: ["p-studio", "p-jump", "p-atlas"],
	projectOverrides: {
		"p-studio": { color: "teal", tags: ["rust", "cli"] },
		"p-jump": {
			color: "amber",
			editorOverride: "cursor",
			alias: "jump",
		},
		"p-ledger": { color: "rose" },
		"p-notes": { color: "green" },
		// an excluded project to exercise the Excluded tab + Restore.
		"p-scheduler": { excluded: true },
	},
	recents: [
		{ id: "p-portfolio", lastOpenedAt: now - HOUR, openCount: 3 },
		{ id: "p-ledger", lastOpenedAt: now - 2 * HOUR, openCount: 5 },
		{ id: "p-notes", lastOpenedAt: now - 3 * HOUR, openCount: 1 },
	],
};

let rows: SearchLocationRow[] = [
	{
		id: "wsl-dev",
		kind: "wsl",
		path: "/home/you/dev",
		distro: "Ubuntu",
		maxDepth: 3,
		projectCount: 12,
		state: "ok",
		error: null,
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: now - 2 * 60_000,
	},
	{
		id: "wsl-work",
		kind: "wsl",
		path: "/home/you/work",
		distro: "Debian",
		maxDepth: 2,
		projectCount: 3,
		state: "distroStopped",
		error: null,
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: now - 3 * 60 * 60_000,
	},
	{
		id: "win-dev",
		kind: "windows",
		path: "C:\\Users\\you\\dev",
		distro: null,
		maxDepth: 3,
		projectCount: 7,
		state: "ok",
		error: null,
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: now - 26 * 60 * 60_000,
	},
];

let macRows: SearchLocationRow[] = [
	{
		id: "mac-projects",
		kind: "mac",
		path: "/Users/you/Code",
		distro: null,
		maxDepth: 3,
		projectCount: 11,
		state: "ok",
		error: null,
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: now - 2 * 60_000,
	},
	{
		id: "mac-documents",
		kind: "mac",
		path: "/Users/you/Documents/Projects",
		distro: null,
		maxDepth: 3,
		projectCount: 0,
		state: "permissionDenied",
		error: "Operation not permitted",
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: now - 12 * 60_000,
	},
	{
		id: "mac-work",
		kind: "mac",
		path: "/Users/you/Work",
		distro: null,
		maxDepth: 2,
		projectCount: 3,
		state: "ok",
		error: null,
		unreadablePaths: [
			"/Users/you/Work/archive/private",
			"/Users/you/Work/vendor/restricted",
		],
		unreadablePathCount: 102,
		lastScanAt: now - 18 * 60_000,
	},
	{
		id: "foreign-windows",
		kind: "windows",
		path: "C:\\Users\\you\\dev",
		distro: null,
		maxDepth: 3,
		projectCount: 0,
		state: "platformForeign",
		error: "This location belongs to another platform",
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: null,
	},
];

// the mock backend serves whichever set matches the simulated host, so every location
// mutation reads and writes through this pair rather than re-deriving which array is live.
const activeRows = (): SearchLocationRow[] =>
	mockPlatform() === "macos" ? macRows : rows;

const setActiveRows = (next: SearchLocationRow[]) => {
	if (mockPlatform() === "macos") macRows = next;
	else rows = next;
};

const distros: DistroDto[] = [
	{ name: "Ubuntu", isDefault: true, state: "running" },
	{ name: "Debian", isDefault: false, state: "stopped" },
];

let idCounter = 0;
let callbackId = 0;

// builds a preview row from a submitted location; no real scan runs in the browser.
function rowFromLocation(
	location: SearchLocation,
	id: string,
): SearchLocationRow {
	return {
		id,
		kind: location.kind,
		path: location.path,
		distro: location.distro,
		maxDepth: location.maxDepth,
		projectCount: 0,
		state: "pending",
		error: null,
		unreadablePaths: [],
		unreadablePathCount: 0,
		lastScanAt: null,
	};
}

// applies an override mutation in memory, pruning the entry when it becomes all-default so the
// dev mock mirrors the real command's tidy-up.
function updateOverride(
	id: string,
	f: (o: ProjectOverride) => ProjectOverride,
): Settings {
	const next = f(settings.projectOverrides[id] ?? {});
	const empty =
		!next.alias &&
		(next.tags?.length ?? 0) === 0 &&
		!next.color &&
		!next.editorOverride &&
		!next.excluded;
	const projectOverrides = { ...settings.projectOverrides };
	if (empty) delete projectOverrides[id];
	else projectOverrides[id] = next;
	return { ...settings, projectOverrides };
}

// a stable fake id for a synthesized explicit project (the real backend derives a blake3 hash
// the browser can't recompute). good enough for the mock to add/remove the same seed.
function explicitId(path: string): string {
	return `exp-${path}`;
}

function macProjectPath(path: string): string {
	const segments = path.split(/[/\\]/).filter(Boolean);
	const suffix = segments.slice(-2).join("/") || "project";
	return `/Users/you/Code/${suffix}`;
}

function indexForPlatform(): ProjectsIndex {
	const platformIndex: ProjectsIndex =
		mockPlatform() === "windows"
			? index
			: {
					...index,
					projects: index.projects.map((project) => ({
						...project,
						kind: "mac",
						distro: null,
						path: macProjectPath(project.path),
					})),
				};
	if (!mockEmpty()) return platformIndex;
	return {
		...platformIndex,
		projects: [],
		scan: { ...platformIndex.scan, totalCount: 0, locations: [] },
	};
}

function settingsForPlatform(): Settings {
	const platformSettings: Settings =
		mockPlatform() === "windows"
			? settings
			: {
					...settings,
					searchLocations: macRows.map((row) => ({
						kind: row.kind,
						path: row.path,
						distro: row.distro,
						maxDepth: row.maxDepth,
					})),
					explicitProjects: settings.explicitProjects.map((project) => ({
						...project,
						kind: "mac",
						distro: null,
						path: macProjectPath(project.path),
					})),
				};
	if (!mockEmpty()) return platformSettings;
	return {
		...platformSettings,
		searchLocations: [],
		explicitProjects: [],
		pinnedOrder: [],
		projectOverrides: {},
		recents: [],
	};
}

type InvokeArgs = Record<string, unknown>;

async function mockInvoke(
	cmd: string,
	args: InvokeArgs = {},
): Promise<unknown> {
	switch (cmd) {
		case "get_settings":
			return settingsForPlatform();
		case "save_settings":
			settings = args.settings as Settings;
			return;
		case "get_index":
			return indexForPlatform();
		case "set_pinned": {
			const id = args.id as string;
			const pinned = args.pinned as boolean;
			settings = {
				...settings,
				pinnedOrder: applyPin(settings.pinnedOrder, id, pinned),
			};
			return;
		}
		case "set_pin_order":
			settings = { ...settings, pinnedOrder: args.ids as string[] };
			return;
		case "set_project_alias": {
			const id = args.id as string;
			const raw = (args.alias as string | null) ?? null;
			const alias = raw?.trim() || null;
			settings = updateOverride(id, (o) => ({ ...o, alias }));
			return;
		}
		case "set_project_tags": {
			const id = args.id as string;
			// mirror the rust normalize_tags: trim, drop empty, dedupe case-insensitively.
			const seen = new Set<string>();
			const tags: string[] = [];
			for (const t of (args.tags as string[]) ?? []) {
				const trimmed = t.trim();
				if (!trimmed) continue;
				const key = trimmed.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				tags.push(trimmed);
			}
			settings = updateOverride(id, (o) => ({ ...o, tags }));
			return;
		}
		case "set_project_editor_override": {
			const id = args.id as string;
			const editor = (args.editor as string | null) ?? null;
			settings = updateOverride(id, (o) => ({ ...o, editorOverride: editor }));
			return;
		}
		case "set_project_color": {
			const id = args.id as string;
			const color = (args.color as ProjectColor | null) ?? null;
			settings = updateOverride(id, (o) => ({ ...o, color }));
			return;
		}
		case "set_project_excluded": {
			const id = args.id as string;
			settings = updateOverride(id, (o) => ({
				...o,
				excluded: args.excluded as boolean,
			}));
			return;
		}
		case "remove_from_recents": {
			const id = args.id as string;
			settings = {
				...settings,
				recents: settings.recents.filter((r) => r.id !== id),
			};
			return;
		}
		case "add_explicit_project": {
			// no real scan in the browser: synthesize an index entry inline so the panel updates.
			const project = args.project as ExplicitProject;
			const id = explicitId(project.path);
			settings = {
				...settings,
				explicitProjects: [
					...settings.explicitProjects.filter((e) => explicitId(e.path) !== id),
					project,
				],
			};
			index.projects = [
				...index.projects.filter((p) => p.id !== id),
				{
					id,
					kind: project.kind,
					distro: project.distro,
					path: project.path,
					name:
						project.path.split(/[/\\]/).filter(Boolean).pop() ?? project.path,
					markers: [],
					sourceLocationIds: [],
					missing: false,
					explicit: true,
					githubUrl: null,
				},
			];
			return;
		}
		case "remove_explicit_project": {
			const id = args.id as string;
			settings = {
				...settings,
				explicitProjects: settings.explicitProjects.filter(
					(e) => explicitId(e.path) !== id,
				),
			};
			// drop only explicit-only entries (those a real scan wouldn't independently find).
			index.projects = index.projects.filter(
				(p) => !(p.id === id && p.sourceLocationIds.length === 0),
			);
			return;
		}
		case "forget_project": {
			const id = args.id as string;
			const { [id]: _dropped, ...projectOverrides } = settings.projectOverrides;
			settings = {
				...settings,
				pinnedOrder: settings.pinnedOrder.filter((p) => p !== id),
				recents: settings.recents.filter((r) => r.id !== id),
				projectOverrides,
				explicitProjects: settings.explicitProjects.filter(
					(e) => explicitId(e.path) !== id,
				),
			};
			// a missing entry is only retained because it's referenced; once forgotten it drops.
			index.projects = index.projects.filter((p) => p.id !== id);
			return;
		}
		case "detect_editors":
			// representative: vs code + cursor present, zed absent, to exercise both card states.
			return mockPlatform() === "macos"
				? [
						{
							kind: "vscode",
							detected: true,
							resolvedPath: "/Applications/Visual Studio Code.app",
							source: "probe",
						},
						{
							kind: "cursor",
							detected: false,
							resolvedPath: null,
							source: "none",
						},
						{
							kind: "zed",
							detected: false,
							resolvedPath: null,
							source: "none",
						},
					]
				: [
						{
							kind: "vscode",
							detected: true,
							resolvedPath:
								"C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
							source: "probe",
						},
						{
							kind: "cursor",
							detected: true,
							resolvedPath:
								"C:\\Users\\you\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
							source: "probe",
						},
						{
							kind: "zed",
							detected: false,
							resolvedPath: null,
							source: "none",
						},
					];
		case "set_default_editor":
			settings = { ...settings, defaultEditor: args.editor as string };
			return;
		case "set_editor_command": {
			const editor = args.editor as string;
			const command = (args.command as string | null) ?? null;
			// spread the existing entry so this only touches `command`, matching the real
			// store and surviving any future EditorConfig fields.
			settings = {
				...settings,
				editors: {
					...settings.editors,
					[editor]: { ...settings.editors[editor], command },
				},
			};
			return;
		}
		case "test_launch":
			// no real spawn in the browser; report success so the chip path is exercisable.
			return { ok: true, detail: "Launched" };
		case "launch_project": {
			// mirror the rust contract: record the open on (simulated) success.
			const id = args.id as string;
			const existing = settings.recents.find((r) => r.id === id);
			const recents = existing
				? settings.recents.map((r) =>
						r.id === id
							? { ...r, lastOpenedAt: Date.now(), openCount: r.openCount + 1 }
							: r,
					)
				: [...settings.recents, { id, lastOpenedAt: Date.now(), openCount: 1 }];
			settings = { ...settings, recents };
			return;
		}
		case "get_search_locations":
			return mockEmpty() ? [] : activeRows();
		case "list_wsl_distros":
			return distros;
		case "get_config_dir":
			return mockPlatform() === "macos"
				? "/Users/you/Library/Application Support/jump"
				: "C:\\Users\\you\\AppData\\Roaming\\jump";
		case "upsert_search_location": {
			const location = args.location as SearchLocation;
			const replaceId = (args.replaceId as string | null) ?? null;
			const current = activeRows();
			setActiveRows(
				replaceId
					? current.map((r) =>
							r.id === replaceId ? rowFromLocation(location, replaceId) : r,
						)
					: [...current, rowFromLocation(location, `loc-${++idCounter}`)],
			);
			return;
		}
		case "remove_search_location": {
			const id = args.locationId as string;
			setActiveRows(activeRows().filter((r) => r.id !== id));
			return;
		}
		case "request_location_access": {
			const id = args.locationId as string;
			setActiveRows(
				activeRows().map((row) =>
					row.id === id ? { ...row, state: "ok", error: null } : row,
				),
			);
			return;
		}
		case "classify_path_cmd": {
			const input = String(args.input ?? "");
			// a drive-letter prefix reads as windows; everything else as a wsl path.
			return /^[a-zA-Z]:\\/.test(input)
				? { kind: "windows", distro: null, linuxPath: null, windowsPath: input }
				: {
						kind: "wsl",
						distro: "Ubuntu",
						linuxPath: input,
						windowsPath: null,
					};
		}
		case "get_hotkey_status":
			return { combo: settings.hotkey, registered: true };
		case "rebind_hotkey": {
			// the real command validates/canonicalizes in core; the preview just echoes it back.
			const combo = String(args.combo ?? "");
			settings = { ...settings, hotkey: combo };
			return { combo, registered: true };
		}
		case "set_launch_at_startup":
			settings = { ...settings, launchAtStartup: Boolean(args.enabled) };
			return;
		case "set_rescan_on_startup":
			settings = { ...settings, rescanOnStartup: Boolean(args.enabled) };
			return;
		case "rebuild_index":
			// the browser mock has no on-disk cache to discard and no scan to run, and its
			// representative index has no stale entries to drop, so a rebuild is a faithful
			// no-op here. explicit (not a default fall-through) so the intent is clear.
			return;
		case "get_platform":
			return mockPlatform();
		case "dismiss_launcher":
			// the browser mock has no window to hide and no application to step aside, so a
			// dismissal is a faithful no-op. explicit (not a default fall-through) so the
			// intent is clear.
			return;
		case "plugin:dialog|open":
			// pretend the user picked a folder in the browse dialog
			return mockPlatform() === "macos"
				? "/Users/you/Code/new-project"
				: "/home/you/new-project";
		case "plugin:event|listen":
			return ++callbackId;
		default:
			// rescan, open_config_dir, window/event/other plugin calls are browser no-ops
			return;
	}
}

// a floating dev-only pill that flips the mocked platform and reloads, so the Windows UI stays
// eyeballable once the Mac is the daily driver. raw DOM (no React) so it stays wholly inside
// this dev-only module and never ships. shows the *current* platform so there's no "which am I
// looking at" ambiguity.
function installDevToggles(): void {
	const pill = document.createElement("button");
	pill.type = "button";
	const paint = () => {
		pill.textContent = `platform: ${mockPlatform()}`;
	};
	pill.style.cssText = [
		"position:fixed",
		"right:8px",
		"bottom:8px",
		"z-index:2147483647",
		"padding:4px 8px",
		"font:11px ui-monospace,monospace",
		"color:#fff",
		"background:#000a",
		"border:1px solid #fff3",
		"border-radius:6px",
		"cursor:pointer",
	].join(";");
	paint();
	pill.addEventListener("click", () => {
		const next = mockPlatform() === "macos" ? "windows" : "macos";
		localStorage.setItem(PLATFORM_KEY, next);
		// a reload is the honest way to re-run every startup fetch under the new platform.
		window.location.reload();
	});
	document.body.appendChild(pill);

	const dataPill = document.createElement("button");
	dataPill.type = "button";
	dataPill.textContent = `data: ${mockEmpty() ? "empty" : "seeded"}`;
	dataPill.style.cssText = `${pill.style.cssText};bottom:36px`;
	dataPill.addEventListener("click", () => {
		localStorage.setItem(DATA_KEY, mockEmpty() ? "seeded" : "empty");
		window.location.reload();
	});
	document.body.appendChild(dataPill);
}

/** Installs a fake tauri ipc bridge on window so the ui renders without the backend. */
export function installTauriMock(): void {
	if (document.body) installDevToggles();
	else
		window.addEventListener("DOMContentLoaded", installDevToggles, {
			once: true,
		});
	const internals = {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main", windowLabel: "main" },
		},
		invoke: mockInvoke,
		transformCallback(
			callback: (response: unknown) => void,
			once = false,
		): number {
			const id = ++callbackId;
			const prop = `_${id}`;
			Object.defineProperty(window, prop, {
				value: (response: unknown) => {
					if (once) Reflect.deleteProperty(window, prop);
					return callback(response);
				},
				configurable: true,
				writable: false,
			});
			return id;
		},
	};
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: internals,
		configurable: true,
	});
}
