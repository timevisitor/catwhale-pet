//! Animation-loop settings and Director configuration lookup.
//!
//! Media playback configuration is intentionally outside this module.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MIN_SPAN_SEC: f64 = 0.2;
const SPAN_EPSILON: f64 = 1e-6;
const MAX_ACTION_ID_LEN: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AnimationLoopConfig {
    pub enabled: bool,
    #[serde(rename = "actionId")]
    pub action_id: String,
    pub start: f64,
    pub end: f64,
}

impl Default for AnimationLoopConfig {
    fn default() -> Self {
        Self { enabled: false, action_id: "idle".into(), start: 0.0, end: 2.0 }
    }
}

fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => {
            let clipped = v.chars().take(24).collect::<String>();
            if v.chars().count() > 24 { format!("\"{clipped}…\"") } else { format!("\"{v}\"") }
        }
        Value::Array(_) => "数组".into(),
        Value::Object(_) => "对象".into(),
    }
}

fn prototype_key(key: &str) -> bool {
    matches!(key, "__proto__" | "constructor" | "prototype")
}

fn validate_action_id(value: Option<&Value>) -> Result<String, String> {
    let Some(value) = value else { return Ok("idle".into()) };
    let Value::String(raw) = value else {
        return Err(format!("actionId 必须是字符串（收到 {}）", describe(value)));
    };
    if raw.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}') {
        return Err("actionId 含非法字符（不能含 / \\ 或控制字符）".into());
    }
    let id = raw.trim();
    if id.is_empty() {
        return Err("actionId 不能为空".into());
    }
    if id.chars().count() > MAX_ACTION_ID_LEN {
        return Err(format!("actionId 太长（最多 {MAX_ACTION_ID_LEN} 字符）"));
    }
    if prototype_key(id) {
        return Err(format!("actionId 不能是原型链关键字：{id}"));
    }
    if id.starts_with('.') {
        return Err("actionId 不能以 . 开头".into());
    }
    if id.contains(|c| c == '/' || c == '\\') {
        return Err("actionId 含非法字符（不能含 / \\ 或控制字符）".into());
    }
    Ok(id.to_string())
}

pub fn normalize_animation_loop(input: &Value) -> Result<AnimationLoopConfig, String> {
    let object = input.as_object().ok_or_else(|| format!("配置必须是对象（收到 {}）", describe(input)))?;
    for key in object.keys() {
        if prototype_key(key) {
            return Err(format!("配置不能含原型链关键字字段：{key}"));
        }
    }
    let mut config = AnimationLoopConfig::default();
    if let Some(value) = object.get("enabled") {
        config.enabled = value
            .as_bool()
            .ok_or_else(|| format!("enabled 必须是布尔值 true/false（收到 {}）", describe(value)))?;
    }
    if object.contains_key("actionId") {
        config.action_id = validate_action_id(object.get("actionId"))?;
    }
    for key in ["start", "end"] {
        if let Some(value) = object.get(key) {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("{key} 必须是有限数值（收到 {}）", describe(value)))?;
            let normalized = if number == 0.0 { 0.0 } else { number };
            if key == "start" {
                config.start = normalized;
            } else {
                config.end = normalized;
            }
        }
    }
    if config.start < 0.0 {
        return Err(format!("start 不能小于 0（收到 {}）", config.start));
    }
    if config.end <= config.start {
        return Err(format!("end 必须大于 start（start={} end={}）", config.start, config.end));
    }
    if config.end - config.start < MIN_SPAN_SEC - SPAN_EPSILON {
        return Err(format!(
            "循环片段太短：end - start 至少要 {MIN_SPAN_SEC} 秒（当前 {}）",
            config.end - config.start
        ));
    }
    Ok(config)
}

fn animation_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("animation-loop.json"))
}

fn atomic_animation_write(path: &Path, config: &AnimationLoopConfig) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "配置路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let tmp = path.with_extension(format!("tmp-{}-{stamp}", std::process::id()));
    let result = (|| {
        let mut text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn animation_loop_get(app: AppHandle) -> Value {
    let path = match animation_file(&app) {
        Ok(path) => path,
        Err(error) => {
            return json!({
                "ok": true,
                "config": AnimationLoopConfig::default(),
                "error": format!("读取动画循环配置失败，已按“关闭循环”处理：{error}"),
            })
        }
    };
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json!({ "ok": true, "config": AnimationLoopConfig::default() })
        }
        Err(error) => {
            return json!({
                "ok": true,
                "config": AnimationLoopConfig::default(),
                "error": format!("读取动画循环配置失败，已按“关闭循环”处理：{error}"),
            })
        }
    };
    let raw = match serde_json::from_str::<Value>(&text) {
        Ok(raw) => raw,
        Err(error) => {
            return json!({
                "ok": true,
                "config": AnimationLoopConfig::default(),
                "error": format!("动画循环配置不是合法 JSON，已按“关闭循环”处理：{error}"),
            })
        }
    };
    match normalize_animation_loop(&raw) {
        Ok(config) => json!({ "ok": true, "config": config }),
        Err(error) => json!({
            "ok": true,
            "config": AnimationLoopConfig::default(),
            "error": format!("动画循环配置无效，已按“关闭循环”处理：{error}"),
        }),
    }
}

#[tauri::command]
pub fn animation_loop_set(app: AppHandle, cfg: Value) -> Value {
    let config = match normalize_animation_loop(&cfg) {
        Ok(config) => config,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let path = match animation_file(&app) {
        Ok(path) => path,
        Err(error) => return json!({ "ok": false, "error": format!("写入动画循环配置失败（原配置未改动）：{error}") }),
    };
    match atomic_animation_write(&path, &config) {
        Ok(()) => json!({ "ok": true, "config": config }),
        Err(error) => json!({
            "ok": false,
            "error": format!("写入动画循环配置失败（原配置未改动）：{error}"),
        }),
    }
}

fn active_skin_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA").unwrap_or_else(|| ".".into());
    let root = PathBuf::from(appdata).join("桌宠").join("skins");
    let text = fs::read_to_string(root.join("active.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let slug = value.get("slug")?.as_str()?;
    if slug.is_empty()
        || !slug.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return None;
    }
    Some(root.join(slug))
}

/// Read the active skin's `director.json` first, then the app-config fallback.
/// A missing file yields `cfg:null`; a malformed higher-priority file is reported
/// rather than silently falling back to a different configuration.
#[tauri::command]
pub fn director_get(app: AppHandle) -> Value {
    let mut candidates = Vec::new();
    if let Some(dir) = active_skin_dir() {
        candidates.push(dir.join("director.json"));
    }
    match app.path().app_config_dir() {
        Ok(dir) => candidates.push(dir.join("director.json")),
        Err(error) if candidates.is_empty() => {
            return json!({ "ok": false, "file": Value::Null, "error": error.to_string(), "cfg": Value::Null })
        }
        Err(_) => {}
    }
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let file = path.to_string_lossy().into_owned();
        return match fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
        {
            Ok(cfg) => json!({ "ok": true, "file": file, "cfg": cfg }),
            Err(error) => json!({ "ok": false, "file": file, "error": error, "cfg": Value::Null }),
        };
    }
    json!({ "ok": true, "file": Value::Null, "cfg": Value::Null })
}
