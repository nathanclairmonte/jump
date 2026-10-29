import { useEffect } from "react";
import * as api from "@/lib/api";
import { useLauncherStore } from "./store";

/**
 * Loads the index + settings on mount and keeps them fresh via the rust-owned events:
 * a scan toggles the indexing indicator and refreshes the index on completion, a settings
 * change re-reads settings, and each reveal resets the query/selection and refreshes. The
 * launcher webview is created hidden and never destroyed, so these listeners stay live
 * across hides and catch background scans.
 */
export function useLauncherData() {
	useEffect(() => {
		const store = useLauncherStore.getState();
		void store.load();

		const unlisteners = [
			api.onEvent(api.EVENT_SCAN_STARTED, () => {
				useLauncherStore.getState().setIndexing(true);
			}),
			api.onEvent(api.EVENT_SCAN_COMPLETE, () => {
				const s = useLauncherStore.getState();
				s.setIndexing(false);
				void s.reloadIndex();
			}),
			api.onEvent(api.EVENT_SETTINGS_CHANGED, () => {
				void useLauncherStore.getState().reloadSettings();
			}),
			api.onEvent(api.EVENT_LAUNCHER_SHOWN, () => {
				void useLauncherStore.getState().onShown();
			}),
		];

		return () => {
			for (const u of unlisteners) void u.then((off) => off());
		};
	}, []);
}
