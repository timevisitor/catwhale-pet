//! DeepSeek Harness stdio JSON-RPC client.
//!
//! The Node process is deliberately long lived: a session id belongs to one
//! process, so a restart always creates a fresh id and the first prompt seeds
//! recent history. stdout is reserved for newline-delimited JSON-RPC frames;
//! diagnostics stay on stderr and API credentials are never written to logs.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const REPO_MARK: [&str; 4] = ["apps", "cli", "src", "bin.ts"];
const DEFAULT_PROVIDER: &str = "deepseek-official";
const DEFAULT_MODEL: &str = "deepseek-v4-flash-vision-exp";
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PATCH_YAML: &str = r#"# Catwhale: official headless profile + SDK JSON-RPC server.
- id: headless-startup
  disabled: true

- id: headless-runner
  disabled: true

- insert:
    - id: sdk-jsonrpc-server
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
"#;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type PendingResult = Result<Value, String>;

struct Turn {
    user: String,
    text: String,
}

#[derive(Clone, PartialEq, Eq)]
struct RuntimeConfig {
    repo: PathBuf,
    profile: String,
    patch: PathBuf,
    cwd: PathBuf,
    provider: String,
    model: String,
    max_tokens: u64,
    node: String,
    base_url: String,
    api_key: String,
}

struct Runtime {
    child: Option<Child>,
    generation: u64,
    next_id: u64,
    pending: HashMap<u64, mpsc::Sender<PendingResult>>,
    ready: bool,
    session_id: Option<String>,
    config: Option<RuntimeConfig>,
    app: Option<AppHandle>,
    booted_at: Option<Instant>,
    boot_duration_ms: u64,
    dead: Option<String>,
    history_seeded: bool,
    turn: Option<Turn>,
    stderr_tail: Arc<Mutex<String>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            child: None,
            generation: 0,
            next_id: 0,
            pending: HashMap::new(),
            ready: false,
            session_id: None,
            config: None,
            app: None,
            booted_at: None,
            boot_duration_ms: 0,
            dead: None,
            history_seeded: false,
            turn: None,
            stderr_tail: Arc::new(Mutex::new(String::new())),
        }
    }
}

fn runtime() -> &'static Mutex<Runtime> {
    static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(Runtime::default()))
}

/// Serializes start/prompt operations without blocking cancellation, whose
/// purpose is precisely to interrupt an operation waiting on a response.
fn operation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn repo_memory_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_else(|_| "0".into())
}

fn failure(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

fn lock_runtime() -> Result<std::sync::MutexGuard<'static, Runtime>, String> {
    runtime().lock().map_err(|_| "harness 状态锁已损坏".into())
}

fn without_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

/// `Command::output` has no timeout. Reader threads prevent a full pipe from
/// deadlocking the bounded wait used by node version/loader probes.
fn command_output(mut command: Command, timeout: Duration) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    without_window(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("无法读取子进程 stdout")?;
    let mut stderr = child.stderr.take().ok_or("无法读取子进程 stderr")?;
    let out_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err("子进程探测超时".into());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(error.to_string());
            }
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok(Output { status, stdout, stderr })
}

fn is_repo_dir(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && REPO_MARK
            .iter()
            .fold(path.to_path_buf(), |p, part| p.join(part))
            .is_file()
}

fn expand_percent_env(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('%') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let key = &after[..close];
        if key.is_empty() {
            out.push('%');
        } else if let Ok(value) = env::var(key) {
            out.push_str(&value);
        } else {
            out.push('%');
            out.push_str(key);
            out.push('%');
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

fn home_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn normalize_path(value: &str) -> PathBuf {
    let mut text = value.trim();
    if text.len() >= 2 {
        let bytes = text.as_bytes();
        if (bytes[0] == b'"' && bytes[text.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[text.len() - 1] == b'\'')
        {
            text = text[1..text.len() - 1].trim();
        }
    }
    let expanded = expand_percent_env(text);
    let mut path = if expanded == "~" {
        home_dir()
    } else if expanded.starts_with("~/") || expanded.starts_with("~\\") {
        home_dir().join(&expanded[2..])
    } else {
        PathBuf::from(expanded)
    };
    if path.as_os_str().is_empty() {
        return path;
    }
    if let Ok(canonical) = fs::canonicalize(&path) {
        path = canonical;
    } else if path.is_relative() {
        if let Ok(cwd) = env::current_dir() {
            path = cwd.join(path);
        }
    }
    // Node's entry-point resolver cannot reliably consume Win32 verbatim
    // paths (for example it may resolve `\\?\F:\...\bin.ts` from `F:`).
    // Keep ordinary drive/UNC paths at the process boundary while retaining
    // canonicalization for reliable repository detection.
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            let bytes = rest.as_bytes();
            if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                return PathBuf::from(rest);
            }
            if let Some(unc) = rest.strip_prefix(r"UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
        }
    }
    path
}

fn harness_child_layouts(path: &Path) -> Vec<PathBuf> {
    vec![
        path.to_path_buf(),
        path.join("src"),
        path.join("deepseek-harness"),
        path.join("deepseek-harness").join("src"),
    ]
}

fn resolve_repo(value: &str) -> Option<PathBuf> {
    let path = normalize_path(value);
    if path.as_os_str().is_empty() {
        return None;
    }
    let mut tries = harness_child_layouts(&path);
    let mut up = path.parent();
    for _ in 0..4 {
        let Some(parent) = up else { break };
        tries.push(parent.to_path_buf());
        up = parent.parent();
    }
    if let Some(hit) = tries.into_iter().find(|p| is_repo_dir(p)) {
        return Some(hit);
    }

    // ZIP layouts such as deepseek-harness-main. Ambiguity requires an
    // explicit selection instead of silently choosing one of several clones.
    let mut hits = Vec::new();
    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten().take(400) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let valid_name = name == "deepseek-harness"
                || name
                    .strip_prefix("deepseek-harness-")
                    .or_else(|| name.strip_prefix("deepseek-harness_"))
                    .is_some_and(|suffix| !suffix.is_empty());
            if !valid_name {
                continue;
            }
            for candidate in [entry.path(), entry.path().join("src")] {
                if is_repo_dir(&candidate) {
                    hits.push(candidate);
                }
            }
        }
    }
    hits.sort();
    hits.dedup();
    if hits.len() == 1 {
        hits.pop()
    } else {
        None
    }
}

fn scan_one_level(roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else { continue };
        for entry in entries.flatten().take(400) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let sub = entry.path();
            if is_repo_dir(&sub) {
                return Some(sub);
            }
            let nested = sub.join("src");
            if is_repo_dir(&nested) {
                return Some(nested);
            }
        }
    }
    None
}

#[cfg(windows)]
fn drive_letters() -> Vec<char> {
    (b'C'..=b'Z').map(char::from).collect()
}

#[cfg(not(windows))]
fn drive_letters() -> Vec<char> {
    Vec::new()
}

fn scan_for_repo() -> Option<PathBuf> {
    let home = home_dir();
    let mut exact = Vec::new();
    for key in ["DSH_HARNESS_REPO", "DSH_HARNESS_SRC"] {
        if let Ok(value) = env::var(key) {
            exact.push(value);
        }
    }
    for candidate in [
        home.join("deepseek-harness").join("src"),
        home.join("deepseek-harness"),
        home.join(".dsh").join("harness"),
    ] {
        if let Some(hit) = resolve_repo(&candidate.to_string_lossy()) {
            return Some(hit);
        }
    }
    for candidate in exact {
        if let Some(hit) = resolve_repo(&candidate) {
            return Some(hit);
        }
    }

    let roots = [
        home.join("Documents").join("GitHub"),
        home.join("Documents"),
        home.join("source").join("repos"),
        home.join("code"),
        home.join("projects"),
        home.join("dev"),
        home.join("Desktop"),
        home.clone(),
    ];
    if let Some(hit) = scan_one_level(&roots) {
        return Some(hit);
    }

    for drive in drive_letters() {
        for candidate in [
            format!(r"{drive}:\deepseek-harness\src"),
            format!(r"{drive}:\deepseek-harness"),
            format!(r"{drive}:\code\deepseek-harness"),
            format!(r"{drive}:\src\deepseek-harness"),
            format!(r"{drive}:\deepseek-harness\deepseek-harness"),
        ] {
            let path = PathBuf::from(candidate);
            if is_repo_dir(&path) {
                return Some(path);
            }
        }
    }
    let roots: Vec<PathBuf> = drive_letters()
        .into_iter()
        .map(|drive| PathBuf::from(format!(r"{drive}:\")))
        .filter(|path| path.exists())
        .collect();
    scan_one_level(&roots)
}

fn repo_cache_file() -> PathBuf {
    crate::chat::config_dir().join("repo-cache.json")
}

fn read_repo_cache() -> Option<String> {
    let value = fs::read_to_string(repo_cache_file())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
    let repo = value.get("repo")?.as_str()?;
    if !repo.is_empty() && is_repo_dir(Path::new(repo)) {
        Some(repo.to_owned())
    } else {
        None
    }
}

fn write_repo_cache(repo: &Path) {
    if repo.as_os_str().is_empty() {
        return;
    }
    let file = repo_cache_file();
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let value = json!({ "repo": repo.to_string_lossy(), "at": now_ms() });
    let _ = fs::write(file, serde_json::to_vec_pretty(&value).unwrap_or_default());
}

fn detect_repo(force: bool) -> Option<PathBuf> {
    if !force {
        if let Ok(cache) = repo_memory_cache().lock() {
            if let Some(value) = cache.as_ref() {
                return resolve_repo(value);
            }
        }
        if let Some(hit) = read_repo_cache() {
            if let Ok(mut cache) = repo_memory_cache().lock() {
                *cache = Some(hit.clone());
            }
            return resolve_repo(&hit);
        }
    }
    let hit = scan_for_repo();
    if let Ok(mut cache) = repo_memory_cache().lock() {
        *cache = Some(hit.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
    }
    if let Some(repo) = &hit {
        write_repo_cache(repo);
    }
    hit
}

#[derive(Clone)]
struct NodeCheck {
    executable: String,
    version: String,
    supported: bool,
    error: String,
}

fn supports_harness_node(version: &str) -> bool {
    let version = version.trim().trim_start_matches(['v', 'V']);
    let mut parts = version.split('.');
    let major = parts.next().and_then(|v| v.parse::<u32>().ok());
    let minor = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    matches!(major, Some(24..)) || (major == Some(22) && minor >= 19)
}

fn check_node(executable: &str) -> NodeCheck {
    let mut command = Command::new(executable);
    command.arg("-v");
    match command_output(command, PROBE_TIMEOUT) {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let supported = supports_harness_node(&version);
            NodeCheck {
                executable: executable.into(),
                supported,
                error: if supported {
                    String::new()
                } else {
                    format!("Node {version} 不受支持：需要 Node 22.19+ 或 24+")
                },
                version,
            }
        }
        Ok(output) => NodeCheck {
            executable: executable.into(),
            version: String::new(),
            supported: false,
            error: format!(
                "node -v 执行失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        },
        Err(error) => NodeCheck {
            executable: executable.into(),
            version: String::new(),
            supported: false,
            error: format!("找不到或无法执行 Node：{error}"),
        },
    }
}

fn resolve_tsx_loader(repo: &Path, node: &str) -> Option<PathBuf> {
    if !is_repo_dir(repo) {
        return None;
    }
    let script = r#"const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');const r=createRequire(process.cwd()+'/package.json').resolve('tsx/esm');process.stdout.write(pathToFileURL(r).href);"#;
    let mut command = Command::new(node);
    command.current_dir(repo).arg("--eval").arg(script);
    let output = command_output(command, PROBE_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let href = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if href.starts_with("file://") {
        Some(PathBuf::from(href))
    } else {
        None
    }
}

#[derive(Clone)]
struct RepoInspection {
    repo: PathBuf,
    has_bin: bool,
    loader: Option<PathBuf>,
    status: &'static str,
    detail: String,
}

fn inspect_repo(value: Option<&str>, node: &str) -> RepoInspection {
    let normalized = value.map(normalize_path).unwrap_or_default();
    let resolved = value.and_then(resolve_repo);
    let repo = resolved.unwrap_or(normalized);
    let has_bin = is_repo_dir(&repo);
    let loader = if has_bin {
        resolve_tsx_loader(&repo, node)
    } else {
        None
    };
    let has_tsx = loader.is_some();
    let status = if repo.as_os_str().is_empty() {
        "missing"
    } else if !has_bin {
        "norepo"
    } else if !has_tsx {
        "nodeps"
    } else {
        "ok"
    };
    let display = repo.to_string_lossy();
    let detail = match status {
        "missing" => "未配置或没探测到 DeepSeek Harness 源码仓库：请自动探测或选择包含 apps/cli/src/bin.ts 的仓库根目录".into(),
        "norepo" => format!("{display} 不是 harness 仓库根：缺少 apps/cli/src/bin.ts；~/.dsh 配置目录和安装产物不是源码仓库"),
        "nodeps" => format!("{display} 目录正确，但 tsx 依赖缺失或损坏；请在该目录执行 pnpm install"),
        _ => format!("仓库及 tsx 入口检查通过：{display}"),
    };
    RepoInspection { repo, has_bin, loader, status, detail }
}

fn inspection_json(check: &RepoInspection, node: &NodeCheck) -> Value {
    let loader = check.loader.as_ref().map(|p| p.to_string_lossy().into_owned());
    json!({
        "ok": true,
        "path": check.repo.to_string_lossy(),
        "repo": check.repo.to_string_lossy(),
        "valid": check.has_bin,
        "hasBin": check.has_bin,
        "hasTsx": check.loader.is_some(),
        "loader": loader,
        "status": check.status,
        "detail": check.detail,
        "node": node.executable,
        "nodeVersion": node.version,
        "nodeOk": node.supported,
        "nodeError": node.error,
    })
}

fn config_root() -> Value {
    let root = crate::chat::current_config();
    root.get("config")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(root)
}

fn config_string(cfg: &Value, section: &str, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = cfg.get(section).and_then(|s| s.get(*key)).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return value.trim().to_owned();
            }
        }
        if let Some(value) = cfg.get(*key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return value.trim().to_owned();
            }
        }
    }
    String::new()
}

fn config_u64(cfg: &Value, section: &str, key: &str, default: u64) -> u64 {
    cfg.get(section)
        .and_then(|s| s.get(key))
        .or_else(|| cfg.get(key))
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn read_harness_defaults() -> (String, String) {
    let mut provider = DEFAULT_PROVIDER.to_owned();
    let mut model = DEFAULT_MODEL.to_owned();
    let dsh_home = env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".dsh"));
    let Ok(text) = fs::read_to_string(dsh_home.join("settings.yaml")) else {
        return (provider, model);
    };
    let block = text
        .split("agent-default-model")
        .nth(1)
        .map(|tail| tail.lines().take(12).collect::<Vec<_>>().join("\n"))
        .unwrap_or(text);
    for line in block.lines() {
        let clean = line.trim().trim_matches([',', '{', '}']);
        if let Some(value) = clean.strip_prefix("provider:") {
            let value = value.trim().trim_matches([',', '}']);
            if !value.is_empty() {
                provider = value.into();
            }
        } else if let Some(value) = clean.strip_prefix("model:") {
            let value = value.trim().trim_matches([',', '}']);
            if !value.is_empty() {
                model = value.into();
            }
        }
    }
    (provider, model)
}

fn ensure_default_patch() -> Result<PathBuf, String> {
    let file = crate::chat::config_dir()
        .join("harness-sdk")
        .join("pet-sdk.patch.yml");
    if fs::read_to_string(&file).ok().as_deref() != Some(PATCH_YAML) {
        let parent = file.parent().ok_or("补丁路径没有父目录")?;
        fs::create_dir_all(parent).map_err(|e| format!("创建补丁目录失败：{e}"))?;
        fs::write(&file, PATCH_YAML).map_err(|e| format!("写入 harness 补丁失败：{e}"))?;
    }
    Ok(file)
}

fn configured_node(cfg: &Value) -> String {
    let configured = config_string(cfg, "harness", &["nodeExe", "node"]);
    if !configured.is_empty() {
        return configured;
    }
    env::var("CATWHALE_NODE").unwrap_or_else(|_| "node".into())
}

fn prepare_config() -> Result<(RuntimeConfig, RepoInspection, NodeCheck), String> {
    let cfg = config_root();
    let node = configured_node(&cfg);
    let node_check = check_node(&node);
    let configured_repo = config_string(&cfg, "harness", &["repo"]);
    let detected;
    let repo_value = if configured_repo.is_empty() {
        detected = detect_repo(false).map(|p| p.to_string_lossy().into_owned());
        detected.as_deref().unwrap_or("")
    } else {
        configured_repo.as_str()
    };
    let inspection = inspect_repo(Some(repo_value), &node);
    if inspection.status != "ok" {
        return Err(inspection.detail);
    }
    if !node_check.supported {
        return Err(if node_check.error.is_empty() {
            "需要 Node 22.19+ 或 24+".into()
        } else {
            node_check.error
        });
    }
    let (default_provider, default_model) = read_harness_defaults();
    let provider = {
        let deepseek = config_string(&cfg, "deepseek", &["provider"]);
        let harness = config_string(&cfg, "harness", &["provider"]);
        if !deepseek.is_empty() { deepseek } else if !harness.is_empty() { harness } else { default_provider }
    };
    let model = {
        let deepseek = config_string(&cfg, "deepseek", &["model"]);
        let harness = config_string(&cfg, "harness", &["model"]);
        if !deepseek.is_empty() { deepseek } else if !harness.is_empty() { harness } else { default_model }
    };
    let profile = {
        let value = config_string(&cfg, "harness", &["profile"]);
        if value.is_empty() { "headless".into() } else { value }
    };
    let patch = {
        let value = config_string(&cfg, "harness", &["patch"]);
        if value.is_empty() { ensure_default_patch()? } else { normalize_path(&value) }
    };
    if !patch.is_file() {
        return Err(format!("找不到 harness 补丁文件：{}", patch.to_string_lossy()));
    }
    let cwd = {
        let value = config_string(&cfg, "harness", &["cwd"]);
        if value.is_empty() { inspection.repo.clone() } else { normalize_path(&value) }
    };
    if !cwd.is_dir() {
        return Err(format!("harness 工作目录不存在：{}", cwd.to_string_lossy()));
    }
    let config = RuntimeConfig {
        repo: inspection.repo.clone(),
        profile,
        patch,
        cwd,
        provider,
        model,
        max_tokens: config_u64(&cfg, "harness", "maxTokens", 8192).clamp(1, 200_000),
        node,
        base_url: config_string(&cfg, "deepseek", &["baseUrl"]),
        api_key: {
            let deepseek = config_string(&cfg, "deepseek", &["apiKey"]);
            if deepseek.is_empty() { config_string(&cfg, "harness", &["apiKey"]) } else { deepseek }
        },
    };
    Ok((config, inspection, node_check))
}

fn push_tail(tail: &Arc<Mutex<String>>, chunk: &str) {
    if let Ok(mut current) = tail.lock() {
        current.push_str(chunk);
        if current.len() > 4000 {
            let mut start = current.len() - 4000;
            while !current.is_char_boundary(start) {
                start += 1;
            }
            current.drain(..start);
        }
    }
}

fn redacted_stderr(runtime: &Runtime) -> String {
    let mut text = runtime.stderr_tail.lock().map(|s| s.clone()).unwrap_or_default();
    if let Some(config) = &runtime.config {
        if !config.api_key.is_empty() {
            text = text.replace(&config.api_key, "[REDACTED]");
        }
    }
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.contains("ExperimentalWarning") || line.contains("trace-warnings") {
            continue;
        }
        let upper = line.to_ascii_uppercase();
        if upper.contains("DEEPSEEK_API_KEY") || upper.contains("AUTHORIZATION:") {
            lines.push("[REDACTED CREDENTIAL LINE]".to_owned());
        } else {
            lines.push(line.chars().take(600).collect());
        }
    }
    lines.join("\n").chars().take(1000).collect()
}

fn boot_ms(state: &Runtime) -> u64 {
    state.booted_at.map(|at| at.elapsed().as_millis() as u64).unwrap_or(0)
}

fn emit_status(app: &AppHandle, state_name: &str, info: Value) {
    let payload = match lock_runtime() {
        Ok(state) => {
            let (provider, model, repo, profile) = state
                .config
                .as_ref()
                .map(|c| {
                    (
                        c.provider.clone(),
                        c.model.clone(),
                        c.repo.to_string_lossy().into_owned(),
                        c.profile.clone(),
                    )
                })
                .unwrap_or_default();
            json!({
                "state": state_name,
                "info": info,
                "sessionId": state.session_id,
                "provider": provider,
                "model": model,
                "repo": repo,
                "profile": profile,
                "bootMs": boot_ms(&state),
            })
        }
        Err(_) => json!({ "state": state_name, "info": info }),
    };
    let _ = app.emit("harness:status", payload);
}

fn emit_event(app: &AppHandle, mut event: Value, session_id: Option<&str>) {
    if let Some(object) = event.as_object_mut() {
        if !object.contains_key("sessionId") {
            object.insert("sessionId".into(), session_id.map(|id| json!(id)).unwrap_or(Value::Null));
        }
    }
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("event").to_owned();
    crate::dock::dock_feed_harness(&kind, event.clone());
    let _ = app.emit("harness:event", event);
}

fn drain_pending(state: &mut Runtime, reason: &str) -> Vec<mpsc::Sender<PendingResult>> {
    let senders = state.pending.drain().map(|(_, sender)| sender).collect::<Vec<_>>();
    for sender in &senders {
        let _ = sender.send(Err(reason.to_owned()));
    }
    senders
}

/// Takes and kills the current child. Generation invalidation ensures delayed
/// stdout/stderr/exit handling can never clear a subsequently spawned process.
fn stop_runtime(reason: &str) -> bool {
    let (mut child, app, pending) = match lock_runtime() {
        Ok(mut state) => {
            state.generation = state.generation.wrapping_add(1);
            state.ready = false;
            state.history_seeded = false;
            state.booted_at = None;
            state.dead = Some(reason.into());
            let child = state.child.take();
            let app = state.app.clone();
            state.turn = None;
            let pending = drain_pending(&mut state, reason);
            (child, app, pending)
        }
        Err(_) => return false,
    };
    drop(pending);
    if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
    if let Some(app) = app {
        emit_status(&app, "dead", json!({ "reason": reason }));
    }
    true
}

fn rpc_request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let (id, receiver) = {
        let mut state = lock_runtime()?;
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        let (sender, receiver) = mpsc::channel();
        state.pending.insert(id, sender);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let write_result = (|| -> Result<(), String> {
            let child = state.child.as_mut().ok_or("harness 未运行")?;
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                let detail = redacted_stderr(&state);
                return Err(if detail.is_empty() {
                    "harness 已退出".into()
                } else {
                    format!("harness 已退出：{detail}")
                });
            }
            let mut bytes = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            let stdin = child.stdin.as_mut().ok_or("harness 输入管道不可用")?;
            stdin.write_all(&bytes).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())
        })();
        if let Err(error) = write_result {
            state.pending.remove(&id);
            return Err(format!("harness 请求写入失败：{error}"));
        }
        (id, receiver)
    };
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Ok(mut state) = lock_runtime() {
                state.pending.remove(&id);
            }
            Err(format!("harness 请求超时：{method}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("harness 请求通道已断开".into()),
    }
}

fn normalize_session_event(event: &Value) -> Option<Value> {
    let kind = event.get("type")?.as_str()?;
    let data = event.get("data").cloned().unwrap_or_else(|| json!({}));
    match kind {
        "assistant/chunk" => {
            let chunk = data.get("chunk").cloned().unwrap_or_else(|| json!({}));
            match chunk.get("type").and_then(Value::as_str) {
                Some("text-delta") => Some(json!({
                    "kind": "delta",
                    "text": chunk.get("text").and_then(Value::as_str).unwrap_or("")
                })),
                Some("reasoning-delta") => Some(json!({
                    "kind": "reasoning",
                    "text": chunk.get("reasoning").or_else(|| chunk.get("text")).and_then(Value::as_str).unwrap_or("")
                })),
                Some("usage") => Some(json!({ "kind": "usage", "usage": chunk.get("usage").cloned().unwrap_or(Value::Null) })),
                Some("block-end") if chunk.get("block").and_then(|b| b.get("type")).and_then(Value::as_str) == Some("text") => Some(json!({
                    "kind": "blockEnd",
                    "text": chunk.get("block").and_then(|b| b.get("text")).and_then(Value::as_str).unwrap_or("")
                })),
                _ => None,
            }
        }
        "assistant/message" => {
            let text = data
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
                .map(|content| {
                    content
                        .iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<String>()
                })
                .unwrap_or_default();
            Some(json!({ "kind": "message", "text": text, "usage": data.get("usage").cloned().unwrap_or(Value::Null) }))
        }
        "tool/call" => Some(json!({
            "kind": "toolCall",
            "name": data.get("name").cloned().unwrap_or(Value::Null),
            "args": data.get("arguments").cloned().unwrap_or(Value::Null),
            "callId": data.get("callId").cloned().unwrap_or(Value::Null),
        })),
        "tool/result" => {
            let content = data
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
                .and_then(|blocks| blocks.first())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let text = content
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<String>()
                })
                .unwrap_or_default();
            Some(json!({
                "kind": "toolResult",
                "callId": content.get("toolCallId").cloned().unwrap_or(Value::Null),
                "text": text.chars().take(4000).collect::<String>(),
                "isError": content.get("isError").and_then(Value::as_bool).unwrap_or(false),
            }))
        }
        "session/title" => Some(json!({ "kind": "title", "title": data.get("title").cloned().unwrap_or(Value::Null) })),
        "turn/end" => Some(json!({ "kind": "turnEnd", "reason": data.get("reason").cloned().unwrap_or(Value::Null) })),
        "request/context" => Some(json!({
            "kind": "route",
            "provider": data.get("provider").cloned().unwrap_or(Value::Null),
            "model": data.get("model").cloned().unwrap_or(Value::Null),
            "contextWindow": data.get("contextWindow").cloned().unwrap_or(Value::Null),
        })),
        _ => None,
    }
}

fn handle_session_event(app: &AppHandle, event: &Value) {
    let Some(normalized) = normalize_session_event(event) else { return };
    let kind = normalized.get("kind").and_then(Value::as_str).unwrap_or("");
    let session_id = lock_runtime().ok().and_then(|state| state.session_id.clone());
    match kind {
        "delta" => {
            if let Ok(mut state) = lock_runtime() {
                if let Some(turn) = state.turn.as_mut() {
                    turn.text.push_str(normalized.get("text").and_then(Value::as_str).unwrap_or(""));
                }
            }
        }
        "message" => {
            if let Ok(mut state) = lock_runtime() {
                if let Some(turn) = state.turn.as_mut() {
                    turn.text = normalized.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
                }
            }
        }
        "turnEnd" => {
            let is_error = normalized
                .get("reason")
                .and_then(|r| r.get("kind"))
                .and_then(Value::as_str)
                == Some("error");
            let completed = lock_runtime().ok().and_then(|mut state| state.turn.take());
            if !is_error {
                if let Some(turn) = completed {
                    if !turn.user.is_empty() || !turn.text.is_empty() {
                        crate::chat::append_history("user", &turn.user);
                        if !turn.text.is_empty() {
                            crate::chat::append_history("assistant", &turn.text);
                        }
                    }
                }
            }
        }
        _ => {}
    }
    emit_event(app, normalized, session_id.as_deref());
}

fn handle_rpc_frame(app: &AppHandle, generation: u64, frame: Value) {
    if frame.get("method").is_none() {
        if let Some(id) = frame.get("id").and_then(Value::as_u64) {
            let sender = lock_runtime().ok().and_then(|mut state| {
                if state.generation == generation {
                    state.pending.remove(&id)
                } else {
                    None
                }
            });
            if let Some(sender) = sender {
                let result = if let Some(error) = frame.get("error") {
                    Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("harness JSON-RPC 错误")
                        .to_owned())
                } else {
                    Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(result);
            }
        }
        return;
    }
    if lock_runtime().map(|state| state.generation != generation).unwrap_or(true) {
        return;
    }
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "session.event" => {
            if let Some(event) = params.get("event") {
                handle_session_event(app, event);
            }
        }
        "session.status" => {
            let state_name = params.get("status").and_then(Value::as_str).unwrap_or("");
            if state_name == "running" || state_name == "idle" {
                let session_id = params.get("sessionId").and_then(Value::as_str);
                if let Ok(mut state) = lock_runtime() {
                    if state.generation == generation && session_id.is_some() {
                        state.session_id = session_id.map(ToOwned::to_owned);
                    }
                }
                emit_status(app, state_name, json!({ "sessionId": session_id }));
            }
        }
        _ if method.starts_with("subagent.") => {
            let session_id = lock_runtime().ok().and_then(|state| state.session_id.clone());
            emit_event(app, json!({ "kind": method, "payload": params }), session_id.as_deref());
        }
        _ => {}
    }
}

fn stdout_reader(app: AppHandle, generation: u64, stdout: impl Read + Send + 'static) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // stdout is a protocol channel. Any accidental non-JSON diagnostics
        // are ignored rather than being mistaken for a response or event.
        let Ok(frame) = serde_json::from_str::<Value>(line) else { continue };
        handle_rpc_frame(&app, generation, frame);
    }

    let (child, pending, reason, stderr, session_id) = match lock_runtime() {
        Ok(mut state) => {
            if state.generation != generation || state.child.is_none() {
                return;
            }
            state.ready = false;
            state.history_seeded = false;
            state.booted_at = None;
            state.turn = None;
            let stderr = redacted_stderr(&state);
            let reason = if stderr.is_empty() {
                "harness 已退出".to_owned()
            } else {
                format!("harness 已退出：{stderr}")
            };
            state.dead = Some(reason.clone());
            let pending = drain_pending(&mut state, &reason);
            (
                state.child.take(),
                pending,
                reason,
                stderr,
                state.session_id.clone(),
            )
        }
        Err(_) => return,
    };
    drop(pending);
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut info = Map::new();
    info.insert("reason".into(), json!(reason));
    if !stderr.is_empty() {
        info.insert("stderr".into(), json!(stderr));
    }
    info.insert("sessionId".into(), session_id.map(|id| json!(id)).unwrap_or(Value::Null));
    emit_status(&app, "dead", Value::Object(info));
}

fn start_process(app: &AppHandle, config: &RuntimeConfig, inspection: &RepoInspection) -> Result<(), String> {
    let loader = inspection.loader.as_ref().ok_or("tsx loader 未解析")?;
    let bin = config.repo.join("apps").join("cli").join("src").join("bin.ts");
    let mut command = Command::new(&config.node);
    command
        .current_dir(&config.cwd)
        .arg("--import")
        .arg(loader)
        .arg(&bin)
        .arg("--profile")
        .arg(&config.profile)
        .arg("--patch")
        .arg(&config.patch)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if config.repo.join("tsconfig.json").is_file() {
        command.env("TSX_TSCONFIG_PATH", config.repo.join("tsconfig.json"));
    }
    if !config.api_key.is_empty() {
        command.env("DEEPSEEK_API_KEY", &config.api_key);
    }
    if !config.base_url.is_empty() {
        command.env("DEEPSEEK_BASE_URL", &config.base_url);
    }
    without_window(&mut command);
    let started = Instant::now();
    let mut child = command.spawn().map_err(|e| format!("harness 启动失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("无法打开 harness stdout")?;
    let stderr = child.stderr.take().ok_or("无法打开 harness stderr")?;
    let generation;
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    {
        let mut state = lock_runtime()?;
        state.generation = state.generation.wrapping_add(1);
        generation = state.generation;
        state.child = Some(child);
        state.ready = false;
        state.session_id = None;
        state.config = Some(config.clone());
        state.app = Some(app.clone());
        state.booted_at = None;
        state.boot_duration_ms = 0;
        state.dead = None;
        state.history_seeded = false;
        state.turn = None;
        state.stderr_tail = stderr_tail.clone();
    }
    emit_status(app, "starting", json!({}));
    {
        let tail = stderr_tail.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => push_tail(&tail, &String::from_utf8_lossy(&buffer[..count])),
                }
            }
        });
    }
    {
        let app = app.clone();
        thread::spawn(move || stdout_reader(app, generation, stdout));
    }

    let initialize = json!({
        "cwd": config.cwd.to_string_lossy(),
        "provider": config.provider,
        "model": config.model,
        "maxTokens": config.max_tokens,
    });
    if let Err(error) = rpc_request("initialize", initialize, BOOT_TIMEOUT) {
        stop_runtime(&error);
        return Err(error);
    }
    let session_id = format!("pet-{}-{:x}", radix36(now_ms()), generation);
    {
        let mut state = lock_runtime()?;
        if state.generation != generation || state.child.is_none() {
            return Err("harness 在初始化期间退出".into());
        }
        state.ready = true;
        state.session_id = Some(session_id.clone());
        state.booted_at = Some(Instant::now());
        state.boot_duration_ms = started.elapsed().as_millis() as u64;
    }
    emit_status(
        app,
        "idle",
        json!({
            "sessionId": session_id,
            "provider": config.provider,
            "model": config.model,
            "bootDurationMs": started.elapsed().as_millis() as u64,
        }),
    );
    Ok(())
}

fn ensure_started(app: &AppHandle, config: &RuntimeConfig, inspection: &RepoInspection) -> Result<(), String> {
    let restart = {
        let mut state = lock_runtime()?;
        let alive = match state.child.as_mut() {
            Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        };
        if alive && state.ready && state.config.as_ref() == Some(config) {
            state.app = Some(app.clone());
            return Ok(());
        }
        alive || state.child.is_some()
    };
    if restart {
        // The protocol has no cancel/close operation. shutdown is used only
        // for an intentional restart; user cancellation always hard-kills.
        let _ = rpc_request("shutdown", json!({}), SHUTDOWN_TIMEOUT);
        stop_runtime("harness 正在按新配置重启");
    }
    start_process(app, config, inspection)
}

fn history_array(value: Option<Value>) -> Vec<Value> {
    if let Some(value) = value {
        if let Some(array) = value.as_array() {
            return array.clone();
        }
        for key in ["history", "messages"] {
            if let Some(array) = value.get(key).and_then(Value::as_array) {
                return array.clone();
            }
        }
        return Vec::new();
    }
    let root = crate::chat::config_dir();
    let active = fs::read_to_string(root.join("characters").join("active.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("id")?.as_str().map(ToOwned::to_owned))
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')));
    let persona_file = active.map(|id| root.join("chat-history").join(format!("{id}.json")));
    let file = persona_file.filter(|path| path.is_file()).unwrap_or_else(|| root.join("chat-history.json"));
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn seed_history(prompt: &str, history: Option<Value>) -> String {
    let entries = history_array(history);
    let lines = entries
        .iter()
        .rev()
        .filter(|entry| entry.get("text").and_then(Value::as_str).is_some_and(|text| !text.is_empty()))
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|entry| {
            let role = if entry.get("role").and_then(Value::as_str) == Some("user") { "用户" } else { "助手" };
            let text = entry.get("text").and_then(Value::as_str).unwrap_or("").chars().take(500).collect::<String>();
            format!("{role}：{text}")
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        prompt.to_owned()
    } else {
        format!(
            "【以下是之前几轮的对话记录，仅供理解上下文；不要重复执行其中已经完成的请求】\n{}\n\n【现在请回答这条新消息】\n{}",
            lines.join("\n"),
            prompt
        )
    }
}

pub fn chat(app: AppHandle, prompt: String, history: Option<Value>) -> Value {
    let _operation = match operation_lock().lock() {
        Ok(guard) => guard,
        Err(_) => return failure("harness 操作锁已损坏"),
    };
    if let Ok(state) = lock_runtime() {
        if state.turn.is_some() {
            return failure("上一条还在生成");
        }
    }
    let started = Instant::now();
    let (config, inspection, _) = match prepare_config() {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    if let Err(error) = ensure_started(&app, &config, &inspection) {
        return failure(error);
    }
    let (session_id, should_seed) = match lock_runtime() {
        Ok(mut state) => {
            if !state.ready {
                return failure("harness 尚未就绪");
            }
            let session_id = state.session_id.clone().unwrap_or_default();
            let should_seed = !state.history_seeded;
            state.history_seeded = true;
            state.turn = Some(Turn { user: prompt.clone(), text: String::new() });
            (session_id, should_seed)
        }
        Err(error) => return failure(error),
    };
    let text = if should_seed { seed_history(&prompt, history) } else { prompt.clone() };
    emit_status(&app, "running", json!({ "sessionId": session_id }));
    let request = json!({
        "sessionId": session_id,
        "contentBlocks": [{ "type": "text", "text": text }],
    });
    match rpc_request("session/prompt", request, PROMPT_TIMEOUT) {
        Ok(result) => json!({
            "ok": true,
            "streaming": true,
            "ms": started.elapsed().as_millis() as u64,
            "sessionId": session_id,
            "result": result,
        }),
        Err(error) => {
            if let Ok(mut state) = lock_runtime() {
                state.turn = None;
            }
            failure(error)
        }
    }
}

pub fn cancel() -> Value {
    let exists = lock_runtime()
        .map(|state| state.child.is_some() || state.turn.is_some())
        .unwrap_or(false);
    if !exists {
        return failure("当前没有在跑的 harness");
    }
    stop_runtime("已取消");
    json!({ "ok": true, "cancelled": true })
}

pub fn status() -> Value {
    let mut state = match lock_runtime() {
        Ok(state) => state,
        Err(error) => return failure(error),
    };
    let alive = match state.child.as_mut() {
        Some(child) => child.try_wait().ok().flatten().is_none(),
        None => false,
    };
    if !alive {
        state.ready = false;
    }
    let config = state.config.clone();
    let cfg = config_root();
    let fallback_repo = config_string(&cfg, "harness", &["repo"]);
    let fallback_profile = config_string(&cfg, "harness", &["profile"]);
    let fallback_provider = config_string(&cfg, "deepseek", &["provider"]);
    let fallback_model = config_string(&cfg, "deepseek", &["model"]);
    json!({
        "ok": true,
        "alive": alive,
        "ready": state.ready,
        "busy": state.turn.is_some(),
        "sessionId": state.session_id,
        "provider": config.as_ref().map(|c| c.provider.clone()).filter(|v| !v.is_empty()).unwrap_or(fallback_provider),
        "model": config.as_ref().map(|c| c.model.clone()).filter(|v| !v.is_empty()).unwrap_or(fallback_model),
        "repo": config.as_ref().map(|c| c.repo.to_string_lossy().into_owned()).unwrap_or(fallback_repo),
        "profile": config.as_ref().map(|c| c.profile.clone()).filter(|v| !v.is_empty()).unwrap_or_else(|| if fallback_profile.is_empty() { "headless".into() } else { fallback_profile }),
        "bootMs": boot_ms(&state),
        "bootDurationMs": state.boot_duration_ms,
        "dead": state.dead,
        "backend": "harness",
    })
}

#[tauri::command]
pub fn harness_detect(path: Option<String>, force: Option<bool>) -> Value {
    let cfg = config_root();
    let node = configured_node(&cfg);
    let node_check = check_node(&node);
    let explicit = path.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(ToOwned::to_owned);
    let detected;
    let selected = if explicit.is_some() {
        explicit
    } else {
        detected = detect_repo(force.unwrap_or(false)).map(|p| p.to_string_lossy().into_owned());
        detected
    };
    let inspection = inspect_repo(selected.as_deref(), &node);
    inspection_json(&inspection, &node_check)
}

#[tauri::command]
pub fn dialog_browse_repo(path: Option<String>) -> Value {
    let picked = path.unwrap_or_default().trim().to_owned();
    if picked.is_empty() {
        return json!({
            "ok": false,
            "code": "NEED_PATH",
            "needPath": true,
            "error": "请由前端目录选择器提供仓库路径",
        });
    }
    let cfg = config_root();
    let node = configured_node(&cfg);
    let node_check = check_node(&node);
    let inspection = inspect_repo(Some(&picked), &node);
    let mut result = inspection_json(&inspection, &node_check);
    if let Some(object) = result.as_object_mut() {
        object.insert("picked".into(), json!(picked));
        object.insert("path".into(), json!(inspection.repo.to_string_lossy()));
        object.insert("valid".into(), json!(inspection.has_bin));
    }
    result
}
