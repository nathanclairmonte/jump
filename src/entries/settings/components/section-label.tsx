import type { ReactNode } from "react";

/** A mono uppercase eyebrow above a group of settings. */
export function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
			{children}
		</span>
	);
}
