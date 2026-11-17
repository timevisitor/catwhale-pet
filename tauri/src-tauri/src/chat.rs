//! Chat configuration, direct OpenAI/Anthropic APIs, and per-persona history.
//!
//! This module deliberately does not start or manage Harness.  A Harness backend
//! returns `HARNESS_REQUIRED`; the Harness module can reuse `current_config`,
//! `append_history`, and `config_dir`.
//!
//! `current_config` is an in-process API: it contains decrypted `apiKey` values
//! for the Harness runtime.  Never emit, serialize to logs, or return it from a
//! Tauri command.  The frontend-facing `config_get` always removes secrets.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const HISTORY_LIMIT: usize = 200;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_JSON_BODY: usize = 16 * 1024 * 1024;
const MAX_SSE_LINE: usize = 8 * 1024 * 1024;
const DEFAULT_SYSTEM: &str = "你是住在用户桌面上的桌宠「猫鲸」，说话简短、口语、友好。";

static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static IO_LOCK: Mutex<()> = Mutex::new(());
static GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE_JOB: Mutex<Option<ApiJob>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn init_config_dir(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = APP_CONFIG_DIR.set(dir);
    }
}

/// App config directory, also usable before the first Tauri command.
pub fn config_dir() -> PathBuf {
    APP_CONFIG_DIR.get().cloned().unwrap_or_else(|| {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("com.hermes.catwhalepoc")
    })
}

fn settings_file() -> PathBuf {
    config_dir().join("settings.json")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "目标路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    let result = (|| {
        let mut file = File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        match fs::rename(&tmp, path) {
            Ok(()) => Ok(()),
            Err(first) => {
                // Windows rename cannot replace an existing file.  Keep the
                // atomic path for new files and use a replace fallback for updates.
                if path.exists() {
                    fs::remove_file(path).map_err(|e| e.to_string())?;
                    fs::rename(&tmp, path).map_err(|e| e.to_string())
                } else {
                    Err(first.to_string())
                }
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn load_raw_unlocked() -> Value {
    fs::read_to_string(settings_file())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn load_raw() -> Value {
    let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_raw_unlocked()
}

fn defaults() -> Value {
    json!({
        "deepseek": {
            "baseUrl": "https://api.deepseek.com",
            "model": "",
            "provider": ""
        },
        "harness": {
            "repo": "",
            "profile": "headless",
            "cwd": "",
            "maxTokens": 8192
        },
        "chat": {
            "backend": "harness",
            "protocol": "openai",
            "baseUrl": "",
            "model": "",
            "temperature": "",
            "maxTokens": 2048,
            "historyTurns": 12,
            "userName": "",
            "personaMaxChars": 6000
        }
    })
}

fn section_mut<'a>(root: &'a mut Value, name: &str) -> &'a mut Map<String, Value> {
    if !root.is_object() {
        *root = json!({});
    }
    let root = root.as_object_mut().expect("object inserted above");
    if !root.get(name).is_some_and(Value::is_object) {
        root.insert(name.to_string(), json!({}));
    }
    root.get_mut(name)
        .and_then(Value::as_object_mut)
        .expect("section inserted above")
}

fn merge_defaults(raw: &Value) -> Value {
    let mut result = raw.clone();
    if !result.is_object() {
        result = json!({});
    }
    for name in ["deepseek", "harness", "chat"] {
        let defaults = defaults();
        let defaults = defaults.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
        let section = section_mut(&mut result, name);
        for (key, value) in defaults {
            section.entry(key).or_insert(value);
        }
    }
    result
}

#[cfg(windows)]
mod dpapi {
    use super::*;
    use std::ffi::c_void;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    struct OutputBlob(CRYPT_INTEGER_BLOB);

    impl Drop for OutputBlob {
        fn drop(&mut self) {
            if !self.0.pbData.is_null() {
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.0.pbData.cast::<c_void>())));
                }
            }
        }
    }

    pub fn encrypt(plain: &str) -> Result<String, String> {
        let bytes = plain.as_bytes();
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(bytes.len()).map_err(|_| "API Key 过长".to_string())?,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = OutputBlob(CRYPT_INTEGER_BLOB::default());
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
            .map_err(|e| format!("Windows DPAPI 加密失败：{e}"))?;
            if output.0.pbData.is_null() {
                return Err("Windows DPAPI 返回了空密文".into());
            }
            let encrypted = std::slice::from_raw_parts(output.0.pbData, output.0.cbData as usize);
            Ok(BASE64.encode(encrypted))
        }
    }

    pub fn decrypt(encoded: &str) -> Result<String, String> {
        let encrypted = BASE64
            .decode(encoded)
            .map_err(|_| "API Key 密文不是有效 base64".to_string())?;
        if encrypted.is_empty() {
            return Err("API Key 密文为空".into());
        }
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(encrypted.len()).map_err(|_| "API Key 密文过长".to_string())?,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let mut output = OutputBlob(CRYPT_INTEGER_BLOB::default());
        let mut description = PWSTR::null();
        unsafe {
            CryptUnprotectData(
                &input,
                Some(&mut description),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
            .map_err(|e| format!("Windows DPAPI 解密失败：{e}"))?;
            if !description.is_null() {
                let _ = LocalFree(Some(HLOCAL(description.0.cast::<c_void>())));
            }
            if output.0.pbData.is_null() {
                return Err("Windows DPAPI 返回了空明文".into());
            }
            let plain = std::slice::from_raw_parts(output.0.pbData, output.0.cbData as usize);
            String::from_utf8(plain.to_vec()).map_err(|_| "API Key 明文不是有效 UTF-8".into())
        }
    }
}

#[cfg(windows)]
fn encrypt_secret(plain: &str) -> Result<String, String> {
    dpapi::encrypt(plain)
}

#[cfg(not(windows))]
fn encrypt_secret(_plain: &str) -> Result<String, String> {
    Err("API Key 仅支持 Windows DPAPI 加密存储".into())
}

#[cfg(windows)]
fn decrypt_secret(encoded: &str) -> Result<String, String> {
    dpapi::decrypt(encoded)
}

#[cfg(not(windows))]
fn decrypt_secret(_encoded: &str) -> Result<String, String> {
    Err("API Key 仅支持 Windows DPAPI 解密".into())
}

fn secret_plain(section: &Map<String, Value>) -> Result<String, String> {
    // Read legacy Electron/plaintext settings for migration, but all new writes
    // are DPAPI-only.  No error or log includes the secret itself.
    if let Some(plain) = section.get("apiKey").and_then(Value::as_str) {
        if !plain.is_empty() {
            return Ok(plain.to_string());
        }
    }
    match section.get("apiKeyEnc").and_then(Value::as_str) {
        Some(encoded) if !encoded.is_empty() => decrypt_secret(encoded),
        _ => Ok(String::new()),
    }
}

fn effective_config(raw: &Value, strict_keys: bool) -> Result<Value, String> {
    let mut result = merge_defaults(raw);
    for name in ["deepseek", "chat"] {
        let key = secret_plain(section_mut(&mut result, name));
        let key = match (key, strict_keys) {
            (Ok(key), _) => key,
            (Err(_), false) => String::new(),
            (Err(error), true) => return Err(error),
        };
        let section = section_mut(&mut result, name);
        section.remove("apiKeyEnc");
        section.insert("apiKey".into(), Value::String(key));
    }
    Ok(result)
}

/// Effective in-process configuration for Harness.  Contains decrypted secrets.
/// Do not expose this value to the frontend and never log it.
pub fn current_config() -> Value {
    effective_config(&load_raw(), false).unwrap_or_else(|_| merge_defaults(&json!({})))
}

fn runtime_config() -> Result<Value, String> {
    effective_config(&load_raw(), true)
}

fn set_encrypted_secret(section: &mut Map<String, Value>, plain: &str) -> Result<(), String> {
    section.remove("apiKey");
    section.remove("apiKeyEnc");
    let plain = plain.trim();
    if !plain.is_empty() {
        let encrypted = encrypt_secret(plain)?;
        section.insert("apiKeyEnc".into(), Value::String(encrypted));
    }
    Ok(())
}

fn migrate_legacy_secret(section: &mut Map<String, Value>) -> Result<(), String> {
    let legacy = section
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !legacy.is_empty() {
        set_encrypted_secret(section, &legacy)?;
    } else {
        section.remove("apiKey");
    }
    Ok(())
}

fn endpoint_for(protocol: &str, base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("API 网址为空".into());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("API 网址必须以 http:// 或 https:// 开头".into());
    }
    let parsed = reqwest::Url::parse(base).map_err(|e| format!("API 网址无效：{e}"))?;
    if parsed.host_str().is_none() {
        return Err("API 网址缺少主机名".into());
    }
    if protocol == "anthropic" {
        if base.ends_with("/v1/messages") {
            Ok(base.to_string())
        } else if base.ends_with("/v1") {
            Ok(format!("{base}/messages"))
        } else {
            Ok(format!("{base}/v1/messages"))
        }
    } else if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

fn numeric_patch(value: &Value, default: u64) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn validate_chat_patch(section: &Map<String, Value>, existing: &Value) -> Result<(), String> {
    if let Some(backend) = section.get("backend").and_then(Value::as_str) {
        if !matches!(backend, "harness" | "api") {
            return Err(format!("未知的对话后端：{backend}"));
        }
    }
    if let Some(protocol) = section.get("protocol").and_then(Value::as_str) {
        if !matches!(protocol, "openai" | "anthropic") {
            return Err(format!("未知的接口格式：{protocol}"));
        }
    }
    if let Some(base) = section.get("baseUrl").and_then(Value::as_str) {
        if !base.trim().is_empty() {
            let protocol = section
                .get("protocol")
                .and_then(Value::as_str)
                .or_else(|| existing.get("protocol").and_then(Value::as_str))
                .unwrap_or("openai");
            endpoint_for(protocol, base)?;
        }
    }
    if let Some(temperature) = section.get("temperature") {
        let valid = match temperature {
            Value::String(s) if s.trim().is_empty() => true,
            Value::String(s) => s.trim().parse::<f64>().map(f64::is_finite).unwrap_or(false),
            Value::Number(n) => n.as_f64().map(f64::is_finite).unwrap_or(false),
            Value::Null => true,
            _ => false,
        };
        if !valid {
            return Err("temperature 必须是有限数字或空字符串".into());
        }
    }
    Ok(())
}

fn masked_section(raw: &Value, effective: &Value, name: &str) -> Value {
    let raw_section = raw.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
    let mut section = effective.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
    let key = section
        .remove("apiKey")
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    section.remove("apiKeyEnc");
    section.remove("keySet");
    section.remove("keyTail");
    section.remove("encrypted");
    section.insert("keySet".into(), Value::Bool(!key.is_empty()));
    section.insert(
        "keyTail".into(),
        Value::String(key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()),
    );
    section.insert(
        "encrypted".into(),
        Value::Bool(raw_section.get("apiKeyEnc").and_then(Value::as_str).is_some_and(|v| !v.is_empty())),
    );
    Value::Object(section)
}

#[tauri::command]
pub fn config_get(app: AppHandle) -> Value {
    init_config_dir(&app);
    let raw = load_raw();
    let effective = effective_config(&raw, false).unwrap_or_else(|_| merge_defaults(&raw));
    let harness = effective.get("harness").cloned().unwrap_or_else(|| json!({}));
    json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "deepseek": masked_section(&raw, &effective, "deepseek"),
        "harness": harness,
        "chat": masked_section(&raw, &effective, "chat"),
        "persona": { "activeId": active_persona_id() }
    })
}

#[tauri::command]
pub fn config_set(app: AppHandle, patch: Value) -> Value {
    init_config_dir(&app);
    let result = (|| {
        let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let raw = load_raw_unlocked();
        let mut next = merge_defaults(&raw);
        if !patch.is_object() {
            return Err("配置 patch 必须是对象".to_string());
        }

        if let Some(chat_patch) = patch.get("chat") {
            let chat_patch = chat_patch.as_object().ok_or_else(|| "chat 必须是对象".to_string())?;
            let existing = next.get("chat").cloned().unwrap_or_else(|| json!({}));
            validate_chat_patch(chat_patch, &existing)?;
            let target = section_mut(&mut next, "chat");
            for (key, value) in chat_patch {
                if matches!(key.as_str(), "apiKey" | "apiKeyEnc" | "keySet" | "keyTail" | "encrypted") {
                    continue;
                }
                target.insert(key.clone(), value.clone());
            }
            for (key, default) in [("maxTokens", 2048), ("historyTurns", 12), ("personaMaxChars", 6000)] {
                if let Some(value) = chat_patch.get(key) {
                    target.insert(key.into(), json!(numeric_patch(value, default)));
                }
            }
        }

        for name in ["deepseek", "harness"] {
            if let Some(update) = patch.get(name) {
                let update = update.as_object().ok_or_else(|| format!("{name} 必须是对象"))?;
                let target = section_mut(&mut next, name);
                for (key, value) in update {
                    if name == "deepseek" && matches!(key.as_str(), "apiKey" | "apiKeyEnc") {
                        continue;
                    }
                    target.insert(key.clone(), value.clone());
                }
            }
        }

        migrate_legacy_secret(section_mut(&mut next, "chat"))?;
        migrate_legacy_secret(section_mut(&mut next, "deepseek"))?;
        if let Some(key) = patch.get("chatApiKey").and_then(Value::as_str) {
            set_encrypted_secret(section_mut(&mut next, "chat"), key)?;
        }
        if let Some(key) = patch.get("apiKey").and_then(Value::as_str) {
            set_encrypted_secret(section_mut(&mut next, "deepseek"), key)?;
        }

        let mut bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        atomic_write(&settings_file(), &bytes)
    })();

    match result {
        Ok(()) => {
            cancel_active(&app);
            json!({ "ok": true, "restarted": true })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn valid_persona_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn active_persona_id() -> String {
    let root = config_dir();
    let value = fs::read_to_string(root.join("characters").join("active.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
    if valid_persona_id(id) && root.join("characters").join(format!("{id}.json")).is_file() {
        id.to_string()
    } else {
        String::new()
    }
}

fn history_file() -> PathBuf {
    let id = active_persona_id();
    if id.is_empty() {
        config_dir().join("chat-history.json")
    } else {
        config_dir().join("chat-history").join(format!("{id}.json"))
    }
}

fn load_history_unlocked(path: &Path) -> Vec<Value> {
    let values = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default();
    let start = values.len().saturating_sub(HISTORY_LIMIT);
    values[start..].to_vec()
}

fn save_history_unlocked(path: &Path, mut values: Vec<Value>) -> Result<(), String> {
    if values.len() > HISTORY_LIMIT {
        values = values[values.len() - HISTORY_LIMIT..].to_vec();
    }
    let bytes = serde_json::to_vec(&values).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes)
}

/// Append one entry to the active persona's history, retaining the last 200.
pub fn append_history(role: &str, text: &str) {
    let path = history_file();
    let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut history = load_history_unlocked(&path);
    history.push(json!({ "role": role, "text": text, "at": now_ms() }));
    let _ = save_history_unlocked(&path, history);
}

fn append_turn(path: &Path, user: &str, assistant: &str) -> Result<(), String> {
    let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut history = load_history_unlocked(path);
    history.push(json!({ "role": "user", "text": user, "at": now_ms() }));
    if !assistant.is_empty() {
        history.push(json!({ "role": "assistant", "text": assistant, "at": now_ms() }));
    }
    save_history_unlocked(path, history)
}

#[tauri::command]
pub fn chat_history(app: AppHandle) -> Value {
    init_config_dir(&app);
    let path = history_file();
    let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Value::Array(load_history_unlocked(&path))
}

#[tauri::command]
pub fn chat_clear(app: AppHandle) -> Value {
    init_config_dir(&app);
    let path = history_file();
    let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match save_history_unlocked(&path, Vec::new()) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn active_persona_card() -> Option<Value> {
    let id = active_persona_id();
    if id.is_empty() {
        return None;
    }
    fs::read_to_string(config_dir().join("characters").join(format!("{id}.json")))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn replace_card_vars(text: &str, character: &str, user: &str) -> String {
    text.replace("{{char}}", character).replace("{{user}}", user)
}

fn persona_system(card: &Value, user_name: &str, max_chars: usize) -> String {
    let data = card.get("data").unwrap_or(card);
    let field = |name: &str| data.get(name).and_then(Value::as_str).unwrap_or_default();
    let name = field("name").trim();
    let character = if name.is_empty() { "猫鲸" } else { name };
    let mut parts = Vec::new();
    let explicit = replace_card_vars(field("system_prompt").trim(), character, user_name);
    if !explicit.is_empty() {
        parts.push(explicit);
    } else {
        parts.push(DEFAULT_SYSTEM.to_string());
    }
    for (label, value) in [
        ("角色名", character.to_string()),
        ("角色描述", replace_card_vars(field("description").trim(), character, user_name)),
        ("性格", replace_card_vars(field("personality").trim(), character, user_name)),
        ("场景", replace_card_vars(field("scenario").trim(), character, user_name)),
        ("补充要求", replace_card_vars(field("post_history_instructions").trim(), character, user_name)),
    ] {
        if !value.is_empty() {
            parts.push(format!("【{label}】\n{value}"));
        }
    }
    parts
        .join("\n\n")
        .chars()
        .take(max_chars.clamp(100, 50_000))
        .collect()
}

fn build_history_messages(path: &Path, prompt: &str, chat: &Value) -> Vec<Value> {
    let history = {
        let _guard = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_history_unlocked(path)
    };
    let turns = chat
        .get("historyTurns")
        .map(|v| numeric_patch(v, 12))
        .unwrap_or(12)
        .clamp(0, 100) as usize;
    let user_name = chat.get("userName").and_then(Value::as_str).unwrap_or_default();
    let max_chars = chat
        .get("personaMaxChars")
        .map(|v| numeric_patch(v, 6000))
        .unwrap_or(6000) as usize;
    let system = active_persona_card()
        .map(|card| persona_system(&card, user_name, max_chars))
        .unwrap_or_else(|| DEFAULT_SYSTEM.to_string());
    let mut messages = vec![json!({ "role": "system", "content": system })];
    let start = history.len().saturating_sub(turns.saturating_mul(2));
    for entry in &history[start..] {
        let role = entry.get("role").and_then(Value::as_str).unwrap_or_default();
        let text = entry.get("text").and_then(Value::as_str).unwrap_or_default();
        if matches!(role, "user" | "assistant" | "system") && !text.is_empty() {
            messages.push(json!({ "role": role, "content": text }));
        }
    }
    messages.push(json!({ "role": "user", "content": prompt }));
    messages
}

#[derive(Clone)]
struct ApiJob {
    generation: u64,
    cancel: Arc<AtomicBool>,
    protocol: String,
    model: String,
    started_at: u64,
    emit_events: bool,
}

impl ApiJob {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire) || GENERATION.load(Ordering::Acquire) != self.generation
    }
}

fn active_job() -> Option<ApiJob> {
    ACTIVE_JOB.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn begin_job(protocol: &str, model: &str, emit_events: bool) -> Result<ApiJob, String> {
    let mut active = ACTIVE_JOB.lock().unwrap_or_else(|e| e.into_inner());
    if active.is_some() {
        return Err("上一条还在生成".into());
    }
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let job = ApiJob {
        generation,
        cancel: Arc::new(AtomicBool::new(false)),
        protocol: protocol.to_string(),
        model: model.to_string(),
        started_at: now_ms(),
        emit_events,
    };
    *active = Some(job.clone());
    Ok(job)
}

fn finish_job(job: &ApiJob) {
    let mut active = ACTIVE_JOB.lock().unwrap_or_else(|e| e.into_inner());
    if active.as_ref().is_some_and(|current| current.generation == job.generation) {
        *active = None;
    }
}

fn emit_status(app: &AppHandle, job: &ApiJob, state: &str) {
    if !job.emit_events || job.cancelled() {
        return;
    }
    let _ = app.emit(
        "harness:status",
        json!({
            "state": state,
            "info": { "provider": job.protocol, "model": job.model }
        }),
    );
}

fn emit_event(app: &AppHandle, job: &ApiJob, event: Value) {
    if !job.emit_events || job.cancelled() {
        return;
    }
    let _ = app.emit("harness:event", event);
}

fn cancel_active(app: &AppHandle) -> bool {
    let mut active = ACTIVE_JOB.lock().unwrap_or_else(|e| e.into_inner());
    let Some(job) = active.take() else {
        return false;
    };
    job.cancel.store(true, Ordering::Release);
    GENERATION.fetch_add(1, Ordering::AcqRel);
    if job.emit_events {
        // Emit before releasing ACTIVE_JOB so a new turn cannot race these old
        // terminal events with its initial running status.
        let _ = app.emit(
            "harness:event",
            json!({ "kind": "turnEnd", "reason": { "kind": "cancelled" } }),
        );
        let _ = app.emit(
            "harness:status",
            json!({
                "state": "idle",
                "info": { "provider": job.protocol, "model": job.model }
            }),
        );
    }
    true
}

struct ApiRequest {
    protocol: String,
    url: String,
    model: String,
    api_key: String,
    max_tokens: u64,
    temperature: Option<f64>,
    messages: Vec<Value>,
}

impl Drop for ApiRequest {
    fn drop(&mut self) {
        // Best-effort clearing of the owned copy; reqwest header copies are
        // separately managed by rustls/reqwest and are never logged here.
        if !self.api_key.is_empty() {
            unsafe {
                self.api_key.as_bytes_mut().fill(0);
            }
        }
    }
}

fn prepare_request(chat: &Value, messages: Vec<Value>) -> Result<ApiRequest, String> {
    let protocol = chat.get("protocol").and_then(Value::as_str).unwrap_or("openai");
    if !matches!(protocol, "openai" | "anthropic") {
        return Err(format!("未知的接口格式：{protocol}"));
    }
    let base_url = chat.get("baseUrl").and_then(Value::as_str).unwrap_or_default();
    if base_url.trim().is_empty() {
        return Err("还没填 API 网址（设置 → 对话后端）".into());
    }
    let model = chat.get("model").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if model.is_empty() {
        return Err("还没填模型名（设置 → 对话后端）".into());
    }
    let api_key = chat.get("apiKey").and_then(Value::as_str).unwrap_or_default().to_string();
    let max_tokens = chat
        .get("maxTokens")
        .map(|v| numeric_patch(v, 2048))
        .unwrap_or(2048)
        .clamp(16, 200_000);
    let temperature = match chat.get("temperature") {
        Some(Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        _ => None,
    };
    Ok(ApiRequest {
        protocol: protocol.to_string(),
        url: endpoint_for(protocol, base_url)?,
        model,
        api_key,
        max_tokens,
        temperature,
        messages,
    })
}

fn request_body(request: &ApiRequest) -> Value {
    let mut body = if request.protocol == "anthropic" {
        let system = request
            .messages
            .iter()
            .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
            .filter_map(|m| m.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut conversation: Vec<Value> = Vec::new();
        for message in &request.messages {
            let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
            if role == "system" {
                continue;
            }
            let content = message.get("content").and_then(Value::as_str).unwrap_or_default();
            if content.is_empty() {
                continue;
            }
            let role = if role == "assistant" { "assistant" } else { "user" };
            if let Some(last) = conversation.last_mut() {
                if last.get("role").and_then(Value::as_str) == Some(role) {
                    let previous = last.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
                    last["content"] = Value::String(format!("{previous}\n\n{content}"));
                    continue;
                }
            }
            conversation.push(json!({ "role": role, "content": content }));
        }
        if conversation.first().and_then(|m| m.get("role")).and_then(Value::as_str) != Some("user") {
            conversation.insert(0, json!({ "role": "user", "content": "（开始）" }));
        }
        let mut body = json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "stream": true,
            "messages": conversation
        });
        if !system.is_empty() {
            body["system"] = Value::String(system);
        }
        body
    } else {
        json!({
            "model": request.model,
            "stream": true,
            "max_tokens": request.max_tokens,
            "messages": request.messages,
            "stream_options": { "include_usage": true }
        })
    };
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    body
}

#[derive(Debug)]
struct ApiError {
    message: String,
    cancelled: bool,
}

impl ApiError {
    fn error(message: impl Into<String>) -> Self {
        Self { message: message.into(), cancelled: false }
    }

    fn cancelled() -> Self {
        Self { message: "已取消".into(), cancelled: true }
    }
}

struct ApiSuccess {
    text: String,
    usage: Value,
    ms: u64,
}

struct ApiFailure {
    error: ApiError,
    text: String,
    usage: Value,
    ms: u64,
}

fn check_cancel(job: &ApiJob) -> Result<(), ApiError> {
    if job.cancelled() {
        Err(ApiError::cancelled())
    } else {
        Ok(())
    }
}

fn redact_error(message: String, api_key: &str) -> String {
    if api_key.is_empty() {
        message
    } else {
        message.replace(api_key, "[REDACTED]")
    }
}

fn read_some(response: &mut Response, buffer: &mut [u8], job: &ApiJob) -> Result<usize, ApiError> {
    check_cancel(job)?;
    let read = response.read(buffer);
    check_cancel(job)?;
    read.map_err(|e| {
        if job.cancelled() {
            ApiError::cancelled()
        } else {
            ApiError::error(format!("读取响应失败：{e}"))
        }
    })
}

fn read_json_body(response: &mut Response, job: &ApiJob, limit: usize) -> Result<Vec<u8>, ApiError> {
    let mut body = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = read_some(response, &mut buffer, job)?;
        if count == 0 {
            break;
        }
        if body.len().saturating_add(count) > limit {
            return Err(ApiError::error("模型响应过大"));
        }
        body.extend_from_slice(&buffer[..count]);
    }
    Ok(body)
}

fn response_error(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    error
        .get("message")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| error.as_str().map(str::to_string))
        .or_else(|| Some(error.to_string()))
}

fn merge_usage(target: &mut Value, incoming: Value) {
    if !target.is_object() {
        *target = json!({});
    }
    if let (Some(target), Some(incoming)) = (target.as_object_mut(), incoming.as_object()) {
        for (key, value) in incoming {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn openai_usage(value: &Value) -> Option<Value> {
    let usage = value.get("usage")?;
    Some(json!({
        "inputTokens": usage.get("prompt_tokens").cloned().unwrap_or(Value::Null),
        "outputTokens": usage.get("completion_tokens").cloned().unwrap_or(Value::Null)
    }))
}

fn emit_text(app: &AppHandle, job: &ApiJob, text: &mut String, delta: &str) {
    if delta.is_empty() {
        return;
    }
    text.push_str(delta);
    emit_event(app, job, json!({ "kind": "delta", "text": delta }));
}

fn process_sse_payload(
    app: &AppHandle,
    job: &ApiJob,
    protocol: &str,
    payload: &str,
    text: &mut String,
    usage: &mut Value,
) -> Result<bool, ApiError> {
    check_cancel(job)?;
    if payload.trim() == "[DONE]" {
        return Ok(true);
    }
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return Ok(false);
    };
    if let Some(error) = response_error(&value) {
        return Err(ApiError::error(error));
    }
    if protocol == "anthropic" {
        match value.get("type").and_then(Value::as_str).unwrap_or_default() {
            "content_block_delta" => {
                let delta = value.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text_delta" => {
                        let part = delta.get("text").and_then(Value::as_str).unwrap_or_default();
                        emit_text(app, job, text, part);
                    }
                    "thinking_delta" => {
                        let reasoning = delta.get("thinking").and_then(Value::as_str).unwrap_or_default();
                        if !reasoning.is_empty() {
                            emit_event(app, job, json!({ "kind": "reasoning", "text": reasoning }));
                        }
                    }
                    _ => {}
                }
            }
            "message_start" => {
                if let Some(tokens) = value
                    .get("message")
                    .and_then(|m| m.get("usage"))
                    .and_then(|u| u.get("input_tokens"))
                {
                    let incoming = json!({ "inputTokens": tokens });
                    merge_usage(usage, incoming.clone());
                    emit_event(app, job, json!({ "kind": "usage", "usage": usage.clone() }));
                }
            }
            "message_delta" => {
                if let Some(tokens) = value.get("usage").and_then(|u| u.get("output_tokens")) {
                    let incoming = json!({ "outputTokens": tokens });
                    merge_usage(usage, incoming.clone());
                    emit_event(app, job, json!({ "kind": "usage", "usage": usage.clone() }));
                }
            }
            "message_stop" => return Ok(true),
            _ => {}
        }
        return Ok(false);
    }

    let choice = value.get("choices").and_then(Value::as_array).and_then(|v| v.first()).cloned().unwrap_or(Value::Null);
    let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
    if let Some(part) = delta.get("content").and_then(Value::as_str) {
        emit_text(app, job, text, part);
    }
    if let Some(reasoning) = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(Value::as_str)
    {
        if !reasoning.is_empty() {
            emit_event(app, job, json!({ "kind": "reasoning", "text": reasoning }));
        }
    }
    if let Some(incoming) = openai_usage(&value) {
        merge_usage(usage, incoming.clone());
        emit_event(app, job, json!({ "kind": "usage", "usage": usage.clone() }));
    }
    Ok(false)
}

struct SseParser {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
}

impl SseParser {
    fn new() -> Self {
        Self { buffer: Vec::new(), data_lines: Vec::new() }
    }

    fn process_line(&mut self, mut line: Vec<u8>) -> Option<String> {
        if line.ends_with(b"\n") {
            line.pop();
        }
        if line.ends_with(b"\r") {
            line.pop();
        }
        if line.is_empty() {
            if self.data_lines.is_empty() {
                return None;
            }
            return Some(std::mem::take(&mut self.data_lines).join("\n"));
        }
        if line.starts_with(b"data:") {
            let mut data = &line[5..];
            if data.starts_with(b" ") {
                data = &data[1..];
            }
            self.data_lines.push(String::from_utf8_lossy(data).into_owned());
        }
        None
    }

    fn feed(&mut self, bytes: &[u8], mut on_data: impl FnMut(String) -> Result<bool, ApiError>) -> Result<bool, ApiError> {
        if self.buffer.len().saturating_add(bytes.len()) > MAX_SSE_LINE {
            return Err(ApiError::error("SSE 事件过大"));
        }
        self.buffer.extend_from_slice(bytes);
        while let Some(newline) = self.buffer.iter().position(|b| *b == b'\n') {
            let line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            if let Some(data) = self.process_line(line) {
                if on_data(data)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn finish(&mut self, mut on_data: impl FnMut(String) -> Result<bool, ApiError>) -> Result<bool, ApiError> {
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            if let Some(data) = self.process_line(line) {
                if on_data(data)? {
                    return Ok(true);
                }
            }
        }
        if !self.data_lines.is_empty() {
            let data = std::mem::take(&mut self.data_lines).join("\n");
            return on_data(data);
        }
        Ok(false)
    }
}

fn parse_non_sse(
    app: &AppHandle,
    job: &ApiJob,
    protocol: &str,
    value: &Value,
    text: &mut String,
    usage: &mut Value,
) -> Result<(), ApiError> {
    if let Some(error) = response_error(value) {
        return Err(ApiError::error(error));
    }
    if protocol == "anthropic" {
        let combined = value
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        emit_text(app, job, text, &combined);
        if let Some(tokens) = value.get("usage") {
            let incoming = json!({
                "inputTokens": tokens.get("input_tokens").cloned().unwrap_or(Value::Null),
                "outputTokens": tokens.get("output_tokens").cloned().unwrap_or(Value::Null)
            });
            merge_usage(usage, incoming.clone());
            emit_event(app, job, json!({ "kind": "usage", "usage": usage.clone() }));
        }
    } else {
        let choice = value.get("choices").and_then(Value::as_array).and_then(|v| v.first()).cloned().unwrap_or(Value::Null);
        let message = choice.get("message").cloned().unwrap_or(Value::Null);
        let content = message.get("content").and_then(Value::as_str).unwrap_or_default();
        emit_text(app, job, text, content);
        if let Some(reasoning) = message
            .get("reasoning_content")
            .or_else(|| message.get("reasoning"))
            .and_then(Value::as_str)
        {
            if !reasoning.is_empty() {
                emit_event(app, job, json!({ "kind": "reasoning", "text": reasoning }));
            }
        }
        if let Some(incoming) = openai_usage(value) {
            merge_usage(usage, incoming.clone());
            emit_event(app, job, json!({ "kind": "usage", "usage": usage.clone() }));
        }
    }
    Ok(())
}

fn execute_request(app: &AppHandle, job: &ApiJob, request: ApiRequest) -> Result<ApiSuccess, ApiFailure> {
    let started = Instant::now();
    let mut text = String::new();
    let mut usage = json!({});
    let api_key = request.api_key.clone();
    let result = (|| {
        check_cancel(job)?;
        emit_event(
            app,
            job,
            json!({ "kind": "route", "provider": request.protocol, "model": request.model }),
        );
        let client = Client::builder()
            .user_agent(concat!("catwhale-pet/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| ApiError::error(format!("创建 HTTP 客户端失败：{e}")))?;
        let mut builder = client
            .post(&request.url)
            .header(ACCEPT, "text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .json(&request_body(&request));
        if !request.api_key.is_empty() {
            if request.protocol == "anthropic" {
                builder = builder.header("x-api-key", &request.api_key).header("anthropic-version", "2023-06-01");
            } else {
                builder = builder.header("Authorization", format!("Bearer {}", request.api_key));
            }
        }
        let mut response = builder.send().map_err(|e| {
            if job.cancelled() {
                ApiError::cancelled()
            } else {
                ApiError::error(format!("API 请求失败：{e}"))
            }
        })?;
        check_cancel(job)?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_json_body(&mut response, job, 64 * 1024)?;
            let detail = String::from_utf8_lossy(&body).chars().take(400).collect::<String>();
            return Err(ApiError::error(if detail.trim().is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}：{detail}")
            }));
        }
        let event_stream = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
        if event_stream {
            let mut parser = SseParser::new();
            let mut buffer = [0u8; 8192];
            let mut done = false;
            while !done {
                let count = read_some(&mut response, &mut buffer, job)?;
                if count == 0 {
                    break;
                }
                done = parser.feed(&buffer[..count], |data| {
                    process_sse_payload(app, job, &request.protocol, &data, &mut text, &mut usage)
                })?;
            }
            if !done {
                parser.finish(|data| {
                    process_sse_payload(app, job, &request.protocol, &data, &mut text, &mut usage)
                })?;
            }
        } else {
            let body = read_json_body(&mut response, job, MAX_JSON_BODY)?;
            let value = serde_json::from_slice::<Value>(&body)
                .map_err(|e| ApiError::error(format!("模型返回的不是有效 JSON：{e}")))?;
            parse_non_sse(app, job, &request.protocol, &value, &mut text, &mut usage)?;
        }
        check_cancel(job)?;
        if text.is_empty() {
            return Err(ApiError::error("模型返回为空"));
        }
        emit_event(app, job, json!({ "kind": "message", "text": text, "usage": usage }));
        Ok(())
    })();

    let ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(()) => Ok(ApiSuccess { text, usage, ms }),
        Err(mut error) => {
            error.message = redact_error(error.message, &api_key);
            Err(ApiFailure { error, text, usage, ms })
        }
    }
}

fn run_chat_worker(app: AppHandle, job: ApiJob, request: ApiRequest, history_path: PathBuf, prompt: String) {
    emit_status(&app, &job, "running");
    let result = execute_request(&app, &job, request);
    if !job.cancelled() {
        match result {
            Ok(success) => {
                let terminal = match append_turn(&history_path, &prompt, &success.text) {
                    Ok(()) => json!({ "kind": "turnEnd", "reason": { "kind": "completed" } }),
                    Err(error) => json!({
                        "kind": "turnEnd",
                        "reason": {
                            "kind": "error",
                            "error": { "message": format!("保存聊天历史失败：{error}") }
                        }
                    }),
                };
                // History is written before turnEnd, matching the Electron IPC
                // contract: a renderer refresh in turnEnd sees the complete turn.
                emit_event(&app, &job, terminal);
                emit_status(&app, &job, "idle");
            }
            Err(failure) => {
                emit_event(
                    &app,
                    &job,
                    json!({
                        "kind": "turnEnd",
                        "reason": {
                            "kind": if failure.error.cancelled { "cancelled" } else { "error" },
                            "error": { "message": failure.error.message }
                        }
                    }),
                );
                emit_status(&app, &job, "idle");
            }
        }
    }
    finish_job(&job);
}

pub fn direct_chat(app: AppHandle, payload: Value) -> Value {
    init_config_dir(&app);
    let config = match runtime_config() {
        Ok(config) => config,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let chat = config.get("chat").cloned().unwrap_or_else(|| json!({}));
    let backend = chat.get("backend").and_then(Value::as_str).unwrap_or("harness");
    if backend != "api" {
        return json!({
            "ok": false,
            "code": "HARNESS_REQUIRED",
            "error": "HARNESS_REQUIRED",
            "backend": "harness"
        });
    }
    let prompt = if payload.is_string() {
        payload.as_str().unwrap_or_default().to_string()
    } else {
        payload.get("prompt").and_then(Value::as_str).unwrap_or_default().to_string()
    };
    if prompt.trim().is_empty() {
        return json!({ "ok": false, "error": "消息为空" });
    }
    let history_path = history_file();
    let messages = build_history_messages(&history_path, &prompt, &chat);
    let request = match prepare_request(&chat, messages) {
        Ok(request) => request,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let job = match begin_job(&request.protocol, &request.model, true) {
        Ok(job) => job,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let generation = job.generation;
    let worker_app = app.clone();
    let worker_job = job.clone();
    let spawn = std::thread::Builder::new()
        .name(format!("catwhale-api-{generation}"))
        .spawn(move || run_chat_worker(worker_app, worker_job, request, history_path, prompt));
    if let Err(error) = spawn {
        finish_job(&job);
        return json!({ "ok": false, "error": format!("无法启动 API 请求线程：{error}") });
    }
    json!({ "ok": true, "streaming": true, "backend": "api", "generation": generation })
}

#[tauri::command]
pub async fn config_test(app: AppHandle) -> Value {
    init_config_dir(&app);
    let config = match runtime_config() {
        Ok(config) => config,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let chat = config.get("chat").cloned().unwrap_or_else(|| json!({}));
    if chat.get("backend").and_then(Value::as_str).unwrap_or("harness") != "api" {
        return json!({
            "ok": false,
            "code": "HARNESS_REQUIRED",
            "error": "HARNESS_REQUIRED",
            "backend": "harness"
        });
    }
    let request = match prepare_request(&chat, vec![json!({ "role": "user", "content": "只回答两个字：正常" })]) {
        Ok(request) => request,
        Err(error) => return json!({ "ok": false, "error": error, "backend": "api" }),
    };
    let model = request.model.clone();
    let job = match begin_job(&request.protocol, &request.model, false) {
        Ok(job) => job,
        Err(error) => return json!({ "ok": false, "error": error, "backend": "api" }),
    };
    let worker_app = app.clone();
    let worker_job = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = execute_request(&worker_app, &worker_job, request);
        finish_job(&worker_job);
        result
    })
    .await;
    match result {
        Ok(Ok(success)) => json!({
            "ok": true,
            "text": success.text,
            "usage": success.usage,
            "ms": success.ms,
            "model": model,
            "backend": "api"
        }),
        Ok(Err(failure)) => json!({
            "ok": false,
            "text": failure.text,
            "usage": failure.usage,
            "error": failure.error.message,
            "cancelled": failure.error.cancelled,
            "ms": failure.ms,
            "model": model,
            "backend": "api"
        }),
        Err(error) => {
            finish_job(&job);
            json!({ "ok": false, "error": error.to_string(), "model": model, "backend": "api" })
        }
    }
}

pub fn direct_cancel(app: AppHandle) -> Value {
    init_config_dir(&app);
    if cancel_active(&app) {
        return json!({ "ok": true, "backend": "api", "cancelled": true });
    }
    let config = current_config();
    let backend = config
        .get("chat")
        .and_then(|chat| chat.get("backend"))
        .and_then(Value::as_str)
        .unwrap_or("harness");
    if backend == "harness" {
        json!({
            "ok": false,
            "code": "HARNESS_REQUIRED",
            "error": "HARNESS_REQUIRED",
            "backend": "harness"
        })
    } else {
        json!({ "ok": false, "error": "当前没有在跑的 API 请求", "backend": "api" })
    }
}

pub fn direct_status(app: AppHandle) -> Value {
    init_config_dir(&app);
    let config = current_config();
    let chat = config.get("chat").cloned().unwrap_or_else(|| json!({}));
    let backend = chat.get("backend").and_then(Value::as_str).unwrap_or("harness");
    let job = active_job();
    let persona = active_persona_id();
    json!({
        "alive": job.is_some(),
        "ready": backend == "api",
        "running": job.is_some(),
        "state": if job.is_some() { "running" } else { "idle" },
        "sessionId": Value::Null,
        "provider": job.as_ref().map(|j| j.protocol.clone()).unwrap_or_else(|| chat.get("protocol").and_then(Value::as_str).unwrap_or_default().to_string()),
        "model": job.as_ref().map(|j| j.model.clone()).unwrap_or_else(|| chat.get("model").and_then(Value::as_str).unwrap_or_default().to_string()),
        "generation": job.as_ref().map(|j| j.generation),
        "startedAt": job.as_ref().map(|j| j.started_at),
        "backend": backend,
        "harnessRequired": backend == "harness",
        "apiModel": chat.get("model").and_then(Value::as_str).unwrap_or_default(),
        "apiProtocol": chat.get("protocol").and_then(Value::as_str).unwrap_or_default(),
        "configured": !chat.get("baseUrl").and_then(Value::as_str).unwrap_or_default().trim().is_empty()
            && !chat.get("model").and_then(Value::as_str).unwrap_or_default().trim().is_empty(),
        "persona": if persona.is_empty() { Value::Null } else { json!({ "id": persona }) }
    })
}
