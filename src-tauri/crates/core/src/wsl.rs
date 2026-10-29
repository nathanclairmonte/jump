//! WSL distro detection and path normalization, all pure parsing so it unit-tests
//! without a real `wsl.exe`. The shell runs the commands and feeds the raw bytes here.
//!
//! Two facts come from `wsl.exe`, both emitted as **UTF-16LE**:
//! - `wsl.exe -l -q`: installed distro names, one per line.
//! - `wsl.exe -l -v`: a table with the default marked `*` and a `Running`/`Stopped`
//!   state column. Listing state starts nothing, so reading it is side-effect-free,
//!   which is how we avoid waking a stopped distro.
//!
//! Path normalization collapses both WSL UNC prefixes (`\\wsl.localhost\` and `\\wsl$\`)
//! to a `{distro, linuxPath}` pair, and classifies a typed/picked path into the three
//! cases the Search Locations UI needs.

/// Whether a distro is ready to scan. Anything not explicitly `Running` is treated as
/// `Stopped` (we never wake it), so transient states like `Installing` correctly skip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistroState {
    Running,
    Stopped,
}

/// One row from `wsl.exe -l -v`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistroInfo {
    pub name: String,
    pub is_default: bool,
    pub state: DistroState,
}

/// A WSL path split into the distro and the in-distro Linux path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    pub linux_path: String,
}

/// How a typed or picked path should be treated by the Search Locations UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathClass {
    /// A WSL UNC path: distro was embedded in the path, no pick needed.
    Wsl(WslPath),
    /// A bare Linux path (starts with `/`) that needs the user to pick a distro.
    WslNeedsDistro { linux_path: String },
    /// A native Windows path (drive-letter or non-WSL UNC).
    Windows { path: String },
}

const PREFIX_LOCALHOST: &str = "\\\\wsl.localhost\\";
const PREFIX_DOLLAR: &str = "\\\\wsl$\\";

/// Decodes UTF-16LE bytes (as emitted by `wsl.exe`) into a `String`, tolerating a
/// leading BOM and an odd trailing byte.
pub fn decode_utf16le(bytes: &[u8]) -> String {
    // strip a leading little-endian BOM (0xFF 0xFE) if present.
    let bytes = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        &bytes[2..]
    } else {
        bytes
    };
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// Parses `wsl.exe -l -q` output into the list of installed distro names.
pub fn parse_distro_list(utf16le: &[u8]) -> Vec<String> {
    decode_utf16le(utf16le)
        .lines()
        .map(|line| line.trim().trim_matches('\u{0}').trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// Parses `wsl.exe -l -v` output into rows carrying the default marker and run state.
///
/// The table looks like (with leading spaces and a `*` on the default):
/// ```text
///   NAME      STATE      VERSION
/// * Ubuntu    Running    2
///   Debian    Stopped    2
/// ```
pub fn parse_distro_table(utf16le: &[u8]) -> Vec<DistroInfo> {
    let text = decode_utf16le(utf16le);
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // skip the header row, however it is localized in the NAME/STATE columns.
        let upper = trimmed.to_uppercase();
        if upper.contains("NAME") && upper.contains("STATE") {
            continue;
        }

        let is_default = trimmed.starts_with('*');
        let rest = trimmed.trim_start_matches('*').trim();
        let mut cols = rest.split_whitespace();
        let Some(name) = cols.next() else {
            continue;
        };
        let state = match cols.next() {
            Some(s) if s.eq_ignore_ascii_case("running") => DistroState::Running,
            _ => DistroState::Stopped,
        };
        out.push(DistroInfo {
            name: name.to_string(),
            is_default,
            state,
        });
    }
    out
}

/// Returns the default distro name (the one marked `*`), if any.
pub fn default_distro(distros: &[DistroInfo]) -> Option<&str> {
    distros
        .iter()
        .find(|d| d.is_default)
        .map(|d| d.name.as_str())
}

/// Normalizes a WSL UNC path (`\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`)
/// into `{distro, linuxPath}`. Returns `None` if the input is not a WSL UNC path.
pub fn normalize_unc(path: &str) -> Option<WslPath> {
    let rest = strip_prefix_ci(path, PREFIX_LOCALHOST)
        .or_else(|| strip_prefix_ci(path, PREFIX_DOLLAR))?;
    // the first segment is the distro; the remainder is the in-distro path.
    let mut segments = rest.splitn(2, '\\');
    let distro = segments.next().unwrap_or("").trim();
    if distro.is_empty() {
        return None;
    }
    let tail = segments.next().unwrap_or("");
    let linux_path = to_linux_path(tail);
    Some(WslPath {
        distro: distro.to_string(),
        linux_path,
    })
}

/// Builds the Windows UNC path for a WSL project (`\\wsl.localhost\<distro>\<path>`), turning
/// the Linux path's forward slashes into backslashes. The inverse of [`normalize_unc`], used to
/// hand a WSL project to Windows File Explorer. A root path (`/`) yields the distro share root.
pub fn to_unc(distro: &str, linux_path: &str) -> String {
    let tail = linux_path.trim_start_matches('/').replace('/', "\\");
    if tail.is_empty() {
        format!("{PREFIX_LOCALHOST}{distro}")
    } else {
        format!("{PREFIX_LOCALHOST}{distro}\\{tail}")
    }
}

/// Classifies a typed or picked path for the Search Locations UI.
pub fn classify_path(input: &str) -> PathClass {
    let trimmed = input.trim();
    if let Some(wsl) = normalize_unc(trimmed) {
        return PathClass::Wsl(wsl);
    }
    if trimmed.starts_with('/') {
        return PathClass::WslNeedsDistro {
            linux_path: normalize_linux_path(trimmed),
        };
    }
    PathClass::Windows {
        path: trimmed.to_string(),
    }
}

/// Converts a Windows-style tail (backslash-separated) into a leading-slash Linux path.
fn to_linux_path(tail: &str) -> String {
    let forward = tail.replace('\\', "/");
    normalize_linux_path(&forward)
}

/// Ensures a single leading slash and no trailing slash (except the bare root).
fn normalize_linux_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Case-insensitive prefix strip (UNC hosts are case-insensitive).
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes a `str` as UTF-16LE bytes for feeding the parsers, mirroring `wsl.exe`.
    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(utf16le("Ubuntu"));
        assert_eq!(decode_utf16le(&bytes), "Ubuntu");
    }

    #[test]
    fn parses_quiet_distro_list() {
        let bytes = utf16le("Ubuntu\r\nDebian\r\n\r\n");
        assert_eq!(parse_distro_list(&bytes), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn parses_verbose_table_with_default_and_state() {
        let table = "  NAME      STATE      VERSION\r\n\
                     * Ubuntu    Running    2\r\n\
                     \u{20}\u{20}Debian    Stopped    2\r\n";
        let distros = parse_distro_table(&utf16le(table));
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu");
        assert!(distros[0].is_default);
        assert_eq!(distros[0].state, DistroState::Running);
        assert_eq!(distros[1].name, "Debian");
        assert!(!distros[1].is_default);
        assert_eq!(distros[1].state, DistroState::Stopped);
        assert_eq!(default_distro(&distros), Some("Ubuntu"));
    }

    #[test]
    fn non_running_states_count_as_stopped() {
        let table = "  NAME      STATE         VERSION\r\n\
                     * Ubuntu    Installing    2\r\n";
        let distros = parse_distro_table(&utf16le(table));
        assert_eq!(distros[0].state, DistroState::Stopped);
    }

    #[test]
    fn normalizes_localhost_unc() {
        let wsl = normalize_unc("\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\proj").unwrap();
        assert_eq!(wsl.distro, "Ubuntu-22.04");
        assert_eq!(wsl.linux_path, "/home/me/proj");
    }

    #[test]
    fn normalizes_dollar_unc() {
        let wsl = normalize_unc("\\\\wsl$\\Ubuntu\\home\\me").unwrap();
        assert_eq!(wsl.distro, "Ubuntu");
        assert_eq!(wsl.linux_path, "/home/me");
    }

    #[test]
    fn unc_prefix_is_case_insensitive() {
        let wsl = normalize_unc("\\\\WSL.LocalHost\\Ubuntu\\home").unwrap();
        assert_eq!(wsl.distro, "Ubuntu");
        assert_eq!(wsl.linux_path, "/home");
    }

    #[test]
    fn unc_root_of_distro_normalizes_to_root() {
        let wsl = normalize_unc("\\\\wsl$\\Ubuntu\\").unwrap();
        assert_eq!(wsl.distro, "Ubuntu");
        assert_eq!(wsl.linux_path, "/");
    }

    #[test]
    fn non_wsl_unc_is_not_normalized() {
        assert!(normalize_unc("\\\\fileserver\\share\\dir").is_none());
        assert!(normalize_unc("C:\\Users\\me").is_none());
    }

    #[test]
    fn classifies_wsl_unc() {
        match classify_path("\\\\wsl.localhost\\Ubuntu\\home\\me") {
            PathClass::Wsl(w) => {
                assert_eq!(w.distro, "Ubuntu");
                assert_eq!(w.linux_path, "/home/me");
            }
            other => panic!("expected Wsl, got {other:?}"),
        }
    }

    #[test]
    fn classifies_bare_linux_path_as_needs_distro() {
        match classify_path("/home/me/code/") {
            PathClass::WslNeedsDistro { linux_path } => assert_eq!(linux_path, "/home/me/code"),
            other => panic!("expected WslNeedsDistro, got {other:?}"),
        }
    }

    #[test]
    fn classifies_windows_drive_path() {
        match classify_path("D:\\dev\\projects") {
            PathClass::Windows { path } => assert_eq!(path, "D:\\dev\\projects"),
            other => panic!("expected Windows, got {other:?}"),
        }
    }

    #[test]
    fn to_unc_builds_localhost_path() {
        assert_eq!(
            to_unc("Ubuntu", "/home/me/proj"),
            "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj"
        );
    }

    #[test]
    fn to_unc_root_is_the_distro_share() {
        assert_eq!(to_unc("Ubuntu", "/"), "\\\\wsl.localhost\\Ubuntu");
    }

    #[test]
    fn to_unc_round_trips_through_normalize() {
        let unc = to_unc("Ubuntu-22.04", "/home/me/proj");
        let back = normalize_unc(&unc).unwrap();
        assert_eq!(back.distro, "Ubuntu-22.04");
        assert_eq!(back.linux_path, "/home/me/proj");
    }
}
