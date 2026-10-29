// the settings nav column. all five sections render now; only Search Locations (and a
// minimal General) are wired up first; the rest are placeholders so each later section drops
// into its panel without re-touching the shell.

import type { LucideIcon } from "lucide-react";
import {
	Code2,
	Folder,
	Keyboard,
	LayoutGrid,
	SlidersHorizontal,
} from "lucide-react";
import { APP_VERSION } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { type SettingsSection, useSettingsStore } from "./store";

const NAV: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
	{ id: "general", label: "General", icon: SlidersHorizontal },
	{ id: "searchLocations", label: "Search Locations", icon: Folder },
	{ id: "projects", label: "Projects", icon: LayoutGrid },
	{ id: "editors", label: "Editors", icon: Code2 },
	{ id: "shortcuts", label: "Shortcuts", icon: Keyboard },
];

export function Sidebar() {
	const section = useSettingsStore((s) => s.section);
	const navigate = useSettingsStore((s) => s.navigate);

	return (
		<nav className="flex w-[212px] flex-none flex-col justify-between border-r border-hairline bg-sidebar p-3">
			<div className="flex flex-col gap-0.5">
				{NAV.map(({ id, label, icon: Icon }) => {
					const active = section === id;
					return (
						<button
							key={id}
							type="button"
							onClick={() => navigate({ section: id, action: null })}
							className={cn(
								"flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors",
								active
									? "bg-selection text-ink"
									: "text-ink-secondary hover:bg-row-hover hover:text-ink-body",
							)}
						>
							<Icon
								size={16}
								strokeWidth={1.7}
								className={active ? "text-accent-orange" : undefined}
							/>
							{label}
						</button>
					);
				})}
			</div>
			<span className="px-3 font-mono text-[11px] text-ink-faint">
				jump v{APP_VERSION}
			</span>
		</nav>
	);
}
