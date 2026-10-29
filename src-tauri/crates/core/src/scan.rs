//! The project scanner: marker/ignore constants, the WSL `find`-expression renderer,
//! the native directory walk, and the shared post-pass (identity construction, dedup,
//! nested-OFF pruning) plus rescan reconciliation (missing-retention).
//!
//! the marker and ignore lists are the single source of truth, rendered
//! two ways: `find` predicates for WSL and a `std::fs` walk for Windows. The constants
//! are reached through a [`ScanProfile`] (the config seam) so user-configurable lists
//! can slot in later without touching this logic.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use crate::model::{derive_id, LocationKind, LocationState, Project};

/// Files/dirs whose presence marks a folder as a project. `.git` counts whether it is a
/// directory (normal repo) or a file (worktree/submodule).
pub const MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "docker-compose.yml",
    "docker-compose.yaml",
];

/// Directories never descended into. `.git` is here too (we detect its presence but
/// never walk into it).
pub const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    ".cache",
    "vendor",
];

/// The effective marker/ignore lists used for one scan. Defaults to the constants; the
/// seam through which user-configurable lists arrive later.
#[derive(Debug, Clone)]
pub struct ScanProfile {
    pub markers: Vec<String>,
    pub ignore_dirs: Vec<String>,
}

impl Default for ScanProfile {
    fn default() -> Self {
        Self {
            markers: MARKERS.iter().map(|s| s.to_string()).collect(),
            ignore_dirs: IGNORE_DIRS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// A single (project-dir, marker) hit, before identity construction. The same dir can
/// produce several candidates (one per marker, possibly across locations); the post-pass
/// merges them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub kind: LocationKind,
    pub distro: Option<String>,
    pub path: String,
    pub marker: String,
    pub source_location_id: String,
}

// ---------------------------------------------------------------------------
// WSL: render the `find` expression and parse its output
// ---------------------------------------------------------------------------

/// Renders the body passed to `wsl.exe -d <distro> -- bash -lc '<body>'`.
///
/// `max_depth` is the canonical project-dir depth (root = 0); `find` searches one level
/// deeper to reach the marker, so it renders `-maxdepth (max_depth + 1)`. Ignored dirs
/// are pruned *before* the marker arm. A marker that is also an ignored dir (`.git`) is
/// detected-then-pruned as a directory, and separately detected as a file (worktrees),
/// so its presence is recorded without descending into it.
///
/// The root path is the only user-influenced value, so it is rigorously single-quoted
/// for bash; markers/ignored-dirs are simple constant tokens.
pub fn render_find_expression(linux_path: &str, max_depth: u32, profile: &ScanProfile) -> String {
    let find_depth = max_depth + 1;
    let root = bash_single_quote(linux_path);

    let marker_set: BTreeSet<&str> = profile.markers.iter().map(|s| s.as_str()).collect();
    let ignore_set: BTreeSet<&str> = profile.ignore_dirs.iter().map(|s| s.as_str()).collect();

    let mut arms: Vec<String> = Vec::new();

    // detect-and-prune arms for any name that is both a marker and an ignored dir: record
    // the dir as a project marker, then stop descending into it.
    for name in marker_set.intersection(&ignore_set) {
        arms.push(format!(
            "\\( -type d -name {n} -printf '%h\\0{n}\\0' -prune \\)",
            n = name
        ));
    }

    // prune arm for ignored dirs that are not markers.
    let ignore_only: Vec<&str> = ignore_set.difference(&marker_set).copied().collect();
    if !ignore_only.is_empty() {
        arms.push(format!(
            "\\( -type d \\( {names} \\) -prune \\)",
            names = name_or_list(&ignore_only)
        ));
    }

    // file-detect arm for every marker (catches file markers, and the `.git` file form).
    let markers: Vec<&str> = profile.markers.iter().map(|s| s.as_str()).collect();
    arms.push(format!(
        "\\( -type f \\( {names} \\) -printf '%h\\0%f\\0' \\)",
        names = name_or_list(&markers)
    ));

    format!("find {root} -maxdepth {find_depth} {arms}", arms = arms.join(" -o "))
}

/// Builds a `-name a -o -name b` predicate fragment.
fn name_or_list(names: &[&str]) -> String {
    names
        .iter()
        .map(|n| format!("-name {n}"))
        .collect::<Vec<_>>()
        .join(" -o ")
}

/// Single-quotes a string for bash, escaping embedded single quotes as `'\''`. Untrusted
/// input must never reach `bash -lc` unquoted.
pub fn bash_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Parses the NUL-delimited `find` output into candidates. The renderer prints two
/// NUL-terminated tokens per hit (the project dir then the marker name), so we read the
/// stream as `(path, marker)` pairs. Paths cannot contain NUL, so pairing is unambiguous.
pub fn wsl_candidates(find_output: &[u8], distro: &str, location_id: &str) -> Vec<Candidate> {
    let text = String::from_utf8_lossy(find_output);
    let mut tokens = text.split('\0');
    let mut out = Vec::new();
    loop {
        let (Some(path), Some(marker)) = (tokens.next(), tokens.next()) else {
            break;
        };
        if path.is_empty() {
            continue;
        }
        out.push(Candidate {
            kind: LocationKind::Wsl,
            distro: Some(distro.to_string()),
            path: path.to_string(),
            marker: marker.to_string(),
            source_location_id: location_id.to_string(),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// native filesystems: walk directly
// ---------------------------------------------------------------------------

/// The category of a failure to read the scan root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeScanErrorKind {
    PermissionDenied,
    Other,
}

impl From<NativeScanErrorKind> for LocationState {
    fn from(kind: NativeScanErrorKind) -> Self {
        match kind {
            NativeScanErrorKind::PermissionDenied => LocationState::PermissionDenied,
            NativeScanErrorKind::Other => LocationState::Error,
        }
    }
}

/// A failure that prevented the scan root from being read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeScanError {
    pub kind: NativeScanErrorKind,
    pub detail: String,
}

impl From<std::io::Error> for NativeScanError {
    fn from(err: std::io::Error) -> Self {
        Self {
            kind: match err.kind() {
                std::io::ErrorKind::PermissionDenied => NativeScanErrorKind::PermissionDenied,
                _ => NativeScanErrorKind::Other,
            },
            detail: err.to_string(),
        }
    }
}

/// The outcome of walking one native location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeScan {
    pub candidates: Vec<Candidate>,
    /// `Some` if the root itself was unreadable (the location errored).
    pub error: Option<NativeScanError>,
    /// Descendant directories that could not be read during an otherwise valid scan.
    pub unreadable_paths: Vec<String>,
}

/// Walks a native location with `std::fs`, mirroring the `find` semantics exactly:
/// projects are dirs (depth `0..=max_depth`, root = 0) directly containing a marker;
/// ignored dirs are never descended (so `.git` is detected but not entered).
pub fn scan_native_location(
    root: &str,
    max_depth: u32,
    location_id: &str,
    kind: LocationKind,
) -> NativeScan {
    let profile = ScanProfile::default();
    let markers: HashSet<&str> = profile.markers.iter().map(|s| s.as_str()).collect();
    let ignore: HashSet<&str> = profile.ignore_dirs.iter().map(|s| s.as_str()).collect();

    let mut candidates = Vec::new();
    let mut unreadable_paths = Vec::new();
    let walk = Walk {
        max_depth,
        markers: &markers,
        ignore: &ignore,
        location_id,
        kind: &kind,
    };
    let result = walk.run(Path::new(root), 0, &mut candidates, &mut unreadable_paths);

    unreadable_paths.sort();
    unreadable_paths.dedup();
    NativeScan {
        candidates,
        error: result.err().map(NativeScanError::from),
        unreadable_paths,
    }
}

/// The scan inputs that stay fixed for the whole recursion, so only the per-directory
/// cursor and the accumulators are threaded through it.
struct Walk<'a> {
    max_depth: u32,
    markers: &'a HashSet<&'a str>,
    ignore: &'a HashSet<&'a str>,
    location_id: &'a str,
    kind: &'a LocationKind,
}

impl Walk<'_> {
    /// Recurses one directory: records its markers, then descends into non-ignored
    /// subdirectories while depth remains. An unreadable *subdir* is skipped (logged); an
    /// unreadable *root* surfaces as the location error.
    fn run(
        &self,
        dir: &Path,
        depth: u32,
        out: &mut Vec<Candidate>,
        unreadable_paths: &mut Vec<String>,
    ) -> Result<(), std::io::Error> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(err) => {
                return handle_read_error(dir, depth, err, unreadable_paths);
            }
        };

        // the deepest level is the widest, so collecting children there would allocate a path
        // per entry only to drop the whole vector unread.
        let descend = depth < self.max_depth;
        let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
        let dir_str = dir.to_string_lossy().to_string();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    tracing::warn!(dir = %dir.display(), error = %err, "skipping unreadable directory entry");
                    unreadable_paths.push(dir_str.clone());
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

            if self.markers.contains(name.as_str()) {
                out.push(Candidate {
                    kind: self.kind.clone(),
                    distro: None,
                    path: dir_str.clone(),
                    marker: name.clone(),
                    source_location_id: self.location_id.to_string(),
                });
            }
            if descend && is_dir && !self.ignore.contains(name.as_str()) {
                subdirs.push(entry.path());
            }
        }

        if descend {
            for sub in subdirs {
                self.run(&sub, depth + 1, out, unreadable_paths)?;
            }
        }
        Ok(())
    }
}

/// Applies the root-versus-descendant failure policy for one directory read.
fn handle_read_error(
    dir: &Path,
    depth: u32,
    err: std::io::Error,
    unreadable_paths: &mut Vec<String>,
) -> Result<(), std::io::Error> {
    if depth == 0 {
        return Err(err);
    }
    tracing::warn!(dir = %dir.display(), error = %err, "skipping unreadable directory");
    unreadable_paths.push(dir.to_string_lossy().to_string());
    Ok(())
}

// ---------------------------------------------------------------------------
// shared post-pass: identity construction, dedup, nested-OFF pruning
// ---------------------------------------------------------------------------

/// Merges raw candidates into projects: groups by deterministic identity (unioning
/// markers and source locations), then, when `include_nested` is false, drops any project
/// that is a descendant of another project in the same environment. All freshly-built
/// projects are `missing: false`.
pub fn build_projects(candidates: Vec<Candidate>, include_nested: bool) -> Vec<Project> {
    // group by identity. BTreeMap keeps output deterministic (sorted by id).
    let mut groups: BTreeMap<String, Project> = BTreeMap::new();
    let mut marker_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut source_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for c in candidates {
        let id = derive_id(&c.kind, c.distro.as_deref(), &c.path);
        marker_sets.entry(id.clone()).or_default().insert(c.marker);
        source_sets
            .entry(id.clone())
            .or_default()
            .insert(c.source_location_id);
        groups.entry(id.clone()).or_insert_with(|| Project {
            id: id.clone(),
            kind: c.kind.clone(),
            distro: c.distro.clone(),
            name: folder_name(&c.kind, &c.path),
            path: c.path,
            markers: Vec::new(),
            source_location_ids: Vec::new(),
            missing: false,
            // explicit-ness is applied later by merge_explicit_projects, never during the scan
            // build; a freshly-discovered project is not explicit until a seed says so.
            explicit: false,
            // resolved later (scan engine, after build) from .git/config; never here.
            github_url: None,
        });
    }

    let mut projects: Vec<Project> = groups
        .into_iter()
        .map(|(id, mut p)| {
            p.markers = marker_sets.remove(&id).unwrap_or_default().into_iter().collect();
            p.source_location_ids =
                source_sets.remove(&id).unwrap_or_default().into_iter().collect();
            p
        })
        .collect();

    if !include_nested {
        projects = prune_nested(projects);
    }
    projects
}

/// Drops any project that is a strict path-descendant of another project in the same
/// `(kind, distro)` partition. The shallower (ancestor) project survives.
fn prune_nested(projects: Vec<Project>) -> Vec<Project> {
    // normalize each path once up front: the ancestor scan below is O(n^2), so normalizing
    // inside it would re-allocate the same strings for every pair.
    let norm: Vec<String> = projects
        .iter()
        .map(|p| normalize_for_compare(&p.kind, &p.path))
        .collect();

    // keep p unless some other project is a strict ancestor of it. computed as a mask so
    // the kept projects are moved out below, not cloned.
    let keep: Vec<bool> = projects
        .iter()
        .enumerate()
        .map(|(i, p)| {
            !projects.iter().enumerate().any(|(j, other)| {
                j != i
                    && other.kind == p.kind
                    && other.distro == p.distro
                    && is_strict_ancestor(&p.kind, &norm[j], &norm[i])
            })
        })
        .collect();

    projects
        .into_iter()
        .zip(keep)
        .filter_map(|(p, keep)| keep.then_some(p))
        .collect()
}

/// Whether `ancestor` is a strict path-ancestor of `descendant`, within one environment.
/// Both inputs are already `normalize_for_compare`-normalized. Boundary-aware (the prefix
/// must end at a separator) so `/foo` is not an ancestor of `/foo-bar`.
fn is_strict_ancestor(kind: &LocationKind, ancestor: &str, descendant: &str) -> bool {
    if ancestor == descendant {
        return false;
    }
    let sep = match kind {
        LocationKind::Windows => '\\',
        LocationKind::Wsl | LocationKind::Mac | LocationKind::Unknown(_) => '/',
    };
    // descendant must continue past the ancestor with a separator, checked without
    // building a "<ancestor><sep>" string for every comparison.
    descendant
        .strip_prefix(ancestor)
        .is_some_and(|rest| rest.starts_with(sep))
}

/// Normalizes a path for ancestor comparison: Windows folds case + slashes, WSL leaves
/// case but unifies nothing; both strip a trailing separator.
fn normalize_for_compare(kind: &LocationKind, path: &str) -> String {
    match kind {
        LocationKind::Windows => path.replace('/', "\\").trim_end_matches('\\').to_lowercase(),
        LocationKind::Wsl => path.trim_end_matches('/').to_string(),
        LocationKind::Mac => path.trim_end_matches('/').to_lowercase(),
        LocationKind::Unknown(_) => path.trim_end_matches(['/', '\\']).to_string(),
    }
}

/// The folder (display) name = the last path segment.
pub fn folder_name(kind: &LocationKind, path: &str) -> String {
    let trimmed = match kind {
        LocationKind::Wsl | LocationKind::Mac => path.trim_end_matches('/'),
        LocationKind::Windows | LocationKind::Unknown(_) => path.trim_end_matches(['\\', '/']),
    };
    trimmed
        .rsplit(['\\', '/'])
        .find(|seg| !seg.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

// ---------------------------------------------------------------------------
// explicit projects: merge synthesized seeds into the scan-discovered set
// ---------------------------------------------------------------------------

/// Merges synthesized explicit-project entries into the (already reconciled) scan-discovered
/// set, by identity. This runs *after* reconcile and nested pruning so an explicit seed always
/// appears even when nested-OFF would have dropped a discovered child, or when the scan never
/// found it at all.
///
/// For each explicit entry: if a scan-discovered project shares its id, that project keeps its
/// scanned facts (markers/sources/github) and gains the `explicit` flag plus any markers the
/// probe found but the scan didn't; it is `missing` only when *both* the scan and the probe
/// agree it's missing, so an explicit probe that found the folder clears a reconcile that had
/// dropped it (e.g. a nested child after nested-projects is toggled off). Otherwise the
/// synthesized entry is appended as-is (the caller set its `explicit`, markers, and `missing`).
///
/// The side-effecting probe that builds the `explicit` list (existence + markers + github,
/// with distro-down preservation) lives in the scan engine; this stays a pure, testable merge.
pub fn merge_explicit_projects(mut projects: Vec<Project>, explicit: Vec<Project>) -> Vec<Project> {
    for e in explicit {
        if let Some(existing) = projects.iter_mut().find(|p| p.id == e.id) {
            existing.explicit = true;
            // present if *either* source found it: an explicit probe that located the folder
            // overrides a reconcile that retained it as missing.
            existing.missing = existing.missing && e.missing;
            let mut markers: BTreeSet<String> = existing.markers.iter().cloned().collect();
            markers.extend(e.markers);
            existing.markers = markers.into_iter().collect();
        } else {
            projects.push(e);
        }
    }
    // keep output deterministic (sorted by id), matching reconcile's contract.
    projects.sort_by(|a, b| a.id.cmp(&b.id));
    projects
}

// ---------------------------------------------------------------------------
// rescan reconciliation: missing-retention and location removal
// ---------------------------------------------------------------------------

/// Inputs the reconcile step needs beyond the fresh + previous project sets.
#[derive(Debug, Clone, Default)]
pub struct ReconcileCtx {
    /// Locations that scanned successfully this run. A previous project is only confirmed
    /// absent if one of its sources is here and it still wasn't found.
    pub ok_location_ids: BTreeSet<String>,
    /// Project ids referenced by settings (pinned / recent / override / explicit). Only
    /// these survive as `missing`; unreferenced disappearances are dropped.
    pub referenced_ids: BTreeSet<String>,
}

/// Reconciles a freshly-built project set against the previous index per the
/// missing-retention rule. Assumes location *removal* was already applied upstream (so
/// `previous` only contains projects whose locations still exist).
pub fn reconcile(mut fresh: Vec<Project>, previous: &[Project], ctx: &ReconcileCtx) -> Vec<Project> {
    let fresh_ids: HashSet<String> = fresh.iter().map(|p| p.id.clone()).collect();
    let prev_by_id: BTreeMap<&str, &Project> =
        previous.iter().map(|p| (p.id.as_str(), p)).collect();

    // preserve source attribution from locations we couldn't reconfirm this run (e.g. a
    // stopped distro): a project found via location A keeps its prior membership in B
    // until B scans again.
    for p in &mut fresh {
        if let Some(prev) = prev_by_id.get(p.id.as_str()) {
            let mut set: BTreeSet<String> = p.source_location_ids.iter().cloned().collect();
            for loc in &prev.source_location_ids {
                if !ctx.ok_location_ids.contains(loc) {
                    set.insert(loc.clone());
                }
            }
            p.source_location_ids = set.into_iter().collect();
        }
    }

    let mut result = fresh;

    for prev in previous {
        if fresh_ids.contains(&prev.id) {
            continue;
        }
        let confirmed_absent = prev
            .source_location_ids
            .iter()
            .any(|loc| ctx.ok_location_ids.contains(loc));

        if confirmed_absent {
            // a working location says it's gone. keep it only if something references it.
            if ctx.referenced_ids.contains(&prev.id) {
                let mut p = prev.clone();
                p.missing = true;
                result.push(p);
            }
            // else: ephemeral, drop.
        } else {
            // no source could be reconfirmed (location down/stopped) -> preserve as-is.
            result.push(prev.clone());
        }
    }

    result.sort_by(|a, b| a.id.cmp(&b.id));
    result
}

/// Removes a location from the index without a rescan: drop its id from each project's
/// source set, and drop a project entirely once its set empties. Never touches disk.
pub fn remove_location_from_index(projects: Vec<Project>, location_id: &str) -> Vec<Project> {
    projects
        .into_iter()
        .filter_map(|mut p| {
            p.source_location_ids.retain(|id| id != location_id);
            if p.source_location_ids.is_empty() {
                None
            } else {
                Some(p)
            }
        })
        .collect()
}

/// Drops source-location ids that are no longer configured (e.g. a location whose path
/// was edited, changing its id), dropping a project once its set empties. Run over the
/// previous index before reconcile so edited-away or externally-removed locations don't
/// linger as falsely-preserved entries. Never touches disk.
pub fn retain_known_locations(projects: Vec<Project>, known: &BTreeSet<String>) -> Vec<Project> {
    projects
        .into_iter()
        .filter_map(|mut p| {
            p.source_location_ids.retain(|id| known.contains(id));
            if p.source_location_ids.is_empty() {
                None
            } else {
                Some(p)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(kind: LocationKind, distro: Option<&str>, path: &str, marker: &str, loc: &str) -> Candidate {
        Candidate {
            kind,
            distro: distro.map(|s| s.to_string()),
            path: path.to_string(),
            marker: marker.to_string(),
            source_location_id: loc.to_string(),
        }
    }

    // --- find rendering ---

    #[test]
    fn find_depth_is_project_depth_plus_one() {
        let body = render_find_expression("/home/me/code", 3, &ScanProfile::default());
        assert!(body.contains("-maxdepth 4"), "body: {body}");
    }

    #[test]
    fn find_quotes_root_and_escapes_quotes() {
        let body = render_find_expression("/home/o'brien/code", 2, &ScanProfile::default());
        assert!(body.contains("find '/home/o'\\''brien/code'"), "body: {body}");
    }

    #[test]
    fn find_prunes_before_matching_files() {
        let body = render_find_expression("/x", 1, &ScanProfile::default());
        let prune = body.find("node_modules").unwrap();
        let file = body.find("package.json").unwrap();
        assert!(prune < file, "prune must precede the file-match arm: {body}");
    }

    #[test]
    fn find_detects_and_prunes_git_dir_and_detects_git_file() {
        let body = render_find_expression("/x", 1, &ScanProfile::default());
        // detect-and-prune arm for the .git directory.
        assert!(body.contains("-type d -name .git -printf '%h\\0.git\\0' -prune"), "{body}");
        // .git also appears in the file-detect arm (worktree form).
        let file_arm = &body[body.find("-type f").unwrap()..];
        assert!(file_arm.contains("-name .git"), "{body}");
    }

    #[test]
    fn find_uses_nul_separated_pairs() {
        let body = render_find_expression("/x", 1, &ScanProfile::default());
        assert!(body.contains("-printf '%h\\0%f\\0'"), "{body}");
    }

    // --- find output parsing ---

    #[test]
    fn parses_find_pairs_into_candidates() {
        let out = b"/home/me/a\0.git\0/home/me/a\0Cargo.toml\0/home/me/b\0package.json\0";
        let cands = wsl_candidates(out, "Ubuntu", "loc1");
        assert_eq!(cands.len(), 3);
        assert_eq!(cands[0].path, "/home/me/a");
        assert_eq!(cands[0].marker, ".git");
        assert_eq!(cands[2].path, "/home/me/b");
        assert_eq!(cands[2].distro.as_deref(), Some("Ubuntu"));
    }

    // --- post-pass: identity + dedup ---

    #[test]
    fn merges_markers_and_sources_by_identity() {
        let cands = vec![
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a", ".git", "loc1"),
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a", "Cargo.toml", "loc1"),
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a", ".git", "loc2"),
        ];
        let projects = build_projects(cands, true);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "a");
        assert_eq!(projects[0].markers, vec![".git", "Cargo.toml"]); // sorted, deduped
        assert_eq!(projects[0].source_location_ids, vec!["loc1", "loc2"]);
    }

    // --- post-pass: nested pruning ---

    #[test]
    fn nested_off_drops_descendant_keeps_ancestor() {
        let cands = vec![
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a", ".git", "loc1"),
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a/b", ".git", "loc1"),
        ];
        let projects = build_projects(cands, false);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "/home/me/a");
    }

    #[test]
    fn nested_on_keeps_both() {
        let cands = vec![
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a", ".git", "loc1"),
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/a/b", ".git", "loc1"),
        ];
        let projects = build_projects(cands, true);
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn boundary_aware_prefix_is_not_an_ancestor() {
        // /home/me/foo is NOT an ancestor of /home/me/foo-bar despite the string prefix.
        let cands = vec![
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/foo", ".git", "loc1"),
            cand(LocationKind::Wsl, Some("Ubuntu"), "/home/me/foo-bar", ".git", "loc1"),
        ];
        let projects = build_projects(cands, false);
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn nesting_is_per_environment() {
        // identical-looking paths in different environments never prune each other.
        let cands = vec![
            cand(LocationKind::Wsl, Some("Ubuntu"), "/a", ".git", "loc1"),
            cand(LocationKind::Windows, None, "/a/b", ".git", "loc2"),
        ];
        let projects = build_projects(cands, false);
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn windows_nesting_is_case_insensitive() {
        let cands = vec![
            cand(LocationKind::Windows, None, "C:\\Code\\App", ".git", "loc1"),
            cand(LocationKind::Windows, None, "c:\\code\\app\\pkg", ".git", "loc1"),
        ];
        let projects = build_projects(cands, false);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "C:\\Code\\App");
    }

    // --- native walk (real fs) ---

    #[test]
    fn native_walk_finds_markers_respects_depth_and_ignores() {
        let base = std::env::temp_dir().join(format!("jump-scan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // a project at depth 1 with .git, and a nested node_modules that must be ignored.
        std::fs::create_dir_all(base.join("proj/.git")).unwrap();
        std::fs::write(base.join("proj/Cargo.toml"), "").unwrap();
        std::fs::create_dir_all(base.join("proj/node_modules/dep")).unwrap();
        std::fs::write(base.join("proj/node_modules/dep/package.json"), "").unwrap();
        // a project beyond the depth cap must not be found.
        std::fs::create_dir_all(base.join("a/b/c/deep")).unwrap();
        std::fs::write(base.join("a/b/c/deep/package.json"), "").unwrap();

        let scan = scan_native_location(
            base.to_str().unwrap(),
            2,
            "loc1",
            LocationKind::Mac,
        );
        assert!(scan.error.is_none());
        assert!(scan.unreadable_paths.is_empty());
        let projects = build_projects(scan.candidates, true);
        let paths: Vec<&str> = projects.iter().map(|p| p.path.as_str()).collect();

        let proj = base.join("proj").to_string_lossy().to_string();
        assert!(paths.contains(&proj.as_str()), "should find proj: {paths:?}");
        // node_modules content is ignored (not descended).
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "node_modules must be ignored: {paths:?}"
        );
        // the depth-4 project is beyond maxDepth 2.
        assert!(
            !paths.iter().any(|p| p.contains("deep")),
            "deep project beyond depth cap: {paths:?}"
        );
        // proj's markers include both .git and Cargo.toml.
        let proj_entry = projects.iter().find(|p| p.path == proj).unwrap();
        assert_eq!(proj_entry.kind, LocationKind::Mac);
        assert!(proj_entry.markers.contains(&".git".to_string()));
        assert!(proj_entry.markers.contains(&"Cargo.toml".to_string()));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn native_walk_unreadable_root_is_location_error() {
        let scan = scan_native_location(
            "/no/such/path/here",
            3,
            "loc1",
            LocationKind::Windows,
        );
        assert!(scan.error.is_some());
        assert!(scan.candidates.is_empty());
    }

    #[test]
    fn unreadable_descendant_is_collected_without_failing_the_location() {
        let mut paths = Vec::new();
        let result = handle_read_error(
            Path::new("/projects/blocked"),
            1,
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            &mut paths,
        );
        assert!(result.is_ok());
        assert_eq!(paths, vec!["/projects/blocked"]);
    }

    #[test]
    fn unreadable_root_remains_a_location_error() {
        let mut paths = Vec::new();
        let result = handle_read_error(
            Path::new("/projects"),
            0,
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            &mut paths,
        );
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert!(paths.is_empty());
    }

    // --- reconcile: missing-retention ---

    fn proj(id: &str, sources: &[&str], missing: bool) -> Project {
        Project {
            id: id.to_string(),
            kind: LocationKind::Wsl,
            distro: Some("Ubuntu".to_string()),
            path: format!("/home/me/{id}"),
            name: id.to_string(),
            markers: vec![".git".to_string()],
            source_location_ids: sources.iter().map(|s| s.to_string()).collect(),
            missing,
            explicit: false,
            github_url: None,
        }
    }

    #[test]
    fn reconcile_keeps_found_projects_not_missing() {
        let fresh = vec![proj("p1", &["loc1"], false)];
        let prev = vec![proj("p1", &["loc1"], false)];
        let ctx = ReconcileCtx {
            ok_location_ids: ["loc1".to_string()].into_iter().collect(),
            referenced_ids: BTreeSet::new(),
        };
        let out = reconcile(fresh, &prev, &ctx);
        assert_eq!(out.len(), 1);
        assert!(!out[0].missing);
    }

    #[test]
    fn reconcile_marks_referenced_disappearance_missing() {
        let fresh: Vec<Project> = vec![];
        let prev = vec![proj("p1", &["loc1"], false)];
        let ctx = ReconcileCtx {
            ok_location_ids: ["loc1".to_string()].into_iter().collect(),
            referenced_ids: ["p1".to_string()].into_iter().collect(),
        };
        let out = reconcile(fresh, &prev, &ctx);
        assert_eq!(out.len(), 1);
        assert!(out[0].missing);
    }

    #[test]
    fn reconcile_drops_unreferenced_disappearance() {
        let fresh: Vec<Project> = vec![];
        let prev = vec![proj("p1", &["loc1"], false)];
        let ctx = ReconcileCtx {
            ok_location_ids: ["loc1".to_string()].into_iter().collect(),
            referenced_ids: BTreeSet::new(),
        };
        let out = reconcile(fresh, &prev, &ctx);
        assert!(out.is_empty());
    }

    #[test]
    fn reconcile_preserves_when_location_failed() {
        // p1's only source location did not scan OK this run: preserve last-known-good,
        // do not mark missing, even though it's unreferenced.
        let fresh: Vec<Project> = vec![];
        let prev = vec![proj("p1", &["loc1"], false)];
        let ctx = ReconcileCtx {
            ok_location_ids: BTreeSet::new(), // loc1 failed
            referenced_ids: BTreeSet::new(),
        };
        let out = reconcile(fresh, &prev, &ctx);
        assert_eq!(out.len(), 1);
        assert!(!out[0].missing);
    }

    #[test]
    fn reconcile_preserves_source_from_unconfirmed_location() {
        // p1 found via loc1 this run; loc2 (a stopped distro) didn't scan. p1 should keep
        // loc2 in its source set so attribution survives until loc2 runs again.
        let fresh = vec![proj("p1", &["loc1"], false)];
        let prev = vec![proj("p1", &["loc1", "loc2"], false)];
        let ctx = ReconcileCtx {
            ok_location_ids: ["loc1".to_string()].into_iter().collect(),
            referenced_ids: BTreeSet::new(),
        };
        let out = reconcile(fresh, &prev, &ctx);
        assert_eq!(out[0].source_location_ids, vec!["loc1", "loc2"]);
    }

    // --- location removal ---

    #[test]
    fn removal_drops_only_when_source_set_empties() {
        let projects = vec![
            proj("p1", &["loc1"], false),        // only loc1 -> dropped
            proj("p2", &["loc1", "loc2"], false), // also loc2 -> kept, loc1 removed
        ];
        let out = remove_location_from_index(projects, "loc1");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "p2");
        assert_eq!(out[0].source_location_ids, vec!["loc2"]);
    }

    // --- explicit project merge ---

    /// A synthesized explicit entry: no source locations, `explicit` set, markers from the probe.
    fn explicit_proj(id: &str, markers: &[&str], missing: bool) -> Project {
        Project {
            id: id.to_string(),
            kind: LocationKind::Wsl,
            distro: Some("Ubuntu".to_string()),
            path: format!("/home/me/{id}"),
            name: id.to_string(),
            markers: markers.iter().map(|s| s.to_string()).collect(),
            source_location_ids: Vec::new(),
            missing,
            explicit: true,
            github_url: None,
        }
    }

    #[test]
    fn merge_appends_explicit_not_found_by_scan() {
        let discovered = vec![proj("p1", &["loc1"], false)];
        let explicit = vec![explicit_proj("p2", &[], false)];
        let out = merge_explicit_projects(discovered, explicit);
        assert_eq!(out.len(), 2);
        let p2 = out.iter().find(|p| p.id == "p2").unwrap();
        assert!(p2.explicit);
        assert!(p2.source_location_ids.is_empty());
    }

    #[test]
    fn merge_flags_discovered_project_explicit_and_unions_markers() {
        // p1 was scan-discovered (with .git) AND is an explicit seed (probe also saw Cargo.toml):
        // it keeps its sources, gains the explicit flag, and unions both markers.
        let discovered = vec![proj("p1", &["loc1"], false)];
        let explicit = vec![explicit_proj("p1", &["Cargo.toml"], false)];
        let out = merge_explicit_projects(discovered, explicit);
        assert_eq!(out.len(), 1, "must merge, not duplicate");
        let p1 = &out[0];
        assert!(p1.explicit);
        assert_eq!(p1.source_location_ids, vec!["loc1"]); // scanned facts preserved
        assert!(p1.markers.contains(&".git".to_string()));
        assert!(p1.markers.contains(&"Cargo.toml".to_string()));
    }

    #[test]
    fn merge_keeps_explicit_missing_when_appended() {
        // a folder-gone explicit seed is synthesized missing=true; the merge appends it verbatim.
        let out = merge_explicit_projects(vec![], vec![explicit_proj("p1", &[], true)]);
        assert_eq!(out.len(), 1);
        assert!(out[0].missing);
        assert!(out[0].explicit);
    }

    #[test]
    fn retain_known_drops_unconfigured_locations() {
        // loc2 was edited away (no longer a configured location); p2 keeps loc1, p3 had
        // only loc2 and is dropped.
        let projects = vec![
            proj("p2", &["loc1", "loc2"], false),
            proj("p3", &["loc2"], false),
        ];
        let known: BTreeSet<String> = ["loc1".to_string()].into_iter().collect();
        let out = retain_known_locations(projects, &known);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "p2");
        assert_eq!(out[0].source_location_ids, vec!["loc1"]);
    }
}
