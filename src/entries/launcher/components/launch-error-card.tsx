import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { EditorKind } from "@/lib/api";
import { editorLabel } from "@/lib/editors";
import type { LaunchErrorState } from "../store";

interface LaunchErrorCardProps {
	error: LaunchErrorState;
	// true while a launch is in flight, so the fallback buttons disable and the picked one
	// reads "Opening…" instead of stacking a second attempt.
	pending: boolean;
	// one-shot fallback: open this project in the chosen (installed) editor without changing
	// the saved editor.
	onOpenWith: (editor: EditorKind) => void;
	// deep-link to Settings -> Editors.
	onEditorSettings: () => void;
}

/**
 * The inline launch-failure card, rendered directly beneath the row that failed to open.
 * Clay-red per the design; the launcher stays open so the user can pick a fallback. Fallbacks
 * are offered only for editors detection found installed (the failed one excluded), so a
 * fallback can't dead-end on a missing editor. They are user actions, never a silent editor
 * switch.
 */
export function LaunchErrorCard({
	error,
	pending,
	onOpenWith,
	onEditorSettings,
}: LaunchErrorCardProps) {
	// which fallback the user clicked, so only that one reads "Opening…". once the launch
	// settles (a new failure replaces this card; success unmounts it) the marker clears.
	const [opening, setOpening] = useState<EditorKind | null>(null);
	useEffect(() => {
		if (!pending) setOpening(null);
	}, [pending]);

	return (
		<div className="mx-1 mt-1.5 mb-1 flex items-center justify-between gap-4 rounded-row border border-danger-border bg-danger-bg px-3.75 py-3.25">
			<div className="flex min-w-0 items-center gap-2.5">
				<TriangleAlert
					size={17}
					strokeWidth={2}
					className="flex-none text-danger-text"
				/>
				<div className="min-w-0">
					<div className="text-[13px] text-danger-text">{error.message}</div>
					{error.detail ? (
						<div className="mt-0.5 truncate font-mono text-[11px] text-danger-text/70">
							{error.detail}
						</div>
					) : null}
				</div>
			</div>
			<div className="flex flex-none items-center gap-2">
				{error.fallbacks.map((editor) => (
					<button
						key={editor}
						type="button"
						disabled={pending}
						onClick={() => {
							setOpening(editor);
							onOpenWith(editor);
						}}
						className="rounded-xl border border-white/12 bg-white/4 px-3 py-1.75 text-[12px] text-ink-body transition-colors hover:bg-white/9 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-white/4"
					>
						{opening === editor
							? "Opening…"
							: `Open with ${editorLabel(editor)}`}
					</button>
				))}
				<button
					type="button"
					onClick={onEditorSettings}
					className="rounded-xl border border-hairline px-3 py-1.75 text-[12px] text-ink-secondary transition-colors hover:bg-row-hover"
				>
					Editor Settings
				</button>
			</div>
		</div>
	);
}
