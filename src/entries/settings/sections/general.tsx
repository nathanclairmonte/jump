import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { AppMark } from "@/components/brand/app-mark";
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
import { Switch } from "@/components/ui/switch";
import { openConfigDir } from "@/lib/api";
import { APP_VERSION } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { SectionLabel } from "../components";
import { useSettingsStore } from "../store";

/** A labelled toggle row inside a settings card; an ActionRow whose action is a Switch. */
function ToggleRow({
	title,
	description,
	checked,
	onCheckedChange,
	divider,
}: {
	title: string;
	description: string;
	checked: boolean;
	onCheckedChange: (value: boolean) => void;
	divider?: boolean;
}) {
	return (
		<ActionRow
			title={title}
			description={description}
			divider={divider}
			action={<Switch checked={checked} onCheckedChange={onCheckedChange} />}
		/>
	);
}

/** A row with a title/description on the left and an action button on the right. */
function ActionRow({
	title,
	description,
	action,
	divider,
}: {
	title: string;
	description: ReactNode;
	action: ReactNode;
	divider?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-5 px-[18px] py-[15px]",
				divider && "border-t border-white/[0.055]",
			)}
		>
			<div className="min-w-0">
				<div className="text-[14px] text-ink-body">{title}</div>
				<div className="mt-[3px] text-[12.5px] text-ink-secondary">
					{description}
				</div>
			</div>
			{action}
		</div>
	);
}

export function General() {
	const settings = useSettingsStore((s) => s.settings);
	const configDir = useSettingsStore((s) => s.configDir);
	const setLaunchAtStartup = useSettingsStore((s) => s.setLaunchAtStartup);
	const setRescanOnStartup = useSettingsStore((s) => s.setRescanOnStartup);
	const rebuildIndex = useSettingsStore((s) => s.rebuildIndex);
	const platform = useSettingsStore((s) => s.platform);

	const [confirmRebuild, setConfirmRebuild] = useState(false);

	if (!settings) return null;

	async function onToggleStartup(value: boolean) {
		try {
			await setLaunchAtStartup(value);
		} catch (err) {
			// the store already rolled the toggle back; tell the user the OS refused.
			toast.error(
				platform === "macos"
					? "Could not update launch at login"
					: "Could not update Windows startup",
				{
					description: String(err),
				},
			);
		}
	}

	async function onToggleRescan(value: boolean) {
		try {
			await setRescanOnStartup(value);
		} catch (err) {
			// the store already rolled the toggle back; tell the user the save failed.
			toast.error("Could not update rescan setting", {
				description: String(err),
			});
		}
	}

	async function onRebuild() {
		setConfirmRebuild(false);
		try {
			await rebuildIndex();
			toast("Rebuilding index…", {
				description: "Discarding the cache and rescanning every location.",
			});
		} catch (err) {
			toast.error("Could not rebuild the index", { description: String(err) });
		}
	}

	return (
		<div className="flex flex-col gap-6 p-[26px_30px]">
			<div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
				General
			</div>

			<div className="flex flex-col gap-2.5">
				<SectionLabel>Startup</SectionLabel>
				<Card>
					<ToggleRow
						title={
							platform === "macos"
								? "Launch at login"
								: "Launch at Windows startup"
						}
						description="Start Jump automatically when you sign in."
						checked={settings.launchAtStartup}
						onCheckedChange={(v) => void onToggleStartup(v)}
					/>
					<ToggleRow
						title="Rescan on startup"
						description="Refresh the project index in the background when Jump launches."
						checked={settings.rescanOnStartup}
						onCheckedChange={(v) => void onToggleRescan(v)}
						divider
					/>
				</Card>
			</div>

			<div className="flex flex-col gap-2.5">
				<SectionLabel>Data</SectionLabel>
				<Card>
					<ActionRow
						title="Config folder"
						description={
							<span className="block truncate font-mono text-ink-secondary">
								{configDir || "…"}
							</span>
						}
						action={
							<Button variant="outline" onClick={() => void openConfigDir()}>
								Open folder
							</Button>
						}
					/>
					<ActionRow
						title="Rebuild index"
						description="Discard the cache and rescan all Search Locations from scratch. Projects that can no longer be found are dropped."
						action={
							<Button
								variant="outline"
								onClick={() => setConfirmRebuild(true)}
								className="flex-none"
							>
								Rebuild
							</Button>
						}
						divider
					/>
				</Card>
			</div>

			<div className="flex flex-col gap-2.5">
				<SectionLabel>About</SectionLabel>
				<Card>
					<div className="flex items-center justify-between gap-5 px-[18px] py-[15px]">
						<div className="flex items-center gap-3">
							<AppMark size={28} />
							<div className="text-[14px] font-medium text-ink-body">Jump</div>
						</div>
						<span className="font-mono text-[12.5px] text-ink-secondary">
							v{APP_VERSION}
						</span>
					</div>
				</Card>
			</div>

			<Dialog
				open={confirmRebuild}
				onOpenChange={(open) => {
					if (!open) setConfirmRebuild(false);
				}}
			>
				<DialogContent className="max-w-md gap-3 bg-elevated">
					<DialogHeader>
						<DialogTitle className="text-[15px] text-ink">
							Rebuild the index?
						</DialogTitle>
						<DialogDescription className="text-[13px] text-ink-secondary">
							This discards the cached index and rescans every Search Location
							from scratch. Projects that can no longer be found, including
							missing or currently-unavailable ones, are permanently dropped and
							can't be recovered. Your pins, tags, colours, and aliases are kept
							and reattach to whatever is rediscovered.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="items-center justify-end">
						<Button variant="outline" onClick={() => setConfirmRebuild(false)}>
							Cancel
						</Button>
						<Button onClick={() => void onRebuild()}>Rebuild</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
