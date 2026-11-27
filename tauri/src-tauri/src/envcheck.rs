//! Environment checks and on-demand deployment for Everything / DeepSeek Harness.
//!
//! This module deliberately performs only bounded filesystem probes.  Long running
//! work is executed with `spawn_blocking`; progress is emitted as `env:log` and each
//! deployment has an independent cancellation flag.

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const HARNESS_REPO_URL: &str = "https://github.com/deepseek-ai/deepseek-harness";
const NPM_MIRROR: &str = "https://registry.npmmirror.com";
const EVERYTHING_PAGE: &str = "https://www.voidtools.com/zh-cn/downloads/";
const EVERYTHING_FALLBACK_ZIP: &str = "https://www.voidtools.com/Everything-1.5.0.1423b.x64.zip";
const MAX_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_EXTRACT_BYTES: u64 = 512 * 1024 * 1024;

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn failure(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

fn cancelled(message: &str) -> Value {
    json!({ "ok": false, "cancelled": true, "code": "CANCELLED", "error": message })
}

/// 配置根目录：统一走 `chat::config_dir()`，它认同 `CATWHALE_CONFIG_DIR`。
/// 直接用 `app.path().app_config_dir()` 会绕过隔离变量，隔离测试就会写进用户真实目录。
fn app_root(_app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::chat::config_dir())
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_root(app)?.join("settings.json"))
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_root(app)?.join("pet-state.json"))
}

fn read_object(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn atomic_json_write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "配置路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    let result = (|| {
        let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        text.push('\n');
        let mut file = File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn update_object(path: &Path, update: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let mut root = read_object(path);
    update(&mut root);
    atomic_json_write(path, &Value::Object(root))
}

fn emit_env(app: &AppHandle, id: &str, kind: &str, mut payload: Map<String, Value>) {
    payload.insert("id".into(), json!(id));
    payload.insert("kind".into(), json!(kind));
    payload.insert("at".into(), json!(now_ms() as u64));
    let _ = app.emit("env:log", Value::Object(payload));
}

fn env_log(app: &AppHandle, id: &str, line: impl AsRef<str>) {
    let line = line.as_ref().trim_end();
    if line.is_empty() {
        return;
    }
    let clipped: String = line.chars().take(500).collect();
    emit_env(app, id, "log", Map::from_iter([(String::from("line"), json!(clipped))]));
}

fn env_phase(app: &AppHandle, id: &str, phase: &str, text: &str) {
    emit_env(
        app,
        id,
        "phase",
        Map::from_iter([
            (String::from("phase"), json!(phase)),
            (String::from("text"), json!(text)),
        ]),
    );
}

fn env_progress(app: &AppHandle, id: &str, phase: &str, got: u64, total: u64) {
    let pct = if total == 0 { 0 } else { ((got.saturating_mul(100)) / total).min(100) };
    emit_env(
        app,
        id,
        "progress",
        Map::from_iter([
            (String::from("phase"), json!(phase)),
            (String::from("got"), json!(got)),
            (String::from("total"), json!(total)),
            (String::from("pct"), json!(pct)),
        ]),
    );
}

#[derive(Clone)]
struct JobControl {
    cancelled: Arc<AtomicBool>,
    pid: Arc<Mutex<Option<u32>>>,
}

struct JobGuard {
    id: String,
    control: JobControl,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(mut jobs) = jobs().lock().ok() {
            jobs.remove(&self.id);
        }
    }
}

fn jobs() -> &'static Mutex<HashMap<String, JobControl>> {
    static JOBS: OnceLock<Mutex<HashMap<String, JobControl>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_job(id: &str) -> Result<JobGuard, Value> {
    let mut all = jobs().lock().map_err(|_| failure("任务状态锁已损坏"))?;
    if all.contains_key(id) {
        return Err(failure("已有部署任务在进行"));
    }
    let control = JobControl {
        cancelled: Arc::new(AtomicBool::new(false)),
        pid: Arc::new(Mutex::new(None)),
    };
    all.insert(id.to_string(), control.clone());
    Ok(JobGuard { id: id.to_string(), control })
}

fn set_job_pid(control: &JobControl, pid: Option<u32>) {
    if let Ok(mut slot) = control.pid.lock() {
        *slot = pid;
    }
}

fn is_cancelled(control: &JobControl) -> bool {
    control.cancelled.load(Ordering::SeqCst)
}

fn check_cancelled(control: &JobControl) -> Result<(), String> {
    if is_cancelled(control) {
        Err("CANCELLED".into())
    } else {
        Ok(())
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
    }
}

#[tauri::command]
pub fn env_cancel(id: String) -> Value {
    let control = jobs().lock().ok().and_then(|jobs| jobs.get(&id).cloned());
    let Some(control) = control else {
        return failure("没有正在进行的任务");
    };
    control.cancelled.store(true, Ordering::SeqCst);
    let pid = control.pid.lock().ok().and_then(|p| *p);
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    json!({ "ok": true })
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn executable_command(exe: &Path, args: &[String]) -> Command {
    let shell = exe
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut command = if shell && cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.arg("/D").arg("/S").arg("/C").arg(exe).args(args);
        c
    } else {
        let mut c = Command::new(exe);
        c.args(args);
        c
    };
    hide_console(&mut command);
    command
}

struct Capture {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

fn run_capture(mut command: Command, timeout: Duration) -> Result<Capture, String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or_else(|| "无法读取 stdout".to_string())?;
    let mut stderr = child.stderr.take().ok_or_else(|| "无法读取 stderr".to_string())?;
    let out_thread = thread::spawn(move || {
        let mut data = Vec::new();
        let _ = stdout.read_to_end(&mut data);
        data
    });
    let err_thread = thread::spawn(move || {
        let mut data = Vec::new();
        let _ = stderr.read_to_end(&mut data);
        data
    });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            kill_process_tree(child.id());
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(30));
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok(Capture { code: status.and_then(|s| s.code()), stdout, stderr, timed_out })
}

fn exe_candidates(name: &str) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    #[cfg(windows)]
    let extensions = ["cmd", "exe", "bat"];
    #[cfg(not(windows))]
    let extensions = [""];
    for ext in extensions {
        for dir in &dirs {
            let file = if ext.is_empty() { name.to_string() } else { format!("{name}.{ext}") };
            let candidate = dir.join(file);
            let key = candidate.to_string_lossy().to_lowercase();
            if seen.insert(key) && candidate.is_file() {
                result.push(candidate);
            }
        }
    }
    result
}

#[derive(Clone, Serialize, Deserialize)]
struct ToolStatus {
    ok: bool,
    version: String,
    path: String,
}

fn first_output_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn tool_version(name: &str) -> ToolStatus {
    for exe in exe_candidates(name) {
        let args = vec![String::from("--version")];
        if let Ok(output) = run_capture(executable_command(&exe, &args), Duration::from_secs(8)) {
            if output.code == Some(0) && !output.timed_out {
                let mut version = first_output_line(&output.stdout);
                if version.is_empty() {
                    version = first_output_line(&output.stderr);
                }
                let version = version.strip_prefix("git version ").unwrap_or(&version);
                let version = version.strip_prefix('v').unwrap_or(version).to_string();
                return ToolStatus { ok: true, version, path: exe.to_string_lossy().into_owned() };
            }
        }
    }
    ToolStatus { ok: false, version: String::new(), path: String::new() }
}

fn harness_node_ok(version: &str) -> bool {
    let version = version.trim().trim_start_matches('v');
    let mut parts = version.split('.');
    let major = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    major >= 24 || (major == 22 && minor >= 19)
}

#[derive(Serialize)]
struct Tools {
    git: ToolStatus,
    node: ToolStatus,
    pnpm: ToolStatus,
    #[serde(rename = "nodeOk")]
    node_ok: bool,
    #[serde(rename = "pnpmOk")]
    pnpm_ok: bool,
}

fn env_tools() -> Tools {
    let git = tool_version("git");
    let node = tool_version("node");
    let pnpm = tool_version("pnpm");
    let node_ok = node.ok && harness_node_ok(&node.version);
    let pnpm_ok = pnpm.ok;
    Tools { git, node, pnpm, node_ok, pnpm_ok }
}

fn is_repo_dir(path: &Path) -> bool {
    path.join("apps").join("cli").join("src").join("bin.ts").is_file()
}

fn has_tsx(repo: &Path) -> bool {
    repo.join("node_modules").join("tsx").join("package.json").is_file()
}

fn normalize_repo_path(value: &str) -> PathBuf {
    let mut text = value.trim();
    if text.len() >= 2
        && ((text.starts_with('"') && text.ends_with('"'))
            || (text.starts_with('\'') && text.ends_with('\'')))
    {
        text = &text[1..text.len() - 1];
    }
    let mut expanded = String::new();
    let mut rest = text.trim();
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let key = &after[..end];
            if let Ok(value) = std::env::var(key) {
                expanded.push_str(&value);
            } else {
                expanded.push('%');
                expanded.push_str(key);
                expanded.push('%');
            }
            rest = &after[end + 1..];
        } else {
            expanded.push('%');
            expanded.push_str(after);
            rest = "";
            break;
        }
    }
    expanded.push_str(rest);
    let expanded = expanded.trim().to_string();
    if expanded.is_empty() {
        return PathBuf::new();
    }
    let path = if expanded == "~" || expanded.starts_with("~/") || expanded.starts_with("~\\") {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default();
        PathBuf::from(home).join(expanded.trim_start_matches('~').trim_start_matches(|c| c == '/' || c == '\\'))
    } else {
        PathBuf::from(expanded)
    };
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

fn resolve_repo(value: &str) -> Option<PathBuf> {
    let path = normalize_repo_path(value);
    if path.as_os_str().is_empty() {
        return None;
    }
    let mut tries = vec![
        path.clone(),
        path.join("src"),
        path.join("deepseek-harness"),
        path.join("deepseek-harness").join("src"),
    ];
    let mut up = path.parent();
    for _ in 0..4 {
        if let Some(parent) = up {
            tries.push(parent.to_path_buf());
            up = parent.parent();
        }
    }
    if let Some(hit) = tries.into_iter().find(|p| is_repo_dir(p)) {
        return Some(hit);
    }
    let mut hits = Vec::new();
    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten().take(400) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == "deepseek-harness"
                || (name.starts_with("deepseek-harness-") || name.starts_with("deepseek-harness_"))
            {
                for candidate in [entry.path(), entry.path().join("src")] {
                    if is_repo_dir(&candidate) {
                        hits.push(candidate);
                    }
                }
            }
        }
    }
    if hits.len() == 1 { hits.pop() } else { None }
}

fn scan_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut seen = HashSet::new();
    for root in roots {
        let key = root.to_string_lossy().to_lowercase();
        if root.as_os_str().is_empty() || !seen.insert(key) {
            continue;
        }
        let Ok(entries) = fs::read_dir(root) else { continue };
        for entry in entries.flatten().take(400) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if is_repo_dir(&entry.path()) {
                return Some(entry.path());
            }
            let src = entry.path().join("src");
            if is_repo_dir(&src) {
                return Some(src);
            }
        }
    }
    None
}

fn scan_for_repo() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    let mut direct = Vec::new();
    for key in ["DSH_HARNESS_REPO", "DSH_HARNESS_SRC"] {
        if let Ok(value) = std::env::var(key) {
            direct.push(value);
        }
    }
    if let Some(home) = &home {
        direct.push(home.join("deepseek-harness").join("src").to_string_lossy().into_owned());
        direct.push(home.join("deepseek-harness").to_string_lossy().into_owned());
        direct.push(home.join(".dsh").join("harness").to_string_lossy().into_owned());
    }
    for candidate in direct {
        if let Some(hit) = resolve_repo(&candidate) {
            return Some(hit);
        }
    }
    let roots = home
        .as_ref()
        .map(|home| {
            vec![
                home.join("Documents").join("GitHub"),
                home.join("Documents"),
                home.join("source").join("repos"),
                home.join("code"),
                home.join("projects"),
                home.join("dev"),
                home.join("Desktop"),
                home.clone(),
            ]
        })
        .unwrap_or_default();
    if let Some(hit) = scan_roots(&roots) {
        return Some(hit);
    }
    #[cfg(windows)]
    {
        let mut exact = Vec::new();
        let mut drive_roots = Vec::new();
        for letter in b'C'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if !root.exists() {
                continue;
            }
            for suffix in [
                "deepseek-harness\\src",
                "deepseek-harness",
                "code\\deepseek-harness",
                "src\\deepseek-harness",
                "deepseek-harness\\deepseek-harness",
            ] {
                let candidate = root.join(suffix);
                if is_repo_dir(&candidate) {
                    exact.push(candidate);
                }
            }
            drive_roots.push(root);
        }
        if let Some(hit) = exact.into_iter().next() {
            return Some(hit);
        }
        return scan_roots(&drive_roots);
    }
    #[cfg(not(windows))]
    None
}

fn cached_detect_repo(app: &AppHandle, force: bool) -> Option<PathBuf> {
    let cache = app_root(app).ok()?.join("repo-cache.json");
    if !force {
        let cached_root = read_object(&cache);
        let cached: Option<String> = match cached_root.get("repo") {
            Some(Value::String(value)) => Some(value.clone()),
            _ => None,
        };
        if let Some(value) = cached {
            let path = normalize_repo_path(&value);
            if is_repo_dir(&path) {
                return Some(path);
            }
        }
    }
    let hit = scan_for_repo();
    if let Some(path) = &hit {
        let _ = atomic_json_write(&cache, &json!({ "repo": path.to_string_lossy(), "at": now_ms() as u64 }));
    }
    hit
}

fn configured_repo(app: &AppHandle) -> String {
    let settings_path = match settings_file(app) {
        Ok(path) => path,
        Err(_) => return String::new(),
    };
    let settings = read_object(&settings_path);
    if let Some(repo) = settings
        .get("harness")
        .and_then(Value::as_object)
        .and_then(|h| h.get("repo"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        return repo.to_string();
    }
    if let Ok(path) = state_file(app) {
        if let Some(repo) = read_object(&path).get("harnessRepo").and_then(Value::as_str) {
            return repo.to_string();
        }
    }
    String::new()
}

fn inspect_repo(repo: PathBuf) -> Value {
    let shown = repo.to_string_lossy().into_owned();
    let has_bin = !shown.is_empty() && is_repo_dir(&repo);
    let has_tsx = has_bin && has_tsx(&repo);
    let status = if shown.is_empty() {
        "missing"
    } else if !has_bin {
        "norepo"
    } else if !has_tsx {
        "nodeps"
    } else {
        "ok"
    };
    let detail = match status {
        "missing" => "未配置或没探测到 DeepSeek Harness 源码仓库".to_string(),
        "norepo" => format!("{shown} 不是 harness 仓库根：缺 apps/cli/src/bin.ts"),
        "nodeps" => format!("{shown}（目录正确，但 tsx 依赖缺失；请执行 pnpm install）"),
        _ => format!("仓库及 tsx 入口检查通过：{shown}"),
    };
    let loader = if has_tsx {
        repo.join("node_modules").join("tsx").join("package.json").to_string_lossy().into_owned()
    } else {
        String::new()
    };
    json!({
        "repo": shown,
        "hasBin": has_bin,
        "hasTsx": has_tsx,
        "loader": loader,
        "status": status,
        "detail": detail,
    })
}

fn effective_repo(app: &AppHandle, explicit: Option<&str>, force: bool) -> PathBuf {
    if let Some(value) = explicit.filter(|s| !s.trim().is_empty()) {
        return resolve_repo(value).unwrap_or_else(|| normalize_repo_path(value));
    }
    let configured = configured_repo(app);
    if !configured.is_empty() {
        return resolve_repo(&configured).unwrap_or_else(|| normalize_repo_path(&configured));
    }
    cached_detect_repo(app, force).unwrap_or_default()
}

pub async fn detect(app: AppHandle, path: Option<String>, force: Option<bool>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = effective_repo(&app, path.as_deref(), force.unwrap_or(false));
        let mut result = inspect_repo(repo);
        if let Some(object) = result.as_object_mut() {
            object.insert("ok".into(), json!(true));
        }
        result
    })
    .await
    .unwrap_or_else(|e| failure(e.to_string()))
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

fn find_file_bounded(root: &Path, name: &str, max_depth: usize, depth: usize) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(root).ok()?.flatten().take(400).collect();
    for entry in &entries {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            && entry.file_name().to_string_lossy().eq_ignore_ascii_case(name)
        {
            return Some(entry.path());
        }
    }
    if depth >= max_depth {
        return None;
    }
    for entry in entries {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(hit) = find_file_bounded(&entry.path(), name, max_depth, depth + 1) {
                return Some(hit);
            }
        }
    }
    None
}

fn everything_config(app: &AppHandle) -> Map<String, Value> {
    settings_file(app)
        .ok()
        .and_then(|p| read_object(&p).get("everything").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn auto_launch_exe(app: &AppHandle) -> PathBuf {
    everything_config(app)
        .get("exe")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_default()
}

fn find_existing_everything(app: &AppHandle) -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let home = home_dir();
    let mut direct = Vec::new();
    if let Some(exe) = everything_config(app).get("exe").and_then(Value::as_str) {
        direct.push(PathBuf::from(exe));
    }
    direct.extend([
        local.join("Everything").join("Everything.exe"),
        PathBuf::from(r"C:\Program Files\Everything\Everything.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Everything\Everything.exe"),
        home.join("Everything").join("Everything.exe"),
    ]);
    if let Some(hit) = direct.into_iter().find(|p| p.is_file()) {
        return hit;
    }
    for name in ["Downloads", "Desktop", "Documents"] {
        let root = home.join(name);
        let Ok(entries) = fs::read_dir(root) else { continue };
        for entry in entries.flatten().take(400) {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && entry.file_name().to_string_lossy().to_lowercase().starts_with("everything")
            {
                if let Some(hit) = find_file_bounded(&entry.path(), "Everything.exe", 2, 0) {
                    return hit;
                }
            }
        }
    }
    PathBuf::new()
}

fn es_path(app: &AppHandle) -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("assets").join("es.exe"));
        candidates.push(resource.join("es.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("assets").join("es.exe"));
        }
    }
    candidates.extend([
        local.join("Everything").join("es.exe"),
        PathBuf::from(r"C:\Program Files\Everything\es.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Everything\es.exe"),
    ]);
    candidates.into_iter().find(|p| p.is_file()).unwrap_or_default()
}

fn instance_from_exe(exe: &Path) -> Option<String> {
    if exe.as_os_str().is_empty() {
        return None;
    }
    let parent = exe.parent()?;
    for entry in fs::read_dir(parent).ok()?.flatten().take(400) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if lower.starts_with("everything-") && lower.ends_with(".ini") && !lower.contains("backup") {
            return Some(name[11..name.len() - 4].to_string());
        }
    }
    if parent.join("Everything.ini").is_file() {
        return Some(String::new());
    }
    None
}

fn es_instance_candidates(app: &AppHandle) -> Vec<String> {
    let mut result = Vec::new();
    let mut push = |value: String| {
        if !result.contains(&value) {
            result.push(value);
        }
    };
    if let Ok(path) = state_file(app) {
        if let Some(value) = read_object(&path).get("esInstance").and_then(Value::as_str) {
            push(value.to_string());
        }
    }
    if let Some(value) = instance_from_exe(&auto_launch_exe(app)) {
        push(value);
    }
    for value in ["", "1.5a", "1.5", "1.4"] {
        push(value.to_string());
    }
    result
}

fn contains_es_error(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim().to_lowercase();
        line.starts_with("error ") || line.starts_with("error\t")
    })
}

fn probe_everything(app: &AppHandle, quick: bool) -> (bool, String) {
    let es = es_path(app);
    if es.as_os_str().is_empty() {
        return (false, String::new());
    }
    let candidates = es_instance_candidates(app);
    let count = if quick { 2 } else { candidates.len() };
    for instance in candidates.into_iter().take(count) {
        let mut args = Vec::new();
        if !instance.is_empty() {
            args.extend([String::from("-instance"), instance.clone()]);
        }
        args.extend([String::from("-n"), String::from("1"), String::from("*")]);
        let timeout = if quick { 2500 } else { 6000 };
        let Ok(output) = run_capture(executable_command(&es, &args), Duration::from_millis(timeout)) else {
            continue;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.code == Some(0)
            && !output.timed_out
            && !stdout.trim().is_empty()
            && !contains_es_error(&stdout)
            && !contains_es_error(&stderr)
        {
            if let Ok(path) = state_file(app) {
                let instance_copy = instance.clone();
                let _ = update_object(&path, |root| {
                    root.insert("esInstance".into(), json!(instance_copy));
                });
            }
            return (true, instance);
        }
    }
    (false, String::new())
}

fn everything_status(app: &AppHandle, quick: bool) -> Value {
    let es = es_path(app);
    let deployed = everything_config(app).get("exe").and_then(Value::as_str).unwrap_or_default().to_string();
    let existing = find_existing_everything(app);
    let (running, instance) = probe_everything(app, quick);
    let es_missing = es.as_os_str().is_empty();
    let existing_string = existing.to_string_lossy().into_owned();
    let status = if es_missing { "missing-es" } else if running { "ok" } else { "missing" };
    let detail = if es_missing {
        "程序自带的 es.exe 不见了（重装或重新解压安装包）".to_string()
    } else if running {
        if instance.is_empty() {
            "Everything 正在运行（默认实例）".to_string()
        } else {
            format!("Everything 正在运行（实例 {instance}）")
        }
    } else if existing.is_file() {
        "Everything 没有在运行，但检测到你机器上已经有一份".to_string()
    } else {
        "Everything 没有在运行（文件搜索会提示未检测到）".to_string()
    };
    let auto_exe = auto_launch_exe(app);
    let auto_launch = everything_config(app).get("autoLaunch").and_then(Value::as_bool).unwrap_or(true);
    json!({
        "id": "everything",
        "name": "Everything（文件搜索用）",
        "status": status,
        "running": running,
        "detail": detail,
        "esExe": es.to_string_lossy(),
        "esExeOk": !es_missing,
        "instance": instance,
        "deployedExe": deployed,
        "deployedOk": !deployed.is_empty() && Path::new(&deployed).is_file(),
        "foundExe": existing_string,
        "foundIsDeployed": !deployed.is_empty() && existing == PathBuf::from(&deployed),
        "autoLaunch": auto_launch,
        "autoLaunchExe": auto_exe.to_string_lossy(),
        "fix": if running && !es_missing { "" } else { "everything" },
    })
}

#[tauri::command]
pub async fn env_check(app: AppHandle, quick: Option<bool>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let quick = quick.unwrap_or(true);
        let tools = if quick { None } else { Some(env_tools()) };
        let repo = effective_repo(&app, None, false);
        let mut harness = inspect_repo(repo);
        let harness_status = harness.get("status").and_then(Value::as_str).unwrap_or("missing").to_string();
        if let Some(object) = harness.as_object_mut() {
            object.remove("loader");
            object.insert("id".into(), json!("harness"));
            object.insert("name".into(), json!("DeepSeek Harness（聊天用）"));
            object.insert("tools".into(), tools.as_ref().map(|t| json!(t)).unwrap_or(Value::Null));
            object.insert("fix".into(), json!(if harness_status == "ok" { "" } else { "harness" }));
        }
        let everything = everything_status(&app, quick);
        let no_ask = settings_file(&app)
            .ok()
            .and_then(|p| read_object(&p).get("envNoAsk").and_then(Value::as_bool))
            .unwrap_or(false);
        let all_ok = harness.get("status").and_then(Value::as_str) == Some("ok")
            && everything.get("status").and_then(Value::as_str) == Some("ok");
        json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "quick": quick,
            "items": [harness, everything],
            "tools": tools,
            "noAsk": no_ask,
            "allOk": all_ok,
        })
    })
    .await
    .unwrap_or_else(|e| failure(e.to_string()))
}

#[tauri::command]
pub fn env_dismiss(app: AppHandle, on: bool) -> Value {
    let path = match settings_file(&app) {
        Ok(path) => path,
        Err(e) => return failure(e),
    };
    match update_object(&path, |root| {
        root.insert("envNoAsk".into(), json!(on));
    }) {
        Ok(()) => json!({ "ok": true, "noAsk": on }),
        Err(e) => failure(e),
    }
}

#[tauri::command]
pub fn env_everything_auto(app: AppHandle, on: bool) -> Value {
    let path = match settings_file(&app) {
        Ok(path) => path,
        Err(e) => return failure(e),
    };
    match update_object(&path, |root| {
        let everything = root.entry("everything").or_insert_with(|| json!({}));
        if !everything.is_object() {
            *everything = json!({});
        }
        everything.as_object_mut().expect("object").insert("autoLaunch".into(), json!(on));
    }) {
        Ok(()) => json!({ "ok": true, "autoLaunch": on }),
        Err(e) => failure(e),
    }
}

#[tauri::command]
pub fn env_launch_everything(app: AppHandle, explicit_exe: Option<String>) -> Value {
    let config = everything_config(&app);
    let configured = config.get("exe").and_then(Value::as_str).unwrap_or_default();
    let mut exe = explicit_exe.filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(configured));
    if !exe.is_file() {
        exe = find_existing_everything(&app);
    }
    if !exe.is_file() {
        return failure("没有可启动的 Everything（先部署一份，或自己下载后告诉我路径）");
    }
    if let Err(e) = Command::new(&exe).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        return failure(e.to_string());
    }
    if let Ok(path) = settings_file(&app) {
        let exe_string = exe.to_string_lossy().into_owned();
        if let Err(e) = update_object(&path, |root| {
            let everything = root.entry("everything").or_insert_with(|| json!({}));
            if !everything.is_object() {
                *everything = json!({});
            }
            let object = everything.as_object_mut().expect("object");
            object.insert("exe".into(), json!(exe_string));
            if let Some(parent) = exe.parent() {
                object.insert("dir".into(), json!(parent.to_string_lossy()));
            }
        }) {
            return failure(format!("Everything 已启动，但保存路径失败：{e}"));
        }
    }
    json!({ "ok": true, "exe": exe.to_string_lossy() })
}

#[tauri::command]
pub fn env_open_url(url: String) -> Value {
    let parsed = match reqwest::Url::parse(url.trim()) {
        Ok(url) => url,
        Err(e) => return failure(format!("无效网址：{e}")),
    };
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return failure("只允许打开 http/https 网址");
    }
    #[cfg(windows)]
    let result = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(parsed.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ());
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(parsed.as_str()).spawn().map(|_| ());
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(parsed.as_str()).spawn().map(|_| ());
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => failure(e.to_string()),
    }
}

struct TempDownload {
    path: PathBuf,
}

impl Drop for TempDownload {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn http_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("catwhale-pet/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

fn net_text(url: &str, timeout: Duration) -> Result<String, String> {
    let mut response = http_client(timeout)?.get(url).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut text = String::new();
    response.by_ref().take(2 * 1024 * 1024).read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(text)
}

fn download_file(
    app: &AppHandle,
    control: &JobControl,
    id: &str,
    url: &str,
    destination: &Path,
) -> Result<(u64, String), String> {
    let client = http_client(Duration::from_secs(300))?;
    let mut response = client.get(url).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err("下载文件超过 128MB 安全上限".into());
    }
    let mut file = File::create(destination).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut got = 0u64;
    let mut last_pct = None;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancelled(control)?;
        let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        got = got.saturating_add(count as u64);
        if got > MAX_DOWNLOAD_BYTES {
            return Err("下载文件超过 128MB 安全上限".into());
        }
        file.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
        hasher.update(&buffer[..count]);
        let pct = if total == 0 { 0 } else { (got * 100 / total).min(100) };
        if pct % 5 == 0 && last_pct != Some(pct) {
            last_pct = Some(pct);
            env_progress(app, id, "download", got, total);
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    env_progress(app, id, "download", got, total);
    Ok((got, format!("{:x}", hasher.finalize())))
}

struct EverythingPick {
    url: String,
    version: String,
    from: String,
}

fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        value
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let aa = parse(a);
    let bb = parse(b);
    for index in 0..aa.len().max(bb.len()) {
        let ordering = aa.get(index).unwrap_or(&0).cmp(bb.get(index).unwrap_or(&0));
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

fn parse_everything_page(body: &str) -> Option<(String, String)> {
    let lower = body.to_ascii_lowercase();
    let mut hits = Vec::new();
    let mut offset = 0;
    while let Some(relative) = lower[offset..].find(".x64.zip") {
        let end = offset + relative + ".x64.zip".len();
        let before = &body[..end];
        let Some(href) = before.rfind("href=") else {
            offset = end;
            continue;
        };
        let tail = &before[href + 5..];
        let Some(quote) = tail.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            offset = end;
            continue;
        };
        let content = tail.trim_start_matches(quote);
        let file = content.trim_start_matches('/');
        let valid = file.len() == content.trim_start_matches('/').len()
            && file.starts_with("Everything-")
            && file.ends_with(".x64.zip")
            && !file.contains('/')
            && !file.contains('\\');
        if valid {
            let version = file.trim_start_matches("Everything-").trim_end_matches(".x64.zip").to_string();
            hits.push((file.to_string(), version));
        }
        offset = end;
    }
    hits.sort_by(|a, b| {
        let a_beta = a.1.to_lowercase().ends_with('b');
        let b_beta = b.1.to_lowercase().ends_with('b');
        b_beta.cmp(&a_beta).then_with(|| version_cmp(&b.1, &a.1))
    });
    hits.into_iter().next()
}

fn resolve_everything_zip() -> EverythingPick {
    if let Ok(body) = net_text(EVERYTHING_PAGE, Duration::from_secs(15)) {
        if let Some((file, version)) = parse_everything_page(&body) {
            return EverythingPick {
                url: format!("https://www.voidtools.com/{file}"),
                version,
                from: "官方下载页".into(),
            };
        }
    }
    let version = EVERYTHING_FALLBACK_ZIP
        .split("Everything-")
        .nth(1)
        .and_then(|s| s.strip_suffix(".x64.zip"))
        .unwrap_or("1.5")
        .to_string();
    EverythingPick {
        url: EVERYTHING_FALLBACK_ZIP.into(),
        version,
        from: "内置已知版本（下载页解析失败）".into(),
    }
}

fn expected_sha256(manifest: &str, zip_name: &str) -> Option<String> {
    for line in manifest.lines() {
        let line = line.trim();
        if line.len() < 65 || !line.is_char_boundary(64) || !line[..64].chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = line[64..].trim_start().trim_start_matches('*').trim();
        if name.eq_ignore_ascii_case(zip_name) {
            return Some(line[..64].to_lowercase());
        }
    }
    None
}

fn extract_zip(
    app: &AppHandle,
    control: &JobControl,
    id: &str,
    archive_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total_entries = archive.len();
    if total_entries > 4096 {
        return Err("ZIP 条目过多".into());
    }
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    for index in 0..archive.len() {
        check_cancelled(control)?;
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or_else(|| "ZIP 含越界路径，已拒绝解压".to_string())?.to_path_buf();
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("ZIP 含符号链接，已拒绝解压".into());
        }
        total = total.saturating_add(entry.size());
        if total > MAX_EXTRACT_BYTES {
            return Err("ZIP 解压后超过 512MB 安全上限".into());
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = File::create(&output).map_err(|e| e.to_string())?;
        loop {
            check_cancelled(control)?;
            let count = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            file.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
        }
        if index % 16 == 0 {
            env_log(app, id, format!("解压条目 {}/{}", index + 1, total_entries));
        }
    }
    Ok(())
}

fn spawn_log_reader<R>(
    mut reader: R,
    sender: mpsc::Sender<Vec<u8>>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    })
}

fn run_job(
    app: &AppHandle,
    guard: &JobGuard,
    mut command: Command,
    cwd: Option<&Path>,
) -> Result<Option<i32>, String> {
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = command.spawn().map_err(|e| e.to_string())?;
    set_job_pid(&guard.control, Some(child.id()));
    let stdout = child.stdout.take().ok_or_else(|| "无法读取子进程 stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "无法读取子进程 stderr".to_string())?;
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    let out_thread = spawn_log_reader(stdout, sender.clone());
    let err_thread = spawn_log_reader(stderr, sender.clone());
    drop(sender);
    let mut pending = String::new();
    let mut log_bytes = |bytes: Vec<u8>, pending: &mut String| {
        pending.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(position) = pending.find('\n') {
            let line = pending[..position].trim_end_matches('\r').to_string();
            env_log(app, &guard.id, line);
            pending.drain(..=position);
        }
        if pending.len() > 16384 {
            let clipped = pending.chars().take(8192).collect::<String>();
            *pending = clipped;
        }
    };
    let status = loop {
        while let Ok(bytes) = receiver.try_recv() {
            log_bytes(bytes, &mut pending);
        }
        if is_cancelled(&guard.control) {
            kill_process_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status.code(),
            None => thread::sleep(Duration::from_millis(40)),
        }
    };
    while let Ok(bytes) = receiver.recv_timeout(Duration::from_millis(100)) {
        log_bytes(bytes, &mut pending);
    }
    let _ = out_thread.join();
    let _ = err_thread.join();
    if !pending.trim().is_empty() {
        env_log(app, &guard.id, &pending);
    }
    set_job_pid(&guard.control, None);
    if is_cancelled(&guard.control) {
        env_log(app, &guard.id, "（已取消）");
        Err("CANCELLED".into())
    } else {
        Ok(status)
    }
}

#[tauri::command]
pub async fn env_deploy_everything(app: AppHandle, dir: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || deploy_everything(app, dir))
        .await
        .unwrap_or_else(|e| failure(e.to_string()))
}

fn deploy_everything(app: AppHandle, dir: String) -> Value {
    let id = "everything";
    let guard = match begin_job(id) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    if dir.trim().is_empty() {
        return failure("没有指定部署目录");
    }
    let destination = PathBuf::from(dir.trim());
    if let Err(e) = fs::create_dir_all(&destination) {
        return failure(e.to_string());
    }
    let result = (|| -> Result<Value, String> {
        env_phase(&app, id, "resolve", "查询官方最新便携版…");
        let pick = resolve_everything_zip();
        env_log(&app, id, format!("下载源：{}（版本 {}）— {}", pick.url, pick.version, pick.from));
        check_cancelled(&guard.control)?;
        let temp = std::env::temp_dir().join(format!("pet-everything-{}-{}.zip", std::process::id(), now_ms()));
        let _cleanup = TempDownload { path: temp.clone() };
        env_phase(&app, id, "download", "正在下载官方 Everything ZIP…");
        let (bytes, actual_sha) = match download_file(&app, &guard.control, id, &pick.url, &temp) {
            Ok(value) => value,
            Err(e) => {
                env_log(&app, id, format!("下载失败：{e}"));
                return Err(e);
            }
        };
        env_log(&app, id, format!("下载完成：{} KB", bytes / 1024));
        env_phase(&app, id, "verify", "校验官方 SHA256…");
        let base = pick.url.strip_suffix(".x64.zip").unwrap_or_else(|| pick.url.strip_suffix(".zip").unwrap_or(&pick.url));
        let sha_url = format!("{base}.sha256");
        let manifest = net_text(&sha_url, Duration::from_secs(20))
            .map_err(|e| format!("获取官方 SHA256 清单失败：{e}"))?;
        let zip_name = pick.url.rsplit('/').next().unwrap_or_default();
        let expected = expected_sha256(&manifest, zip_name)
            .ok_or_else(|| format!("官方校验清单中没有 {zip_name}，拒绝未校验安装"))?;
        if expected != actual_sha {
            return Err(format!("SHA256 校验失败：期望 {expected}，实际 {actual_sha}"));
        }
        env_log(&app, id, format!("SHA256 校验通过：{}…", &actual_sha[..16]));
        check_cancelled(&guard.control)?;
        env_phase(&app, id, "extract", "解压到指定目录…");
        extract_zip(&app, &guard.control, id, &temp, &destination).map_err(|e| format!("解压失败：{e}"))?;
        let exe = find_file_bounded(&destination, "Everything.exe", 3, 0)
            .ok_or_else(|| "解压后没找到 Everything.exe".to_string())?;
        let settings = settings_file(&app).map_err(|e| format!("已解压，但保存设置失败：{e}"))?;
        let exe_string = exe.to_string_lossy().into_owned();
        let dir_string = destination.to_string_lossy().into_owned();
        let version = pick.version.clone();
        update_object(&settings, |root| {
            let everything = root.entry("everything").or_insert_with(|| json!({}));
            if !everything.is_object() {
                *everything = json!({});
            }
            let object = everything.as_object_mut().expect("object");
            object.insert("dir".into(), json!(dir_string));
            object.insert("exe".into(), json!(exe_string));
            object.insert("ver".into(), json!(version));
            object.insert("at".into(), json!(now_ms() as u64));
        })
        .map_err(|e| format!("已解压，但保存设置失败：{e}"))?;
        env_log(&app, id, format!("已部署：{}", exe.to_string_lossy()));
        env_phase(&app, id, "launch", "启动 Everything…");
        Command::new(&exe)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("文件已部署，但 Everything 启动失败：{e}"))?;
        let status = everything_status(&app, false);
        Ok(json!({
            "ok": true,
            "dir": destination.to_string_lossy(),
            "exe": exe.to_string_lossy(),
            "ver": pick.version,
            "status": status,
        }))
    })();
    match result {
        Ok(value) => value,
        Err(e) if e == "CANCELLED" => cancelled("部署已取消"),
        Err(e) => {
            env_log(&app, id, format!("部署失败：{e}"));
            failure(e)
        }
    }
}

#[tauri::command]
pub async fn env_deploy_harness(app: AppHandle, dir: String, use_mirror: Option<bool>) -> Value {
    tauri::async_runtime::spawn_blocking(move || deploy_harness(app, dir, use_mirror.unwrap_or(true)))
        .await
        .unwrap_or_else(|e| failure(e.to_string()))
}

fn deploy_harness(app: AppHandle, dir: String, use_mirror: bool) -> Value {
    let id = "harness";
    let guard = match begin_job(id) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    if dir.trim().is_empty() {
        return failure("没有指定部署目录");
    }
    let destination = normalize_repo_path(&dir);
    let result = (|| -> Result<Value, String> {
        let tools = env_tools();
        env_log(
            &app,
            id,
            format!(
                "工具链：git {} / node {} / pnpm {}",
                if tools.git.ok { &tools.git.version } else { "缺失" },
                if tools.node.ok { &tools.node.version } else { "缺失" },
                if tools.pnpm.ok { &tools.pnpm.version } else { "缺失" },
            ),
        );
        let already = is_repo_dir(&destination);
        if !already && !tools.git.ok {
            return Err("本机没有 git：请先安装 Git，或指定已有的 harness 仓库".into());
        }
        if !tools.node_ok || !tools.pnpm_ok {
            return Err("安装依赖需要 Node.js 22.19+（22.x）或 24+，以及可用的 pnpm".into());
        }
        let parent = destination.parent().ok_or_else(|| "目标目录没有父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if !already {
            if destination.exists() && fs::read_dir(&destination).map_err(|e| e.to_string())?.next().is_some() {
                return Err(format!("目标目录不是空的，也不是 harness 仓库：{}", destination.to_string_lossy()));
            }
            check_cancelled(&guard.control)?;
            env_phase(&app, id, "clone", "克隆仓库（浅克隆，只取最新一版）…");
            let clone_url = std::env::var("PET_HARNESS_CLONE_URL").unwrap_or_else(|_| HARNESS_REPO_URL.into());
            env_log(&app, id, format!("git clone {clone_url} → {}", destination.to_string_lossy()));
            let git = if tools.git.path.is_empty() { PathBuf::from("git") } else { PathBuf::from(&tools.git.path) };
            let args = vec![
                "clone".into(),
                "--depth".into(),
                "1".into(),
                clone_url,
                destination.to_string_lossy().into_owned(),
            ];
            let code = run_job(&app, &guard, executable_command(&git, &args), Some(parent))?;
            if code != Some(0) {
                return Err(format!("克隆失败（退出码 {}）", code.map(|c| c.to_string()).unwrap_or_else(|| "未知".into())));
            }
        } else {
            env_log(&app, id, format!("目录里已经是 harness 仓库，跳过克隆：{}", destination.to_string_lossy()));
        }
        check_cancelled(&guard.control)?;
        env_phase(&app, id, "install", "安装依赖（pnpm install，约 1.8GB / 数分钟）…");
        let pnpm = if tools.pnpm.path.is_empty() { PathBuf::from("pnpm") } else { PathBuf::from(&tools.pnpm.path) };
        let mut args = vec![String::from("install")];
        if use_mirror {
            args.extend([String::from("--registry"), String::from(NPM_MIRROR)]);
        }
        env_log(&app, id, format!("在 {} 执行 pnpm install", destination.to_string_lossy()));
        let code = run_job(&app, &guard, executable_command(&pnpm, &args), Some(&destination))?;
        if code != Some(0) {
            return Err(format!("依赖安装失败（退出码 {}）", code.map(|c| c.to_string()).unwrap_or_else(|| "未知".into())));
        }
        let ok_bin = is_repo_dir(&destination);
        let ok_tsx = has_tsx(&destination);
        if !ok_bin || !ok_tsx {
            return Err(format!("安装完成但校验未通过（bin.ts={ok_bin} tsx={ok_tsx}）"));
        }
        let settings = settings_file(&app).map_err(|e| format!("依赖已安装，但保存仓库设置失败：{e}"))?;
        let repo_string = destination.to_string_lossy().into_owned();
        update_object(&settings, |root| {
            let harness = root.entry("harness").or_insert_with(|| json!({}));
            if !harness.is_object() {
                *harness = json!({});
            }
            harness.as_object_mut().expect("object").insert("repo".into(), json!(repo_string));
        })
        .map_err(|e| format!("依赖已安装，但保存仓库设置失败：{e}"))?;
        env_log(&app, id, format!("部署完成，已写入设置：harness.repo = {}", destination.to_string_lossy()));
        Ok(json!({
            "ok": true,
            "dir": destination.to_string_lossy(),
            "checked": { "bin": ok_bin, "tsx": ok_tsx },
        }))
    })();
    match result {
        Ok(value) => value,
        Err(e) if e == "CANCELLED" => cancelled("部署已取消"),
        Err(e) => {
            env_log(&app, id, format!("部署失败：{e}"));
            failure(e)
        }
    }
}
