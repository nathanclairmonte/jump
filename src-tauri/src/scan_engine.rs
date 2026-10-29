//! The scan engine: runs one indexing pass over the configured Search Locations and
//! writes `projects-index.json`. The pure logic (find rendering, walk, post-pass,
//! reconcile) lives in `jump-core`; this module owns the side-effects: spawning
//! `wsl.exe`, the OS clock, the single-scan guard, and event emission.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::Ordering;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use jump_core::git::github_url_from_config;
use jump_core::model::{
    ExplicitProject, LocationKind, LocationScanStatus, LocationState, Project, ProjectsIndex,
    ScanReport, Settings, SCHEMA_VERSION,
};
use jump_core::scan::{
    bash_single_quote, build_projects, folder_name, merge_explicit_projects, reconcile,
    render_find_expression, retain_known_locations, scan_native_location, wsl_candidates,
    Candidate, ReconcileCtx, ScanProfile,
};
use jump_core::wsl::{parse_distro_table, DistroInfo, DistroState};

use crate::state::AppState;

/// Fired when a scan finishes (or an instant index mutation lands). A thin signal;
/// windows re-fetch the index via `get_index`; the payload is just a summary.
pub const EVENT_SCAN_COMPLETE: &str = "scan-complete";
/// Fired when a scan actually begins (not when a request is coalesced into a running
/// one), so the launcher can show its indexing indicator. Paired with `scan-complete`.
pub const EVENT_SCAN_STARTED: &str = "scan-started";
/// Fired when settings are persisted, so other windows re-fetch via `get_settings`.
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCompletePayload {
    pub total_count: usize,
    pub error_count: usize,
    pub last_scan_at: Option<u64>,
}

/// Builds a completion payload from an index (used by both a real scan and the instant
/// removal path).
pub fn payload_from_index(index: &ProjectsIndex) -> ScanCompletePayload {
    let error_count = index
        .scan
        .locations
        .iter()
        .filter(|s| {
            matches!(
                s.state,
                LocationState::Error
                    | LocationState::PermissionDenied
                    | LocationState::PlatformForeign
                    | LocationState::DistroMissing
            )
        })
        .count();
    ScanCompletePayload {
        total_count: index.projects.len(),
        error_count,
        last_scan_at: index.scan.last_scan_at,
    }
}

/// Triggers a background scan, coalescing if one is already running. Non-blocking: the
/// tray/hotkey stay responsive while the scan runs on its own thread.
pub fn trigger_scan(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        // swap returns the previous value: if it was already true, a scan is in flight. rather
        // than drop this request, flag it so the running scan loops once more; otherwise a
        // settings change made after that scan snapshotted settings would never reach the index.
        if state.scanning.swap(true, Ordering::SeqCst) {
            state.rescan_pending.store(true, Ordering::SeqCst);
            tracing::info!("scan already in progress; queued another pass");
            return;
        }
    }

    // only signal a fresh start, never a coalesced one, so the indexing indicator
    // matches one scan-started to one scan-complete.
    let _ = app.emit(EVENT_SCAN_STARTED, ());

    std::thread::spawn(move || {
        // reset the guard via Drop so a panic inside run_scan still clears `scanning`; otherwise
        // a single failed scan would wedge every future trigger into a permanent no-op. on the
        // way out it also re-checks rescan_pending: a request that arrived after the loop's final
        // check (while `scanning` was still true, so trigger_scan only flagged a pending pass and
        // returned) would otherwise be stranded with no running scan to consume it, so we relaunch
        // once the slot is actually free.
        struct ScanGuard(AppHandle);
        impl Drop for ScanGuard {
            fn drop(&mut self) {
                let state = self.0.state::<AppState>();
                state.scanning.store(false, Ordering::SeqCst);
                // ordering closes the race: we release `scanning` before this load, and
                // trigger_scan sets `scanning` (swap) before it sets `rescan_pending`, so a late
                // request can't slip past both unseen. relaunching with the slot now free is safe.
                if state.rescan_pending.load(Ordering::SeqCst) {
                    trigger_scan(self.0.clone());
                }
            }
        }
        let _guard = ScanGuard(app.clone());

        // loop so a request that arrived mid-scan (rescan_pending) gets a fresh pass. clear the
        // flag *before* each run, so only changes made during or after the run re-trigger it.
        loop {
            let state = app.state::<AppState>();
            state.rescan_pending.store(false, Ordering::SeqCst);
            let payload = run_scan(&app);
            if let Err(err) = app.emit(EVENT_SCAN_COMPLETE, payload) {
                tracing::warn!(error = %err, "could not emit scan-complete");
            }
            if !state.rescan_pending.load(Ordering::SeqCst) {
                break;
            }
            // another pass is queued: emit a fresh scan-started so the indexing indicator stays
            // on (one scan-started per scan-complete) instead of flickering "done" between passes.
            let _ = app.emit(EVENT_SCAN_STARTED, ());
        }
    });
}

/// Runs one full scan synchronously and persists the index. Returns the completion
/// summary.
fn run_scan(app: &AppHandle) -> ScanCompletePayload {
    let started = Instant::now();
    let state = app.state::<AppState>();
    let (settings, store) = {
        let guard = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        (guard.clone(), state.store.clone())
    };

    // hold the index lock for the whole load-then-save span so an instant index mutation
    // (a location removal) lands fully before or after this scan, never interleaved.
    let _index_guard = state.index_lock.lock().unwrap_or_else(|e| e.into_inner());

    let previous_projects = store.load_index().projects;
    let profile = ScanProfile::default();

    // resolve distro states once, side-effect-free, so we never wake a stopped distro.
    let distros = list_distros();

    let mut candidates = Vec::new();
    let mut statuses: Vec<LocationScanStatus> = Vec::new();
    let mut ok_location_ids: BTreeSet<String> = BTreeSet::new();

    for loc in &settings.search_locations {
        let loc_id = loc.id();
        let at = now_ms();
        if !loc.kind.is_supported_on(crate::platform::PLATFORM) {
            statuses.push(status(
                &loc_id,
                LocationState::PlatformForeign,
                Some(format!(
                    "{} locations cannot be scanned on {}",
                    loc.kind.as_str(),
                    crate::platform::PLATFORM.as_str()
                )),
                Vec::new(),
                at,
            ));
            continue;
        }

        match &loc.kind {
            LocationKind::Windows | LocationKind::Mac => {
                let scan = scan_native_location(
                    &loc.path,
                    loc.max_depth,
                    &loc_id,
                    loc.kind.clone(),
                );
                match scan.error {
                    Some(err) => {
                        statuses.push(status(
                            &loc_id,
                            err.kind.into(),
                            Some(err.detail),
                            scan.unreadable_paths,
                            at,
                        ));
                    }
                    None => {
                        ok_location_ids.insert(loc_id.clone());
                        candidates.extend(scan.candidates);
                        statuses.push(status(
                            &loc_id,
                            LocationState::Ok,
                            None,
                            scan.unreadable_paths,
                            at,
                        ));
                    }
                }
            }
            LocationKind::Wsl => {
                let distro = loc.distro.clone().unwrap_or_default();
                match distro_availability(&distros, &distro) {
                    DistroAvailability::Missing => {
                        statuses.push(status(
                            &loc_id,
                            LocationState::DistroMissing,
                            Some(format!("distro '{distro}' not found")),
                            Vec::new(),
                            at,
                        ));
                    }
                    DistroAvailability::Stopped => {
                        // never auto-start: skip and preserve last-known-good.
                        statuses.push(status(
                            &loc_id,
                            LocationState::DistroStopped,
                            Some(format!("distro '{distro}' is stopped")),
                            Vec::new(),
                            at,
                        ));
                    }
                    DistroAvailability::Running => {
                        let body = render_find_expression(&loc.path, loc.max_depth, &profile);
                        match run_find(&distro, &body) {
                            Ok(out) => {
                                ok_location_ids.insert(loc_id.clone());
                                candidates.extend(wsl_candidates(&out, &distro, &loc_id));
                                statuses.push(status(
                                    &loc_id,
                                    LocationState::Ok,
                                    None,
                                    Vec::new(),
                                    at,
                                ));
                            }
                            Err(err) => {
                                statuses.push(status(
                                    &loc_id,
                                    LocationState::Error,
                                    Some(err),
                                    Vec::new(),
                                    at,
                                ));
                            }
                        }
                    }
                }
            }
            LocationKind::Unknown(_) => unreachable!("foreign locations were handled above"),
        }
    }

    let mut fresh = build_projects(candidates, settings.include_nested_projects);

    // resolve each fresh git project's GitHub URL now, while the distros are confirmed up, so
    // the launcher's "Open in GitHub" action is a pure-frontend visibility check. Reconciled
    // (missing/preserved) projects keep their previously stored url.
    enrich_github_urls(&mut fresh, &distros);

    // per-location project counts from the freshly found set, tallied in one pass so we
    // don't re-walk every project once per location.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for p in &fresh {
        for id in &p.source_location_ids {
            *counts.entry(id.clone()).or_default() += 1;
        }
    }
    for st in &mut statuses {
        st.project_count = counts.get(&st.location_id).copied().unwrap_or(0);
    }

    // drop index entries whose locations are no longer configured (e.g. a path edit
    // changed a location's id), then reconcile per the missing-retention rule. cloned so the
    // raw previous set survives for explicit-seed lookup below: explicit-only entries have no
    // source location and would be pruned away by retain_known_locations.
    let known: BTreeSet<String> = settings
        .search_locations
        .iter()
        .filter(|location| location.kind.is_supported_on(crate::platform::PLATFORM))
        .map(|location| location.id())
        .collect();
    let previous_pruned = retain_known_locations(previous_projects.clone(), &known);
    let ctx = ReconcileCtx {
        ok_location_ids,
        referenced_ids: referenced_ids(&settings),
    };
    let reconciled = reconcile(fresh, &previous_pruned, &ctx);

    // explicit seeds: synthesize an index entry for each from a best-effort probe,
    // resolve its github url, then merge into the scan-discovered set by identity. done after
    // reconcile + nested pruning so an explicit project always appears, even one nested-OFF
    // would have dropped or the scan never found. looked up against the *raw* previous set so a
    // distro-down seed can preserve its last-known entry.
    let mut explicit = synthesize_explicit(&settings, &distros, &previous_projects, &profile);
    enrich_github_urls(&mut explicit, &distros);
    let projects = merge_explicit_projects(reconciled, explicit);

    let last_scan_at = now_ms();
    let index = ProjectsIndex {
        schema_version: SCHEMA_VERSION,
        scan: ScanReport {
            last_scan_at: Some(last_scan_at),
            duration_ms: Some(started.elapsed().as_millis() as u64),
            total_count: projects.len(),
            locations: statuses,
        },
        projects,
    };

    if let Err(err) = store.save_index(&index) {
        tracing::error!(error = %err, "could not save projects index");
    }
    tracing::info!(
        count = index.projects.len(),
        ms = index.scan.duration_ms.unwrap_or(0),
        "scan complete"
    );

    payload_from_index(&index)
}

/// Resolves each freshly-scanned `.git` project's GitHub URL from its `.git/config`, in place.
/// Native projects are read with `std::fs`; WSL projects are read inside their distro
/// in one `bash` pass per distro (never per-file UNC reads, which would reintroduce the slow 9p
/// access we avoid). Non-GitHub repos and unreadable configs simply stay `None`. A WSL
/// project whose distro isn't running is skipped: probing it would start a stopped distro, which
/// we never do (a preserved explicit entry keeps its previously resolved url instead).
fn enrich_github_urls(projects: &mut [Project], distros: &[DistroInfo]) {
    // native filesystems: direct reads on the scan thread.
    for p in projects.iter_mut() {
        if matches!(p.kind, LocationKind::Windows | LocationKind::Mac) && has_git_marker(p) {
            let cfg = std::path::Path::new(&p.path).join(".git").join("config");
            if let Ok(text) = std::fs::read_to_string(&cfg) {
                p.github_url = github_url_from_config(&text);
            }
        }
    }

    // wsl: gather git-project paths per running distro, then one native read pass each.
    let mut by_distro: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for p in projects.iter() {
        if p.kind == LocationKind::Wsl && has_git_marker(p) {
            if let Some(distro) = &p.distro {
                if matches!(distro_availability(distros, distro), DistroAvailability::Running) {
                    by_distro.entry(distro.clone()).or_default().push(p.path.clone());
                }
            }
        }
    }
    // key the resolved urls by distro then path so the write-back is a single pass over
    // projects, not a full re-walk per distro.
    let mut resolved: BTreeMap<String, BTreeMap<String, Option<String>>> = BTreeMap::new();
    for (distro, paths) in by_distro {
        let configs = read_wsl_git_configs(&distro, &paths);
        resolved.insert(distro, configs);
    }
    for p in projects.iter_mut() {
        if p.kind == LocationKind::Wsl {
            if let Some(distro) = &p.distro {
                if let Some(url) = resolved.get(distro).and_then(|m| m.get(&p.path)) {
                    p.github_url = url.clone();
                }
            }
        }
    }
}

fn has_git_marker(p: &Project) -> bool {
    p.markers.iter().any(|m| m == ".git")
}

/// Reads `<path>/.git/config` for each Linux path natively inside the distro, returning
/// `path -> resolved GitHub URL` (`None` when there is no GitHub remote or no readable config).
/// One `wsl.exe` invocation prints each path then its config, NUL-delimited, so the pairing is
/// exact (paths and configs never contain NUL). Paths are rigorously single-quoted.
fn read_wsl_git_configs(distro: &str, paths: &[String]) -> BTreeMap<String, Option<String>> {
    let mut out: BTreeMap<String, Option<String>> = BTreeMap::new();
    if paths.is_empty() {
        return out;
    }
    // emit each project inline with its path as a single-quoted literal, never a `for d in ...`
    // loop that reads back `$d`: variable references do not survive `wsl.exe -- bash -c <body>`
    // (the boundary expands them away before the inner shell runs), so a `$d` loop yields an
    // empty path and empty config for every project. literal paths are what the find scan relies
    // on too, and they pass through intact.
    let mut body = String::new();
    for p in paths {
        let path = bash_single_quote(p);
        let cfg = bash_single_quote(&format!("{p}/.git/config"));
        body.push_str(&format!(
            "printf '%s\\0' {path}; cat {cfg} 2>/dev/null; printf '\\0'; "
        ));
    }
    // a non-login `-c` (not `-lc` like the rest of the engine) so profile/rc startup output
    // can't prepend to stdout and shift the NUL-paired stream; this body only needs printf and
    // cat, so it doesn't depend on the login-shell PATH/env the find scan does.
    let output = match crate::platform::wsl_output(&["-d", distro, "--", "bash", "-c", &body]) {
        Ok(o) => o.stdout,
        Err(err) => {
            tracing::warn!(distro, error = %err, "could not read wsl git configs");
            return out;
        }
    };
    let text = String::from_utf8_lossy(&output);
    let mut tokens = text.split('\0');
    loop {
        let (Some(path), Some(config)) = (tokens.next(), tokens.next()) else {
            break;
        };
        if path.is_empty() {
            continue;
        }
        out.insert(path.to_string(), github_url_from_config(config));
    }
    out
}

/// What a best-effort probe of an explicit seed's folder concluded.
enum Probe {
    /// The folder exists; these markers were found at depth 0 (possibly empty).
    Found(Vec<String>),
    /// The folder was confirmed absent on a reachable environment.
    Gone,
    /// Existence couldn't be determined: distro down/missing, no distro, or a transient probe
    /// error. We must not flip a previously-good entry to missing on such a hiccup.
    Unknown,
}

/// Synthesizes an index entry for each explicit-project seed via a best-effort probe.
/// Windows seeds are probed with `std::fs` (depth 0); WSL seeds via one `find` inside a running
/// distro. A seed whose folder is *confirmed* gone is kept as `missing: true` rather than dropped,
/// since the user asked for it. When existence can't be determined (distro down/missing, no
/// distro, or a transient error) the previous entry is preserved as-is; with no previous entry we
/// emit a `missing: true` placeholder rather than vouch for a folder we never confirmed exists.
/// Github urls are resolved by the caller.
fn synthesize_explicit(
    settings: &Settings,
    distros: &[DistroInfo],
    previous: &[Project],
    profile: &ScanProfile,
) -> Vec<Project> {
    let prev_by_id: BTreeMap<&str, &Project> =
        previous.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut out = Vec::new();

    for seed in &settings.explicit_projects {
        if !seed.kind.is_supported_on(crate::platform::PLATFORM) {
            continue;
        }
        let id = seed.id();
        let prev = prev_by_id.get(id.as_str()).copied();
        // a synthesized entry carries no source location (it isn't tied to a Search Location);
        // markers/missing come from the probe, github is seeded from the previous entry and may
        // be refreshed by the caller's enrichment pass.
        let make = |markers: Vec<String>, missing: bool| Project {
            id: id.clone(),
            kind: seed.kind.clone(),
            distro: seed.distro.clone(),
            path: seed.path.clone(),
            name: folder_name(&seed.kind, &seed.path),
            markers,
            source_location_ids: Vec::new(),
            missing,
            explicit: true,
            github_url: prev.and_then(|p| p.github_url.clone()),
        };

        let probe = match &seed.kind {
            LocationKind::Windows | LocationKind::Mac => {
                probe_native(&seed.path, &id, seed.kind.clone())
            }
            LocationKind::Wsl => match seed.distro.as_deref() {
                // a wsl seed with no distro can never be probed against a real environment.
                None | Some("") => Probe::Unknown,
                Some(distro) => match distro_availability(distros, distro) {
                    DistroAvailability::Running => probe_wsl(distro, &seed.path, &id, profile),
                    // never wake a stopped/absent distro; we just can't tell.
                    _ => Probe::Unknown,
                },
            },
            LocationKind::Unknown(_) => unreachable!("foreign explicit seeds were skipped"),
        };

        let project = match probe {
            Probe::Found(markers) => make(markers, false),
            Probe::Gone => make(prev_markers(prev), true),
            // undeterminable: keep the last-known entry (flagged explicit) if we have one; with
            // none, a missing placeholder, since we never confirmed the folder exists.
            Probe::Unknown => match prev {
                Some(p) => Project {
                    explicit: true,
                    ..p.clone()
                },
                None => make(Vec::new(), true),
            },
        };
        out.push(project);
    }
    out
}

/// Probes a Windows explicit seed at depth 0. A missing directory is `Gone`; one that exists but
/// can't be read (e.g. permissions) is `Unknown` so we don't wrongly declare it missing.
fn probe_native(path: &str, id: &str, kind: LocationKind) -> Probe {
    if !std::path::Path::new(path).is_dir() {
        return Probe::Gone;
    }
    let scan = scan_native_location(path, 0, id, kind);
    match scan.error {
        Some(_) => Probe::Unknown,
        None => Probe::Found(markers_of(&scan.candidates)),
    }
}

/// Probes a WSL explicit seed via one `find` inside a running distro. When `find` fails, a cheap
/// `test -d` separates a genuinely gone folder (`Gone`) from a transient failure (`Unknown`).
fn probe_wsl(distro: &str, path: &str, id: &str, profile: &ScanProfile) -> Probe {
    let body = render_find_expression(path, 0, profile);
    match run_find(distro, &body) {
        Ok(bytes) => Probe::Found(markers_of(&wsl_candidates(&bytes, distro, id))),
        Err(_) => match wsl_path_exists(distro, path) {
            Ok(true) => Probe::Unknown,
            Ok(false) => Probe::Gone,
            Err(_) => Probe::Unknown,
        },
    }
}

/// Whether `path` is a directory inside a running `distro` (`test -d`). `Err` only when the probe
/// itself couldn't run (wsl.exe failed), kept distinct from a clean "not a directory".
fn wsl_path_exists(distro: &str, path: &str) -> Result<bool, String> {
    let body = format!("test -d {}", bash_single_quote(path));
    let output = crate::platform::wsl_output(&["-d", distro, "--", "bash", "-lc", &body])
        .map_err(|e| format!("could not check folder: {e}"))?;
    Ok(output.status.success())
}

/// Verifies an explicit-project seed points at a real folder, before it is added to settings.
/// Windows is a direct `is_dir` check; a WSL seed is checked inside a *running*
/// distro. A down/missing distro can't be probed, so the add is allowed through (the seed is
/// synthesized as missing on the next scan) rather than rejected on a transient state.
pub(crate) fn verify_explicit_exists(seed: &ExplicitProject) -> Result<(), String> {
    if !seed.kind.is_supported_on(crate::platform::PLATFORM) {
        return Err(format!(
            "{} projects cannot be added on {}",
            seed.kind.as_str(),
            crate::platform::PLATFORM.as_str()
        ));
    }
    match &seed.kind {
        LocationKind::Windows | LocationKind::Mac => {
            if std::path::Path::new(&seed.path).is_dir() {
                Ok(())
            } else {
                Err(format!("folder not found: {}", seed.path))
            }
        }
        LocationKind::Wsl => {
            let distro = seed.distro.clone().unwrap_or_default();
            if distro.is_empty() {
                return Err("a WSL project needs a distro".to_string());
            }
            match distro_availability(&list_distros(), &distro) {
                DistroAvailability::Running => {
                    if wsl_path_exists(&distro, &seed.path)? {
                        Ok(())
                    } else {
                        Err(format!("folder not found in {distro}: {}", seed.path))
                    }
                }
                // can't probe a down/missing distro; allow the add and let the scan synthesize it.
                _ => Ok(()),
            }
        }
        LocationKind::Unknown(_) => unreachable!("foreign explicit seeds were rejected"),
    }
}

/// Collapses probe candidates to a sorted, deduped marker list.
fn markers_of(candidates: &[Candidate]) -> Vec<String> {
    let set: BTreeSet<String> = candidates.iter().map(|c| c.marker.clone()).collect();
    set.into_iter().collect()
}

/// The previous entry's markers, or empty when there is no previous entry.
fn prev_markers(prev: Option<&Project>) -> Vec<String> {
    prev.map(|p| p.markers.clone()).unwrap_or_default()
}

/// Project ids referenced by settings (pinned / recent / overridden). Only these survive a
/// scan-discovered disappearance as `missing`; everything else is dropped. Explicit seeds are
/// not listed here: they are re-synthesized into the index each pass (see `synthesize_explicit`),
/// so their retention is handled there, not by the reconcile missing-retention rule.
fn referenced_ids(settings: &Settings) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    set.extend(settings.pinned_order.iter().cloned());
    set.extend(settings.recents.iter().map(|r| r.id.clone()));
    set.extend(settings.project_overrides.keys().cloned());
    set
}

fn status(
    location_id: &str,
    state: LocationState,
    error: Option<String>,
    mut unreadable_paths: Vec<String>,
    at: u64,
) -> LocationScanStatus {
    const MAX_STORED_UNREADABLE_PATHS: usize = 100;

    let unreadable_path_count = unreadable_paths.len();
    unreadable_paths.truncate(MAX_STORED_UNREADABLE_PATHS);
    LocationScanStatus {
        location_id: location_id.to_string(),
        project_count: 0,
        state,
        error,
        unreadable_paths,
        unreadable_path_count,
        last_scan_at: Some(at),
    }
}

enum DistroAvailability {
    Running,
    Stopped,
    Missing,
}

fn distro_availability(distros: &[DistroInfo], name: &str) -> DistroAvailability {
    match distros.iter().find(|d| d.name == name) {
        None => DistroAvailability::Missing,
        Some(d) => match d.state {
            DistroState::Running => DistroAvailability::Running,
            DistroState::Stopped => DistroAvailability::Stopped,
        },
    }
}

/// Lists installed distros with their default marker and run state via `wsl.exe -l -v`.
/// Returns empty when WSL is absent (the app then runs Windows-only).
pub fn list_distros() -> Vec<DistroInfo> {
    match crate::platform::wsl_output(&["-l", "-v"]) {
        Ok(out) => parse_distro_table(&out.stdout),
        Err(err) if err.kind() == std::io::ErrorKind::Unsupported => Vec::new(),
        Err(err) => {
            tracing::info!(error = %err, "wsl.exe not available; treating as Windows-only");
            Vec::new()
        }
    }
}

/// Runs the rendered `find` body natively inside the distro. `find` may exit non-zero
/// when some subtree is unreadable yet still print valid results, so a non-zero exit with
/// output is taken as-is. but a non-zero exit with *empty* output means the whole
/// invocation failed (missing bash, bad path, distro gone), which we surface as an error
/// rather than silently reporting the location as having zero projects.
fn run_find(distro: &str, body: &str) -> Result<Vec<u8>, String> {
    let output = crate::platform::wsl_output(&["-d", distro, "--", "bash", "-lc", body])
        .map_err(|e| format!("failed to run wsl find: {e}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().next().unwrap_or("").trim();
        let msg = if detail.is_empty() {
            "wsl find produced no output".to_string()
        } else {
            detail.to_string()
        };
        return Err(msg);
    }
    Ok(output.stdout)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jump_core::model::{LocationKind, LocationScanStatus, Project, ProjectsIndex};
    use jump_core::wsl::{DistroInfo, DistroState};

    fn status_with(state: LocationState) -> LocationScanStatus {
        LocationScanStatus {
            location_id: "loc".to_string(),
            project_count: 0,
            state,
            error: None,
            unreadable_paths: Vec::new(),
            unreadable_path_count: 0,
            last_scan_at: None,
        }
    }

    #[test]
    fn status_bounds_stored_unreadable_paths_without_losing_the_total() {
        let paths = (0..105).map(|index| format!("/blocked/{index}"));
        let status = status(
            "loc",
            LocationState::Ok,
            None,
            paths.collect(),
            1_700_000_000_000,
        );

        assert_eq!(status.unreadable_paths.len(), 100);
        assert_eq!(status.unreadable_path_count, 105);
        assert_eq!(status.unreadable_paths.first().unwrap(), "/blocked/0");
        assert_eq!(status.unreadable_paths.last().unwrap(), "/blocked/99");
    }

    fn project_with(id: &str) -> Project {
        Project {
            id: id.to_string(),
            kind: LocationKind::Windows,
            distro: None,
            path: format!("C:\\{id}"),
            name: id.to_string(),
            markers: Vec::new(),
            source_location_ids: vec!["loc".to_string()],
            missing: false,
            explicit: false,
            github_url: None,
        }
    }

    #[test]
    fn payload_error_count_covers_blocked_foreign_error_and_missing_but_not_stopped() {
        let mut index = ProjectsIndex::default();
        index.scan.locations = vec![
            status_with(LocationState::Ok),
            status_with(LocationState::Error),
            status_with(LocationState::PermissionDenied),
            status_with(LocationState::PlatformForeign),
            status_with(LocationState::DistroMissing),
            // a stopped distro preserves last-known-good, so it is not an error state.
            status_with(LocationState::DistroStopped),
        ];
        index.projects = vec![project_with("a"), project_with("b")];

        let payload = payload_from_index(&index);
        assert_eq!(payload.error_count, 4);
        assert_eq!(payload.total_count, 2);
    }

    #[test]
    fn distro_availability_maps_running_stopped_and_missing() {
        let distros = vec![
            DistroInfo {
                name: "Ubuntu".to_string(),
                is_default: true,
                state: DistroState::Running,
            },
            DistroInfo {
                name: "Debian".to_string(),
                is_default: false,
                state: DistroState::Stopped,
            },
        ];
        assert!(matches!(
            distro_availability(&distros, "Ubuntu"),
            DistroAvailability::Running
        ));
        assert!(matches!(
            distro_availability(&distros, "Debian"),
            DistroAvailability::Stopped
        ));
        assert!(matches!(
            distro_availability(&distros, "Arch"),
            DistroAvailability::Missing
        ));
    }
}
