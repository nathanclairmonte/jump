import { Caret } from "./caret";

type AppMarkProps = {
	size?: number;
};

/**
 * The app icon: the caret centered in a dark squircle. drawn in css (gradient +
 * inset highlight) so it scales cleanly for in-app use; the window/tray/bundle
 * rasters are generated from the same design source.
 */
export function AppMark({ size = 18 }: AppMarkProps) {
	return (
		<div
			className="flex shrink-0 items-center justify-center"
			style={{
				width: size,
				height: size,
				borderRadius: size * 0.28,
				background: "linear-gradient(155deg, #26231f, #141210)",
				boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
			}}
		>
			<Caret
				className="text-accent-orange"
				style={{ width: size * 0.6, height: size * 0.6 }}
			/>
		</div>
	);
}
