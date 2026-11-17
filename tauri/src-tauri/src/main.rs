#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod boot_guard;
mod chat;
mod dock;
mod envcheck;
mod everything;
mod feature_config;
mod gamemode;
mod harness;
mod media;
mod persona;
mod sysinfo;
mod update;

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder};

/// 宽高比用 f64 位模式存进 AtomicU64（0.6 = 0x3FE3333333333333）
static ASPECT_BITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0x3FE3333333333333);
/// 开菜单前的前台窗（HWND 存 isize）。收菜单时若 sao 仍是前台，先把前台交回它再隐藏，
/// 避免 SW_HIDE 前台窗触发跨进程「找下一个前台窗」搜索（候选里有慢进程时卡 ~1.3s）。
#[cfg(windows)]
static PREV_FG: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
/// 最近一个非本进程前台窗。菜单显示期间始终保持外部前台，避开 wetype 注入链。
#[cfg(windows)]
static LAST_EXTERNAL_FG: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
fn aspect() -> f64 {
    f64::from_bits(ASPECT_BITS.load(Ordering::Relaxed))
}
fn set_aspect_val(v: f64) {
    if v.is_finite() && v > 0.1 && v < 3.0 {
        ASPECT_BITS.store(v.to_bits(), Ordering::Relaxed);
    }
}

/// release 构建是 windows_subsystem="windows"，没有 stderr，只能写文件
fn wlog(path: &std::path::Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}
const MARGIN: i32 = 20;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct UiPrefs {
    shadow: bool,
    demo_background: bool,
    chat_emote: bool,
}
impl Default for UiPrefs {
    fn default() -> Self {
        Self { shadow: false, demo_background: false, chat_emote: true }
    }
}

fn ui_prefs_path() -> std::path::PathBuf {
    chat::config_dir().join("ui.json")
}

fn ui_prefs() -> UiPrefs {
    std::fs::read_to_string(ui_prefs_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_ui_prefs(prefs: &UiPrefs) {
    let path = ui_prefs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(path, text);
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Config {
    x: i32,
    y: i32,
    h: i32,
}
impl Default for Config {
    fn default() -> Self {
        Config { x: -1, y: -1, h: 340 }
    }
}

struct Pet {
    /// 角色在窗口内的矩形（逻辑坐标），前端上报
    rect: Arc<Mutex<[f64; 4]>>,
    /// 逐像素命中网格：宽、高、0/1 字节 + 角色在窗口内的归一化包围盒
    grid: Arc<Mutex<Grid>>,
    /// 拖动期间冻结穿透轮询
    dragging: Arc<AtomicBool>,
    /// 穿透状态缓存：-1=未定(强制重判) 0=穿透 1=可交互
    /// 必须共享，否则拖动结束把窗口硬改成穿透过之后，
    /// 轮询线程的局部缓存还停在"可交互"，认为没变化就再也不恢复 —— 光标不移出去就永远点不到。
    hit_state: Arc<AtomicI32>,
    /// 菜单开着时整窗可交互：命中网格只按动作首帧采样，菜单姿态(stand_arms)
    /// 换帧后光标处的 alpha 可能变透明，「点角色收菜单」的点击会穿透掉
    /// （原版 Electron 用全局鼠标钩子转发没这个问题，移植版必须显式兜底）。
    menu_open: Arc<AtomicBool>,
    cfg: Arc<Mutex<Config>>,
    cfg_path: std::path::PathBuf,
}

/// 前端采样当前帧 alpha 得到的粗网格（96×160 与 Electron 版一致）。
/// 透明像素不抢鼠标，角色轮廓内才可交互。
#[derive(Default)]
struct Grid {
    w: u32,
    h: u32,
    /// 归一化包围盒 x0,y0,x1,y1（相对窗口宽高的比例）
    bbox: [f64; 4],
    data: Vec<u8>,
}

impl Grid {
    fn hit(&self, fx: f64, fy: f64) -> bool {
        // 没有网格（采不到 alpha）就按整个窗口命中，保证点得动
        if self.w == 0 || self.h == 0 || self.data.is_empty() {
            return true;
        }
        let [x0, y0, x1, y1] = self.bbox;
        if fx < x0 || fx > x1 || fy < y0 || fy > y1 {
            return false;
        }
        let ux = (fx - x0) / (x1 - x0).max(1e-6);
        let uy = (fy - y0) / (y1 - y0).max(1e-6);
        let gx = ((ux * self.w as f64) as u32).min(self.w - 1);
        let gy = ((uy * self.h as f64) as u32).min(self.h - 1);
        self.data[(gy * self.w + gx) as usize] > 0
    }
}

fn save_cfg(pet: &Pet) {
    if let Ok(s) = serde_json::to_string_pretty(&*pet.cfg.lock().unwrap()) {
        let _ = std::fs::write(&pet.cfg_path, s);
    }
}

fn window_size(h: i32) -> LogicalSize<f64> {
    LogicalSize::new(h as f64 * aspect(), h as f64)
}

/// 按新高度调整窗口，底边中点保持不动（放大不会离地）
fn apply_size(win: &WebviewWindow, h: i32) {
    let h = h.clamp(120, 620);
    let (Ok(old_pos), Ok(old_size), Ok(sf)) =
        (win.outer_position(), win.outer_size(), win.scale_factor())
    else {
        return;
    };
    let new_h = (h as f64 * sf).round() as i32;
    let new_w = (h as f64 * aspect() * sf).round() as i32;
    let _ = win.set_size(window_size(h));
    let new_x = old_pos.x + (old_size.width as i32 - new_w) / 2;
    let new_y = old_pos.y + old_size.height as i32 - new_h;
    let _ = win.set_position(PhysicalPosition::new(new_x, new_y));
}

fn park_bottom_right(win: &WebviewWindow, h: i32) {
    let mon = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten());
    let Some(mon) = mon else { return };
    let wa = mon.work_area();
    let sf = win.scale_factor().unwrap_or(1.0);
    let w = (h as f64 * aspect() * sf).round() as i32;
    let hh = (h as f64 * sf).round() as i32;
    let x = wa.position.x + wa.size.width as i32 - w - MARGIN;
    let y = wa.position.y + wa.size.height as i32 - hh - MARGIN;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

#[tauri::command]
fn set_role_rect(pet: tauri::State<'_, Pet>, x: f64, y: f64, w: f64, h: f64) {
    *pet.rect.lock().unwrap() = [x, y, w, h];
}

/// 前端上传命中网格：w/h 网格尺寸，bbox 归一化包围盒，data 为 w*h 个 0/1 字节（base64 前按原始字节传）
#[tauri::command]
fn set_hit_grid(pet: tauri::State<'_, Pet>, w: u32, h: u32, bbox: Vec<f64>, data: Vec<u8>) {
    if w == 0 || h == 0 || w > 512 || h > 512 || data.len() != (w * h) as usize || bbox.len() != 4 {
        return;
    }
    let mut g = pet.grid.lock().unwrap();
    g.w = w;
    g.h = h;
    g.bbox = [bbox[0], bbox[1], bbox[2], bbox[3]];
    g.data = data;
}


/* ===================== 皮肤系统 =====================
   与原 Electron 版同构：%APPDATA%\桌宠\skins\<slug>\skin.json + videos\*.webm，
   active.json 指向当前皮肤。视频通过 Tauri 的 asset protocol 暴露给页面。 */
fn skin_root() -> std::path::PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(appdata).join("桌宠").join("skins")
}

#[derive(serde::Serialize, Clone)]
struct SkinInfo {
    slug: String,
    name: String,
    active: bool,
}

fn read_active_slug() -> Option<String> {
    let p = skin_root().join("active.json");
    let s = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let slug = v.get("slug")?.as_str()?.to_string();
    // 与原版同一套 slug 校验
    if !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        Some(slug)
    } else {
        None
    }
}

#[tauri::command]
fn skin_list() -> Vec<SkinInfo> {
    let root = skin_root();
    let active = read_active_slug();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else { return out };
    for e in rd.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(j) = std::fs::read_to_string(path.join("skin.json")) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&j) else { continue };
        let slug = path
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or(&slug)
            .to_string();
        out.push(SkinInfo {
            active: active.as_deref() == Some(slug.as_str()),
            slug,
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 返回当前皮肤的完整 skin.json + 目录（前端据此建动作表）
#[tauri::command]
fn skin_load() -> serde_json::Value {
    let root = skin_root();
    let Some(slug) = read_active_slug() else {
        return serde_json::json!({ "ok": false, "reason": "no-active-skin" });
    };
    let dir = root.join(&slug);
    let jp = dir.join("skin.json");
    let Ok(txt) = std::fs::read_to_string(&jp) else {
        return serde_json::json!({ "ok": false, "reason": "read-failed", "dir": dir.to_string_lossy() });
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return serde_json::json!({ "ok": false, "reason": "parse-failed", "dir": dir.to_string_lossy() });
    };
    serde_json::json!({
        "ok": true,
        "slug": slug,
        "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(&slug),
        "dir": dir.to_string_lossy(),
        "actions": v.get("actions").cloned().unwrap_or(serde_json::json!({})),
    })
}

#[tauri::command]
fn skin_set(app: AppHandle, slug: String) -> Result<(), String> {
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err("bad slug".into());
    }
    let root = skin_root();
    if !root.join(&slug).join("skin.json").exists() {
        return Err(format!("skin not found: {slug}"));
    }
    let _ = std::fs::create_dir_all(&root);
    std::fs::write(
        root.join("active.json"),
        serde_json::json!({ "slug": slug }).to_string(),
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("skin:changed", &slug);
    Ok(())
}

#[tauri::command]
fn skin_open_folder() -> Result<String, String> {
    let dir = skin_root();
    let _ = std::fs::create_dir_all(&dir);
    std::process::Command::new("explorer")
        .arg(dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/* ===================== 开机自启（HKCU Run） ===================== */
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "CatwhalePet";

fn self_exe() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Fallback videos ship beside the executable instead of being embedded in the
/// Tauri asset archive. This keeps 26 WebM files out of the PE read-only data.
#[tauri::command]
fn builtin_asset_dir() -> String {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("frontend").join("assets"));
        }
    }
    if let Some(source) = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(source.join("frontend").join("assets"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn autostart_get() -> bool {
    let out = std::process::Command::new("reg")
        .args(["query", RUN_KEY, "/v", RUN_NAME])
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
fn autostart_set(on: bool) -> Result<bool, String> {
    let exe = self_exe();
    if exe.is_empty() {
        return Err("cannot resolve exe path".into());
    }
    let st = if on {
        std::process::Command::new("reg")
            .args([
                "add",
                RUN_KEY,
                "/v",
                RUN_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{exe}\""),
                "/f",
            ])
            .status()
    } else {
        std::process::Command::new("reg")
            .args(["delete", RUN_KEY, "/v", RUN_NAME, "/f"])
            .status()
    };
    match st {
        Ok(s) if s.success() => Ok(on),
        Ok(_) => Ok(autostart_get()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn list_displays(app: AppHandle) -> Vec<serde_json::Value> {
    let prim = app.primary_monitor().ok().flatten();
    let prim_name = prim.as_ref().map(|m| m.name().cloned().unwrap_or_default());
    let mut out = Vec::new();
    if let Ok(mons) = app.available_monitors() {
        for (i, m) in mons.iter().enumerate() {
            let name = m.name().cloned().unwrap_or_else(|| format!("显示器 {i}"));
            let wa = m.work_area();
            out.push(serde_json::json!({
                "index": i,
                "name": name,
                "primary": prim_name.as_deref() == Some(name.as_str()),
                "x": wa.position.x, "y": wa.position.y,
                "w": wa.size.width, "h": wa.size.height,
                "scale": m.scale_factor(),
            }));
        }
    }
    out
}


/* ===================== SAO 环状菜单（独立窗口） =====================
   为什么会话里要开第二个窗口：主窗口是「贴着角色大小」的紧凑透明窗，
   装不下左侧详情卡 + 分类轴 + 两级列表。原版 Electron 用全屏透明窗解决，
   这里用独立菜单窗口解决 —— 它可交互、主窗口继续穿透，两边互不干扰。 */
const SAO_W: f64 = 708.0;
const SAO_H: f64 = 374.0;

/// 菜单窗口该放哪：优先角色右侧，右边放不下就翻到左侧
fn sao_position(app: &AppHandle) -> (i32, i32, bool) {
    let Some(main) = app.get_webview_window("main") else { return (200, 200, false) };
    let (Ok(pos), Ok(size), Ok(sf)) = (main.outer_position(), main.outer_size(), main.scale_factor())
    else {
        return (200, 200, false);
    };
    let w = (SAO_W * sf).round() as i32;
    let h = (SAO_H * sf).round() as i32;
    // 角色所在显示器的工作区
    let mon = main.current_monitor().ok().flatten();
    let wa = mon.as_ref().map(|m| m.work_area());
    let (wa_x, wa_y, wa_w, wa_h) = match wa {
        Some(a) => (a.position.x, a.position.y, a.size.width as i32, a.size.height as i32),
        None => (0, 0, 1920, 1080),
    };
    let right_edge = pos.x + size.width as i32;
    let left_edge = pos.x;
    let gap = (10.0 * sf).round() as i32;
    let (x, mirror) = if right_edge + gap + w <= wa_x + wa_w {
        (right_edge + gap, false)
    } else if left_edge - gap - w >= wa_x {
        (left_edge - gap - w, true)
    } else {
        ((wa_x + wa_w - w - gap).max(wa_x), true)
    };
    // 垂直方向：与角色顶部对齐，但不超出工作区
    let mut y = pos.y + (size.height as i32 - h) / 2;
    if y + h > wa_y + wa_h {
        y = wa_y + wa_h - h - gap;
    }
    if y < wa_y {
        y = wa_y + gap;
    }
    (x, y, mirror)
}

/// WebView2 显式浏览器参数（main 窗在 tauri.conf.json 里配了同一份）。
/// 设置 additional_browser_args 会整体替换 wry 默认参数，所以必须把
/// wry 默认禁的 msWebOOUI/msPdfOOUI/msSmartScreenProtection 和自动播放策略一并带上。
/// CalculateNativeWinOcclusion：见 main() 里的注释——被遮挡的桌宠渲染进程不能被挂起。
const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

/// 预建菜单窗口（启动时调用一次，隐藏状态）。之后右键只是「定位 + 显示」，秒开。
/// 为什么必须预建：WebView2 第二个实例冷启动实测约 3.5 秒，期间窗口是空白透明的，
/// 用户看到的就是「右键没反应」；而且一失焦就关，再右键又重新建，永远等不到。
fn ensure_sao(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("sao") {
        return Ok(w);
    }
    let win = WebviewWindowBuilder::new(app, "sao", WebviewUrl::App("sao.html".into()))
        .title("sao")
        .inner_size(SAO_W, SAO_H)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focusable(true)
        .visible(false)
        .additional_browser_args(WEBVIEW_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    // WebView2 预建偶尔会把仍隐藏的 sao 留成前台窗，既偷用户键盘也让
    // 第一次右键落入 wetype 卡顿路径；立即把前台交回外部应用。
    #[cfg(windows)]
    keep_foreground_external();
    let app2 = app.clone();
    win.on_window_event(move |ev| {
        if let tauri::WindowEvent::Focused(false) = ev {
            // 刚弹出的一瞬间会被判定失焦（窗口还没真正抢到焦点），给 600ms 宽限。
            // 判定+收起必须回主线程做：跨线程 ShowWindow(SW_HIDE) 会被随后的
            // 焦点/激活消息覆盖（和 close_sao 注释里同一个坑）。
            let app3 = app2.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(600));
                let app4 = app3.clone();
                let _ = app3.run_on_main_thread(move || {
                    if let Some(w) = app4.get_webview_window("sao") {
                        // 可见/聚焦一律读 Win32 真值，不用 w.is_visible()/is_focused()：
                        // 预建 visible(false) + Win32 ShowWindow 显示后，Tauri 内部标志与真实
                        // 状态脱钩，宽限线程会误判「已隐藏」而跳过收起。
                        let vis = win_real_visible(&w);
                        let foc = win_has_focus(&w);
                        if vis && !foc {
                            if !set_win_visible(&w, false) {
                                let _ = w.hide();
                            }
                            // 失焦收起也要通知主窗口复位 menuOpen，否则行为引擎
                            // 一直以为菜单开着，空闲随机永远不抽（和 close_sao 同口径）。
                            let _ = app4.emit_to("main", "sao:closed", ());
                            if let Some(pet) = app4.try_state::<Pet>() {
                                pet.menu_open.store(false, Ordering::SeqCst);
                                pet.hit_state.store(-1, Ordering::SeqCst);
                            }
                        }
                    }
                });
            });
        }
    });
    // 失焦兜底巡检：Tauri 的 Focused(false) 事件在内部焦点标志脱钩后可能不再触发
    // （实测 2026-11-17：reopen 时前台被别的程序抢走、宽限线程收起后，再点窗外
    // 完全无事件，菜单永远挂着）。菜单可见期间每 250ms 读一次 Win32 真前台，
    // 连续两次失焦才收（防开菜单瞬间的焦点抖动误关）。只读 GetForegroundWindow，
    // 不抢焦点；隐藏后空转开销可忽略。
    let app5 = app.clone();
    std::thread::spawn(move || {
        let mut unfocused = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            #[cfg(windows)]
            unsafe {
                let fg = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
                if !fg.0.is_null() && !hwnd_is_ours(fg) {
                    LAST_EXTERNAL_FG.store(fg.0 as isize, Ordering::SeqCst);
                }
            }
            let Some(w) = app5.get_webview_window("sao") else { continue };
            if !win_real_visible(&w) {
                unfocused = 0;
                continue;
            }
            if win_has_focus(&w) {
                unfocused = 0;
                continue;
            }
            unfocused += 1;
            if unfocused < 2 {
                continue;
            }
            unfocused = 0;
            let app6 = app5.clone();
            let _ = app5.run_on_main_thread(move || {
                if let Some(w) = app6.get_webview_window("sao") {
                    // 回主线程后再核一次真值，避免和 open_sao/宽限线程竞态
                    if win_real_visible(&w) && !win_has_focus(&w) {
                        if !set_win_visible(&w, false) {
                            let _ = w.hide();
                        }
                        let _ = app6.emit_to("main", "sao:closed", ());
                        if let Some(pet) = app6.try_state::<Pet>() {
                            pet.menu_open.store(false, Ordering::SeqCst);
                            pet.hit_state.store(-1, Ordering::SeqCst);
                        }
                    }
                }
            });
        }
    });
    Ok(win)
}

/// sao 顶层窗是否真的可见（WS_VISIBLE 位）。Tauri is_visible() 在预建+Win32 显示后不可信。
#[cfg(windows)]
fn win_real_visible(win: &WebviewWindow) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_STYLE};
    match sao_top_hwnd(win) {
        Some(h) => unsafe { (GetWindowLongW(h, GWL_STYLE) as u32 & 0x1000_0000) != 0 },
        None => false,
    }
}

/// sao 是否持有键盘焦点（顶层或其子窗），或者就是前台窗。
/// 开菜单不再抢前台（躲输入法焦点交接卡顿），失焦判定必须改读键盘焦点：
/// GetGUIThreadInfo 跨线程读目标线程的 hwndFocus，纯 Win32 不碰 WebView2 IPC。
#[cfg(windows)]
fn win_has_focus(win: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowRect,
        GetWindowThreadProcessId, IsChild, GUITHREADINFO,
    };
    match sao_top_hwnd(win) {
        Some(h) => unsafe {
            let fg = GetForegroundWindow();
            if fg == h || main_top_hwnd().is_some_and(|m| fg == m) {
                // sao 不抢前台时焦点可能留在 main；这也是菜单正在交互的有效状态。
                return true;
            }
            let tid = GetWindowThreadProcessId(h, None);
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if GetGUIThreadInfo(tid, &mut info).is_ok() {
                let f = info.hwndFocus;
                if !f.is_invalid() && (f == h || IsChild(h, f).as_bool()) {
                    return true;
                }
            }
            // 从其他应用右键时，NOACTIVATE 会让前台一直留在原应用。只要前台
            // 仍是打开菜单前的那个窗口、且光标在主窗或菜单内，就视为正常交互。
            // 若前台后来切到别的窗口（Alt+Tab），即使光标没动也会判定失焦；
            // 若点击原应用的别处，光标已离开两个窗口，同样会关闭菜单。
            let prev = windows::Win32::Foundation::HWND(PREV_FG.load(Ordering::SeqCst) as _);
            if !prev.0.is_null() && fg == prev {
                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_ok() {
                    let mut sr = RECT::default();
                    if GetWindowRect(h, &mut sr).is_ok()
                        && pt.x >= sr.left && pt.x < sr.right && pt.y >= sr.top && pt.y < sr.bottom
                    {
                        return true;
                    }
                    if let Some(m) = main_top_hwnd() {
                        let mut mr = RECT::default();
                        if GetWindowRect(m, &mut mr).is_ok()
                            && pt.x >= mr.left && pt.x < mr.right && pt.y >= mr.top && pt.y < mr.bottom
                        {
                            return true;
                        }
                    }
                }
            }
            false
        },
        None => false,
    }
}

#[tauri::command]
async fn open_sao(app: AppHandle) -> Result<(), String> {
    let win = ensure_sao(&app)?;
    if let Some(pet) = app.try_state::<Pet>() {
        pet.menu_open.store(true, Ordering::SeqCst);
        pet.hit_state.store(-1, Ordering::SeqCst); // 强制穿透轮询立刻重判
    }
    // 菜单开着时整窗可交互，避免动画透明像素让「点角色收菜单」穿透到下层窗口。
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_ignore_cursor_events(false);
    }
    // 若右键或此前的程序化验收让 main/sao 持前台，先交回最近的外部应用。
    // 已在前台的外部窗会被记录为 PREV_FG，供无焦点菜单的失焦判定使用。
    #[cfg(windows)]
    keep_foreground_external();
    let (x, y, mirror) = sao_position(&app);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // 与原版一致：菜单在角色右侧时，角色动画也水平翻转朝向菜单；
    // sao:closed 时前端会恢复默认朝向。
    let _ = app.emit_to("main", "pet:mirror", !mirror);
    if !set_win_visible(&win, true) {
        let _ = win.show();
    }
    // wetype_tip_core.dll 注入本进程后，只要在 main/sao 持有前台时显示菜单，
    // 它就可能在 WebView2/输入法焦点链里同步等待约 3.3s。SetFocus(sao)、
    // SetForegroundWindow(main) 也都会触发，因此不能靠事后隐藏或换焦点补救。
    // 最终方案是两个窗口都 NOACTIVATE、前台始终留在外部应用；真实 Esc 由
    // 低级键盘钩子转发，失焦巡检结合原前台与光标位置判断。
    let _ = app.emit_to("sao", "sao:refresh", ());
    Ok(())
}

/// sao 的顶层窗句柄。win.hwnd() 在 WebView2 下可能返回 webview 子窗口，
/// 对子窗口 ShowWindow / SetForegroundWindow 都不生效，必须按标题找本进程顶层窗。
#[cfg(windows)]
fn sao_top_hwnd(win: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId};
    use windows::core::w;
    unsafe {
        // 类名是 "Tauri Window"（不是 label "sao"），按 类名+标题 找本进程顶层窗。
        if let Ok(h) = FindWindowW(w!("Tauri Window"), w!("sao")) {
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == std::process::id() {
                return Some(h);
            }
        }
    }
    win.hwnd().ok().map(|h| windows::Win32::Foundation::HWND(h.0 as _))
}

/// 主窗顶层句柄（类名 "Tauri Window" + 标题 "catwhale-poc" + 本进程 pid 校验）。
/// 隐藏前台 sao 前把前台交回主窗用，避免跨进程前台搜索。
#[cfg(windows)]
fn main_top_hwnd() -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId};
    use windows::core::w;
    unsafe {
        if let Ok(h) = FindWindowW(w!("Tauri Window"), w!("catwhale-poc")) {
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == std::process::id() {
                return Some(h);
            }
        }
    }
    None
}

#[cfg(windows)]
fn hwnd_is_ours(h: windows::Win32::Foundation::HWND) -> bool {
    if h.0.is_null() {
        return false;
    }
    let mut pid = 0u32;
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(h, Some(&mut pid));
    }
    pid == std::process::id()
}

/// 找一个可交还前台的外部应用窗口。优先用最近真实前台，启动时若尚未记录
/// 则按 Z 序找第一个可见、有标题、非工具窗的其他进程顶层窗。
#[cfg(windows)]
fn external_fg_candidate() -> Option<windows::Win32::Foundation::HWND> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowTextLengthW, IsWindow, IsWindowVisible,
        GWL_EXSTYLE,
    };
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    unsafe {
        let last = HWND(LAST_EXTERNAL_FG.load(Ordering::SeqCst) as _);
        if !last.0.is_null() && IsWindow(Some(last)).as_bool() && !hwnd_is_ours(last) {
            return Some(last);
        }
        unsafe extern "system" fn find(hwnd: HWND, lp: LPARAM) -> BOOL {
            let out = &mut *(lp.0 as *mut Option<HWND>);
            let pid_ok = !hwnd_is_ours(hwnd);
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if pid_ok
                && IsWindowVisible(hwnd).as_bool()
                && GetWindowTextLengthW(hwnd) > 0
                && ex & WS_EX_TOOLWINDOW == 0
            {
                *out = Some(hwnd);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut found = None;
        let _ = EnumWindows(Some(find), LPARAM(&mut found as *mut _ as isize));
        found
    }
}

/// 菜单打开和预建期间都不能让 main/sao 持有前台：实测只要在本进程前台
/// 显示 sao，wetype 就会同步等待；保持外部前台时同一路径低于 0.5s。
#[cfg(windows)]
fn keep_foreground_external() {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};
    unsafe {
        let fg = GetForegroundWindow();
        if !fg.0.is_null() && !hwnd_is_ours(fg) {
            LAST_EXTERNAL_FG.store(fg.0 as isize, Ordering::SeqCst);
            PREV_FG.store(fg.0 as isize, Ordering::SeqCst);
            return;
        }
        if let Some(target) = external_fg_candidate() {
            let _ = SetForegroundWindow(target);
            let now = GetForegroundWindow();
            PREV_FG.store(now.0 as isize, Ordering::SeqCst);
            if !now.0.is_null() && !hwnd_is_ours(now) {
                LAST_EXTERNAL_FG.store(now.0 as isize, Ordering::SeqCst);
            }
        }
    }
}

/// 直接用 Win32 显示/隐藏窗口。
/// 为什么不用 Tauri 的 show()/hide()：预建时设 visible(false) 会让 Tauri 的内部可见标志
/// 与 Win32 真实状态脱钩，之后 show()→hide() 会出现「Tauri 认为已隐藏、屏幕上还挂着」的情况
/// （实测 Tauri 内部标志报 false 时，同进程 WS_VISIBLE 仍可能为真）。
#[cfg(windows)]
fn set_win_visible(win: &WebviewWindow, on: bool) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, ShowWindow, GWL_STYLE, SW_HIDE, SW_SHOWNOACTIVATE,
    };
    match sao_top_hwnd(win) {
        Some(h) => unsafe {
            if !on {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetForegroundWindow, IsWindow, SetForegroundWindow,
                };
                // sao 是前台窗时直接 SW_HIDE，Windows 会同步发起跨进程「找下一个前台窗」
                // 搜索，候选里有响应慢的进程（SOLIDWORKS/电脑管家等）就卡 ~1.3s。
                // 先把前台交回「开菜单前的前台窗」（open_sao 时记在 PREV_FG），再隐藏。
                // 不交回主窗：主窗是 WS_EX_NOACTIVATE 非激活窗（点角色不抢前台，
                // 从根上消掉一次性 ~3s 焦点交接卡顿），程序化 SetForegroundWindow 虽能
                // 激活它，但没必要——交回用户原来的应用才是原版桌宠语义。
                // 仅当 sao 确为前台时才交接：失焦关（点窗外）场景前台已是用户点的应用。
                if GetForegroundWindow() == h {
                    let prev = windows::Win32::Foundation::HWND(PREV_FG.load(Ordering::SeqCst) as _);
                    let target = if !prev.0.is_null() && prev != h && IsWindow(Some(prev)).as_bool() {
                        prev
                    } else {
                        external_fg_candidate().unwrap_or(h)
                    };
                    if target != h {
                        let _ = SetForegroundWindow(target);
                    }
                }
                let _ = ShowWindow(h, SW_HIDE);
            } else {
                let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
            }
            if !on {
                // 轻量复核：极端情况下激活消息可能把 SW_HIDE 顶掉，50ms 后看一眼，
                // 冒头就补一刀。（曾误用子窗口句柄时这里加过 500ms 循环补刀，
                // 根因修复后不需要，别阻塞主线程。）
                std::thread::sleep(Duration::from_millis(50));
                if (GetWindowLongW(h, GWL_STYLE) as u32 & 0x1000_0000) != 0 {
                    let _ = ShowWindow(h, SW_HIDE);
                }
            }
            true
        },
        None => false,
    }
}

/// main/sao 共用焦点守卫：main 不响应鼠标激活并吞掉 WM_SETFOCUS，阻止 wry
/// 同步 MoveFocus 进入 wetype 等待链；sao 保留焦点消息供程序化验收使用。
/// 两个窗口的 WS_EX_NOACTIVATE 都在 WM_STYLECHANGING 中重写保留，防止 tao
/// set_window_flags 整体写扩展样式时把该位冲掉。
#[cfg(windows)]
unsafe extern "system" fn main_focus_guard_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _uid: usize,
    refr: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Shell::DefSubclassProc;
    const WM_SETFOCUS: u32 = 0x0007;
    // 主窗永不因点击而激活：WM_MOUSEACTIVATE 回 MA_NOACTIVATE(3)，
    // 鼠标消息照常送达 WebView2，但不进入前台/输入法焦点交接。
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const MA_NOACTIVATE: isize = 3;
    if msg == WM_MOUSEACTIVATE && refr == 1 {
        return windows::Win32::Foundation::LRESULT(MA_NOACTIVATE);
    }
    // tao 的 set_window_flags（set_ignore_cursor_events/show/hide 都会走）按内部标志
    // 整体重写 GWL_EXSTYLE，会把我们设的 WS_EX_NOACTIVATE 冲掉（实测 2026-11-17：
    // 装好守卫后点一次角色，顶层 NOACTIVATE 位就没了，卡顿复发）。
    // WM_STYLECHANGING 在 SetWindowLongW 生效前同步送达，在这里把该位永久焊进
    // styleNew，任何 tao 重写都带不掉。主窗和 sao 都不因鼠标或浏览器焦点同步
    // 抢前台；sao 的真实 Esc 改由低级键盘钩子转发。
    const WM_STYLECHANGING: u32 = 0x007C;
    const GWL_EXSTYLE_I: isize = -20;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    if msg == WM_STYLECHANGING && wparam.0 as isize == GWL_EXSTYLE_I {
        #[repr(C)]
        struct StyleStruct {
            style_old: u32,
            style_new: u32,
        }
        let ss = lparam.0 as *mut StyleStruct;
        if !ss.is_null() {
            (*ss).style_new |= WS_EX_NOACTIVATE;
        }
    }
    // 只在主窗吞 WM_SETFOCUS；sao 要收 Esc，保留焦点消息
    if msg == WM_SETFOCUS && refr == 1 {
        return windows::Win32::Foundation::LRESULT(0);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[cfg(windows)]
fn top_hwnd_by_title(app: &AppHandle, title: &str, label: &str) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId};
    use windows::core::w;
    let t: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut top = FindWindowW(w!("Tauri Window"), windows::core::PCWSTR(t.as_ptr())).ok();
        if let Some(h) = top {
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid != std::process::id() {
                top = None;
            }
        }
        top.or_else(|| {
            app.get_webview_window(label)
                .and_then(|w| w.hwnd().ok())
                .map(|h| windows::Win32::Foundation::HWND(h.0 as _))
        })
    }
}

#[cfg(windows)]
unsafe extern "system" fn enum_child_noactivate(
    hwnd: windows::Win32::Foundation::HWND,
    _l: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE};
    // Chrome 子窗属于浏览器进程，不能跨进程子类化，但可以写扩展样式位。
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_NOACTIVATE == 0 {
        SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_NOACTIVATE) as i32);
    }
    windows::core::BOOL(1)
}

#[cfg(windows)]
fn install_main_focus_guard(app: &AppHandle) {
    use windows::Win32::UI::Shell::SetWindowSubclass;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetWindowLongW, SetWindowLongW, GWL_EXSTYLE,
    };
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    if let Some(h) = top_hwnd_by_title(app, "catwhale-poc", "main") {
        let _ = unsafe { SetWindowSubclass(h, Some(main_focus_guard_proc), 0xCA7, 1) };
        // 主窗做成 Electron 原版那样的「非激活窗」：鼠标消息照常送达渲染器，
        // 但不进入 wetype 的前台焦点链。顶层+所有子窗都设（子窗在浏览器进程，
        // 样式位可跨进程写；子类化不行）。
        unsafe {
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            SetWindowLongW(h, GWL_EXSTYLE, (ex | WS_EX_NOACTIVATE) as i32);
            let _ = EnumChildWindows(Some(h), Some(enum_child_noactivate), windows::Win32::Foundation::LPARAM(0));
        }
    }
    if let Some(h) = top_hwnd_by_title(app, "sao", "sao") {
        let _ = unsafe { SetWindowSubclass(h, Some(main_focus_guard_proc), 0xCA7, 2) };
        // 顶层和子窗都禁止激活，真实点击菜单项不会进入 wetype 焦点链。
        unsafe {
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            SetWindowLongW(h, GWL_EXSTYLE, (ex | WS_EX_NOACTIVATE) as i32);
            let _ = EnumChildWindows(Some(h), Some(enum_child_noactivate), windows::Win32::Foundation::LPARAM(0));
        }
    }
}

/// 真正收起菜单：回主线程原子完成「隐藏 sao + 复位 menu_open/hit_state + 通知 main」。
/// close_sao 命令与穿透轮询的「点角色收菜单」共用同一份逻辑。
fn close_sao_now(app: &AppHandle) {
    let app3 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app3.get_webview_window("sao") {
            if !set_win_visible(&w, false) {
                let _ = w.hide();
            }
        }
        if let Some(pet) = app3.try_state::<Pet>() {
            pet.menu_open.store(false, Ordering::SeqCst);
            pet.hit_state.store(-1, Ordering::SeqCst);
        }
        let _ = app3.emit_to("main", "sao:closed", ());
    });
}

/// NOACTIVATE 菜单不持有键盘焦点，真实 Esc 由低级键盘钩子转发给 sao。
/// 钩子只在 menu_open=true 时消费 Esc，其余按键和其他时候全部原样放行；
/// 不做窗口隐藏、不切换前台，回调只发一个事件，避免低级钩子超时。
#[cfg(windows)]
static HOOK_APP: Mutex<Option<AppHandle>> = Mutex::new(None);

#[cfg(windows)]
unsafe extern "system" fn keyboard_ll_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_SYSKEYDOWN,
    };
    if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if info.vkCode == VK_ESCAPE.0 as u32 {
            let app = HOOK_APP.lock().ok().and_then(|g| g.clone());
            if let Some(app) = app {
                if app.try_state::<Pet>().is_some_and(|pet| pet.menu_open.load(Ordering::SeqCst)) {
                    let _ = app.emit_to("sao", "sao:escape", ());
                    return windows::Win32::Foundation::LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(windows)]
fn install_keyboard_hook(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMessageW, SetWindowsHookExW, MSG, WH_KEYBOARD_LL,
    };
    *HOOK_APP.lock().unwrap() = Some(app.clone());
    let log_path = app.path().app_config_dir().ok().map(|d| d.join("startup.log"));
    std::thread::spawn(move || unsafe {
        match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_ll_proc), None, 0) {
            Ok(_) => {
                let mut msg = MSG::default();
                // 低级钩子要求安装线程有消息泵；GetMessageW 阻塞即泵。
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            }
            Err(e) => {
                if let Some(path) = log_path {
                    wlog(&path, &format!("[sao] keyboard hook install failed: {e}"));
                }
            }
        }
    });
}

#[tauri::command]
async fn close_sao(app: AppHandle) {
    // 必须在 async 命令里做：同步命令在 WebView 的 IPC/消息处理上下文里跑，
    // 此时调 ShowWindow(SW_HIDE) 会被随后的焦点/激活消息覆盖掉，
    // 表现为「close_sao 调了但窗口还在」（实测 2026-11-17，CDP 直接调有效、点击里调无效）。
    close_sao_now(&app);
}

/// NOACTIVATE 模式下 Esc 由 main 接收，转发给 sao 统一处理两级关闭语义。
#[tauri::command]
fn sao_escape(app: AppHandle) {
    let _ = app.emit_to("sao", "sao:escape", ());
}

/* ===================== 原版搜索 / 聊天独立浮窗 =====================
   Electron 原版把浮窗放在全屏透明 DOM 里；Tauri 版用独立 WebviewWindow
   复刻同一套贴角色定位。窗口隐藏而不销毁，聊天在后台继续接收流式事件。 */
fn ensure_float(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(label) {
        return Ok(win);
    }
    let (page, title, width, height) = match label {
        "search" => ("search.html", "猫鲸 · 文件搜索", 470.0, 154.0),
        "chat" => ("chat.html", "猫鲸 · DeepSeek 聊天", 470.0, 570.0),
        _ => return Err("未知浮窗".to_string()),
    };
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .additional_browser_args(WEBVIEW_ARGS)
        .build()
        .map_err(|e| e.to_string())
}

/// 优先放角色左侧，空间不足再翻右侧；返回浮窗实际是否位于角色右侧。
fn position_float(app: &AppHandle, label: &str, force: bool) -> Option<bool> {
    let win = app.get_webview_window(label)?;
    if !force && !win.is_visible().unwrap_or(false) {
        return None;
    }
    let main = app.get_webview_window("main")?;
    let (Ok(pos), Ok(pet_size), Ok(sf), Ok(float_size)) = (
        main.outer_position(),
        main.outer_size(),
        main.scale_factor(),
        win.outer_size(),
    ) else {
        return None;
    };
    let monitor = main.current_monitor().ok().flatten();
    let area = monitor.as_ref().map(|m| m.work_area());
    let (wa_x, wa_y, wa_w, wa_h) = match area {
        Some(a) => (a.position.x, a.position.y, a.size.width as i32, a.size.height as i32),
        None => (0, 0, 1920, 1080),
    };
    let (w, h) = (float_size.width as i32, float_size.height as i32);
    let gap = (12.0 * sf).round() as i32;
    let margin = (8.0 * sf).round() as i32;
    let min_x = wa_x + margin;
    let max_x = (wa_x + wa_w - w - margin).max(min_x);
    let min_y = wa_y + margin;
    let max_y = (wa_y + wa_h - h - margin).max(min_y);
    let left = pos.x - w - gap;
    let mut x = if left >= min_x {
        left
    } else {
        pos.x + pet_size.width as i32 + gap
    };
    x = x.clamp(min_x, max_x);
    let mut y = (pos.y + (pet_size.height as i32 - h) / 2).clamp(min_y, max_y);
    let overlaps = x < pos.x + pet_size.width as i32
        && x + w > pos.x
        && y < pos.y + pet_size.height as i32
        && y + h > pos.y;
    if overlaps {
        y = (pos.y - h - gap).clamp(min_y, max_y);
    }
    let old = win.outer_position().ok();
    if old.map(|p| (p.x, p.y)) != Some((x, y)) {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let on_right = x + w / 2 > pos.x + pet_size.width as i32 / 2;
    let _ = app.emit_to(
        "main",
        "pet:mirror",
        serde_json::json!({ "source": "float", "on": on_right }),
    );
    Some(on_right)
}

fn sync_float_mirror(app: &AppHandle) {
    for label in ["search", "chat"] {
        if position_float(app, label, false).is_some() {
            return;
        }
    }
    let _ = app.emit_to(
        "main",
        "pet:mirror",
        serde_json::json!({ "source": "float", "on": false }),
    );
}

async fn open_float(app: AppHandle, label: String) -> Result<(), String> {
    close_sao_now(&app);
    for other in ["search", "chat"] {
        if other != label {
            if let Some(win) = app.get_webview_window(other) {
                let _ = win.hide();
            }
        }
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    let win = if let Some(win) = app.get_webview_window(&label) {
        win
    } else {
        let app2 = app.clone();
        let label2 = label.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.send(ensure_float(&app2, &label2));
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())??
    };
    position_float(&app, &label, true);
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let _ = app.emit_to(&label, "float:show", label.clone());
    // 首次监听异步注册后补发一次，重开时则会立即收到第一次。
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let _ = app2.emit_to(&label, "float:show", label.clone());
    });
    Ok(())
}

#[tauri::command]
async fn close_float(app: AppHandle, label: String) -> Result<(), String> {
    if label != "search" && label != "chat" {
        return Err("未知浮窗".to_string());
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
        let _ = app.emit_to(&label, "float:closed", label.clone());
    }
    sync_float_mirror(&app);
    Ok(())
}

/// 搜索结果从空态变为列表时，按内容收缩 / 增高原生窗口并重算左右侧。
#[tauri::command]
fn float_layout(app: AppHandle, label: String, width: Option<f64>, height: Option<f64>) {
    if label != "search" && label != "chat" {
        return;
    }
    let Some(win) = app.get_webview_window(&label) else { return };
    let old = win.inner_size().ok();
    let sf = win.scale_factor().unwrap_or(1.0);
    let w = width.unwrap_or(470.0).clamp(320.0, 800.0);
    let h = height.unwrap_or_else(|| old.map(|s| s.height as f64 / sf).unwrap_or(154.0))
        .clamp(92.0, 1200.0);
    let _ = win.set_size(LogicalSize::new(w, h));
    position_float(&app, &label, false);
}

/// 综合工具面板：控制 / 设置等仍共用一个窗口；搜索与聊天走原版独立浮窗。
#[tauri::command]
async fn open_panel(app: AppHandle, panel: String) -> Result<(), String> {
    if panel == "search" || panel == "chat" {
        return open_float(app, panel).await;
    }
    let panel = match panel.as_str() {
        "control" | "settings" | "persona" | "dock" | "env" => panel,
        _ => "control".to_string(),
    };
    close_sao_now(&app);
    for label in ["search", "chat"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.hide();
        }
    }
    sync_float_mirror(&app);
    let existing = app.get_webview_window("panel");
    let win = if let Some(win) = existing {
        win
    } else {
        let app2 = app.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = WebviewWindowBuilder::new(&app2, "panel", WebviewUrl::App("panel.html".into()))
                .title("猫鲸 · 工具面板")
                .inner_size(1060.0, 720.0)
                .min_inner_size(760.0, 520.0)
                .resizable(true)
                .visible(false)
                .additional_browser_args(WEBVIEW_ARGS)
                .build()
                .map_err(|e| e.to_string());
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())??
    };
    let _ = app.emit_to("panel", "panel:show", panel.clone());
    // 新窗口的事件监听是异步注册的；补发一次保证首次打开也落在指定页面。
    let app2 = app.clone();
    let panel2 = panel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        let _ = app2.emit_to("panel", "panel:show", panel2);
    });
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    Ok(())
}

fn chat_backend(app: &AppHandle) -> String {
    chat::config_get(app.clone())
        .get("chat")
        .and_then(|chat| chat.get("backend"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("harness")
        .to_string()
}

/// 前端只看到一个聊天协议；后端按配置选择直连 API 或长驻 Harness。
#[tauri::command]
fn harness_chat(app: AppHandle, prompt: String, history: Option<serde_json::Value>) -> serde_json::Value {
    if chat_backend(&app) == "api" {
        chat::direct_chat(app, serde_json::json!({ "prompt": prompt, "history": history }))
    } else {
        harness::chat(app, prompt, history)
    }
}

#[tauri::command]
fn harness_cancel(app: AppHandle) -> serde_json::Value {
    let direct = chat::direct_cancel(app.clone());
    if direct.get("code").and_then(serde_json::Value::as_str) == Some("HARNESS_REQUIRED") {
        harness::cancel()
    } else {
        direct
    }
}

#[tauri::command]
fn harness_status(app: AppHandle) -> serde_json::Value {
    if chat_backend(&app) == "api" {
        chat::direct_status(app)
    } else {
        harness::status()
    }
}

/// 菜单要显示的状态：皮肤、尺寸、自启、屏幕、当前动作
#[tauri::command]
fn sao_context(pet: tauri::State<'_, Pet>, app: AppHandle) -> serde_json::Value {
    let skins = skin_list();
    let active_name = skin_load()
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("内置")
        .to_string();
    let size = pet.cfg.lock().unwrap().h;
    let displays = list_displays(app.clone());
    let mirror = sao_position(&app).2;
    let current_index = app
        .get_webview_window("main")
        .and_then(|win| win.current_monitor().ok().flatten())
        .and_then(|current| {
            app.available_monitors().ok()?.iter().position(|monitor| {
                monitor.name() == current.name() && monitor.position() == current.position()
            })
        })
        .unwrap_or(0);
    let prefs = ui_prefs();
    serde_json::json!({
        "mirror": mirror,
        "skin": active_name,
        "skins": skins,
        "size": size,
        "autostart": autostart_get(),
        "displays": displays,
        "currentIndex": current_index,
        "shadow": prefs.shadow,
        "demoBackground": prefs.demo_background,
        "chatEmote": prefs.chat_emote,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// 菜单点击统一入口
#[tauri::command]
fn sao_action(app: AppHandle, action: String, arg: Option<serde_json::Value>) -> Result<(), String> {
    let sarg = arg.as_ref().and_then(|v| v.as_str()).map(|s| s.to_string());
    let narg = arg.as_ref().and_then(|v| v.as_i64());
    match action.as_str() {
        "play" => {
            if let Some(id) = sarg {
                let _ = app.emit_to("main", "pet:play", id);
            }
        }
        "random" => {
            let _ = app.emit_to("main", "pet:play", "random");
        }
        "tailAgain" => {
            let _ = app.emit_to("main", "pet:play", "tail_closed");
        }
        "size" => {
            if let Some(h) = narg {
                resize_cmd(&app, h as i32);
            }
        }
        "shadow" => {
            if let Some(on) = arg.as_ref().and_then(|v| v.as_bool()) {
                let mut prefs = ui_prefs();
                prefs.shadow = on;
                save_ui_prefs(&prefs);
                let _ = app.emit_to("main", "pet:shadow", on);
            }
        }
        "demoBackground" => {
            if let Some(on) = arg.as_ref().and_then(|v| v.as_bool()) {
                let mut prefs = ui_prefs();
                prefs.demo_background = on;
                save_ui_prefs(&prefs);
                let _ = app.emit_to("main", "pet:demo-background", on);
            }
        }
        "chatEmote" => {
            if let Some(on) = arg.as_ref().and_then(|v| v.as_bool()) {
                let mut prefs = ui_prefs();
                prefs.chat_emote = on;
                save_ui_prefs(&prefs);
                let _ = app.emit_to("main", "pet:chat-emote", on);
            }
        }
        "skin" => {
            if let Some(slug) = sarg {
                skin_set(app.clone(), slug)?;
                let _ = app.emit_to("sao", "sao:refresh", ());
            }
        }
        "autostart" => {
            let on = !autostart_get();
            let _ = autostart_set(on);
            let _ = app.emit_to("sao", "sao:refresh", ());
        }
        "display" => {
            if let Some(idx) = narg {
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(mons) = app.available_monitors() {
                        if let Some(m) = mons.get(idx as usize) {
                            let a = m.work_area();
                            let h = app
                                .try_state::<Pet>()
                                .map(|p| p.cfg.lock().unwrap().h)
                                .unwrap_or(340);
                            let sf = w.scale_factor().unwrap_or(1.0);
                            let ww = (h as f64 * aspect() * sf).round() as i32;
                            let hh = (h as f64 * sf).round() as i32;
                            let x = a.position.x + a.size.width as i32 - ww - MARGIN;
                            let y = a.position.y + a.size.height as i32 - hh - MARGIN;
                            let _ = w.set_position(PhysicalPosition::new(x, y));
                            if let Some(pet) = app.try_state::<Pet>() {
                                let mut c = pet.cfg.lock().unwrap();
                                c.x = x;
                                c.y = y;
                                drop(c);
                                save_cfg(&pet);
                            }
                        }
                    }
                }
            }
        }
        "task" => {
            let ms = narg.unwrap_or(10000);
            let _ = app.emit_to("main", "pet:task", ms);
        }
        "reload" => {
            for label in ["main", "sao", "panel", "search", "chat"] {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.eval("location.reload()");
                }
            }
            let prefs = ui_prefs();
            let _ = app.emit_to("main", "pet:shadow", prefs.shadow);
            let _ = app.emit_to("main", "pet:demo-background", prefs.demo_background);
            let _ = app.emit_to("main", "pet:chat-emote", prefs.chat_emote);
        }
        "hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "quit" => app.exit(0),
        "skinFolder" => {
            let _ = skin_open_folder();
        }
        "close" => {
            let a = app.clone();
            std::thread::spawn(move || {
                let _ = tauri::async_runtime::block_on(close_sao(a));
            });
        }
        _ => {}
    }
    Ok(())
}

/// 游戏模式只改变主程序资源，不重复向前端发 pet:gamemode（gamemode.rs 已发）。
fn apply_game_mode(app: &AppHandle, on: bool) {
    if on {
        close_sao_now(app);
        media::media_stop();
        sysinfo::sysinfo_stop_all();
        for label in ["main", "panel", "search", "chat"] {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.hide();
            }
        }
        sync_float_mirror(app);
    } else if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        if let Some(pet) = app.try_state::<Pet>() {
            pet.hit_state.store(-1, Ordering::SeqCst);
        }
        media::media_init(app);
    }
}

fn watch_game_mode(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut previous = gamemode::gamemode_active();
        apply_game_mode(&app, previous);
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let current = gamemode::gamemode_active();
            if current != previous {
                previous = current;
                apply_game_mode(&app, current);
            }
        }
    });
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// 调试用：命中判定全链路状态（网格尺寸/包围盒/命中态/光标位置）
#[tauri::command]
fn dbg_hit(pet: tauri::State<'_, Pet>, app: AppHandle) -> serde_json::Value {
    let g = pet.grid.lock().unwrap();
    let rect = *pet.rect.lock().unwrap();
    let state = pet.hit_state.load(Ordering::SeqCst);
    let mut out = serde_json::json!({
        "grid_w": g.w, "grid_h": g.h, "bbox": g.bbox,
        "nonzero": g.data.iter().filter(|b| **b > 0).count(),
        "rect": rect, "hit_state": state,
    });
    if let Some(w) = app.get_webview_window("main") {
        let sf = w.scale_factor().unwrap_or(1.0);
        let sz = w.inner_size().unwrap_or_default();
        if let (Ok(cur), Ok(org)) = (w.cursor_position(), w.outer_position()) {
            let x = (cur.x - org.x as f64) / sf;
            let y = (cur.y - org.y as f64) / sf;
            let gw = (sz.width as f64 / sf).max(1.0);
            let gh = (sz.height as f64 / sf).max(1.0);
            let in_rect = x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3];
            let hit = in_rect && g.hit(x / gw, y / gh);
            out["cursor_logical"] = serde_json::json!([x, y]);
            out["win_logical"] = serde_json::json!([gw, gh]);
            out["in_rect"] = serde_json::json!(in_rect);
            out["hit"] = serde_json::json!(hit);
        }
    }
    out
}

#[tauri::command]
fn set_ignore(win: WebviewWindow, on: bool) -> Result<(), String> {
    win.set_ignore_cursor_events(on).map_err(|e| e.to_string())
}

/// 皮肤视频的宽高比（前端按皮肤里视频的原生 width/height 上报），立即按新比例重排窗口
#[tauri::command]
fn set_aspect(win: WebviewWindow, pet: tauri::State<'_, Pet>, a: f64) {
    set_aspect_val(a);
    let h = pet.cfg.lock().unwrap().h;
    apply_size(&win, h);
    sync_float_mirror(win.app_handle());
}

#[tauri::command]
fn get_config(pet: tauri::State<'_, Pet>) -> Config {
    pet.cfg.lock().unwrap().clone()
}

/// 缩放：窗口跟着变，并记住
/// 自测用：直接走一遍「后端 emit → 前端 listen → 播放」的通路
#[tauri::command]
fn force_wave(app: AppHandle) {
    let _ = app.emit("pet:play", "emo_wave");
}

#[tauri::command]
fn set_pet_size(win: WebviewWindow, pet: tauri::State<'_, Pet>, h: i32) {
    let h = h.clamp(120, 620);
    apply_size(&win, h);
    pet.cfg.lock().unwrap().h = h;
    if let Ok(p) = win.outer_position() {
        let mut c = pet.cfg.lock().unwrap();
        c.x = p.x;
        c.y = p.y;
    }
    save_cfg(&pet);
    sync_float_mirror(win.app_handle());
}

/// 原生拖动：Rust 轮询光标 + 左键状态自己搬窗口（不用系统拖动循环，避免吃掉点击）
#[tauri::command]
fn drag_begin(win: WebviewWindow, pet: tauri::State<'_, Pet>) {
    let dragging = pet.dragging.clone();
    if dragging.swap(true, Ordering::SeqCst) {
        return; // 已在拖
    }
    let w = win.clone();
    let app = win.app_handle().clone();
    std::thread::spawn(move || {
        let (Ok(start_cur), Ok(start_win)) = (w.cursor_position(), w.outer_position()) else {
            // 拿不到就退回系统拖动
            let _ = w.start_dragging();
            if let Some(pet) = app.try_state::<Pet>() {
                pet.dragging.store(false, Ordering::SeqCst);
            }
            return;
        };
        let mut tick = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(8));
            if !left_button_down() {
                break;
            }
            if let Ok(c) = w.cursor_position() {
                let dx = (c.x - start_cur.x).round() as i32;
                let dy = (c.y - start_cur.y).round() as i32;
                let _ = w.set_position(PhysicalPosition::new(start_win.x + dx, start_win.y + dy));
                tick = tick.wrapping_add(1);
                if tick % 10 == 0 {
                    sync_float_mirror(&app);
                }
            }
        }
        if let Some(pet) = app.try_state::<Pet>() {
            // 顺序很重要：先复位拖动标志（让轮询恢复工作），再把穿透状态置 -1 要求重判，
            // 最后才保存位置。绝不能在这里硬 set_ignore_cursor_events(true) ——
            // 那样会绕过轮询缓存，导致"光标不离角色就永远点不到桌宠"（用户实测 2026-11-17）。
            pet.dragging.store(false, Ordering::SeqCst);
            pet.hit_state.store(-1, Ordering::SeqCst);
            if let Ok(p) = w.outer_position() {
                let mut c = pet.cfg.lock().unwrap();
                c.x = p.x;
                c.y = p.y;
                drop(c);
                save_cfg(&pet);
            }
        }
        sync_float_mirror(&app);
    });
}

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 }
}
#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

/// 单实例：Windows 命名 Mutex，第二次启动直接退出
#[cfg(windows)]
fn already_running() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_ALREADY_EXISTS;
    use windows::Win32::System::Threading::CreateMutexW;
    unsafe {
        match CreateMutexW(None, true, w!("Local\\catwhale-pet-single")) {
            Ok(_h) => {
                // 句柄故意泄漏：进程存活期间持有，退出时系统回收
                std::io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_ALREADY_EXISTS.0 as i32)
            }
            Err(_) => false,
        }
    }
}
#[cfg(not(windows))]
fn already_running() -> bool {
    false
}

fn main() {
    if already_running() {
        return;
    }
    let boot_guard = boot_guard::boot_guard_init_early();
    if boot_guard.delay_ms > 0 {
        std::thread::sleep(Duration::from_millis(boot_guard.delay_ms));
    }
    #[cfg(windows)]
    unsafe {
        let fg = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        if !fg.0.is_null() && !hwnd_is_ours(fg) {
            LAST_EXTERNAL_FG.store(fg.0 as isize, Ordering::SeqCst);
        }
    }
    // 桌宠主窗常年被别的窗口遮挡 → WebView2(Chromium) 的 Windows 原生遮挡计算
    // (CalculateNativeWinOcclusion) 会把被完全挡住的窗口渲染进程直接挂起（不是节流），
    // 唤醒要 2-4s：点角色收菜单时 close_sao 的 IPC 要等渲染进程醒来才送达
    // （实测 2026-11-17，SOLIDWORKS 挡着桌宠时点击收菜单延迟 3.2s）。
    // 注意：--disable-features 重复出现时 Chromium 只认最后一个，而 wry 自己会追加
    // 一条 --disable-features=msWebOOUI,...，所以环境变量里塞 feature 会被盖掉。
    // 正解：走 additional_browser_args 显式配置（main 在 tauri.conf.json，sao 在
    // ensure_sao 的 builder），把 wry 默认禁的 feature 一并带上。这里只保留
    // 三个节流开关做兜底（它们不与 wry 的参数冲突）。
    {
        let key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        let mut args = std::env::var(key).unwrap_or_default();
        for a in [
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ]
        .into_iter()
        .chain(boot_guard.switches.iter().map(String::as_str))
        {
            if !args.contains(a) {
                if !args.is_empty() {
                    args.push(' ');
                }
                args.push_str(a);
            }
        }
        std::env::set_var(key, args);
    }
    tauri::Builder::default()
        .manage(boot_guard)
        .setup(|app| {
            let boot = app.state::<boot_guard::BootGuard>();
            boot.phase("window-created");
            let win = app.get_webview_window("main").expect("main window");
            // 焦点守卫必须装在 wry 的父窗子类「之后」才能先于它拦 WM_SETFOCUS。
            // wry 在控制器异步创建回调里才 attach_parent_subclass（晚于 setup），
            // 这里延迟 ~1.2s 等它就绪后再叠装（同 proc+id 重复安装幂等、不改链序）。
            #[cfg(windows)]
            {
                let app_h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1200));
                    let app_h2 = app_h.clone();
                    let _ = app_h.run_on_main_thread(move || {
                        install_main_focus_guard(&app_h2);
                    });
                });
            }
            let log_path = app
                .path()
                .app_config_dir()
                .map(|d| {
                    let _ = std::fs::create_dir_all(&d);
                    d.join("startup.log")
                })
                .unwrap_or_else(|_| std::path::PathBuf::from("startup.log"));
            let lg = log_path.clone();
            macro_rules! logf {
                ($($a:tt)*) => {{
                    wlog(&lg, &format!($($a)*));
                }};
            }
            logf!("--- start v{} ---", env!("CARGO_PKG_VERSION"));

            // ---- 读配置
            let dir = app.path().app_config_dir().expect("config dir");
            let _ = std::fs::create_dir_all(&dir);
            let cfg_path = dir.join("config.json");
            let cfg: Config = std::fs::read_to_string(&cfg_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            let h = cfg.h.clamp(120, 620);
            let _ = win.set_size(window_size(h));
            if cfg.x >= 0 && cfg.y >= 0 {
                let _ = win.set_position(PhysicalPosition::new(cfg.x, cfg.y));
            } else {
                park_bottom_right(&win, h);
            }

            let pet = Pet {
                rect: Arc::new(Mutex::new([0.0, 0.0, 0.0, 1.0])),
                grid: Arc::new(Mutex::new(Grid::default())),
                dragging: Arc::new(AtomicBool::new(false)),
                hit_state: Arc::new(AtomicI32::new(-1)),
                menu_open: Arc::new(AtomicBool::new(false)),
                cfg: Arc::new(Mutex::new(cfg)),
                cfg_path: cfg_path.clone(),
            };
            let rect_handle = pet.rect.clone();
            let grid_handle = pet.grid.clone();
            let drag_flag = pet.dragging.clone();
            let hit_state = pet.hit_state.clone();
            app.manage(pet);
            #[cfg(windows)]
            install_keyboard_hook(app.handle());
            media::media_init(app.handle());
            dock::dock_init(app.handle());
            gamemode::gamemode_init(app.handle());
            watch_game_mode(app.handle());
            let prefs = ui_prefs();
            let _ = app.emit_to("main", "pet:shadow", prefs.shadow);
            let _ = app.emit_to("main", "pet:demo-background", prefs.demo_background);
            let _ = app.emit_to("main", "pet:chat-emote", prefs.chat_emote);
            app.state::<boot_guard::BootGuard>().phase("page-loaded");
            app.state::<boot_guard::BootGuard>().phase("ready");

            // ---- 默认整窗穿透
            let _ = win.set_ignore_cursor_events(true);

            // ---- 托盘
            let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let sao_item = MenuItem::with_id(app, "sao", "打开菜单", true, None::<&str>)?;
            let wave = MenuItem::with_id(app, "wave", "打个招呼", true, None::<&str>)?;
            let s1 = MenuItem::with_id(app, "size120", "小  120", true, None::<&str>)?;
            let s2 = MenuItem::with_id(app, "size340", "中  340", true, None::<&str>)?;
            let s3 = MenuItem::with_id(app, "size620", "大  620", true, None::<&str>)?;
            let skin_next = MenuItem::with_id(app, "skinNext", "换下一个皮肤", true, None::<&str>)?;
            let skin_dir = MenuItem::with_id(app, "skinFolder", "打开皮肤文件夹", true, None::<&str>)?;
            let auto_c = MenuItem::with_id(app, "autostart", "开机自启（点一下切换）", true, None::<&str>)?;
            let q = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &toggle,
                    &sao_item,
                    &wave,
                    &PredefinedMenuItem::separator(app)?,
                    &s1,
                    &s2,
                    &s3,
                    &PredefinedMenuItem::separator(app)?,
                    &skin_next,
                    &skin_dir,
                    &auto_c,
                    &PredefinedMenuItem::separator(app)?,
                    &q,
                ],
            )?;
            // 注意：TrayIcon 必须活到进程结束。setup 里用局部变量会在闭包返回时被 drop，图标随之消失。
            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("猫鲸桌宠")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, e| {
                    let lp = app
                        .path()
                        .app_config_dir()
                        .map(|d| d.join("startup.log"))
                        .unwrap_or_else(|_| std::path::PathBuf::from("startup.log"));
                    wlog(&lp, &format!("[menu] id={}", e.id().as_ref()));
                    match e.id().as_ref() {
                    "quit" => app.exit(0),
                    "toggle" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(true) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                            }
                        }
                    }
                    "sao" => {
                        let a = app.clone();
                        std::thread::spawn(move || {
                            let _ = open_sao(a);
                        });
                    }
                    "wave" => {
                        match app.emit("pet:play", "emo_wave") {
                            Ok(_) => wlog(&lp, "[menu] emit pet:play ok"),
                            Err(err) => wlog(&lp, &format!("[menu] emit ERR {err}")),
                        }
                    }
                    "skinNext" => {
                        let list = skin_list();
                        if list.len() > 1 {
                            let cur = list.iter().position(|x| x.active).unwrap_or(0);
                            let next = &list[(cur + 1) % list.len()];
                            match skin_set(app.clone(), next.slug.clone()) {
                                Ok(_) => {
                                    wlog(&lp, &format!("[skin] -> {}", next.slug));
                                }
                                Err(err) => wlog(&lp, &format!("[skin] ERR {err}")),
                            }
                        } else {
                            wlog(&lp, "[skin] only one skin");
                        }
                    }
                    "skinFolder" => {
                        let _ = skin_open_folder();
                    }
                    "autostart" => {
                        let on = !autostart_get();
                        match autostart_set(on) {
                            Ok(v) => wlog(&lp, &format!("[auto] -> {v}")),
                            Err(err) => wlog(&lp, &format!("[auto] ERR {err}")),
                        }
                    }
                    "size120" => resize_cmd(app, 120),
                    "size340" => resize_cmd(app, 340),
                    "size620" => resize_cmd(app, 620),
                    _ => {}
                    }
                })
                .build(app);
            match tray {
                Ok(t) => {
                    let r = t.set_visible(true);
                    logf!("tray: built ok, set_visible={:?}", r.err());
                    app.manage(t);
                }
                Err(e) => logf!("tray: BUILD ERROR {e}"),
            }

            // ---- 穿透轮询：50ms 判一次，命中角色才收鼠标
            let w2 = win.clone();
            let menu_flag = app
                .try_state::<Pet>()
                .map(|p| p.menu_open.clone())
                .expect("Pet managed above");
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(50));
                    if drag_flag.load(Ordering::SeqCst) {
                        continue; // 拖动中不改状态
                    }
                    // 可见性读主窗 Win32 WS_VISIBLE 真值，不依赖 Tauri 内部标志或
                    // WebView2 控制器 IPC。注意不能用 win_real_visible(&w2)——它内部
                    // 按标题 "sao" 找窗，对主窗会误读菜单的可见性。
                    #[cfg(windows)]
                    let visible = match main_top_hwnd() {
                        Some(h) => unsafe {
                            (windows::Win32::UI::WindowsAndMessaging::GetWindowLongW(
                                h,
                                windows::Win32::UI::WindowsAndMessaging::GWL_STYLE,
                            ) as u32
                                & 0x1000_0000)
                                != 0
                        },
                        None => true,
                    };
                    #[cfg(not(windows))]
                    let visible = w2.is_visible().unwrap_or(true);
                    if !visible {
                        continue;
                    }
                    // 菜单开着 → 整窗可交互：网格只按动作首帧采样，stand_arms 换帧后
                    // 光标处可能变透明，「点角色收菜单」会穿透掉。窗口矩形只比角色略大，
                    // 菜单开着时让整窗收鼠标代价可忽略（原版靠全局鼠标钩子达到同样效果）。
                    if menu_flag.load(Ordering::SeqCst) {
                        // 整窗可交互已在 open_sao 显示菜单前设好。这里只读 Rust 状态并跳过
                        // 网格切换，不在轮询线程调用 Tauri/WebView2 的同步接口。
                        // 「点角色收菜单」由前端 mousedown→invoke('close_sao') 走主线程隐藏；
                        // 菜单显示期间不做 main/sao 间焦点交接，避开输入法注入链的同步等待。
                        continue;
                    }
                    let (Ok(cur), Ok(org), Ok(sf)) =
                        (w2.cursor_position(), w2.outer_position(), w2.scale_factor())
                    else {
                        continue;
                    };
                    let x = (cur.x - org.x as f64) / sf;
                    let y = (cur.y - org.y as f64) / sf;
                    let q = *rect_handle.lock().unwrap();
                    // 两重判定：① 在角色容器矩形内 ② 命中网格里该点不透明
                    let in_rect = x >= q[0] && x <= q[0] + q[2] && y >= q[1] && y <= q[1] + q[3];
                    let hit = if in_rect {
                        // 注意：x/y 已除以 sf 转成逻辑坐标，所以窗口尺寸也必须换成逻辑尺寸。
                        // inner_size() 返回的是物理像素，直接用会让网格永远错位 → 判定恒失败。
                        let sz = w2.inner_size().unwrap_or_default();
                        let gw = (sz.width as f64 / sf).max(1.0);
                        let gh = (sz.height as f64 / sf).max(1.0);
                        grid_handle.lock().unwrap().hit(x / gw, y / gh)
                    } else {
                        false
                    };
                    // 共享状态：拖动收尾会把 hit_state 置 -1 要求强制重判，
                    // 所以这里不能用局部缓存（否则光标不离角色就永远恢复不了交互）。
                    // prev != want 时下发；prev == -1 必然 != want，天然就是"强制重判"。
                    let want = if hit { 1 } else { 0 };
                    if hit_state.swap(want, Ordering::SeqCst) != want {
                        let _ = w2.set_ignore_cursor_events(!hit);
                    }
                }
            });

            logf!(
                "win: pos={:?} size={:?} visible={:?}",
                win.outer_position(),
                win.outer_size(),
                win.is_visible()
            );

            // ---- 预建 SAO 菜单窗口（隐藏）：WebView2 二次冷启动 ~3.5s，
            //      不预建的话用户右键会看到一段空白，"菜单呼不出"就是这个。
            let app_h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(600));
                match ensure_sao(&app_h) {
                    Ok(_) => {
                        let lp = app_h
                            .path()
                            .app_config_dir()
                            .map(|d| d.join("startup.log"))
                            .unwrap_or_else(|_| std::path::PathBuf::from("startup.log"));
                        wlog(&lp, "[sao] prebuilt hidden ok");
                    }
                    Err(e) => {
                        let lp = app_h
                            .path()
                            .app_config_dir()
                            .map(|d| d.join("startup.log"))
                            .unwrap_or_else(|_| std::path::PathBuf::from("startup.log"));
                        wlog(&lp, &format!("[sao] prebuild ERR {e}"));
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_role_rect,
            set_hit_grid,
            quit,
            set_ignore,
            get_config,
            set_aspect,
            set_pet_size,
            force_wave,
            drag_begin,
            skin_list,
            skin_load,
            builtin_asset_dir,
            skin_set,
            skin_open_folder,
            autostart_get,
            autostart_set,
            list_displays,
            open_sao,
            close_sao,
            sao_escape,
            sao_context,
            sao_action,
            open_panel,
            close_float,
            float_layout,
            harness_chat,
            harness_cancel,
            harness_status,
            dbg_hit,
            chat::config_get,
            chat::config_set,
            chat::config_test,
            chat::chat_history,
            chat::chat_clear,
            harness::harness_detect,
            harness::dialog_browse_repo,
            everything::everything_search,
            everything::everything_open,
            everything::everything_reveal,
            everything::everything_copy,
            sysinfo::sysinfo_get,
            harness::harness_detect,
            envcheck::env_check,
            sysinfo::sysinfo_start,
            sysinfo::sysinfo_start_light,
            sysinfo::sysinfo_stop,
            update::update_check,
            update::update_status,
            update::update_open_url,
            media::media_get,
            media::media_set,
            media::media_probe_once,
            media::media_diag,
            envcheck::env_check,
            envcheck::env_cancel,
            envcheck::env_dismiss,
            envcheck::env_everything_auto,
            envcheck::env_launch_everything,
            envcheck::env_open_url,
            envcheck::env_deploy_everything,
            envcheck::env_deploy_harness,
            persona::persona_list,
            persona::persona_get,
            persona::persona_save,
            persona::persona_delete,
            persona::persona_set_active,
            persona::persona_import_buffer,
            persona::persona_export,
            persona::persona_reveal,
            feature_config::animation_loop_get,
            feature_config::animation_loop_set,
            feature_config::director_get,
            gamemode::gamemode_get,
            gamemode::gamemode_set_manual,
            dock::dock_get,
            dock::dock_select,
            dock::dock_cycle,
            dock::dock_pin,
            dock::dock_clear_ended,
            dock::dock_probe,
            dock::dock_config
        ])
        .build(tauri::generate_context!())
        .expect("tauri build failed")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
                media::media_stop();
                sysinfo::sysinfo_stop_all();
                if let Some(boot) = app.try_state::<boot_guard::BootGuard>() {
                    boot.phase("quit");
                }
            }
        });
}

fn resize_cmd(app: &AppHandle, h: i32) {
    if let Some(w) = app.get_webview_window("main") {
        apply_size(&w, h);
        if let Some(pet) = app.try_state::<Pet>() {
            pet.cfg.lock().unwrap().h = h;
            if let Ok(p) = w.outer_position() {
                let mut c = pet.cfg.lock().unwrap();
                c.x = p.x;
                c.y = p.y;
            }
            save_cfg(&pet);
        }
        sync_float_mirror(app);
    }
}
