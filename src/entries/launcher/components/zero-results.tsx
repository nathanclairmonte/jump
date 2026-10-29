import { Search } from "lucide-react";

interface ZeroResultsProps {
	query: string;
	onRescan: () => void;
	onAddProject: () => void;
}

/** Shown when an active query matches nothing. Rescan re-runs the scan; Add Project
 *  deep-links to Settings -> Projects. (No-Search-Locations is a separate state.) */
export function ZeroResults({
	query,
	onRescan,
	onAddProject,
}: ZeroResultsProps) {
	return (
		<div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
			<div className="flex h-[46px] w-[46px] items-center justify-center rounded-card bg-[rgba(255,255,255,0.04)]">
				<Search size={20} className="text-ink-faint" strokeWidth={2} />
			</div>
			<div className="text-[14px] text-ink">
				No projects found for "
				<span className="text-ink-secondary">{query}</span>"
			</div>
			<div className="text-[12.5px] text-ink-tertiary">
				Try a different search, or rescan your locations.
			</div>
			<div className="mt-1 flex items-center gap-2">
				<button
					type="button"
					onClick={onRescan}
					className="rounded-button border border-hairline bg-[rgba(255,255,255,0.03)] px-3 py-[7px] text-[12.5px] text-ink-body hover:bg-row-hover"
				>
					Rescan Projects
				</button>
				<button
					type="button"
					onClick={onAddProject}
					className="rounded-button border border-hairline bg-[rgba(255,255,255,0.03)] px-3 py-[7px] text-[12.5px] text-ink-body hover:bg-row-hover"
				>
					Add Project
				</button>
			</div>
		</div>
	);
}
