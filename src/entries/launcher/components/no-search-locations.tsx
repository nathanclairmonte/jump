import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NoSearchLocationsProps {
	foreignOnly?: boolean;
	onOpenSettings: () => void;
	onAddLocation: () => void;
}

/** Guides a fresh profile to the Search Locations setup instead of showing a generic empty list. */
export function NoSearchLocations({
	foreignOnly = false,
	onOpenSettings,
	onAddLocation,
}: NoSearchLocationsProps) {
	return (
		<div className="flex flex-col items-center px-7 py-11 text-center">
			<div className="flex size-11.5 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.04] text-ink-faint shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
				<Folder size={23} strokeWidth={1.7} />
			</div>
			<div className="mt-3.5 text-[15.5px] font-medium text-ink-body">
				{foreignOnly ? "No usable Search Locations" : "No Search Locations yet"}
			</div>
			<div className="mt-1.5 max-w-84 text-[13px] leading-relaxed text-ink-tertiary">
				{foreignOnly
					? "Your configured locations belong to another platform. Add a folder on this computer."
					: "Add a folder for Jump to scan for projects."}
			</div>
			<div className="mt-4 flex gap-2">
				<Button variant="outline" onClick={onOpenSettings}>
					Open Settings
				</Button>
				<Button onClick={onAddLocation}>Add Search Location</Button>
			</div>
		</div>
	);
}
