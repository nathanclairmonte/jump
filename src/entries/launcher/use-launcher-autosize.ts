import {
	currentMonitor,
	getCurrentWindow,
	LogicalSize,
} from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import * as api from "@/lib/api";

// the launcher window hugs its content (spotlight/raycast style) instead of living in a
// fixed box. width stays put; only height tracks the panel.
const WINDOW_WIDTH = 660;
// transparent gutter kept around the panel so its drop shadow and rounded corners render
// without being clipped by the window edge. top mirrors the panel's pt-2.
const GUTTER_TOP = 8;
const GUTTER_BOTTOM = 24;
// breathing room above the monitor's bottom edge once the list is long enough to cap.
const BOTTOM_MARGIN = 24;
// fixed ceiling on the visible panel so a full recents list stops growing well before the
// screen bottom and scrolls internally instead. tuned so roughly five recent rows show with
// a typical pinned set; nudge this to taste.
const PANEL_MAX_HEIGHT = 650;

/**
 * Sizes the launcher window to its content. Returns two refs: `frameRef` wraps the panel and
 * the (unclipped) action menu, and its measured height drives the window height so the menu
 * can hang below a short panel without being clipped; `panelRef` is the visible box, capped at
 * a fixed max height (falling back to the space below its anchor on a short monitor) so a long
 * result list scrolls internally instead of running off-screen. Width is fixed.
 */
export function useLauncherAutosize() {
	const frameRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const frame = frameRef.current;
		const panel = panelRef.current;
		if (!frame || !panel) return;
		const win = getCurrentWindow();
		let raf = 0;

		// the frame, not the panel, is what the window must contain: an open action menu grows
		// the frame below the panel while the panel keeps hugging its rows.
		const fitWindow = () => {
			const height = frame.offsetHeight + GUTTER_TOP + GUTTER_BOTTOM;
			void win.setSize(new LogicalSize(WINDOW_WIDTH, Math.ceil(height)));
		};

		// cap = space from the panel's anchor down to the monitor's bottom. recomputed on
		// each reveal because the launcher follows the cursor across monitors, where the
		// anchor position and scale factor can both differ.
		const recomputeCap = async () => {
			const monitor = await currentMonitor();
			if (!monitor) return;
			const pos = await win.outerPosition();
			const topWithinMonitor = pos.y - monitor.position.y;
			const available =
				(monitor.size.height - topWithinMonitor) / monitor.scaleFactor -
				BOTTOM_MARGIN;
			// the fixed ceiling is the usual limit; the screen-derived space is only a fallback
			// so a short monitor still can't push the panel off-screen.
			const cap = Math.min(
				available - GUTTER_TOP - GUTTER_BOTTOM,
				PANEL_MAX_HEIGHT,
			);
			panel.style.maxHeight = `${Math.max(0, Math.round(cap))}px`;
			fitWindow();
		};

		const ro = new ResizeObserver(() => {
			// coalesce per-keystroke result churn into a single resize per frame.
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(fitWindow);
		});
		ro.observe(frame);

		void recomputeCap();
		const offShown = api.onEvent(api.EVENT_LAUNCHER_SHOWN, () =>
			recomputeCap(),
		);

		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			void offShown.then((off) => off());
		};
	}, []);

	return { frameRef, panelRef };
}
