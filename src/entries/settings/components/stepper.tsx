import { Minus, Plus } from "lucide-react";

/** A compact numeric stepper (e.g. scan depth). */
export function Stepper({
	value,
	onChange,
	min = 0,
	max = 12,
	label,
}: {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
	label: string;
}) {
	return (
		<div className="inline-flex flex-none items-center overflow-hidden rounded-[8px] border border-hairline">
			<button
				type="button"
				aria-label={`Decrease ${label}`}
				disabled={value <= min}
				onClick={() => onChange(Math.max(min, value - 1))}
				className="flex h-[30px] w-[30px] items-center justify-center text-ink-secondary transition-colors hover:bg-row-hover disabled:opacity-40"
			>
				<Minus size={14} strokeWidth={2} />
			</button>
			<span className="w-[38px] text-center font-mono text-[13px] text-ink">
				{value}
			</span>
			<button
				type="button"
				aria-label={`Increase ${label}`}
				disabled={value >= max}
				onClick={() => onChange(Math.min(max, value + 1))}
				className="flex h-[30px] w-[30px] items-center justify-center text-ink-secondary transition-colors hover:bg-row-hover disabled:opacity-40"
			>
				<Plus size={14} strokeWidth={2} />
			</button>
		</div>
	);
}
