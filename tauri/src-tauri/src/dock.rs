// Local, read-only Agent dock compatible with `agent-dock.js`.
//
// Network service: 127.0.0.1:8770, GET `/health`, `/`, `/api`, POST `/state`.
// Log adapters read at most the last 96 KiB of a session file.  This module never
// executes an Agent command and never writes into an Agent's own directory.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8770;
const POLL_MS: u64 = 2_000;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const LOG_TAIL_BYTES: u64 = 96 * 1024;
const LOG_ACTIVE_MS: u64 = 10_000;
const LOG_LIVE_MS: u64 = 120_000;
const PROBE_TTL_MS: u64 = 20_000;
const STALE_WORKING_MS: u64 = 150_000;
const STALE_SPEAKING_MS: u64 = 180_000;
const STALE_IDLE_MS: u64 = 300_000;
const STALE_WAITING_MS: u64 = 600_000;
const SLEEPING_MS: u64 = 20_000;

static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DockConfig {
    enabled: bool,
    port: u16,
    keep_done_sec: u64,
}

impl Default for DockConfig {
    fn default() -> Self {
        Self { enabled: true, port: DEFAULT_PORT, keep_done_sec: 60 }
    }
}

impl DockConfig {
    fn normalized(mut self) -> Self {
        if !(1024..=65535).contains(&self.port) {
            self.port = DEFAULT_PORT;
        }
        if !(5..=3600).contains(&self.keep_done_sec) {
            self.keep_done_sec = 60;
        }
        self
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counters {
    received: u64,
    dropped: u64,
    parse_errors: u64,
}

#[derive(Clone, Default)]
struct Summary {
    last_user: String,
    last_agent: String,
    last_tool: String,
    #[allow(dead_code)]
    last_type: String,
    saw_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    key: String,
    agent: String,
    agent_name: String,
    accent: String,
    session_id: String,
    state: String,
    event: String,
    title: String,
    cwd: String,
    tool: String,
    last_user: String,
    last_agent: String,
    source: String,
    first_seen_at: u64,
    updated_at: u64,
    state_since: u64,
    #[serde(skip)]
    file: Option<PathBuf>,
    #[serde(skip)]
    summary: Option<Summary>,
    #[serde(skip)]
    summary_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    id: String,
    name: String,
    kind: String,
    accent: String,
    available: bool,
    wired: bool,
    detail: String,
    paths: Vec<PathBuf>,
    checked_at: u64,
    disabled: bool,
    sessions: u64,
}

struct ServerControl {
    port: u16,
    stop: Arc<AtomicBool>,
}

struct Inner {
    cfg: DockConfig,
    sessions: BTreeMap<String, Session>,
    selected: Option<String>,
    pinned: Option<String>,
    channels: BTreeMap<String, Channel>,
    disabled_agents: HashSet<String>,
    counters: Counters,
    started_at: u64,
    server: Option<Arc<ServerControl>>,
    error: String,
    emit_queued: bool,
    last_emit: u64,
}

struct Runtime {
    app: AppHandle,
    config_path: PathBuf,
    inner: Mutex<Inner>,
    operation_lock: Mutex<()>,
    poll_started: AtomicBool,
}

impl Runtime {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn config_path(app: &AppHandle) -> PathBuf {
    // 与 island/info/walk 一致，走 chat::config_dir()：
    // 默认就是 app_config_dir（生产环境路径不变），但测试时可用 CATWHALE_CONFIG_DIR
    // 把整棵配置树隔离到别处，避免读到/写到真实用户目录。
    let _ = app;
    crate::chat::config_dir().join("dock.json")
}

fn load_config(path: &Path) -> DockConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<DockConfig>(&text).ok())
        .unwrap_or_default()
        .normalized()
}

fn save_config(path: &Path, cfg: &DockConfig) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, text);
    }
}

fn runtime(app: &AppHandle) -> Arc<Runtime> {
    let rt = RUNTIME
        .get_or_init(|| {
            let path = config_path(app);
            let cfg = load_config(&path);
            if !path.exists() {
                save_config(&path, &cfg);
            }
            let error = if cfg.enabled { String::new() } else { "看板已关闭（dock.json 里 enabled=false）".to_string() };
            Arc::new(Runtime {
                app: app.clone(),
                config_path: path,
                inner: Mutex::new(Inner {
                    cfg,
                    sessions: BTreeMap::new(),
                    selected: None,
                    pinned: None,
                    channels: BTreeMap::new(),
                    disabled_agents: HashSet::new(),
                    counters: Counters::default(),
                    started_at: now_ms(),
                    server: None,
                    error,
                    emit_queued: false,
                    last_emit: 0,
                }),
                operation_lock: Mutex::new(()),
                poll_started: AtomicBool::new(false),
            })
        })
        .clone();

    if !rt.poll_started.swap(true, Ordering::AcqRel) {
        let worker = rt.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            if !worker.lock().cfg.enabled {
                continue;
            }
            expire_sessions(&worker);
            scan_logs(&worker);
            refresh_channels(&worker, false);
            emit_now(&worker);
        });
    }
    rt
}

/// Start HTTP and polling lazily/idempotently.  Bind failure is reported in snapshots
/// and never prevents the pet itself from starting.
pub fn dock_init(app: &AppHandle) {
    let rt = runtime(app);
    refresh_channels(&rt, true);
    ensure_running(&rt);
}

fn ensure_running(rt: &Arc<Runtime>) {
    let _operation = rt.operation_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (enabled, already_running) = {
        let inner = rt.lock();
        (inner.cfg.enabled, inner.server.is_some())
    };
    if enabled && !already_running {
        start_server(rt);
    }
}

fn start_server(rt: &Arc<Runtime>) {
    let port = rt.lock().cfg.port;
    let listener = match TcpListener::bind((HOST, port)) {
        Ok(listener) => listener,
        Err(error) => {
            rt.lock().error = error.to_string();
            return;
        }
    };
    if let Err(error) = listener.set_nonblocking(true) {
        rt.lock().error = error.to_string();
        return;
    }
    let actual_port = listener.local_addr().map(|addr| addr.port()).unwrap_or(port);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut inner = rt.lock();
        inner.server = Some(Arc::new(ServerControl { port: actual_port, stop: stop.clone() }));
        inner.error.clear();
    }
    let server = rt.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let connection = server.clone();
                    std::thread::spawn(move || handle_connection(stream, connection));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    });
}

fn stop_server(rt: &Arc<Runtime>) {
    if let Some(server) = rt.lock().server.take() {
        server.stop.store(true, Ordering::Release);
    }
}

fn actual_port(rt: &Runtime) -> u16 {
    let inner = rt.lock();
    inner.server.as_ref().map(|server| server.port).unwrap_or(inner.cfg.port)
}

fn info(rt: &Runtime) -> Value {
    let inner = rt.lock();
    json!({
        "ok": inner.server.is_some(),
        "host": HOST,
        "port": inner.server.as_ref().map(|server| server.port).unwrap_or(inner.cfg.port),
        "startedAt": inner.started_at,
    })
}

/* ================================ HTTP ================================ */

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn handle_connection(mut stream: TcpStream, rt: Arc<Runtime>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err((status, message, dropped)) => {
            if dropped {
                let mut inner = rt.lock();
                inner.counters.dropped = inner.counters.dropped.saturating_add(1);
            }
            send_json(&mut stream, status, json!({ "ok": false, "error": message }));
            return;
        }
    };

    let path = request.path.split('?').next().unwrap_or("/");
    match (request.method.as_str(), path) {
        ("GET", "/health") | ("GET", "/") => {
            let mut value = Map::new();
            value.insert("ok".into(), Value::Bool(true));
            value.insert("app".into(), Value::String("catwhale-agent-dock".into()));
            if let Value::Object(info) = info(&rt) {
                value.extend(info);
            }
            send_json(&mut stream, 200, Value::Object(value));
        }
        ("GET", "/api") => send_json(&mut stream, 200, snapshot(&rt)),
        ("POST", "/state") => {
            let raw = match serde_json::from_slice::<Value>(&request.body) {
                Ok(raw) => raw,
                Err(_) => {
                    let mut inner = rt.lock();
                    inner.counters.parse_errors = inner.counters.parse_errors.saturating_add(1);
                    drop(inner);
                    send_json(&mut stream, 400, json!({ "ok": false, "error": "invalid json" }));
                    return;
                }
            };
            let agent_header = request.headers.get("x-agent").map(String::as_str);
            let result = ingest(&rt, raw, agent_header);
            let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
            send_json(&mut stream, if ok { 200 } else { 400 }, result);
        }
        _ => send_json(&mut stream, 404, json!({ "ok": false, "error": "not found" })),
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Request, (u16, &'static str, bool)> {
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end;
    loop {
        if let Some(pos) = find_header_end(&data) {
            header_end = pos;
            break;
        }
        if data.len() > MAX_HEADER_BYTES {
            return Err((400, "headers too large", false));
        }
        let count = stream.read(&mut buffer).map_err(|_| (400, "read failed", false))?;
        if count == 0 {
            return Err((400, "incomplete request", false));
        }
        data.extend_from_slice(&buffer[..count]);
    }

    let header = String::from_utf8_lossy(&data[..header_end]);
    let mut lines = header.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    if method.is_empty() {
        return Err((400, "bad request", false));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err((400, "unsupported transfer encoding", false));
    }
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>().map_err(|_| (400, "invalid content length", false)))
        .transpose()?
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err((413, "body too large", true));
    }
    let body_start = header_end + 4;
    let mut body = data.get(body_start..).unwrap_or_default().to_vec();
    if body.len() > MAX_BODY_BYTES {
        return Err((413, "body too large", true));
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let chunk = remaining.min(buffer.len());
        let count = stream
            .read(&mut buffer[..chunk])
            .map_err(|_| (400, "read failed", false))?;
        if count == 0 {
            return Err((400, "incomplete body", false));
        }
        body.extend_from_slice(&buffer[..count]);
    }
    body.truncate(content_length);
    Ok(Request { method, path, headers, body })
}

fn find_header_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|window| window == b"\r\n\r\n")
}

fn send_json(stream: &mut TcpStream, status: u16, value: Value) {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

/* ============================ Push ingestion ============================ */

fn ingest(rt: &Arc<Runtime>, raw: Value, agent_header: Option<&str>) -> Value {
    let port = actual_port(rt);
    let mut inner = rt.lock();
    inner.counters.received = inner.counters.received.saturating_add(1);
    let Some(object) = raw.as_object() else {
        inner.counters.dropped = inner.counters.dropped.saturating_add(1);
        return json!({ "ok": false, "error": "payload must be an object" });
    };

    let event = first_text(object, &["event", "hook_event_name", "hookName"]);
    let agent_input = first_text(object, &["agent", "agent_id", "source"]);
    let mut agent = normalize_agent_id(if agent_input.is_empty() {
        agent_header.unwrap_or("")
    } else {
        &agent_input
    });
    if agent.is_empty() {
        agent = if !event.is_empty()
            && (object.contains_key("profile") || object.contains_key("hook_event_name"))
        {
            "hermes".to_string()
        } else {
            "generic".to_string()
        };
    }
    let state = normalize_state(&text_value(object.get("state")))
        .or_else(|| {
            let value = state_from_event(event.trim());
            if value.is_empty() { None } else { Some(value.to_string()) }
        })
        .or_else(|| normalize_state(&text_value(object.get("status"))))
        .unwrap_or_else(|| "working".to_string());
    let mut session_id = clamp_text(&first_text(object, &["session_id", "sessionId", "session"]), 120);
    if session_id.is_empty() {
        session_id = "default".to_string();
    }
    let key = format!("{agent}::{session_id}");
    let now = now_ms();
    let previous = inner.sessions.get(&key).cloned();
    let (agent_name, _, accent) = agent_meta(&agent);

    let previous_title = previous.as_ref().map(|s| s.title.as_str()).unwrap_or("");
    let mut title = first_text(object, &["session_title", "title"]);
    if title.is_empty() {
        title = previous_title.to_string();
    }
    if title.is_empty() {
        title = text_value(object.get("name"));
    }
    title = clamp_text(&title, 48);
    let cwd_input = first_text(object, &["cwd"]);
    let cwd = if cwd_input.is_empty() {
        previous.as_ref().map(|s| s.cwd.clone()).unwrap_or_default()
    } else {
        clamp_text(&cwd_input, 200)
    };
    if title.is_empty() {
        title = Path::new(&cwd)
            .file_name()
            .map(|part| part.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    if title.is_empty() {
        title = session_id.chars().take(12).collect();
    }

    let session = Session {
        key: key.clone(),
        agent: agent.clone(),
        agent_name: agent_name.to_string(),
        accent: accent.to_string(),
        session_id: session_id.clone(),
        state: state.clone(),
        event: if event.is_empty() {
            previous.as_ref().map(|s| s.event.clone()).unwrap_or_default()
        } else {
            event
        },
        title,
        cwd,
        tool: prefer_previous(
            first_text(object, &["tool_name", "tool"]),
            previous.as_ref().map(|s| s.tool.clone()),
            40,
        ),
        last_user: prefer_previous(
            first_text(object, &["prompt", "last_user_message"]),
            previous.as_ref().map(|s| s.last_user.clone()),
            300,
        ),
        last_agent: prefer_previous(
            first_text(object, &["last_assistant_message", "message", "text"]),
            previous.as_ref().map(|s| s.last_agent.clone()),
            400,
        ),
        source: "push".to_string(),
        first_seen_at: previous.as_ref().map(|s| s.first_seen_at).unwrap_or(now),
        updated_at: now,
        state_since: previous
            .as_ref()
            .filter(|old| old.state == state)
            .map(|old| old.state_since)
            .unwrap_or(now),
        file: None,
        summary: None,
        summary_at: 0,
    };
    inner.sessions.insert(key.clone(), session);
    drop(inner);
    queue_emit(rt, false);
    json!({
        "ok": true,
        "session": { "key": key, "agent": agent, "state": state, "sessionId": session_id },
        "port": port,
    })
}

fn prefer_previous(input: String, previous: Option<String>, limit: usize) -> String {
    if input.is_empty() {
        previous.unwrap_or_default()
    } else {
        clamp_text(&input, limit)
    }
}

/// Native DeepSeek Harness entry point.  Call `dock_init` first; events have exactly
/// the same `status` / `event` shapes as the Electron main-process integration.
pub fn dock_feed_harness(kind: &str, payload: Value) {
    let Some(rt) = RUNTIME.get().cloned() else { return };
    let now = now_ms();
    let mut inner = rt.lock();
    let key = "dsh::live";
    let previous = inner.sessions.get(key).cloned();
    let mut session = native_base(previous.as_ref(), now);
    let mut changed = true;

    if kind == "status" {
        let status = text_value(payload.get("state")).to_lowercase();
        if status.is_empty() || status == "stopped" || status == "dead" {
            if previous.as_ref().is_none_or(|old| old.state.is_empty() || old.state == "done") {
                return;
            }
            session.state = "done".into();
            session.event = "status".into();
        } else {
            session.state = if matches!(status.as_str(), "busy" | "working" | "starting") {
                "working"
            } else {
                "idle"
            }
            .into();
            session.event = format!("harness:{status}");
        }
    } else if kind == "event" {
        let event_kind = text_value(payload.get("kind"));
        match event_kind.as_str() {
            "delta" | "message" => {
                session.state = "speaking".into();
                session.event = if event_kind == "delta" { "stream".into() } else { "message".into() };
                session.last_agent = clamp_text(&last_chars(&text_value(payload.get("text")), 400), 400);
            }
            "tool" => {
                session.state = "working".into();
                session.event = "tool".into();
                session.tool = clamp_text(&text_value(payload.get("name")), 40);
            }
            "turnEnd" => {
                let failed = payload
                    .get("reason")
                    .and_then(|reason| reason.get("kind"))
                    .and_then(Value::as_str)
                    == Some("error");
                session.state = if failed { "error" } else { "done" }.into();
                session.event = "turnEnd".into();
                session.tool.clear();
            }
            "error" => {
                session.state = "error".into();
                session.event = "error".into();
            }
            _ => changed = false,
        }
    } else {
        changed = false;
    }
    if !changed {
        return;
    }
    session.updated_at = now;
    session.state_since = previous
        .as_ref()
        .filter(|old| old.state == session.state)
        .map(|old| old.state_since)
        .unwrap_or(now);
    inner.sessions.insert(key.to_string(), session);
    drop(inner);
    queue_emit(&rt, false);
}

fn native_base(previous: Option<&Session>, now: u64) -> Session {
    let mut session = previous.cloned().unwrap_or_else(|| Session {
        key: "dsh::live".into(),
        agent: "dsh".into(),
        agent_name: "DeepSeek Harness".into(),
        accent: "#4d6bfe".into(),
        session_id: "live".into(),
        state: "working".into(),
        event: String::new(),
        title: "桌宠对话".into(),
        cwd: String::new(),
        tool: String::new(),
        last_user: String::new(),
        last_agent: String::new(),
        source: "native".into(),
        first_seen_at: now,
        updated_at: now,
        state_since: now,
        file: None,
        summary: None,
        summary_at: 0,
    });
    session.source = "native".into();
    if session.title.is_empty() {
        session.title = "桌宠对话".into();
    }
    session
}

/* ============================ Log adapters ============================ */

fn expire_sessions(rt: &Runtime) {
    let now = now_ms();
    let keep_done_ms = rt.lock().cfg.keep_done_sec.saturating_mul(1000);
    rt.lock().sessions.retain(|_, session| {
        let age = now.saturating_sub(session.updated_at);
        match session.source.as_str() {
            "push" | "native" => match session.state.as_str() {
                "done" | "error" => age <= keep_done_ms,
                "sleeping" => age <= SLEEPING_MS,
                "working" => age <= STALE_WORKING_MS,
                "speaking" => age <= STALE_SPEAKING_MS,
                "idle" => age <= STALE_IDLE_MS,
                "waiting_user" => age <= STALE_WAITING_MS,
                _ => true,
            },
            "log" => age <= LOG_LIVE_MS + 60_000,
            _ => true,
        }
    });
}

#[derive(Clone)]
struct LogFile {
    path: PathBuf,
    mtime: u64,
}

fn scan_logs(rt: &Runtime) {
    let home = home_dir();
    let roots = [
        ("codex", home.join(".codex").join("sessions")),
        ("claude-code", home.join(".claude").join("projects")),
    ];
    let now = now_ms();
    let mut inner = rt.lock();
    for (agent, root) in roots {
        if inner.channels.get(agent).is_some_and(|channel| !channel.available)
            || inner.disabled_agents.contains(agent)
        {
            continue;
        }
        let files = list_jsonl(&root, 6, 60);
        let mut touched = HashSet::new();
        for file in files.into_iter().take(3) {
            let age = now.saturating_sub(file.mtime);
            if age > LOG_LIVE_MS {
                continue;
            }
            let raw_state = if age <= LOG_ACTIVE_MS { "working" } else { "done" };
            let session_id = file
                .path
                .file_stem()
                .map(|part| part.to_string_lossy().into_owned())
                .unwrap_or_else(|| "session".into());
            let key = format!("{agent}::{session_id}");
            let previous = inner.sessions.get(&key).cloned();
            if previous.as_ref().is_some_and(|old| old.source == "push") {
                continue;
            }
            if previous.as_ref().is_some_and(|old| {
                old.state == raw_state && now.saturating_sub(old.updated_at) < 1500
            }) {
                touched.insert(key);
                continue;
            }
            let summary = previous
                .as_ref()
                .and_then(|old| old.summary.clone())
                .filter(|_| now.saturating_sub(previous.as_ref().map(|s| s.summary_at).unwrap_or(0)) < 4000)
                .unwrap_or_else(|| summarize_records(&read_tail(&file.path, LOG_TAIL_BYTES)));
            let state = if summary.saw_error && raw_state == "done" { "error" } else { raw_state };
            let (agent_name, _, accent) = agent_meta(agent);
            let title = if summary.last_user.is_empty() {
                session_id.chars().take(12).collect()
            } else {
                clamp_text(&summary.last_user, 48)
            };
            let session = Session {
                key: key.clone(),
                agent: agent.into(),
                agent_name: agent_name.into(),
                accent: accent.into(),
                session_id,
                state: state.into(),
                event: "log".into(),
                title,
                cwd: String::new(),
                tool: summary.last_tool.clone(),
                last_user: summary.last_user.clone(),
                last_agent: summary.last_agent.clone(),
                source: "log".into(),
                first_seen_at: previous.as_ref().map(|old| old.first_seen_at).unwrap_or(file.mtime),
                updated_at: file.mtime,
                state_since: previous
                    .as_ref()
                    .filter(|old| old.state == state)
                    .map(|old| old.state_since)
                    .unwrap_or(file.mtime),
                file: Some(file.path.clone()),
                summary: Some(summary),
                summary_at: now,
            };
            inner.sessions.insert(key.clone(), session);
            touched.insert(key);
        }
        inner.sessions.retain(|key, session| {
            if session.agent != agent || session.source != "log" || touched.contains(key) {
                return true;
            }
            session
                .file
                .as_ref()
                .and_then(|path| file_mtime(path))
                .is_some_and(|mtime| now.saturating_sub(mtime) <= LOG_LIVE_MS)
        });
    }
}

fn list_jsonl(root: &Path, max_depth: usize, max_files: usize) -> Vec<LogFile> {
    fn walk(dir: &Path, depth: usize, max_depth: usize, max_files: usize, out: &mut Vec<LogFile>) {
        if depth > max_depth || out.len() >= max_files {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if out.len() >= max_files {
                break;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                walk(&path, depth + 1, max_depth, max_files, out);
            } else if kind.is_file()
                && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
            {
                if let Some(mtime) = file_mtime(&path) {
                    out.push(LogFile { path, mtime });
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 0, max_depth, max_files, &mut out);
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

fn file_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn read_tail(path: &Path, bytes: u64) -> String {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    let len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return String::new(),
    };
    if file.seek(SeekFrom::Start(len.saturating_sub(bytes))).is_err() {
        return String::new();
    }
    let mut tail = Vec::with_capacity(len.min(bytes) as usize);
    if file.take(bytes).read_to_end(&mut tail).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&tail).into_owned()
}

fn summarize_records(text: &str) -> Summary {
    let mut out = Summary::default();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        let payload = record.get("payload").filter(|value| value.is_object());
        let message = record.get("message").filter(|value| value.is_object());
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| payload.and_then(|value| value.get("type")).and_then(Value::as_str))
            .unwrap_or("");
        if !kind.is_empty() {
            out.last_type = kind.to_string();
        }
        if kind == "error"
            || record.get("error").is_some_and(json_truthy)
            || payload.and_then(|value| value.get("ok")).and_then(Value::as_bool) == Some(false)
        {
            out.saw_error = true;
        }
        let role = message
            .and_then(|value| value.get("role"))
            .or_else(|| payload.and_then(|value| value.get("role")))
            .or_else(|| record.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let content = message
            .and_then(|value| value.get("content"))
            .or_else(|| payload.and_then(|value| value.get("content")))
            .or_else(|| record.get("content"));
        let mut content_text = content.map(content_text).unwrap_or_default();
        if content_text.is_empty() {
            content_text = payload
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        let tool = payload
            .and_then(|value| value.get("name"))
            .or_else(|| record.get("tool_name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !tool.is_empty() {
            out.last_tool = tool.to_string();
        }
        if role == "user" && !content_text.is_empty() {
            out.last_user = clamp_text(&content_text, 300);
        } else if matches!(role, "assistant" | "agent") && !content_text.is_empty() {
            out.last_agent = clamp_text(&content_text, 400);
        } else if kind == "event_msg" {
            if let Some(payload) = payload {
                match payload.get("type").and_then(Value::as_str).unwrap_or("") {
                    "user_message" => {
                        out.last_user = clamp_text(&text_value(payload.get("message")), 300)
                    }
                    "agent_message" => {
                        out.last_agent = clamp_text(&text_value(payload.get("message")), 400)
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

fn content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                ["text", "input_text", "output_text"]
                    .iter()
                    .find_map(|key| item.get(*key).and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/* ============================ Channel probes ============================ */

#[derive(Default)]
struct Probe {
    available: bool,
    wired: bool,
    detail: String,
    paths: Vec<PathBuf>,
}

const AGENTS: [(&str, &str, &str, &str); 8] = [
    ("hermes", "Hermes", "push", "#5b9dff"),
    ("codex", "ChatGPT Codex", "log", "#10a37f"),
    ("claude-code", "Claude Code", "log", "#d97757"),
    ("openclaw", "OpenClaw", "push", "#8b5cf6"),
    ("mimocode", "MiMoCode", "cli", "#f59e0b"),
    ("workbuddy", "WorkBuddy", "push", "#0ea5e9"),
    ("dsh", "DeepSeek Harness", "native", "#4d6bfe"),
    ("generic", "其它 Agent", "push", "#94a3b8"),
];

fn agent_meta(id: &str) -> (&str, &str, &str) {
    AGENTS
        .iter()
        .find(|(agent, _, _, _)| *agent == id)
        .map(|(_, name, kind, accent)| (*name, *kind, *accent))
        .unwrap_or((if id == "generic" { "其它 Agent" } else { id }, "push", "#94a3b8"))
}

fn refresh_channels(rt: &Runtime, force: bool) {
    let now = now_ms();
    let port = actual_port(rt);
    for (id, name, kind, accent) in AGENTS {
        if !force
            && rt.lock()
                .channels
                .get(id)
                .is_some_and(|channel| now.saturating_sub(channel.checked_at) < PROBE_TTL_MS)
        {
            continue;
        }
        let probe = probe_channel(id, port);
        let disabled = rt.lock().disabled_agents.contains(id);
        rt.lock().channels.insert(
            id.to_string(),
            Channel {
                id: id.into(),
                name: name.into(),
                kind: kind.into(),
                accent: accent.into(),
                available: probe.available,
                wired: probe.wired,
                detail: probe.detail,
                paths: probe.paths,
                checked_at: now,
                disabled,
                sessions: 0,
            },
        );
    }
}

fn probe_channel(id: &str, port: u16) -> Probe {
    let home = home_dir();
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    match id {
        "hermes" => {
            let config = local.join("hermes").join("config.yaml");
            if !config.is_file() {
                return Probe {
                    detail: "没找到 Hermes 配置（%LOCALAPPDATA%\\hermes\\config.yaml）".into(),
                    ..Probe::default()
                };
            }
            let text = std::fs::File::open(&config)
                .ok()
                .map(|file| {
                    let mut bytes = Vec::new();
                    let _ = file.take(400_000).read_to_end(&mut bytes);
                    String::from_utf8_lossy(&bytes).into_owned()
                })
                .unwrap_or_default();
            let wired = text
                .find("hooks")
                .is_some_and(|pos| text[pos..].chars().take(2000).collect::<String>().contains("outbound"))
                && text.contains(&port.to_string());
            Probe {
                available: true,
                wired,
                detail: if wired {
                    "hooks.outbound 已指向本机端口".into()
                } else {
                    "未接 hooks.outbound（见 tools/dock-install-hermes-hooks.js）".into()
                },
                paths: vec![config],
            }
        }
        "codex" => directory_probe(
            home.join(".codex").join("sessions"),
            "按会话日志跟随",
            "没有 %USERPROFILE%\\.codex\\sessions",
        ),
        "claude-code" => directory_probe(
            home.join(".claude").join("projects"),
            "按会话日志跟随",
            "没有 %USERPROFILE%\\.claude\\projects",
        ),
        "openclaw" => {
            let dir = std::env::var_os("OPENCLAW_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".openclaw"));
            directory_probe(
                dir,
                "目录已找到；状态需从它的网关/插件推送（POST /state）",
                "没找到 OpenClaw 安装（可用 POST /state 推送）",
            )
        }
        "mimocode" => {
            let candidates = [home.join(".mimocode").join("bin").join("mimo.exe"), home.join(".mimocode").join("bin").join("mimo")];
            if let Some(path) = candidates.iter().find(|path| path.is_file()) {
                Probe {
                    available: true,
                    detail: "已找到 mimo 可执行文件；状态需由插件推送".into(),
                    paths: vec![path.clone()],
                    ..Probe::default()
                }
            } else {
                Probe { detail: "没找到 ~/.mimocode/bin/mimo（可用 POST /state 推送）".into(), ..Probe::default() }
            }
        }
        "workbuddy" => {
            let candidates = [
                appdata.join("WorkBuddy"),
                local.join("Programs").join("WorkBuddy"),
                home.join(".workbuddy"),
            ];
            if let Some(path) = candidates.iter().find(|path| path.is_dir()) {
                Probe {
                    available: true,
                    detail: "目录已找到；状态需由它的 hook 推送".into(),
                    paths: vec![path.clone()],
                    ..Probe::default()
                }
            } else {
                Probe { detail: "没找到 WorkBuddy（可用 POST /state 推送）".into(), ..Probe::default() }
            }
        }
        "dsh" => {
            let mut candidates = Vec::new();
            for key in ["DSH_HARNESS_REPO", "DSH_HARNESS_SRC"] {
                if let Some(path) = std::env::var_os(key) {
                    candidates.push(PathBuf::from(path));
                }
            }
            candidates.push(home.join("Documents").join("deepseek-harness"));
            candidates.push(home.join("deepseek-harness"));
            if let Some(path) = candidates.iter().find(|path| path.is_dir() && path.join("packages").is_dir()) {
                Probe {
                    available: true,
                    detail: "桌宠内置通道（聊天时实时上报）".into(),
                    paths: vec![path.clone()],
                    ..Probe::default()
                }
            } else {
                Probe { detail: "没找到 harness 仓库（托盘设置里指定后可用）".into(), ..Probe::default() }
            }
        }
        "generic" => Probe {
            available: true,
            detail: "通用推送通道：任何程序 POST /state 即可".into(),
            ..Probe::default()
        },
        _ => Probe { detail: "未探测".into(), ..Probe::default() },
    }
}

fn directory_probe(path: PathBuf, found: &str, missing: &str) -> Probe {
    if path.is_dir() {
        Probe { available: true, detail: found.into(), paths: vec![path], ..Probe::default() }
    } else {
        Probe { detail: missing.into(), ..Probe::default() }
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/* ========================= Selection / snapshot ========================= */

fn state_rank(state: &str) -> i32 {
    match state {
        "waiting_user" => 6,
        "error" => 5,
        "working" => 4,
        "speaking" => 3,
        "done" => 2,
        "idle" => 1,
        "sleeping" => 0,
        _ => 0,
    }
}

fn ordered_sessions(inner: &Inner) -> Vec<Session> {
    let mut list = inner.sessions.values().cloned().collect::<Vec<_>>();
    list.sort_by(|a, b| {
        state_rank(&b.state)
            .cmp(&state_rank(&a.state))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    list
}

fn snapshot(rt: &Runtime) -> Value {
    let inner = rt.lock();
    let list = ordered_sessions(&inner);
    let mut counts = HashMap::<String, u64>::new();
    for session in &list {
        *counts.entry(session.agent.clone()).or_default() += 1;
    }
    let mut channels = inner.channels.values().cloned().collect::<Vec<_>>();
    for channel in &mut channels {
        channel.disabled = inner.disabled_agents.contains(&channel.id);
        channel.sessions = counts.get(&channel.id).copied().unwrap_or(0);
    }
    channels.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| b.available.cmp(&a.available))
            .then_with(|| a.name.cmp(&b.name))
    });
    let dominant = list.first();
    let running = inner.server.is_some();
    let port = inner.server.as_ref().map(|server| server.port).unwrap_or(inner.cfg.port);
    let mut value = json!({
        "ok": running,
        "app": "catwhale-agent-dock",
        "port": port,
        "host": HOST,
        "updatedAt": now_ms(),
        "selected": inner.selected,
        "pinned": inner.pinned,
        "state": dominant.map(|session| session.state.as_str()).unwrap_or("idle"),
        "dominant": dominant.map(|session| session.key.as_str()),
        "sessions": list,
        "channels": channels,
        "counters": inner.counters,
        "config": {
            "keepDoneSec": inner.cfg.keep_done_sec,
            "logActiveSec": LOG_ACTIVE_MS / 1000,
            "enabled": inner.cfg.enabled,
            "port": inner.cfg.port,
        },
    });
    if !inner.error.is_empty() {
        value["error"] = Value::String(inner.error.clone());
    }
    value
}

fn emit_now(rt: &Arc<Runtime>) {
    {
        let mut inner = rt.lock();
        inner.emit_queued = false;
        inner.last_emit = now_ms();
    }
    let _ = rt.app.emit("dock:update", snapshot(rt));
}

fn queue_emit(rt: &Arc<Runtime>, force: bool) {
    if force {
        return emit_now(rt);
    }
    {
        let mut inner = rt.lock();
        if inner.emit_queued {
            return;
        }
        inner.emit_queued = true;
    }
    let worker = rt.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        let skip = {
            let inner = worker.lock();
            now_ms().saturating_sub(inner.last_emit) < 100
        };
        if !skip {
            emit_now(&worker);
        } else {
            worker.lock().emit_queued = false;
        }
    });
}

#[tauri::command]
pub fn dock_get(app: AppHandle) -> Value {
    let rt = runtime(&app);
    ensure_running(&rt);
    if rt.lock().channels.is_empty() {
        refresh_channels(&rt, true);
    }
    snapshot(&rt)
}

/// 只读快照（不拉起服务、不探测通道）：给灵动岛的 Agent 态用，500ms 一次不能有副作用。
pub fn snapshot_quick(app: &AppHandle) -> Value {
    let rt = runtime(app);
    snapshot(&rt)
}

#[tauri::command]
pub fn dock_select(app: AppHandle, id: Option<String>) -> Option<String> {
    let rt = runtime(&app);
    ensure_running(&rt);
    let id = id.filter(|value| !value.is_empty()).map(|value| normalize_agent_id(&value));
    let selected = {
        let mut inner = rt.lock();
        inner.selected = match id {
            Some(id) if !id.is_empty() && inner.selected.as_deref() != Some(id.as_str()) => Some(id),
            _ => None,
        };
        inner.selected.clone()
    };
    emit_now(&rt);
    selected
}

#[tauri::command]
pub fn dock_cycle(app: AppHandle, dir: Option<i32>) -> Option<String> {
    let rt = runtime(&app);
    ensure_running(&rt);
    let key = {
        let mut inner = rt.lock();
        let list = ordered_sessions(&inner);
        if list.is_empty() {
            return None;
        }
        let current = list.iter().position(|session| Some(&session.key) == inner.pinned.as_ref()).unwrap_or(0);
        let next = if dir.unwrap_or(1) < 0 {
            (current + list.len() - 1) % list.len()
        } else {
            (current + 1) % list.len()
        };
        let session = &list[next];
        inner.pinned = Some(session.key.clone());
        inner.selected = Some(session.agent.clone());
        session.key.clone()
    };
    emit_now(&rt);
    Some(key)
}

#[tauri::command]
pub fn dock_pin(app: AppHandle, key: Option<String>) -> Option<String> {
    let rt = runtime(&app);
    ensure_running(&rt);
    let key = key.unwrap_or_default();
    let pinned = {
        let mut inner = rt.lock();
        inner.pinned = if inner.pinned.as_deref() == Some(key.as_str()) { None } else { Some(key) };
        if let Some(pinned) = inner.pinned.clone() {
            if let Some(session) = inner.sessions.get(&pinned) {
                inner.selected = Some(session.agent.clone());
            }
        }
        inner.pinned.clone()
    };
    emit_now(&rt);
    pinned
}

#[tauri::command]
pub fn dock_clear_ended(app: AppHandle) -> u64 {
    let rt = runtime(&app);
    ensure_running(&rt);
    let removed = {
        let mut inner = rt.lock();
        let before = inner.sessions.len();
        inner.sessions.retain(|_, session| !matches!(session.state.as_str(), "done" | "error" | "sleeping"));
        before - inner.sessions.len()
    } as u64;
    emit_now(&rt);
    removed
}

#[tauri::command]
pub fn dock_probe(app: AppHandle) -> Value {
    let rt = runtime(&app);
    ensure_running(&rt);
    refresh_channels(&rt, true);
    emit_now(&rt);
    snapshot(&rt)
}

#[tauri::command]
pub fn dock_config(app: AppHandle, patch: Option<Value>) -> Value {
    let rt = runtime(&app);
    let _operation = rt.operation_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = rt.lock().cfg.clone();
    let mut next = before.clone();
    if let Some(object) = patch.as_ref().and_then(Value::as_object) {
        if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
            next.enabled = enabled;
        }
        if let Some(value) = object.get("port") {
            next.port = value
                .as_u64()
                .filter(|port| (1024..=65535).contains(port))
                .map(|port| port as u16)
                .unwrap_or(DEFAULT_PORT);
        }
        if let Some(value) = object.get("keepDoneSec") {
            next.keep_done_sec = value
                .as_u64()
                .filter(|seconds| (5..=3600).contains(seconds))
                .unwrap_or(60);
        }
    }
    next = next.normalized();
    save_config(&rt.config_path, &next);
    let restart = next.port != before.port || next.enabled != before.enabled;
    rt.lock().cfg = next.clone();
    if restart {
        stop_server(&rt);
    }
    if next.enabled {
        if restart || rt.lock().server.is_none() {
            start_server(&rt);
        }
    } else {
        rt.lock().error = "看板已关闭（dock.json 里 enabled=false）".into();
    }
    drop(_operation);
    emit_now(&rt);
    json!({ "ok": true, "config": next, "snapshot": snapshot(&rt) })
}

/* ============================ Normalization ============================ */

fn text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn first_text(object: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter().find_map(|key| {
        let value = text_value(object.get(*key));
        if value.is_empty() { None } else { Some(value) }
    }).unwrap_or_default()
}

fn clamp_text(value: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = normalized.chars().count();
    if count <= limit {
        normalized
    } else if limit == 1 {
        "…".into()
    } else {
        format!("{}…", normalized.chars().take(limit - 1).collect::<String>())
    }
}

fn last_chars(value: &str, count: usize) -> String {
    let length = value.chars().count();
    value.chars().skip(length.saturating_sub(count)).collect()
}

fn normalize_state(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase().replace([' ', '-'], "_");
    if normalized.is_empty() {
        return None;
    }
    if matches!(normalized.as_str(), "idle" | "working" | "speaking" | "waiting_user" | "done" | "error" | "sleeping") {
        return Some(normalized);
    }
    let alias = match normalized.as_str() {
        "attention" => "done",
        "juggling" | "sweeping" | "carrying" | "tool_running" | "thinking" | "busy" => "working",
        "notification" => "waiting_user",
        "typing" | "talking" => "speaking",
        "finished" => "done",
        "failed" => "error",
        "ready" => "idle",
        "offline" => "sleeping",
        _ => return None,
    };
    Some(alias.into())
}

fn state_from_event(event: &str) -> &'static str {
    match event {
        "pre_llm_call" | "post_llm_call" | "pre_api_request" | "post_api_request"
        | "on_stream_end" | "pre_tool_call" | "post_tool_call" | "post_approval_response"
        | "on_human_input_resolved" | "subagent_start" | "subagent_stop" | "UserPromptSubmit"
        | "PreToolUse" | "PostToolUse" | "SubagentStart" | "SubagentStop" | "PreCompact"
        | "PostCompact" | "userPromptSubmitted" | "preToolUse" | "postToolUse"
        | "subagentStart" | "subagentStop" | "preCompact" => "working",
        "api_request_error" | "PostToolUseFailure" | "StopFailure" | "errorOccurred" => "error",
        "on_stream_start" | "on_stream_delta" | "AssistantMessage" | "AssistantOutput" => "speaking",
        "pre_approval_request" | "on_human_input_request" | "PermissionRequest" | "Notification" | "Elicitation" => "waiting_user",
        "on_session_start" | "on_session_reset" | "SessionStart" | "sessionStart" => "idle",
        "on_session_end" | "on_session_finalize" | "agent_loop_stopped" | "Stop" | "agentStop" => "done",
        "SessionEnd" | "sessionEnd" => "sleeping",
        _ => "",
    }
}

fn normalize_agent_id(value: &str) -> String {
    let id = value.trim().to_lowercase();
    if id.is_empty() {
        return String::new();
    }
    if AGENTS.iter().any(|(agent, _, _, _)| *agent == id) {
        return id;
    }
    match id.as_str() {
        "claude" | "claudecode" | "claude_code" => return "claude-code".into(),
        "chatgpt" | "openai-codex" | "codex-cli" => return "codex".into(),
        "clawd" | "open-claw" => return "openclaw".into(),
        "mimo" | "mimo-code" => return "mimocode".into(),
        "deepseek-harness" | "deepseekharness" | "harness" => return "dsh".into(),
        _ => {}
    }
    if id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')) {
        id
    } else {
        "generic".into()
    }
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
