use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use jump_core::model::Settings;
use jump_core::persist::Store;

use crate::hotkey::ActiveHotkey;

// the rust side owns the source of truth. the frontend holds only ui state
// and reaches settings/index through commands. settings is cached in memory so reads are
// cheap and a scan can snapshot it without touching disk; the store remains the
// canonical writer.
pub struct AppState {
    pub store: Store,
    pub settings: Mutex<Settings>,
    // single-scan guard: at most one scan runs at a time, so two triggers (background
    // startup + a manual rescan) can't double-write the index. locations *within* a scan
    // still run sequentially here; parallelism is a later optimization.
    pub scanning: AtomicBool,
    // set when a scan is requested while one is already running. instead of dropping the
    // coalesced request (which could miss an explicit add/remove made mid-scan, since the
    // running scan already snapshotted settings), the active scan loops once more.
    pub rescan_pending: AtomicBool,
    // serializes the index read-modify-write span so an instant mutation (a location
    // removal) can't interleave with a running scan and clobber its result. the scan holds
    // this across its whole load-then-save pass, so a removal either lands fully before or
    // fully after, never mid-flight.
    pub index_lock: Mutex<()>,
    // the live global hotkey: the actual Shortcut bound right now plus its registration
    // status. the shortcut handler compares presses against this (not a captured constant),
    // so a rebind takes effect immediately; the Shortcuts panel reads it for honest status.
    pub hotkey: Mutex<ActiveHotkey>,
}

impl AppState {
    pub fn new(store: Store, settings: Settings, hotkey: ActiveHotkey) -> Self {
        Self {
            store,
            settings: Mutex::new(settings),
            scanning: AtomicBool::new(false),
            rescan_pending: AtomicBool::new(false),
            index_lock: Mutex::new(()),
            hotkey: Mutex::new(hotkey),
        }
    }
}
