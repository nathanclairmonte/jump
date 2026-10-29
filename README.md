# Jump

A fast personal launcher for opening developer projects on macOS and Windows. The Windows
app also supports projects inside WSL2.

> Press a global hotkey, type part of a project name, hit Enter, and the project opens
> in the right editor.

Jump runs in the background. It lives in the macOS menu bar or Windows system tray. It
provides a launcher palette, Settings, project scanning, and clear first-run guidance.

Jump is open source under the [MIT license](LICENSE).
Third-party code and fonts retain their own licenses. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install on macOS

The macOS release supports Apple Silicon and requires macOS 13 or later. It is unsigned
and unnotarized.

1. Download the `.dmg` from the [latest release](https://github.com/nathanclairmonte/jump/releases/latest).
2. Open it and drag Jump into Applications.
3. Clear the quarantine flag in Terminal:

```sh
xattr -cr /Applications/Jump.app
```

macOS may otherwise say that the app is damaged. Run the command again after each new
download because macOS applies quarantine to each copy.

## Install on Windows

Download the x64 `-setup.exe` installer from the
[latest release](https://github.com/nathanclairmonte/jump/releases/latest) and run it.
Jump installs for your Windows user and runs in the system tray. The installer is
unsigned, so Windows may show a SmartScreen warning.

Use WSL2 to add projects from a Linux distribution. VS Code and Cursor can open
WSL projects through their remote integration. Zed support for WSL is best-effort
and requires the Linux `zed` command inside the distribution.

## Stack

- **Frontend:** React 19 + Vite (multi-page, one HTML entry per window, no router) +
  Tailwind v4 + shadcn (Radix) + Zustand, on bun.
- **Backend:** Tauri v2 (Rust).
- **Tooling:** `mise` pins bun / node / task; Biome for lint/format; `task` for scripts.

## Develop

Run the Tauri development loop on the native target OS. On Windows, use a Windows-side
checkout rather than WSL because interop breaks the dev server and file watching.

```sh
mise install        # install the pinned toolchain (bun, node, task)
bun install         # install dependencies

task tauri:dev      # run the native development app
task build:mac      # build the macOS DMG on macOS
task build:win      # build the NSIS installer on Windows
task mac:unq        # clear quarantine on /Applications/Jump.app

task check          # biome check (lint + format + import sort)
task format         # biome format --write
bun run test        # vitest
```

`task bump` updates `package.json`, the sole version source. Release candidates require
manual dispatch on main. See [release verification and draft staging](docs/releasing.md).

### Packaged licenses

Native app builds include a `licenses/` directory in the app's Tauri resources.
It contains Jump's MIT license, the third-party notice with the shadcn/ui license,
frontend dependency license texts, and both font licenses. See the
[packaged notice paths](THIRD_PARTY_NOTICES.md#packaged-app-notices).

`bun run build` refreshes `dist/THIRD_PARTY_LICENSES.md` from the bundled frontend
dependencies. Normal native app builds run this command before Tauri copies the
notices into the package.

## Layout

The standalone marketing site lives in [`website/`](website/README.md). Run
`npm ci --prefix website`, then `task dev-web` to preview it at http://localhost:4321.
Use `task check-web` to check, test, and build the site independently of the app.

- `src/` frontend (one entry per window under `src/entries/`, shared tokens in
  `src/styles/globals.css`).
- `src-tauri/` Rust shell: windows, menu bar and tray integration, scanning, persistence,
  editor launching, and native platform operations.
- `src-tauri/crates/core/` pure cross-platform domain logic, tested independently from the
  Tauri shell.
- `launcher.html` / `settings.html` per-window Vite entries.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a substantial change.
Follow [SECURITY.md](SECURITY.md) to report a vulnerability privately.
