import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig({
	// tauri serves the frontend over http on localhost, so absolute root paths work.
	base: "/",
	plugins: [react(), tailwindcss()],
	build: {
		license: { fileName: "THIRD_PARTY_LICENSES.md" },
		// one html entry per tauri window (no router): the always-resident launcher
		// ships only its own bundle and never drags the settings ui into memory.
		rollupOptions: {
			input: {
				launcher: resolve(root, "launcher.html"),
				settings: resolve(root, "settings.html"),
			},
		},
	},
	resolve: {
		alias: {
			"@": resolve(root, "src"),
		},
	},
	// tauri drives this dev server: keep its logs visible and the port fixed so the
	// rust shell can always find the webview.
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		// don't watch the rust build output: vite's file watcher crashes with EBUSY
		// when cargo writes dlls into src-tauri/target during a tauri dev rebuild.
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "jsdom",
		globals: true,
	},
});
