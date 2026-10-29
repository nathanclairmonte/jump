import type { ReactNode } from "react";

type KeycapProps = {
	children: ReactNode;
};

/** A small mono keycap chip for footer hints and shortcut references. */
export function Keycap({ children }: KeycapProps) {
	return (
		<kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-keycap border border-hairline bg-elevated px-1.5 font-mono text-[11px] text-ink-tertiary">
			{children}
		</kbd>
	);
}
