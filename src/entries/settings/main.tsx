import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import "@/styles/fonts";
import "@/styles/globals.css";
import { Settings } from "./settings";

async function bootstrap() {
	// dev-only: render the real ui in a plain browser (`bun dev`) by faking the tauri
	// bridge when the rust backend isn't present. stripped from production builds.
	if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
		const { installTauriMock } = await import("@/dev/mock-tauri");
		installTauriMock();
	}

	const root = document.getElementById("root");
	if (root) {
		createRoot(root).render(
			<StrictMode>
				<Settings />
				{/* toasts are scoped to settings on purpose: the launcher launch flow stays toast-free. */}
				<Toaster />
			</StrictMode>,
		);
	}
}

void bootstrap();
