//! 情报（信息中枢）摘要层：给灵动岛的「信息卡」供数
//!
//! 只做**通用聚合**，不带任何业务账号/令牌/私有源：
//! - 数据来自 `info.json`（默认在配置目录；可用 `CATWHALE_INFO_FILE` 指到别处）。
//!   文件由用户或其他本地集成写入，schema 见 `summary()` 的注释。
//! - 聚合结果与 Electron 版 `getInfo()` 对齐：
//!   `{ todoOpen, todoTotal, nextTodo, calCount, nextCal, unread, weather }`
//! - 另加 `unreadNotes` / `notifyCount`（可选），供「未读/待办红点」使用。
//!
//! 这样「信息卡」是真实可用的（用户写什么就显示什么），同时不会把飞书/IMAP/
//! 余额查询这类私有实现打进包里。

use serde_json::{json, Value};
use std::path::PathBuf;

fn info_path() -> PathBuf {
    if let Ok(p) = std::env::var("CATWHALE_INFO_FILE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    crate::chat::config_dir().join("info.json")
}

fn read_raw() -> Value {
    let path = info_path();
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if text.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(&text).unwrap_or_else(|_| json!({}))
}

fn text_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn num_of(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 把 info.json 归一化成摘要。
/// 支持的写法（两种都认）：
///   A. 结构化：{ todos:[{text,done}], calendar:[{time,title}], mail:{unread}, weather:{city,temp,text},
///                notes:[{text,done}] }
///   B. 预算好的：{ todoOpen, todoTotal, nextTodo, calCount, nextCal, unread, weather }
pub fn summary() -> Value {
    let raw = read_raw();
    let obj = raw.as_object().cloned().unwrap_or_default();

    // ---- 待办 ----
    let todos = obj
        .get("todos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut todo_open = 0u64;
    let mut next_todo = String::new();
    for t in &todos {
        let done = t.get("done").and_then(Value::as_bool).unwrap_or(false);
        if !done {
            todo_open += 1;
            if next_todo.is_empty() {
                next_todo = text_of(t.get("text")).chars().take(40).collect();
            }
        }
    }
    let todo_open = num_of(obj.get("todoOpen")).map(|v| v.max(0.0) as u64).unwrap_or(todo_open);
    let todo_total = num_of(obj.get("todoTotal"))
        .map(|v| v.max(0.0) as u64)
        .unwrap_or(todos.len() as u64);
    if next_todo.is_empty() {
        next_todo = text_of(obj.get("nextTodo")).chars().take(40).collect();
    }

    // ---- 日程 ----
    let cal = obj
        .get("calendar")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_cal = String::new();
    if let Some(first) = cal.first() {
        let time = text_of(first.get("time"));
        let title = text_of(first.get("title"));
        next_cal = [time, title]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
    }
    let cal_count = num_of(obj.get("calCount"))
        .map(|v| v.max(0.0) as u64)
        .unwrap_or(cal.len() as u64);
    if next_cal.is_empty() {
        next_cal = text_of(obj.get("nextCal"));
    }

    // ---- 邮件未读 ----
    let unread = num_of(obj.get("mail").and_then(|m| m.get("unread")))
        .or_else(|| num_of(obj.get("unread")))
        .map(|v| v.max(0.0) as u64)
        .unwrap_or(0);

    // ---- 天气（只读文件，不联网、不带 key） ----
    let weather = match obj.get("weather") {
        Some(w) if w.is_object() => json!({
            "city": text_of(w.get("city")),
            "temp": w.get("temp").cloned().unwrap_or(Value::Null),
            "text": text_of(w.get("text")),
        }),
        _ => Value::Null,
    };

    let notes = obj
        .get("notes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|n| !n.get("done").and_then(Value::as_bool).unwrap_or(false))
                .count() as u64
        })
        .unwrap_or(0);
    let notify_count = num_of(obj.get("notifyCount")).map(|v| v as u64).unwrap_or(0);

    json!({
        "todoOpen": todo_open,
        "todoTotal": todo_total,
        "nextTodo": next_todo,
        "calCount": cal_count,
        "nextCal": next_cal,
        "unread": unread,
        "notesOpen": notes,
        "notifyCount": notify_count,
        "weather": weather,
        "source": info_path().to_string_lossy(),
        "ts": crate::island::now_ms_pub(),
    })
}

/// 读摘要 + 来源路径（给命令 / 诊断用）
pub fn get() -> Value {
    json!({ "ok": true, "info": summary(), "path": info_path().to_string_lossy() })
}

#[tauri::command]
pub fn info_get() -> Value {
    get()
}

#[tauri::command]
pub fn info_set(patch: Option<Value>) -> Value {
    set(patch)
}

/// 覆盖写 info.json（通用接口；供本地集成 / 验收注入虚构数据）。
/// patch 里出现 null 表示删除该键。
pub fn set(patch: Option<Value>) -> Value {
    let mut base = read_raw();
    if !base.is_object() {
        base = json!({});
    }
    if let Some(Value::Object(patch_obj)) = patch {
        let obj = base.as_object_mut().unwrap();
        for (k, v) in patch_obj {
            if v.is_null() {
                obj.remove(&k);
            } else {
                obj.insert(k, v);
            }
        }
    }
    let path = info_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(&base).unwrap_or_else(|_| "{}".into());
    if let Err(e) = std::fs::write(&path, text) {
        return json!({ "ok": false, "error": format!("写 info.json 失败：{e}") });
    }
    json!({ "ok": true, "path": path.to_string_lossy(), "info": summary() })
}
