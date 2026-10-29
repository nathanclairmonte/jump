import type { CSSProperties } from "react";

type CaretProps = {
	className?: string;
	style?: CSSProperties;
	strokeWidth?: number;
};

/**
 * The brand caret: a rounded upward chevron. drawn inline so it stays crisp at any
 * size and inherits its color from `currentColor` (the orange spark when wanted).
 */
export function Caret({ className, style, strokeWidth = 2.4 }: CaretProps) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			className={className}
			style={style}
		>
			<path
				d="M5 15 L12 8 L19 15"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
