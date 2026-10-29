//! The data model: serde structs serialized to `settings.json` (user-authored) and
//! `projects-index.json` (generated cache), plus deterministic id derivation.
//!
//! Conventions:
//! - every persisted struct is `#[serde(rename_all = "camelCase", default)]` so keys
//!   match the hand-editable file and any missing field falls back to its `Default`.
//! - identity (`id`) is a deterministic content hash of `(kind, distro, path)`, never a
//!   random uuid, so pins/recents/overrides keyed by id survive a rescan.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::platform::Platform;

/// Bumped only on a breaking change to the on-disk shape. v0 ships `1`; there is no
/// migration code yet, but stamping it gives a future change a hook.
pub const SCHEMA_VERSION: u32 = 1;

/// The default global hotkey. Kept here so the model's default and the shell's
/// registration can't drift.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Space";

/// The default per-location scan depth (project-dir depth, root = 0).
pub const DEFAULT_SCAN_DEPTH: u32 = 3;

// ---------------------------------------------------------------------------
// environment kind
// ---------------------------------------------------------------------------

/// Which environment a location or project lives in. Part of identity.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum LocationKind {
    /// A native Windows folder, scanned with `walkdir`.
    #[default]
    Windows,
    /// A folder inside a WSL distro, scanned natively via `wsl.exe ... find`.
    Wsl,
    /// A native macOS folder, scanned with the shared filesystem walker.
    Mac,
    /// A kind written by a newer or external client. The token is preserved exactly.
    Unknown(String),
}

impl LocationKind {
    /// The stable lowercase token used in id hashing and the env badge.
    pub fn as_str(&self) -> &str {
        match self {
            LocationKind::Windows => "windows",
            LocationKind::Wsl => "wsl",
            LocationKind::Mac => "mac",
            LocationKind::Unknown(token) => token,
        }
    }

    /// Returns the native location kind created by add flows on a host platform.
    pub fn native_for(platform: Platform) -> Self {
        match platform {
            Platform::Windows => Self::Windows,
            Platform::Macos => Self::Mac,
        }
    }

    /// Whether this location can be scanned or launched on the host platform.
    pub fn is_supported_on(&self, platform: Platform) -> bool {
        matches!(
            (platform, self),
            (Platform::Windows, Self::Windows | Self::Wsl)
                | (Platform::Macos, Self::Mac)
        )
    }
}

impl Serialize for LocationKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for LocationKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let token = String::deserialize(deserializer)?;
        Ok(match token.as_str() {
            "windows" => Self::Windows,
            "wsl" => Self::Wsl,
            "mac" => Self::Mac,
            _ => Self::Unknown(token),
        })
    }
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/// Derives the deterministic id for a project or search location from its identity
/// tuple. The components are NUL-separated before hashing so boundaries can't collide
/// (distro `a` + path `/b` must not equal distro `a/b` + empty path).
///
/// The id is opaque (a hash, not a readable string) so it is always a safe JSON object
/// key regardless of what the path contains. The readable triple stays in the entry's
/// own fields.
pub fn derive_id(kind: &LocationKind, distro: Option<&str>, path: &str) -> String {
    let canonical = canonical_id_path(kind, path);
    let mut hasher = blake3::Hasher::new();
    hasher.update(kind.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(distro.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(canonical.as_bytes());
    // 128 bits is far more than enough to avoid collisions across a personal index, and
    // keeps the id short enough to read at a glance in the json.
    let hash = hasher.finalize();
    hex16(hash.as_bytes())
}

/// Canonicalizes a path for *id purposes only* (never for storage or display), so the
/// same on-disk directory yields one id. Windows is case-insensitive and accepts either
/// slash, so we fold case and separators; macOS is case-insensitive too but slash-only;
/// WSL is case-sensitive, so we leave it alone. A trailing separator is stripped in all.
fn canonical_id_path(kind: &LocationKind, path: &str) -> String {
    match kind {
        LocationKind::Windows => {
            let unified = path.replace('/', "\\");
            let trimmed = unified.trim_end_matches('\\');
            trimmed.to_lowercase()
        }
        LocationKind::Wsl => trim_keep_root(path, &['/']).to_string(),
        LocationKind::Mac => trim_keep_root(path, &['/']).to_lowercase(),
        LocationKind::Unknown(_) => trim_keep_root(path, &['/', '\\']).to_string(),
    }
}

/// Strips trailing separators, except when that would erase a bare root ("/" trims to "",
/// which must stay distinct from the empty path).
fn trim_keep_root<'a>(path: &'a str, separators: &[char]) -> &'a str {
    let trimmed = path.trim_end_matches(separators);
    if trimmed.is_empty() && path.starts_with(separators) {
        &path[..1]
    } else {
        trimmed
    }
}

/// Hex-encodes the first 16 bytes of a hash.
fn hex16(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for &b in bytes.iter().take(16) {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ---------------------------------------------------------------------------
// settings.json (user-authored)
// ---------------------------------------------------------------------------

/// The single dark theme shipped in v0. The control is deferred; the field
/// exists so the file shape is stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
}

/// One of the four preset spine colors a user can assign to a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectColor {
    Teal,
    Amber,
    Rose,
    Green,
}

/// Per-editor config (command override + detection/validation cache). `serde(default)`
/// lets new fields be added later without breaking older files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorConfig {
    /// User override for the editor's base launch command. `None` -> use detection.
    pub command: Option<String>,
}

/// App-only metadata layered onto a project by id. Never touches disk under the
/// project's folder; lives entirely in `settings.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectOverride {
    pub alias: Option<String>,
    pub tags: Vec<String>,
    pub color: Option<ProjectColor>,
    /// Editor key (e.g. "vscode") to use for this project, overriding the global default.
    pub editor_override: Option<String>,
    /// Hidden from the launcher/search until restored.
    pub excluded: bool,
}

/// A launch record. `lastOpenedAt` is epoch milliseconds (the shell stamps it; core
/// stays clock-free for deterministic tests).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recent {
    pub id: String,
    pub last_opened_at: u64,
    pub open_count: u32,
}

/// A configured place to scan. Its id is derived from `(kind, distro, path)`, so editing
/// `maxDepth` is id-stable while editing the path is a different location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchLocation {
    pub kind: LocationKind,
    /// Windows path for `windows`; Linux path for `wsl`.
    pub path: String,
    /// Required for `wsl`, `None` for `windows`.
    pub distro: Option<String>,
    pub max_depth: u32,
}

impl Default for SearchLocation {
    fn default() -> Self {
        Self {
            kind: LocationKind::Windows,
            path: String::new(),
            distro: None,
            max_depth: DEFAULT_SCAN_DEPTH,
        }
    }
}

impl SearchLocation {
    /// The deterministic id for this location, matching the `sourceLocationIds` stored on
    /// index entries.
    pub fn id(&self) -> String {
        derive_id(&self.kind, self.distro.as_deref(), &self.path)
    }
}

/// A user-added project that should always appear in the index, even when no Search
/// Location's scan would discover it (e.g. a marker-less folder, or one outside every
/// scanned location). Stored in `settings.json`; the scan engine synthesizes an index
/// entry for each seed every pass. Carries identity only, `(kind, distro, path)`,
/// so its derived id matches the index `Project` and any pins/recents/overrides keyed by that id
/// keep working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExplicitProject {
    pub kind: LocationKind,
    /// Windows path for `windows`; Linux path for `wsl`.
    pub path: String,
    /// Required for `wsl`, `None` for `windows`.
    pub distro: Option<String>,
}

impl Default for ExplicitProject {
    fn default() -> Self {
        Self {
            kind: LocationKind::Windows,
            path: String::new(),
            distro: None,
        }
    }
}

impl ExplicitProject {
    /// The deterministic id for this explicit project, matching the synthesized index
    /// `Project` entry and any settings keyed by the same identity.
    pub fn id(&self) -> String {
        derive_id(&self.kind, self.distro.as_deref(), &self.path)
    }
}

/// The full user-authored settings document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub launch_at_startup: bool,
    pub rescan_on_startup: bool,
    pub theme: Theme,
    /// Editor key (e.g. "vscode") used when a project has no editor override. resolution
    /// is wired later; the field exists now so the shape is stable.
    pub default_editor: Option<String>,
    pub include_nested_projects: bool,
    pub default_scan_depth: u32,
    pub hotkey: String,
    pub search_locations: Vec<SearchLocation>,
    /// User-added projects that always appear, independent of the scan.
    pub explicit_projects: Vec<ExplicitProject>,
    pub editors: BTreeMap<String, EditorConfig>,
    /// Project ids in user-chosen pin order.
    pub pinned_order: Vec<String>,
    /// App-only metadata keyed by project id.
    pub project_overrides: BTreeMap<String, ProjectOverride>,
    pub recents: Vec<Recent>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            launch_at_startup: false,
            rescan_on_startup: true,
            theme: Theme::Dark,
            default_editor: None,
            include_nested_projects: false,
            default_scan_depth: DEFAULT_SCAN_DEPTH,
            hotkey: DEFAULT_HOTKEY.to_string(),
            search_locations: Vec::new(),
            explicit_projects: Vec::new(),
            editors: BTreeMap::new(),
            pinned_order: Vec::new(),
            project_overrides: BTreeMap::new(),
            recents: Vec::new(),
        }
    }
}

/// Normalizes a free-form tag list (Projects table chip editor): trims each tag, drops empties,
/// and dedupes case-insensitively while preserving input order and the first spelling seen. Pure
/// so the command and any dev mock share one rule.
pub fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_lowercase()) {
            out.push(trimmed.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// projects-index.json (generated cache)
// ---------------------------------------------------------------------------

/// One project in the generated index. Holds only *scanned facts* plus the `missing`
/// flag; app-only state (pinned/recent/excluded/explicit) is derived by joining against
/// `settings.json` in the launcher/settings layer, never stored here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: String,
    pub kind: LocationKind,
    pub distro: Option<String>,
    /// Full path: Linux path for `wsl`, Windows path for `windows`.
    pub path: String,
    /// The folder name (display name; duplicates across the index are allowed).
    pub name: String,
    /// Which markers were found in the folder (e.g. `.git`, `Cargo.toml`).
    pub markers: Vec<String>,
    /// The set of locations that discovered this project, as a sorted unique list. Drives
    /// exact removal and missing detection.
    pub source_location_ids: Vec<String>,
    /// True when a successful scan of its source location(s) no longer found it but
    /// something in settings still references it, per the missing-retention rule.
    pub missing: bool,
    /// True when this entry was seeded by an `ExplicitProject` (it always appears, even if
    /// the scan wouldn't otherwise find it). A scan-discovered folder that is *also* an
    /// explicit seed carries both its scanned facts and this flag.
    pub explicit: bool,
    /// The project's GitHub web URL (`https://github.com/owner/repo`), resolved at scan time
    /// from `.git/config` when the origin (or first GitHub) remote points at github.com; `None`
    /// otherwise. Drives the launcher's "Open in GitHub" action. `serde(default)` lets an older
    /// index load with `None` until the next scan repopulates it.
    pub github_url: Option<String>,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: LocationKind::Windows,
            distro: None,
            path: String::new(),
            name: String::new(),
            markers: Vec::new(),
            source_location_ids: Vec::new(),
            github_url: None,
            missing: false,
            explicit: false,
        }
    }
}

/// The outcome of scanning a single location. Lives in the generated index, not in
/// settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocationState {
    /// Scanned successfully.
    #[default]
    Ok,
    /// WSL distro is installed but stopped; skipped without waking it.
    DistroStopped,
    /// WSL distro is not installed (absent from `-l -q`).
    DistroMissing,
    /// The location path was unreachable or the scan errored.
    Error,
    /// The scan root itself could not be read because access was denied.
    PermissionDenied,
    /// The configured location belongs to a different or unknown platform.
    PlatformForeign,
}

/// Per-location scan status, surfaced in the Settings status line.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocationScanStatus {
    pub location_id: String,
    pub project_count: usize,
    pub state: LocationState,
    /// Human-readable detail for `Error` (and optional context for the others).
    pub error: Option<String>,
    /// Descendant directories skipped because they could not be read.
    pub unreadable_paths: Vec<String>,
    /// Total unreadable descendants, including paths omitted from the bounded stored list.
    pub unreadable_path_count: usize,
    /// Epoch milliseconds of this location's last scan attempt.
    pub last_scan_at: Option<u64>,
}

/// The global scan report carried alongside the index entries.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanReport {
    /// Epoch milliseconds of the last completed scan.
    pub last_scan_at: Option<u64>,
    pub duration_ms: Option<u64>,
    pub total_count: usize,
    pub locations: Vec<LocationScanStatus>,
}

/// The generated index document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectsIndex {
    pub schema_version: u32,
    pub projects: Vec<Project>,
    pub scan: ScanReport,
}

impl Default for ProjectsIndex {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            projects: Vec::new(),
            scan: ScanReport::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_is_deterministic_for_same_identity() {
        let a = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj");
        let b = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj");
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn id_differs_by_environment_distro_and_path() {
        let wsl = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj");
        let win = derive_id(&LocationKind::Windows, None, "/home/me/proj");
        let other_distro = derive_id(&LocationKind::Wsl, Some("Debian"), "/home/me/proj");
        let other_path = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/other");
        assert_ne!(wsl, win);
        assert_ne!(wsl, other_distro);
        assert_ne!(wsl, other_path);
    }

    #[test]
    fn nul_separation_prevents_component_collision() {
        // distro "a" + path "/b" must not hash the same as distro "a/b" + empty path.
        let split = derive_id(&LocationKind::Wsl, Some("a"), "/b");
        let merged = derive_id(&LocationKind::Wsl, Some("a/b"), "");
        assert_ne!(split, merged);
    }

    #[test]
    fn windows_id_is_case_and_separator_insensitive() {
        let a = derive_id(&LocationKind::Windows, None, "C:\\Foo\\Bar");
        let b = derive_id(&LocationKind::Windows, None, "c:/foo/bar");
        let c = derive_id(&LocationKind::Windows, None, "C:\\Foo\\Bar\\");
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn wsl_id_is_case_sensitive() {
        let lower = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj");
        let upper = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/Proj");
        assert_ne!(lower, upper);
    }

    #[test]
    fn mac_id_is_case_insensitive_and_preserves_display_path() {
        let lower = derive_id(&LocationKind::Mac, None, "/Users/nathan/Projects/jump");
        let upper = derive_id(&LocationKind::Mac, None, "/users/NATHAN/projects/JUMP/");
        assert_eq!(lower, upper);

        let location = SearchLocation {
            kind: LocationKind::Mac,
            path: "/Users/Nathan/Projects/Jump".to_string(),
            distro: None,
            max_depth: 3,
        };
        assert_eq!(location.path, "/Users/Nathan/Projects/Jump");
    }

    #[test]
    fn unknown_kind_round_trips_its_original_token() {
        let kind: LocationKind = serde_json::from_str("\"future-os\"").unwrap();
        assert_eq!(kind, LocationKind::Unknown("future-os".to_string()));
        assert_eq!(serde_json::to_string(&kind).unwrap(), "\"future-os\"");
    }

    #[test]
    fn location_support_is_platform_explicit() {
        assert!(LocationKind::Windows.is_supported_on(Platform::Windows));
        assert!(LocationKind::Wsl.is_supported_on(Platform::Windows));
        assert!(LocationKind::Mac.is_supported_on(Platform::Macos));
        assert!(!LocationKind::Mac.is_supported_on(Platform::Windows));
        assert!(!LocationKind::Wsl.is_supported_on(Platform::Macos));
        assert!(!LocationKind::Unknown("linux".to_string()).is_supported_on(Platform::Macos));
    }

    #[test]
    fn wsl_trailing_slash_ignored_but_root_preserved() {
        let a = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj");
        let b = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj/");
        assert_eq!(a, b);
        // the root itself stays distinct from the empty path.
        let root = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/");
        let empty = derive_id(&LocationKind::Wsl, Some("Ubuntu"), "");
        assert_ne!(root, empty);
    }

    #[test]
    fn location_id_matches_derive_id() {
        let loc = SearchLocation {
            kind: LocationKind::Wsl,
            path: "/home/me/code".to_string(),
            distro: Some("Ubuntu".to_string()),
            max_depth: 3,
        };
        assert_eq!(
            loc.id(),
            derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/code")
        );
    }

    #[test]
    fn location_id_stable_across_depth_change() {
        let shallow = SearchLocation {
            max_depth: 2,
            ..SearchLocation {
                kind: LocationKind::Windows,
                path: "D:\\code".to_string(),
                distro: None,
                max_depth: 0,
            }
        };
        let deep = SearchLocation {
            max_depth: 5,
            ..shallow.clone()
        };
        assert_eq!(shallow.id(), deep.id());
    }

    #[test]
    fn normalize_tags_trims_drops_empty_and_dedupes_case_insensitively() {
        let out = normalize_tags(vec![
            "  Rust ".to_string(),
            "rust".to_string(), // case-insensitive dup of the first
            "".to_string(),     // dropped
            "   ".to_string(),  // whitespace-only dropped
            "CLI".to_string(),
        ]);
        // first spelling wins, input order preserved.
        assert_eq!(out, vec!["Rust".to_string(), "CLI".to_string()]);
    }

    #[test]
    fn explicit_project_id_matches_derive_id_and_index_entry() {
        let ep = ExplicitProject {
            kind: LocationKind::Wsl,
            path: "/home/me/notes".to_string(),
            distro: Some("Ubuntu".to_string()),
        };
        // the seed's id must match what a synthesized index entry (and any pin/recent/override
        // keyed by the same identity) would derive, so the merge-by-id lines them up.
        assert_eq!(
            ep.id(),
            derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/notes")
        );
    }

    #[test]
    fn settings_defaults_match_spec() {
        let s = Settings::default();
        assert_eq!(s.schema_version, 1);
        assert!(!s.launch_at_startup);
        assert!(s.rescan_on_startup);
        assert!(!s.include_nested_projects);
        assert_eq!(s.default_scan_depth, 3);
        assert_eq!(s.hotkey, "Ctrl+Alt+Space");
        assert!(s.search_locations.is_empty());
    }

    #[test]
    fn settings_partial_json_fills_missing_with_defaults() {
        // a file written by an older build that only knows about a couple of fields must
        // still load, with everything else defaulted.
        let json = r#"{ "hotkey": "Ctrl+Shift+J" }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.hotkey, "Ctrl+Shift+J");
        assert!(s.rescan_on_startup); // defaulted, not false
        assert_eq!(s.default_scan_depth, 3);
        assert_eq!(s.schema_version, 1);
    }

    #[test]
    fn settings_unknown_fields_are_ignored() {
        // a file written by a newer build (extra field) must load in an older binary.
        let json = r#"{ "hotkey": "Ctrl+Alt+Space", "someFutureField": 42 }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.hotkey, "Ctrl+Alt+Space");
    }

    #[test]
    fn settings_round_trip_is_camel_case() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"launchAtStartup\""));
        assert!(json.contains("\"rescanOnStartup\""));
        assert!(json.contains("\"searchLocations\""));
        assert!(json.contains("\"explicitProjects\""));
        assert!(json.contains("\"schemaVersion\""));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn index_round_trips() {
        let idx = ProjectsIndex {
            schema_version: SCHEMA_VERSION,
            projects: vec![Project {
                id: derive_id(&LocationKind::Wsl, Some("Ubuntu"), "/home/me/proj"),
                kind: LocationKind::Wsl,
                distro: Some("Ubuntu".to_string()),
                path: "/home/me/proj".to_string(),
                name: "proj".to_string(),
                markers: vec![".git".to_string(), "Cargo.toml".to_string()],
                source_location_ids: vec!["loc1".to_string()],
                missing: false,
                explicit: false,
                github_url: Some("https://github.com/me/proj".to_string()),
            }],
            scan: ScanReport {
                last_scan_at: Some(1_700_000_000_000),
                duration_ms: Some(42),
                total_count: 1,
                locations: vec![LocationScanStatus {
                    location_id: "loc1".to_string(),
                    project_count: 1,
                    state: LocationState::Ok,
                    error: None,
                    unreadable_paths: Vec::new(),
                    unreadable_path_count: 0,
                    last_scan_at: Some(1_700_000_000_000),
                }],
            },
        };
        let json = serde_json::to_string(&idx).unwrap();
        assert!(json.contains("\"sourceLocationIds\""));
        let back: ProjectsIndex = serde_json::from_str(&json).unwrap();
        assert_eq!(idx, back);
    }
}
