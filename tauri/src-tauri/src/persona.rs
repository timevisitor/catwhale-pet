//! Local Character Card store (V1/V2/V3 JSON and SillyTavern PNG).
//!
//! Only persona fields cross this module's API boundary.  Unknown JSON fields,
//! extensions, chat history, local settings and credentials are never returned or
//! exported.  Export deliberately takes a frontend-selected path; an empty path is
//! reported as `NEED_PATH`, never as a successful save.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_FIELD: usize = 20_000;
const MAX_CARD_BYTES: usize = 8 * 1024 * 1024;
const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const FALLBACK_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CharacterCard {
    pub name: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub first_mes: String,
    pub mes_example: String,
    pub creator_notes: String,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub alternate_greetings: Vec<String>,
    pub tags: Vec<String>,
    pub creator: String,
    pub character_version: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn failure(error: impl Into<String>) -> Value {
    json!({ "ok": false, "error": error.into() })
}

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("characters"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn file_of(app: &AppHandle, id: &str, extension: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("非法角色 id".into());
    }
    Ok(store_dir(app)?.join(format!("{id}{extension}")))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "目标路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    let result = (|| {
        let mut file = File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.replace("\r\n", "\n").chars().take(limit).collect()
}

fn value_string(value: Option<&Value>, limit: usize) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(v)) => v.to_string(),
        Some(Value::Array(_)) => String::new(),
        Some(Value::Object(_)) => String::new(),
    };
    truncate_chars(&text, limit)
}

fn first_value<'a>(data: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| data.get(*key)).filter(|value| {
        match value {
            Value::String(s) => !s.is_empty(),
            Value::Null => false,
            _ => true,
        }
    })
}

/// Convert V1/V2/V3 input into the persona-only internal representation.
pub fn normalize_card(raw: &Value) -> Result<CharacterCard, String> {
    let root = raw.as_object().ok_or_else(|| "不是有效的角色卡 JSON".to_string())?;
    let data = if matches!(root.get("spec").and_then(Value::as_str), Some("chara_card_v2" | "chara_card_v3"))
        && root.get("data").and_then(Value::as_object).is_some()
    {
        root.get("data").and_then(Value::as_object).expect("checked")
    } else if root
        .get("data")
        .and_then(Value::as_object)
        .and_then(|d| d.get("name"))
        .is_some()
    {
        root.get("data").and_then(Value::as_object).expect("checked")
    } else {
        root
    };
    let string = |keys: &[&str], limit: usize| value_string(first_value(data, keys), limit);
    let list = |key: &str, count: usize, limit: usize, drop_empty: bool| {
        data.get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(count)
                    .map(|value| value_string(Some(value), limit))
                    .filter(|value| !drop_empty || !value.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let card = CharacterCard {
        name: string(&["name", "char_name"], 80).trim().to_string(),
        description: string(&["description", "char_persona"], MAX_FIELD),
        personality: string(&["personality"], MAX_FIELD),
        scenario: string(&["scenario", "world_scenario"], MAX_FIELD),
        first_mes: string(&["first_mes", "char_greeting"], MAX_FIELD),
        mes_example: string(&["mes_example", "example_dialogue"], MAX_FIELD),
        creator_notes: string(&["creator_notes", "creatorcomment"], MAX_FIELD),
        system_prompt: string(&["system_prompt"], MAX_FIELD),
        post_history_instructions: string(&["post_history_instructions"], MAX_FIELD),
        alternate_greetings: list("alternate_greetings", 20, MAX_FIELD, false),
        tags: list("tags", 30, 40, true),
        creator: string(&["creator"], 80),
        character_version: string(&["character_version"], 40),
    };
    if card.name.is_empty() {
        return Err("角色卡缺少 name（角色名）".into());
    }
    if card.description.is_empty() && card.personality.is_empty() && card.system_prompt.is_empty() {
        return Err("角色卡没有任何人设内容（description / personality / system_prompt 都为空）".into());
    }
    Ok(card)
}

fn card_data(card: &CharacterCard) -> Map<String, Value> {
    let mut data = serde_json::to_value(card)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    data.insert(
        "extensions".into(),
        json!({ "catwhale": { "kind": "persona-only", "exportedBy": "catwhale-pet" } }),
    );
    data
}

pub fn to_v2(card: &Value) -> Result<Value, String> {
    let card = normalize_card(card)?;
    Ok(json!({
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": Value::Object(card_data(&card)),
    }))
}

fn to_v3(card: &CharacterCard) -> Value {
    let mut data = card_data(card);
    data.insert("group_only_greetings".into(), json!([]));
    json!({ "spec": "chara_card_v3", "spec_version": "3.0", "data": Value::Object(data) })
}

#[derive(Clone)]
struct PngChunk {
    kind: [u8; 4],
    data: Vec<u8>,
}

fn read_png_chunks(bytes: &[u8]) -> Result<Vec<PngChunk>, String> {
    if bytes.len() < 8 || bytes[..8] != PNG_SIG {
        return Err("不是 PNG 文件".into());
    }
    let mut chunks = Vec::new();
    let mut offset = 8usize;
    let mut ended = false;
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().expect("four bytes")) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|v| v.checked_add(length))
            .ok_or_else(|| "PNG 块长度溢出".to_string())?;
        if end > bytes.len() {
            return Err("PNG 已损坏（块越界）".into());
        }
        let kind: [u8; 4] = bytes[offset + 4..offset + 8].try_into().expect("four bytes");
        chunks.push(PngChunk { kind, data: bytes[offset + 8..offset + 8 + length].to_vec() });
        offset = end;
        if &kind == b"IEND" {
            ended = true;
            break;
        }
    }
    if !ended {
        return Err("PNG 已损坏（缺 IEND）".into());
    }
    Ok(chunks)
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|b| char::from(*b)).collect()
}

fn inflate_limited(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    ZlibDecoder::new(bytes)
        .take((MAX_CARD_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|e| format!("压缩文本块损坏：{e}"))?;
    if output.len() > MAX_CARD_BYTES {
        return Err("PNG 文本块解压后超过 8MB".into());
    }
    Ok(output)
}

fn png_text_entries(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
    let mut result = HashMap::new();
    let Ok(chunks) = read_png_chunks(bytes) else { return result };
    for chunk in chunks {
        let parsed: Option<(String, Vec<u8>)> = match &chunk.kind {
            b"tEXt" => chunk.data.iter().position(|b| *b == 0).map(|split| {
                (latin1(&chunk.data[..split]), chunk.data[split + 1..].to_vec())
            }),
            b"zTXt" => chunk.data.iter().position(|b| *b == 0).and_then(|split| {
                if chunk.data.get(split + 1) != Some(&0) {
                    return None;
                }
                inflate_limited(&chunk.data[split + 2..])
                    .ok()
                    .map(|text| (latin1(&chunk.data[..split]), text))
            }),
            b"iTXt" => (|| {
                let split = chunk.data.iter().position(|b| *b == 0)?;
                let compressed = *chunk.data.get(split + 1)?;
                let method = *chunk.data.get(split + 2)?;
                if compressed > 1 || (compressed == 1 && method != 0) {
                    return None;
                }
                let after_language = chunk.data[split + 3..].iter().position(|b| *b == 0)? + split + 4;
                let after_translated = chunk.data[after_language..].iter().position(|b| *b == 0)? + after_language + 1;
                let body = &chunk.data[after_translated..];
                let text = if compressed == 1 { inflate_limited(body).ok()? } else { body.to_vec() };
                Some((latin1(&chunk.data[..split]), text))
            })(),
            _ => None,
        };
        if let Some((keyword, text)) = parsed {
            result.insert(keyword.to_lowercase(), text);
        }
    }
    result
}

fn decode_base64_json(bytes: &[u8]) -> Result<Value, String> {
    let compact: Vec<u8> = bytes.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
    let decoded = BASE64.decode(compact).map_err(|e| format!("角色卡 base64 无效：{e}"))?;
    if decoded.len() > MAX_CARD_BYTES {
        return Err("角色卡 JSON 超过 8MB".into());
    }
    serde_json::from_slice(&decoded).map_err(|e| format!("角色卡 JSON 无效：{e}"))
}

pub fn card_from_png(bytes: &[u8]) -> Result<CharacterCard, String> {
    let entries = png_text_entries(bytes);
    let encoded = entries.get("ccv3").or_else(|| entries.get("chara"))
        .ok_or_else(|| "这张 PNG 里没有角色卡数据（缺 chara / ccv3 文本块）".to_string())?;
    normalize_card(&decode_base64_json(encoded)?)
}

fn png_chunk(kind: &[u8; 4], data: &[u8], output: &mut Vec<u8>) -> Result<(), String> {
    let length = u32::try_from(data.len()).map_err(|_| "PNG 文本块过大".to_string())?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(kind);
    output.extend_from_slice(data);
    let mut checksum_data = Vec::with_capacity(4 + data.len());
    checksum_data.extend_from_slice(kind);
    checksum_data.extend_from_slice(data);
    output.extend_from_slice(&crc32fast::hash(&checksum_data).to_be_bytes());
    Ok(())
}

fn text_keyword(chunk: &PngChunk) -> String {
    chunk
        .data
        .iter()
        .position(|b| *b == 0)
        .map(|split| latin1(&chunk.data[..split]).to_lowercase())
        .unwrap_or_default()
}

pub fn card_to_png(card: &CharacterCard, png: &[u8]) -> Result<Vec<u8>, String> {
    let chunks = read_png_chunks(png)?;
    let v2 = json!({
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": Value::Object(card_data(card)),
    });
    let v3 = to_v3(card);
    let v2_text = BASE64.encode(serde_json::to_vec(&v2).map_err(|e| e.to_string())?);
    let v3_text = BASE64.encode(serde_json::to_vec(&v3).map_err(|e| e.to_string())?);
    let chara = [b"chara\0".as_slice(), v2_text.as_bytes()].concat();
    let ccv3 = [b"ccv3\0".as_slice(), v3_text.as_bytes()].concat();
    let mut output = Vec::with_capacity(png.len() + chara.len() + ccv3.len() + 24);
    output.extend_from_slice(&PNG_SIG);
    for chunk in chunks {
        let is_card_text = matches!(&chunk.kind, b"tEXt" | b"zTXt" | b"iTXt")
            && matches!(text_keyword(&chunk).as_str(), "chara" | "ccv3");
        if is_card_text {
            continue;
        }
        if &chunk.kind == b"IEND" {
            png_chunk(b"tEXt", &chara, &mut output)?;
            png_chunk(b"tEXt", &ccv3, &mut output)?;
        }
        png_chunk(&chunk.kind, &chunk.data, &mut output)?;
    }
    Ok(output)
}

pub fn parse_card_file(bytes: &[u8]) -> Result<(CharacterCard, &'static str), String> {
    if bytes.len() > MAX_CARD_BYTES {
        return Err("文件过大（>8MB），不像角色卡".into());
    }
    if bytes.starts_with(&PNG_SIG) {
        return card_from_png(bytes).map(|card| (card, "png"));
    }
    let text = std::str::from_utf8(bytes).map_err(|e| format!("既不是 PNG 也不是 UTF-8 JSON：{e}"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw: Value = serde_json::from_str(text).map_err(|e| format!("既不是 PNG 也不是合法 JSON：{e}"))?;
    normalize_card(&raw).map(|card| (card, "json"))
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        output.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).unwrap_or_else(|_| now_ms().to_string())
}

fn card_id(name: &str) -> String {
    let mut ascii = String::new();
    let mut dash = false;
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            ascii.push(ch);
            dash = false;
        } else if !dash {
            ascii.push('-');
            dash = true;
        }
    }
    let ascii = ascii.trim_matches('-').chars().take(32).collect::<String>();
    format!("{}-{}", if ascii.is_empty() { "char" } else { &ascii }, radix36(now_ms()))
}

fn normalized_file_card(app: &AppHandle, id: &str) -> Result<CharacterCard, String> {
    let path = file_of(app, id, ".json")?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_CARD_BYTES {
        return Err("角色卡文件超过 8MB".into());
    }
    let raw: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    normalize_card(&raw)
}

fn active_id(app: &AppHandle) -> String {
    let Ok(path) = store_dir(app).map(|dir| dir.join("active.json")) else { return String::new() };
    let value = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let id: String = value
        .get("id")
        .and_then(Value::as_str)
        .map(|value| value.to_owned())
        .unwrap_or_else(String::new);
    if valid_id(&id) && file_of(app, &id, ".json").map(|p| p.is_file()).unwrap_or(false) {
        id
    } else {
        String::new()
    }
}

fn save_card(app: &AppHandle, raw: &Value, requested_id: Option<&str>) -> Result<(String, CharacterCard), String> {
    let card = normalize_card(raw)?;
    let v2 = to_v2(raw)?;
    let id = requested_id
        .filter(|id| valid_id(id))
        .map(str::to_string)
        .unwrap_or_else(|| card_id(&card.name));
    let path = file_of(app, &id, ".json")?;
    let mut bytes = serde_json::to_vec_pretty(&v2).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    atomic_write(&path, &bytes)?;
    Ok((id, card))
}

fn list_cards(app: &AppHandle) -> Result<Vec<Value>, String> {
    let dir = store_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "active.json" || !name.ends_with(".json") {
            continue;
        }
        let id = name.trim_end_matches(".json");
        if !valid_id(id) {
            continue;
        }
        let updated = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        match normalized_file_card(app, id) {
            Ok(card) => result.push(json!({
                "id": id,
                "name": card.name,
                "tags": card.tags,
                "creator": card.creator,
                "hasAvatar": file_of(app, id, ".png").map(|p| p.is_file()).unwrap_or(false),
                "updated": updated,
            })),
            Err(error) => result.push(json!({ "id": id, "name": id, "broken": error, "updated": updated })),
        }
    }
    result.sort_by(|a, b| {
        b.get("updated").and_then(Value::as_u64).unwrap_or(0)
            .cmp(&a.get("updated").and_then(Value::as_u64).unwrap_or(0))
    });
    Ok(result)
}

fn persona_info(app: &AppHandle) -> Value {
    match list_cards(app) {
        Ok(list) => {
            let active_id = active_id(app);
            let active = if active_id.is_empty() {
                Value::Null
            } else {
                normalized_file_card(app, &active_id).ok().and_then(|card| serde_json::to_value(card).ok()).unwrap_or(Value::Null)
            };
            json!({ "ok": true, "list": list, "activeId": active_id, "active": active })
        }
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub fn persona_list(app: AppHandle) -> Value {
    persona_info(&app)
}

#[tauri::command]
pub fn persona_get(app: AppHandle, id: String) -> Value {
    match normalized_file_card(&app, &id) {
        Ok(card) => json!({ "ok": true, "id": id, "card": card }),
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub fn persona_save(app: AppHandle, card: Value, id: Option<String>) -> Value {
    match save_card(&app, &card, id.as_deref()) {
        Ok((saved, _)) => {
            let mut result = persona_info(&app);
            if let Some(object) = result.as_object_mut() {
                object.insert("saved".into(), json!(saved));
            }
            result
        }
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub fn persona_delete(app: AppHandle, id: String) -> Value {
    if !valid_id(&id) {
        return failure("非法角色 id");
    }
    let was_active = active_id(&app) == id;
    for extension in [".json", ".png"] {
        if let Ok(path) = file_of(&app, &id, extension) {
            if path.exists() {
                if let Err(error) = fs::remove_file(path) {
                    return failure(error.to_string());
                }
            }
        }
    }
    if was_active {
        if let Err(error) = set_active_id(&app, "") {
            return failure(error);
        }
    }
    persona_info(&app)
}

fn set_active_id(app: &AppHandle, id: &str) -> Result<(), String> {
    if !id.is_empty() {
        let path = file_of(app, id, ".json")?;
        if !path.is_file() {
            return Err(format!("角色不存在：{id}"));
        }
    }
    let active = store_dir(app)?.join("active.json");
    let mut bytes = serde_json::to_vec(&json!({ "id": id })).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    atomic_write(&active, &bytes)
}

#[tauri::command]
pub fn persona_set_active(app: AppHandle, id: Option<String>) -> Value {
    let id = id.unwrap_or_default();
    match set_active_id(&app, &id) {
        Ok(()) => persona_info(&app),
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub fn persona_import_buffer(app: AppHandle, data: Vec<u8>) -> Value {
    if data.len() > MAX_CARD_BYTES {
        return failure("文件过大（>8MB），不像角色卡");
    }
    let result = (|| -> Result<(String, &'static str), String> {
        let (card, format) = parse_card_file(&data)?;
        let raw = serde_json::to_value(&card).map_err(|e| e.to_string())?;
        let (id, _) = save_card(&app, &raw, None)?;
        if format == "png" {
            let png = card_to_png(&card, &data)?;
            atomic_write(&file_of(&app, &id, ".png")?, &png)?;
        }
        Ok((id, format))
    })();
    match result {
        Ok((imported, format)) => {
            let mut result = persona_info(&app);
            if let Some(object) = result.as_object_mut() {
                object.insert("imported".into(), json!(imported));
                object.insert("format".into(), json!(format));
            }
            result
        }
        Err(error) => failure(error),
    }
}

fn fallback_png(app: &AppHandle, supplied: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    if let Some(bytes) = supplied {
        if bytes.len() > MAX_CARD_BYTES {
            return Err("PNG 底图超过 8MB".into());
        }
        read_png_chunks(&bytes)?;
        return Ok(bytes);
    }
    if let Ok(resources) = app.path().resource_dir() {
        for relative in ["assets/icon.png", "icons/32x32.png", "icons/128x128.png"] {
            let path = resources.join(relative);
            if let Ok(bytes) = fs::read(path) {
                if bytes.len() <= MAX_CARD_BYTES && read_png_chunks(&bytes).is_ok() {
                    return Ok(bytes);
                }
            }
        }
    }
    let bytes = BASE64.decode(FALLBACK_PNG_BASE64).map_err(|e| e.to_string())?;
    read_png_chunks(&bytes)?;
    Ok(bytes)
}

#[tauri::command]
pub fn persona_export(
    app: AppHandle,
    id: String,
    format: Option<String>,
    path: Option<String>,
    fallback_png_data: Option<Vec<u8>>,
) -> Value {
    let Some(path) = path.filter(|path| !path.trim().is_empty()) else {
        return json!({
            "ok": false,
            "code": "NEED_PATH",
            "error": "NEED_PATH",
            "needPath": true,
        });
    };
    let format = if format.as_deref() == Some("json") { "json" } else { "png" };
    let result = (|| -> Result<(), String> {
        let card = normalized_file_card(&app, &id)?;
        let bytes = if format == "json" {
            let raw = serde_json::to_value(&card).map_err(|e| e.to_string())?;
            let mut bytes = serde_json::to_vec_pretty(&to_v2(&raw)?).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            bytes
        } else {
            let avatar = file_of(&app, &id, ".png")?;
            let base = if avatar.is_file() {
                let bytes = fs::read(&avatar).map_err(|e| e.to_string())?;
                if bytes.len() > MAX_CARD_BYTES {
                    return Err("PNG 底图超过 8MB".into());
                }
                bytes
            } else {
                fallback_png(&app, fallback_png_data)?
            };
            card_to_png(&card, &base)?
        };
        atomic_write(Path::new(path.trim()), &bytes)
    })();
    match result {
        Ok(()) => json!({ "ok": true, "path": path }),
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub fn persona_reveal(app: AppHandle) -> Value {
    let dir = match store_dir(&app) {
        Ok(dir) => dir,
        Err(error) => return failure(error),
    };
    if let Err(error) = fs::create_dir_all(&dir) {
        return failure(error.to_string());
    }
    #[cfg(windows)]
    let result = Command::new("explorer.exe").arg(&dir).spawn().map(|_| ());
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&dir).spawn().map(|_| ());
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&dir).spawn().map(|_| ());
    match result {
        Ok(()) => json!({ "ok": true, "path": dir.to_string_lossy() }),
        Err(error) => failure(error.to_string()),
    }
}
