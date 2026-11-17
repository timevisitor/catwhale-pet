// Anti-cheat compatibility game mode.
//
// This module only detects processes and publishes state.  The main integration is
// responsible for hiding/restoring windows, releasing hotkeys and stopping media /
// sysinfo workers when `pet:gamemode` is emitted.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const POLL_MS: u64 = 8_000;
const GAME_GUARD_PROCS: [&str; 7] = [
    "SGuard64.exe",
    "SGuardSvc64.exe",
    "ACE-Tray.exe",
    "EasyAntiCheat.exe",
    "EasyAntiCheat_EOS.exe",
    "BEService.exe",
    "vgc.exe",
];

#[derive(Default)]
struct GameModeState {
    active: bool,
    reason: String,
    since: u64,
    /// None = automatic, Some(true) = forced on, Some(false) = forced off.
    manual: Option<bool>,
    last_scan: u64,
    scans: u64,
}

fn state() -> &'static Mutex<GameModeState> {
    static STATE: OnceLock<Mutex<GameModeState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(GameModeState::default()))
}

fn app_handle() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

fn scan_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_state() -> MutexGuard<'static, GameModeState> {
    state().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("com.hermes.catwhalepoc")
        })
        .join("settings.json")
}

fn read_settings(app: &AppHandle) -> (bool, Vec<String>) {
    let raw = std::fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let cfg = raw.get("gameMode").unwrap_or(&Value::Null);
    let auto = cfg.get("auto").and_then(Value::as_bool).unwrap_or(true);
    let extra = cfg
        .get("extraProcs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    (auto, extra)
}

fn fallback_snapshot() -> Value {
    let st = lock_state();
    json!({
        "active": st.active,
        "reason": st.reason,
        "manual": match st.manual { Some(true) => "on", Some(false) => "off", None => "" },
        "auto": true,
        "scans": st.scans,
        "procs": GAME_GUARD_PROCS,
    })
}

fn snapshot(app: &AppHandle) -> Value {
    let (auto, extra) = read_settings(app);
    let st = lock_state();
    let procs = GAME_GUARD_PROCS
        .iter()
        .map(|name| (*name).to_string())
        .chain(extra)
        .collect::<Vec<_>>();
    json!({
        "active": st.active,
        "reason": st.reason,
        "manual": match st.manual { Some(true) => "on", Some(false) => "off", None => "" },
        "auto": auto,
        "scans": st.scans,
        "procs": procs,
    })
}

fn apply(on: bool, reason: &str) {
    let changed = {
        let mut st = lock_state();
        if st.active == on {
            if on && !reason.is_empty() {
                st.reason = reason.to_string();
            }
            false
        } else {
            st.active = on;
            st.reason = if on { reason.to_string() } else { String::new() };
            st.since = now_ms();
            true
        }
    };
    if changed {
        if let Some(app) = app_handle().get() {
            let _ = app.emit("pet:gamemode", json!({ "on": on, "reason": reason }));
        }
    }
}

fn tick(app: &AppHandle) {
    // A manual command and the periodic worker may wake together.  Serialize a whole
    // decision so a slower process scan cannot overwrite a newer manual choice.
    let _scan_guard = scan_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let manual = lock_state().manual;
    match manual {
        Some(true) => return apply(true, "手动开启"),
        Some(false) => return apply(false, ""),
        None => {}
    }

    let (auto, extra) = read_settings(app);
    if !auto {
        return apply(false, "");
    }

    let names = process_names();
    {
        let mut st = lock_state();
        st.last_scan = now_ms();
        st.scans = st.scans.saturating_add(1);
    }
    // Enumeration failure deliberately preserves the previous state, matching the
    // Electron implementation and avoiding visibility flapping.
    let Some(names) = names else { return };
    let hit = GAME_GUARD_PROCS
        .iter()
        .map(|name| (*name).to_string())
        .chain(extra)
        .find(|name| names.contains(&name.to_lowercase()));
    match hit {
        Some(name) => apply(true, &name),
        None => apply(false, ""),
    }
}

/// Start the idempotent eight-second watcher.  Call once from Tauri `setup`.
pub fn gamemode_init(app: &AppHandle) {
    let _ = app_handle().set(app.clone());
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    // Keep the original command-line verification entry points.
    for arg in std::env::args() {
        match arg.as_str() {
            "--gamemode=on" => lock_state().manual = Some(true),
            "--gamemode=off" => lock_state().manual = Some(false),
            _ => {}
        }
    }

    tick(app);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        tick(&app);
    });
}

#[tauri::command]
pub fn gamemode_get(app: AppHandle) -> Value {
    let _ = app_handle().set(app.clone());
    snapshot(&app)
}

pub fn gamemode_active() -> bool {
    lock_state().active
}

/// `Some(true)` forces on, `Some(false)` forces off, `None` returns to auto mode.
#[tauri::command]
pub fn gamemode_set_manual(on: Option<bool>) -> Value {
    lock_state().manual = on;
    if let Some(app) = app_handle().get().cloned() {
        tick(&app);
        snapshot(&app)
    } else {
        // Useful for early main-process calls before Tauri setup has installed the app.
        match on {
            Some(true) => apply(true, "手动开启"),
            Some(false) => apply(false, ""),
            None => {}
        }
        fallback_snapshot()
    }
}

#[cfg(windows)]
fn process_names() -> Option<HashSet<String>> {
    toolhelp::process_names()
}

#[cfg(not(windows))]
fn process_names() -> Option<HashSet<String>> {
    None
}

/// Minimal Toolhelp binding: avoids expanding the existing `windows` crate feature
/// list just for three functions.  Only image names are read; no process is opened.
#[cfg(windows)]
mod toolhelp {
    use super::HashSet;
    use core::ffi::c_void;

    type Handle = *mut c_void;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const MAX_PATH: usize = 260;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; MAX_PATH],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub(super) fn process_names() -> Option<HashSet<String>> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot == (-1isize as Handle) {
                return None;
            }
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
            if Process32FirstW(snapshot, &mut entry) == 0 {
                CloseHandle(snapshot);
                return None;
            }
            let mut names = HashSet::new();
            loop {
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|ch| *ch == 0)
                    .unwrap_or(MAX_PATH);
                names.insert(String::from_utf16_lossy(&entry.sz_exe_file[..len]).to_lowercase());
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
            CloseHandle(snapshot);
            Some(names)
        }
    }
}
