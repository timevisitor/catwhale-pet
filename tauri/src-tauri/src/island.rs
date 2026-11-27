//! 灵动岛（Dynamic Island）v2 —— 相对锚点跟随
//!
//! 与 v1（每 80ms 轮询桌宠窗口、按头顶居中重算）相比，位置逻辑换成了
//! 「一次订阅、事件驱动、按存储偏移跟随」：
//!
//! - **锚点**：桌宠角色头顶中点（由主窗上报的逐像素 alpha 网格算出来，带粘滞，
//!   见 `note_pet_box`）。锚点在窗口内是归一化的，桌宠窗口平移时锚点跟着平移，
//!   所以「岛相对锚点的偏移」天然与位移无关。
//! - **偏移**：`Cfg::off`，逻辑 px，指向**胶囊底边中点**（桌面宠的一侧）。
//!   `None` = 旧行为（底边贴在头顶上方 `PET_GAP` 处，且随球/胶囊高度变化）。
//!   用户拖动过之后就是固定值 —— 球 ↔ 胶囊切换时底边不动，胶囊向上长。
//! - **跟随源**：桌宠每次真的动（拖动循环、自动行走、改尺寸、切屏）都调
//!   `pet_moved()`；它只往 channel 里投一个「脏」信号，由唯一的搬运线程
//!   `follower` 取最新状态算一次 set_position。突发位移在 channel 里被合并，
//!   不会每个 8ms 都压一次窗口；闲时（没人动桌宠）线程阻塞在 recv 上，零写入。
//! - **夹取不改偏移**：贴边/跨屏/DPI 变化只在渲染那一刻夹进显示器工作区，
//!   存储的偏移原样保留 —— 否则用户拖到副屏，桌宠一走就被永久改回主屏。
//!
//! 窗口本身仍是固定 640×150、形变全在 CSS 里做（见 `tauri-desktop-app` §灵类浮层）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "island";
const ISLAND_W: f64 = 640.0;
const ISLAND_H: f64 = 150.0;
const BALL_PX: f64 = 56.0;
const CAP_W: f64 = 600.0;
const CAP_H: f64 = 104.0;
const TOP_PAD: f64 = 8.0;
/// 默认排版：胶囊底边离头顶的距离（逻辑 px）
const PET_GAP: f64 = 6.0;
/// 桌宠窗口顶部到「头顶」的留白（逻辑 px），仅在完全没有 alpha 网格时兜底
const PET_HEAD_INSET: f64 = 10.0;
const LEVELS_MAX: usize = 44;
/// 数据聚合周期（只刷内容，不刷位置）
const TICK_MS: u64 = 500;
const SILENT_RESET_MS: u64 = 4000;
/// 命中测试周期：只决定穿不穿透，不动窗口
const HIT_MS: u64 = 80;
/// 判定「偶尔偏得很多」的锚点阈值（相对窗口尺寸）与连续帧数
const ANCHOR_JUMP: f64 = 0.12;
const ANCHOR_MISS_NEED: u32 = 6;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Cfg {
    pub enabled: bool,
    pub msg: bool,
    pub music: bool,
    pub video: bool,
    /// 一条消息在胶囊里停留多久（毫秒）
    pub hold_ms: u64,
    /// 相对角色锚点的偏移（逻辑 px，指向胶囊底边中点）。None = 默认头顶居上。
    pub off: Option<[f64; 2]>,
    /// 消息源：off（默认，不读任何通知）/ mock（验收注入虚构 JSON）/ winrt（系统通知中心，需授权）
    pub notify_source: String,
    /// 歌词：开 = 查公开的网易云接口（可用 CATWHALE_LYRIC_FILE 注入虚构 LRC）
    pub lyric: bool,
    /// 信息卡：点小球展开情报摘要
    pub info: bool,
    /// Agent 看板卡片（读本机 dock 的会话状态；关掉只影响胶囊，不影响面板）
    pub agent: bool,
}

impl Default for Cfg {
    fn default() -> Self {
        Self {
            enabled: true,
            msg: true,
            music: true,
            video: true,
            hold_ms: 8000,
            off: None,
            notify_source: "off".into(),
            lyric: true,
            info: true,
            agent: true,
        }
    }
}

/// 验收注入的「虚构曲目」：走真实的歌词 provider → 解析 → 进岛这条路。
#[derive(Clone)]
struct DemoTrack {
    title: String,
    artist: String,
    app: String,
    started: Instant,
}

struct State {
    levels: Vec<f64>,
    last_msg: Option<Value>,
    msg_at: u64,
    last_msg_id: String,
    track_key: String,
    silent_ms: u64,
    elapsed_ms: u64,
    mode: String,
    payload: Value,
    /// 进度插值锚点（SMTC 的 pos 很久才更新一次）
    prog_key: String,
    prog_pos: f64,
    prog_at: u64,
    prog_last: f64,
    prog_still_ms: u64,
    /// 消息源首轮只记基线，避免开机把历史通知当新消息弹出来
    notify_baseline: bool,
    notify_next: Option<Instant>,
    /// Agent 看板快照（来自本机 dock 的自有 HTTP 服务；验收可 POST 虚构会话）
    agent_at: u64,
    /// 点小球展开的信息卡
    info_open: bool,
    /// 验收注入的虚构曲目（None = 跟随真实媒体会话）
    demo: Option<DemoTrack>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            levels: Vec::new(),
            last_msg: None,
            msg_at: 0,
            last_msg_id: String::new(),
            track_key: String::new(),
            silent_ms: SILENT_RESET_MS,
            elapsed_ms: 0,
            mode: "idle".into(),
            payload: Value::Null,
            prog_key: String::new(),
            prog_pos: 0.0,
            prog_at: 0,
            prog_last: -1.0,
            prog_still_ms: 0,
            notify_baseline: false,
            notify_next: None,
            agent_at: 0,
            info_open: false,
            demo: None,
        }
    }
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static CFG: Mutex<Option<Cfg>> = Mutex::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);
static PINNED: AtomicBool = AtomicBool::new(false);
static HIDDEN_UNTIL: AtomicU64 = AtomicU64::new(0);
/// 用户正在拖岛：搬运线程必须让位（否则会被跟随逻辑拽回去）
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// 桌宠角色的可见包围盒（归一化 x0, 头顶, x1, y1）
static PET_BOX: Mutex<Option<[f64; 4]>> = Mutex::new(None);
/// 粘住的锚点（归一化 cx, head）
static ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static ANCHOR_MISS: AtomicU32 = AtomicU32::new(0);
/// 搬运线程的唤醒通道（只放「脏」信号，最多积压 1 个）
static SIGNAL: OnceLock<mpsc::SyncSender<()>> = OnceLock::new();
/// 上一次真正写进窗口的位置，用来去重（闲时 0 次写入）
static LAST_APPLIED: Mutex<Option<(i32, i32)>> = Mutex::new(None);
/// 诊断计数：信号数 / 实际 set_position 次数
static N_SIGNAL: AtomicU64 = AtomicU64::new(0);
static N_APPLY: AtomicU64 = AtomicU64::new(0);
static N_DRAG: AtomicU64 = AtomicU64::new(0);
/// 跟随模式：event（默认，事件驱动） / legacy（v1 的 80ms 轮询 + 6px 死区）
/// 仅用于 A/B 验收（环境变量 CATWHALE_ISLAND_FOLLOW=legacy），不暴露在界面上。
static FOLLOW_MODE: Mutex<&'static str> = Mutex::new("event");
/// 歌词缓存：key = "title|artist" → Some(lines) / None（查过但没有）
static LYRICS: OnceLock<Mutex<HashMap<String, Option<Lyric>>>> = OnceLock::new();
/// 当前内容在窗口里的水平中心（逻辑 px）。贴边夹取时内容会整体挪向角色一侧，
/// 尖角与命中矩形都按这个值算 —— 页面用 payload.tailX 同步。
static CONTENT_X: Mutex<f64> = Mutex::new(ISLAND_W / 2.0);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 供 info/notify 模块复用（时间戳口径一致）
pub fn now_ms_pub() -> u64 {
    now_ms()
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(State::default());
    }
    f(guard.as_mut().unwrap())
}

fn log_line(msg: &str) {
    use std::io::Write;
    let path = crate::chat::config_dir().join("island.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "[{}] {}", now_ms(), msg);
    }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

fn cfg_path() -> std::path::PathBuf {
    crate::chat::config_dir().join("island.json")
}

fn cfg() -> Cfg {
    if let Ok(g) = CFG.lock() {
        if let Some(c) = g.as_ref() {
            return c.clone();
        }
    }
    let loaded = std::fs::read_to_string(cfg_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Cfg>(&text).ok())
        .unwrap_or_default();
    if let Ok(mut g) = CFG.lock() {
        *g = Some(loaded.clone());
    }
    loaded
}

fn save_cfg(next: &Cfg) {
    if let Ok(mut g) = CFG.lock() {
        *g = Some(next.clone());
    }
    if let Some(dir) = cfg_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(next) {
        let _ = std::fs::write(cfg_path(), text);
    }
}

/* ------------------------------------------------------------------ *
 * 锚点：角色头顶中点
 * ------------------------------------------------------------------ */

pub fn reset_anchor() {
    if let Ok(mut g) = ANCHOR.lock() {
        *g = None;
    }
    ANCHOR_MISS.store(0, Ordering::SeqCst);
}

/// 主窗口每次上报命中网格时调用：算出「头顶」这个锚点。
///
/// 不能直接用 alpha 包围盒顶边 —— 立绘上方常有一根翘起的呆毛，气泡会被顶得离脑袋很远。
/// 取「第一行足够宽（≥ 最宽行 25%）」当头顶。锚点带粘滞：呼吸/摆尾造成的小抖动不跟，
/// 只有偏移超窗口高/宽 12% 且连续 6 帧才重新锚定（真的换皮肤/换姿态）。
pub fn note_pet_box(bbox: &[f64], w: u32, h: u32, data: &[u8]) {
    if bbox.len() != 4 || w == 0 || h == 0 {
        return;
    }
    let (x0, y0, x1, y1) = (bbox[0], bbox[1], bbox[2], bbox[3]);
    if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
        return;
    }
    let mut head_top = y0;
    if data.len() == (w * h) as usize {
        let mut rows = vec![0u32; h as usize];
        let mut first_row = None;
        let mut last_row = 0usize;
        for row in 0..h as usize {
            let mut n = 0u32;
            for col in 0..w as usize {
                if data[row * w as usize + col] != 0 {
                    n += 1;
                }
            }
            rows[row] = n;
            if n > 0 {
                if first_row.is_none() {
                    first_row = Some(row);
                }
                last_row = row;
            }
        }
        if let Some(fr) = first_row {
            let widest = rows.iter().copied().max().unwrap_or(0);
            let need = ((widest as f64 * 0.25).ceil() as u32).max(2);
            let mut hr = fr;
            for row in fr..=last_row {
                if rows[row] >= need {
                    hr = row;
                    break;
                }
            }
            if last_row > fr {
                let frac = (hr - fr) as f64 / (last_row - fr + 1) as f64;
                head_top = y0 + frac * (y1 - y0);
            }
        }
    }
    let cx = ((x0 + x1) / 2.0).clamp(0.0, 1.0);
    let head = head_top.clamp(0.0, 1.0);
    if let Ok(mut g) = PET_BOX.lock() {
        *g = Some([x0.max(0.0), head, x1.min(1.0), y1.min(1.0)]);
    }
    let mut locked = ANCHOR.lock().unwrap_or_else(|e| e.into_inner());
    match *locked {
        None => {
            *locked = Some((cx, head));
            ANCHOR_MISS.store(0, Ordering::SeqCst);
        }
        Some((acx, ahead)) => {
            let d = ((cx - acx).abs()).max((head - ahead).abs());
            if d > ANCHOR_JUMP {
                let n = ANCHOR_MISS.fetch_add(1, Ordering::SeqCst) + 1;
                if n >= ANCHOR_MISS_NEED {
                    *locked = Some((cx, head));
                    ANCHOR_MISS.store(0, Ordering::SeqCst);
                }
            } else {
                ANCHOR_MISS.store(0, Ordering::SeqCst);
            }
        }
    }
}

fn pet_box() -> Option<[f64; 4]> {
    PET_BOX.lock().ok().and_then(|g| *g)
}

/* ------------------------------------------------------------------ *
 * 窗口几何
 * ------------------------------------------------------------------ */

/// 桌宠窗口的物理矩形 (x, y, w, h, scale)
fn pet_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64, f64)> {
    let w = app.get_webview_window("main")?;
    if !w.is_visible().unwrap_or(true) {
        return None;
    }
    let pos = w.outer_position().ok()?;
    let size = w.outer_size().ok()?;
    let sf = w.scale_factor().ok()?;
    Some((
        pos.x as f64,
        pos.y as f64,
        size.width as f64,
        size.height as f64,
        sf,
    ))
}

/// 角色锚点（物理 px）+ 桌宠窗口 scale。归一化包围盒 × 物理尺寸，两者同单位，不用再除 sf。
fn anchor_phys(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let (px, py, pw, ph, sf) = pet_rect(app)?;
    let (acx, ahead) = match ANCHOR.lock().ok().and_then(|g| *g) {
        Some(a) => a,
        None => match pet_box() {
            Some(b) => (((b[0] + b[2]) / 2.0).clamp(0.0, 1.0), b[1]),
            None => (0.5, (PET_HEAD_INSET / (ph / sf).max(1.0)).clamp(0.0, 1.0)),
        },
    };
    Some((px + acx * pw, py + ahead * ph, sf))
}

/// 球/胶囊的可见高度（逻辑 px）
fn content_h(mode: &str) -> f64 {
    if mode == "idle" {
        BALL_PX
    } else {
        CAP_H
    }
}

/// 每种状态的内容宽度（逻辑 px），与 island.html 的 `--w` 一一对应。
/// 消息要宽、Agent/情报窄一些 —— 与 Electron v0.7.1 的取值保持一致。
fn content_w(mode: &str) -> f64 {
    match mode {
        "idle" => BALL_PX,
        "msg" => 560.0,
        "music" => 600.0,
        "video" => 520.0,
        "agent" => 420.0,
        "info" => 452.0,
        _ => CAP_W,
    }
}

/// 期望的窗口左上角（物理 px）：锚点 + 存储偏移 − 内容底边中点在窗口内的相对位置。
fn island_target(app: &AppHandle, mode: &str) -> Option<(i32, i32)> {
    let (ax, ay, psf) = anchor_phys(app)?;
    let c = cfg();
    let ch = content_h(mode);
    // 默认（没拖动过）：内容**底边**贴头顶上方 PET_GAP，高度随球/胶囊变化 —— 与 v1 一致。
    // off 指向底边中点，所以默认只有 -PET_GAP 这一项（不是 -(gap+ch)：那样会整体抬高一个内容高度）
    let off = c.off.unwrap_or([0.0, -PET_GAP]);
    let sf_i = app
        .get_webview_window(LABEL)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(psf);
    let x = ax + off[0] * psf - (ISLAND_W / 2.0) * sf_i;
    let y = ay + off[1] * psf - (TOP_PAD + ch) * sf_i;
    Some((x.round() as i32, y.round() as i32))
}

/// 落点：窗口位置 + 内容在窗口内的水平中心（逻辑 px，贴边夹取时内容挪向角色一侧）。
/// 返回 (x, y, tail_x, content_x)；tail_x / content_x 都是相对窗口左边的 CSS px。
fn placement(app: &AppHandle, mode: &str) -> Option<(i32, i32, f64, f64)> {
    let (tx, ty) = island_target(app, mode)?;
    let (w, h) = island_size_phys(app);
    let (x, y) = clamp_to_monitor(app, tx, ty, w, h);
    let (ax, _, _) = anchor_phys(app)?;
    let sf = app
        .get_webview_window(LABEL)
        .and_then(|win| win.scale_factor().ok())
        .unwrap_or(1.0);
    let tail = ((ax - x as f64) / sf).clamp(26.0, ISLAND_W - 26.0);
    let cw = content_w(mode);
    let content_x = tail.clamp(cw / 2.0 + 4.0, ISLAND_W - cw / 2.0 - 4.0);
    if let Ok(mut g) = CONTENT_X.lock() {
        *g = content_x;
    }
    Some((x, y, tail, content_x))
}

/// 把窗口矩形夹进「离它最近的那块显示器」的工作区。
/// 只影响这一次渲染，绝不回写 Cfg::off —— 否则跨屏摆放会被桌宠的移动吃掉。
fn clamp_to_monitor(app: &AppHandle, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    let monitors = match app.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        _ => return (x, y),
    };
    let cx = x + w / 2;
    let cy = y + h / 2;
    let mut best = 0usize;
    let mut best_d = i64::MAX;
    for (i, m) in monitors.iter().enumerate() {
        let a = m.work_area();
        let (mx, my) = (a.position.x as i64, a.position.y as i64);
        let (mw, mh) = (a.size.width as i64, a.size.height as i64);
        let inside = (cx as i64) >= mx
            && (cx as i64) < mx + mw
            && (cy as i64) >= my
            && (cy as i64) < my + mh;
        let d = if inside {
            0
        } else {
            let dx = ((mx + mw / 2) - cx as i64).abs();
            let dy = ((my + mh / 2) - cy as i64).abs();
            dx + dy
        };
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    let a = monitors[best].work_area();
    let min_x = a.position.x;
    let min_y = a.position.y;
    let max_x = (a.position.x + a.size.width as i32 - w).max(min_x);
    let max_y = (a.position.y + a.size.height as i32 - h).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn island_size_phys(app: &AppHandle) -> (i32, i32) {
    let sf = app
        .get_webview_window(LABEL)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    (
        (ISLAND_W * sf).round() as i32,
        (ISLAND_H * sf).round() as i32,
    )
}

/// 算一次目标位置并（必要时）写进窗口。返回是否真的写了。
fn apply(app: &AppHandle) -> bool {
    if DRAGGING.load(Ordering::SeqCst) {
        return false;
    }
    let c = cfg();
    if !c.enabled {
        return false;
    }
    let mode = with_state(|s| s.mode.clone());
    let Some((x, y, _, _)) = placement(app, &mode) else {
        // 桌宠隐藏/最小化：岛一起收起来，别杵在屏幕顶上
        hide_island(app);
        return false;
    };
    {
        let mut last = LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some((x, y)) {
            return false;
        }
        *last = Some((x, y));
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        N_APPLY.fetch_add(1, Ordering::SeqCst);
        return true;
    }
    false
}

/// 桌宠几何变了（拖动 / 行走 / 改尺寸 / 切屏 / 锚点更新）→ 投一个脏信号。
/// 非阻塞、可合并：连发的位移不会排队，搬运线程只处理最新状态。
pub fn pet_moved(app: &AppHandle) {
    N_SIGNAL.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = SIGNAL.get() {
        let _ = tx.try_send(());
    } else {
        // 还没 init（启动早期）：直接算一次，不做线程
        let _ = app;
    }
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

fn ensure_island(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("island.html".into()))
        .title("island")
        .inner_size(ISLAND_W, ISLAND_H)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focusable(false) // WS_EX_NOACTIVATE：点了不抢前台
        .visible(false)
        .additional_browser_args(crate::WEBVIEW_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_ignore_cursor_events(true);
    if let Some((x, y, _, _)) = placement(app, "idle") {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        *LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = Some((x, y));
    }
    Ok(win)
}

fn show_island(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
        }
    }
}

fn hide_island(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            // 下次显示时重新贴一次，别复用旧坐标
            *LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
}

/* ------------------------------------------------------------------ *
 * 跟随线程：唯一的窗口搬运者
 * ------------------------------------------------------------------ */

fn follower(app: AppHandle) {
    // 容量 1：突发位移压成一个「脏」位，搬运线程醒了就取最新状态
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let _ = SIGNAL.set(tx);
    std::thread::spawn(move || {
        // 阻塞等信号；闲时（桌宠不动）这里什么都不做
        while rx.recv().is_ok() {
            // 合并突发：只保留最后一帧状态
            while rx.try_recv().is_ok() {}
            let _ = apply(&app);
        }
    });
}

/// 80ms 一轮：光标是否落在「当前形状」里 → 决定穿不穿透。
/// 只调用 set_ignore_cursor_events（且仅在状态翻转时），不改窗口位置。
fn hit_watcher(app: AppHandle) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut last_inside: Option<bool> = None;
    loop {
        std::thread::sleep(Duration::from_millis(HIT_MS));
        let c = cfg();
        if !c.enabled || DRAGGING.load(Ordering::SeqCst) {
            continue;
        }
        let Some(w) = app.get_webview_window(LABEL) else {
            continue;
        };
        if !w.is_visible().unwrap_or(false) {
            last_inside = None;
            continue;
        }
        let mode = with_state(|s| s.mode.clone());
        #[cfg(windows)]
        unsafe {
            let mut pt = POINT::default();
            if GetCursorPos(&mut pt).is_err() {
                continue;
            }
            if let (Ok(pos), Ok(sf)) = (w.outer_position(), w.scale_factor()) {
                let (cw, ch) = (content_w(&mode), content_h(&mode));
                let cx = pos.x as f64 + (*CONTENT_X.lock().unwrap_or_else(|e| e.into_inner())) * sf
                    - cw * sf / 2.0;
                let cy = pos.y as f64 + TOP_PAD * sf;
                let px = pt.x as f64;
                let py = pt.y as f64;
                let inside = px >= cx - 4.0
                    && px <= cx + cw * sf + 4.0
                    && py >= cy - 4.0
                    && py <= cy + ch * sf + 4.0;
                if last_inside != Some(inside) {
                    last_inside = Some(inside);
                    let _ = w.set_ignore_cursor_events(!inside);
                }
            }
        }
    }
}

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 }
}

/// v1 的跟随方式（只用于 A/B 对比）：80ms 轮询、头顶居中、6px 死区、只夹主显示器。
/// 它不看 `Cfg::off`，所以用户拖过的偏移在 legacy 模式下会被忽略 —— 这正是要对比的差异。
fn legacy_poller(app: AppHandle) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut last_pos = (i32::MIN, i32::MIN);
    let mut last_inside: Option<bool> = None;
    loop {
        std::thread::sleep(Duration::from_millis(80));
        let c = cfg();
        if !c.enabled {
            continue;
        }
        let mode = with_state(|s| s.mode.clone());
        if let Some((ax, ay, psf)) = anchor_phys(&app) {
            if let Some(w) = app.get_webview_window(LABEL) {
                let sf_i = w.scale_factor().unwrap_or(psf);
                let ch = content_h(&mode);
                let mut x = ax - (ISLAND_W / 2.0) * sf_i;
                let mut y = ay - PET_GAP * psf - (TOP_PAD + ch) * sf_i;
                if let Ok(Some(mon)) = app.primary_monitor() {
                    let mw = mon.size().width as f64 * mon.scale_factor();
                    let mx = mon.position().x as f64;
                    let my = mon.position().y as f64;
                    if x < mx {
                        x = mx;
                    }
                    if x + ISLAND_W * sf_i > mx + mw {
                        x = mx + mw - ISLAND_W * sf_i;
                    }
                    if y < my {
                        y = my;
                    }
                }
                let (x, y) = (x.round() as i32, y.round() as i32);
                if (x - last_pos.0).abs() >= 6 || (y - last_pos.1).abs() >= 6 || last_pos.0 == i32::MIN {
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                    N_APPLY.fetch_add(1, Ordering::SeqCst);
                    last_pos = (x, y);
                }
                // 命中测试与 v1 相同：光标落在球/胶囊里才吃事件
                #[cfg(windows)]
                unsafe {
                    let mut pt = POINT::default();
                    if GetCursorPos(&mut pt).is_ok() {
                        if let Ok(pos) = w.outer_position() {
                            let (cw, chh) = if mode == "idle" {
                                (BALL_PX, BALL_PX)
                            } else {
                                (CAP_W, CAP_H)
                            };
                            let cx = pos.x as f64 + (ISLAND_W - cw) * sf_i / 2.0;
                            let cy = pos.y as f64 + TOP_PAD * sf_i;
                            let inside = pt.x as f64 >= cx - 4.0
                                && pt.x as f64 <= cx + cw * sf_i + 4.0
                                && pt.y as f64 >= cy - 4.0
                                && pt.y as f64 <= cy + chh * sf_i + 4.0;
                            if last_inside != Some(inside) {
                                last_inside = Some(inside);
                                let _ = w.set_ignore_cursor_events(!inside);
                            }
                        }
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * 歌词：网易云公开接口（真实 provider）/ CATWHALE_LYRIC_FILE（虚构 provider）
 * ------------------------------------------------------------------ */

#[derive(Clone)]
struct Lyric {
    /// (起始毫秒, 文本)
    lines: Vec<(u64, String)>,
}

fn http_get(url: &str) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .header("Referer", "https://music.163.com/")
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.text().ok()
}

fn parse_lrc(text: &str) -> Vec<(u64, String)> {
    let mut out: Vec<(u64, String)> = Vec::new();
    for line in text.lines() {
        let Some(close) = line.find(']') else { continue };
        if !line.starts_with('[') || close < 2 {
            continue;
        }
        let stamp = &line[1..close];
        let body = line[close + 1..].trim().to_string();
        if body.is_empty() {
            continue;
        }
        let mut parts = stamp.split(':');
        let (Some(mm), Some(ss)) = (parts.next(), parts.next()) else { continue };
        let (Ok(m), Ok(s)) = (mm.trim().parse::<u64>(), ss.trim().parse::<f64>()) else { continue };
        out.push((m * 60_000 + (s * 1000.0) as u64, body));
    }
    out.sort_by_key(|(ms, _)| *ms);
    out
}

fn url_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// 真实 provider：按「歌名 + 歌手」搜 id 再取 LRC（公开接口，不需要账号）。
fn fetch_lyric_net(title: &str, artist: &str) -> Option<Lyric> {
    let q = format!("{} {}", title.trim(), artist.trim());
    let search = http_get(&format!(
        "https://music.163.com/api/search/get/web?s={}&type=1&limit=1",
        url_encode(&q)
    ))?;
    let val: Value = serde_json::from_str(&search).ok()?;
    let id = val
        .get("result")?
        .get("songs")?
        .as_array()?
        .first()?
        .get("id")?
        .as_i64()?;
    let lyric_json = http_get(&format!(
        "https://music.163.com/api/song/lyric?id={}&lv=-1&kv=-1&tv=-1",
        id
    ))?;
    let lv: Value = serde_json::from_str(&lyric_json).ok()?;
    let lrc = lv.get("lrc")?.get("lyric")?.as_str()?.to_string();
    let lines = parse_lrc(&lrc);
    if lines.is_empty() {
        None
    } else {
        Some(Lyric { lines })
    }
}

/// 虚构 provider：`CATWHALE_LYRIC_FILE` 指向一份 LRC，任何曲目都用它。
fn fetch_lyric_mock() -> Option<Lyric> {
    let path = std::env::var("CATWHALE_LYRIC_FILE").ok()?;
    if path.trim().is_empty() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let lines = parse_lrc(&text);
    if lines.is_empty() {
        None
    } else {
        Some(Lyric { lines })
    }
}

fn lyric_at(key: &str, elapsed_ms: u64) -> (String, String) {
    let store = LYRICS.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(guard) = store.lock() else {
        return (String::new(), String::new());
    };
    match guard.get(key).cloned() {
        Some(Some(l)) => {
            let mut cur = String::new();
            let mut next = String::new();
            for (ms, text) in l.lines.iter() {
                if *ms <= elapsed_ms + 200 {
                    cur = text.clone();
                } else {
                    next = text.clone();
                    break;
                }
            }
            (cur, next)
        }
        _ => (String::new(), String::new()),
    }
}

fn ensure_lyric(key: &str, title: &str, artist: &str, enabled: bool) {
    if key.is_empty() || !enabled {
        return;
    }
    let store = LYRICS.get_or_init(|| Mutex::new(HashMap::new()));
    let seen = store.lock().map(|g| g.contains_key(key)).unwrap_or(true);
    if seen {
        return;
    }
    if let Ok(mut g) = store.lock() {
        g.insert(key.to_string(), None); // 占位，避免并发重复请求
    }
    let key2 = key.to_string();
    let title2 = title.to_string();
    let artist2 = artist.to_string();
    std::thread::spawn(move || {
        let got = if std::env::var("CATWHALE_LYRIC_FILE").map(|p| !p.trim().is_empty()).unwrap_or(false) {
            fetch_lyric_mock()
        } else {
            fetch_lyric_net(&title2, &artist2)
        };
        if let Some(store) = LYRICS.get() {
            if let Ok(mut g) = store.lock() {
                g.insert(key2, got);
            }
        }
    });
}

/* ------------------------------------------------------------------ *
 * 消息：provider → 解析 → 去重 / 首轮基线 → 进岛
 * ------------------------------------------------------------------ */

/// 从一条通知里抽「会话名 / 正文」。
/// 微信 4.x：texts[0]=应用名、texts[1]=会话名、texts[2]="发送者 : 正文"；
/// QQ/飞书等：texts[0]=会话名、其余是正文。
fn split_notify(item: &Value, app: &str) -> (String, String) {
    let texts: Vec<String> = item
        .get("texts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().unwrap_or_default().trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mut rest: Vec<String> = texts
        .iter()
        .filter(|t| t.as_str() != app)
        .cloned()
        .collect();
    if rest.is_empty() {
        let title = item.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let body = item.get("body").and_then(Value::as_str).unwrap_or("").trim().to_string();
        return (title, body);
    }
    if rest.len() == 1 {
        return (String::new(), rest.remove(0));
    }
    let session = rest.remove(0);
    let body = rest.join(" ");
    (session, body)
}

fn tick_notifications(cfg: &Cfg) {
    if !cfg.msg || cfg.notify_source.eq_ignore_ascii_case("off") {
        return;
    }
    let due = with_state(|s| match s.notify_next {
        Some(t) => t.elapsed() >= Duration::from_millis(4000),
        None => true,
    });
    if !due {
        return;
    }
    with_state(|s| s.notify_next = Some(Instant::now()));
    let raw = crate::notify::poll(&cfg.notify_source);
    let items = raw.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(first) = items.first() else { return };
    let app_name = first
        .get("app")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let id = first
        .get("id")
        .map(|v| v.to_string())
        .unwrap_or_default();
    if app_name.is_empty() || id.is_empty() {
        return;
    }
    let (session, body) = split_notify(first, &app_name);
    with_state(|s| {
        if s.last_msg_id == id {
            return;
        }
        s.last_msg_id = id.clone();
        // 启动后第一条只记基线：否则一开机就把历史通知当成新消息弹出来
        if !s.notify_baseline {
            s.notify_baseline = true;
            return;
        }
        s.msg_at = now_ms();
        s.last_msg = Some(json!({
            "app": app_name,
            "title": session,
            "text": body,
            "ts": s.msg_at,
            "count": 1,
            "source": cfg.notify_source,
        }));
    });
}

/* ------------------------------------------------------------------ *
 * Agent 看板 → 胶囊里的「Agent 态」
 * ------------------------------------------------------------------ */

fn agent_view(app: &AppHandle) -> Option<Value> {
    let snap = crate::dock::snapshot_quick(app);
    let list = snap.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    let rank = |st: &str| match st {
        "waiting_user" => 3,
        "working" | "speaking" => 2,
        _ => 0,
    };
    let mut pick: Option<&Value> = None;
    let mut best = 0;
    for it in &list {
        let r = rank(it.get("state").and_then(Value::as_str).unwrap_or(""));
        if r > best {
            best = r;
            pick = Some(it);
        }
    }
    let mut fresh = false;
    if pick.is_none() {
        // 刚干完的给一次露脸机会（12 秒内），别让「完成」一闪而过
        let now = now_ms();
        let mut newest: Option<(&Value, u64)> = None;
        for it in &list {
            let st = it.get("state").and_then(Value::as_str).unwrap_or("");
            if st == "done" || st == "error" {
                let at = it.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
                if now.saturating_sub(at) < 12_000 && newest.map(|(_, t)| at > t).unwrap_or(true) {
                    newest = Some((it, at));
                }
            }
        }
        if let Some((it, _)) = newest {
            pick = Some(it);
            fresh = true;
        }
    }
    let pick = pick?;
    let name = pick
        .get("agentName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let id = pick.get("agent").and_then(Value::as_str).unwrap_or("");
            match id {
                "claude-code" => "Claude Code".into(),
                "codex" => "Codex".into(),
                other if !other.is_empty() => other.to_string(),
                _ => "Agent".into(),
            }
        });
    let state = pick.get("state").and_then(Value::as_str).unwrap_or("").to_string();
    let label = match state.as_str() {
        "working" => "正在干活",
        "speaking" => "正在说话",
        "waiting_user" => "等你确认",
        "done" => "完成了",
        "error" => "出错了",
        _ => "闲置",
    };
    let detail_src = pick
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| pick.get("lastAgent").and_then(Value::as_str))
        .unwrap_or("");
    let detail: String = detail_src.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail: String = detail.chars().take(120).collect();
    let busy = matches!(state.as_str(), "working" | "speaking" | "waiting_user");
    let at = pick.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
    with_state(|s| s.agent_at = at);
    Some(json!({
        "agent": name,
        "state": state,
        "label": label,
        "detail": detail,
        "busy": busy,
        "fresh": fresh,
        "count": list.len(),
        "at": at,
    }))
}


/* ------------------------------------------------------------------ *
 * 媒体 → 胶囊内容
 * ------------------------------------------------------------------ */

fn friendly_app(proc_name: &str) -> String {
    let p = proc_name.to_lowercase();
    let name = if p.contains("cloudmusic") || p.contains("netease") {
        "网易云"
    } else if p.contains("qqmusic") {
        "QQ音乐"
    } else if p.contains("kugou") {
        "酷狗"
    } else if p.contains("kuwo") {
        "酷我"
    } else if p.contains("spotify") {
        "Spotify"
    } else if p.contains("potplayer") {
        "PotPlayer"
    } else if p.contains("vlc") {
        "VLC"
    } else if p.contains("msedge") || p.contains("chrome") || p.contains("firefox") {
        "浏览器"
    } else {
        return proc_name.trim_end_matches(".exe").to_string();
    };
    name.to_string()
}

fn demo_levels(elapsed_ms: u64) -> Vec<f64> {
    (0..LEVELS_MAX)
        .map(|i| {
            let t = (elapsed_ms as f64 / 1000.0) - (LEVELS_MAX - i) as f64 * 0.5;
            let v = (t * 2.1).sin().abs() * 0.72 + 0.18;
            v.clamp(0.0, 1.0)
        })
        .collect()
}

/// 媒体视图。demo 存在时用虚构曲目（验收），否则读真实媒体会话快照。
fn tick_media(
    cfg: &Cfg,
    demo: Option<&DemoTrack>,
) -> (String, String, String, String, String, Vec<f64>, Option<f64>, Option<f64>, bool, u64) {
    if let Some(d) = demo {
        let elapsed = d.started.elapsed().as_millis() as u64;
        let levels = demo_levels(elapsed);
        with_state(|s| {
            s.levels = levels.clone();
            s.silent_ms = 0;
        });
        return (
            "music".into(),
            d.title.clone(),
            d.artist.clone(),
            d.app.clone(),
            friendly_app(&d.app),
            levels,
            None,
            Some(210.0),
            true,
            elapsed,
        );
    }
    if !(cfg.music || cfg.video) {
        return (
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            vec![0.0; 12],
            None,
            None,
            false,
            0,
        );
    }
    let snap = crate::media::snapshot_for_island();
    let info = snap.get("info").cloned().unwrap_or(Value::Null);
    let kind = snap.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
    let playing = snap.get("playing").and_then(Value::as_bool).unwrap_or(false);
    let title = info.get("title").and_then(Value::as_str).unwrap_or("").to_string();
    let artist = info.get("artist").and_then(Value::as_str).unwrap_or("").to_string();
    let app = info.get("proc").and_then(Value::as_str).unwrap_or("").to_string();
    let peak = info.get("peak").and_then(Value::as_f64).unwrap_or(0.0);
    let pos = info.get("pos").and_then(Value::as_f64);
    let dur = info.get("end").and_then(Value::as_f64);

    let levels = with_state(|s| {
        s.levels.push(if playing { peak.clamp(0.0, 1.0) } else { 0.0 });
        if s.levels.len() > LEVELS_MAX {
            let drop = s.levels.len() - LEVELS_MAX;
            s.levels.drain(0..drop);
        }
        s.silent_ms = if playing {
            if peak > 0.004 {
                0
            } else {
                s.silent_ms + TICK_MS
            }
        } else {
            SILENT_RESET_MS
        };
        s.levels.clone()
    });
    let app_name = friendly_app(&app);
    let elapsed = with_state(|s| {
        let key = format!("{}|{}", title, artist);
        if s.track_key != key {
            s.track_key = key.clone();
            s.elapsed_ms = 0;
        } else if s.silent_ms < SILENT_RESET_MS && !title.is_empty() {
            s.elapsed_ms += TICK_MS;
        }
        s.elapsed_ms
    });
    (kind, title, artist, app, app_name, levels, pos, dur, playing, elapsed)
}

fn build_payload(cfg: &Cfg, app: &AppHandle) -> Value {
    let demo = with_state(|s| s.demo.clone());
    let (kind, title, artist, app_proc, app_name, levels, pos, dur, playing, elapsed) =
        tick_media(cfg, demo.as_ref());
    let key = if title.is_empty() {
        String::new()
    } else {
        format!("{}|{}", title, artist)
    };
    // 真实 provider / 虚构 provider 都走这一条：按 key 拉一次歌词，之后按进度取当前行
    ensure_lyric(&key, &title, &artist, cfg.lyric);
    let (lyric, lyric_next) = if !title.is_empty() {
        lyric_at(&key, elapsed)
    } else {
        (String::new(), String::new())
    };

    let (shown_pos, estimated) = with_state(|s| {
        let now = now_ms();
        let Some(raw) = pos else {
            return (None, false);
        };
        if s.prog_key != key {
            s.prog_key = key.clone();
            s.prog_pos = raw;
            s.prog_at = now;
            s.prog_last = raw;
            s.prog_still_ms = 0;
        } else if (raw - s.prog_last).abs() > 0.3 {
            s.prog_pos = raw;
            s.prog_at = now;
            s.prog_last = raw;
            s.prog_still_ms = 0;
        } else {
            s.prog_still_ms += TICK_MS;
        }
        let add = if playing {
            (now.saturating_sub(s.prog_at)) as f64 / 1000.0
        } else {
            0.0
        };
        let mut v = s.prog_pos + add;
        if let Some(d) = dur {
            if d > 0.5 && v > d {
                v = d;
            }
        }
        (Some(v), s.prog_still_ms > 5000)
    });

    let msg = with_state(|s| s.last_msg.clone());
    let msg_at = with_state(|s| s.msg_at);
    let hold = cfg.hold_ms.max(1500);
    let msg_fresh = cfg.msg && msg.is_some() && now_ms().saturating_sub(msg_at) < hold;

    let playing_music = cfg.music && kind == "music" && !title.is_empty();
    let playing_video = cfg.video && kind == "video" && !title.is_empty();

    // Agent 看板：只在真忙（working/speaking/waiting_user）时占胶囊，
    // 干完的只在 12 秒内露一次脸（见 agent_view）。
    let agent = if cfg.agent { agent_view(app) } else { None };
    let agent_on = agent
        .as_ref()
        .map(|a| a.get("busy").and_then(Value::as_bool).unwrap_or(false))
        .unwrap_or(false);
    let info_open = with_state(|s| s.info_open);
    let info = if cfg.info { Some(crate::info::summary()) } else { None };
    let badge = info
        .as_ref()
        .map(|i| {
            let n = |k: &str| i.get(k).and_then(Value::as_u64).unwrap_or(0);
            n("todoOpen") + n("unread") + n("notesOpen")
        })
        .unwrap_or(0);

    let mut mode: String = if msg_fresh {
        "msg".to_string()
    } else if agent_on {
        "agent".to_string()
    } else if playing_video {
        "video".to_string()
    } else if playing_music {
        "music".to_string()
    } else if cfg.info && info_open {
        "info".to_string()
    } else {
        "idle".to_string()
    };
    if PINNED.load(Ordering::SeqCst) && mode == "idle" {
        mode = with_state(|s| s.mode.clone());
        if mode.is_empty() {
            mode = "idle".to_string();
        }
    }

    let (_, _, tail_x, content_x) = placement(app, &mode)
        .unwrap_or((0, 0, ISLAND_W / 2.0, ISLAND_W / 2.0));

    json!({
        "mode": mode,
        "pinned": PINNED.load(Ordering::SeqCst),
        "music": {
            "title": title,
            "artist": artist,
            "app": app_proc,
            "appName": app_name,
            "levels": levels,
            "pos": shown_pos,
            "dur": dur,
            "estimated": estimated,
            "lyric": lyric,
            "lyricNext": lyric_next,
            "elapsed": (elapsed as f64) / 1000.0,
        },
        "msg": msg.unwrap_or(Value::Null),
        "agent": agent.unwrap_or(Value::Null),
        "info": info.unwrap_or(Value::Null),
        "badge": badge,
        "tailX": tail_x,
        "contentX": content_x,
        "video": {
            "title": if kind == "video" { title } else { String::new() },
            "appName": app_name,
            "pos": shown_pos,
            "dur": dur,
            "estimated": estimated,
        },
        "cfg": cfg,
        "ts": now_ms(),
    })
}

/// 数据聚合：刷内容 / 显隐；模式变化时通知搬运线程（底边锚定，胶囊向上长）
fn aggregator(app: AppHandle) {
    loop {
        let cfg = cfg();
        if cfg.enabled {
            tick_notifications(&cfg);
            let payload = build_payload(&cfg, &app);
            let mode = payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("idle")
                .to_string();
            let prev = with_state(|s| {
                let prev = s.mode.clone();
                // 拖动期间冻结模式：中途形变会让「底边 = 松手位置」算歪
                if !DRAGGING.load(Ordering::SeqCst) {
                    s.mode = mode.clone();
                }
                s.payload = payload.clone();
                prev
            });
            let hidden = now_ms() < HIDDEN_UNTIL.load(Ordering::SeqCst);
            if !hidden || mode != "idle" {
                if hidden && mode != "idle" {
                    HIDDEN_UNTIL.store(0, Ordering::SeqCst);
                }
                show_island(&app);
            } else {
                hide_island(&app);
            }
            if prev != mode {
                pet_moved(&app); // 球↔胶囊高度变了，重算一次（事件，不是轮询）
            }
            let _ = app.emit_to(LABEL, "island:data", payload);
        } else {
            hide_island(&app);
        }
        std::thread::sleep(Duration::from_millis(TICK_MS));
    }
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

pub fn island_init(app: &AppHandle) {
    // A/B 诊断开关：CATWHALE_ISLAND_FOLLOW=legacy 时退回 v1 的 80ms 轮询跟随。
    // 正式使用永远是 event（默认）；保留它只为在同一台机、同一条轨迹上量差异。
    let mode = std::env::var("CATWHALE_ISLAND_FOLLOW").unwrap_or_default();
    if mode.eq_ignore_ascii_case("legacy") {
        if let Ok(mut m) = FOLLOW_MODE.lock() {
            *m = "legacy";
        }
        log_line("island v2 started (legacy follow: 80ms poll / 6px deadband)");
        let _ = ensure_island(app);
        let a = app.clone();
        std::thread::spawn(move || legacy_poller(a));
        if cfg().enabled {
            start_data_only(app.clone());
        }
        return;
    }
    follower(app.clone());
    let _ = ensure_island(app);
    let cfg = cfg();
    if cfg.enabled {
        start(app.clone());
    } else {
        hide_island(app);
    }
}

/// legacy 模式只跑数据聚合（不跑事件跟随与命中线程：命中测试在 legacy_poller 里）
fn start_data_only(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let cfg = cfg();
    if cfg.music || cfg.video {
        let _ = crate::media::media_set(app.clone(), Some(json!({ "enabled": true, "pollMs": 600 })));
    }
    let a1 = app.clone();
    std::thread::spawn(move || aggregator(a1));
}

fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let cfg = cfg();
    if cfg.music || cfg.video {
        let _ = crate::media::media_set(
            app.clone(),
            Some(json!({ "enabled": true, "pollMs": 600 })),
        );
    }
    let a1 = app.clone();
    std::thread::spawn(move || aggregator(a1));
    let a2 = app.clone();
    std::thread::spawn(move || hit_watcher(a2));
    log_line("island v2 started");
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn island_get(app: AppHandle) -> Value {
    let _ = ensure_island(&app);
    let cfg = cfg();
    let payload = with_state(|s| s.payload.clone());
    json!({ "ok": true, "cfg": cfg, "data": payload })
}

#[tauri::command]
pub fn island_set(app: AppHandle, patch: Option<Value>) -> Value {
    let mut next = cfg();
    if let Some(obj) = patch.and_then(|p| p.as_object().cloned()) {
        if let Some(v) = obj.get("enabled").and_then(Value::as_bool) {
            next.enabled = v;
        }
        if let Some(v) = obj.get("msg").and_then(Value::as_bool) {
            next.msg = v;
        }
        if let Some(v) = obj.get("music").and_then(Value::as_bool) {
            next.music = v;
        }
        if let Some(v) = obj.get("video").and_then(Value::as_bool) {
            next.video = v;
        }
        if let Some(v) = obj.get("holdMs").and_then(Value::as_u64) {
            next.hold_ms = v.clamp(1500, 60_000);
        }
        if let Some(v) = obj.get("notifySource").and_then(Value::as_str) {
            let s = v.to_ascii_lowercase();
            if s == "off" || s == "mock" || s == "winrt" {
                next.notify_source = s;
                // 切换来源后重新记基线，避免把上一来源的 id 当成「已看过」
                with_state(|st| {
                    st.notify_baseline = false;
                    st.notify_next = None;
                });
            }
        }
        if let Some(v) = obj.get("lyric").and_then(Value::as_bool) {
            next.lyric = v;
        }
        if let Some(v) = obj.get("agent").and_then(Value::as_bool) {
            next.agent = v;
        }
        if let Some(v) = obj.get("info").and_then(Value::as_bool) {
            next.info = v;
            if !v {
                with_state(|st| st.info_open = false);
            }
        }
    }
    save_cfg(&next);
    if next.enabled {
        let _ = ensure_island(&app);
        start(app.clone());
        show_island(&app);
        pet_moved(&app);
    } else {
        hide_island(&app);
    }
    json!({ "ok": true, "cfg": next })
}

#[tauri::command]
pub fn island_cmd(app: AppHandle, cmd: String) -> Value {
    match cmd.as_str() {
        "expand" => {
            HIDDEN_UNTIL.store(0, Ordering::SeqCst);
            show_island(&app);
        }
        "pin" => {
            let now = PINNED.load(Ordering::SeqCst);
            PINNED.store(!now, Ordering::SeqCst);
            HIDDEN_UNTIL.store(0, Ordering::SeqCst);
        }
        "dismiss" => {
            PINNED.store(false, Ordering::SeqCst);
            HIDDEN_UNTIL.store(now_ms() + 60_000, Ordering::SeqCst);
            with_state(|s| s.info_open = false);
            hide_island(&app);
        }
        // 点小球：展开「情报卡」（信息中枢摘要 + Agent 摘要并进胶囊）
        "info" => {
            HIDDEN_UNTIL.store(0, Ordering::SeqCst);
            with_state(|s| s.info_open = true);
            show_island(&app);
            pet_moved(&app);
        }
        // 情报卡右侧按钮：打开本机的综合面板（Agent 看板页）
        "hud" => {
            let a2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::open_panel(a2, "dock".into()).await;
            });
        }
        _ => {}
    }
    json!({ "ok": true, "pinned": PINNED.load(Ordering::SeqCst) })
}

/// 造一条示例消息 / 虚构曲目（联调与验收用）。
/// 真实消息只可能来自 `notifySource` 指定的 provider；没有真实新消息时用它验证链路。
#[tauri::command]
pub fn island_demo(app: AppHandle, mode: Option<String>) -> Value {
    let what = mode.unwrap_or_else(|| "msg".into());
    match what.as_str() {
        "msg" => {
            with_state(|s| {
                s.last_msg = Some(json!({
                    "app": "猫鲸演示",
                    "title": "预览消息",
                    "text": "这是灵动岛的预览消息：用来验收消息态排版与跟随，不读取真实通知。",
                    "ts": now_ms(),
                    "count": 2,
                    "source": "demo",
                }));
                s.msg_at = now_ms();
            });
        }
        "music" => {
            with_state(|s| {
                s.demo = Some(DemoTrack {
                    title: "验收曲目 · 虚构".into(),
                    artist: "Mock Artist".into(),
                    app: "catwhale-demo".into(),
                    started: Instant::now(),
                });
                // 换曲 → 歌词缓存重新走一次 provider
                if let Some(store) = LYRICS.get() {
                    if let Ok(mut g) = store.lock() {
                        g.clear();
                    }
                }
            });
        }
        "clear" | "idle" => {
            with_state(|s| {
                s.demo = None;
                s.info_open = false;
            });
        }
        "info" => {
            with_state(|s| s.info_open = true);
        }
        _ => {}
    }
    HIDDEN_UNTIL.store(0, Ordering::SeqCst);
    show_island(&app);
    pet_moved(&app);
    json!({ "ok": true, "mode": what })
}

/// 程序化设定「胶囊底边中点相对角色锚点」的偏移（逻辑 px）。
/// 与拖动松手走同一条应用路径（保存 → 重算 → 落位），用于联调 / 自动化验收；
/// 正常使用时用户是拖出来的，不需要这条命令。
#[tauri::command]
pub fn island_set_offset(app: AppHandle, x: f64, y: f64) -> Value {
    if !(x.is_finite() && y.is_finite()) {
        return json!({ "ok": false, "error": "offset 必须是有限数" });
    }
    let mut c = cfg();
    c.off = Some([
        (x.clamp(-4000.0, 4000.0) * 10.0).round() / 10.0,
        (y.clamp(-4000.0, 4000.0) * 10.0).round() / 10.0,
    ]);
    save_cfg(&c);
    *LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    pet_moved(&app);
    json!({ "ok": true, "off": c.off })
}

/// 消息源诊断：当前来源、最近一次探针结果（不返回通知正文之外的任何数据）
#[tauri::command]
pub fn notify_probe(source: Option<String>) -> Value {
    let src = source.unwrap_or_else(|| cfg().notify_source);
    crate::notify::poll(&src)
}

/// 用户显式授权：走一次 Windows 通知中心权限框（只在 winrt 来源下有意义）
#[tauri::command]
pub async fn notify_request_access() -> Value {
    tauri::async_runtime::spawn_blocking(crate::notify::request_access)
        .await
        .unwrap_or_else(|e| json!({ "ok": false, "error": format!("任务失败：{e}") }))
}

/// 恢复默认锚点排版（清掉拖动偏移）
#[tauri::command]
pub fn island_reset_pos(app: AppHandle) -> Value {
    let mut c = cfg();
    c.off = None;
    save_cfg(&c);
    *LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    pet_moved(&app);
    json!({ "ok": true, "off": Value::Null })
}

/// 拖动开始：自己搬窗口（不用 start_dragging，否则吃掉单击）。
/// 松手时把窗口位置换算成「相对角色锚点的偏移」并持久化 —— 这才是跨屏、缩放、
/// 角色走动都能保持一致的那份状态。
#[tauri::command]
pub fn island_drag_begin(app: AppHandle) -> Value {
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return json!({ "ok": true, "already": true });
    }
    N_DRAG.fetch_add(1, Ordering::SeqCst);
    std::thread::spawn(move || {
        let Some(w) = app.get_webview_window(LABEL) else {
            DRAGGING.store(false, Ordering::SeqCst);
            return;
        };
        let (Ok(start_cur), Ok(start_win), Ok(sf_i)) =
            (w.cursor_position(), w.outer_position(), w.scale_factor())
        else {
            DRAGGING.store(false, Ordering::SeqCst);
            return;
        };
        let mut last = (start_win.x, start_win.y);
        loop {
            // 高精度 8ms：原 thread::sleep 实际 ~15.6ms，拖岛时明显一格一格
            crate::timing::sleep_ms(8);
            if !left_button_down() {
                break;
            }
            if let Ok(c) = w.cursor_position() {
                let nx = start_win.x + (c.x - start_cur.x).round() as i32;
                let ny = start_win.y + (c.y - start_cur.y).round() as i32;
                if (nx, ny) != last {
                    let _ = w.set_position(tauri::PhysicalPosition::new(nx, ny));
                    last = (nx, ny);
                }
            }
        }
        // 松手：内容底边中点 → 相对锚点的逻辑偏移
        let mode = with_state(|s| s.mode.clone());
        let ch = content_h(&mode);
        if let Some((ax, ay, psf)) = anchor_phys(&app) {
            let bx = last.0 as f64 + (ISLAND_W / 2.0) * sf_i;
            let by = last.1 as f64 + (TOP_PAD + ch) * sf_i;
            let mut c = cfg();
            let off = [
                ((bx - ax) / psf * 10.0).round() / 10.0,
                ((by - ay) / psf * 10.0).round() / 10.0,
            ];
            c.off = Some(off);
            save_cfg(&c);
            log_line(&format!("drag end off={:?} mode={}", off, mode));
        }
        DRAGGING.store(false, Ordering::SeqCst);
        // 按新偏移重新贴合（这一步会做一次夹取，但不会改 off）
        *LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = None;
        pet_moved(&app);
        let _ = app.emit_to("main", "island:moved", json!({ "ok": true }));
    });
    json!({ "ok": true })
}

/// 诊断：跟随计数器 + 当前锚点/偏移（验收脚本用）
#[tauri::command]
pub fn island_stat(app: AppHandle) -> Value {
    let c = cfg();
    let anchor = ANCHOR.lock().ok().and_then(|g| *g);
    let last = *LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner());
    let mode = with_state(|s| s.mode.clone());
    json!({
        "ok": true,
        "mode": mode,
        "enabled": c.enabled,
        "off": c.off,
        "anchor": anchor,
        "lastApplied": last,
        "signals": N_SIGNAL.load(Ordering::SeqCst),
        "applied": N_APPLY.load(Ordering::SeqCst),
        "drags": N_DRAG.load(Ordering::SeqCst),
        "follow": *FOLLOW_MODE.lock().unwrap_or_else(|e| e.into_inner()),
        "dragging": DRAGGING.load(Ordering::SeqCst),
        "notifySource": c.notify_source,
        "lyric": c.lyric,
        "info": c.info,
        "contentX": *CONTENT_X.lock().unwrap_or_else(|e| e.into_inner()),
        "payload": with_state(|s| s.payload.clone()),
        "target": island_target(&app, &mode),
        "petRect": pet_rect(&app),
        "petAnchor": anchor_phys(&app),
        "islandWin": app.get_webview_window(LABEL).and_then(|w| {
            let p = w.outer_position().ok()?;
            let s = w.scale_factor().ok()?;
            Some((p.x, p.y, s))
        }),
    })
}
