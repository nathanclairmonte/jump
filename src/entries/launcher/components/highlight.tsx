import { Fragment, type ReactNode } from "react";

// renders `text` with the matched ranges wrapped in a highlight span. ranges are a flat
// [start, end, start, end, ...] list (uFuzzy's shape); empty ranges render the plain text.
export function Highlight({
	text,
	ranges,
	className,
}: {
	text: string;
	ranges: number[];
	className: string;
}) {
	if (ranges.length === 0) return <>{text}</>;

	const parts: ReactNode[] = [];
	let cursor = 0;
	for (let i = 0; i < ranges.length; i += 2) {
		const start = ranges[i];
		const end = ranges[i + 1];
		if (start > cursor)
			parts.push(<Fragment key={cursor}>{text.slice(cursor, start)}</Fragment>);
		parts.push(
			<span key={start} className={className}>
				{text.slice(start, end)}
			</span>,
		);
		cursor = end;
	}
	if (cursor < text.length) {
		parts.push(<Fragment key={cursor}>{text.slice(cursor)}</Fragment>);
	}
	return <>{parts}</>;
}
