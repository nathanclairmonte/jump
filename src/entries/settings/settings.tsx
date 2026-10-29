import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { AppMark } from "@/components/brand/app-mark";
import {
	EVENT_SCAN_COMPLETE,
	EVENT_SETTINGS_CHANGED,
	EVENT_SETTINGS_NAVIGATE,
	onEvent,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Editors } from "./sections/editors";
import { General } from "./sections/general";
import { Projects } from "./sections/projects";
import { SearchLocations } from "./sections/search-locations";
import { Shortcuts } from "./sections/shortcuts";
import { Sidebar } from "./sidebar";
import { asTarget, useSettingsStore } from "./store";

type WinControlProps = {
	onClick: () => void;
	label: string;
	danger?: boolean;
	children: ReactNode;
};

/**
 * A titlebar window control: full titlebar height, square, flush to the edge, no
 * radius. close turns clay-red on hover per the design.
 */
function WinControl({ onClick, label, danger, children }: WinControlProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			className={cn(
				"flex h-full w-11.5 items-center justify-center text-ink-secondary transition-colors hover:bg-row-hover hover:text-ink",
				danger && "hover:bg-danger hover:text-white",
			)}
		>
			{children}
		</button>
	);
}

/** Shown when the initial load fails, so the panel offers a retry instead of staying blank. */
function LoadError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
			<div className="text-[14px] text-ink-body">Could not load settings.</div>
			<div className="max-w-md font-mono text-[12px] text-ink-tertiary">
				{message}
			</div>
			<button
				type="button"
				onClick={onRetry}
				className="mt-1 rounded-xl border border-hairline bg-black/20 px-3 py-1.5 text-[13px] text-ink-body transition-colors hover:border-white/20"
			>
				Retry
			</button>
		</div>
	);
}

/** Renders the active section panel. */
function SectionPanel({
	scrollRef,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
}) {
	const section = useSettingsStore((s) => s.section);
	switch (section) {
		case "searchLocations":
			return <SearchLocations />;
		case "general":
			return <General />;
		case "projects":
			// the projects panel drives a scroll-linked collapsing header off this container.
			return <Projects scrollRef={scrollRef} />;
		case "editors":
			return <Editors />;
		case "shortcuts":
			return <Shortcuts />;
	}
}

export function Settings() {
	const win = getCurrentWindow();
	const scrollRef = useRef<HTMLDivElement>(null);
	const load = useSettingsStore((s) => s.load);
	const refreshRows = useSettingsStore((s) => s.refreshRows);
	const refreshIndex = useSettingsStore((s) => s.refreshIndex);
	const reloadSettings = useSettingsStore((s) => s.reloadSettings);
	const navigate = useSettingsStore((s) => s.navigate);
	const loadError = useSettingsStore((s) => s.loadError);
	const platform = useSettingsStore((s) => s.platform);
	// the HTML window controls are Windows-only. checked as a positive so an unresolved
	// platform falls to native chrome, and macOS never paints a second set of controls over
	// its traffic lights while the request is in flight.
	const isWindows = platform === "windows";

	useEffect(() => {
		void load();
		// thin-signal events: re-fetch on a nudge. a scan finishing refreshes the location rows
		// (counts/time) and the index (the Projects table joins against it); a settings change
		// re-syncs the cached settings.
		const offScan = onEvent(EVENT_SCAN_COMPLETE, () => {
			void refreshRows();
			void refreshIndex();
		});
		const offSettings = onEvent(EVENT_SETTINGS_CHANGED, () => {
			void reloadSettings();
			void refreshRows();
		});
		// a deep-link to an *already-open* settings window arrives as an event (a fresh
		// window instead seeds its section from the URL hash).
		const offNavigate = onEvent<string>(EVENT_SETTINGS_NAVIGATE, (section) => {
			const next = asTarget(section);
			if (next) navigate(next);
		});
		return () => {
			void offScan.then((off) => off());
			void offSettings.then((off) => off());
			void offNavigate.then((off) => off());
		};
	}, [load, refreshRows, refreshIndex, reloadSettings, navigate]);

	return (
		// native window chrome owns the outer shape on both platforms.
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-window text-ink">
			{/* titlebar content overlays native traffic lights on macOS. */}
			<div
				data-tauri-drag-region
				className={cn(
					"flex h-11.5 shrink-0 select-none items-center border-b border-hairline bg-titlebar",
					isWindows ? "justify-between pl-4" : "justify-end px-4",
				)}
			>
				<div data-tauri-drag-region className="flex items-center gap-2.5">
					<AppMark size={20} />
					<span className="text-[13px] font-medium text-ink-body">
						Jump Settings
					</span>
				</div>
				{isWindows && (
					<div className="flex h-full">
						<WinControl onClick={() => void win.minimize()} label="Minimize">
							<Minus size={16} strokeWidth={2} />
						</WinControl>
						<WinControl
							onClick={() => void win.toggleMaximize()}
							label="Maximize"
						>
							<Square size={13} strokeWidth={2} />
						</WinControl>
						<WinControl onClick={() => void win.close()} label="Close" danger>
							<X size={16} strokeWidth={2} />
						</WinControl>
					</div>
				)}
			</div>

			{/* body: nav column + the active section panel. */}
			<div className="flex min-h-0 flex-1">
				<Sidebar />
				{/* scrollbar-gutter:stable reserves the gutter so switching to an empty tab (no
				    scrollbar) doesn't shift the content width. */}
				<div
					ref={scrollRef}
					className="min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
				>
					{loadError ? (
						<LoadError message={loadError} onRetry={() => void load()} />
					) : (
						<SectionPanel scrollRef={scrollRef} />
					)}
				</div>
			</div>
		</div>
	);
}
