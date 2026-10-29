//! Git remote parsing: resolve a project's GitHub web URL from its `.git/config`.
//!
//! Pure and tauri-independent so it unit-tests without a real repo. The scanner reads the
//! config bytes (Windows via `std::fs`, WSL via a native `bash` pass) and calls in here; the
//! resolved `https://github.com/owner/repo` URL is cached on the index entry so the launcher's
//! "Open in GitHub" item is a pure-frontend visibility check. GitHub-only in
//! v0; generalizes to other providers later.

/// Resolves the GitHub web URL for a repo from its `.git/config` contents, or `None` when there
/// is no GitHub remote. Prefers the `origin` remote; falls back to the first GitHub remote in
/// file order. Handles SSH (`git@github.com:o/r.git`), `ssh://`, `git://`, and HTTPS forms.
pub fn github_url_from_config(config: &str) -> Option<String> {
    let remotes = parse_remotes(config);

    // origin wins when it is itself a GitHub remote; otherwise take the first GitHub remote.
    if let Some((_, url)) = remotes.iter().find(|(name, _)| name == "origin") {
        if let Some(web) = github_web_url(url) {
            return Some(web);
        }
    }
    remotes.iter().find_map(|(_, url)| github_web_url(url))
}

/// Parses the `[remote "<name>"]` sections out of a `.git/config`, returning each remote's
/// name paired with its `url` (in file order, first `url` per remote).
fn parse_remotes(config: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current: Option<String> = None;

    for raw in config.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            current = section_remote_name(line);
            continue;
        }
        // a key line inside a remote section: capture the first `url = ...` we see.
        if let Some(name) = &current {
            if let Some(value) = key_value(line, "url") {
                if !out.iter().any(|(n, _)| n == name) {
                    out.push((name.clone(), value.to_string()));
                }
            }
        }
    }
    out
}

/// If `line` is a `[remote "<name>"]` header, returns `<name>`; otherwise `None` (and any
/// non-remote section clears the current remote context).
fn section_remote_name(line: &str) -> Option<String> {
    let inner = line.trim_start_matches('[').trim_end_matches(']').trim();
    // split the section type from its quoted subsection: `remote "origin"`.
    let (kind, rest) = inner.split_once(char::is_whitespace)?;
    // section names are case-insensitive in git; the quoted subsection (the remote name) is not.
    if !kind.eq_ignore_ascii_case("remote") {
        return None;
    }
    let name = rest.trim().trim_matches('"');
    (!name.is_empty()).then(|| name.to_string())
}

/// Splits a `key = value` line, returning the trimmed value when the key matches. Key names are
/// case-insensitive in git, so `URL = ...` resolves the same as `url = ...`.
fn key_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let (k, v) = line.split_once('=')?;
    k.trim().eq_ignore_ascii_case(key).then(|| v.trim())
}

/// Converts a single git remote URL to its GitHub web URL (`https://github.com/owner/repo`),
/// or `None` when the host is not exactly `github.com`. Handles the scp-like SSH form
/// (`[user@]host:path`) and the `scheme://[user@]host[:port]/path` URL forms.
pub fn github_web_url(remote: &str) -> Option<String> {
    let s = remote.trim();
    if s.is_empty() {
        return None;
    }

    let (host, path) = if let Some((_, after)) = s.split_once("://") {
        // URL form: split authority from path at the first slash.
        let (authority, path) = after.split_once('/')?;
        (host_of_authority(authority), path)
    } else if let Some((authority, path)) = s.split_once(':') {
        // scp-like form: `git@github.com:owner/repo`.
        (host_of_authority(authority), path)
    } else {
        return None;
    };

    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let repo = clean_repo_path(path)?;
    Some(format!("https://github.com/{repo}"))
}

/// Extracts the host from an `[user@]host[:port]` authority.
fn host_of_authority(authority: &str) -> &str {
    let after_user = authority.rsplit('@').next().unwrap_or(authority);
    after_user.split(':').next().unwrap_or(after_user)
}

/// Normalizes a remote's path to `owner/repo`: strips a leading slash, a trailing slash, and a
/// trailing `.git`. Returns `None` unless it looks like `owner/repo`.
fn clean_repo_path(path: &str) -> Option<String> {
    let p = path
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    if p.is_empty() || !p.contains('/') {
        return None;
    }
    Some(p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_scp_form_resolves() {
        assert_eq!(
            github_web_url("git@github.com:nathanclairmonte/jump.git"),
            Some("https://github.com/nathanclairmonte/jump".to_string())
        );
    }

    #[test]
    fn https_form_resolves_and_strips_git_suffix() {
        assert_eq!(
            github_web_url("https://github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn https_with_token_user_resolves() {
        assert_eq!(
            github_web_url("https://x-access-token:secret@github.com/owner/repo"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn ssh_scheme_form_resolves() {
        assert_eq!(
            github_web_url("ssh://git@github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn git_protocol_form_resolves() {
        assert_eq!(
            github_web_url("git://github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn trailing_slash_is_trimmed() {
        assert_eq!(
            github_web_url("https://github.com/owner/repo/"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn non_github_host_is_none() {
        assert!(github_web_url("git@gitlab.com:owner/repo.git").is_none());
        assert!(github_web_url("https://bitbucket.org/owner/repo.git").is_none());
        // enterprise GitHub on a different host is out of scope in v0.
        assert!(github_web_url("git@github.example.com:owner/repo.git").is_none());
    }

    #[test]
    fn host_match_is_case_insensitive() {
        assert_eq!(
            github_web_url("git@GitHub.com:Owner/Repo.git"),
            Some("https://github.com/Owner/Repo".to_string())
        );
    }

    #[test]
    fn missing_owner_repo_is_none() {
        assert!(github_web_url("https://github.com/owner").is_none());
        assert!(github_web_url("git@github.com:").is_none());
    }

    #[test]
    fn config_prefers_origin() {
        let config = "\
[remote \"upstream\"]
\turl = git@github.com:upstream/repo.git
[remote \"origin\"]
\turl = git@github.com:me/repo.git
";
        assert_eq!(
            github_url_from_config(config),
            Some("https://github.com/me/repo".to_string())
        );
    }

    #[test]
    fn config_falls_back_to_first_github_when_origin_not_github() {
        let config = "\
[remote \"origin\"]
\turl = git@gitlab.com:me/repo.git
[remote \"github\"]
\turl = https://github.com/me/mirror.git
";
        assert_eq!(
            github_url_from_config(config),
            Some("https://github.com/me/mirror".to_string())
        );
    }

    #[test]
    fn config_with_no_github_remote_is_none() {
        let config = "\
[remote \"origin\"]
\turl = git@gitlab.com:me/repo.git
";
        assert!(github_url_from_config(config).is_none());
    }

    #[test]
    fn config_with_no_remotes_is_none() {
        let config = "\
[core]
\trepositoryformatversion = 0
\tbare = false
[branch \"main\"]
\tremote = origin
";
        assert!(github_url_from_config(config).is_none());
    }

    #[test]
    fn section_and_key_names_are_case_insensitive() {
        // git treats the section type and key names case-insensitively; only the quoted
        // subsection (the remote's name) is case-sensitive.
        let config = "\
[Remote \"origin\"]
\tURL = git@github.com:me/repo.git
";
        assert_eq!(
            github_url_from_config(config),
            Some("https://github.com/me/repo".to_string())
        );
    }

    #[test]
    fn ignores_url_lines_outside_remote_sections() {
        // a `url` under a non-remote section (e.g. a submodule include) must not be picked up.
        let config = "\
[submodule \"x\"]
\turl = git@github.com:other/sub.git
[remote \"origin\"]
\turl = git@github.com:me/repo.git
";
        assert_eq!(
            github_url_from_config(config),
            Some("https://github.com/me/repo".to_string())
        );
    }
}
