use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::{StatusCode, Url};
use semver::Version;
use serde_json::{json, Value};
use std::process::Command;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/timevisitor/catwhale-pet/releases/latest";
const GITHUB_RELEASES_PAGE: &str = "https://github.com/timevisitor/catwhale-pet/releases";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn latest_cache() -> &'static RwLock<Option<Value>> {
    static LATEST: OnceLock<RwLock<Option<Value>>> = OnceLock::new();
    LATEST.get_or_init(|| RwLock::new(None))
}

fn without_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

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
        || parts.iter().any(|part| {
            part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return None;
    }
    while parts.len() < 3 {
        parts.push("0");
    }
    Version::parse(&format!("{}{}", parts.join("."), suffix)).ok()
}

fn update_error(error: impl Into<String>) -> Value {
    json!({
        "ok": false,
        "error": error.into(),
        "currentVersion": CURRENT_VERSION
    })
}

fn open_validated_url(url: &Url) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // 不使用 cmd /C start，避免 URL 中的 shell 元字符被二次解释。
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url.as_str()]);
        without_window(&mut command);
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

#[tauri::command]
pub fn update_check() -> Value {
    let client = match Client::builder().timeout(Duration::from_secs(8)).build() {
        Ok(client) => client,
        Err(error) => return update_error(error.to_string()),
    };
    let response = match client
        .get(LATEST_RELEASE_API)
        .header(USER_AGENT, format!("catwhale-pet/{CURRENT_VERSION}"))
        .header(ACCEPT, "application/vnd.github+json")
        .send()
    {
        Ok(response) => response,
        Err(error) => return update_error(error.to_string()),
    };

    if response.status() == StatusCode::NOT_FOUND {
        return json!({
            "ok": true,
            "hasUpdate": false,
            "noRelease": true,
            "currentVersion": CURRENT_VERSION,
            "latestVersion": Value::Null,
            "releaseUrl": GITHUB_RELEASES_PAGE
        });
    }
    if !response.status().is_success() {
        return update_error(format!("GitHub API HTTP {}", response.status().as_u16()));
    }

    let release: Value = match response.json() {
        Ok(release) => release,
        Err(error) => return update_error(error.to_string()),
    };
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .filter(|tag| !tag.trim().is_empty())
        .or_else(|| release.get("name").and_then(Value::as_str))
        .unwrap_or("");
    let latest_version = tag
        .trim()
        .strip_prefix('v')
        .or_else(|| tag.trim().strip_prefix('V'))
        .unwrap_or(tag.trim());
    let (Some(current), Some(latest)) = (
        parse_version(CURRENT_VERSION),
        parse_version(latest_version),
    ) else {
        return update_error(format!("无法比较版本: {CURRENT_VERSION} / {latest_version}"));
    };
    let has_update = latest > current;

    let release_url = release
        .get("html_url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .unwrap_or(GITHUB_RELEASES_PAGE);
    let assets = release.get("assets").and_then(Value::as_array);
    let asset = assets.and_then(|assets| {
        assets
            .iter()
            .find(|asset| {
                asset
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_ascii_lowercase().ends_with(".zip"))
            })
            .or_else(|| assets.first())
    });
    let download_url = asset
        .and_then(|asset| asset.get("browser_download_url"))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .unwrap_or(release_url);
    let asset_name = asset
        .and_then(|asset| asset.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    let notes = release.get("body").and_then(Value::as_str).unwrap_or("");

    let result = json!({
        "ok": true,
        "hasUpdate": has_update,
        "currentVersion": CURRENT_VERSION,
        "latestVersion": latest_version,
        "releaseUrl": release_url,
        "downloadUrl": download_url,
        "assetName": asset_name,
        "publishedAt": published_at,
        "notes": notes
    });

    // 原 IPC 的 latest 表示“可下载的新版本”，无更新或查询失败时不覆盖缓存。
    if has_update {
        *latest_cache()
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result.clone());
    }
    result
}

#[tauri::command]
pub fn update_status() -> Value {
    let latest = latest_cache()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    json!({
        "ok": true,
        "currentVersion": CURRENT_VERSION,
        "latest": latest
    })
}

#[tauri::command]
pub fn update_open_url(url: String) -> Value {
    let cached_url = latest_cache()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|latest| latest.get("releaseUrl"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let target = if url.trim().is_empty() {
        cached_url.as_deref().unwrap_or(GITHUB_RELEASES_PAGE)
    } else {
        url.trim()
    };

    let parsed = match Url::parse(target) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() =>
        {
            url
        }
        _ => return json!({ "ok": false, "error": "只允许有效的 http/https URL" }),
    };

    match open_validated_url(&parsed) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}
