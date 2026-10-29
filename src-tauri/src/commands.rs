//! Tauri commands: the frontend's only door to the Rust-owned source of truth. Settings
//! and the index are read/written here; mutations emit thin-signal events so other
//! windows re-fetch.

use tauri::{AppHandle, Emitter, State};

use jump_core::editor::EditorKind;
use jump_core::model::{
    normalize_tags, ExplicitProject, LocationKind, LocationState, Project, ProjectColor,
    ProjectOverride, ProjectsIndex, Recent, SearchLocation, Settings,
};
use jump_core::scan::remove_location_from_index;
use jump_core::wsl::{classify_path, to_unc, DistroState, PathClass};

use crate::scan_engine::{
    list_distros, now_ms, payload_from_index, trigger_scan, verify_explicit_exists,
    EVENT_SCAN_COMPLETE, EVENT_SETTINGS_CHANGED,
};
use crate::state::AppState;
use crate::window;

/// Returns the in-memory settings (the cached source of truth).
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Persists the full settings document and notifies other windows. The caller is
/// responsible for sending back the complete object it loaded (so unmanaged fields are
/// preserved); it then triggers `rescan` if the change affects discovery.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings;
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Loads the generated index from disk.
#[tauri::command]
pub fn get_index(state: State<'_, AppState>) -> ProjectsIndex {
    state.store.load_index()
}

/// Triggers a background rescan (coalesced if one is already running).
#[tauri::command]
pub fn rescan(app: AppHandle) {
    trigger_scan(app);
}

/// Pins or unpins a project by id. "Pinned" is membership in `pinned_order`; pinning
/// appends to the end (newest pin last), unpinning removes. A field-scoped mutation
/// under the settings lock, so a concurrent Settings-window edit isn't clobbered the way
/// a full `save_settings` would. Idempotent: re-pinning an already-pinned id is a no-op.
#[tauri::command]
pub fn set_pinned(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        if pinned {
            if !settings.pinned_order.contains(&id) {
                settings.pinned_order.push(id);
            }
        } else {
            settings.pinned_order.retain(|p| p != &id);
        }
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Replaces the pin order wholesale after a drag-reorder. The frontend sends the full
/// reordered id list; we trust it as the new order. Field-scoped like `set_pinned`.
#[tauri::command]
pub fn set_pin_order(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.pinned_order = ids;
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Upserts a project into `recents`, stamping `lastOpenedAt` from the OS clock (core stays
/// clock-free) and bumping `openCount`; new ids start at 1. The settings-lock-scoped half of
/// recording an open, called by `launch_project` on a confirmed spawn success (it emits the
/// change event itself). No storage cap; the launcher shows the most recent few.
pub(crate) fn record_recent_inner(state: &AppState, id: String) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    let now = now_ms();
    match settings.recents.iter_mut().find(|r| r.id == id) {
        Some(existing) => {
            existing.last_opened_at = now;
            existing.open_count = existing.open_count.saturating_add(1);
        }
        None => settings.recents.push(Recent {
            id,
            last_opened_at: now,
            open_count: 1,
        }),
    }
    state.store.save_settings(&settings).map_err(|e| e.to_string())
}

/// Opens (or resurfaces) the Settings window, optionally deep-linking to a section
/// (e.g. the launcher's "Add Project" -> Projects). Section routing + the no-race
/// hash/event handling live in `window::open_settings`.
#[tauri::command]
pub fn open_settings(app: AppHandle, section: Option<String>) {
    window::open_settings(&app, section.as_deref());
}

/// Dismisses the launcher through the platform-aware focus-restoration path.
#[tauri::command]
pub fn dismiss_launcher(app: AppHandle) {
    window::dismiss_launcher(&app);
}

/// The kind an add flow means when the caller omits it: whatever this host creates natively.
/// Shared by every `*Input` DTO so one door can't derive a different identity than another.
fn kind_or_native(kind: Option<LocationKind>) -> LocationKind {
    kind.unwrap_or_else(|| LocationKind::native_for(crate::platform::PLATFORM))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchLocationInput {
    pub kind: Option<LocationKind>,
    pub path: String,
    pub distro: Option<String>,
    pub max_depth: Option<u32>,
}

impl SearchLocationInput {
    fn resolve(self) -> SearchLocation {
        SearchLocation {
            kind: kind_or_native(self.kind),
            path: self.path,
            distro: self.distro,
            max_depth: self.max_depth.unwrap_or(jump_core::model::DEFAULT_SCAN_DEPTH),
        }
    }
}

fn validate_location_replacement(
    locations: &[SearchLocation],
    replace_id: Option<&str>,
    next_kind: &LocationKind,
) -> Result<(), String> {
    let Some(replace_id) = replace_id else {
        return Ok(());
    };
    let original = locations
        .iter()
        .find(|location| location.id() == replace_id)
        .ok_or_else(|| format!("search location not found: {replace_id}"))?;
    if &original.kind != next_kind {
        return Err("a search location's platform kind cannot be changed".to_string());
    }
    Ok(())
}

/// Adds or updates a Search Location, keyed by the *derived* id (the frontend can't
/// recompute the hash, so identity matching must live here, same reason
/// `remove_search_location` does). Drops any existing location that shares the new
/// location's identity, plus the original being edited (`replaceId`, in case the edit
/// changed the path and therefore the id), then appends the new one, persists, and
/// rescans to discover its projects.
#[tauri::command]
pub fn upsert_search_location(
    app: AppHandle,
    state: State<'_, AppState>,
    location: SearchLocationInput,
    replace_id: Option<String>,
) -> Result<(), String> {
    let location = location.resolve();
    if !location.kind.is_supported_on(crate::platform::PLATFORM) {
        return Err(format!(
            "{} locations cannot be added on {}",
            location.kind.as_str(),
            crate::platform::PLATFORM.as_str()
        ));
    }
    let new_id = location.id();
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        validate_location_replacement(
            &settings.search_locations,
            replace_id.as_deref(),
            &location.kind,
        )?;
        settings.search_locations.retain(|l| {
            let id = l.id();
            id != new_id && Some(&id) != replace_id.as_ref()
        });
        settings.search_locations.push(location);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    // clone so the borrowed-from app stays valid while the scan thread takes ownership.
    trigger_scan(app.clone());
    Ok(())
}

#[cfg(test)]
mod search_location_tests {
    use super::validate_location_replacement;
    use jump_core::model::{LocationKind, SearchLocation};

    fn location(kind: LocationKind) -> SearchLocation {
        SearchLocation {
            kind,
            path: "/projects".to_string(),
            distro: None,
            max_depth: 3,
        }
    }

    #[test]
    fn replacement_preserves_the_persisted_platform_kind() {
        let original = location(LocationKind::Mac);
        let id = original.id();
        let locations = vec![original];

        assert!(validate_location_replacement(&locations, Some(&id), &LocationKind::Mac).is_ok());
        assert!(
            validate_location_replacement(&locations, Some(&id), &LocationKind::Windows).is_err()
        );
        assert!(
            validate_location_replacement(&locations, Some("missing"), &LocationKind::Mac).is_err()
        );
    }
}

/// Removes a Search Location: drops it from settings and instantly prunes its projects
/// from the index (no rescan; never touches disk). Emits both events so the UI refreshes
/// settings and index together.
#[tauri::command]
pub fn remove_search_location(
    app: AppHandle,
    state: State<'_, AppState>,
    location_id: String,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.search_locations.retain(|l| l.id() != location_id);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }

    // hold the index lock across the load-modify-save so a concurrent scan can't write its
    // own index in between and resurrect the projects we just pruned.
    let _index_guard = state.index_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = state.store.load_index();
    let projects = std::mem::take(&mut index.projects);
    index.projects = remove_location_from_index(projects, &location_id);
    index.scan.locations.retain(|s| s.location_id != location_id);
    index.scan.total_count = index.projects.len();
    state.store.save_index(&index).map_err(|e| e.to_string())?;
    drop(_index_guard);

    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    let _ = app.emit(EVENT_SCAN_COMPLETE, payload_from_index(&index));
    Ok(())
}

// ---------------------------------------------------------------------------
// launcher action-menu mutations: per-project metadata, field-scoped like the pin
// commands so a concurrent Settings-window edit isn't clobbered. Each emits
// `settings-changed`; none rescans (these never affect discovery).
// ---------------------------------------------------------------------------

/// Mutates one project's override entry under the settings lock, persists, and emits the
/// change. Prunes the entry when the mutation leaves it all-default, so clearing the last bit
/// of metadata (e.g. Clear Override on a project with nothing else set) leaves no empty record.
fn mutate_override(
    app: &AppHandle,
    state: &AppState,
    id: String,
    f: impl FnOnce(&mut ProjectOverride),
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        f(settings.project_overrides.entry(id.clone()).or_default());
        // drop the entry entirely if the mutation left it all-default, so clearing the last
        // bit of metadata leaves no empty record behind.
        if settings.project_overrides.get(&id) == Some(&ProjectOverride::default()) {
            settings.project_overrides.remove(&id);
        }
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Sets or clears a project's editor override (action menu: Set Editor Override / Clear
/// Override). `None` clears it. Rejects an unknown editor key rather than persisting nonsense.
#[tauri::command]
pub fn set_project_editor_override(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    editor: Option<String>,
) -> Result<(), String> {
    if let Some(key) = &editor {
        if EditorKind::from_key(key).is_none() {
            return Err(format!("unknown editor: {key}"));
        }
    }
    mutate_override(&app, &state, id, |o| o.editor_override = editor)
}

/// Sets or clears a project's alias (Projects table: rename). A blank/whitespace alias clears it,
/// so the display falls back to the folder name.
#[tauri::command]
pub fn set_project_alias(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    alias: Option<String>,
) -> Result<(), String> {
    let normalized = alias.and_then(|a| {
        let trimmed = a.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    mutate_override(&app, &state, id, |o| o.alias = normalized)
}

/// Replaces a project's tag list wholesale (Projects table chip editor). Normalization (trim,
/// drop-empty, case-insensitive dedupe) is the pure `normalize_tags` so the rule lives in one place.
#[tauri::command]
pub fn set_project_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let normalized = normalize_tags(tags);
    mutate_override(&app, &state, id, |o| o.tags = normalized)
}

/// Sets or clears a project's spine color (action menu: Set Color, with `None` = Unset).
#[tauri::command]
pub fn set_project_color(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    color: Option<ProjectColor>,
) -> Result<(), String> {
    mutate_override(&app, &state, id, |o| o.color = color)
}

/// Excludes or restores a project (action menu: Exclude from Search). Excluded projects are
/// hidden from the launcher/search until restored; nothing on disk is touched.
#[tauri::command]
pub fn set_project_excluded(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    excluded: bool,
) -> Result<(), String> {
    mutate_override(&app, &state, id, |o| o.excluded = excluded)
}

/// Drops a project from `recents` (action menu: Remove from Recents). A no-op if it wasn't
/// recent. Leaves pins/overrides alone.
#[tauri::command]
pub fn remove_from_recents(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.recents.retain(|r| r.id != id);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitProjectInput {
    pub kind: Option<LocationKind>,
    pub path: String,
    pub distro: Option<String>,
}

impl ExplicitProjectInput {
    fn resolve(self) -> ExplicitProject {
        ExplicitProject {
            kind: kind_or_native(self.kind),
            path: self.path,
            distro: self.distro,
        }
    }
}

/// Adds an explicit project (Projects panel: "Add Explicit Project"). Verifies the folder exists
/// first (rejecting a typo'd path), then appends the seed (identity-deduped so re-adding the same
/// folder is a no-op replace) and rescans so the synthesized entry lands in the index.
#[tauri::command]
pub fn add_explicit_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project: ExplicitProjectInput,
) -> Result<(), String> {
    let project = project.resolve();
    verify_explicit_exists(&project)?;
    let id = project.id();
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.explicit_projects.retain(|e| e.id() != id);
        settings.explicit_projects.push(project);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    trigger_scan(app);
    Ok(())
}

/// Removes an explicit-project seed by id (Projects panel: remove). Never touches disk. A folder
/// that is *also* scan-discoverable stays in the index after the rescan; one that only existed as
/// an explicit seed disappears. Leaves any pins/recents/overrides keyed by the id in place (the
/// join silently skips orphaned ids).
#[tauri::command]
pub fn remove_explicit_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.explicit_projects.retain(|e| e.id() != id);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    trigger_scan(app);
    Ok(())
}

/// Forgets a project entirely (Projects panel: Remove a missing project). Strips every settings
/// reference to its id (pin order, recents, override metadata, and any explicit seed) in one
/// write, then rescans so a now-unreferenced missing entry drops from the index. Never touches
/// disk. A folder that is still scan-discoverable simply reappears (without its old metadata) on
/// the rescan; that's the intended "start over" for a stale entry.
#[tauri::command]
pub fn forget_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.pinned_order.retain(|p| p != &id);
        settings.recents.retain(|r| r.id != id);
        settings.project_overrides.remove(&id);
        settings.explicit_projects.retain(|e| e.id() != id);
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    trigger_scan(app);
    Ok(())
}

/// Looks up an index entry by id (owned clone), for the action-menu commands that need the
/// project's path/kind/distro/url from the canonical index rather than trusting the frontend.
fn find_project(state: &AppState, id: &str) -> Result<Project, String> {
    state
        .store
        .load_index()
        .projects
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("no index entry for {id}"))
}

/// Opens a project's folder in the OS file manager (action menu: Show in File Explorer).
/// Windows projects open by path; WSL projects open via their `\\wsl.localhost\<distro>\...`
/// UNC path. The platform module owns the OS-specific spawn (`explorer.exe` / `open`), both of
/// which show the folder's contents.
#[tauri::command]
pub fn show_in_file_explorer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let project = find_project(&state, &id)?;
    if !project.kind.is_supported_on(crate::platform::PLATFORM) {
        return Err(format!(
            "{} projects cannot be revealed on {}",
            project.kind.as_str(),
            crate::platform::PLATFORM.as_str()
        ));
    }
    let target = match project.kind {
        // a native path is already what the host's file manager wants.
        LocationKind::Windows | LocationKind::Mac => project.path.clone(),
        // a WSL project without a distro can't be turned into a UNC path; fail loudly rather
        // than spawn the file manager on a malformed path that silently opens nothing.
        LocationKind::Wsl => {
            let distro = project
                .distro
                .as_deref()
                .ok_or_else(|| format!("WSL project {id} has no distro; cannot locate it"))?;
            to_unc(distro, &project.path)
        }
        // the support guard above rejects every unknown kind, so this stays graceful rather
        // than panicking if that ever stops being true.
        LocationKind::Unknown(kind) => {
            return Err(format!("cannot reveal a project with unknown kind '{kind}'"));
        }
    };
    crate::platform::reveal_in_file_manager(&target)
}

/// Opens the project's GitHub page in the default browser (action menu: Open in GitHub). Reads
/// the URL cached on the index entry at scan time and validates the scheme as cheap
/// defense-in-depth before handing it to the shell.
#[tauri::command]
pub fn open_github_url(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let project = find_project(&state, &id)?;
    let url = project
        .github_url
        .ok_or_else(|| "no GitHub remote for this project".to_string())?;
    if !url.starts_with("https://") {
        return Err(format!("refusing to open non-https url: {url}"));
    }
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| format!("could not open browser: {e}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroDto {
    pub name: String,
    pub is_default: bool,
    /// "running" | "stopped".
    pub state: String,
}

/// Lists installed WSL distros with their default marker and run state. Empty when WSL
/// is not installed.
#[tauri::command]
pub fn list_wsl_distros() -> Vec<DistroDto> {
    list_distros()
        .into_iter()
        .map(|d| DistroDto {
            name: d.name,
            is_default: d.is_default,
            state: match d.state {
                DistroState::Running => "running",
                DistroState::Stopped => "stopped",
            }
            .to_string(),
        })
        .collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyResult {
    /// "wsl" | "wslNeedsDistro" | "windows".
    pub kind: String,
    pub distro: Option<String>,
    pub linux_path: Option<String>,
    pub windows_path: Option<String>,
}

/// Classifies a typed or picked path so the Search Locations UI knows whether it is a
/// WSL UNC path (distro embedded), a bare Linux path (needs a distro pick), or a Windows
/// path. Single source of truth for this rule lives in `jump-core`.
#[tauri::command]
pub fn classify_path_cmd(input: String) -> ClassifyResult {
    match classify_path(&input) {
        PathClass::Wsl(w) => ClassifyResult {
            kind: "wsl".to_string(),
            distro: Some(w.distro),
            linux_path: Some(w.linux_path),
            windows_path: None,
        },
        PathClass::WslNeedsDistro { linux_path } => ClassifyResult {
            kind: "wslNeedsDistro".to_string(),
            distro: None,
            linux_path: Some(linux_path),
            windows_path: None,
        },
        PathClass::Windows { path } => ClassifyResult {
            kind: "windows".to_string(),
            distro: None,
            linux_path: None,
            windows_path: Some(path),
        },
    }
}

/// Returns the config dir path for display in Settings.
#[tauri::command]
pub fn get_config_dir(state: State<'_, AppState>) -> String {
    state.store.dir().to_string_lossy().to_string()
}

/// Returns the platform this build runs on. Fetched once at startup so the frontend can
/// collapse the environment axis on macOS; reads the single `PLATFORM` constant so Rust and
/// TS share one vocabulary with exactly two values.
#[tauri::command]
pub fn get_platform() -> jump_core::platform::Platform {
    crate::platform::PLATFORM
}

/// Opens the config dir in the OS file manager. Routes through the platform seam so there is
/// exactly one "reveal a folder" path (shared with `show_in_file_explorer`); the config dir is
/// always a native path, so no UNC translation is needed.
#[tauri::command]
pub fn open_config_dir(state: State<'_, AppState>) -> Result<(), String> {
    // make sure the dir exists first so a fresh profile doesn't open nothing.
    let _ = state.store.ensure_dirs();
    let dir = state
        .store
        .dir()
        .to_str()
        .ok_or_else(|| "config dir path is not valid utf-8".to_string())?;
    crate::platform::reveal_in_file_manager(dir)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchLocationRow {
    /// Derived location id, surfaced because the frontend can't recompute the hash. Used
    /// for joining and for the remove command.
    pub id: String,
    pub kind: LocationKind,
    pub path: String,
    pub distro: Option<String>,
    pub max_depth: u32,
    pub project_count: usize,
    /// "ok" | "distroStopped" | "distroMissing" | "error" | "pending" (never scanned).
    pub state: String,
    pub error: Option<String>,
    pub unreadable_paths: Vec<String>,
    pub unreadable_path_count: usize,
    pub last_scan_at: Option<u64>,
}

/// Returns display-ready rows for the Search Locations panel: each configured location
/// joined with its latest per-location scan status (count, state, time). Built here
/// because the frontend cannot derive the location id.
#[tauri::command]
pub fn get_search_locations(state: State<'_, AppState>) -> Vec<SearchLocationRow> {
    let settings = state.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let index = state.store.load_index();

    settings
        .search_locations
        .iter()
        .map(|loc| {
            let id = loc.id();
            let status = index.scan.locations.iter().find(|s| s.location_id == id);
            SearchLocationRow {
                id: id.clone(),
                kind: loc.kind.clone(),
                path: loc.path.clone(),
                distro: loc.distro.clone(),
                max_depth: loc.max_depth,
                project_count: status.map(|s| s.project_count).unwrap_or(0),
                state: status
                    .map(|s| location_state_str(s.state))
                    .unwrap_or("pending")
                    .to_string(),
                error: status.and_then(|s| s.error.clone()),
                unreadable_paths: status
                    .map(|s| s.unreadable_paths.clone())
                    .unwrap_or_default(),
                unreadable_path_count: status.map(|s| s.unreadable_path_count).unwrap_or(0),
                last_scan_at: status.and_then(|s| s.last_scan_at),
            }
        })
        .collect()
}

fn location_state_str(state: LocationState) -> &'static str {
    match state {
        LocationState::Ok => "ok",
        LocationState::DistroStopped => "distroStopped",
        LocationState::DistroMissing => "distroMissing",
        LocationState::Error => "error",
        LocationState::PermissionDenied => "permissionDenied",
        LocationState::PlatformForeign => "platformForeign",
    }
}

/// Attempts to read a configured macOS location, then rescans so its status reflects the
/// result of any native consent prompt.
#[tauri::command]
pub async fn request_location_access(
    app: AppHandle,
    state: State<'_, AppState>,
    location_id: String,
) -> Result<(), String> {
    let location = state
        .settings
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .search_locations
        .iter()
        .find(|location| location.id() == location_id)
        .cloned()
        .ok_or_else(|| format!("search location not found: {location_id}"))?;
    if location.kind != LocationKind::Mac {
        return Err("folder access can only be requested for a macOS location".to_string());
    }
    let path = location.path;
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::platform::request_folder_access(&path)
    })
    .await
    .map_err(|err| format!("folder access task failed: {err}"))
    .and_then(|result| result);
    trigger_scan(app);
    result
}

/// Opens the macOS Files and Folders privacy pane for recovery after access was denied.
#[tauri::command]
pub fn open_files_and_folders_settings() -> Result<(), String> {
    crate::platform::open_files_and_folders_settings()
}

/// Rebuilds the index from scratch (General -> Data -> Rebuild index): clears the cached
/// `projects-index.json`, then kicks a fresh scan. Because the previous index is gone, the
/// reconcile pass retains nothing, so stale `missing` ghosts are dropped and only what is on
/// disk now (plus re-synthesized explicit seeds) repopulates. `settings.json` is untouched,
/// so pins/recents/tags/colors/overrides re-attach by id to whatever is rediscovered. The
/// empty `scan-complete` clears any open window immediately; the real scan repopulates it.
#[tauri::command]
pub fn rebuild_index(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        // hold the index lock across the clear so a concurrent scan can't interleave; the
        // scan we trigger below re-acquires it on its own thread.
        let _guard = state.index_lock.lock().unwrap_or_else(|e| e.into_inner());
        state
            .store
            .save_index(&ProjectsIndex::default())
            .map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SCAN_COMPLETE, payload_from_index(&ProjectsIndex::default()));
    trigger_scan(app);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    /// The canonical combo string currently bound (e.g. "Ctrl+Alt+Space").
    pub combo: String,
    /// Whether the OS actually accepted the registration. False after a conflict, so the
    /// Shortcuts panel can show "Not registered" instead of a false "Registered".
    pub registered: bool,
}

/// Returns the live hotkey status for the Shortcuts panel (the bound combo + whether it is
/// actually registered with the OS).
#[tauri::command]
pub fn get_hotkey_status(state: State<'_, AppState>) -> HotkeyStatus {
    let active = state.hotkey.lock().unwrap_or_else(|e| e.into_inner());
    HotkeyStatus {
        combo: active.combo.clone(),
        registered: active.registered,
    }
}

/// Rebinds the global hotkey (Shortcuts -> Change). Validates in core, then registers the new
/// combo *before* unregistering the old one, so a conflict fails cleanly with the old hotkey
/// still working and nothing persisted. It then persists the canonical string, and only once
/// that write lands does it swap the live shortcut and drop the old binding, so a failed save
/// leaves the app exactly as it was rather than running a hotkey the disk doesn't agree with.
/// A conflict keeps the app running with a warning rather than crashing or silently rebinding,
/// per the slice's acceptance criteria.
#[tauri::command]
pub fn rebind_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    combo: String,
) -> Result<HotkeyStatus, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // validate + canonicalize in core; invalid input touches nothing.
    let (new_shortcut, canonical) = crate::hotkey::resolve(&combo)?;

    // no-op if the same combo is already bound and live, so we don't unregister-then-
    // re-register it and momentarily drop the hotkey. (a *failed* prior registration falls
    // through so the user can retry the same combo.)
    {
        let active = state.hotkey.lock().unwrap_or_else(|e| e.into_inner());
        if active.registered && active.shortcut == new_shortcut {
            return Ok(HotkeyStatus {
                combo: active.combo.clone(),
                registered: true,
            });
        }
    }

    // register the new shortcut while the old is still live; a conflict fails here, leaving
    // the old hotkey untouched and nothing persisted. a *self*-conflict (a prior rebind's
    // best-effort unregister failed, so this app still holds the combo) is recoverable: drop our
    // stale grab and retry once. a genuine other-app conflict still fails honestly on the retry.
    if let Err(first) = app.global_shortcut().register(new_shortcut) {
        let _ = app.global_shortcut().unregister(new_shortcut);
        app.global_shortcut()
            .register(new_shortcut)
            .map_err(|_| format!("that shortcut is already in use: {first}"))?;
    }

    // persist before committing the live swap: if the write fails we must end up exactly as we
    // started (old hotkey still bound, nothing changed), so the returned error is honest. roll
    // the just-made OS registration back rather than leave a second live shortcut around.
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.hotkey = canonical.clone();
        if let Err(err) = state.store.save_settings(&settings) {
            drop(settings);
            let _ = app.global_shortcut().unregister(new_shortcut);
            return Err(err.to_string());
        }
    }

    // persisted: swap the live shortcut, then best-effort unregister the old one (the new combo
    // is already authoritative, so a failed unregister is logged, not fatal).
    let (old_shortcut, old_was_registered) = {
        let mut active = state.hotkey.lock().unwrap_or_else(|e| e.into_inner());
        let prev = (active.shortcut, active.registered);
        active.shortcut = new_shortcut;
        active.combo = canonical.clone();
        active.registered = true;
        prev
    };
    if old_was_registered && old_shortcut != new_shortcut {
        if let Err(err) = app.global_shortcut().unregister(old_shortcut) {
            tracing::warn!(error = %err, "could not unregister the old hotkey after rebind");
        }
    }

    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(HotkeyStatus {
        combo: canonical,
        registered: true,
    })
}

/// Enables or disables launching Jump at Windows startup (General -> Startup). Calls the
/// autostart plugin first and only persists `launchAtStartup` once the OS call succeeds, so
/// the stored flag can never claim a startup state the OS doesn't actually hold.
#[tauri::command]
pub fn set_launch_at_startup(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| format!("could not update Windows startup: {e}"))?;

    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.launch_at_startup = enabled;
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}

/// Toggles the background rescan-on-startup flag (General -> Startup). Field-scoped under the
/// settings lock like `set_pinned`: a full `save_settings` round-trip would carry a stale copy
/// of the whole document and could clobber a concurrent field write (e.g. the adjacent
/// launch-at-startup toggle, desyncing its flag from the real OS autostart state).
#[tauri::command]
pub fn set_rescan_on_startup(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.rescan_on_startup = enabled;
        state.store.save_settings(&settings).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, ());
    Ok(())
}
