import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import * as api from "@/lib/api";
import { useLauncherStore } from "./store";

/**
 * Wires the launcher's window-level behavior: focus the search whenever the window
 * is shown, and hide on Esc. focus-loss hiding (click-outside) is owned by the rust
 * side so it can apply the debug escape hatch; backdrop clicks are handled in the
 * component. returns a ref to attach to the search input.
 */
export function useLauncherWindow() {
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const win = getCurrentWindow();
		const focusInput = () => inputRef.current?.focus();

		// rust shows + focuses the window; mirror that into the dom focus so typing
		// works immediately, and again on every subsequent show.
		focusInput();
		const unlisten = win.onFocusChanged(({ payload: focused }) => {
			if (focused) focusInput();
		});

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				// the esc ladder, innermost first: a submenu pops to the menu root, then the
				// root closes; an inline launch error dismisses (the launcher stays open so a
				// fallback is still reachable); finally esc hides the launcher.
				const store = useLauncherStore.getState();
				if (store.actionMenu) {
					if (store.actionMenu.level !== "root") store.actionMenuBack();
					else store.closeActionMenu();
					return;
				}
				if (store.launchError) {
					store.clearLaunchError();
					return;
				}
				void api.dismissLauncher();
			}
		};
		window.addEventListener("keydown", onKeyDown);

		return () => {
			window.removeEventListener("keydown", onKeyDown);
			void unlisten.then((off) => off());
		};
	}, []);

	return inputRef;
}
