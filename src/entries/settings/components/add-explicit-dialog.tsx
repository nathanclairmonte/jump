// the "Add Explicit Project" editor (Projects panel). an explicit project always appears in the
// index even when no Search Location's scan would find it. mirrors the Search-Locations add flow
// (browse/classify/distro-pick) but without a scan depth: a single folder, not a tree.

import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import {
	type ClassifyResult,
	classifyPath,
	type ExplicitProject,
	type Platform,
} from "@/lib/api";
import { useSettingsStore } from "../store";

function AddExplicitForm({
	platform,
	onClose,
}: {
	platform: Platform;
	onClose: () => void;
}) {
	const distros = useSettingsStore((s) => s.distros);
	const addExplicitProject = useSettingsStore((s) => s.addExplicitProject);
	const defaultDistro =
		distros.find((d) => d.isDefault)?.name ?? distros[0]?.name ?? null;

	const [path, setPath] = useState("");
	// only relevant for a bare Linux path (a UNC path carries its own distro). null until the
	// user picks; we fall back to defaultDistro at use so a late distro load still preselects.
	const [distro, setDistro] = useState<string | null>(null);
	// the backend's classification of the current path, kept so the distro picker shows exactly
	// when submit will demand a distro (driving it off a parallel regex would let the two drift).
	const [classified, setClassified] = useState<ClassifyResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// re-classify on a short debounce as the path is typed; browse() seeds it directly below.
	useEffect(() => {
		if (platform === "macos") return;
		const trimmed = path.trim();
		if (!trimmed) {
			setClassified(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void classifyPath(trimmed)
				.then((c) => {
					if (!cancelled) setClassified(c);
				})
				// a classify failure just clears the classification (no distro picker); submit
				// re-classifies and surfaces the error there rather than leaving a dangling reject.
				.catch(() => {
					if (!cancelled) setClassified(null);
				});
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [path, platform]);

	async function browse() {
		const picked = await open({ directory: true });
		if (typeof picked !== "string") return;
		if (platform === "macos") {
			setPath(picked);
			return;
		}
		const c = await classifyPath(picked);
		setClassified(c);
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
		const trimmed = path.trim();
		if (!trimmed) {
			setError("Enter a path or browse to a folder.");
			return;
		}
		if (platform === "macos") {
			setBusy(true);
			try {
				await addExplicitProject({ kind: "mac", path: trimmed, distro: null });
				onClose();
			} catch (err) {
				setError(String(err));
			} finally {
				setBusy(false);
			}
			return;
		}

		let c: ClassifyResult;
		try {
			c = await classifyPath(trimmed);
		} catch (err) {
			// a classify failure (e.g. a transient WSL probe error) must surface, not vanish as
			// an unhandled rejection that leaves the dialog silently inert.
			setError(String(err));
			return;
		}
		let project: ExplicitProject;
		if (c.kind === "windows") {
			project = {
				kind: "windows",
				path: c.windowsPath ?? trimmed,
				distro: null,
			};
		} else {
			// wsl or wslNeedsDistro: a UNC path carries its distro; a bare Linux path needs the pick.
			const resolvedDistro =
				c.kind === "wsl" ? c.distro : (distro ?? defaultDistro);
			if (!resolvedDistro) {
				setError("Pick a distro for this Linux path.");
				return;
			}
			project = {
				kind: "wsl",
				path: c.linuxPath ?? trimmed,
				distro: resolvedDistro,
			};
		}
		setBusy(true);
		try {
			// the backend verifies the folder exists; a typo'd path rejects here.
			await addExplicitProject(project);
			onClose();
		} catch (err) {
			setError(String(err));
		} finally {
			setBusy(false);
		}
	}

	// a bare Linux path (no embedded distro) is the only case needing the distro picker, decided
	// by the backend's own classification rather than a regex that could diverge from it.
	const needsDistro =
		platform === "windows" && classified?.kind === "wslNeedsDistro";

	return (
		<>
			<DialogHeader>
				<DialogTitle className="text-[13px] font-normal text-ink-body">
					Add explicit project
				</DialogTitle>
				<DialogDescription className="text-[12px] text-ink-tertiary">
					Always shows in the launcher, even if a scan wouldn't find it (no
					marker, or outside your search locations).
				</DialogDescription>
			</DialogHeader>

			<div className="flex items-center gap-2">
				<Input
					value={path}
					onChange={(e) => setPath(e.target.value)}
					placeholder={
						platform === "macos"
							? "/Users/you/Projects/notes"
							: "/home/you/notes  or  C:\\Users\\you\\notes"
					}
					className="h-auto w-auto flex-1 rounded-[8px] border-hairline bg-black/20 px-3 py-2 font-mono text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
				/>
				<Button variant="outline" onClick={() => void browse()}>
					Browse…
				</Button>
			</div>

			{needsDistro && (
				<div className="flex items-center gap-2">
					<Label className="text-[12.5px] font-normal text-ink-secondary">
						Distro
					</Label>
					<Select
						value={distro ?? defaultDistro ?? undefined}
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
			)}

			{error && <span className="text-[12px] text-danger-text">{error}</span>}

			<DialogFooter>
				<Button variant="outline" onClick={onClose} disabled={busy}>
					Cancel
				</Button>
				<Button onClick={() => void submit()} disabled={busy}>
					{busy ? "Adding…" : "Add Project"}
				</Button>
			</DialogFooter>
		</>
	);
}

/** Hosts the add form in a dialog, remounting per open so fields reset. */
export function AddExplicitDialog({
	open,
	platform,
	onClose,
}: {
	open: boolean;
	platform: Platform;
	onClose: () => void;
}) {
	// per-open remount key so the form's fields reset each time (mirrors LocationDialog).
	const [openCount, setOpenCount] = useState(0);
	useEffect(() => {
		if (open) setOpenCount((n) => n + 1);
	}, [open]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-w-md gap-3 bg-elevated">
				{open && (
					<AddExplicitForm
						key={openCount}
						platform={platform}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
