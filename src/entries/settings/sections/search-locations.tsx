// the live Search Locations panel: Windows keeps its grouped native/WSL model, while macOS
// presents one flat native list. every mutation routes through the store and discovery
// changes auto-rescan.

import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, RotateCw, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	classifyPath,
	type LocationKind,
	type LocationStatusState,
	openFilesAndFoldersSettings,
	type Platform,
	type SearchLocation,
	type SearchLocationRow,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { isLocationKindSupported } from "@/lib/platform-labels";
import { cn } from "@/lib/utils";
import { EnvBadge, SectionLabel, Stepper } from "../components";
import { useSettingsStore } from "../store";

function metaLine(row: SearchLocationRow, platform: Platform): string {
	const parts: string[] = [];
	if (platform === "windows") {
		parts.push(row.kind === "wsl" ? "WSL" : "Windows");
	}
	if (row.distro) parts.push(row.distro);
	parts.push(`depth ${row.maxDepth}`);
	const count = row.projectCount;
	parts.push(`${count} ${count === 1 ? "project" : "projects"}`);
	parts.push(
		row.lastScanAt
			? formatRelativeTime(row.lastScanAt, Date.now())
			: "not scanned",
	);
	return parts.join(" · ");
}

type StateChipPresentation = { text: string; tone: string } | undefined;

const WARNING_CHIP = "bg-warning-bg text-warning border-warning-border";
const DANGER_CHIP = "bg-danger-bg text-danger-text border-danger-border";

const STATE_CHIP = {
	windows: {
		ok: undefined,
		pending: undefined,
		distroStopped: { text: "distro stopped", tone: WARNING_CHIP },
		distroMissing: { text: "distro not found", tone: WARNING_CHIP },
		error: { text: "scan error", tone: DANGER_CHIP },
		permissionDenied: { text: "scan error", tone: DANGER_CHIP },
		platformForeign: { text: "other platform", tone: WARNING_CHIP },
	},
	macos: {
		ok: undefined,
		pending: undefined,
		distroStopped: undefined,
		distroMissing: undefined,
		error: { text: "scan error", tone: DANGER_CHIP },
		permissionDenied: { text: "access blocked", tone: DANGER_CHIP },
		platformForeign: { text: "other platform", tone: WARNING_CHIP },
	},
} satisfies Record<
	Platform,
	Record<LocationStatusState, StateChipPresentation>
>;

/** A degraded-state chip for locations that could not be refreshed normally. */
function StateChip({
	row,
	platform,
}: {
	row: SearchLocationRow;
	platform: Platform;
}) {
	const chip = STATE_CHIP[platform][row.state];
	if (!chip) return null;
	return (
		<Badge
			variant="ghost"
			className={cn(
				"flex-none rounded-badge border px-1.5 py-[2px] text-[10.5px] font-normal",
				chip.tone,
			)}
			title={row.error ?? undefined}
		>
			{chip.text}
		</Badge>
	);
}

function LocationCard({
	row,
	platform,
	onEdit,
}: {
	row: SearchLocationRow;
	platform: Platform;
	onEdit: () => void;
}) {
	const removeLocation = useSettingsStore((s) => s.removeLocation);
	const grantLocationAccess = useSettingsStore((s) => s.grantLocationAccess);
	const [requesting, setRequesting] = useState(false);
	const [requestError, setRequestError] = useState<string | null>(null);
	// kind is persisted truth; scan state can still be pending when startup rescans are off.
	const isForeign = !isLocationKindSupported(platform, row.kind);

	async function grantAccess() {
		setRequesting(true);
		setRequestError(null);
		try {
			await grantLocationAccess(row.id);
		} catch (err) {
			setRequestError(String(err));
		} finally {
			setRequesting(false);
		}
	}

	return (
		<div className="border-t border-white/[0.055] first:border-t-0">
			<div className="flex items-center justify-between gap-4 px-[18px] py-[14px]">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						{platform === "windows" ? <EnvBadge kind={row.kind} /> : null}
						<span className="truncate font-mono text-[13px] text-ink-body">
							{row.path}
						</span>
						<StateChip row={row} platform={platform} />
					</div>
					<div className="mt-[5px] font-mono text-[11.5px] text-ink-tertiary">
						{metaLine(row, platform)}
					</div>
				</div>
				<div className="flex flex-none items-center gap-1.5">
					{!isForeign ? (
						<Button variant="outline" size="sm" onClick={onEdit}>
							Edit
						</Button>
					) : null}
					<Button
						variant="ghost"
						size="icon"
						aria-label="Remove location"
						onClick={() => void removeLocation(row.id)}
						className="text-ink-tertiary hover:bg-danger/15 hover:text-danger-text"
					>
						<Trash2 size={15} strokeWidth={1.8} />
					</Button>
				</div>
			</div>

			{platform === "macos" && row.state === "permissionDenied" ? (
				<div className="mx-[18px] mb-[14px] rounded-[9px] border border-danger-border bg-danger-bg px-3.5 py-3">
					<div className="flex items-start gap-2.5">
						<ShieldAlert
							size={16}
							strokeWidth={1.8}
							className="mt-0.5 flex-none text-danger-text"
						/>
						<div className="min-w-0 flex-1">
							<div className="text-[12.5px] text-danger-text">
								macOS is preventing Jump from reading this folder.
							</div>
							<div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
								Grant access to request permission, or open Files and Folders if
								you previously denied it.
							</div>
							{requestError ? (
								<div className="mt-1.5 font-mono text-[11px] text-danger-text">
									{requestError}
								</div>
							) : null}
							<div className="mt-2.5 flex gap-2">
								<Button
									size="sm"
									onClick={() => void grantAccess()}
									disabled={requesting}
								>
									{requesting ? "Requesting…" : "Grant access"}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => void openFilesAndFoldersSettings()}
								>
									Open Privacy Settings
								</Button>
							</div>
						</div>
					</div>
				</div>
			) : null}

			{isForeign ? (
				<div className="mx-[18px] mb-[14px] rounded-[9px] border border-warning-border bg-warning-bg px-3.5 py-2.5 text-[11.5px] leading-relaxed text-warning">
					This location belongs to another platform and cannot be scanned on
					this computer. It is retained exactly as configured and can be removed
					here.
				</div>
			) : null}

			{row.unreadablePathCount > 0 ? (
				<details className="group mx-[18px] mb-[14px] rounded-[9px] border border-warning-border bg-warning-bg px-3.5 py-2.5">
					<summary className="flex cursor-pointer list-none items-center gap-2 text-[11.5px] text-warning">
						<ChevronDown
							size={13}
							strokeWidth={2}
							className="transition-transform group-open:rotate-180"
						/>
						{row.unreadablePathCount}{" "}
						{row.unreadablePathCount === 1
							? "directory was"
							: "directories were"}{" "}
						not readable. The scan may be incomplete.
					</summary>
					<div className="mt-2.5 border-t border-warning-border pt-2.5">
						<div className="max-h-36 space-y-1 overflow-y-auto font-mono text-[10.5px] leading-relaxed text-ink-secondary">
							{row.unreadablePaths.map((path) => (
								<div key={path} className="break-all">
									{path}
								</div>
							))}
						</div>
						{row.unreadablePaths.length < row.unreadablePathCount ? (
							<div className="mt-2 text-[10.5px] text-ink-tertiary">
								Showing {row.unreadablePaths.length} of{" "}
								{row.unreadablePathCount} paths.
							</div>
						) : null}
					</div>
				</details>
			) : null}
		</div>
	);
}

type EditorState =
	| { mode: "add"; kind: LocationKind }
	| { mode: "edit"; row: SearchLocationRow };

function LocationEditorForm({
	editor,
	platform,
	onClose,
}: {
	editor: EditorState;
	platform: Platform;
	onClose: () => void;
}) {
	const settings = useSettingsStore((s) => s.settings);
	const distros = useSettingsStore((s) => s.distros);
	const addOrUpdateLocation = useSettingsStore((s) => s.addOrUpdateLocation);

	const kind = editor.mode === "add" ? editor.kind : editor.row.kind;
	const defaultDistro =
		distros.find((d) => d.isDefault)?.name ?? distros[0]?.name ?? null;

	const [path, setPath] = useState(
		editor.mode === "edit" ? editor.row.path : "",
	);
	const [distro, setDistro] = useState<string | null>(
		editor.mode === "edit"
			? editor.row.distro
			: kind === "wsl"
				? defaultDistro
				: null,
	);
	const [depth, setDepth] = useState(
		editor.mode === "edit"
			? editor.row.maxDepth
			: (settings?.defaultScanDepth ?? 3),
	);
	const [error, setError] = useState<string | null>(null);

	async function browse() {
		const picked = await open({ directory: true });
		if (typeof picked !== "string") return;
		if (platform === "macos") {
			setPath(picked);
			return;
		}
		const c = await classifyPath(picked);
		if (c.kind === "wsl") {
			setPath(c.linuxPath ?? picked);
			setDistro(c.distro);
		} else if (c.kind === "wslNeedsDistro") {
			setPath(c.linuxPath ?? picked);
		} else {
			setPath(c.windowsPath ?? picked);
		}
	}

	async function submit() {
		setError(null);
		if (!path.trim()) {
			setError("Enter a path or browse to a folder.");
			return;
		}
		if (platform === "macos") {
			await addOrUpdateLocation(
				{
					kind: "mac",
					path: path.trim(),
					distro: null,
					maxDepth: depth,
				},
				editor.mode === "edit" ? editor.row.id : undefined,
			);
			onClose();
			return;
		}

		const c = await classifyPath(path.trim());
		let loc: SearchLocation;
		if (kind === "wsl") {
			if (c.kind === "windows") {
				setError("That looks like a Windows path, not a WSL path.");
				return;
			}
			const resolvedDistro = c.kind === "wsl" ? c.distro : distro;
			if (!resolvedDistro) {
				setError("Pick a distro for this Linux path.");
				return;
			}
			loc = {
				kind: "wsl",
				path: c.linuxPath ?? path.trim(),
				distro: resolvedDistro,
				maxDepth: depth,
			};
		} else {
			if (c.kind !== "windows") {
				setError("That looks like a WSL path. Use Add WSL Location instead.");
				return;
			}
			loc = {
				kind: "windows",
				path: c.windowsPath ?? path.trim(),
				distro: null,
				maxDepth: depth,
			};
		}
		// pass the edited row's id so the rust upsert replaces it even if the path (and
		// thus the id) changed.
		const replaceId = editor.mode === "edit" ? editor.row.id : undefined;
		await addOrUpdateLocation(loc, replaceId);
		onClose();
	}

	return (
		<>
			<DialogHeader>
				<div className="flex items-center gap-2">
					{platform === "windows" ? <EnvBadge kind={kind} /> : null}
					<DialogTitle className="text-[13px] font-normal text-ink-body">
						{editor.mode === "add" ? "Add" : "Edit"}{" "}
						{platform === "macos"
							? "location"
							: `${kind === "wsl" ? "WSL" : "Windows"} location`}
					</DialogTitle>
				</div>
				<DialogDescription className="sr-only">
					{platform === "macos"
						? "Configure a search location."
						: kind === "wsl"
							? "Configure a WSL search location."
							: "Configure a Windows search location."}
				</DialogDescription>
			</DialogHeader>

			<div className="flex items-center gap-2">
				<Input
					value={path}
					onChange={(e) => setPath(e.target.value)}
					placeholder={
						platform === "macos"
							? "/Users/you/Projects"
							: kind === "wsl"
								? "/home/you/dev"
								: "C:\\Users\\you\\dev"
					}
					className="h-auto w-auto flex-1 rounded-[8px] border-hairline bg-black/20 px-3 py-2 font-mono text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
				/>
				<Button variant="outline" onClick={() => void browse()}>
					Browse…
				</Button>
			</div>

			{platform === "windows" && kind === "wsl" ? (
				<div className="flex items-center gap-2">
					<Label className="text-[12.5px] font-normal text-ink-secondary">
						Distro
					</Label>
					<Select
						value={distro ?? undefined}
						onValueChange={(v) => setDistro(v || null)}
					>
						<SelectTrigger
							aria-label="Distro"
							className="h-auto rounded-[8px] border-hairline bg-black/20 px-3 py-1.5 text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
						>
							<SelectValue
								placeholder={
									distros.length === 0 ? "No distros found" : "Select distro"
								}
							/>
						</SelectTrigger>
						<SelectContent position="popper" sideOffset={1}>
							{distros.map((d) => (
								<SelectItem key={d.name} value={d.name}>
									{d.name}
									{d.isDefault ? " (default)" : ""}
									{d.state === "stopped" ? " (stopped)" : ""}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}

			<div className="flex items-center gap-3 text-[12.5px] text-ink-secondary">
				<span>Scan depth</span>
				<Stepper value={depth} onChange={setDepth} label="scan depth" />
			</div>

			{error && <span className="text-[12px] text-danger-text">{error}</span>}

			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					Cancel
				</Button>
				<Button onClick={() => void submit()}>
					{editor.mode === "add" ? "Add Location" : "Save"}
				</Button>
			</DialogFooter>
		</>
	);
}

/** Stable remount key so each open seeds a fresh form (add vs edit, per-row). */
function editorKey(editor: EditorState): string {
	return editor.mode === "add" ? `add-${editor.kind}` : `edit-${editor.row.id}`;
}

/**
 * Hosts the add/edit form in a modal dialog. `editor` drives open state; the last
 * editor is retained through the close animation so the body doesn't blank out on the
 * way out, and a per-open key remounts the form so its fields reset each time.
 */
function LocationDialog({
	editor,
	platform,
	onClose,
}: {
	editor: EditorState | null;
	platform: Platform;
	onClose: () => void;
}) {
	const [rendered, setRendered] = useState<EditorState | null>(editor);
	const [openCount, setOpenCount] = useState(0);

	useEffect(() => {
		if (editor) {
			setRendered(editor);
			setOpenCount((n) => n + 1);
		}
	}, [editor]);

	return (
		<Dialog
			open={editor !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-md gap-3 bg-elevated">
				{rendered && (
					<LocationEditorForm
						key={`${editorKey(rendered)}-${openCount}`}
						editor={rendered}
						platform={platform}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function LocationGroup({
	label,
	rows,
	platform,
	onEdit,
}: {
	label: string;
	rows: SearchLocationRow[];
	platform: Platform;
	onEdit: (row: SearchLocationRow) => void;
}) {
	if (rows.length === 0) return null;
	return (
		<div className="flex flex-col gap-2.5">
			<SectionLabel>{label}</SectionLabel>
			<Card>
				{rows.map((row) => (
					<LocationCard
						key={row.id}
						row={row}
						platform={platform}
						onEdit={() => onEdit(row)}
					/>
				))}
			</Card>
		</div>
	);
}

export function SearchLocations() {
	const settings = useSettingsStore((s) => s.settings);
	const rows = useSettingsStore((s) => s.rows);
	const setNested = useSettingsStore((s) => s.setNested);
	const setDefaultDepth = useSettingsStore((s) => s.setDefaultDepth);
	const rescan = useSettingsStore((s) => s.rescan);
	const platform = useSettingsStore((s) => s.platform);
	const action = useSettingsStore((s) => s.action);
	const clearAction = useSettingsStore((s) => s.clearAction);

	const [editor, setEditor] = useState<EditorState | null>(null);

	useEffect(() => {
		if (action !== "addLocation" || !platform) return;
		setEditor({
			mode: "add",
			kind: platform === "macos" ? "mac" : "windows",
		});
		clearAction();
	}, [action, clearAction, platform]);

	if (!settings || !platform) return null;

	const groups =
		platform === "macos"
			? [
					{
						label: "Locations",
						kind: "mac" as const,
						rows,
					},
				]
			: [
					{
						label: "WSL locations",
						kind: "wsl" as const,
						rows: rows.filter((r) => r.kind === "wsl"),
					},
					{
						label: "Windows locations",
						kind: "windows" as const,
						rows: rows.filter((r) => r.kind === "windows"),
					},
					...(rows.some((r) => !isLocationKindSupported(platform, r.kind))
						? [
								{
									label: "Other platforms",
									kind: "mac" as const,
									rows: rows.filter(
										(r) => !isLocationKindSupported(platform, r.kind),
									),
								},
							]
						: []),
				];
	const addOptions =
		platform === "macos"
			? [{ label: "Add Location", kind: "mac" as const }]
			: [
					{ label: "Add WSL Location", kind: "wsl" as const },
					{ label: "Add Windows Location", kind: "windows" as const },
				];
	const totalProjects = rows.reduce((sum, r) => sum + r.projectCount, 0);
	const lastScanAt = rows.reduce<number | null>(
		(latest, r) =>
			r.lastScanAt && (!latest || r.lastScanAt > latest)
				? r.lastScanAt
				: latest,
		null,
	);

	return (
		<div className="flex flex-col gap-6 p-[26px_30px]">
			<div className="flex items-center justify-between">
				<div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
					Search Locations
				</div>
				<div className="flex items-center gap-3">
					<div className="font-mono text-[11px] text-ink-tertiary">
						{totalProjects} {totalProjects === 1 ? "project" : "projects"}
						{lastScanAt
							? ` · scanned ${formatRelativeTime(lastScanAt, Date.now())}`
							: ""}
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void rescan()}
						disabled={rows.length === 0}
					>
						<RotateCw size={12} strokeWidth={2} />
						Rescan all
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-2.5">
				<SectionLabel>Global discovery</SectionLabel>
				<Card>
					<div className="flex items-center justify-between gap-5 px-[18px] py-[15px]">
						<div>
							<div className="text-[14px] text-ink-body">
								Include nested projects / packages
							</div>
							<div className="mt-[3px] text-[12.5px] text-ink-secondary">
								Off opens the monorepo root. On also indexes inner packages.
							</div>
						</div>
						<Switch
							checked={settings.includeNestedProjects}
							onCheckedChange={(v) => void setNested(v)}
							aria-label="Include nested projects"
						/>
					</div>
					<div className="flex items-center justify-between gap-5 border-t border-white/[0.055] px-[18px] py-[15px]">
						<div>
							<div className="text-[14px] text-ink-body">
								Default scan depth for new locations
							</div>
							<div className="mt-[3px] text-[12.5px] text-ink-secondary">
								How many folders deep to look for project markers.
							</div>
						</div>
						<Stepper
							value={settings.defaultScanDepth}
							onChange={(v) => void setDefaultDepth(v)}
							label="default scan depth"
						/>
					</div>
				</Card>
			</div>

			{groups.map((group) => (
				<LocationGroup
					key={group.kind}
					label={group.label}
					rows={group.rows}
					platform={platform}
					onEdit={(row) => setEditor({ mode: "edit", row })}
				/>
			))}

			<div className="flex gap-2.5">
				{addOptions.map((option) => (
					<Button
						key={option.kind}
						variant="outline"
						onClick={() => setEditor({ mode: "add", kind: option.kind })}
					>
						<span className="text-[15px] leading-none">+</span>
						{option.label}
					</Button>
				))}
			</div>

			<LocationDialog
				editor={editor}
				platform={platform}
				onClose={() => setEditor(null)}
			/>
		</div>
	);
}
