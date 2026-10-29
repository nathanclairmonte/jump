// the Shortcuts panel: rebind the global hotkey (record a combo, save, report success or
// conflict) and a static reference of the launcher's built-in keys. the authoritative
// parse/validate/registration lives in rust (commands::rebind_hotkey); this records a combo
// and renders status.

import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	getHotkeyStatus,
	type HotkeyStatus,
	type Platform,
	rebindHotkey,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionLabel } from "../components";
import {
	type AssembledCombo,
	comboFromEvent,
	formatCombo,
	splitCombo,
} from "../hotkey-display";
import { useSettingsStore } from "../store";

/** A combo's per-key pills, separated by `+`; `trailing` appends e.g. a recording ellipsis. */
function ComboPills({
	tokens,
	platform,
	trailing,
}: {
	tokens: string[];
	platform: Platform;
	trailing?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-[7px]">
			{tokens.map((tok, i) => (
				// tokens within a canonical combo are unique (modifiers deduped + one key).
				<span key={tok} className="flex items-center gap-[7px]">
					{i > 0 && platform === "windows" ? (
						<span className="text-[#5f5d58]">+</span>
					) : null}
					<span className="text-[#dedcd7]">{tok}</span>
				</span>
			))}
			{trailing}
		</div>
	);
}

/** A recessed box rendering a combo's per-key pills, separated by `+` like the design. */
function ComboKeys({
	tokens,
	platform,
}: {
	tokens: string[];
	platform: Platform;
}) {
	return (
		<div className="rounded-[8px] border border-white/[0.07] bg-black/[0.24] px-3 py-1.5 font-mono text-[12px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]">
			<ComboPills tokens={tokens} platform={platform} />
		</div>
	);
}

/** The registration status chip: green when bound, amber when a conflict left it unregistered. */
function StatusChip({ registered }: { registered: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-[6px] text-[11.5px]",
				registered ? "text-success" : "text-warning",
			)}
		>
			<span
				className={cn(
					"size-[7px] rounded-full",
					registered ? "bg-success" : "bg-warning",
				)}
			/>
			{registered ? "Registered" : "Not registered"}
		</span>
	);
}

/** The editable global-shortcut card: shows the bound combo, or a live recorder while changing. */
function GlobalShortcutCard() {
	const settingsHotkey = useSettingsStore((s) => s.settings?.hotkey);
	const platform = useSettingsStore((s) => s.platform);
	// the card renders before `load` resolves, so pills need a host to format against.
	const displayPlatform = platform ?? "windows";
	const [status, setStatus] = useState<HotkeyStatus | null>(null);
	const [recording, setRecording] = useState(false);
	const [draft, setDraft] = useState<AssembledCombo | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const recorderRef = useRef<HTMLButtonElement>(null);

	const refreshStatus = useCallback(() => {
		void getHotkeyStatus()
			.then(setStatus)
			.catch(() => {});
	}, []);

	// fetch on mount and whenever the bound combo changes (e.g. another window rebound it).
	// biome-ignore lint/correctness/useExhaustiveDependencies: settingsHotkey is an intentional re-fetch trigger though the body doesn't read it.
	useEffect(() => {
		refreshStatus();
	}, [refreshStatus, settingsHotkey]);

	// focus the recorder when recording starts so it captures keystrokes immediately.
	useEffect(() => {
		if (recording) recorderRef.current?.focus();
	}, [recording]);

	function startRecording() {
		setError(null);
		setDraft(null);
		setRecording(true);
	}

	function cancelRecording() {
		setRecording(false);
		setDraft(null);
		setError(null);
	}

	function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
		// swallow every key while recording so combos never leak into the app (and Tab can't
		// move focus out of the recorder mid-capture).
		e.preventDefault();
		e.stopPropagation();
		// the Escape key cancels recording rather than binding, matching the editor-shortcut
		// convention.
		if (e.code === "Escape") {
			cancelRecording();
			return;
		}
		setError(null);
		setDraft(comboFromEvent(e));
	}

	async function save() {
		if (!draft?.complete || draft.needsModifier) return;
		setSaving(true);
		setError(null);
		try {
			const next = await rebindHotkey(draft.combo);
			setStatus(next);
			setRecording(false);
			setDraft(null);
			toast("Shortcut updated", {
				description: `Open launcher is now ${formatCombo(next.combo, displayPlatform)}.`,
			});
		} catch (err) {
			// a conflict (or invalid combo) keeps the old hotkey bound; surface it and let the
			// user record a different combo or cancel.
			setError(String(err));
		} finally {
			setSaving(false);
		}
	}

	const canSave = !!draft && draft.complete && !draft.needsModifier && !saving;
	const boundTokens = status ? splitCombo(status.combo, displayPlatform) : [];
	const draftTokens = draft ? splitCombo(draft.combo, displayPlatform) : [];

	return (
		<div className="flex flex-col gap-2.5">
			<SectionLabel>Global shortcut</SectionLabel>
			<Card>
				<div className="flex items-center justify-between gap-5 px-[18px] py-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2.5">
							<span className="text-[14px] text-ink-body">Open launcher</span>
							{status && <StatusChip registered={status.registered} />}
						</div>
						<div className="mt-[3px] text-[12.5px] text-ink-secondary">
							Press anywhere to summon Jump.
						</div>
						{error && (
							<div className="mt-2 text-[12px] text-danger-text">{error}</div>
						)}
					</div>

					{recording ? (
						<div className="flex flex-none items-center gap-2.5">
							{/* a native button so it's focusable and captures the recorded combo;
							    onKeyDown preventDefault stops Space/Enter from activating it. */}
							<button
								type="button"
								ref={recorderRef}
								aria-label="Record a new shortcut"
								onKeyDown={onKeyDown}
								onBlur={cancelRecording}
								className="flex min-w-[140px] cursor-default items-center justify-center rounded-[8px] border border-accent-orange/40 bg-black/[0.24] px-3 py-1.5 font-mono text-[12px] outline-none ring-2 ring-accent-orange/20"
							>
								{draftTokens.length > 0 ? (
									<ComboPills
										tokens={draftTokens}
										platform={displayPlatform}
										trailing={
											!draft?.complete && (
												<span className="text-[#5f5d58]">…</span>
											)
										}
									/>
								) : (
									<span className="text-ink-tertiary">Press a shortcut…</span>
								)}
							</button>
							{/* preventDefault on mousedown keeps focus on the recorder, so its onBlur
							    (cancelRecording) doesn't fire and tear this button down before the click
							    can commit the rebind. */}
							<Button
								size="sm"
								disabled={!canSave}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => void save()}
							>
								Save
							</Button>
							<Button size="sm" variant="outline" onClick={cancelRecording}>
								Cancel
							</Button>
						</div>
					) : (
						<div className="flex flex-none items-center gap-2.5">
							<ComboKeys tokens={boundTokens} platform={displayPlatform} />
							<Button variant="outline" onClick={startRecording}>
								Change
							</Button>
						</div>
					)}
				</div>
				{recording && draft?.needsModifier && (
					<div className="border-t border-white/[0.055] px-[18px] py-2.5 text-[12px] text-warning">
						{platform === "macos"
							? "Add a modifier (⌃, ⌥, ⇧, or ⌘) to the shortcut."
							: "Add a modifier (Ctrl, Alt, Shift, or Win) to the shortcut."}
					</div>
				)}
			</Card>
		</div>
	);
}

// the launcher's built-in keys, fixed and not user-configurable, transcribed from the design.
const REFERENCE: { label: string; keys: string }[] = [
	{ label: "Open selected project", keys: "↵ Enter" },
	{ label: "Open action menu", keys: "Tab" },
	{ label: "Close menu · hide launcher", keys: "Esc" },
	{ label: "Move selection", keys: "↑ ↓" },
	{ label: "Reorder pinned projects", keys: "Drag" },
];

/** The read-only reference of the launcher's built-in shortcuts. */
function ReferenceCard() {
	return (
		<div className="flex flex-col gap-2.5">
			<SectionLabel>In-launcher shortcuts · reference</SectionLabel>
			<Card>
				{REFERENCE.map((row, i) => (
					<div
						key={row.label}
						className={cn(
							"flex items-center justify-between px-[18px] py-[13px]",
							i > 0 && "border-t border-white/[0.05]",
						)}
					>
						<span className="text-[13px] text-ink-body/90">{row.label}</span>
						<span className="rounded-[6px] border border-white/[0.09] bg-white/[0.05] px-[9px] py-[3px] font-mono text-[11px] text-ink-body">
							{row.keys}
						</span>
					</div>
				))}
			</Card>
		</div>
	);
}

export function Shortcuts() {
	return (
		<div className="flex flex-col gap-6 p-[26px_30px]">
			<div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
				Shortcuts
			</div>
			<GlobalShortcutCard />
			<ReferenceCard />
		</div>
	);
}
