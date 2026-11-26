//! 消息源：Windows 通知中心（WinRT）与可注入的虚构 provider
//!
//! 设计原则（隐私）：
//! - **默认关闭**。`island.json` 的 `notifySource` 默认 `off`，只有用户显式
//!   改成 `winrt` 才会去读通知中心；读之前要用 `notify_request_access` 走一次
//!   系统授权（Windows 的 UserNotificationListener 权限），和原版一致。
//! - **mock 只给验收用**：`notifySource=mock` 时从环境变量 `CATWHALE_NOTIFY_FILE`
//!   指向的 JSON 读「虚构通知」，绝不碰系统通知中心。验收脚本用它跑通
//!   「provider → 解析 → 去重/基线 → 进岛」这条真实路由。
//! - 不落任何通知正文到磁盘（探针的中间文件在调用结束后删除）。
//!
//! 返回契约与 Electron 版 winnotify 源对齐：
//!   { ok, source, access, count, items:[{id, app, aumid, texts:[..], title, body, creation}] }

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const PROBE_PS1: &str = include_str!("../assets/winnotify_probe.ps1");

fn cfg_dir() -> PathBuf {
    crate::chat::config_dir()
}

fn probe_dir() -> PathBuf {
    cfg_dir().join("notify")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 跑一个子进程，带超时；返回 (stdout, stderr)。超时就 kill 掉。
fn run_with_timeout(cmd: &mut Command, ms: u64) -> Result<(String, String), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 控制台程序必须 CREATE_NO_WINDOW，否则每 4 秒闪一个黑框
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败：{e}"))?;
    let deadline = std::time::Instant::now() + Duration::from_millis(ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超时（{ms}ms）"));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("等待失败：{e}")),
        }
    }
    let out = child.wait_with_output().map_err(|e| format!("取输出失败：{e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// 虚构 provider：从 JSON 文件读，字段与 WinRT 探针一致。
/// 文件既可以是 `{"items":[...]}`，也可以直接是数组。
fn poll_mock() -> Value {
    let path = match std::env::var("CATWHALE_NOTIFY_FILE") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => {
            return json!({
                "ok": false, "source": "mock", "access": "n/a", "count": 0, "items": [],
                "error": "未设置 CATWHALE_NOTIFY_FILE（mock provider 需要一份虚构通知 JSON）"
            })
        }
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return json!({
                "ok": false, "source": "mock", "access": "n/a", "count": 0, "items": [],
                "error": format!("读 mock 文件失败：{e}")
            })
        }
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "ok": false, "source": "mock", "access": "n/a", "count": 0, "items": [],
                "error": format!("mock JSON 解析失败：{e}")
            })
        }
    };
    let items: Vec<Value> = if let Some(arr) = value.as_array() {
        arr.clone()
    } else {
        value
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let items: Vec<Value> = items
        .into_iter()
        .take(60)
        .enumerate()
        .map(|(i, mut it)| {
            if it.get("id").and_then(Value::as_str).map(str::is_empty).unwrap_or(true) {
                if let Some(obj) = it.as_object_mut() {
                    obj.insert("id".into(), json!(format!("mock-{}", i + 1)));
                }
            }
            if it.get("ts").is_none() {
                if let Some(obj) = it.as_object_mut() {
                    obj.insert("ts".into(), json!(now_ms()));
                }
            }
            it
        })
        .collect();
    json!({
        "ok": true, "source": "mock", "access": "allowed",
        "count": items.len(), "items": items, "probe": "file", "ts": now_ms()
    })
}

/// 真实 provider：PowerShell + WinRT UserNotificationListener（只读系统已渲染的 toast）。
fn poll_winrt(request_access: bool) -> Value {
    let dir = probe_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return json!({ "ok": false, "source": "winrt", "access": "unknown", "count": 0, "items": [],
                       "error": format!("建目录失败：{e}") });
    }
    let ps1 = dir.join("winnotify_probe.ps1");
    // 每次覆盖写：脚本升级后不会沿用旧文件
    if let Err(e) = std::fs::write(&ps1, PROBE_PS1.as_bytes()) {
        return json!({ "ok": false, "source": "winrt", "access": "unknown", "count": 0, "items": [],
                       "error": format!("写探针失败：{e}") });
    }
    let out_json = dir.join("notify_out.json");
    let _ = std::fs::remove_file(&out_json);
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&ps1)
        .arg("-OutFile")
        .arg(&out_json);
    if request_access {
        cmd.arg("-RequestAccess");
    }
    let run = run_with_timeout(&mut cmd, 20_000);
    if let Err(e) = run {
        return json!({ "ok": false, "source": "winrt", "access": "unknown", "count": 0, "items": [],
                       "error": e });
    }
    let text = std::fs::read_to_string(&out_json).unwrap_or_default();
    let _ = std::fs::remove_file(&out_json);
    let mut val: Value = serde_json::from_str(&text).unwrap_or_else(|e| {
        json!({ "ok": false, "access": "unknown", "count": 0, "items": [],
                "error": format!("探针输出解析失败：{e}") })
    });
    if let Some(obj) = val.as_object_mut() {
        obj.insert("source".into(), json!("winrt"));
    }
    val
}

/// 按来源轮询一次。`source` 只认 off/mock/winrt（大小写不敏感）。
pub fn poll(source: &str) -> Value {
    match source.to_ascii_lowercase().as_str() {
        "mock" => poll_mock(),
        "winrt" => poll_winrt(false),
        "off" | "" => json!({ "ok": false, "source": "off", "access": "off", "count": 0,
                              "items": [], "error": "消息源已关闭" }),
        other => json!({ "ok": false, "source": other, "access": "unknown", "count": 0,
                         "items": [], "error": "未知消息源（只支持 off / mock / winrt）" }),
    }
}

/// 用户显式点「允许读取通知」时调用：走一次系统授权框。
pub fn request_access() -> Value {
    poll_winrt(true)
}
