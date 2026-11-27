//! 在线升级（整包替换）
//!
//! 流程：检查 → 下载（流式 + sha256）→ 校验 → 解包入 staging → 生成 apply.cmd →
//! spawn 外部 cmd → 应用退出 → cmd 备份/换目录/重启 → 新实例读 last-result.json。
//!
//! 硬约定（与 `在线升级-共享规格.md` 逐条对齐）：
//! - 磁盘布局固定在 `%LOCALAPPDATA%\catwhale-update\`；**只认环境变量 LOCALAPPDATA**，
//!   不走 KnownFolder（那玩意读注册表、不认环境变量，隔离验收会写进用户真实目录）。
//! - 资产按名字正则选，绝不按 assets 顺序取（旧实现取第一个 zip，会把对端 238 MB 包装进来）。
//! - 所有 `Command::new` 都带 `CREATE_NO_WINDOW`，否则每次升级闪黑框。
//! - 升级脚本的子进程 cwd 不能落在安装目录里（否则 `move 安装目录 备份` 永远失败）。

use regex::Regex;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::{StatusCode, Url};
use semver::Version;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/* ============================ 常量与文案 ============================ */

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_RELEASE_API: &str =
    "https://api.github.com/repos/timevisitor/catwhale-pet/releases/latest";
const GITHUB_RELEASES_PAGE: &str = "https://github.com/timevisitor/catwhale-pet/releases";

/// 本端主 exe 文件名（也用来定位包根）。
const APP_EXE: &str = "catwhale-poc.exe";
/// 本端必需的同目录运行库。
const AV_DLL: &str = "WebView2Loader.dll";
const SUMS_NAME: &str = "SHA256SUMS.txt";

/// §2.1 本端（Tauri）资产匹配正则，`.search` 语义、忽略大小写。
const OWN_ASSET_RE: &str = r"(?i)catwhale-(tauri|poc)[-_]v?[0-9]";
/// §2.1 兜底：把现有 release（catwhale-poc-*）也接住。
const OWN_ASSET_FALLBACK_RE: &str = r"(?i)^catwhale-poc-";

pub const EVENT_PROGRESS: &str = "update:progress";
pub const EVENT_RESULT: &str = "update:result";

const UPDATE_DIR_NAME: &str = "catwhale-update";
const STALL_MS: u64 = 200;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// §7 必须拒绝自动升级的 8 类情形（外加两条下载地址安全闸）。
pub const R_DEV_MODE: &str = "当前是开发模式运行（程序目录里没有 frontend 资源），不支持自动升级";
pub const R_INSTALL_READONLY: &str = "程序目录不可写，无法自动升级";
pub const R_PARENT_READONLY: &str = "程序目录的上级目录不可写（换目录需要它），无法自动升级";
pub const R_NO_SUMS: &str = "该版本没有校验清单";
pub const R_NO_ASSET: &str = "该版本没有适用于本端的升级包";
pub const R_MULTI_ASSET: &str = "该版本有多个升级包，无法确定";
pub const R_NO_SHA_ENTRY: &str = "校验清单里没有这个升级包";
pub const R_PLATFORM: &str = "当前平台不是 win-x64，不支持自动升级";
pub const R_CROSS_VOLUME: &str = "升级包目录与程序目录不在同一个盘";
pub const R_INSECURE_URL: &str = "升级包下载地址不是 https，已拒绝";

/* ============================ 进度状态 ============================ */

#[derive(Clone, Debug)]
pub struct UpdateState {
    pub phase: String,
    pub percent: f64,
    pub received: u64,
    pub total: u64,
    pub bytes_per_sec: f64,
    pub error: String,
    pub target_version: String,
    pub ready_to_restart: bool,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            percent: 0.0,
            received: 0,
            total: 0,
            bytes_per_sec: 0.0,
            error: String::new(),
            target_version: String::new(),
            ready_to_restart: false,
        }
    }
}

fn state_slot() -> &'static Mutex<UpdateState> {
    static S: OnceLock<Mutex<UpdateState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(UpdateState::default()))
}

fn lock_state() -> std::sync::MutexGuard<'static, UpdateState> {
    state_slot().lock().unwrap_or_else(|p| p.into_inner())
}

fn snapshot() -> UpdateState {
    lock_state().clone()
}

fn cancel_flag() -> &'static AtomicBool {
    static C: OnceLock<AtomicBool> = OnceLock::new();
    C.get_or_init(|| AtomicBool::new(false))
}

fn cancelled() -> bool {
    cancel_flag().load(Ordering::SeqCst)
}

/// 最近一次 `update_check` 的成功结果（旧 UI 的 `update_status().latest` 在用）。
fn latest_cache() -> &'static RwLock<Option<Value>> {
    static L: OnceLock<RwLock<Option<Value>>> = OnceLock::new();
    L.get_or_init(|| RwLock::new(None))
}

/// 最近一次 check 算出的可下载计划。
fn plan_slot() -> &'static Mutex<Option<Plan>> {
    static P: OnceLock<Mutex<Option<Plan>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

/// 已解包好的 staging 目录（包根即 staging 自身）。
fn staged_slot() -> &'static Mutex<Option<PathBuf>> {
    static T: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

fn result_cache() -> &'static Mutex<Option<Value>> {
    static R: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/* ============================ 路径 ============================ */

/// `%LOCALAPPDATA%\catwhale-update\`。
///
/// **必须**先认环境变量：Windows KnownFolder(FOLDERID_LocalAppData) 走注册表，
/// 不认 `LOCALAPPDATA`，隔离验收（harness 就是改这个变量做的）会写进用户真实目录。
fn update_dir() -> PathBuf {
    static D: OnceLock<PathBuf> = OnceLock::new();
    D.get_or_init(|| {
        if let Some(v) = std::env::var_os("LOCALAPPDATA") {
            if !v.is_empty() {
                return PathBuf::from(v).join(UPDATE_DIR_NAME);
            }
        }
        if let Some(v) = std::env::var_os("USERPROFILE") {
            if !v.is_empty() {
                return PathBuf::from(v)
                    .join("AppData")
                    .join("Local")
                    .join(UPDATE_DIR_NAME);
            }
        }
        std::env::temp_dir().join(UPDATE_DIR_NAME)
    })
    .clone()
}

fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn append_log(line: &str) {
    let path = crate::chat::config_dir().join("startup.log");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} [update] {}", now_secs(), line);
    }
}

/* ============================ 版本号 ============================ */

fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim();
    let text = text
        .strip_prefix('v')
        .or_else(|| text.strip_prefix('V'))
        .unwrap_or(text);

    // 接受常见的 1 / 1.2 标签，同时保留 semver 的预发布与 build 后缀。
    let suffix_at = text.find(['-', '+']).unwrap_or(text.len());
    let (core, suffix) = text.split_at(suffix_at);
    let mut parts = core.split('.').collect::<Vec<_>>();
    if parts.is_empty()
        || parts.len() > 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    while parts.len() < 3 {
        parts.push("0");
    }
    Version::parse(&format!("{}{}", parts.join("."), suffix)).ok()
}

/* ============================ 拒绝情形（§7） ============================ */

/// §7-7 平台闸。参数化便于单测覆盖非 win-x64 分支。
pub fn platform_reason(os: &str, arch: &str) -> Option<&'static str> {
    if os == "windows" && arch == "x86_64" {
        None
    } else {
        Some(R_PLATFORM)
    }
}

/// §7-1 开发模式：exe 所在目录没有 `frontend`，且 exe 名不是预期名。
pub fn dev_mode_reason(exe_dir: &Path, exe_name: &str) -> Option<&'static str> {
    if exe_dir.join("frontend").is_dir() || exe_name.eq_ignore_ascii_case(APP_EXE) {
        None
    } else {
        Some(R_DEV_MODE)
    }
}

/// 目录是否可写（建一个临时文件再删）。
pub fn dir_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".update-probe-{}-{}", std::process::id(), now_secs()));
    match File::create(&probe) {
        Ok(mut f) => {
            let _ = f.write_all(b"ok");
            let _ = f.sync_all();
            drop(f);
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn writable_reason(dir: &Path, is_parent: bool) -> Option<&'static str> {
    if dir_writable(dir) {
        None
    } else if is_parent {
        Some(R_PARENT_READONLY)
    } else {
        Some(R_INSTALL_READONLY)
    }
}

/// 卷标识：`H:\a\b` → `h`；UNC/相对路径用前缀字符串兜底。
fn volume_of(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return s[..1].to_ascii_lowercase();
    }
    s.split('\\').next().unwrap_or("").to_ascii_lowercase()
}

pub fn cross_volume_reason(a: &Path, b: &Path) -> Option<&'static str> {
    if volume_of(a) == volume_of(b) {
        None
    } else {
        Some(R_CROSS_VOLUME)
    }
}

/* ============================ 资产选择（§2.1） ============================ */

fn own_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(OWN_ASSET_RE).expect("内置资产正则必须合法"))
}

fn fallback_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(OWN_ASSET_FALLBACK_RE).expect("兜底资产正则必须合法"))
}

fn asset_name(a: &Value) -> &str {
    a.get("name").and_then(Value::as_str).unwrap_or("")
}

fn asset_url_of(a: &Value) -> String {
    a.get("browser_download_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn asset_size_of(a: &Value) -> u64 {
    a.get("size").and_then(Value::as_u64).unwrap_or(0)
}

fn is_zip(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".zip")
}

fn pick_one(mut hits: Vec<Value>) -> Result<Value, String> {
    match hits.len() {
        0 => Err(R_NO_ASSET.to_string()),
        1 => Ok(hits.remove(0)),
        _ => Err(R_MULTI_ASSET.to_string()),
    }
}

/// 按名字正则挑本端升级包。`debug` 为 `CATWHALE_UPDATE_ASSET`（正则源），存在时**直接覆盖**。
pub fn select_asset(assets: &[Value], debug: Option<&str>) -> Result<Value, String> {
    if let Some(src) = debug {
        let re = Regex::new(src).map_err(|e| format!("CATWHALE_UPDATE_ASSET 不是合法正则：{e}"))?;
        let hits: Vec<Value> = assets
            .iter()
            .filter(|a| re.is_match(asset_name(a)))
            .cloned()
            .collect();
        return pick_one(hits);
    }
    let mut hits: Vec<Value> = assets
        .iter()
        .filter(|a| is_zip(asset_name(a)) && own_re().is_match(asset_name(a)))
        .cloned()
        .collect();
    if hits.is_empty() {
        hits = assets
            .iter()
            .filter(|a| is_zip(asset_name(a)) && fallback_re().is_match(asset_name(a)))
            .cloned()
            .collect();
    }
    pick_one(hits)
}

fn find_sums_asset(assets: &[Value]) -> Option<Value> {
    assets
        .iter()
        .find(|a| asset_name(a).eq_ignore_ascii_case(SUMS_NAME))
        .cloned()
}

/// 解析 GNU `sha256sum` 清单：`<64hex>  <name>` 或 `<hex> *<name>`。
pub fn parse_sums(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.splitn(2, char::is_whitespace);
        let hash = it.next().unwrap_or("").trim().to_ascii_lowercase();
        let rest = it.next().unwrap_or("").trim_start();
        let name = rest.trim_start_matches('*').trim();
        if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && !name.is_empty() {
            out.push((hash, name.to_string()));
        }
    }
    out
}

pub fn lookup_sums(list: &[(String, String)], name: &str) -> Option<String> {
    list.iter()
        .find(|(_, n)| n == name)
        .or_else(|| list.iter().find(|(_, n)| n.eq_ignore_ascii_case(name)))
        .map(|(h, _)| h.clone())
}

/* ============================ URL 闸 ============================ */

pub fn url_allowed(url: &Url, allow_http: bool) -> bool {
    match url.scheme() {
        "https" => url.host_str().is_some(),
        // 本地验收：只有设置 CATWHALE_UPDATE_API（调试覆盖）时才允许环回地址的 http
        "http" => {
            allow_http
                && matches!(
                    url.host_str(),
                    Some("127.0.0.1") | Some("localhost") | Some("::1")
                )
        }
        _ => false,
    }
}

fn open_validated_url(url: &Url) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // 不使用 cmd /C start，避免 URL 中的 shell 元字符被二次解释。
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url.as_str()]);
        command.creation_flags(CREATE_NO_WINDOW);
        command.spawn().map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url.as_str()).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url.as_str())
            .spawn()
            .map(|_| ())
    }
}

/* ============================ 检查 ============================ */

#[derive(Clone, Debug)]
struct Plan {
    version: String,
    asset_name: String,
    asset_url: String,
    asset_size: u64,
    sha256: String,
    release_url: String,
}

fn update_error(error: impl Into<String>) -> Value {
    json!({
        "ok": false,
        "error": error.into(),
        "currentVersion": CURRENT_VERSION
    })
}

fn http_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// 环境变量 `CATWHALE_UPDATE_API` 存在 → 返回 (url, 允许明文 http)。
fn api_endpoint() -> (String, bool) {
    match std::env::var("CATWHALE_UPDATE_API") {
        Ok(v) if !v.trim().is_empty() => (v.trim().to_string(), true),
        _ => (DEFAULT_RELEASE_API.to_string(), false),
    }
}

fn asset_pattern_override() -> Option<String> {
    std::env::var("CATWHALE_UPDATE_ASSET")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 拉取 release + 判定可升级性。返回 (§3 响应, 可下载计划)。
fn run_check() -> (Value, Option<Plan>) {
    let (api, allow_http) = api_endpoint();
    let url = match Url::parse(&api) {
        Ok(u) => u,
        Err(e) => return (update_error(format!("升级接口地址非法：{e}")), None),
    };
    if !url_allowed(&url, allow_http) {
        return (update_error("升级接口地址不是 https，已拒绝"), None);
    }
    let client = match http_client(Duration::from_secs(12)) {
        Ok(c) => c,
        Err(e) => return (update_error(e), None),
    };
    let response = match client
        .get(url)
        .header(USER_AGENT, format!("catwhale-pet/{CURRENT_VERSION}"))
        .header(ACCEPT, "application/vnd.github+json")
        .send()
    {
        Ok(r) => r,
        Err(e) => return (update_error(e.to_string()), None),
    };

    if response.status() == StatusCode::NOT_FOUND {
        return (
            json!({
                "ok": true,
                "hasUpdate": false,
                "noRelease": true,
                "currentVersion": CURRENT_VERSION,
                "latestVersion": Value::Null,
                "canAutoUpdate": false,
                "reason": "",
                "releaseUrl": GITHUB_RELEASES_PAGE
            }),
            None,
        );
    }
    if !response.status().is_success() {
        // 403/429 基本都是 GitHub 未认证接口按出口 IP 限流（60 次/小时）。
        // 共用代理/VPN 时容易被同 IP 的其他人用光；直说人话，别丢一个裸 HTTP 码。
        let code = response.status().as_u16();
        if code == 403 || code == 429 {
            return (
                json!({
                    "ok": false,
                    "hasUpdate": false,
                    "currentVersion": CURRENT_VERSION,
                    "latestVersion": Value::Null,
                    "canAutoUpdate": false,
                    "rateLimited": true,
                    "reason": "检查更新被 GitHub 限流（HTTP 403/429）：未登录接口按出口 IP 每小时只给 60 次，同一条代理/VPN 上的其他人也会占用。等一会儿再试，或点「手动下载」直接拿整包。",
                    "releaseUrl": GITHUB_RELEASES_PAGE
                }),
                None,
            );
        }
        return (
            update_error(format!("升级接口 HTTP {code}")),
            None,
        );
    }

    let release: Value = match response.json() {
        Ok(v) => v,
        Err(e) => return (update_error(e.to_string()), None),
    };
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
        .or_else(|| release.get("name").and_then(Value::as_str))
        .unwrap_or("");
    let latest_version = tag
        .trim()
        .strip_prefix('v')
        .or_else(|| tag.trim().strip_prefix('V'))
        .unwrap_or(tag.trim())
        .to_string();
    let (Some(current), Some(latest)) = (
        parse_version(CURRENT_VERSION),
        parse_version(&latest_version),
    ) else {
        return (
            update_error(format!(
                "无法比较版本: {CURRENT_VERSION} / {latest_version}"
            )),
            None,
        );
    };
    let has_update = latest > current;

    let release_url = release
        .get("html_url")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .unwrap_or(GITHUB_RELEASES_PAGE)
        .to_string();
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let notes = release
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let assets: Vec<Value> = release
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut out = json!({
        "ok": true,
        "hasUpdate": has_update,
        "noRelease": false,
        "currentVersion": CURRENT_VERSION,
        "latestVersion": latest_version,
        "notes": notes,
        "publishedAt": published_at,
        "releaseUrl": release_url,
        "assetName": "",
        "assetUrl": "",
        "assetSize": 0,
        "sumsUrl": "",
        "expectedSha256": "",
        "canAutoUpdate": false,
        "reason": "",
        // 兼容旧 UI：旧字段继续返回
        "downloadUrl": release_url,
    });

    if !has_update {
        return (out, None);
    }

    // ---- 先算所有「不需要第二次网络请求」的闸，按 §7 顺序 ----
    let mut reason: Option<String> = None;
    if reason.is_none() {
        reason = platform_reason(std::env::consts::OS, std::env::consts::ARCH).map(str::to_string);
    }
    let install = install_dir();
    if reason.is_none() {
        let exe_name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_default();
        reason = dev_mode_reason(&install, &exe_name).map(str::to_string);
    }
    if reason.is_none() {
        reason = writable_reason(&install, false).map(str::to_string);
    }
    if reason.is_none() {
        if let Some(parent) = install.parent() {
            reason = writable_reason(parent, true).map(str::to_string);
        }
    }
    if reason.is_none() {
        reason = cross_volume_reason(&update_dir(), &install).map(str::to_string);
    }

    // ---- 资产选择：必须在「校验清单」之前（否则「只有对端包」会被误报成缺清单）----
    let debug_asset = asset_pattern_override();
    let mut asset: Option<Value> = None;
    if reason.is_none() {
        match select_asset(&assets, debug_asset.as_deref()) {
            Ok(a) => asset = Some(a),
            Err(e) => reason = Some(e),
        }
    }
    let mut expected = String::new();
    let mut sums_url = String::new();
    if reason.is_none() {
        match find_sums_asset(&assets) {
            None => reason = Some(R_NO_SUMS.to_string()),
            Some(sums_asset) => {
                let u = asset_url_of(&sums_asset);
                sums_url = u.clone();
                match Url::parse(&u) {
                    Err(_) => reason = Some(R_NO_SUMS.to_string()),
                    Ok(target) => {
                        if !url_allowed(&target, allow_http) {
                            reason = Some(R_INSECURE_URL.to_string());
                        } else {
                            match http_client(Duration::from_secs(12)) {
                                Err(e) => reason = Some(format!("无法创建 HTTP 客户端：{e}")),
                                Ok(client) => match client
                                    .get(target)
                                    .header(USER_AGENT, format!("catwhale-pet/{CURRENT_VERSION}"))
                                    .send()
                                    .and_then(|r| r.text())
                                {
                                    Err(e) => reason = Some(format!("读取校验清单失败：{e}")),
                                    Ok(text) => {
                                        let list = parse_sums(&text);
                                        let name = asset.as_ref().map(asset_name).unwrap_or("");
                                        match lookup_sums(&list, name) {
                                            Some(h) => expected = h,
                                            None => reason = Some(R_NO_SHA_ENTRY.to_string()),
                                        }
                                    }
                                },
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(a) = asset.as_ref() {
        let u = asset_url_of(a);
        out["assetName"] = json!(asset_name(a));
        out["assetUrl"] = json!(u);
        out["assetSize"] = json!(asset_size_of(a));
        out["downloadUrl"] = json!(if u.is_empty() {
            release_url.clone()
        } else {
            u.clone()
        });
        if reason.is_none() {
            match Url::parse(&u) {
                Ok(p) if url_allowed(&p, allow_http) => {}
                Ok(_) => reason = Some(R_INSECURE_URL.to_string()),
                Err(_) => reason = Some("升级包下载地址非法".to_string()),
            }
        }
    }
    out["sumsUrl"] = json!(sums_url);
    out["expectedSha256"] = json!(expected);

    match reason {
        Some(r) => {
            out["canAutoUpdate"] = json!(false);
            out["reason"] = json!(r);
            (out, None)
        }
        None => {
            let a = match asset {
                Some(a) => a,
                None => return (out, None),
            };
            out["canAutoUpdate"] = json!(true);
            let plan = Plan {
                version: latest_version.clone(),
                asset_name: asset_name(&a).to_string(),
                asset_url: asset_url_of(&a),
                asset_size: asset_size_of(&a),
                sha256: expected,
                release_url: release_url.clone(),
            };
            (out, Some(plan))
        }
    }
}

#[tauri::command]
pub fn update_check() -> Value {
    let (out, plan) = run_check();
    if out.get("ok").and_then(Value::as_bool) == Some(true)
        && out.get("hasUpdate").and_then(Value::as_bool) == Some(true)
    {
        *plan_slot().lock().unwrap_or_else(|e| e.into_inner()) = plan;
        *latest_cache().write().unwrap_or_else(|e| e.into_inner()) = Some(out.clone());
    }
    out
}

#[tauri::command]
pub fn update_status() -> Value {
    let latest = latest_cache()
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    json!({
        "ok": true,
        "currentVersion": CURRENT_VERSION,
        "latest": latest,
        "state": state_json(&snapshot())
    })
}

#[tauri::command]
pub fn update_open_url(url: String) -> Value {
    let cached_url = latest_cache()
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|l| l.get("releaseUrl"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let target = if url.trim().is_empty() {
        cached_url.as_deref().unwrap_or(GITHUB_RELEASES_PAGE)
    } else {
        url.trim()
    };
    let parsed = match Url::parse(target) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => u,
        _ => return json!({ "ok": false, "error": "只允许有效的 http/https URL" }),
    };
    match open_validated_url(&parsed) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/* ============================ 状态快照 ============================ */

fn state_json(s: &UpdateState) -> Value {
    let last = result_cache().lock().unwrap_or_else(|p| p.into_inner()).clone();
    json!({
        "phase": s.phase.clone(),
        "percent": s.percent,
        "received": s.received,
        "total": s.total,
        "bytesPerSec": s.bytes_per_sec,
        "error": s.error.clone(),
        "targetVersion": s.target_version.clone(),
        "readyToRestart": s.ready_to_restart,
        "currentVersion": CURRENT_VERSION,
        "lastResult": last,
    })
}

fn persist_state(s: &UpdateState) {
    let dir = update_dir();
    let _ = fs::create_dir_all(&dir);
    let text = serde_json::to_string_pretty(&state_json(s)).unwrap_or_else(|_| "{}".to_string());
    let _ = fs::write(dir.join("state.json"), text);
}

/// 更新状态 + 落 state.json + 推 `update:progress`。
fn publish(app: &AppHandle, s: UpdateState) {
    {
        let mut g = lock_state();
        *g = s.clone();
    }
    persist_state(&s);
    let _ = app.emit(EVENT_PROGRESS, state_json(&s));
}

/// 更新状态 + 落 state.json（没有 AppHandle 可推事件时用）。
fn publish_plain(s: UpdateState) {
    {
        let mut g = lock_state();
        *g = s.clone();
    }
    persist_state(&s);
}

#[tauri::command]
pub fn update_state() -> Value {
    state_json(&snapshot())
}

/* ============================ 下载 / 解包 ============================ */

fn fail(app: &AppHandle, plan: &Plan, msg: String) {
    append_log(&format!("[update] FAILED {msg}"));
    publish(
        app,
        UpdateState {
            phase: "error".to_string(),
            error: msg,
            target_version: plan.version.clone(),
            ..Default::default()
        },
    );
}

fn cleanup_version_dir(version: &str) {
    let root = update_dir().join(format!("v{version}"));
    let _ = fs::remove_dir_all(&root);
}

/// 下载 + 校验 + 解包。成功返回 staging 目录（= 包根内容）。
fn download_and_stage(app: &AppHandle, plan: &Plan) -> Result<PathBuf, String> {
    let root = update_dir().join(format!("v{}", plan.version));
    fs::create_dir_all(&root).map_err(|e| format!("创建升级目录失败：{e}"))?;
    let zip_path = root.join("package.zip");
    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(root.join("staging"));
    let _ = fs::remove_dir_all(root.join("staging-raw"));

    let client = http_client(Duration::from_secs(3600))?;
    let mut resp = client
        .get(&plan.asset_url)
        .header(USER_AGENT, format!("catwhale-pet/{CURRENT_VERSION}"))
        .send()
        .map_err(|e| format!("连接下载地址失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status().as_u16()));
    }
    let total = resp
        .content_length()
        .filter(|n| *n > 0)
        .unwrap_or(plan.asset_size);

    let mut file = File::create(&zip_path).map_err(|e| format!("创建下载文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 128 * 1024];
    let mut received: u64 = 0;
    let started = Instant::now();
    let mut last_push = Instant::now() - Duration::from_millis(STALL_MS);

    loop {
        if cancelled() {
            drop(file);
            let _ = fs::remove_file(&zip_path);
            return Err("已取消下载".to_string());
        }
        let n = resp.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写盘失败：{e}"))?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if last_push.elapsed() >= Duration::from_millis(STALL_MS) {
            last_push = Instant::now();
            let secs = started.elapsed().as_secs_f64().max(0.001);
            let percent = if total > 0 {
                (received as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            publish(
                app,
                UpdateState {
                    phase: "downloading".to_string(),
                    percent,
                    received,
                    total,
                    bytes_per_sec: received as f64 / secs,
                    target_version: plan.version.clone(),
                    ..Default::default()
                },
            );
        }
    }
    let _ = file.sync_all();
    drop(file);

    // ---- 校验（§8-1：不匹配就删包、报错、绝不进入 stage）----
    publish(
        app,
        UpdateState {
            phase: "verifying".to_string(),
            percent: 100.0,
            received,
            total,
            target_version: plan.version.clone(),
            ..Default::default()
        },
    );
    let actual = sha256_file(&zip_path)?;
    if !actual.eq_ignore_ascii_case(&plan.sha256) {
        let _ = fs::remove_file(&zip_path);
        return Err(format!(
            "升级包校验失败：sha256 不匹配（清单 {}，实际 {}），已删除下载文件",
            &plan.sha256[..plan.sha256.len().min(16)],
            &actual[..16]
        ));
    }
    let _ = fs::write(root.join("package.sha256"), &actual);

    // ---- 解包 ----
    publish(
        app,
        UpdateState {
            phase: "extracting".to_string(),
            percent: 100.0,
            received,
            total,
            target_version: plan.version.clone(),
            ..Default::default()
        },
    );
    let raw = root.join("staging-raw");
    let _ = fs::remove_dir_all(&raw);
    fs::create_dir_all(&raw).map_err(|e| format!("创建解包目录失败：{e}"))?;
    if let Err(e) = extract_zip(&zip_path, &raw) {
        let _ = fs::remove_dir_all(&raw);
        return Err(e);
    }
    let pkg = match find_pkg_root(&raw) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_dir_all(&raw);
            return Err(e);
        }
    };
    if !pkg.join(APP_EXE).is_file() {
        let _ = fs::remove_dir_all(&raw);
        return Err("升级包里缺少主程序 catwhale-poc.exe".to_string());
    }
    if !pkg.join(AV_DLL).is_file() {
        let _ = fs::remove_dir_all(&raw);
        return Err("升级包里缺少 WebView2Loader.dll".to_string());
    }
    // 包内若带 SHA256SUMS.txt，逐个文件校验（§8-3）
    let inner_sums = pkg.join(SUMS_NAME);
    if inner_sums.is_file() {
        let text = fs::read_to_string(&inner_sums).unwrap_or_default();
        for (expect, name) in parse_sums(&text) {
            let rel = match safe_rel(&name) {
                Ok(r) => r,
                Err(e) => {
                    let _ = fs::remove_dir_all(&raw);
                    return Err(e);
                }
            };
            let file = pkg.join(&rel);
            if !file.is_file() {
                let _ = fs::remove_dir_all(&raw);
                return Err(format!("升级包内文件缺失：{name}"));
            }
            let got = sha256_file(&file)?;
            if got != expect {
                let _ = fs::remove_dir_all(&raw);
                return Err(format!("升级包内文件校验失败：{name}"));
            }
        }
    }

    // ---- 把「包根」变成 staging 本身（不能让包根嵌在 staging 下面）----
    let staging = root.join("staging");
    let _ = fs::remove_dir_all(&staging);
    if pkg == raw {
        fs::rename(&raw, &staging).map_err(|e| format!("移动解包目录失败：{e}"))?;
    } else {
        fs::rename(&pkg, &staging).map_err(|e| format!("移动包根失败：{e}"))?;
        let _ = fs::remove_dir_all(&raw);
    }
    Ok(staging)
}

/// Zip Slip 防护：拒绝绝对路径、盘符、`..` 上跳。
pub fn safe_rel(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("ZIP 条目路径为空，已拒绝".to_string());
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(format!("ZIP 含绝对路径，已拒绝（Zip Slip）：{name}"));
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(format!("ZIP 含盘符路径，已拒绝（Zip Slip）：{name}"));
    }
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!("ZIP 含上跳路径，已拒绝（Zip Slip）：{name}"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(format!("ZIP 条目路径为空，已拒绝：{name}"));
    }
    Ok(out)
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("打开升级包失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("升级包不是合法 zip：{e}"))?;
    if archive.len() > 20000 {
        return Err("升级包条目过多，已拒绝".to_string());
    }
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败：{e}"))?;
        let rel = safe_rel(entry.name())?;
        let out = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("建目录失败：{e}"))?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > 4 * 1024 * 1024 * 1024 {
            return Err("升级包解压后体积异常，已拒绝".to_string());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
        }
        let mut f = File::create(&out).map_err(|e| format!("写文件失败：{e}"))?;
        loop {
            let n = entry.read(&mut buf).map_err(|e| format!("解压失败：{e}"))?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n])
                .map_err(|e| format!("写文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// 定位包根：解包根直接有主 exe → 解包根；否则恰好一个子目录里有 → 该子目录。
pub fn find_pkg_root(raw: &Path) -> Result<PathBuf, String> {
    if raw.join(APP_EXE).is_file() {
        return Ok(raw.to_path_buf());
    }
    let mut hits = Vec::new();
    if let Ok(rd) = fs::read_dir(raw) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && p.join(APP_EXE).is_file() {
                hits.push(p);
            }
        }
    }
    match hits.len() {
        1 => Ok(hits.remove(0)),
        0 => Err("升级包里没有找到主程序（catwhale-poc.exe），已拒绝".to_string()),
        _ => Err("升级包里有多层主程序目录，无法确定包根".to_string()),
    }
}

/* ============================ 命令：download / cancel / stage ============================ */

fn plan_for_download() -> Result<Plan, String> {
    if let Some(p) = plan_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok(p);
    }
    let (out, plan) = run_check();
    match plan {
        Some(p) => {
            *plan_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
            *latest_cache().write().unwrap_or_else(|e| e.into_inner()) = Some(out);
            Ok(p)
        }
        None => {
            let reason = out
                .get("reason")
                .and_then(Value::as_str)
                .filter(|r| !r.is_empty())
                .map(str::to_string)
                .or_else(|| out.get("error").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "当前没有可用的升级包".to_string());
            Err(reason)
        }
    }
}

#[tauri::command]
pub fn update_download(app: AppHandle) -> Value {
    let cur = snapshot();
    if cur.phase == "downloading" || cur.phase == "verifying" || cur.phase == "extracting" {
        return json!({ "ok": true, "already": true, "phase": cur.phase });
    }
    let plan = match plan_for_download() {
        Ok(p) => p,
        Err(reason) => {
            publish_plain(UpdateState {
                phase: "error".to_string(),
                error: reason.clone(),
                ..Default::default()
            });
            return json!({ "ok": false, "error": reason, "phase": "error" });
        }
    };
    // 已经解包好了：直接进 ready
    let already = staged_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .filter(|p| p.is_dir());
    if already.is_some() {
        publish(
            &app,
            UpdateState {
                phase: "ready".to_string(),
                percent: 100.0,
                received: plan.asset_size,
                total: plan.asset_size,
                target_version: plan.version.clone(),
                ready_to_restart: true,
                ..Default::default()
            },
        );
        return json!({ "ok": true, "phase": "ready" });
    }

    cancel_flag().store(false, Ordering::SeqCst);
    publish(
        &app,
        UpdateState {
            phase: "downloading".to_string(),
            total: plan.asset_size,
            target_version: plan.version.clone(),
            ..Default::default()
        },
    );
    let app_h = app.clone();
    let plan_moved = plan.clone();
    std::thread::spawn(move || match download_and_stage(&app_h, &plan_moved) {
        Ok(staging) => {
            *staged_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(staging);
            append_log(&format!(
                "[update] staged v{} ({})",
                plan_moved.version, plan_moved.asset_name
            ));
            publish(
                &app_h,
                UpdateState {
                    phase: "ready".to_string(),
                    percent: 100.0,
                    received: plan_moved.asset_size,
                    total: plan_moved.asset_size,
                    target_version: plan_moved.version.clone(),
                    ready_to_restart: true,
                    ..Default::default()
                },
            );
        }
        Err(e) => {
            if cancelled() || e.contains("取消") {
                cleanup_version_dir(&plan_moved.version);
                *staged_slot().lock().unwrap_or_else(|x| x.into_inner()) = None;
                publish_plain(UpdateState {
                    phase: "idle".to_string(),
                    error: "已取消下载".to_string(),
                    ..Default::default()
                });
            } else {
                fail(&app_h, &plan_moved, e);
            }
        }
    });
    json!({ "ok": true, "phase": "downloading" })
}

#[tauri::command]
pub fn update_cancel() -> Value {
    let phase = snapshot().phase;
    cancel_flag().store(true, Ordering::SeqCst);
    if phase == "downloading" || phase == "verifying" || phase == "extracting" {
        return json!({ "ok": true, "cancelling": true, "phase": phase });
    }
    if let Some(plan) = plan_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        cleanup_version_dir(&plan.version);
    }
    *staged_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
    publish_plain(UpdateState {
        phase: "idle".to_string(),
        error: "已取消下载".to_string(),
        ..Default::default()
    });
    json!({ "ok": true, "phase": "idle" })
}

/// 单独触发「解包 + 校验」（下载完成后会自动调用；这里给手动重试用）。
#[tauri::command]
pub fn update_stage(app: AppHandle) -> Value {
    let cur = snapshot();
    if cur.phase == "downloading" || cur.phase == "extracting" || cur.phase == "applying" {
        return json!({ "ok": false, "error": "当前阶段不能重复解包", "phase": cur.phase });
    }
    let already = staged_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .filter(|p| p.is_dir());
    if already.is_some() {
        return json!({ "ok": true, "phase": "ready" });
    }
    let plan = match plan_for_download() {
        Ok(p) => p,
        Err(reason) => {
            publish_plain(UpdateState {
                phase: "error".to_string(),
                error: reason.clone(),
                ..Default::default()
            });
            return json!({ "ok": false, "error": reason, "phase": "error" });
        }
    };
    let root = update_dir().join(format!("v{}", plan.version));
    let zip_path = root.join("package.zip");
    if !zip_path.is_file() {
        return json!({ "ok": false, "error": "还没有下载升级包", "phase": snapshot().phase });
    }
    let app_h = app.clone();
    let plan_moved = plan.clone();
    publish(
        &app,
        UpdateState {
            phase: "verifying".to_string(),
            target_version: plan.version.clone(),
            ..Default::default()
        },
    );
    std::thread::spawn(move || {
        let result = (|| -> Result<PathBuf, String> {
            let actual = sha256_file(&zip_path)?;
            if !actual.eq_ignore_ascii_case(&plan_moved.sha256) {
                let _ = fs::remove_file(&zip_path);
                return Err("升级包校验失败：sha256 不匹配，已删除下载文件".to_string());
            }
            let raw = root.join("staging-raw");
            let _ = fs::remove_dir_all(&raw);
            fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
            extract_zip(&zip_path, &raw)?;
            let pkg = find_pkg_root(&raw)?;
            if !pkg.join(APP_EXE).is_file() {
                return Err("升级包里缺少主程序 catwhale-poc.exe".to_string());
            }
            if !pkg.join(AV_DLL).is_file() {
                return Err("升级包里缺少 WebView2Loader.dll".to_string());
            }
            let staging = root.join("staging");
            let _ = fs::remove_dir_all(&staging);
            if pkg == raw {
                fs::rename(&raw, &staging).map_err(|e| e.to_string())?;
            } else {
                fs::rename(&pkg, &staging).map_err(|e| e.to_string())?;
                let _ = fs::remove_dir_all(&raw);
            }
            Ok(staging)
        })();
        match result {
            Ok(staging) => {
                *staged_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(staging);
                publish(
                    &app_h,
                    UpdateState {
                        phase: "ready".to_string(),
                        percent: 100.0,
                        total: plan_moved.asset_size,
                        received: plan_moved.asset_size,
                        target_version: plan_moved.version.clone(),
                        ready_to_restart: true,
                        ..Default::default()
                    },
                );
            }
            Err(e) => fail(&app_h, &plan_moved, e),
        }
    });
    json!({ "ok": true, "phase": "verifying" })
}

/* ============================ apply.cmd 生成（§6） ============================ */

pub struct ApplySpec {
    pub install: String,
    pub stage: String,
    pub exe: String,
    pub pid: u32,
    pub bak: String,
    /// 日志绝对路径；落在更新目录里时自动写成 `%LOCALAPPDATA%\catwhale-update\...` 形式。
    pub log: String,
    pub result: String,
    pub from: String,
    pub to: String,
}

/// 更新目录里的路径 → 用环境变量形式表达（cmd 读环境变量不经过代码页转换，中文路径更稳）。
fn env_form(path: &str) -> String {
    let dir = update_dir().to_string_lossy().replace('/', "\\");
    let p = path.replace('/', "\\");
    if let Some(rest) = p.strip_prefix(&dir) {
        let rest = rest.trim_start_matches('\\');
        return format!("%LOCALAPPDATA%\\{UPDATE_DIR_NAME}\\{rest}");
    }
    p
}

fn bat_quote(v: &str) -> String {
    // 值里的 `"` 会破坏 set "X=..."；路径不会出现，保险起见剔除。
    v.replace('"', "").replace(['\r', '\n'], "")
}

/// 由参数生成 apply.cmd 全文（纯函数，便于单测）。
pub fn build_apply_cmd(s: &ApplySpec) -> String {
    let install = bat_quote(&s.install);
    let stage = bat_quote(&s.stage);
    let exe = bat_quote(&s.exe);
    let pid = s.pid;
    let bak = bat_quote(&s.bak);
    let log = env_form(&bat_quote(&s.log));
    let result = env_form(&bat_quote(&s.result));
    let from = bat_quote(&s.from);
    let to = bat_quote(&s.to);
    let log_name = bat_quote(s.log.rsplit(['\\', '/']).next().unwrap_or("apply.log"));

    let ok_json = format!(
        "{{\"from\":\"{from}\",\"to\":\"{to}\",\"result\":\"ok\",\"at\":0,\"log\":\"{log_name}\"}}"
    );
    let fail_json = |code: &str| {
        format!(
            "{{\"from\":\"{from}\",\"to\":\"{to}\",\"result\":\"failed\",\"at\":0,\"log\":\"{log_name}\",\"error\":\"{code}\"}}"
        )
    };
    let j_backup = fail_json("backup_failed");
    let j_swap = fail_json("swap_failed");
    let j_unlock = fail_json("unlock_timeout");
    let j_proc = fail_json("proc_timeout");
    let j_start = fail_json("start_failed");

    let mut t = String::new();
    t.push_str("@echo off\r\n");
    t.push_str("chcp 65001 >nul\r\n");
    t.push_str("setlocal enabledelayedexpansion\r\n");
    t.push_str("rem catwhale-pet online update script (generated, do not edit)\r\n");
    t.push_str(&format!("set \"INSTALL={install}\"\r\n"));
    t.push_str(&format!("set \"STAGE={stage}\"\r\n"));
    t.push_str(&format!("set \"EXE={exe}\"\r\n"));
    t.push_str(&format!("set \"PID={pid}\"\r\n"));
    t.push_str(&format!("set \"BAK={bak}\"\r\n"));
    t.push_str(&format!("set \"LOG={log}\"\r\n"));
    t.push_str(&format!("set \"RESULT={result}\"\r\n"));
    t.push_str(&format!("set \"FROM={from}\"\r\n"));
    t.push_str(&format!("set \"TO={to}\"\r\n"));
    // 关键：子进程 cwd 不能落在安装目录里（否则 move 安装目录 永远失败）
    t.push_str("cd /d \"%LOCALAPPDATA%\\catwhale-update\" 2>nul\r\n");
    t.push_str("if errorlevel 1 cd /d \"%SystemRoot%\" 2>nul\r\n");
    t.push_str("if errorlevel 1 cd /d \"%TEMP%\" 2>nul\r\n");
    t.push_str("call :log \"START from=%FROM% to=%TO% pid=%PID%\"\r\n");
    t.push_str("call :log \"install=%INSTALL%\"\r\n");
    t.push_str("call :log \"stage=%STAGE%\"\r\n");

    // 1) 等旧进程退出
    t.push_str("rem ---- 1) wait for old process (max ~180s) ----\r\n");
    t.push_str("set /a TICKS=0\r\n");
    t.push_str("set \"KILLED=0\"\r\n");
    t.push_str(":wait_proc\r\n");
    t.push_str("set \"ALIVE=\"\r\n");
    // 用 for /f 精确比对 PID 列，比 find 命中内存数字可靠；也不依赖系统语言
    t.push_str("for /f \"tokens=2 delims=,\" %%A in ('tasklist /FI \"PID eq %PID%\" /NH /FO CSV 2^>nul') do if \"%%~A\"==\"%PID%\" set \"ALIVE=1\"\r\n");
    t.push_str("if not defined ALIVE goto proc_gone\r\n");
    t.push_str("set /a TICKS+=1\r\n");
    t.push_str("if %TICKS% geq 20 if \"%KILLED%\"==\"0\" (\r\n");
    t.push_str("  set \"KILLED=1\"\r\n");
    t.push_str("  call :log \"still alive after 20 ticks, taskkill /PID %PID% /F\"\r\n");
    t.push_str("  taskkill /PID %PID% /F >nul 2>&1\r\n");
    t.push_str(")\r\n");
    t.push_str("if %TICKS% geq 180 goto fail_proc_timeout\r\n");
    t.push_str("call :sleep1\r\n");
    t.push_str("goto wait_proc\r\n");
    t.push_str(":proc_gone\r\n");
    t.push_str("call :log \"process gone (ticks=%TICKS%)\"\r\n");

    // 2) 等 exe 解锁
    t.push_str("rem ---- 2) wait for exe unlock (max ~60s) ----\r\n");
    t.push_str("set /a TICKS=0\r\n");
    t.push_str(":wait_unlock\r\n");
    t.push_str("if not exist \"%INSTALL%\\%EXE%\" goto unlock_ok\r\n");
    t.push_str("ren \"%INSTALL%\\%EXE%\" \"%EXE%.t\" >nul 2>&1\r\n");
    t.push_str("if errorlevel 1 (\r\n");
    t.push_str("  set /a TICKS+=1\r\n");
    t.push_str("  if !TICKS! geq 60 goto fail_unlock\r\n");
    t.push_str("  call :sleep1\r\n");
    t.push_str("  goto wait_unlock\r\n");
    t.push_str(")\r\n");
    t.push_str("ren \"%INSTALL%\\%EXE%.t\" \"%EXE%\" >nul 2>&1\r\n");
    t.push_str(":unlock_ok\r\n");
    t.push_str("call :log \"exe unlocked (ticks=%TICKS%)\"\r\n");

    // 3) 备份
    t.push_str("rem ---- 3) backup old install dir ----\r\n");
    t.push_str("move \"%INSTALL%\" \"%BAK%\" >nul 2>&1\r\n");
    t.push_str("if errorlevel 1 goto fail_backup\r\n");
    t.push_str("call :log \"backup ok\"\r\n");

    // 4) 换入
    t.push_str("rem ---- 4) swap in staged package ----\r\n");
    t.push_str("move \"%STAGE%\" \"%INSTALL%\" >nul 2>&1\r\n");
    t.push_str("if errorlevel 1 goto fail_swap\r\n");
    t.push_str("call :log \"swap ok\"\r\n");

    // 5) 启动新版
    t.push_str("rem ---- 5) start new version (max 5 tries) ----\r\n");
    t.push_str("set /a TRIES=0\r\n");
    t.push_str(":start_loop\r\n");
    t.push_str("set /a TRIES+=1\r\n");
    t.push_str("start \"\" \"%INSTALL%\\%EXE%\"\r\n");
    t.push_str("if not errorlevel 1 goto started\r\n");
    t.push_str("call :log \"start failed (try %TRIES%)\"\r\n");
    t.push_str("if %TRIES% geq 5 goto fail_start\r\n");
    t.push_str("call :sleep1\r\n");
    t.push_str("goto start_loop\r\n");
    t.push_str(":started\r\n");
    t.push_str("call :log \"started (tries=%TRIES%)\"\r\n");

    // 6) 写回执（纯 ASCII；at 由新实例按文件 mtime 补）
    t.push_str("rem ---- 6) write result receipt ----\r\n");
    t.push_str(&format!(">\"%RESULT%\" echo {ok_json}\r\n"));
    t.push_str("call :log \"RESULT ok\"\r\n");

    // 7) 清理备份
    t.push_str("rem ---- 7) cleanup backup ----\r\n");
    t.push_str("rmdir /s /q \"%BAK%\" >nul 2>&1\r\n");
    t.push_str("if exist \"%BAK%\" call :log \"backup kept (in use)\"\r\n");
    t.push_str("call :log \"DONE ok\"\r\n");
    t.push_str("endlocal\r\n");
    t.push_str("exit /b 0\r\n");

    // ---- 失败分支 ----
    t.push_str("\r\n:fail_proc_timeout\r\n");
    t.push_str("call :log \"FAIL old process still alive after ~180s, abort (nothing touched)\"\r\n");
    t.push_str(&format!(">\"%RESULT%\" echo {j_proc}\r\n"));
    t.push_str("endlocal & exit /b 4\r\n");

    t.push_str("\r\n:fail_unlock\r\n");
    t.push_str("call :log \"FAIL exe still locked after ~60s, abort (nothing touched)\"\r\n");
    t.push_str(&format!(">\"%RESULT%\" echo {j_unlock}\r\n"));
    t.push_str("endlocal & exit /b 5\r\n");

    t.push_str("\r\n:fail_backup\r\n");
    t.push_str("call :log \"FAIL backup: move install -> bak (install dir busy?)\"\r\n");
    t.push_str(&format!(">\"%RESULT%\" echo {j_backup}\r\n"));
    t.push_str("call :log \"DONE failed(backup); old install untouched\"\r\n");
    t.push_str("endlocal & exit /b 2\r\n");

    t.push_str("\r\n:fail_swap\r\n");
    t.push_str("call :log \"FAIL swap: move stage -> install; rolling back\"\r\n");
    t.push_str("move \"%BAK%\" \"%INSTALL%\" >nul 2>&1\r\n");
    t.push_str("if errorlevel 1 call :log \"ROLLBACK FAILED: bak kept, manual restore needed\"\r\n");
    t.push_str("if not errorlevel 1 call :log \"rollback ok\"\r\n");
    t.push_str("set /a TRIES=0\r\n");
    t.push_str(":rollback_start\r\n");
    t.push_str("if not exist \"%INSTALL%\\%EXE%\" goto rollback_done\r\n");
    t.push_str("set /a TRIES+=1\r\n");
    t.push_str("start \"\" \"%INSTALL%\\%EXE%\"\r\n");
    t.push_str("if not errorlevel 1 goto rollback_done\r\n");
    t.push_str("if %TRIES% geq 5 goto rollback_done\r\n");
    t.push_str("call :sleep1\r\n");
    t.push_str("goto rollback_start\r\n");
    t.push_str(":rollback_done\r\n");
    t.push_str(&format!(">\"%RESULT%\" echo {j_swap}\r\n"));
    t.push_str("call :log \"DONE failed(swap)\"\r\n");
    t.push_str("endlocal & exit /b 3\r\n");

    t.push_str("\r\n:fail_start\r\n");
    t.push_str("call :log \"FAIL start new exe after 5 tries (install dir already swapped)\"\r\n");
    t.push_str(&format!(">\"%RESULT%\" echo {j_start}\r\n"));
    t.push_str("endlocal & exit /b 6\r\n");

    // ---- 子过程 ----
    t.push_str("\r\n:sleep1\r\n");
    // cmd 里最稳的 sleep：ping 回环（timeout 在无控制台/重定向时会报错）
    t.push_str("ping -n 2 127.0.0.1 >nul\r\n");
    t.push_str("exit /b 0\r\n");
    t.push_str("\r\n:log\r\n");
    t.push_str(">>\"%LOG%\" echo [%date% %time%] %~1\r\n");
    t.push_str("exit /b 0\r\n");
    t
}

/* ============================ 命令：apply ============================ */

#[tauri::command]
pub fn update_apply(app: AppHandle) -> Value {
    let cur = snapshot();
    if cur.phase == "downloading" || cur.phase == "extracting" || cur.phase == "applying" {
        return json!({ "ok": false, "error": "正在下载/解包，不能立即重启", "phase": cur.phase });
    }
    let staged = staged_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(staging) = staged else {
        return json!({ "ok": false, "error": "还没有可用的升级包，请先下载" });
    };
    if !staging.is_dir() || !staging.join(APP_EXE).is_file() {
        return json!({ "ok": false, "error": "升级包目录不完整，请重新下载" });
    }
    let plan = match plan_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(p) => p,
        None => return json!({ "ok": false, "error": "缺少升级计划，请重新检查更新" }),
    };

    let install = install_dir();
    if let Some(reason) = cross_volume_reason(&update_dir(), &install) {
        return json!({ "ok": false, "error": reason, "reason": reason });
    }

    let ts = now_secs();
    let dir = update_dir();
    let _ = fs::create_dir_all(&dir);
    let log_path = dir.join(format!("apply-{ts}.log"));
    let result_path = dir.join("last-result.json");
    let script_path = dir.join(format!("apply-{ts}.cmd"));
    let bak = format!("{}.bak-{ts}", install.to_string_lossy());

    let spec = ApplySpec {
        install: install.to_string_lossy().to_string(),
        stage: staging.to_string_lossy().to_string(),
        exe: APP_EXE.to_string(),
        pid: std::process::id(),
        bak,
        log: log_path.to_string_lossy().to_string(),
        result: result_path.to_string_lossy().to_string(),
        from: CURRENT_VERSION.to_string(),
        to: plan.version.clone(),
    };
    let script = build_apply_cmd(&spec);
    if let Err(e) = fs::write(&script_path, script.as_bytes()) {
        return json!({ "ok": false, "error": format!("写升级脚本失败：{e}") });
    }

    // 关键：cmd 的 cwd 绝不能是安装目录（否则脚本自己锁住目录，move 必失败）
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/c").arg(&script_path);
    cmd.current_dir(&dir);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    if let Err(e) = cmd.spawn() {
        return json!({ "ok": false, "error": format!("启动升级脚本失败：{e}") });
    }

    publish(
        &app,
        UpdateState {
            phase: "applying".to_string(),
            percent: 100.0,
            target_version: plan.version.clone(),
            ready_to_restart: true,
            ..Default::default()
        },
    );
    append_log(&format!(
        "[update] applying v{} via {}",
        plan.version,
        script_path.display()
    ));

    let will_quit_at = now_secs() * 1000 + 600;
    let app_h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        app_h.exit(0);
    });
    json!({
        "ok": true,
        "willQuitAt": will_quit_at,
        "phase": "applying",
        "logPath": log_path.to_string_lossy(),
        "targetVersion": plan.version,
    })
}

/* ============================ 启动：回执 / 清理 ============================ */

/// 读 `last-result.json`（纯 ASCII；`at` 缺失时用文件 mtime 补，`log` 只存文件名）。
fn read_last_result() -> Option<Value> {
    let path = update_dir().join("last-result.json");
    let text = fs::read_to_string(&path).ok()?;
    let mut v: Value = serde_json::from_str(text.trim()).ok()?;
    if v.get("at").and_then(Value::as_u64).unwrap_or(0) == 0 {
        if let Ok(md) = fs::metadata(&path) {
            if let Ok(modified) = md.modified() {
                if let Ok(d) = modified.duration_since(UNIX_EPOCH) {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("at".to_string(), json!(d.as_secs()));
                    }
                }
            }
        }
    }
    if let Some(name) = v.get("log").and_then(Value::as_str).map(str::to_string) {
        let full = update_dir().join(&name);
        if let Some(obj) = v.as_object_mut() {
            obj.insert("logPath".to_string(), json!(full.to_string_lossy()));
        }
    }
    Some(v)
}

/// 启动时：读回执、报告残留 .bak、清理旧 `v*` 目录（保留最新一个）。
pub fn startup_notice(app: &AppHandle) {
    if let Some(v) = read_last_result() {
        *result_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(v.clone());
        let _ = app.emit(EVENT_RESULT, v.clone());
        append_log(&format!(
            "[update] last-result result={} from={} to={}",
            v.get("result").and_then(Value::as_str).unwrap_or("?"),
            v.get("from").and_then(Value::as_str).unwrap_or("?"),
            v.get("to").and_then(Value::as_str).unwrap_or("?")
        ));
    }
    // .bak-* 只报告，不删（可能正被脚本用）
    if let Some(parent) = install_dir().parent() {
        if let Ok(rd) = fs::read_dir(parent) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.contains(".bak-") {
                    append_log(&format!("[update] leftover backup dir: {name}"));
                }
            }
        }
    }
    // 清理旧 v* 目录，保留最新一个
    let dir = update_dir();
    let mut vers: Vec<(SystemTime, PathBuf)> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let looks_like_version = name.len() > 1
                && name.starts_with('v')
                && name[1..].starts_with(|c: char| c.is_ascii_digit());
            if p.is_dir() && looks_like_version {
                let t = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH);
                vers.push((t, p));
            }
        }
    }
    if vers.len() > 1 {
        vers.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, p) in vers.iter().skip(1) {
            if fs::remove_dir_all(p).is_ok() {
                append_log(&format!("[update] cleaned old package dir {}", p.display()));
            }
        }
    }
}

/* ============================ 单测 ============================ */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asset(name: &str) -> Value {
        json!({
            "name": name,
            "size": 1024,
            "browser_download_url": format!("https://example.invalid/{name}")
        })
    }

    #[test]
    fn version_compare() {
        assert!(parse_version("0.7.2") > parse_version("0.7.1"));
        assert_eq!(parse_version("v0.7.1"), parse_version("0.7.1"));
        assert_eq!(parse_version("V1.2"), parse_version("1.2.0"));
        assert!(parse_version("0.7.10") > parse_version("0.7.9"));
        assert!(parse_version("0.7.2-beta") < parse_version("0.7.2"));
        assert!(parse_version("0.7").is_some());
        assert!(parse_version("abc").is_none());
        assert!(parse_version("1.2.3.4").is_none());
    }

    #[test]
    fn asset_pick_ignores_order_and_decoy() {
        let all = vec![
            asset("catwhale-pet-v0.7.2-win-x64.zip"), // 对端 238MB，故意排第一
            asset("SHA256SUMS.txt"),
            asset("catwhale-poc-v0.7.2-win-x64.zip"), // 本端
        ];
        let got = select_asset(&all, None).expect("应选中本端 zip");
        assert_eq!(asset_name(&got), "catwhale-poc-v0.7.2-win-x64.zip");

        // 只有对端 → 必须报「没有适用于本端」，绝不能回落到随便一个 zip
        let only_decoy = vec![asset("catwhale-pet-v0.7.2-win-x64.zip")];
        let err = select_asset(&only_decoy, None).unwrap_err();
        assert_eq!(err, R_NO_ASSET);
        assert!(err.contains("本端"));

        // 两个本端包 → 拒绝（宁可不升，也不升错）
        let two = vec![
            asset("catwhale-poc-v0.7.2-win-x64.zip"),
            asset("catwhale-tauri-v0.7.2-win-x64.zip"),
        ];
        assert_eq!(select_asset(&two, None).unwrap_err(), R_MULTI_ASSET);

        // 兜底：现有 release 命名 catwhale-poc-0.7.1-win-x64.zip（无 v）
        let legacy = vec![asset("catwhale-poc-0.7.1-win-x64.zip")];
        assert!(select_asset(&legacy, None).is_ok());

        // 环境变量覆盖（正则源）
        let mixed = vec![
            asset("catwhale-pet-v0.7.2-win-x64.zip"),
            asset("catwhale-poc-v0.7.2-win-x64.zip"),
        ];
        let got = select_asset(&mixed, Some("(?i)catwhale-pet-")).unwrap();
        assert_eq!(asset_name(&got), "catwhale-pet-v0.7.2-win-x64.zip");
    }

    #[test]
    fn sums_parse_and_lookup() {
        let text = "# comment\n\
d2c9a0b7f4e1c3a5b6d7e8f90123456789abcdef0123456789abcdef01234567  catwhale-poc-v0.7.2-win-x64.zip\n\
deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef *catwhale-pet-v0.7.2-win-x64.zip\n\
short  nope.zip\n";
        let list = parse_sums(text);
        assert_eq!(list.len(), 2, "只有两行合法：{list:?}");
        assert_eq!(
            lookup_sums(&list, "catwhale-poc-v0.7.2-win-x64.zip").unwrap(),
            "d2c9a0b7f4e1c3a5b6d7e8f90123456789abcdef0123456789abcdef01234567"
        );
        assert_eq!(
            lookup_sums(&list, "catwhale-pet-v0.7.2-win-x64.zip").unwrap(),
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        );
        assert!(lookup_sums(&list, "missing.zip").is_none());
        assert_eq!(R_NO_SHA_ENTRY, "校验清单里没有这个升级包");
    }

    #[test]
    fn zip_slip_is_rejected() {
        assert!(safe_rel("frontend/assets/idle.webm").is_ok());
        assert!(safe_rel("catwhale-poc.exe").is_ok());
        assert!(safe_rel("a\\b\\c.txt").is_ok());
        for bad in [
            "../evil.txt",
            "..\\evil.txt",
            "a/../../b.txt",
            "/abs.txt",
            "\\abs.txt",
            "C:/windows/x.txt",
            "C:evil.txt",
            "",
            "./",
        ] {
            assert!(safe_rel(bad).is_err(), "必须拒绝：{bad}");
        }
    }

    #[test]
    fn refusal_reasons_are_reachable() {
        // 1) 平台
        assert_eq!(platform_reason("linux", "x86_64"), Some(R_PLATFORM));
        assert_eq!(platform_reason("windows", "aarch64"), Some(R_PLATFORM));
        assert_eq!(platform_reason("windows", "x86_64"), None);

        // 2) 开发模式：临时目录里没有 frontend，exe 名也不是预期名
        let tmp = std::env::temp_dir().join(format!("catwhale-dev-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        assert_eq!(dev_mode_reason(&tmp, "catwhale.exe"), Some(R_DEV_MODE));
        assert_eq!(dev_mode_reason(&tmp, "catwhale-poc.exe"), None);
        let _ = fs::remove_dir_all(&tmp);

        // 3) 目录不可写（不存在的路径必然写不进去）
        let nope = PathBuf::from("Z:\\definitely-missing-dir-catwhale");
        assert_eq!(writable_reason(&nope, false), Some(R_INSTALL_READONLY));
        assert_eq!(writable_reason(&nope, true), Some(R_PARENT_READONLY));
        let ok_dir = std::env::temp_dir();
        assert_eq!(writable_reason(&ok_dir, false), None);

        // 4) 跨卷
        assert_eq!(
            cross_volume_reason(Path::new("H:\\a\\b"), Path::new("C:\\c")),
            Some(R_CROSS_VOLUME)
        );
        assert_eq!(
            cross_volume_reason(Path::new("H:\\a\\b"), Path::new("H:/x/y")),
            None
        );

        // 5) 其余四条是常量，逐条断言文案（UI 直接显示）
        assert!(R_NO_SUMS.contains("清单"));
        assert!(R_NO_ASSET.contains("本端"));
        assert!(R_MULTI_ASSET.contains("多个"));
        assert!(R_NO_SHA_ENTRY.contains("清单"));
        assert!(!R_PLATFORM.is_empty() && !R_DEV_MODE.is_empty());
    }

    #[test]
    fn apply_cmd_has_protocol_lines() {
        let spec = ApplySpec {
            install: "H:\\Hermes交付\\updatetest\\tauri\\app".to_string(),
            stage: "C:\\Users\\x\\AppData\\Local\\catwhale-update\\v0.7.2\\staging".to_string(),
            exe: "catwhale-poc.exe".to_string(),
            pid: 4242,
            bak: "H:\\Hermes交付\\updatetest\\tauri\\app.bak-1764234245".to_string(),
            log: "C:\\Users\\x\\AppData\\Local\\catwhale-update\\apply-1764234245.log".to_string(),
            result: "C:\\Users\\x\\AppData\\Local\\catwhale-update\\last-result.json".to_string(),
            from: "0.7.1".to_string(),
            to: "0.7.2".to_string(),
        };
        let text = build_apply_cmd(&spec);
        let need = [
            "@echo off",
            "chcp 65001 >nul",
            "setlocal enabledelayedexpansion",
            "set \"INSTALL=H:\\Hermes交付\\updatetest\\tauri\\app\"",
            "set \"STAGE=C:\\Users\\x\\AppData\\Local\\catwhale-update\\v0.7.2\\staging\"",
            "set \"EXE=catwhale-poc.exe\"",
            "set \"PID=4242\"",
            "set \"FROM=0.7.1\"",
            "set \"TO=0.7.2\"",
            "cd /d \"%LOCALAPPDATA%\\catwhale-update\"",
            "tasklist /FI \"PID eq %PID%\" /NH /FO CSV",
            "taskkill /PID %PID% /F",
            "ren \"%INSTALL%\\%EXE%\" \"%EXE%.t\"",
            "move \"%INSTALL%\" \"%BAK%\"",
            "move \"%STAGE%\" \"%INSTALL%\"",
            "move \"%BAK%\" \"%INSTALL%\"",
            "start \"\" \"%INSTALL%\\%EXE%\"",
            "rmdir /s /q \"%BAK%\"",
            "ping -n 2 127.0.0.1 >nul",
            ":log",
            "START from=%FROM% to=%TO% pid=%PID%",
            "\"result\":\"ok\"",
            "\"result\":\"failed\"",
            "\"error\":\"backup_failed\"",
            "\"error\":\"swap_failed\"",
        ];
        for n in need {
            assert!(text.contains(n), "apply.cmd 缺少关键行：{n}");
        }
        // 回执必须是纯 ASCII（说明性中文只进 .log）
        let receipts: Vec<&str> = text
            .lines()
            .filter(|l| l.contains("RESULT%\" echo "))
            .collect();
        assert!(!receipts.is_empty(), "没有找到写回执的行");
        for line in receipts {
            assert!(line.is_ascii(), "last-result.json 必须纯 ASCII：{line}");
        }
        assert!(!text.to_ascii_lowercase().contains("powershell"));
        // START 必须出现在任何业务动作之前
        let start_at = text.find("START from=").unwrap();
        let first_move = text.find("move \"%INSTALL%\"").unwrap();
        assert!(start_at < first_move);
    }

    #[test]
    fn url_gate_rejects_plain_http_without_override() {
        let u = Url::parse("http://127.0.0.1:8000/assets/a.zip").unwrap();
        assert!(!url_allowed(&u, false), "未设置调试覆盖时不允许明文 http");
        assert!(url_allowed(&u, true));
        let https = Url::parse("https://github.com/x.zip").unwrap();
        assert!(url_allowed(&https, false));
        let evil = Url::parse("http://evil.example.com/a.zip").unwrap();
        assert!(!url_allowed(&evil, true), "只有环回地址放行");
        let other = Url::parse("ftp://x/y").unwrap();
        assert!(!url_allowed(&other, true));
    }

    #[test]
    fn pkg_root_detection() {
        let base = std::env::temp_dir().join(format!("catwhale-pkgroot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let flat = base.join("flat");
        fs::create_dir_all(&flat).unwrap();
        fs::write(flat.join(APP_EXE), b"x").unwrap();
        assert_eq!(find_pkg_root(&flat).unwrap(), flat);

        let wrap = base.join("wrap");
        let inner = wrap.join("桌宠");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join(APP_EXE), b"x").unwrap();
        assert_eq!(find_pkg_root(&wrap).unwrap(), inner);

        let none = base.join("none");
        fs::create_dir_all(&none).unwrap();
        assert!(find_pkg_root(&none).is_err());

        let multi = base.join("multi");
        for d in ["a", "b"] {
            let p = multi.join(d);
            fs::create_dir_all(&p).unwrap();
            fs::write(p.join(APP_EXE), b"x").unwrap();
        }
        assert!(find_pkg_root(&multi).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn update_dir_follows_env_var() {
        let d = update_dir();
        assert_eq!(d.file_name().unwrap().to_string_lossy(), UPDATE_DIR_NAME);
        if let Some(v) = std::env::var_os("LOCALAPPDATA") {
            assert!(d.starts_with(PathBuf::from(v)), "必须从环境变量解析：{d:?}");
        }
    }
}
