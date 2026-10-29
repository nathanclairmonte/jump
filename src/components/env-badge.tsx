import { Badge } from "@/components/ui/badge";
import type { LocationKind } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The environment badge: WSL violet, Windows azure. Shared by settings + launcher. */
export function EnvBadge({ kind }: { kind: LocationKind }) {
	return (
		<Badge
			variant="ghost"
			className={cn(
				"flex-none rounded-badge px-1.5 py-[2px] text-[11px] font-medium",
				kind === "wsl"
					? "bg-wsl-bg text-wsl-text"
					: "bg-windows-bg text-windows-text",
			)}
		>
			{kind === "wsl" ? "WSL" : "Windows"}
		</Badge>
	);
}
