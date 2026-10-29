// the indexing indicator: a pulsing-dot pill in the header and a shimmer line beneath it.
// subtle by design (the cached list stays usable while a scan refreshes in the background).

export function IndexingPill() {
	return (
		<span className="inline-flex flex-none items-center gap-[6px] font-mono text-[10.5px] text-ink-tertiary">
			<span
				className="h-[6px] w-[6px] rounded-full bg-accent-orange"
				style={{ animation: "jmp-pulse 1.1s ease-in-out infinite" }}
			/>
			Indexing…
		</span>
	);
}

/** The 2px accent shimmer that slides under the search header while indexing. */
export function IndexingShimmer() {
	return (
		<div className="relative h-[2px] w-full overflow-hidden">
			<div
				className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent-orange to-transparent"
				style={{ animation: "jmp-shimmer 1.4s linear infinite" }}
			/>
		</div>
	);
}
