use encoding_rs::GBK;
use serde_json::{json, Value};
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ES_INSTANCES: [&str; 4] = ["", "1.5a", "1.5", "1.4"];

fn without_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn instance_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn es_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    // Electron 原版是 __dirname/assets/es.exe；Tauri 对应可执行文件旁的 assets。
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("assets").join("es.exe"));
        }
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        if !local_app_data.is_empty() {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Everything")
                    .join("es.exe"),
            );
        }
    }
    candidates.push(PathBuf::from(r"C:\Program Files\Everything\es.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\Everything\es.exe"));

    candidates.into_iter().find(|path| path.is_file())
}

fn decode_gbk(bytes: &[u8]) -> String {
    GBK.decode(bytes).0.into_owned()
}

fn run_es<I, S>(es: &Path, args: I) -> std::io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(es);
    command.args(args);
    without_window(&mut command);
    command.output()
}

fn error_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| {
            let mut chars = line.chars();
            let is_error = chars
                .by_ref()
                .take(5)
                .collect::<String>()
                .eq_ignore_ascii_case("error");
            is_error && chars.next().is_some_and(char::is_whitespace)
        })
        .map(ToOwned::to_owned)
}

fn detect_instance(es: &Path) -> String {
    let mut cached = instance_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(instance) = cached.as_ref() {
        return instance.clone();
    }

    for instance in ES_INSTANCES {
        let mut args = Vec::new();
        if !instance.is_empty() {
            args.extend(["-instance", instance]);
        }
        args.extend(["-n", "1", "*"]);

        if let Ok(output) = run_es(es, &args) {
            let stdout = decode_gbk(&output.stdout);
            let stderr = decode_gbk(&output.stderr);
            if !stdout.trim().is_empty()
                && error_line(&stdout).is_none()
                && error_line(&stderr).is_none()
            {
                *cached = Some(instance.to_owned());
                return instance.to_owned();
            }
        }
    }

    // 与原版一致：全部探测失败后，让正式查询在默认实例上给出具体错误。
    *cached = Some(String::new());
    String::new()
}

fn search_error(error: String, detail: Option<String>, instance: &str) -> Value {
    let mut value = json!({
        "ok": false,
        "error": error,
        "instance": instance,
        "results": []
    });
    if let Some(detail) = detail {
        value["detail"] = Value::String(detail);
    }
    value
}

#[tauri::command]
pub fn everything_search(query: String, limit: Option<u32>) -> Value {
    let query = query
        .chars()
        .map(|ch| match ch {
            '\r' | '\n' | '\t' | '\0' => ' ',
            other => other,
        })
        .collect::<String>();
    let query = query.trim();
    let limit = limit.unwrap_or(30).clamp(1, 200);

    if query.is_empty() {
        let instance = instance_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .unwrap_or_default();
        return json!({
            "ok": true,
            "results": [],
            "instance": instance,
            "empty": true
        });
    }

    let Some(es) = es_path() else {
        return json!({ "ok": false, "error": "NO_ES", "results": [] });
    };
    let instance = detect_instance(&es);

    let mut args = vec![
        "-csv".to_owned(),
        "-full-path-and-name".to_owned(),
        "-extension".to_owned(),
        "-size".to_owned(),
        "-date-modified".to_owned(),
        "-date-format".to_owned(),
        "1".to_owned(),
        "-size-format".to_owned(),
        "0".to_owned(),
        "-n".to_owned(),
        limit.to_string(),
        query.to_owned(),
    ];
    if !instance.is_empty() {
        args.splice(0..0, ["-instance".to_owned(), instance.clone()]);
    }

    let output = match run_es(&es, &args) {
        Ok(output) => output,
        Err(error) => {
            return search_error(format!("es.exe 执行失败: {error}"), None, &instance);
        }
    };
    let stdout = decode_gbk(&output.stdout);
    let stderr = decode_gbk(&output.stderr);

    if let Some(detail) = error_line(&stdout).or_else(|| error_line(&stderr)) {
        let friendly = if detail.to_ascii_lowercase().contains("ipc window not found")
            || detail.to_ascii_lowercase().contains("not running")
        {
            "未检测到 Everything（请先启动 Everything 后重试）".to_owned()
        } else {
            detail.clone()
        };
        return search_error(friendly, Some(detail), &instance);
    }

    let nonempty_lines = stdout.lines().filter(|line| !line.trim().is_empty()).count();
    if !output.status.success() && nonempty_lines <= 1 {
        let code = output
            .status
            .code()
            .map_or_else(|| "terminated".to_owned(), |code| code.to_string());
        return search_error(
            "未检测到 Everything（请先启动 Everything 后重试）".to_owned(),
            Some(format!("exit={code}")),
            &instance,
        );
    }

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(stdout.as_bytes());
    let mut results = Vec::new();
    for record in reader.records() {
        let record = match record {
            Ok(record) => record,
            Err(error) => {
                return search_error(format!("CSV 解析失败: {error}"), None, &instance);
            }
        };
        let Some(path) = record.get(0).filter(|path| !path.is_empty()) else {
            continue;
        };
        let name = path
            .rsplit(|ch| ch == '\\' || ch == '/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(path);
        let size = record
            .get(2)
            .and_then(|size| size.parse::<u64>().ok())
            .unwrap_or(0);
        results.push(json!({
            "path": path,
            "name": name,
            "ext": record.get(1).unwrap_or(""),
            "size": size,
            "mtime": record.get(3).unwrap_or("")
        }));
    }

    json!({
        "ok": true,
        "instance": instance,
        "total": results.len(),
        "results": results
    })
}

fn validated_existing_path(input: &str) -> Result<&Path, String> {
    if input.is_empty() || input.chars().any(char::is_control) {
        return Err("无效路径".to_owned());
    }
    let path = Path::new(input);
    if !path.is_absolute() || !path.exists() {
        return Err("无效路径".to_owned());
    }
    Ok(path)
}

fn launch_explorer<I, S>(args: I) -> Value
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("explorer.exe");
    command.args(args);
    without_window(&mut command);
    match command.spawn() {
        Ok(_) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[tauri::command]
pub fn everything_open(path: String) -> Value {
    match validated_existing_path(&path) {
        Ok(path) => launch_explorer([path.as_os_str()]),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub fn everything_reveal(path: String) -> Value {
    match validated_existing_path(&path) {
        Ok(path) => {
            // /select, 与路径是同一个 argv 项；不经过 cmd.exe，路径中的 & | ; 等不会被解释。
            let argument = format!("/select,{}", path.display());
            launch_explorer([argument.as_str()])
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[cfg(windows)]
fn set_unicode_clipboard(text: &str) -> Result<(), String> {
    use core::ffi::c_void;

    type Handle = *mut c_void;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const CF_UNICODETEXT: u32 = 13;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, memory: Handle) -> Handle;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(memory: Handle) -> Handle;
        fn GlobalUnlock(memory: Handle) -> i32;
        fn GlobalFree(memory: Handle) -> Handle;
    }

    let mut wide = text.encode_utf16().collect::<Vec<_>>();
    wide.push(0);
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * std::mem::size_of::<u16>());
        if memory.is_null() {
            return Err("GlobalAlloc 失败".to_owned());
        }
        let target = GlobalLock(memory);
        if target.is_null() {
            GlobalFree(memory);
            return Err("GlobalLock 失败".to_owned());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), target.cast::<u16>(), wide.len());
        GlobalUnlock(memory);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            GlobalFree(memory);
            return Err("无法打开系统剪贴板".to_owned());
        }
        let result = if EmptyClipboard() == 0 {
            Err("无法清空系统剪贴板".to_owned())
        } else if SetClipboardData(CF_UNICODETEXT, memory).is_null() {
            Err("无法写入 Unicode 剪贴板".to_owned())
        } else {
            Ok(())
        };
        CloseClipboard();
        if result.is_err() {
            GlobalFree(memory);
        }
        result
    }
}

#[cfg(not(windows))]
fn set_unicode_clipboard(_text: &str) -> Result<(), String> {
    Err("当前平台不支持 Unicode 剪贴板".to_owned())
}

#[tauri::command]
pub fn everything_copy(text: String) -> Value {
    match set_unicode_clipboard(&text) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}
