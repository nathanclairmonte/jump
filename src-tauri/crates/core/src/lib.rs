//! Pure, tauri-independent domain logic for Jump.
//!
//! Everything here is free of the Tauri webview stack, so either host can test both
//! platforms' pure rules. The Tauri shell owns commands, events, native UI, and processes.

pub mod editor;
pub mod git;
pub mod hotkey;
pub mod model;
pub mod persist;
pub mod platform;
pub mod scan;
pub mod wsl;
