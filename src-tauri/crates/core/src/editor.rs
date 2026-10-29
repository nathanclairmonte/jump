//! Editor adapters: the pure command-construction + resolution logic for opening a
//! project in an editor. Detection (filesystem probing) and spawning are side-effects and
//! live in the Tauri shell crate. Everything here is pure so either host can test the full
//! editor by location by platform launch matrix.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::model::LocationKind;
use crate::platform::Platform;

/// The three editors v0 supports. A closed set drives all per-editor quirks; the wire
/// format stays the lowercase string keys (`vscode`/`cursor`/`zed`) so `settings.json`
/// remains hand-editable and an unknown key degrades to "no editor" rather than panicking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorKind {
    VsCode,
    Cursor,
    Zed,
}

impl EditorKind {
    /// Every editor, in display order. Drives the Editors UI and detection sweep.
    pub const ALL: [EditorKind; 3] = [EditorKind::VsCode, EditorKind::Cursor, EditorKind::Zed];

    /// The stable lowercase key used on the wire and as the `editors` map key.
    pub fn as_str(self) -> &'static str {
        match self {
            EditorKind::VsCode => "vscode",
            EditorKind::Cursor => "cursor",
            EditorKind::Zed => "zed",
        }
    }

    /// Parses a wire key back to a kind. Unknown keys return `None` so a stale or typo'd
    /// override resolves to "no editor" (and falls back) instead of erroring.
    pub fn from_key(key: &str) -> Option<EditorKind> {
        match key {
            "vscode" => Some(EditorKind::VsCode),
            "cursor" => Some(EditorKind::Cursor),
            "zed" => Some(EditorKind::Zed),
            _ => None,
        }
    }

    /// Human label for error messages (the frontend has its own copy for the UI).
    pub fn label(self) -> &'static str {
        match self {
            EditorKind::VsCode => "VS Code",
            EditorKind::Cursor => "Cursor",
            EditorKind::Zed => "Zed",
        }
    }

    /// The application target detection resolves to on the host platform.
    pub fn target_name(self, platform: Platform) -> &'static str {
        match (platform, self) {
            (Platform::Windows, EditorKind::VsCode) => "Code.exe",
            (Platform::Windows, EditorKind::Cursor) => "Cursor.exe",
            (Platform::Windows, EditorKind::Zed) => "zed.exe",
            (Platform::Macos, EditorKind::VsCode) => "Visual Studio Code.app",
            (Platform::Macos, EditorKind::Cursor) => "Cursor.app",
            (Platform::Macos, EditorKind::Zed) => "Zed.app",
        }
    }

    /// Known install locations to probe on a host platform. First hit wins.
    pub fn probe_paths(self, platform: Platform) -> &'static [&'static str] {
        match (platform, self) {
            (Platform::Windows, EditorKind::VsCode) => &[
                r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
                r"%PROGRAMFILES%\Microsoft VS Code\Code.exe",
                r"%PROGRAMFILES(X86)%\Microsoft VS Code\Code.exe",
            ],
            (Platform::Windows, EditorKind::Cursor) => &[
                r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe",
                r"%PROGRAMFILES%\cursor\Cursor.exe",
            ],
            (Platform::Windows, EditorKind::Zed) => {
                &[r"%LOCALAPPDATA%\Programs\Zed\zed.exe"]
            }
            (Platform::Macos, EditorKind::VsCode) => &[
                "/Applications/Visual Studio Code.app",
                "~/Applications/Visual Studio Code.app",
            ],
            (Platform::Macos, EditorKind::Cursor) => {
                &["/Applications/Cursor.app", "~/Applications/Cursor.app"]
            }
            (Platform::Macos, EditorKind::Zed) => {
                &["/Applications/Zed.app", "~/Applications/Zed.app"]
            }
        }
    }
}

/// How the shell must account for the child process after a successful spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildHandling {
    /// Wait for a short-lived adapter so its exit status and stderr remain observable.
    WaitForExit,
    /// Reap a potentially long-lived editor without blocking the launch command.
    ReapInBackground,
}

/// A fully-resolved spawn instruction: the program, argument vector, and child policy. Args
/// are kept as separate tokens (never a joined string) so the OS process layer quotes each
/// correctly and we sidestep batch/shell quoting entirely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub child_handling: ChildHandling,
}

/// Why a launch instruction cannot be built for the requested combination.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CommandBuildError {
    #[error("location kind '{kind}' is not supported on {platform}")]
    PlatformForeign { platform: &'static str, kind: String },
    #[error("no launch command resolved for {editor}")]
    MissingProgram { editor: &'static str },
    #[error("a WSL launch requires a distro")]
    MissingDistro,
}

/// Resolves the editor-owned CLI inside a macOS application bundle. Launch Services accepts
/// folders but VS Code can acknowledge that request without opening a workspace, while each
/// supported editor ships a CLI specifically for opening project paths.
fn macos_bundle_cli(editor: EditorKind, bundle: &str) -> String {
    join_macos_path(bundle, match editor {
        EditorKind::VsCode => "Contents/Resources/app/bin/code",
        EditorKind::Cursor => "Contents/Resources/app/bin/cursor",
        EditorKind::Zed => "Contents/MacOS/cli",
    })
}

/// Joins path components using macOS separators even when core is tested on Windows.
fn join_macos_path(base: &str, suffix: &str) -> String {
    let base = base.trim_end_matches('/');
    let suffix = suffix.trim_start_matches('/');
    if base.is_empty() {
        format!("/{suffix}")
    } else {
        format!("{base}/{suffix}")
    }
}

/// Recognizes a macOS application bundle without applying the test host's path rules.
fn is_macos_app_bundle(path: &str) -> bool {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("app"))
}

/// Resolves which editor a launch should use: project override wins, else the global
/// default. Unknown/absent keys fall through, so a missing default plus no override yields
/// `None` (the shell turns that into an honest "no editor configured" error, never a
/// silent no-op): we never silently switch the saved editor.
pub fn resolve_editor(
    default_editor: Option<&str>,
    project_override: Option<&str>,
) -> Option<EditorKind> {
    project_override
        .and_then(EditorKind::from_key)
        .or_else(|| default_editor.and_then(EditorKind::from_key))
}

/// Resolves with the full launch precedence: an explicit per-launch override (the error
/// card's Open-With pick) beats the project's stored override, which beats the global
/// default. Each level is consulted only if it parses to a known editor, so a stale or
/// typo'd value at one level falls through to the next instead of masking the levels below
/// it (a non-empty but unrecognized explicit pick must not silently skip the stored
/// override): we never silently switch the saved editor.
pub fn resolve_editor_layered(
    default_editor: Option<&str>,
    stored_override: Option<&str>,
    explicit_override: Option<&str>,
) -> Option<EditorKind> {
    explicit_override
        .and_then(EditorKind::from_key)
        .or_else(|| stored_override.and_then(EditorKind::from_key))
        .or_else(|| default_editor.and_then(EditorKind::from_key))
}

/// Builds the spawn instruction for opening `path` in `editor` under `env`.
///
/// - `exe` is the resolved Windows executable (from detection or a user override), or `None`
///   for the Zed+WSL combination, which routes through `wsl.exe` and needs no Windows exe.
///   The match owns that decision, so callers never synthesize a placeholder exe.
/// - `distro` is required for WSL targets; callers guarantee it (a WSL project always
///   carries one). It is unused for Windows targets.
///
/// The forms (validated against VS Code/Cursor on Windows):
/// - Windows: `<exe> "<winPath>"`, the path as its own argument (the reliable, as-designed
///   form; the deprecated `vscode://folder` URI scheme is avoided).
/// - WSL VS Code/Cursor: `<exe> --folder-uri=vscode-remote://wsl+<distro><linuxPath>`. The
///   `=` form keeps the URI a single argv token: Chromium filters out a standalone arg
///   containing `://`, so the spaced form fails silently on Windows.
/// - WSL Zed: best-effort `wsl.exe -d <distro> -- zed "<linuxPath>"`, which depends on a Zed
///   Linux CLI inside the distro.
pub fn build_command(
    platform: Platform,
    editor: EditorKind,
    env: &LocationKind,
    command: Option<&str>,
    path: &str,
    distro: Option<&str>,
) -> Result<CommandSpec, CommandBuildError> {
    if !env.is_supported_on(platform) {
        return Err(CommandBuildError::PlatformForeign {
            platform: platform.as_str(),
            kind: env.as_str().to_string(),
        });
    }

    let required_program = || {
        command
            .filter(|value| !value.trim().is_empty())
            .ok_or(CommandBuildError::MissingProgram {
                editor: editor.label(),
            })
    };

    Ok(match (platform, editor, env) {
        // every editor opens a native Windows folder by passing the path directly.
        (Platform::Windows, _, LocationKind::Windows) => CommandSpec {
            program: required_program()?.to_string(),
            args: vec![path.to_string()],
            child_handling: ChildHandling::ReapInBackground,
        },

        // vs code family: open the WSL remote folder via the Windows binary + folder-uri.
        (
            Platform::Windows,
            EditorKind::VsCode | EditorKind::Cursor,
            LocationKind::Wsl,
        ) => CommandSpec {
            program: required_program()?.to_string(),
            args: vec![format!(
                "--folder-uri=vscode-remote://wsl+{}{}",
                distro.ok_or(CommandBuildError::MissingDistro)?,
                path
            )],
            child_handling: ChildHandling::ReapInBackground,
        },

        // zed has no documented Windows-side CLI for an arbitrary WSL path, so reach into
        // the distro and run its Linux `zed` directly (exe is unused here). best-effort.
        (Platform::Windows, EditorKind::Zed, LocationKind::Wsl) => CommandSpec {
            program: "wsl.exe".to_string(),
            args: vec![
                "-d".to_string(),
                distro.ok_or(CommandBuildError::MissingDistro)?.to_string(),
                "--".to_string(),
                "zed".to_string(),
                path.to_string(),
            ],
            child_handling: ChildHandling::ReapInBackground,
        },

        // application bundles use the editor-owned CLI because Launch Services can report a
        // successful folder handoff without opening a workspace. executable overrides remain
        // direct and receive the project path.
        (Platform::Macos, _, LocationKind::Mac) => {
            let program = required_program()?;
            // checks the macOS path as text so foreign-platform tests cannot substitute the
            // host separator. trimming a trailing slash keeps detection and launch aligned.
            if is_macos_app_bundle(program) {
                CommandSpec {
                    program: macos_bundle_cli(editor, program),
                    args: vec![path.to_string()],
                    child_handling: ChildHandling::WaitForExit,
                }
            } else {
                CommandSpec {
                    program: program.to_string(),
                    args: vec![path.to_string()],
                    child_handling: ChildHandling::ReapInBackground,
                }
            }
        }

        _ => unreachable!("supported platform and location pairs are exhaustive"),
    })
}

/// Expands `%VAR%` tokens in `template`, resolving each via `lookup`. Returns `None` if any
/// referenced variable is absent or a `%` is left unbalanced, so a template that can't be
/// fully formed is skipped rather than probed with a literal `%VAR%` left in it. The env read
/// is injected, so the `%`-pairing logic stays pure and is unit-tested here; the shell passes
/// a closure over `std::env::var`.
pub fn expand_vars(template: &str, lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&lookup(&after[..end])?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// Expands macOS home markers in a probe template using an injected home directory.
pub fn expand_home(template: &str, home: Option<&str>) -> Option<String> {
    if let Some(rest) = template.strip_prefix("~/") {
        return Some(join_macos_path(home?, rest));
    }
    if template == "~" {
        return Some(home?.to_string());
    }
    if template.contains("$HOME") {
        return Some(template.replace("$HOME", home?));
    }
    Some(template.to_string())
}

/// The ordered candidate paths a PATH lookup of `cmd` should stat: per dir, the bare name
/// first, then `cmd + ext` for each `;`-separated `pathext` entry (empties skipped). Returns
/// empty when `cmd` is path-like (a separator means it isn't a bare-command PATH lookup, so
/// the caller stats it directly instead). Pure so the lookup order is unit-tested; the shell
/// stats each in turn and takes the first that exists.
pub fn path_lookup_candidates(
    platform: Platform,
    dirs: &[PathBuf],
    cmd: &str,
    pathext: &str,
) -> Vec<PathBuf> {
    if cmd.contains('/') || cmd.contains('\\') {
        return Vec::new();
    }
    let mut out = Vec::new();
    for dir in dirs {
        out.push(dir.join(cmd));
        if platform == Platform::Windows {
            for ext in pathext.split(';').filter(|e| !e.is_empty()) {
                out.push(dir.join(format!("{cmd}{ext}")));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_round_trips_for_every_editor() {
        for ed in EditorKind::ALL {
            assert_eq!(EditorKind::from_key(ed.as_str()), Some(ed));
        }
    }

    #[test]
    fn unknown_key_is_none() {
        assert_eq!(EditorKind::from_key("vs-code"), None);
        assert_eq!(EditorKind::from_key(""), None);
        assert_eq!(EditorKind::from_key("emacs"), None);
    }

    #[test]
    fn serde_uses_lowercase_keys() {
        let json = serde_json::to_string(&EditorKind::VsCode).unwrap();
        assert_eq!(json, "\"vscode\"");
        let back: EditorKind = serde_json::from_str("\"zed\"").unwrap();
        assert_eq!(back, EditorKind::Zed);
    }

    #[test]
    fn resolve_prefers_override_then_default() {
        // override wins over default.
        assert_eq!(
            resolve_editor(Some("vscode"), Some("cursor")),
            Some(EditorKind::Cursor)
        );
        // no override falls back to default.
        assert_eq!(resolve_editor(Some("vscode"), None), Some(EditorKind::VsCode));
        // an unknown override falls through to the default rather than erroring.
        assert_eq!(
            resolve_editor(Some("zed"), Some("nonsense")),
            Some(EditorKind::Zed)
        );
        // nothing configured -> nothing resolved (the shell makes this an honest error).
        assert_eq!(resolve_editor(None, None), None);
        assert_eq!(resolve_editor(Some("bogus"), None), None);
    }

    #[test]
    fn layered_resolution_falls_through_each_invalid_level() {
        // a valid explicit pick wins over both stored and default.
        assert_eq!(
            resolve_editor_layered(Some("vscode"), Some("cursor"), Some("zed")),
            Some(EditorKind::Zed)
        );
        // an invalid explicit pick falls through to the stored override, NOT the default.
        assert_eq!(
            resolve_editor_layered(Some("vscode"), Some("cursor"), Some("garbage")),
            Some(EditorKind::Cursor)
        );
        // invalid explicit + no stored falls through to the default.
        assert_eq!(
            resolve_editor_layered(Some("vscode"), None, Some("garbage")),
            Some(EditorKind::VsCode)
        );
        // no explicit pick uses the stored override over the default.
        assert_eq!(
            resolve_editor_layered(Some("vscode"), Some("zed"), None),
            Some(EditorKind::Zed)
        );
        // nothing valid anywhere resolves to nothing.
        assert_eq!(resolve_editor_layered(None, None, Some("garbage")), None);
    }

    // --- command construction matrix (all editor x location x platform combinations) ---

    #[test]
    fn command_matrix_accepts_only_host_supported_locations() {
        let locations = [
            LocationKind::Windows,
            LocationKind::Wsl,
            LocationKind::Mac,
            LocationKind::Unknown("future-os".to_string()),
        ];
        for platform in [Platform::Windows, Platform::Macos] {
            for editor in EditorKind::ALL {
                for location in &locations {
                    let command = if platform == Platform::Macos {
                        Some(editor.target_name(platform))
                    } else if editor == EditorKind::Zed && location == &LocationKind::Wsl {
                        None
                    } else {
                        Some(editor.target_name(platform))
                    };
                    let result = build_command(
                        platform,
                        editor,
                        location,
                        command,
                        "/project",
                        Some("Ubuntu"),
                    );
                    assert_eq!(
                        result.is_ok(),
                        location.is_supported_on(platform),
                        "{platform:?} {editor:?} {location:?}: {result:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn windows_and_wsl_forms_are_preserved() {
        let windows = build_command(
            Platform::Windows,
            EditorKind::VsCode,
            &LocationKind::Windows,
            Some(r"C:\VS\Code.exe"),
            r"C:\Users\me\proj",
            None,
        )
        .unwrap();
        assert_eq!(windows.program, r"C:\VS\Code.exe");
        assert_eq!(windows.args, vec![r"C:\Users\me\proj"]);

        let wsl = build_command(
            Platform::Windows,
            EditorKind::Cursor,
            &LocationKind::Wsl,
            Some(r"C:\Cursor\Cursor.exe"),
            "/home/me/folder.with.dot",
            Some("Ubuntu"),
        )
        .unwrap();
        assert_eq!(
            wsl.args,
            vec!["--folder-uri=vscode-remote://wsl+Ubuntu/home/me/folder.with.dot"]
        );

        let zed = build_command(
            Platform::Windows,
            EditorKind::Zed,
            &LocationKind::Wsl,
            None,
            "/home/me/my project",
            Some("Ubuntu"),
        )
        .unwrap();
        assert_eq!(zed.program, "wsl.exe");
        assert_eq!(zed.args.last().unwrap(), "/home/me/my project");
    }

    #[test]
    fn mac_bundle_uses_editor_cli_while_executable_override_runs_directly() {
        let bundle = build_command(
            Platform::Macos,
            EditorKind::VsCode,
            &LocationKind::Mac,
            Some("/Applications/Visual Studio Code.app"),
            "/Users/me/My Project",
            None,
        )
        .unwrap();
        assert_eq!(
            bundle.program,
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
        );
        assert_eq!(bundle.child_handling, ChildHandling::WaitForExit);
        assert_eq!(bundle.args, vec!["/Users/me/My Project"]);

        let executable = build_command(
            Platform::Macos,
            EditorKind::VsCode,
            &LocationKind::Mac,
            Some("/usr/local/bin/code"),
            "/Users/me/project",
            None,
        )
        .unwrap();
        assert_eq!(executable.program, "/usr/local/bin/code");
        assert_eq!(
            executable.child_handling,
            ChildHandling::ReapInBackground
        );
        assert_eq!(executable.args, vec!["/Users/me/project"]);

        let bundle_with_trailing_separator = build_command(
            Platform::Macos,
            EditorKind::Cursor,
            &LocationKind::Mac,
            Some("/Applications/Cursor.app/"),
            "/Users/me/project",
            None,
        )
        .unwrap();
        assert_eq!(
            bundle_with_trailing_separator.program,
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
        );
        assert_eq!(
            bundle_with_trailing_separator.child_handling,
            ChildHandling::WaitForExit
        );

        let zed_bundle = build_command(
            Platform::Macos,
            EditorKind::Zed,
            &LocationKind::Mac,
            Some("/Applications/Zed.app"),
            "/Users/me/project",
            None,
        )
        .unwrap();
        assert_eq!(
            zed_bundle.program,
            "/Applications/Zed.app/Contents/MacOS/cli"
        );
    }

    #[test]
    fn every_editor_has_platform_specific_probe_paths() {
        for platform in [Platform::Windows, Platform::Macos] {
            for editor in EditorKind::ALL {
                let paths = editor.probe_paths(platform);
                let target = editor.target_name(platform);
                assert!(!paths.is_empty(), "{} has no probe paths", editor.as_str());
                assert!(
                    paths.iter().all(|path| path.ends_with(target)),
                    "{} probe paths must target {target}",
                    editor.as_str()
                );
            }
        }
    }

    // --- env-var expansion ---

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |v| pairs.iter().find(|(k, _)| *k == v).map(|(_, val)| val.to_string())
    }

    #[test]
    fn expand_substitutes_known_vars() {
        let got = expand_vars(
            r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe",
            lookup(&[("LOCALAPPDATA", r"C:\Users\me\AppData\Local")]),
        );
        assert_eq!(
            got,
            Some(r"C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe".to_string())
        );
    }

    #[test]
    fn expand_handles_a_paren_named_var_and_multiple_tokens() {
        // PROGRAMFILES(X86) is a real var name; the parens live between the % delimiters.
        let got = expand_vars(
            r"%PROGRAMFILES(X86)%\%APP%\Code.exe",
            lookup(&[("PROGRAMFILES(X86)", r"C:\Program Files (x86)"), ("APP", "VS Code")]),
        );
        assert_eq!(got, Some(r"C:\Program Files (x86)\VS Code\Code.exe".to_string()));
    }

    #[test]
    fn expand_with_no_vars_is_identity() {
        assert_eq!(expand_vars(r"C:\fixed\path.exe", lookup(&[])), Some(r"C:\fixed\path.exe".to_string()));
    }

    #[test]
    fn expand_returns_none_when_a_var_is_unset() {
        // a template that can't be fully formed is skipped, not probed with %VAR% left in.
        assert_eq!(expand_vars(r"%MISSING%\x.exe", lookup(&[])), None);
    }

    #[test]
    fn expand_returns_none_on_an_unbalanced_percent() {
        assert_eq!(expand_vars(r"%LOCALAPPDATA\x.exe", lookup(&[("LOCALAPPDATA", "C:")])), None);
    }

    #[test]
    fn expand_home_supports_tilde_and_home_variable() {
        assert_eq!(
            expand_home("~/Applications/Zed.app", Some("/Users/me")),
            Some("/Users/me/Applications/Zed.app".to_string())
        );
        assert_eq!(
            expand_home("$HOME/bin/code", Some("/Users/me")),
            Some("/Users/me/bin/code".to_string())
        );
        assert_eq!(
            expand_home("~/Applications/Zed.app", Some("/Users/me/")),
            Some("/Users/me/Applications/Zed.app".to_string())
        );
        assert_eq!(expand_home("~/bin/code", Some("/")), Some("/bin/code".to_string()));
        assert_eq!(expand_home("~/Applications/Zed.app", None), None);
    }

    // --- PATH lookup candidate ordering ---

    #[test]
    fn path_candidates_try_bare_then_each_ext_per_dir() {
        // expectations are built with the same `join` so the OS path separator is irrelevant
        // (these run on linux under WSL but the logic ships on windows).
        let (a, b) = (PathBuf::from("dir_a"), PathBuf::from("dir_b"));
        let got = path_lookup_candidates(
            Platform::Windows,
            &[a.clone(), b.clone()],
            "code",
            ".EXE;.CMD",
        );
        assert_eq!(
            got,
            vec![
                a.join("code"),
                a.join("code.EXE"),
                a.join("code.CMD"),
                b.join("code"),
                b.join("code.EXE"),
                b.join("code.CMD"),
            ]
        );
    }

    #[test]
    fn path_candidates_skip_empty_pathext_entries() {
        let a = PathBuf::from("dir_a");
        // a trailing `;` (or a doubled one) must not yield a bare-name duplicate.
        let got = path_lookup_candidates(Platform::Windows, &[a.clone()], "zed", ".EXE;;");
        assert_eq!(got, vec![a.join("zed"), a.join("zed.EXE")]);
    }

    #[test]
    fn path_candidates_are_empty_for_a_path_like_command() {
        // a separator means it's not a bare-command PATH lookup; the caller stats it directly.
        let dirs = vec![PathBuf::from("dir_a")];
        assert!(path_lookup_candidates(
            Platform::Windows,
            &dirs,
            r"C:\tools\code.exe",
            ".EXE"
        )
        .is_empty());
        assert!(path_lookup_candidates(Platform::Macos, &dirs, "tools/code", "").is_empty());
    }

    #[test]
    fn mac_path_candidates_do_not_apply_windows_extensions() {
        let dir = PathBuf::from("bin");
        assert_eq!(
            path_lookup_candidates(Platform::Macos, std::slice::from_ref(&dir), "code", ".EXE"),
            vec![dir.join("code")]
        );
    }
}
