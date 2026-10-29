// the rich per-project editor (Projects table: "Edit details…"). a single surface for the
// free-text metadata (alias plus tags) and the color and editor-override pickers, so the table
// row itself stays a clean display row. each field commits its own field-scoped command on Save,
// only when it actually changed, so we don't fire redundant writes.

import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
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
	PROJECT_COLORS,
	SPINE_CLASS,
} from "@/entries/launcher/components/project-spine";
import type { EditorKind, ProjectColor } from "@/lib/api";
import { EDITOR_KINDS, editorLabel } from "@/lib/editors";
import { cn } from "@/lib/utils";
import type { ProjectRow } from "../projects-model";
import { useSettingsStore } from "../store";

// editor override is stored as null (= use global default); the Select needs a string sentinel.
const DEFAULT_EDITOR = "default";

/** Compares two tag lists for equality (order-sensitive, since the editor preserves order). */
function sameTags(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Whether a tag is already present, matched case-insensitively (mirrors backend normalize_tags). */
function hasTag(tags: string[], candidate: string): boolean {
	return tags.some((t) => t.toLowerCase() === candidate.toLowerCase());
}

export function ProjectEditForm({
	row,
	onClose,
}: {
	row: ProjectRow;
	onClose: () => void;
}) {
	const setProjectAlias = useSettingsStore((s) => s.setProjectAlias);
	const setProjectTags = useSettingsStore((s) => s.setProjectTags);
	const setProjectColor = useSettingsStore((s) => s.setProjectColor);
	const setProjectEditorOverride = useSettingsStore(
		(s) => s.setProjectEditorOverride,
	);

	const [alias, setAlias] = useState(row.alias ?? "");
	const [tags, setTags] = useState<string[]>(row.tags);
	const [draft, setDraft] = useState("");
	const [color, setColor] = useState<ProjectColor | null>(row.color);
	const [editor, setEditor] = useState<EditorKind | null>(
		row.editorOverride as EditorKind | null,
	);

	function addDraftTag() {
		const trimmed = draft.trim();
		if (!trimmed) return;
		if (!hasTag(tags, trimmed)) {
			setTags([...tags, trimmed]);
		}
		setDraft("");
	}

	function onDraftKeyDown(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			addDraftTag();
		} else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
			// backspace on an empty draft peels off the last chip.
			setTags(tags.slice(0, -1));
		}
	}

	async function save() {
		// fold a pending draft into the saved set so a half-typed tag isn't lost.
		const finalTags = (() => {
			const trimmed = draft.trim();
			if (trimmed && !hasTag(tags, trimmed)) {
				return [...tags, trimmed];
			}
			return tags;
		})();
		const nextAlias = alias.trim() || null;

		// fire only the fields that changed (each is its own field-scoped command).
		const ops: Promise<void>[] = [];
		if (nextAlias !== (row.alias ?? null))
			ops.push(setProjectAlias(row.id, nextAlias));
		if (!sameTags(finalTags, row.tags))
			ops.push(setProjectTags(row.id, finalTags));
		if (color !== row.color) ops.push(setProjectColor(row.id, color));
		if (editor !== (row.editorOverride as EditorKind | null))
			ops.push(setProjectEditorOverride(row.id, editor));
		await Promise.all(ops);
		onClose();
	}

	return (
		<>
			{/* min-w-0 lets the grid column shrink to the dialog width so the nowrap path truncates
			    instead of blowing the column (and every field) past the panel's max-width. */}
			<DialogHeader className="min-w-0">
				<DialogTitle className="text-[14px] font-medium text-ink">
					{row.displayName}
				</DialogTitle>
				<DialogDescription className="truncate font-mono text-[11.5px] text-ink-tertiary">
					{row.path}
				</DialogDescription>
			</DialogHeader>

			<div className="flex flex-col gap-1.5">
				<Label className="text-[12.5px] font-normal text-ink-secondary">
					Alias
				</Label>
				<Input
					value={alias}
					onChange={(e) => setAlias(e.target.value)}
					placeholder={row.name}
					className="h-auto w-full rounded-[8px] border-hairline bg-black/20 px-3 py-2 text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label className="text-[12.5px] font-normal text-ink-secondary">
					Tags
				</Label>
				<div className="flex flex-wrap items-center gap-1.5 rounded-[8px] border border-hairline bg-black/20 px-2 py-2">
					{tags.map((tag) => (
						<span
							key={tag}
							className="flex items-center gap-1 rounded-badge bg-white/[0.06] py-[2px] pr-1 pl-2 text-[12px] text-ink-body"
						>
							{tag}
							<button
								type="button"
								aria-label={`Remove tag ${tag}`}
								onClick={() => setTags(tags.filter((t) => t !== tag))}
								className="rounded-[4px] p-0.5 text-ink-tertiary hover:bg-white/10 hover:text-ink"
							>
								<X size={11} strokeWidth={2.2} />
							</button>
						</span>
					))}
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={onDraftKeyDown}
						onBlur={addDraftTag}
						placeholder={tags.length === 0 ? "Add tags…" : ""}
						className="min-w-20 flex-1 bg-transparent text-[13px] text-ink-body outline-none placeholder:text-ink-faint"
					/>
				</div>
			</div>

			<div className="flex items-center justify-between gap-4">
				<Label className="text-[12.5px] font-normal text-ink-secondary">
					Color
				</Label>
				<div className="flex items-center gap-1.5">
					{PROJECT_COLORS.map((c) => (
						<button
							key={c}
							type="button"
							aria-label={`Set color ${c}`}
							onClick={() => setColor(c)}
							className={cn(
								"h-5 w-5 rounded-[6px] transition-transform",
								SPINE_CLASS[c],
								color === c
									? "ring-2 ring-white/70 ring-offset-2 ring-offset-elevated"
									: "opacity-80 hover:opacity-100",
							)}
						/>
					))}
					<button
						type="button"
						aria-label="Unset color"
						onClick={() => setColor(null)}
						className={cn(
							"h-5 w-5 rounded-[6px] border border-white/20 transition-transform",
							color === null
								? "ring-2 ring-white/70 ring-offset-2 ring-offset-elevated"
								: "hover:border-white/40",
						)}
					/>
				</div>
			</div>

			<div className="flex items-center justify-between gap-4">
				<Label className="text-[12.5px] font-normal text-ink-secondary">
					Editor override
				</Label>
				<Select
					value={editor ?? DEFAULT_EDITOR}
					onValueChange={(v) =>
						setEditor(v === DEFAULT_EDITOR ? null : (v as EditorKind))
					}
				>
					<SelectTrigger
						aria-label="Editor override"
						className="h-auto rounded-[8px] border-hairline bg-black/20 px-3 py-1.5 text-[13px] text-ink-body focus-visible:border-white/20 focus-visible:ring-0"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" sideOffset={1}>
						<SelectItem value={DEFAULT_EDITOR}>Default</SelectItem>
						{EDITOR_KINDS.map((k) => (
							<SelectItem key={k} value={k}>
								{editorLabel(k)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					Cancel
				</Button>
				<Button onClick={() => void save()}>Save</Button>
			</DialogFooter>
		</>
	);
}
