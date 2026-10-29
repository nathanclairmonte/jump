// the live Editors panel: a default-editor segmented control plus a per-editor card with
// live detection, a base-command override (edited in a modal), and per-environment Test
// launch buttons whose results are ephemeral (detection is recomputed, never
// persisted; validation is not stored). resolution + launch happen server-side.

import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
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
import {
	detectEditors,
	type EditorDetection,
	type EditorKind,
	type LocationKind,
	type Platform,
	type TestResult,
	testLaunch,
} from "@/lib/api";
import { EDITOR_KINDS, editorLabel } from "@/lib/editors";
import { cn } from "@/lib/utils";
import { SectionLabel } from "../components";
import { useSettingsStore } from "../store";

/** Detection state (Detected / Not detected) chip. */
function DetectionChip({ detected }: { detected: boolean }) {
	return (
		<Badge
			variant="ghost"
			className={cn(
				"flex-none rounded-badge border px-2 py-[3px] text-[11.5px] font-normal",
				detected
					? "border-success-border bg-success-bg text-success"
					: "border-warning-border bg-warning-bg text-warning",
			)}
		>
			{detected ? "Detected" : "Not detected"}
		</Badge>
	);
}

/** The transient outcome line for a Test launch (in-session only). */
function TestStatus({ state }: { state: TestRunState | undefined }) {
	if (!state) return null;
	if (state.pending) {
		return <span className="text-[12px] text-ink-tertiary">Testing…</span>;
	}
	const r = state.result;
	if (!r) return null;
	return (
		<span
			className={cn("text-[12px]", r.ok ? "text-success" : "text-danger-text")}
			title={r.detail}
		>
			{r.ok ? "✓ Launched" : `✗ ${r.detail}`}
		</span>
	);
}

type TestRunState = { pending: boolean; result?: TestResult };
type TestKey = `${EditorKind}:${LocationKind}`;

function EditorCard({
	kind,
	detection,
	isDefault,
	onTest,
	testState,
	onEdit,
	wslAvailable,
	platform,
}: {
	kind: EditorKind;
	detection: EditorDetection | undefined;
	isDefault: boolean;
	onTest: (env: LocationKind) => void;
	testState: (env: LocationKind) => TestRunState | undefined;
	onEdit: () => void;
	wslAvailable: boolean;
	platform: Platform;
}) {
	const detected = detection?.detected ?? false;
	// what we'd actually launch: the resolved exe (probe or override). honest about misses.
	const commandLine = detection?.resolvedPath ?? "not found";

	return (
		<Card className="overflow-hidden">
			<div className="flex items-center justify-between gap-4 px-[18px] py-[15px]">
				<div className="min-w-0">
					<div className="flex items-center gap-2.5">
						<span className="text-[14.5px] font-semibold text-ink">
							{editorLabel(kind)}
						</span>
						{isDefault ? (
							<span className="rounded-[5px] border border-accent-orange/25 bg-accent-orange/15 px-1.5 py-0.5 font-mono text-[10px] text-accent-soft">
								DEFAULT
							</span>
						) : null}
					</div>
					<div className="mt-1 truncate font-mono text-[12px] text-ink-tertiary">
						{commandLine}
					</div>
				</div>
				<DetectionChip detected={detected} />
			</div>

			<div className="flex items-center justify-between gap-4 border-t border-white/[0.055] px-[18px] py-[13px]">
				{/* only Windows has more than one environment to launch into, so it is the one
				    host that earns per-environment test buttons; every other footer is a status
				    line plus the same Edit affordance. */}
				{detected && platform === "windows" ? (
					<>
						<div className="flex min-w-0 items-center gap-3">
							<TestStatus state={testState("windows")} />
							<TestStatus state={testState("wsl")} />
						</div>
						<div className="flex flex-none items-center gap-1.5">
							<Button
								variant="outline"
								size="sm"
								onClick={() => onTest("windows")}
								disabled={testState("windows")?.pending}
							>
								Test Windows
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => onTest("wsl")}
								disabled={!wslAvailable || testState("wsl")?.pending}
								title={wslAvailable ? undefined : "No WSL distro found"}
							>
								Test WSL
							</Button>
							<Button variant="outline" size="sm" onClick={onEdit}>
								Edit
							</Button>
						</div>
					</>
				) : (
					<>
						<span className="text-[12px] text-ink-tertiary">
							{detected
								? "Ready to open projects."
								: `Install ${editorLabel(kind)} or point Jump at its command to enable.`}
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={onEdit}
							className="flex-none"
						>
							{detected ? "Edit" : "Edit command"}
						</Button>
					</>
				)}
			</div>
		</Card>
	);
}

/** The base-command override editor, in a modal. Mirrors the Search Locations dialog. */
function CommandDialog({
	kind,
	detection,
	platform,
	onClose,
	onCommitted,
}: {
	kind: EditorKind;
	detection: EditorDetection | undefined;
	platform: Platform;
	onClose: () => void;
	// fired only after a save/reset that actually changed the command, so the parent re-probes
	// detection then and not on a plain Cancel/dismiss.
	onCommitted: () => void;
}) {
	const settings = useSettingsStore((s) => s.settings);
	const setEditorCommand = useSettingsStore((s) => s.setEditorCommand);
	const current = settings?.editors[kind]?.command ?? "";
	const [command, setCommand] = useState(current);

	async function browse() {
		const picked = await open({
			multiple: false,
			directory: false,
			filters:
				platform === "macos"
					? [
							{ name: "Applications", extensions: ["app"] },
							{ name: "Executables", extensions: ["*"] },
						]
					: [{ name: "Programs", extensions: ["exe"] }],
		});
		if (typeof picked === "string") setCommand(picked);
	}

	async function save() {
		await setEditorCommand(kind, command.trim() ? command.trim() : null);
		onCommitted();
		onClose();
	}

	async function reset() {
		await setEditorCommand(kind, null);
		onCommitted();
		onClose();
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle className="text-[13px] font-normal text-ink-body">
					{editorLabel(kind)} command
				</DialogTitle>
				<DialogDescription className="text-[12px] text-ink-tertiary">
					{platform === "macos"
						? "Override the application or executable Jump launches. Leave blank to auto-detect."
						: "Override the executable Jump launches. Leave blank to auto-detect."}
				</DialogDescription>
			</DialogHeader>

			<div className="font-mono text-[11.5px] text-ink-tertiary">
				Detected: {detection?.resolvedPath ?? "not found"}
			</div>

			<div className="flex items-center gap-2">
				<Input
					value={command}
					onChange={(e) => setCommand(e.target.value)}
					placeholder={
						platform === "macos"
							? "/Applications/Editor.app"
							: "C:\\Path\\To\\Editor.exe"
					}
					className="h-auto w-auto flex-1 rounded-[8px] border-hairline bg-black/20 px-3 py-2 font-mono text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
				/>
				<Button variant="outline" onClick={() => void browse()}>
					Browse…
				</Button>
			</div>

			<DialogFooter className="items-center justify-between">
				<Button
					variant="ghost"
					onClick={() => void reset()}
					className="text-ink-tertiary"
				>
					Reset to detected
				</Button>
				<div className="flex items-center gap-1.5">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button onClick={() => void save()}>Save</Button>
				</div>
			</DialogFooter>
		</>
	);
}

export function Editors() {
	const settings = useSettingsStore((s) => s.settings);
	const distros = useSettingsStore((s) => s.distros);
	const setDefaultEditor = useSettingsStore((s) => s.setDefaultEditor);
	const platform = useSettingsStore((s) => s.platform);

	const [detections, setDetections] = useState<EditorDetection[]>([]);
	const [tests, setTests] = useState<Partial<Record<TestKey, TestRunState>>>(
		{},
	);
	const [editing, setEditing] = useState<EditorKind | null>(null);

	// detection is live (never persisted), so recompute on mount and after a command edit.
	const refreshDetections = useCallback(() => {
		void detectEditors().then(setDetections);
	}, []);

	useEffect(() => {
		refreshDetections();
	}, [refreshDetections]);

	if (!settings || !platform) return null;

	const det = (kind: EditorKind) => detections.find((d) => d.kind === kind);
	const wslAvailable = distros.length > 0;

	async function runTest(kind: EditorKind, env: LocationKind) {
		const key: TestKey = `${kind}:${env}`;
		setTests((t) => ({ ...t, [key]: { pending: true } }));
		try {
			const result = await testLaunch(kind, env);
			setTests((t) => ({ ...t, [key]: { pending: false, result } }));
		} catch (err) {
			setTests((t) => ({
				...t,
				[key]: { pending: false, result: { ok: false, detail: String(err) } },
			}));
		}
	}

	return (
		<div className="flex flex-col gap-6 p-[26px_30px]">
			<div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
				Editors
			</div>

			<div className="flex flex-col gap-2.5">
				<SectionLabel>Default editor</SectionLabel>
				<div className="inline-flex gap-0.5 self-start rounded-[9px] border border-hairline bg-white/[0.04] p-[3px]">
					{EDITOR_KINDS.map((kind) => {
						const active = settings.defaultEditor === kind;
						return (
							<button
								key={kind}
								type="button"
								onClick={() => void setDefaultEditor(kind)}
								className={cn(
									"rounded-[7px] px-4 py-[7px] text-[13px] transition-colors",
									active
										? "bg-[#2e2a25] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
										: "text-ink-secondary hover:text-ink-body",
								)}
							>
								{editorLabel(kind)}
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex flex-col gap-2.5">
				<SectionLabel>Supported editors</SectionLabel>
				<div className="flex flex-col gap-2.5">
					{EDITOR_KINDS.map((kind) => (
						<EditorCard
							key={kind}
							kind={kind}
							detection={det(kind)}
							isDefault={settings.defaultEditor === kind}
							onTest={(env) => void runTest(kind, env)}
							testState={(env) => tests[`${kind}:${env}`]}
							onEdit={() => setEditing(kind)}
							wslAvailable={wslAvailable}
							platform={platform}
						/>
					))}
				</div>
			</div>

			<Dialog
				open={editing !== null}
				onOpenChange={(open) => {
					if (!open) setEditing(null);
				}}
			>
				<DialogContent className="max-w-md gap-3 bg-elevated">
					{editing && (
						<CommandDialog
							key={editing}
							kind={editing}
							detection={det(editing)}
							platform={platform}
							onClose={() => setEditing(null)}
							// a command change can flip detection; re-probe only when it changed.
							onCommitted={refreshDetections}
						/>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
