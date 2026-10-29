//! Editor side-effects: detection (probing the filesystem for installed editors),
//! spawning a launch, and the per-editor commands the Editors UI drives. The pure
//! command-construction + resolution logic lives in `jump_core::editor` and is unit-tested
//! there; this module owns the OS-touching parts (env-var expansion, `Path::exists`,
//! process spawning) behind the shell's platform seam.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use jump_core::editor::{
    build_command, path_lookup_candidates, resolve_editor_layered, CommandSpec, EditorKind,
};
use jump_core::model::{EditorConfig, LocationKind};

use crate::scan_engine::{list_distros, EVENT_SETTINGS_CHANGED};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// wire DTOs
// ---------------------------------------------------------------------------

/// Live detection result for one editor, recomputed on demand (never persisted): whether
/// its executable resolves on this machine and where.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDetection {
    pub kind: String,
    pub detected: bool,
    pub resolved_path: Option<String>,
    /// "override" (user command), "probe" (known install dir), or "none".
    pub source: String,
}

/// The ephemeral outcome of a Test launch. Shown next to the button until re-tested or the
/// window closes; nothing is written to disk.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub detail: String,
}

impl TestResult {
    fn ok() -> Self {
        Self { ok: true, detail: "Launched".to_string() }
    }
    fn fail(detail: impl Into<String>) -> Self {
        Self { ok: false, detail: detail.into() }
    }
}

/// A launch failure, shaped for the launcher's inline error card. `kind` lets the frontend
/// choose which fallback buttons to show; `message` is the human line and `detail` the mono
/// technical line. Returned as the `Err` of `launch_project`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchError {
    /// "noEditorConfigured" | "editorUnavailable" | "spawnFailed".
    pub kind: String,
    pub message: String,
    pub detail: String,
    /// The editor key we resolved and tried (when one resolved at all), so the inline card
    /// can offer fallbacks that exclude the editor that just failed. `None` for
    /// "noEditorConfigured" and for failures that happen before an editor is resolved.
    pub editor: Option<String>,
}

// ---------------------------------------------------------------------------
// detection (live, never persisted)
// ---------------------------------------------------------------------------

/// Probes the known install dirs for an editor target, returning the first launchable hit.
/// The template syntax is chosen by core (`probe_paths`) and expanded by the matching host
/// impl behind the platform seam, so the two never disagree about what a template means.
fn probe_editor(editor: EditorKind) -> Option<String> {
    editor
        .probe_paths(crate::platform::PLATFORM)
        .iter()
        .find_map(|template| {
            let path = crate::platform::expand_probe_template(template)?;
            crate::platform::is_launchable_path(Path::new(&path)).then_some(path)
        })
}

/// The trimmed, non-empty command override for an editor, if the user set one.
fn override_command(cfg: Option<&EditorConfig>) -> Option<&str> {
    cfg.and_then(|c| c.command.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Resolves a bare command name against `PATH` (honoring `PATHEXT`), returning the first
/// match's full path. Mirrors what the OS does at spawn time, so detection agrees with launch
/// for a bare-command override instead of reporting "not found" for something that will run.
/// A path-ish command (contains a separator) isn't a PATH lookup, so it returns `None` here
/// and the caller stats it directly. PATH is only consulted for an *explicit* override, never
/// for identity probing (Cursor ships a `code.cmd` that would poison a `where code` lookup).
fn resolve_on_path(cmd: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let exts = crate::platform::path_ext();
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    // candidate ordering (bare-then-ext per dir, path-like short-circuit) is the pure part and
    // lives in core; here we just take the first that actually exists on disk.
    path_lookup_candidates(crate::platform::PLATFORM, &dirs, cmd, &exts)
        .into_iter()
        .find(|path| crate::platform::is_launchable_path(path))
        .map(|p| p.to_string_lossy().to_string())
}

/// Live detection for one editor: a user override short-circuits the probe (and is the
/// universal escape hatch for non-standard installs); otherwise probe the known dirs.
fn detect_one(editor: EditorKind, cfg: Option<&EditorConfig>) -> EditorDetection {
    if let Some(cmd) = override_command(cfg) {
        // a full path we can stat, or a bare command we can resolve on PATH (mirroring what
        // the OS does at spawn), both count as detected; otherwise the override is set but
        // points at nothing findable, so report it un-detected while still showing the input.
        let resolved = if crate::platform::is_launchable_path(Path::new(cmd)) {
            Some(cmd.to_string())
        } else {
            resolve_on_path(cmd)
        };
        return EditorDetection {
            kind: editor.as_str().to_string(),
            detected: resolved.is_some(),
            resolved_path: resolved.or_else(|| Some(cmd.to_string())),
            source: "override".to_string(),
        };
    }
    match probe_editor(editor) {
        Some(path) => EditorDetection {
            kind: editor.as_str().to_string(),
            detected: true,
            resolved_path: Some(path),
            source: "probe".to_string(),
        },
        None => EditorDetection {
            kind: editor.as_str().to_string(),
            detected: false,
            resolved_path: None,
            source: "none".to_string(),
        },
    }
}

/// The program to spawn for an editor: the user override if set (used as-is, since a bare
/// command may resolve via PATH at spawn time), else the first probed install. `None` means
/// the editor isn't available on this machine.
fn resolve_exe(editor: EditorKind, cfg: Option<&EditorConfig>) -> Option<String> {
    if let Some(cmd) = override_command(cfg) {
        return Some(cmd.to_string());
    }
    probe_editor(editor)
}

// ---------------------------------------------------------------------------
// process spawning
// ---------------------------------------------------------------------------

/// Runs a Test launch and judges it: a clean exit (or still-running after a short grace
/// window, which is how a freshly-started GUI editor behaves) is success; a non-zero exit
/// within the window is failure, with the first stderr line captured for the detail.
fn run_test_spawn(spec: CommandSpec) -> TestResult {
    let mut child = match crate::platform::background_command(&spec.program)
        .args(&spec.args)
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return TestResult::fail(format!("could not start {}: {e}", spec.program)),
    };

    // drain stderr on its own thread: a chatty child that fills the ~64KB pipe buffer before
    // exiting would otherwise block on the write and never exit, which the poll below would
    // misread as a healthy still-running editor. the thread ends when the child closes stderr.
    let stderr = child.stderr.take();
    let drain = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            use std::io::Read;
            let _ = s.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return TestResult::ok(),
            Ok(Some(status)) => {
                let stderr = drain.join().unwrap_or_default();
                let line = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
                let detail = if line.is_empty() {
                    match status.code() {
                        Some(c) => format!("exited with code {c}"),
                        None => "exited abnormally".to_string(),
                    }
                } else {
                    line.to_string()
                };
                return TestResult::fail(detail);
            }
            // still running after the grace window: a GUI editor that came up and stayed.
            Ok(None) if Instant::now() >= deadline => return TestResult::ok(),
            Ok(None) => std::thread::sleep(Duration::from_millis(120)),
            Err(e) => return TestResult::fail(format!("could not check status: {e}")),
        }
    }
}

/// Queries a distro's `$HOME` so the WSL Test launch opens a natural, guaranteed folder.
/// Falls back to the distro root when the query fails.
fn wsl_home(distro: &str) -> String {
    let out = crate::platform::wsl_output(&[
        "-d",
        distro,
        "--",
        "bash",
        "-lc",
        "printf %s \"$HOME\"",
    ]);
    match out {
        Ok(o) if o.status.success() => {
            let home = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if home.is_empty() { "/".to_string() } else { home }
        }
        _ => "/".to_string(),
    }
}

/// Resolves the program to spawn for a given editor + environment, as the `Option<exe>`
/// `build_command` expects. `Ok(None)` is the Zed+WSL case (it reaches into the distro via
/// `wsl.exe`, so no Windows exe is needed); `Ok(Some(exe))` is a resolved install or override;
/// `Err(())` means the editor isn't available on this machine.
fn launch_exe(
    editor: EditorKind,
    env: &LocationKind,
    cfg: Option<&EditorConfig>,
) -> Result<Option<String>, ()> {
    if editor == EditorKind::Zed && env == &LocationKind::Wsl {
        return Ok(None);
    }
    resolve_exe(editor, cfg).map(Some).ok_or(())
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/// Live-detects all editors. Called when the Editors UI opens; nothing is persisted.
#[tauri::command]
pub fn detect_editors(state: State<'_, AppState>) -> Vec<EditorDetection> {
    let settings = state.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
    EditorKind::ALL
        .into_iter()
        .map(|ed| detect_one(ed, settings.editors.get(ed.as_str())))
        .collect()
}

/// Sets the global default editor. Rejects an unknown key rather than persisting nonsense.
#[tauri::command]
pub fn set_default_editor(
    app: AppHandle,
    state: State<'_, AppState>,
    editor: String,
) -> Result<(), String> {
    if EditorKind::from_key(&editor).is_none() {
        return Err(format!("unknown editor: {editor}"));
    }
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.default_editor = Some(editor);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Sets (or clears, with `None`/blank) an editor's base-command override. Field-scoped under
/// the settings lock so a concurrent edit isn't clobbered.
#[tauri::command]
pub fn set_editor_command(
    app: AppHandle,
    state: State<'_, AppState>,
    editor: String,
    command: Option<String>,
) -> Result<(), String> {
    if EditorKind::from_key(&editor).is_none() {
        return Err(format!("unknown editor: {editor}"));
    }
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        let entry = settings.editors.entry(editor).or_default();
        entry.command = command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Runs a per-editor x per-environment Test launch against a real, innocuous folder
/// (Windows: the config dir; WSL: the default distro's `$HOME`). Async + off-thread so the
/// up-to-5s poll never blocks the UI. The result is ephemeral.
#[tauri::command]
pub async fn test_launch(app: AppHandle, editor: String, env: String) -> TestResult {
    if crate::platform::PLATFORM != jump_core::platform::Platform::Windows {
        return TestResult::fail("Test launch is only available on Windows.");
    }
    let kind = match EditorKind::from_key(&editor) {
        Some(k) => k,
        None => return TestResult::fail(format!("unknown editor: {editor}")),
    };
    let location = if env == "wsl" { LocationKind::Wsl } else { LocationKind::Windows };

    // do the whole build-and-run off the async runtime: building the spec already touches the
    // filesystem and (for WSL) spawns wsl.exe twice, which can take seconds on a cold distro,
    // so keeping it off the executor thread is what stops a Test from blocking other commands.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let cfg = settings.editors.get(kind.as_str());

        let exe = match launch_exe(kind, &location, cfg) {
            Ok(e) => e,
            Err(()) => {
                return TestResult::fail(format!(
                    "{} not found. Set its command in Settings.",
                    kind.label()
                ))
            }
        };

        // only the innocuous target folder differs per environment; the spec is built once so
        // `build_command`'s signature has a single call site here.
        let (path, distro) = if location == LocationKind::Wsl {
            let distros = list_distros();
            let Some(distro) = distros.iter().find(|d| d.is_default).or_else(|| distros.first())
            else {
                return TestResult::fail("No WSL distro found.");
            };
            let distro = distro.name.clone();
            (wsl_home(&distro), Some(distro))
        } else {
            (state.store.dir().to_string_lossy().to_string(), None)
        };

        match build_command(
            crate::platform::PLATFORM,
            kind,
            &location,
            exe.as_deref(),
            &path,
            distro.as_deref(),
        ) {
            Ok(spec) => run_test_spawn(spec),
            Err(err) => TestResult::fail(err.to_string()),
        }
    })
    .await
    .unwrap_or_else(|e| TestResult::fail(format!("test task failed: {e}")))
}

/// The one real launch entry point. Resolves editor (explicit `editor_override` from the
/// Open-With pick beats the project's stored override, which beats the global default) +
/// environment, spawns detached, and records the open in `recents` *only* on a confirmed
/// spawn success. Returns a structured `LaunchError` for the inline error card on failure;
/// never silently switches the saved editor.
#[tauri::command]
pub async fn launch_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    editor_override: Option<String>,
) -> Result<(), LaunchError> {
    let settings = state.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let index = state.store.load_index();
    let project = index.projects.iter().find(|p| p.id == id).ok_or_else(|| LaunchError {
        kind: "spawnFailed".to_string(),
        message: "Project not found".to_string(),
        detail: format!("no index entry for {id}"),
        editor: None,
    })?;

    let stored_override = settings
        .project_overrides
        .get(&id)
        .and_then(|o| o.editor_override.as_deref());

    // strict precedence: explicit pick > stored override > global default, each consulted only
    // if it parses, so a non-empty but unrecognized explicit pick can't skip the stored level.
    let editor = resolve_editor_layered(
        settings.default_editor.as_deref(),
        stored_override,
        editor_override.as_deref(),
    )
    .ok_or_else(|| LaunchError {
        kind: "noEditorConfigured".to_string(),
        message: "No editor configured".to_string(),
        detail: "Set a default editor in Settings -> Editors.".to_string(),
        editor: None,
    })?;

    let cfg = settings.editors.get(editor.as_str());
    let env = &project.kind;
    let exe = launch_exe(editor, env, cfg).map_err(|()| LaunchError {
        kind: "editorUnavailable".to_string(),
        message: format!("{} isn't available", editor.label()),
        detail: format!(
            "Could not find {} on this machine. Set its command in Settings -> Editors.",
            editor.target_name(crate::platform::PLATFORM)
        ),
        editor: Some(editor.as_str().to_string()),
    })?;

    let spec = build_command(
        crate::platform::PLATFORM,
        editor,
        env,
        exe.as_deref(),
        &project.path,
        project.distro.as_deref(),
    )
    .map_err(|err| LaunchError {
        kind: "spawnFailed".to_string(),
        message: format!("Could not open in {}", editor.label()),
        detail: err.to_string(),
        editor: Some(editor.as_str().to_string()),
    })?;
    tauri::async_runtime::spawn_blocking(move || crate::platform::spawn_editor(&spec))
        .await
        .map_err(|err| LaunchError {
            kind: "spawnFailed".to_string(),
            message: format!("Could not open in {}", editor.label()),
            detail: format!("launch task failed: {err}"),
            editor: Some(editor.as_str().to_string()),
        })?
        .map_err(|e| LaunchError {
            kind: "spawnFailed".to_string(),
            message: format!("Could not open in {}", editor.label()),
            // the platform impl already names the program it could not start, so wrapping
            // here would print it twice.
            detail: e,
            editor: Some(editor.as_str().to_string()),
        })?;

    // record only now that the spawn succeeded (an earlier stub recorded unconditionally; this
    // is the move its TODO called for). a record failure must not fail the launch.
    let _ = crate::commands::record_recent_inner(&state, id);
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}
