//! The host platform as a value, not a `cfg`.
//!
//! Every platform-varying pure function in `jump-core` takes a `Platform` as a parameter
//! rather than consulting `cfg!`, so both platforms' logic is constructible and unit-testable
//! from any host: the macOS arms are exercised on a Windows CI runner and the Windows/WSL arms
//! on the owner's Mac. The shell resolves its own platform once (the sole `cfg!(target_os)` in
//! the codebase) and passes the value in.

use serde::{Deserialize, Serialize};

/// Which OS Jump is running on.
///
/// Deliberately a **different type** from `LocationKind`: a `Platform::Windows` host holds
/// both `LocationKind::Windows` and `LocationKind::Wsl` projects, so collapsing the two would
/// conflate "which OS am I on" with "where does this project live".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
}

impl Platform {
    /// Returns the stable lowercase token used on the wire.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_lowercase_tokens() {
        assert_eq!(
            serde_json::to_string(&Platform::Windows).unwrap(),
            "\"windows\""
        );
        assert_eq!(
            serde_json::to_string(&Platform::Macos).unwrap(),
            "\"macos\""
        );
    }

    #[test]
    fn deserializes_from_lowercase_tokens() {
        assert_eq!(
            serde_json::from_str::<Platform>("\"windows\"").unwrap(),
            Platform::Windows
        );
        assert_eq!(
            serde_json::from_str::<Platform>("\"macos\"").unwrap(),
            Platform::Macos
        );
    }

    #[test]
    fn string_tokens_match_serde() {
        for platform in [Platform::Windows, Platform::Macos] {
            let serialized = serde_json::to_string(&platform).unwrap();
            assert_eq!(serialized.trim_matches('"'), platform.as_str());
        }
    }
}
