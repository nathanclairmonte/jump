//! On-disk persistence: the custom `jump` config dir, atomic JSON writes, and tolerant
//! loads.
//!
//! - The config dir is a custom `jump` folder under the OS's conventional config root,
//!   resolved manually (not from the bundle identifier): `%APPDATA%\jump` on Windows,
//!   `~/Library/Application Support/jump` on macOS. Resolution is a pure function of a
//!   `Platform` plus injected env values, so both platforms' logic is testable from either
//!   host and this crate reads no environment itself.
//! - Writes are atomic (temp file in the same dir, then rename) so a crash mid-write can
//!   never leave a half-written file.
//! - Loads are tolerant: a missing file yields defaults (and is **not** written back;
//!   the default `settings.json` is created lazily on the first real change, keeping
//!   the "absent -> first-run" trigger pristine). A genuinely corrupt file is backed up
//!   to `*.bak` and replaced by defaults, never crashing or silently discarding data.

use std::path::{Path, PathBuf};

use crate::model::{ProjectsIndex, Settings};
use crate::platform::Platform;

#[derive(Debug, thiserror::Error)]
pub enum PersistError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialize error: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("config dir could not be resolved: {0}")]
    ConfigDir(String),
}

const SETTINGS_FILE: &str = "settings.json";
const INDEX_FILE: &str = "projects-index.json";
const LOGS_DIR: &str = "logs";

/// Owns the config directory and the read/write operations over its files.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Creates a store rooted at an explicit config dir (used by the shell after resolving
    /// the platform config dir via [`config_dir`], and by tests with a temp dir).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dir.join(SETTINGS_FILE)
    }

    pub fn index_path(&self) -> PathBuf {
        self.dir.join(INDEX_FILE)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.dir.join(LOGS_DIR)
    }

    /// Creates the config dir and `logs/` if absent. Call before writing.
    pub fn ensure_dirs(&self) -> Result<(), PersistError> {
        std::fs::create_dir_all(&self.dir)?;
        std::fs::create_dir_all(self.logs_dir())?;
        Ok(())
    }

    /// Whether `settings.json` exists. The shell uses this for the first-run trigger.
    pub fn settings_exist(&self) -> bool {
        self.settings_path().exists()
    }

    /// Loads settings, tolerating absence (-> defaults, not written back) and corruption
    /// (-> `.bak` + defaults).
    pub fn load_settings(&self) -> Settings {
        load_tolerant(&self.settings_path(), "settings")
    }

    /// Atomically writes settings as pretty JSON (the file is hand-editable).
    pub fn save_settings(&self, settings: &Settings) -> Result<(), PersistError> {
        self.ensure_dirs()?;
        let json = serde_json::to_string_pretty(settings)?;
        atomic_write(&self.settings_path(), json.as_bytes())?;
        Ok(())
    }

    /// Loads the generated index, tolerating absence and corruption like settings.
    pub fn load_index(&self) -> ProjectsIndex {
        load_tolerant(&self.index_path(), "index")
    }

    /// Atomically writes the generated index.
    pub fn save_index(&self, index: &ProjectsIndex) -> Result<(), PersistError> {
        self.ensure_dirs()?;
        let json = serde_json::to_string_pretty(index)?;
        atomic_write(&self.index_path(), json.as_bytes())?;
        Ok(())
    }
}

/// `<base>/jump`. The on-disk folder name is decoupled from the reverse-DNS bundle
/// identifier on purpose.
pub fn config_dir_in(base: &Path) -> PathBuf {
    base.join("jump")
}

/// Resolves the config dir for a platform from injected env values, purely: this crate
/// reads no environment, so both arms are testable from any host. Windows resolves under
/// `%APPDATA%`, macOS under `$HOME/Library/Application Support`.
///
/// Each arm errors when its own required input is absent rather than falling back to a
/// disposable temp dir (the old shell behaviour, which would silently write a Mac user's
/// data somewhere the OS is free to delete). Failure is the caller's cue to fail loudly.
pub fn config_dir(
    platform: Platform,
    appdata: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, PersistError> {
    match platform {
        Platform::Windows => {
            let base = appdata
                .ok_or_else(|| PersistError::ConfigDir("APPDATA is not set".to_string()))?;
            Ok(config_dir_in(Path::new(base)))
        }
        Platform::Macos => {
            let base =
                home.ok_or_else(|| PersistError::ConfigDir("HOME is not set".to_string()))?;
            Ok(config_dir_in(
                &Path::new(base).join("Library").join("Application Support"),
            ))
        }
    }
}

/// Reads + parses a JSON file into `T`, falling back to `T::default()` on a missing file
/// (silently) or a corrupt file (after backing the bad file up to `*.bak`).
fn load_tolerant<T>(path: &Path, label: &str) -> T
where
    T: serde::de::DeserializeOwned + Default,
{
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(?path, error = %err, "could not read {label} file; using defaults");
            }
            return T::default();
        }
    };
    match serde_json::from_slice::<T>(&bytes) {
        Ok(value) => value,
        Err(err) => {
            tracing::error!(?path, error = %err, "corrupt {label} file; backing up and using defaults");
            backup_corrupt(path);
            T::default()
        }
    }
}

/// Renames a corrupt file aside to `<name>.bak` so its contents survive for inspection
/// while a fresh default takes its place.
fn backup_corrupt(path: &Path) {
    let mut bak = path.as_os_str().to_os_string();
    bak.push(".bak");
    if let Err(err) = std::fs::rename(path, PathBuf::from(&bak)) {
        tracing::warn!(?path, error = %err, "could not back up corrupt file");
    }
}

/// Writes bytes atomically: a temp file in the *same directory* (so the rename stays on
/// one filesystem and is atomic), then `rename` over the destination.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent dir")
    })?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tmp");
    // pid in the temp name avoids two writers colliding on the temp file itself.
    let tmp = dir.join(format!(".{file_name}.{}.tmp", std::process::id()));

    // fsync the temp file's data to disk *before* the rename, so a power loss can't let
    // the rename land ahead of the bytes and leave a zero-length or torn file in place.
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }

    // rename is atomic on the same filesystem; on windows it also replaces the target.
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }

    // attempt to fsync the directory so the rename entry itself is durable. platforms that
    // cannot open directories simply retain the temp-file sync above as their durable point.
    if let Ok(dir_file) = std::fs::File::open(dir) {
        let _ = dir_file.sync_all();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LocationKind, SearchLocation};

    /// A unique temp config dir for one test.
    fn temp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("jump-persist-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Store::new(dir)
    }

    #[test]
    fn config_dir_appends_jump() {
        let dir = config_dir_in(Path::new("C:\\Users\\me\\AppData\\Roaming"));
        assert!(dir.ends_with("jump"));
    }

    #[test]
    fn windows_config_dir_lives_under_appdata() {
        let dir = config_dir(
            Platform::Windows,
            Some("C:\\Users\\me\\AppData\\Roaming"),
            // home is irrelevant on windows and must not be consulted.
            Some("/Users/me"),
        )
        .unwrap();
        assert_eq!(dir, PathBuf::from("C:\\Users\\me\\AppData\\Roaming").join("jump"));
    }

    #[test]
    fn macos_config_dir_lives_under_application_support() {
        let dir = config_dir(
            Platform::Macos,
            // appdata is irrelevant on macos and must not be consulted.
            Some("C:\\ignored"),
            Some("/Users/me"),
        )
        .unwrap();
        assert_eq!(
            dir,
            PathBuf::from("/Users/me/Library/Application Support/jump")
        );
    }

    #[test]
    fn unresolvable_config_dir_errors_rather_than_falling_back() {
        // the whole point of the amendment: a missing base is a hard error, never a silent
        // temp dir. asserted for both platforms, and both are checked from either host.
        assert!(config_dir(Platform::Windows, None, Some("/Users/me")).is_err());
        assert!(config_dir(Platform::Macos, Some("C:\\x"), None).is_err());
    }

    #[test]
    fn missing_settings_returns_defaults_without_writing() {
        let store = temp_store("missing");
        let s = store.load_settings();
        assert_eq!(s.hotkey, "Ctrl+Alt+Space");
        // lazy-write: load must not create the file (keeps the first-run trigger).
        assert!(!store.settings_exist());
    }

    #[test]
    fn settings_round_trip() {
        let store = temp_store("roundtrip");
        let mut s = Settings::default();
        s.search_locations.push(SearchLocation {
            kind: LocationKind::Wsl,
            path: "/home/me/code".to_string(),
            distro: Some("Ubuntu".to_string()),
            max_depth: 4,
        });
        store.save_settings(&s).unwrap();
        assert!(store.settings_exist());

        let loaded = store.load_settings();
        assert_eq!(loaded, s);
        // pretty json on disk for hand-editing.
        let raw = std::fs::read_to_string(store.settings_path()).unwrap();
        assert!(raw.contains('\n'));
        assert!(raw.contains("\"searchLocations\""));

        let _ = std::fs::remove_dir_all(store.dir());
    }

    #[test]
    fn corrupt_settings_is_backed_up_and_defaulted() {
        let store = temp_store("corrupt");
        store.ensure_dirs().unwrap();
        std::fs::write(store.settings_path(), b"{ this is not json").unwrap();

        let s = store.load_settings();
        assert_eq!(s, Settings::default());

        let mut bak = store.settings_path().into_os_string();
        bak.push(".bak");
        assert!(PathBuf::from(bak).exists(), "corrupt file should be backed up");

        let _ = std::fs::remove_dir_all(store.dir());
    }

    #[test]
    fn unknown_location_kind_is_preserved_without_marking_settings_corrupt() {
        let store = temp_store("unknown-kind");
        store.ensure_dirs().unwrap();
        std::fs::write(
            store.settings_path(),
            br#"{"searchLocations":[{"kind":"future-os","path":"/projects","maxDepth":3}]}"#,
        )
        .unwrap();

        let settings = store.load_settings();
        assert_eq!(
            settings.search_locations[0].kind,
            LocationKind::Unknown("future-os".to_string())
        );
        store.save_settings(&settings).unwrap();
        let saved = std::fs::read_to_string(store.settings_path()).unwrap();
        assert!(saved.contains("\"kind\": \"future-os\""));

        let mut backup = store.settings_path().into_os_string();
        backup.push(".bak");
        assert!(!PathBuf::from(backup).exists());
        let _ = std::fs::remove_dir_all(store.dir());
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let store = temp_store("atomic");
        store.ensure_dirs().unwrap();
        let path = store.dir().join("f.json");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        // no leftover temp files in the dir.
        let leftovers: Vec<_> = std::fs::read_dir(store.dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file should be renamed away");

        let _ = std::fs::remove_dir_all(store.dir());
    }

    #[test]
    fn index_round_trip() {
        let store = temp_store("index");
        let idx = ProjectsIndex::default();
        store.save_index(&idx).unwrap();
        let loaded = store.load_index();
        assert_eq!(loaded, idx);
        let _ = std::fs::remove_dir_all(store.dir());
    }
}
