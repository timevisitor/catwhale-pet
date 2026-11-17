//! Local media detection (SMTC + WASAPI), ported from the Electron media-show module.
//!
//! The two probe sources are embedded in the executable and materialized below Tauri's
//! app config directory. PowerShell is never launched from the source tree or the old
//! Electron project. No managed Tauri state is required: the commands lazily create one
//! process-wide runtime, while `media_init` can restore the persisted setting at startup.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const PROBE_PS1: &str = include_str!("media_probe.ps1");
const PROBE_CS: &str = include_str!("WasapiProbe.cs");
const DEFAULT_POLL_MS: u64 = 2_000;
const DEFAULT_START_MS: u64 = 1_200;
const DEFAULT_STOP_MS: u64 = 2_500;
const MIN_POLL_MS: u64 = 500;
const MAX_BACKOFF_MS: u64 = 60_000;
const ONCE_TIMEOUT: Duration = Duration::from_secs(15);
const PUSH_INTERVAL: Duration = Duration::from_millis(120);
const PEAK_MIN: f64 = 0.004;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaConfig {
    enabled: bool,
    poll_ms: u64,
    start_ms: u64,
    stop_ms: u64,
}

impl Default for MediaConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            poll_ms: DEFAULT_POLL_MS,
            start_ms: DEFAULT_START_MS,
            stop_ms: DEFAULT_STOP_MS,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaInfo {
    kind: String,
    app: String,
    proc: String,
    pid: Option<u32>,
    title: String,
    artist: String,
    album: String,
    pb_type: String,
    peak: f64,
    source: String,
    confidence: String,
    since: u64,
}

impl MediaInfo {
    fn from_decision(kind: &str, decision: &Decision) -> Self {
        Self {
            kind: kind.to_string(),
            app: decision.app.clone(),
            proc: decision.proc.clone(),
            pid: decision.pid,
            title: decision.title.clone(),
            artist: decision.artist.clone(),
            album: decision.album.clone(),
            pb_type: decision.pb_type.clone(),
            peak: decision.peak,
            source: decision.source.clone(),
            confidence: decision.confidence.clone(),
            since: epoch_ms(),
        }
    }

    fn update(&mut self, decision: &Decision) -> bool {
        let changed = self.app != decision.app
            || self.proc != decision.proc
            || self.title != decision.title
            || self.artist != decision.artist
            || self.album != decision.album;
        self.app = decision.app.clone();
        self.proc = decision.proc.clone();
        self.pid = decision.pid;
        self.title = decision.title.clone();
        self.artist = decision.artist.clone();
        self.album = decision.album.clone();
        self.pb_type = decision.pb_type.clone();
        self.peak = decision.peak;
        self.source = decision.source.clone();
        self.confidence = decision.confidence.clone();
        changed
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaState {
    enabled: bool,
    running: bool,
    kind: Option<String>,
    playing: bool,
    info: Option<MediaInfo>,
    samples: u64,
    errors: u64,
    restarts: u64,
    last_error: String,
    last_sample_age: Option<u64>,
    poll_ms: u64,
}

#[derive(Default)]
struct StateData {
    running: bool,
    kind: Option<String>,
    info: Option<MediaInfo>,
    samples: u64,
    errors: u64,
    restarts: u64,
    last_error: String,
    last_sample: Option<Instant>,
    last_push: Option<Instant>,
}

impl StateData {
    fn snapshot(&self, cfg: &MediaConfig) -> MediaState {
        MediaState {
            enabled: cfg.enabled,
            running: self.running,
            kind: self.kind.clone(),
            playing: self.kind.is_some(),
            info: self.info.clone(),
            samples: self.samples,
            errors: self.errors,
            restarts: self.restarts,
            last_error: self.last_error.clone(),
            last_sample_age: self.last_sample.map(|t| millis(t.elapsed())),
            poll_ms: cfg.poll_ms,
        }
    }

    fn clear_playback(&mut self) {
        self.kind = None;
        self.info = None;
    }
}

#[derive(Clone)]
struct Worker {
    generation: u64,
    pid: u32,
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
    started: Instant,
}

struct Inner {
    cfg: MediaConfig,
    state: StateData,
    smoother: Smoother,
    generation: u64,
    worker: Option<Worker>,
    starting: Option<u64>,
    restart_pending: Option<u64>,
    backoff_ms: u64,
    last_raw: Option<Value>,
    last_decision: Option<Value>,
}

struct Runtime {
    app: AppHandle,
    settings_path: PathBuf,
    probe_dir: PathBuf,
    inner: Mutex<Inner>,
    update_lock: Mutex<()>,
    spawn_lock: Mutex<()>,
}

impl Runtime {
    fn new(app: &AppHandle) -> Self {
        let config_dir = app.path().app_config_dir().unwrap_or_else(|_| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("com.hermes.catwhalepoc")
        });
        let _ = std::fs::create_dir_all(&config_dir);
        let settings_path = config_dir.join("settings.json");
        let cfg = load_config(&settings_path);
        Self {
            app: app.clone(),
            settings_path,
            probe_dir: config_dir.join("media-probe"),
            inner: Mutex::new(Inner {
                cfg,
                state: StateData::default(),
                smoother: Smoother::default(),
                generation: 0,
                worker: None,
                starting: None,
                restart_pending: None,
                backoff_ms: 1_000,
                last_raw: None,
                last_decision: None,
            }),
            update_lock: Mutex::new(()),
            spawn_lock: Mutex::new(()),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn runtime(app: &AppHandle) -> &'static Runtime {
    let mut created = false;
    let rt = RUNTIME.get_or_init(|| {
        created = true;
        Runtime::new(app)
    });
    if created {
        let generation = {
            let mut inner = lock(&rt.inner);
            inner.generation += 1;
            inner.generation
        };
        start_worker(rt, generation);
    }
    rt
}

/// Restore the saved setting. Call once from Tauri's `setup` callback.
/// With the default configuration this only reads JSON; it starts no process.
pub fn media_init(app: &AppHandle) {
    let _ = runtime(app);
}

#[tauri::command]
pub fn media_get(app: AppHandle) -> Value {
    let rt = runtime(&app);
    let inner = lock(&rt.inner);
    json!({
        "ok": true,
        "state": inner.state.snapshot(&inner.cfg),
        "cfg": inner.cfg,
    })
}

#[tauri::command]
pub fn media_set(app: AppHandle, patch: Option<Value>) -> Value {
    let rt = runtime(&app);
    let _update = lock(&rt.update_lock);
    let current = lock(&rt.inner).cfg.clone();
    let next = match merge_config(current.clone(), patch) {
        Ok(cfg) => cfg,
        Err(error) => {
            let inner = lock(&rt.inner);
            return json!({
                "ok": false,
                "error": error,
                "state": inner.state.snapshot(&inner.cfg),
                "cfg": inner.cfg,
            });
        }
    };

    if let Err(error) = save_config(&rt.settings_path, &next) {
        let mut inner = lock(&rt.inner);
        inner.state.errors += 1;
        inner.state.last_error = format!("保存媒体配置失败：{error}");
        let state = inner.state.snapshot(&inner.cfg);
        drop(inner);
        push_state(rt, true);
        return json!({ "ok": false, "error": error, "state": state, "cfg": current });
    }

    let (_old_cfg, worker, generation, should_start) = {
        let mut inner = lock(&rt.inner);
        let old_cfg = std::mem::replace(&mut inner.cfg, next.clone());
        let lifecycle_changed = old_cfg.enabled != next.enabled
            || (next.enabled && old_cfg != next);
        let needs_start = next.enabled
            && (lifecycle_changed
                || (inner.worker.is_none()
                    && inner.starting.is_none()
                    && inner.restart_pending.is_none()));
        let worker = if lifecycle_changed {
            inner.generation += 1;
            inner.restart_pending = None;
            inner.backoff_ms = 1_000;
            inner.smoother.reset();
            inner.state.clear_playback();
            inner.state.last_sample = None;
            inner.state.last_error.clear();
            inner.worker.take()
        } else {
            None
        };
        if !next.enabled {
            inner.state.running = false;
        }
        let generation = inner.generation;
        (old_cfg, worker, generation, needs_start)
    };

    if let Some(worker) = worker {
        stop_worker(worker);
    }
    if should_start {
        start_worker(rt, generation);
    } else if !next.enabled {
        // A restart thread may have been inside spawn when the generation changed.
        // Wait for that stale spawn to be rejected and reaped before reporting stopped.
        let _spawn = lock(&rt.spawn_lock);
    }
    push_state(rt, true);

    let inner = lock(&rt.inner);
    json!({
        "ok": true,
        "state": inner.state.snapshot(&inner.cfg),
        "cfg": inner.cfg,
    })
}

#[tauri::command]
pub fn media_diag(app: AppHandle) -> Value {
    let rt = runtime(&app);
    let inner = lock(&rt.inner);
    let script = rt.probe_dir.join("media_probe.ps1");
    let cs_path = rt.probe_dir.join("WasapiProbe.cs");
    json!({
        "ok": true,
        "state": inner.state.snapshot(&inner.cfg),
        "cfg": inner.cfg,
        "script": script,
        "exists": script.is_file(),
        "cs": cs_path.is_file(),
        "csPath": cs_path,
        "probeDir": rt.probe_dir,
        "settings": rt.settings_path,
        "powershell": powershell_exe(),
        "selfPid": std::process::id(),
        "probePid": inner.worker.as_ref().map(|w| w.pid),
        "backoffMs": inner.backoff_ms,
        "restartPending": inner.restart_pending.is_some(),
        "lastRaw": inner.last_raw,
        "lastDecision": inner.last_decision,
    })
}

/// One isolated sample. It never reuses or stops the continuous probe.
#[tauri::command]
pub async fn media_probe_once(app: AppHandle) -> Value {
    let rt = runtime(&app);
    match tauri::async_runtime::spawn_blocking(move || probe_once_blocking(rt)).await {
        Ok(value) => value,
        Err(error) => json!({ "ok": false, "error": format!("一次性探测任务失败：{error}") }),
    }
}

/// Stop the current process tree and cancel pending/automatic restarts.
/// The persisted enabled flag is deliberately retained (same semantics as Electron stopAll).
pub fn media_stop() {
    let Some(rt) = RUNTIME.get() else { return };
    // If a spawn is in flight, wait for it and then kill that exact child before
    // returning. This closes the shutdown race where a process could appear after stop.
    let _spawn = lock(&rt.spawn_lock);
    let worker = {
        let mut inner = lock(&rt.inner);
        inner.generation += 1;
        inner.restart_pending = None;
        inner.backoff_ms = 1_000;
        inner.smoother.reset();
        inner.state.running = false;
        inner.state.clear_playback();
        inner.state.last_sample = None;
        inner.worker.take()
    };
    if let Some(worker) = worker {
        stop_worker(worker);
    }
    push_state(rt, true);
}

fn merge_config(mut cfg: MediaConfig, patch: Option<Value>) -> Result<MediaConfig, String> {
    let Some(patch) = patch else { return Ok(cfg) };
    let Some(object) = patch.as_object() else {
        return Err("媒体配置必须是对象".into());
    };
    let show = object
        .get("show")
        .and_then(Value::as_object)
        .unwrap_or(object);
    if let Some(value) = show.get("enabled") {
        cfg.enabled = value
            .as_bool()
            .ok_or_else(|| "enabled 必须是布尔值".to_string())?;
    }
    for (key, target) in [
        ("pollMs", &mut cfg.poll_ms),
        ("startMs", &mut cfg.start_ms),
        ("stopMs", &mut cfg.stop_ms),
    ] {
        if let Some(value) = show.get(key) {
            *target = positive_ms(value, key)?;
        }
    }
    if cfg.poll_ms < MIN_POLL_MS {
        return Err("采样间隔不能小于 500ms".into());
    }
    Ok(cfg)
}

fn positive_ms(value: &Value, key: &str) -> Result<u64, String> {
    let number = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<u64>().ok()));
    match number {
        Some(n) if n > 0 => Ok(n),
        _ => Err(format!("参数必须是正整数：{key}")),
    }
}

fn load_config(path: &Path) -> MediaConfig {
    let mut cfg = MediaConfig::default();
    let Ok(text) = std::fs::read_to_string(path) else { return cfg };
    let Ok(root) = serde_json::from_str::<Value>(&text) else { return cfg };
    let Some(show) = root
        .get("media")
        .and_then(Value::as_object)
        .and_then(|m| m.get("show"))
        .and_then(Value::as_object)
    else {
        return cfg;
    };
    cfg.enabled = show.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    for (key, target, default) in [
        ("pollMs", &mut cfg.poll_ms, DEFAULT_POLL_MS),
        ("startMs", &mut cfg.start_ms, DEFAULT_START_MS),
        ("stopMs", &mut cfg.stop_ms, DEFAULT_STOP_MS),
    ] {
        *target = show
            .get(key)
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
            .unwrap_or(default);
    }
    if cfg.poll_ms < MIN_POLL_MS {
        cfg.poll_ms = DEFAULT_POLL_MS;
    }
    cfg
}

fn save_config(path: &Path, cfg: &MediaConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut root = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if !root.get("media").is_some_and(Value::is_object) {
        root["media"] = json!({});
    }
    root["media"]["show"] = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    let data = format!("{}\n", serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    // Windows' std::fs::rename does not replace an existing destination.
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn ensure_probe_files(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建探针目录失败：{e}"))?;
    write_if_changed(&dir.join("media_probe.ps1"), PROBE_PS1.as_bytes())?;
    write_if_changed(&dir.join("WasapiProbe.cs"), PROBE_CS.as_bytes())?;
    Ok(dir.join("media_probe.ps1"))
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if std::fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("替换 {} 失败：{e}", path.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败：{e}", path.display()))
}

fn powershell_exe() -> PathBuf {
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if system.is_file() {
        system
    } else {
        PathBuf::from("powershell.exe")
    }
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn spawn_probe(script: &Path, cwd: &Path, poll_ms: u64, once: bool) -> std::io::Result<Child> {
    let mut command = Command::new(powershell_exe());
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"])
        .arg("-File")
        .arg(script)
        .current_dir(cwd)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if once {
        command.arg("-Once");
    } else {
        command.arg("-IntervalMs").arg(poll_ms.to_string());
    }
    hidden(&mut command).spawn()
}

fn start_worker(rt: &'static Runtime, generation: u64) {
    let _spawn = lock(&rt.spawn_lock);
    {
        let mut inner = lock(&rt.inner);
        if inner.generation != generation
            || !inner.cfg.enabled
            || inner.worker.is_some()
            || inner.starting.is_some()
        {
            return;
        }
        inner.starting = Some(generation);
    }

    let poll_ms = lock(&rt.inner).cfg.poll_ms;
    let spawned = ensure_probe_files(&rt.probe_dir)
        .map_err(std::io::Error::other)
        .and_then(|script| spawn_probe(&script, &rt.probe_dir, poll_ms, false));

    match spawned {
        Ok(mut child) => {
            let pid = child.id();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let has_stdout = stdout.is_some();
            let worker = Worker {
                generation,
                pid,
                stop: Arc::new(AtomicBool::new(false)),
                child: Arc::new(Mutex::new(child)),
                started: Instant::now(),
            };
            let accepted = {
                let mut inner = lock(&rt.inner);
                inner.starting = None;
                if inner.generation == generation
                    && inner.cfg.enabled
                    && inner.worker.is_none()
                {
                    inner.state.running = true;
                    inner.worker = Some(worker.clone());
                    true
                } else {
                    false
                }
            };
            if !accepted {
                stop_worker(worker);
                return;
            }
            push_state(rt, true);
            if let Some(stdout) = stdout {
                let reader = worker.clone();
                thread::spawn(move || run_probe_stdout(rt, reader, stdout));
            }
            if let Some(stderr) = stderr {
                let reader = worker.clone();
                thread::spawn(move || run_probe_stderr(rt, reader, stderr));
            }
            if !has_stdout {
                // A piped child should always have stdout; do not leave a worker with
                // no reader permanently marked as running if that invariant is broken.
                let generation = worker.generation;
                {
                    let mut inner = lock(&rt.inner);
                    inner.worker = None;
                    inner.state.running = false;
                    inner.state.errors += 1;
                    inner.state.last_error = "PowerShell 未提供 stdout 管道".into();
                }
                stop_worker(worker);
                push_state(rt, true);
                schedule_restart(rt, generation);
            }
        }
        Err(error) => {
            let retry = {
                let mut inner = lock(&rt.inner);
                if inner.starting == Some(generation) {
                    inner.starting = None;
                }
                if inner.generation == generation && inner.cfg.enabled {
                    inner.state.running = false;
                    inner.state.errors += 1;
                    inner.state.last_error = format!("启动 PowerShell 失败：{error}");
                    true
                } else {
                    false
                }
            };
            push_state(rt, true);
            if retry {
                schedule_restart(rt, generation);
            }
        }
    }
}

fn run_probe_stdout(rt: &'static Runtime, worker: Worker, stdout: impl Read) {
    let mut reader = BufReader::new(stdout);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => break,
            Ok(_) => {
                if bytes.len() > 1 << 20 {
                    record_worker_error(rt, &worker, "丢弃超过 1 MiB 的探针输出", true);
                    continue;
                }
                if worker.stop.load(Ordering::Acquire) {
                    break;
                }
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim();
                if line.is_empty() || !line.starts_with('{') {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(sample) if sample.is_object() => ingest(rt, worker.generation, sample),
                    Ok(_) => {}
                    Err(error) => record_worker_error(
                        rt,
                        &worker,
                        &format!("探针 JSON 解析失败：{error}"),
                        true,
                    ),
                }
            }
            Err(error) => {
                if !worker.stop.load(Ordering::Acquire) {
                    record_worker_error(
                        rt,
                        &worker,
                        &format!("读取探针输出失败：{error}"),
                        true,
                    );
                }
                break;
            }
        }
    }

    let status = wait_for_worker(&worker);
    let retry = {
        let mut inner = lock(&rt.inner);
        if inner.generation != worker.generation {
            false
        } else {
            if inner.worker.as_ref().is_some_and(|w| {
                w.generation == worker.generation && w.pid == worker.pid
            }) {
                inner.worker = None;
            }
            inner.state.running = false;
            inner.smoother.reset();
            inner.state.clear_playback();
            if inner.cfg.enabled && !worker.stop.load(Ordering::Acquire) {
                inner.state.errors += 1;
                inner.state.last_error = match status {
                    Some(status) => format!("媒体探针意外退出：{status}"),
                    None => "媒体探针退出，且无法读取退出状态".into(),
                };
                if worker.started.elapsed() >= Duration::from_secs(60) {
                    inner.backoff_ms = 1_000;
                }
                true
            } else {
                false
            }
        }
    };
    push_state(rt, true);
    if retry {
        schedule_restart(rt, worker.generation);
    }
}

fn wait_for_worker(worker: &Worker) -> Option<std::process::ExitStatus> {
    loop {
        let result = lock(&worker.child).try_wait();
        match result {
            Ok(Some(status)) => return Some(status),
            Ok(None) if worker.stop.load(Ordering::Acquire) => return None,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

fn run_probe_stderr(rt: &'static Runtime, worker: Worker, stderr: impl Read) {
    let mut reader = BufReader::new(stderr);
    let mut text = String::new();
    loop {
        text.clear();
        match reader.read_line(&mut text) {
            Ok(0) => break,
            Ok(_) => {
                let message = text.trim();
                if !message.is_empty() && !worker.stop.load(Ordering::Acquire) {
                    let mut inner = lock(&rt.inner);
                    if inner.generation == worker.generation {
                        inner.state.last_error = clip(message, 300);
                        drop(inner);
                        push_state(rt, false);
                    }
                }
            }
            Err(_) => break,
        }
    }
}

fn record_worker_error(rt: &Runtime, worker: &Worker, message: &str, count: bool) {
    let mut inner = lock(&rt.inner);
    if inner.generation != worker.generation {
        return;
    }
    if count {
        inner.state.errors += 1;
    }
    inner.state.last_error = clip(message, 300);
    drop(inner);
    push_state(rt, false);
}

fn schedule_restart(rt: &'static Runtime, generation: u64) {
    let delay = {
        let mut inner = lock(&rt.inner);
        if inner.generation != generation
            || !inner.cfg.enabled
            || inner.worker.is_some()
            || inner.restart_pending.is_some()
        {
            return;
        }
        let delay = inner.backoff_ms.min(MAX_BACKOFF_MS);
        inner.backoff_ms = delay.saturating_mul(2).min(MAX_BACKOFF_MS);
        inner.state.restarts += 1;
        inner.restart_pending = Some(generation);
        delay
    };
    push_state(rt, true);
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(delay);
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            thread::sleep((deadline - now).min(Duration::from_millis(100)));
            let inner = lock(&rt.inner);
            if inner.generation != generation || !inner.cfg.enabled {
                return;
            }
        }
        let start = {
            let mut inner = lock(&rt.inner);
            if inner.generation != generation || !inner.cfg.enabled {
                false
            } else {
                inner.restart_pending = None;
                true
            }
        };
        if start {
            start_worker(rt, generation);
        }
    });
}

fn stop_worker(worker: Worker) {
    worker.stop.store(true, Ordering::Release);
    let mut child = lock(&worker.child);
    kill_process_tree(&mut child);
}

fn kill_process_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.wait();
        return;
    }
    #[cfg(windows)]
    {
        let taskkill = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("taskkill.exe");
        let mut command = Command::new(if taskkill.is_file() {
            taskkill
        } else {
            PathBuf::from("taskkill.exe")
        });
        command
            .arg("/PID")
            .arg(child.id().to_string())
            .args(["/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = hidden(&mut command).status();
    }
    // taskkill may be unavailable or denied. Terminate the direct PowerShell and reap
    // it in every case; /T above handles compiler/helper descendants on normal Windows.
    let _ = child.kill();
    let _ = child.wait();
}

fn push_state(rt: &Runtime, force: bool) {
    let snapshot = {
        let mut inner = lock(&rt.inner);
        let now = Instant::now();
        if !force
            && inner
                .state
                .last_push
                .is_some_and(|last| now.duration_since(last) < PUSH_INTERVAL)
        {
            return;
        }
        inner.state.last_push = Some(now);
        inner.state.snapshot(&inner.cfg)
    };
    let _ = rt.app.emit("media:state", snapshot);
}

fn ingest(rt: &Runtime, generation: u64, sample: Value) {
    let decision = decide(&sample);
    let now = Instant::now();
    let (start_ms, stop_ms) = {
        let inner = lock(&rt.inner);
        if inner.generation != generation {
            return;
        }
        (inner.cfg.start_ms, inner.cfg.stop_ms)
    };
    let decision_value = serde_json::to_value(&decision).unwrap_or(Value::Null);
    let mut inner = lock(&rt.inner);
    if inner.generation != generation {
        return;
    }
    inner.state.samples += 1;
    inner.state.last_sample = Some(now);
    inner.last_raw = Some(sample);
    inner.last_decision = Some(decision_value);
    let result = inner
        .smoother
        .push(&decision, now, start_ms, stop_ms);
    if result.changed {
        inner.state.kind = result.kind.clone();
        inner.state.info = result
            .kind
            .as_deref()
            .map(|kind| MediaInfo::from_decision(kind, &decision));
        drop(inner);
        push_state(rt, true);
        return;
    }
    if let (Some(kind), Some(info)) = (result.kind.as_deref(), inner.state.info.as_mut()) {
        if decision.playing && decision.kind == kind {
            if info.update(&decision) {
                drop(inner);
                push_state(rt, true);
                return;
            }
        }
    }
    drop(inner);
    push_state(rt, false);
}

fn probe_once_blocking(rt: &'static Runtime) -> Value {
    let script = match ensure_probe_files(&rt.probe_dir) {
        Ok(script) => script,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let mut child = match spawn_probe(&script, &rt.probe_dir, DEFAULT_POLL_MS, true) {
        Ok(child) => child,
        Err(error) => {
            return json!({ "ok": false, "error": format!("启动 PowerShell 失败：{error}") })
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_string(&mut text);
        }
        text
    });
    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });

    let deadline = Instant::now() + ONCE_TIMEOUT;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                timed_out = true;
                kill_process_tree(&mut child);
                break Err("一次性媒体探测超过 15000ms，已终止进程树".to_string());
            }
            Err(error) => {
                kill_process_tree(&mut child);
                break Err(format!("等待一次性媒体探测失败：{error}"));
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if timed_out {
        return json!({ "ok": false, "error": status.err().unwrap_or_default() });
    }
    if let Err(error) = status {
        return json!({ "ok": false, "error": error });
    }
    let line = stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .last();
    let Some(line) = line else {
        return json!({
            "ok": false,
            "error": format!("无 JSON 输出：{}", clip(stderr.trim(), 300)),
        });
    };
    match serde_json::from_str::<Value>(line) {
        Ok(raw) if raw.is_object() => {
            let decision = decide(&raw);
            json!({ "ok": true, "raw": raw, "decision": decision })
        }
        Ok(_) => json!({ "ok": false, "error": "探针输出不是 JSON 对象" }),
        Err(error) => json!({
            "ok": false,
            "error": format!("解析探针输出失败：{error}"),
            "stderr": clip(stderr.trim(), 300),
        }),
    }
}

#[derive(Default)]
struct Smoother {
    current: Option<String>,
    candidate: Option<(String, Instant)>,
    last_loud: Option<Instant>,
}

struct SmoothResult {
    kind: Option<String>,
    changed: bool,
}

impl Smoother {
    fn reset(&mut self) {
        self.current = None;
        self.candidate = None;
        self.last_loud = None;
    }

    fn push(&mut self, decision: &Decision, now: Instant, start_ms: u64, stop_ms: u64) -> SmoothResult {
        let kind = if decision.playing && decision.kind != "unknown" {
            Some(decision.kind.as_str())
        } else {
            None
        };
        if kind.is_some() {
            self.last_loud = Some(now);
        }
        let Some(kind) = kind else {
            if let Some(current) = &self.current {
                let stopped = self.last_loud.is_some_and(|last| {
                    now.saturating_duration_since(last) >= Duration::from_millis(stop_ms)
                });
                if stopped {
                    self.current = None;
                    self.candidate = None;
                    return SmoothResult { kind: None, changed: true };
                }
                return SmoothResult {
                    kind: Some(current.clone()),
                    changed: false,
                };
            }
            self.candidate = None;
            return SmoothResult { kind: None, changed: false };
        };

        if self.current.as_deref() == Some(kind) {
            self.candidate = None;
            return SmoothResult {
                kind: Some(kind.to_string()),
                changed: false,
            };
        }
        if self.candidate.as_ref().map(|(k, _)| k.as_str()) != Some(kind) {
            self.candidate = Some((kind.to_string(), now));
        }
        let required = if self.current.is_some() {
            start_ms.min(600)
        } else {
            start_ms
        };
        let elapsed = self
            .candidate
            .as_ref()
            .map(|(_, since)| now.saturating_duration_since(*since))
            .unwrap_or_default();
        if elapsed >= Duration::from_millis(required) {
            self.current = Some(kind.to_string());
            self.candidate = None;
            return SmoothResult {
                kind: Some(kind.to_string()),
                changed: true,
            };
        }
        SmoothResult {
            kind: self.current.clone(),
            changed: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    playing: bool,
    /// `video`, `music`, or `unknown`. The public state maps unknown to kind=null.
    kind: String,
    source: String,
    app: String,
    proc: String,
    pid: Option<u32>,
    title: String,
    artist: String,
    album: String,
    pb_type: String,
    peak: f64,
    confidence: String,
}

impl Decision {
    fn silent() -> Self {
        Self {
            playing: false,
            kind: "unknown".into(),
            source: String::new(),
            app: String::new(),
            proc: String::new(),
            pid: None,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            pb_type: String::new(),
            peak: 0.0,
            confidence: "none".into(),
        }
    }
}

#[derive(Clone, Default)]
struct Session {
    app: String,
    status: String,
    title: String,
    artist: String,
    album: String,
    pb_type: String,
    genres: Vec<String>,
    win: String,
}

impl Session {
    fn from_value(value: &Value) -> Self {
        let pb_props = string(value, "pbTypeProps");
        let pb_type = if pb_props.is_empty() {
            string(value, "pbType")
        } else {
            pb_props
        };
        Self {
            app: string(value, "app"),
            status: string(value, "status"),
            title: string(value, "title"),
            artist: string(value, "artist"),
            album: string(value, "album"),
            pb_type,
            genres: value
                .get("genres")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(value_string).collect())
                .unwrap_or_default(),
            win: {
                let win = string(value, "win");
                if win.is_empty() {
                    string(value, "windowTitle")
                } else {
                    win
                }
            },
        }
    }
}

#[derive(Clone)]
struct AudioSession {
    proc_name: String,
    pid: u32,
    peak: f64,
    active: bool,
    win: String,
}

const VIDEO_APPS: &[&str] = &[
    "potplayer", "vlc", "mpv", "mpc-hc", "mpc-be", "kmplayer", "gomplayer", "iqiyi",
    "qiyi", "qyclient", "qyclientd", "tencentvideo", "qqlive", "youku", "mgtv", "sohu",
    "pptv", "netflix", "disney", "primevideo", "hbomax", "爱奇艺", "腾讯视频", "优酷",
    "芒果", "搜狐视频", "wmplayer", "windows media player", "movies & tv", "films & tv",
    "zune", "media player", "foobar2000_video",
];
const VIDEO_APP_STRONG: &[&str] = &[
    "potplayer", "vlc", "mpv", "mpc-hc", "mpc-be", "iqiyi", "qiyi", "qyclient",
    "tencentvideo", "qqlive", "youku", "mgtv", "netflix", "wmplayer", "kmplayer", "gomplayer",
];
const MUSIC_APPS: &[&str] = &[
    "cloudmusic", "netease", "网易云", "music.163", "qqmusic", "qq音乐", "tencentmusic",
    "qqtvmusic", "kugou", "酷狗", "kuwo", "酷我", "migu", "咪咕", "spotify", "applemusic",
    "apple music", "itunes", "amazonmusic", "tidal", "deezer", "soundcloud", "musicbee",
    "aimp", "foobar2000", "winamp", "youtube music", "music.youtube",
];
const BROWSER_APPS: &[&str] = &[
    "chrome", "msedge", "edge", "firefox", "brave", "opera", "vivaldi", "safari", "360se",
    "360chrome", "qqbrowser", "quark",
];
const MUSIC_HOSTS: &[&str] = &[
    "music.163", "y.qq", "music.youtube", "spotify", "kugou", "kuwo", "migu", "xiami",
    "bandcamp", "soundcloud", "deezer", "tidal", "网易云音乐", "qq音乐", "酷狗音乐",
    "酷我音乐", "咪咕音乐", "youtube music", "apple music", "汽水音乐", "千千音乐",
];
const VIDEO_HOSTS: &[&str] = &[
    "bilibili", "youtube", "youku", "iqiyi", "v.qq.com", "mgtv", "netflix", "twitch",
    "dailymotion", "douyin", "ixigua", "哔哩哔哩", "腾讯视频", "爱奇艺", "优酷", "芒果tv",
    "西瓜视频", "抖音", "快手", "acfun", "a站",
];
const VIDEO_TITLE_HINTS: &[&str] = &[
    " - 第", "集", "电视剧", "电影", "正片", "花絮", "预告", "episode", "ep.", "movie",
    "trailer", "直播", "番剧", "动漫",
];
const MUSIC_EXTENSIONS: &[&str] = &[
    ".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".wma", ".ape", ".dsf",
    ".dff",
];
const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m2ts", ".rmvb",
    ".m4v",
];

fn decide(sample: &Value) -> Decision {
    let smtc = sample
        .get("smtc")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(Session::from_value).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut audio = sample
        .get("wasapi")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(pick_audio)
                .collect::<Vec<AudioSession>>()
        })
        .unwrap_or_default();
    audio.sort_by(|a, b| b.peak.total_cmp(&a.peak));
    let loud = audio.iter().filter(|w| w.active).collect::<Vec<_>>();
    if loud.is_empty() {
        return Decision::silent();
    }

    for session in smtc.iter().filter(|s| norm(&s.status) == "playing") {
        if let Some(wasapi) = loud.iter().find(|w| session_matches(session, w)) {
            let mut merged = session.clone();
            merged.win = wasapi.win.clone();
            let kind = classify_session(&merged);
            if kind != "unknown" {
                return Decision {
                    playing: true,
                    kind: kind.into(),
                    source: "smtc".into(),
                    app: if session.app.is_empty() {
                        wasapi.proc_name.clone()
                    } else {
                        session.app.clone()
                    },
                    proc: wasapi.proc_name.clone(),
                    pid: Some(wasapi.pid),
                    title: session.title.clone(),
                    artist: session.artist.clone(),
                    album: session.album.clone(),
                    pb_type: session.pb_type.clone(),
                    peak: wasapi.peak,
                    confidence: "high".into(),
                };
            }
        }
    }

    for wasapi in &loud {
        let session = Session {
            app: wasapi.proc_name.clone(),
            win: wasapi.win.clone(),
            ..Session::default()
        };
        let kind = classify_session(&session);
        if kind == "unknown" {
            continue;
        }
        let loose = smtc.iter().find(|s| session_matches(s, wasapi));
        return Decision {
            playing: true,
            kind: kind.into(),
            source: "wasapi".into(),
            app: wasapi.proc_name.clone(),
            proc: wasapi.proc_name.clone(),
            pid: Some(wasapi.pid),
            title: loose.map(|s| s.title.clone()).unwrap_or_default(),
            artist: loose.map(|s| s.artist.clone()).unwrap_or_default(),
            album: loose.map(|s| s.album.clone()).unwrap_or_default(),
            pb_type: loose.map(|s| s.pb_type.clone()).unwrap_or_default(),
            peak: wasapi.peak,
            confidence: "medium".into(),
        };
    }

    let loudest = loud[0];
    Decision {
        playing: true,
        kind: "unknown".into(),
        source: "wasapi".into(),
        app: loudest.proc_name.clone(),
        proc: loudest.proc_name.clone(),
        pid: Some(loudest.pid),
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        pb_type: String::new(),
        peak: loudest.peak,
        confidence: "low".into(),
    }
}

fn pick_audio(value: &Value) -> Option<AudioSession> {
    let proc_name = string(value, "proc");
    if proc_name.is_empty() {
        return None;
    }
    let proc_norm = norm(&proc_name);
    let pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
    if pid == std::process::id()
        || ["electron", "桌宠", "catwhale-pet", "catwhale-poc"].contains(&proc_norm.as_str())
    {
        return None;
    }
    let peak = number(value, "peak");
    let state = string(value, "state");
    if state != "Active" && peak < PEAK_MIN {
        return None;
    }
    Some(AudioSession {
        proc_name,
        pid,
        peak,
        active: peak >= PEAK_MIN,
        win: string(value, "win"),
    })
}

fn classify_session(session: &Session) -> &'static str {
    let app = norm(&session.app);
    let title = norm(&session.title);
    let artist = session.artist.trim();
    let pb_type = norm(&session.pb_type);
    let genres = session.genres.iter().map(|g| norm(g)).collect::<Vec<_>>();

    if ends_with_any(&title, VIDEO_EXTENSIONS) {
        return "video";
    }
    if ends_with_any(&title, MUSIC_EXTENSIONS) {
        return "music";
    }
    if hit_any(&app, VIDEO_APP_STRONG) {
        return "video";
    }
    if hit_any(&app, MUSIC_APPS) {
        return "music";
    }
    if hit_any(&app, BROWSER_APPS) {
        let site = format!("{} {}", norm(&session.win), title);
        if music_zone(&site) || hit_any(&site, MUSIC_HOSTS) {
            return "music";
        }
        if hit_any(&site, VIDEO_HOSTS) {
            return "video";
        }
        if !artist.is_empty() {
            return "music";
        }
        if hit_any(&title, VIDEO_TITLE_HINTS) {
            return "video";
        }
        if pb_type == "video"
            || genres
                .iter()
                .any(|g| g.contains("video") || g.contains("movie"))
        {
            return "video";
        }
        return "video";
    }
    if hit_any(&app, VIDEO_APPS) {
        return "video";
    }
    if !artist.is_empty() || pb_type == "music" {
        return "music";
    }
    if pb_type == "video" {
        return "video";
    }
    if !genres.is_empty() {
        if genres
            .iter()
            .any(|g| g.contains("video") || g.contains("movie"))
        {
            return "video";
        }
        return "music";
    }
    "unknown"
}

fn app_key(app: &str) -> String {
    let normalized = norm(app);
    let mut base = normalized
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&normalized)
        .to_string();
    if base.ends_with(".exe") {
        base.truncate(base.len() - 4);
    }
    if let Some(dot) = base.find('.') {
        if dot >= 3 {
            base.truncate(dot);
        }
    }
    base
}

fn session_matches(session: &Session, audio: &AudioSession) -> bool {
    let app = app_key(&session.app);
    let proc = norm(&audio.proc_name);
    !app.is_empty() && !proc.is_empty() && (app == proc || app.contains(&proc) || proc.contains(&app))
}

fn music_zone(text: &str) -> bool {
    if ["bilibili.com/audio", "音频区", "音乐区", "radio"]
        .iter()
        .any(|s| text.contains(s))
    {
        return true;
    }
    let mut rest = text;
    while let Some(index) = rest.find("/music") {
        let after = &rest[index + 6..];
        if after.chars().next().map_or(true, |c| !c.is_ascii_alphanumeric() && c != '_') {
            return true;
        }
        rest = after;
    }
    false
}

fn ends_with_any(text: &str, suffixes: &[&str]) -> bool {
    suffixes.iter().any(|suffix| text.ends_with(suffix))
}

fn hit_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn norm(text: &str) -> String {
    text.to_lowercase()
}

fn string(value: &Value, key: &str) -> String {
    value.get(key).map(value_string).unwrap_or_default()
}

fn value_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn number(value: &Value, key: &str) -> f64 {
    value
        .get(key)
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn millis(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn epoch_ms() -> u64 {
    millis(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default())
}
