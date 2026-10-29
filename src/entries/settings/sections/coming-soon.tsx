// placeholder for sections whose logic lands later (Projects, Editors,
// Shortcuts). the shell + nav are built now so those later sections only fill the panel.

export function ComingSoon({ title }: { title: string }) {
	return (
		<div className="flex flex-col gap-6 p-[26px_30px]">
			<div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
				{title}
			</div>
			<p className="text-[13px] text-ink-tertiary">
				{title} arrives in a later slice.
			</p>
		</div>
	);
}
