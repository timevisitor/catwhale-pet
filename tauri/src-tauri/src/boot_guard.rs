// Startup watchdog and persistent L0-L3 compatibility levels.
//
// `boot_guard_init_early` is intended for `main()` before the Tauri builder creates
// any WebView2 instance.  The returned switches/features are recommendations only;
// main remains responsible for applying them and for delaying window creation.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const CRASH_WINDOW_MS: u64 = 10 * 60 * 1000;
const BOOT_PHASES: [&str; 3] = ["process-boot", "window-created", "page-loaded"];
const LEVEL_DELAYS_MS: [u64; 4] = [0, 800, 800, 3000];
const LEVEL_NOTES: [&str; 4] = [
    "正常",
    "延迟 0.8 秒建窗（让输入法注入先跑完，改时序）",
    "再关硬件加速（透明窗口走软件合成）",
    "再拉长到 3 秒、降置顶级别、禁用 GPU",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct BootState {
    level: u8,
    run_level: u8,
    fails: u64,
    phase: String,
    last_start: u64,
    last_crashed_phase: String,
    last_crashed_at: u64,
    note: String,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl Default for BootState {
    fn default() -> Self {
        Self {
            level: 0,
            run_level: 0,
            fails: 0,
            phase: String::new(),
            last_start: 0,
            last_crashed_phase: String::new(),
            last_crashed_at: 0,
            note: LEVEL_NOTES[0].to_string(),
            extra: BTreeMap::new(),
        }
    }
}

struct Inner {
    state: Mutex<BootState>,
    state_path: PathBuf,
    log_path: PathBuf,
    started_at: u64,
    run_level: u8,
}

/// Recommendations and the phase recorder for one process lifetime.
#[derive(Clone)]
pub struct BootGuard {
    pub level: u8,
    pub delay_ms: u64,
    pub persist_level: u8,
    pub features: Vec<String>,
    pub switches: Vec<String>,
    pub crashed_last_time: bool,
    pub last_crashed_phase: String,
    pub state_path: PathBuf,
    pub log_path: PathBuf,
    pub ime: Vec<PathBuf>,
    inner: Arc<Inner>,
}

impl BootGuard {
    /// Additional WebView2 switches.  Merge `features` into the existing single
    /// `--disable-features=` argument instead of appending a second occurrence.
    pub fn additional_browser_args(&self) -> String {
        self.switches.join(" ")
    }

    pub fn disable_hardware_acceleration(&self) -> bool {
        self.level >= 2
    }

    pub fn always_on_top_level(&self) -> &'static str {
        if self.level >= 3 { "normal" } else { "screen-saver" }
    }

    /// Record a startup stage.  Stages only move forward; `ready` and `quit` are
    /// terminal for ordinary stage updates, while `quit` may follow `ready`.
    pub fn phase(&self, name: &str) {
        self.phase_with(name, None);
    }

    pub fn phase_with(&self, name: &str, extra: Option<Value>) {
        let Some(next_rank) = phase_rank(name) else { return };
        let elapsed = {
            let mut state = self.lock_state();
            // Unknown legacy states are replaced by the first valid new stage.
            let current_rank = phase_rank(&state.phase).unwrap_or(0);
            if state.phase == "quit"
                || (state.phase == "ready" && name != "quit")
                || next_rank < current_rank
            {
                return;
            }
            state.phase = name.to_string();
            state.last_start = if state.last_start == 0 { self.inner.started_at } else { state.last_start };
            state.run_level = self.inner.run_level;
            if let Some(Value::Object(values)) = extra {
                state.extra.extend(values);
            }
            write_state(&self.inner.state_path, &state);
            now_ms().saturating_sub(self.inner.started_at)
        };
        append_log(
            &self.inner.log_path,
            &format!("[{}] PHASE {name} +{elapsed}ms", iso_time(now_ms())),
        );
    }

    pub fn describe(&self) -> String {
        if self.level == 0 {
            return "正常启动".to_string();
        }
        let mut text = format!("兼容模式 L{}：{}", self.level, LEVEL_NOTES[self.level as usize]);
        if !self.last_crashed_phase.is_empty() {
            text.push_str(&format!("（上次启动停在 {}）", self.last_crashed_phase));
        }
        text
    }

    pub fn snapshot(&self) -> Value {
        let state = self.lock_state();
        json!({
            "level": self.level,
            "runLevel": self.inner.run_level,
            "persistLevel": self.persist_level,
            "delayMs": self.delay_ms,
            "features": self.features,
            "switches": self.switches,
            "crashedLastTime": self.crashed_last_time,
            "lastCrashedPhase": self.last_crashed_phase,
            "phase": state.phase,
            "fails": state.fails,
            "description": self.describe(),
            "statePath": self.state_path,
            "logPath": self.log_path,
            "ime": self.ime,
        })
    }

    fn lock_state(&self) -> MutexGuard<'_, BootState> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn phase_rank(name: &str) -> Option<u8> {
    match name {
        "process-boot" => Some(0),
        "window-created" => Some(1),
        "page-loaded" => Some(2),
        "ready" => Some(3),
        "quit" => Some(4),
        _ => None,
    }
}

/// App-handle variant for callers that initialize after Tauri setup.
pub fn boot_guard_init(app: &tauri::AppHandle) -> BootGuard {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| default_config_dir());
    init_in_dir(dir, std::env::args().collect())
}

/// Early variant required to affect WebView2 before any window is created.
pub fn boot_guard_init_early() -> BootGuard {
    init_in_dir(default_config_dir(), std::env::args().collect())
}

fn default_config_dir() -> PathBuf {
    // 与 chat::config_dir() 认同一个覆盖变量。看门狗在应用对象建立之前就要落状态文件，
    // 拿不到 Tauri 的 app_config_dir()，于是这里单独算路径 —— 不认覆盖变量的话，
    // 带 CATWHALE_CONFIG_DIR 的隔离测试每次都会写进用户的真实配置目录
    // （boot-guard.json / boot-guard.log），隔离就只剩一半。
    if let Some(dir) = std::env::var_os("CATWHALE_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.hermes.catwhalepoc")
}

fn init_in_dir(dir: PathBuf, argv: Vec<String>) -> BootGuard {
    let state_path = dir.join("boot-guard.json");
    let log_path = dir.join("boot-guard.log");
    let started_at = now_ms();
    let previous = read_state(&state_path);

    let crashed_last_time = BOOT_PHASES.contains(&previous.phase.as_str())
        && previous.last_start > 0
        && started_at.saturating_sub(previous.last_start) < CRASH_WINDOW_MS;

    let reset = argv.iter().any(|arg| arg == "--compat-reset");
    let mut persist_level = if reset { 0 } else { previous.level.min(3) };
    if crashed_last_time && !reset {
        persist_level = (persist_level + 1).min(3);
        append_log(
            &log_path,
            &format!(
                "[{}] CRASH-DETECTED lastPhase={} lastStart={} failCount={} -> level={}",
                iso_time(started_at),
                previous.phase,
                iso_time(previous.last_start),
                previous.fails.saturating_add(1),
                persist_level
            ),
        );
    }

    let forced = compat_argument(&argv);
    let compat_off = argv.iter().any(|arg| arg == "--compat-off");
    let level = if compat_off { 0 } else { forced.unwrap_or(persist_level) };
    let fails = if reset {
        0
    } else if crashed_last_time {
        previous.fails.saturating_add(1)
    } else {
        previous.fails
    };
    let last_crashed_phase = if crashed_last_time {
        previous.phase.clone()
    } else {
        previous.last_crashed_phase.clone()
    };
    let state = BootState {
        level: persist_level,
        run_level: level,
        fails,
        phase: "process-boot".to_string(),
        last_start: started_at,
        last_crashed_phase: last_crashed_phase.clone(),
        last_crashed_at: if crashed_last_time { started_at } else { previous.last_crashed_at },
        note: LEVEL_NOTES[persist_level as usize].to_string(),
        extra: previous.extra,
    };
    write_state(&state_path, &state);

    let ime = detect_ime();
    let forced_note = if compat_off {
        Some("--compat-off".to_string())
    } else {
        forced.map(|value| format!("--compat={value}"))
    };
    append_log(
        &log_path,
        &format!(
            "[{}] BOOT level={}{} {}prevPhase={} ime={} runtime=tauri-2 os={}",
            iso_time(started_at),
            level,
            forced_note
                .as_ref()
                .map(|note| format!(" ({note}，不落盘)"))
                .unwrap_or_default(),
            if reset { "(--compat-reset) " } else { "" },
            if previous.phase.is_empty() { "-" } else { &previous.phase },
            if ime.is_empty() {
                "(none)".to_string()
            } else {
                ime.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>().join(";")
            },
            std::env::consts::OS
        ),
    );

    let features = if level >= 2 {
        vec!["CalculateNativeWinOcclusion".to_string()]
    } else {
        Vec::new()
    };
    let mut switches = Vec::new();
    if level >= 2 {
        switches.push("--disable-gpu-compositing".to_string());
    }
    if level >= 3 {
        switches.push("--disable-gpu".to_string());
    }

    BootGuard {
        level,
        delay_ms: LEVEL_DELAYS_MS[level as usize],
        persist_level,
        features,
        switches,
        crashed_last_time,
        last_crashed_phase,
        state_path: state_path.clone(),
        log_path: log_path.clone(),
        ime,
        inner: Arc::new(Inner {
            state: Mutex::new(state),
            state_path,
            log_path,
            started_at,
            run_level: level,
        }),
    }
}

fn compat_argument(argv: &[String]) -> Option<u8> {
    let mut found = None;
    let mut index = 0;
    while index < argv.len() {
        if let Some(value) = argv[index].strip_prefix("--compat=") {
            found = match value {
                "0" => Some(0),
                "1" => Some(1),
                "2" => Some(2),
                "3" => Some(3),
                _ => None,
            };
        } else if argv[index] == "--compat" && index + 1 < argv.len() {
            found = match argv[index + 1].as_str() {
                "0" => Some(0),
                "1" => Some(1),
                "2" => Some(2),
                "3" => Some(3),
                _ => None,
            };
            index += 1;
        }
        index += 1;
    }
    found
}

fn read_state(path: &Path) -> BootState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_state(path: &Path, state: &BootState) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, text);
    }
}

fn append_log(path: &Path, line: &str) {
    use std::io::Write;
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn detect_ime() -> Vec<PathBuf> {
    let program_x86 = std::env::var_os("ProgramFiles(x86)")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let program = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let candidates = [
        program_x86.join("SogouInput"),
        program.join("SogouInput"),
        local.join("SogouInput"),
        PathBuf::from(r"G:\SogouInput"),
        program_x86.join("Tencent").join("QQPinyin"),
        program_x86.join("Baidu").join("BaiduPinyin"),
    ];
    candidates.into_iter().filter(|path| path.exists()).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Small UTC formatter so the module does not need a time/date dependency.
fn iso_time(ms: u64) -> String {
    let seconds = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let hour = day_seconds / 3600;
    let minute = day_seconds % 3600 / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}
