//! 桌面走动（v0.7.0）
//!
//! 设计要点：
//! - 位置与边界由 Rust 权威维护，前端只负责播 `walk_left` / `walk_right` 动画。
//! - 活动范围是「物理像素矩形」，保存在独立 `walk.json`。默认关闭巡游。
//! - 框选使用按需创建的临时透明窗 `walk-select`，选完 / Esc / 失焦立即销毁，
//!   不做常驻全屏窗；结束后恢复主窗点击穿透。
//! - 聊天里的「向左走」「往右走 200 像素」「停下」由 [`parse_walk_command`]
//!   纯函数解析；只有用户本次输入会进来，AI 输出与历史重放没有任何入口。
//! - 测试隔离：设置 `CATWHALE_WALK_DIR` 可把 `walk.json` 指到临时目录，
//!   从而不写真实 KnownFolder（默认是 `%APPDATA%\com.hermes.catwhalepoc\walk.json`）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WALK_LEFT: &str = "walk_left";
pub const WALK_RIGHT: &str = "walk_right";
const SELECT_LABEL: &str = "walk-select";
const TICK_MS: u64 = 33;
/// 巡游速度（逻辑像素/秒），实际步进按 DPI 缩放。
const WALK_SPEED: f64 = 190.0;
const DEFAULT_DISTANCE: u32 = 200;
const MAX_DISTANCE: u32 = 5000;
const MIN_SELECT_PX: f64 = 40.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x.saturating_add(self.w)
    }
    pub fn bottom(&self) -> i32 {
        self.y.saturating_add(self.h)
    }
    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right() && other.x < self.right() && self.y < other.bottom() && other.y < self.bottom()
    }
    pub fn intersection(&self, other: &Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let r = self.right().min(other.right());
        let b = self.bottom().min(other.bottom());
        if r <= x || b <= y {
            None
        } else {
            Some(Rect { x, y, w: r - x, h: b - y })
        }
    }
    fn area(&self) -> i64 {
        self.w.max(0) as i64 * self.h.max(0) as i64
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WalkConfig {
    pub version: u32,
    pub enabled: bool,
    pub bounds: Option<Rect>,
}

impl Default for WalkConfig {
    fn default() -> Self {
        Self { version: 1, enabled: false, bounds: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalkCommand {
    Move { dx: i32, dy: i32, distance: u32 },
    Stop,
}

/// 只接受「明确指令」。普通句子（含 AI 回复、历史消息）不会命中。
///
/// 支持：向左走 / 往右走 200 像素 / 向右移动 50px / 向上走 / 向下走 100 像素 /
///      停下 / 停下来 / 停止 / 站住 / 暂停巡游
pub fn parse_walk_command(raw: &str) -> Option<WalkCommand> {
    let text = raw
        .trim()
        .trim_end_matches(|c: char| matches!(c, '。' | '！' | '!' | '？' | '?' | '，' | ',' | '；' | ';' | '、' | '.' | ' ' | '\t'));
    if text.is_empty() || text.contains('\n') {
        return None;
    }
    if matches!(
        text,
        "停下" | "停下来" | "停一下" | "停下吧" | "停止" | "停止巡游" | "暂停巡游" | "站住" | "别走了" | "别走" | "不要走了" | "不要走"
    ) {
        return Some(WalkCommand::Stop);
    }
    parse_move(text)
}

fn strip_politeness(mut s: &str) -> &str {
    loop {
        let before = s;
        for prefix in ["麻烦你", "麻烦", "请你", "请", "帮我", "给我", "麻烦帮我"] {
            if let Some(rest) = s.strip_prefix(prefix) {
                s = rest.trim_start();
                break;
            }
        }
        if s == before {
            return s;
        }
    }
}

fn parse_move(raw: &str) -> Option<WalkCommand> {
    let s = strip_politeness(raw);
    let s = s
        .strip_prefix('向')
        .or_else(|| s.strip_prefix('往'))
        .or_else(|| s.strip_prefix('朝'))
        .unwrap_or(s);
    let mut chars = s.char_indices();
    let (_, dir_char) = chars.next()?;
    let (dx, dy) = match dir_char {
        '左' => (-1i32, 0i32),
        '右' => (1, 0),
        '上' => (0, -1),
        '下' => (0, 1),
        _ => return None,
    };
    let rest = &s[dir_char.len_utf8()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('边').unwrap_or(rest).trim_start();
    let rest = ["移动", "走", "挪", "跑"]
        .iter()
        .find_map(|verb| rest.strip_prefix(verb))?;
    let rest = rest.trim();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() > 5 {
        return None;
    }
    let mut tail = rest[digits.len()..].trim();
    for unit in ["个像素", "像素", "个点", "px", "PX", "点"] {
        if let Some(t) = tail.strip_prefix(unit) {
            tail = t.trim();
            break;
        }
    }
    if !tail.is_empty() {
        return None;
    }
    let distance = if digits.is_empty() {
        DEFAULT_DISTANCE
    } else {
        digits.parse::<u32>().ok()?.clamp(1, MAX_DISTANCE)
    };
    Some(WalkCommand::Move { dx: dx * distance as i32, dy: dy * distance as i32, distance })
}

/// 反向拖拽也归一化成左上角 + 正宽高。
pub fn normalize_selection(x0: i32, y0: i32, x1: i32, y1: i32) -> Rect {
    let x = x0.min(x1);
    let y = y0.min(y1);
    Rect { x, y, w: (x1 - x0).abs(), h: (y1 - y0).abs() }
}

/// 让窗口左上角落在允许区域里。
pub fn clamp_position(pos: (i32, i32), size: (i32, i32), area: Rect) -> (i32, i32) {
    let max_x = (area.right() - size.0).max(area.x);
    let max_y = (area.bottom() - size.1).max(area.y);
    (pos.0.clamp(area.x, max_x), pos.1.clamp(area.y, max_y))
}

/// 把保存的范围裁进显示器；完全离屏（或退化成 0 面积）返回 None。
///
/// **不再偷偷按窗口尺寸放大选框**：以前选框比窗口小时会被居中扩到窗口大小，
/// 用户看到的框和实际能走的区域不一致。现在原样保留，能不能走交给 [`area_fit`]
/// 判定（装不下 → 暂停巡游 / 拒绝指令，并给出「框太小」的反馈）。
pub fn sanitize_bounds(bounds: Rect, monitors: &[Rect]) -> Option<Rect> {
    if bounds.w <= 0 || bounds.h <= 0 {
        return None;
    }
    let best = monitors
        .iter()
        .filter_map(|m| bounds.intersection(m).map(|i| (i.area(), *m, i)))
        .max_by_key(|(area, _, _)| *area);
    let Some((_, _monitor, clipped)) = best else { return None };
    if clipped.w <= 0 || clipped.h <= 0 {
        return None;
    }
    Some(clipped)
}

/* ===================== 持久化 ===================== */

pub struct WalkStore {
    path: PathBuf,
}

impl WalkStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn load(&self) -> (WalkConfig, Option<String>) {
        match fs::read_to_string(&self.path) {
            Ok(text) => match serde_json::from_str::<WalkConfig>(&text) {
                Ok(mut cfg) => {
                    if cfg.version == 0 {
                        cfg.version = 1;
                    }
                    (cfg, None)
                }
                Err(e) => (WalkConfig::default(), Some(format!("walk.json 解析失败，已按默认关闭处理：{e}"))),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (WalkConfig::default(), None),
            Err(e) => (WalkConfig::default(), Some(format!("walk.json 读取失败，已按默认关闭处理：{e}"))),
        }
    }
    pub fn save(&self, cfg: &WalkConfig) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
        fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
        match fs::rename(&tmp, &self.path) {
            Ok(()) => Ok(()),
            Err(first) => {
                // Windows 上 rename 不能直接覆盖已存在文件；删旧再改名。
                if self.path.exists() {
                    fs::remove_file(&self.path).map_err(|e| {
                        let _ = fs::remove_file(&tmp);
                        format!("保存 walk.json 失败：{e}（{first}）")
                    })?;
                    fs::rename(&tmp, &self.path).map_err(|e| {
                        let _ = fs::remove_file(&tmp);
                        format!("保存 walk.json 失败：{e}")
                    })
                } else {
                    let _ = fs::remove_file(&tmp);
                    Err(format!("保存 walk.json 失败：{first}"))
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 测试隔离入口：`CATWHALE_WALK_DIR` 指到主题内 tmp 即可不写真实档案。
/// 默认与聊天配置同目录（Windows KnownFolder: RoamingAppData + identifier）。
pub fn walk_config_path() -> PathBuf {
    walk_config_path_from(crate::chat::config_dir(), std::env::var_os("CATWHALE_WALK_DIR"))
}

fn walk_config_path_from(base: PathBuf, override_dir: Option<std::ffi::OsString>) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir).join("walk.json");
    }
    base.join("walk.json")
}

/* ===================== 运行时 ===================== */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MotionKind {
    Cruise,
    Command,
}

struct Motion {
    tx: i32,
    ty: i32,
    dir: i8,
    kind: MotionKind,
}

struct WalkInner {
    cfg: WalkConfig,
    motion: Option<Motion>,
    dir: i8,
    walking: bool,
    next_cruise_at: u64,
    last_tick: u64,
    last_monitor_check: u64,
    last_monitor_sig: String,
    game_mode: bool,
    rng: u64,
    seq: u64,
}

#[derive(Clone)]
pub struct WalkEngine {
    inner: Arc<Mutex<WalkInner>>,
    store: Arc<WalkStore>,
}

impl WalkEngine {
    pub fn new(path: PathBuf) -> (Self, Option<String>) {
        let store = WalkStore::new(path);
        let (cfg, warn) = store.load();
        let engine = Self {
            inner: Arc::new(Mutex::new(WalkInner {
                cfg,
                motion: None,
                dir: 1,
                walking: false,
                next_cruise_at: 0,
                last_tick: 0,
                last_monitor_check: 0,
                last_monitor_sig: String::new(),
                game_mode: false,
                rng: now_ms() ^ 0x9E37_79B9_7F4A_7C15,
                seq: 0,
            })),
            store: Arc::new(store),
        };
        (engine, warn)
    }

    fn save(&self) -> Result<(), String> {
        let cfg = lock(&self.inner).cfg.clone();
        self.store.save(&cfg)
    }
}

fn next_rand(inner: &mut WalkInner) -> u64 {
    let mut x = inner.rng | 1;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    inner.rng = x;
    x
}

fn monitor_rect(mon: &tauri::Monitor) -> Rect {
    let wa = mon.work_area();
    Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width as i32, h: wa.size.height as i32 }
}

fn monitor_sig(app: &AppHandle) -> String {
    let mut out = String::new();
    if let Ok(mons) = app.available_monitors() {
        for m in mons {
            let wa = m.work_area();
            out.push_str(&format!(
                "{}@{}x{}+{}+{}x{};",
                m.name().map(|n| n.to_string()).unwrap_or_default(),
                m.size().width,
                m.size().height,
                wa.position.x,
                wa.position.y,
                m.scale_factor()
            ));
        }
    }
    out
}

/// 活动范围能否容纳当前窗口。
///
/// 以前这里在「选框小于窗口」时**静默退回整屏工作区**：用户框了一小块，角色却
/// 满屏乱走，看上去像范围没生效。现在的约定是：范围原样保留（供用户自己框大或
/// 清掉），但**不启动巡游、不接受走动指令**，并在设置页/聊天里给出可读反馈。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AreaFit {
    /// 可以正常走动：给出的矩形就是硬边界。
    Ready(Rect),
    /// 范围（与本屏工作区交叠后）装不下窗口：保留范围，暂停所有自动移动。
    TooSmall,
}

impl AreaFit {
    fn ready(self) -> Option<Rect> {
        match self {
            AreaFit::Ready(r) => Some(r),
            AreaFit::TooSmall => None,
        }
    }
}

fn area_fit(bounds: Option<Rect>, size: (i32, i32), work: Rect) -> AreaFit {
    match bounds {
        Some(b) => match b.intersection(&work) {
            Some(i) if i.w >= size.0 && i.h >= size.1 => AreaFit::Ready(i),
            _ => AreaFit::TooSmall,
        },
        None => AreaFit::Ready(work),
    }
}

/// 放不下的范围：把窗口按「选框原点 + 窗口尺寸」夹住，再并进工作区。
/// 只用于摆放（clamp_window），不用于走动——不能借这个矩形走到框外。
fn hold_area(bounds: Option<Rect>, size: (i32, i32), work: Rect) -> Rect {
    let Some(b) = bounds else { return work };
    let base = b.intersection(&work).unwrap_or(b);
    let mut rect = Rect {
        x: base.x,
        y: base.y,
        w: base.w.max(size.0),
        h: base.h.max(size.1),
    };
    rect.x = rect.x.min(work.right() - rect.w.min(work.w));
    rect.y = rect.y.min(work.bottom() - rect.h.min(work.h));
    rect.x = rect.x.max(work.x);
    rect.y = rect.y.max(work.y);
    rect.w = rect.w.min(work.w);
    rect.h = rect.h.min(work.h);
    rect
}

fn main_work_area(app: &AppHandle, win: &WebviewWindow) -> Rect {
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    mon.as_ref().map(monitor_rect).unwrap_or(Rect { x: 0, y: 0, w: 1920, h: 1080 })
}

fn effective_area(app: &AppHandle, win: &WebviewWindow, bounds: Option<Rect>, size: (i32, i32)) -> AreaFit {
    area_fit(bounds, size, main_work_area(app, win))
}

fn current_size(win: &WebviewWindow) -> (i32, i32) {
    win.outer_size()
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or((204, 340))
}

/// 手动交互（原生拖动 / 菜单展开）期间，自动移动必须让位。
/// `drag_begin` 只取消一次在途目标；拖动可能持续数秒，`tick` 每 33ms 都要重新判定，
/// 否则 1.8 秒后巡游会重新抽目标、把用户按着的窗口搬走。
fn pet_flags(app: &AppHandle) -> (bool, bool) {
    use std::sync::atomic::Ordering;
    app.try_state::<crate::Pet>()
        .map(|pet| {
            (
                pet.dragging.load(Ordering::SeqCst),
                pet.menu_open.load(Ordering::SeqCst),
            )
        })
        .unwrap_or((false, false))
}

fn interaction_held(app: &AppHandle) -> bool {
    let (dragging, menu) = pet_flags(app);
    dragging || menu
}

fn emit_state(app: &AppHandle, walking: bool, dir: i8, kind: &str) {
    let _ = app.emit(
        "walk:state",
        json!({
            "walking": walking,
            "dir": if dir < 0 { "left" } else { "right" },
            "kind": kind,
        }),
    );
}

fn status_value(app: &AppHandle, engine: &WalkEngine) -> Value {
    let inner = lock(&engine.inner);
    let cfg = inner.cfg.clone();
    let walking = inner.walking;
    let dir = inner.dir;
    drop(inner);
    let bounds_rel = cfg.bounds.and_then(|b| {
        let mons = app.available_monitors().ok()?;
        let center = (b.x + b.w / 2, b.y + b.h / 2);
        let mon = mons.iter().find(|m| {
            let r = monitor_rect(m);
            center.0 >= r.x && center.0 < r.right() && center.1 >= r.y && center.1 < r.bottom()
        })?;
        let r = monitor_rect(mon);
        let sf = mon.scale_factor();
        Some(json!({
            "x": ((b.x - r.x) as f64 / sf).round() as i64,
            "y": ((b.y - r.y) as f64 / sf).round() as i64,
            "w": (b.w as f64 / sf).round() as i64,
            "h": (b.h as f64 / sf).round() as i64,
            "scale": sf,
            "monitor": mon.name().map(|n| n.to_string()).unwrap_or_default(),
        }))
    });
    // 范围是否装得下当前窗口：panel 用它显示「范围太小，已暂停巡游」，
    // 也让 `walk_set_enabled` 能解释为什么开了却不走。
    let (bounds_fit, need_w, need_h) = match app.get_webview_window("main") {
        Some(win) => {
            let size = current_size(&win);
            let sf = win.scale_factor().unwrap_or(1.0);
            let fit = area_fit(cfg.bounds, size, main_work_area(app, &win));
            (
                match fit {
                    AreaFit::Ready(_) => "ok",
                    AreaFit::TooSmall => "too_small",
                },
                (size.0 as f64 / sf).round() as i64,
                (size.1 as f64 / sf).round() as i64,
            )
        }
        None => ("ok", 0, 0),
    };
    json!({
        "ok": true,
        "enabled": cfg.enabled,
        "bounds": cfg.bounds,
        "boundsRel": bounds_rel,
        "boundsFit": bounds_fit,
        "needW": need_w,
        "needH": need_h,
        "walking": walking,
        "dir": if dir < 0 { "left" } else { "right" },
        "file": engine.store.path().to_string_lossy(),
    })
}

/// 启动时校正范围（换屏/分辨率变化后可能已离屏），并把窗口夹回范围内。
pub fn walk_init(app: AppHandle, engine: WalkEngine) {
    {
        let mut inner = lock(&engine.inner);
        inner.last_monitor_sig = monitor_sig(&app);
        inner.last_tick = now_ms();
        inner.next_cruise_at = now_ms() + 800;
    }
    if let Some(main) = app.get_webview_window("main") {
        let mons: Vec<Rect> = app
            .available_monitors()
            .map(|v| v.iter().map(monitor_rect).collect())
            .unwrap_or_default();
        let mut changed = false;
        {
            let mut inner = lock(&engine.inner);
            if let Some(b) = inner.cfg.bounds {
                match sanitize_bounds(b, &mons) {
                    Some(nb) if nb == b => {}
                    Some(nb) => {
                        inner.cfg.bounds = Some(nb);
                        changed = true;
                    }
                    None => {
                        inner.cfg.bounds = None;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            let _ = engine.save();
        }
        clamp_window(&app);
    }
    let engine2 = engine.clone();
    let app2 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(TICK_MS));
        tick(&app2, &engine2);
    });
}

fn tick(app: &AppHandle, engine: &WalkEngine) {
    let Some(win) = app.get_webview_window("main") else { return };
    let now = now_ms();
    let size = current_size(&win);
    let Ok(pos) = win.outer_position() else { return };

    // 显示器变化：每 ~500ms 检查一次，范围失效就清掉并夹回工作区。
    let mut check_monitors = false;
    {
        let inner = lock(&engine.inner);
        if now.saturating_sub(inner.last_monitor_check) >= 400 {
            check_monitors = true;
        }
    }
    if check_monitors {
        lock(&engine.inner).last_monitor_check = now;
        let sig = monitor_sig(app);
        // Tauri 显示器 API 在锁外取，避免和主线程命令互等。
        let mons: Vec<Rect> = app
            .available_monitors()
            .map(|v| v.iter().map(monitor_rect).collect())
            .unwrap_or_default();
        let work = main_work_area(app, &win);
        let mut save = false;
        let mut changed = false;
        {
            let mut inner = lock(&engine.inner);
            if inner.last_monitor_sig != sig {
                inner.last_monitor_sig = sig;
                if let Some(b) = inner.cfg.bounds {
                    match sanitize_bounds(b, &mons) {
                        Some(nb) if nb == b => {}
                        Some(nb) => {
                            inner.cfg.bounds = Some(nb);
                            changed = true;
                        }
                        None => {
                            inner.cfg.bounds = None;
                            changed = true;
                        }
                    }
                }
                let b = inner.cfg.bounds;
                if let Some(area) = area_fit(b, size, work).ready() {
                    if let Some(m) = inner.motion.as_mut() {
                        let (nx, ny) = clamp_position((m.tx, m.ty), size, area);
                        m.tx = nx;
                        m.ty = ny;
                    }
                } else {
                    // 范围装不下窗口：目标作废，等用户把范围框大再走。
                    inner.motion = None;
                    inner.walking = false;
                }
                save = changed;
            }
        }
        if changed {
            let _ = app.emit("walk:config", json!({"ok": true, "boundsChanged": true}));
        }
        if save {
            let _ = engine.save();
        }
    }

    let fit = {
        let bounds = lock(&engine.inner).cfg.bounds;
        effective_area(app, &win, bounds, size)
    };
    let area = fit.ready();
    // 拖动 / 菜单打开时手动交互优先：tick 这一拍就不许再启动或推进任何移动。
    // 旧实现只在 drag_begin 里 cancel 一次，长按 1.8 秒后巡游的 next_cruise_at 到点，
    // 又抽了个新目标并每 33ms set_position —— 实测表现为「按着角色自己乱窜」。
    let holding = interaction_held(app);
    let scale = win.scale_factor().unwrap_or(1.0);
    let mut do_emit: Option<(bool, i8, &'static str)> = None;
    let mut set_pos: Option<(i32, i32)> = None;

    {
        let mut inner = lock(&engine.inner);
        if inner.game_mode {
            let was = inner.walking || inner.motion.is_some();
            let d = inner.dir;
            inner.motion = None;
            inner.walking = false;
            inner.last_tick = now;
            drop(inner);
            if was {
                emit_state(app, false, d, "gamemode");
            }
            return;
        }
        let dt = ((now.saturating_sub(inner.last_tick)).min(80) as f64 / 1000.0).max(0.001);
        inner.last_tick = now;

        // 手动交互优先 / 范围装不下窗口：这一拍一律不移动，且清掉在途目标。
        if holding || area.is_none() {
            let was = inner.walking || inner.motion.is_some();
            let d = inner.dir;
            inner.motion = None;
            inner.walking = false;
            inner.next_cruise_at = now + 1500;
            drop(inner);
            if was {
                emit_state(app, false, d, if holding { "interaction" } else { "bounds" });
            }
            return;
        }
        let area = area.unwrap_or(Rect { x: 0, y: 0, w: size.0, h: size.1 });

        if let Some(m) = inner.motion.take() {
            let dx = (m.tx - pos.x) as f64;
            let dy = (m.ty - pos.y) as f64;
            let dist = (dx * dx + dy * dy).sqrt();
            let step = WALK_SPEED * scale * dt;
            if dist <= step.max(0.5) {
                set_pos = Some((m.tx, m.ty));
                inner.walking = false;
                if m.dir != inner.dir {
                    inner.dir = m.dir;
                }
                do_emit = Some((false, inner.dir, match m.kind {
                    MotionKind::Cruise => "cruise",
                    MotionKind::Command => "command",
                }));
                inner.next_cruise_at = now + if m.kind == MotionKind::Command { 1200 } else { 2200 + (next_rand(&mut inner) % 3200) };
            } else {
                let nx = pos.x as f64 + dx / dist * step;
                let ny = pos.y as f64 + dy / dist * step;
                let (cx, cy) = clamp_position((nx.round() as i32, ny.round() as i32), size, area);
                set_pos = Some((cx, cy));
                if m.dir != inner.dir {
                    inner.dir = m.dir;
                    do_emit = Some((true, inner.dir, "move"));
                }
                if !inner.walking {
                    inner.walking = true;
                    do_emit = Some((true, inner.dir, "move"));
                }
                // 放回 motion，下一拍继续
                inner.motion = Some(m);
            }
        } else if inner.walking {
            inner.walking = false;
            do_emit = Some((false, inner.dir, "stop"));
        } else if inner.cfg.enabled && now >= inner.next_cruise_at {
            let max_x = (area.right() - size.0).max(area.x);
            let max_y = (area.bottom() - size.1).max(area.y);
            let mut tx = area.x;
            let mut ty = area.y;
            for _ in 0..6 {
                let rx = next_rand(&mut inner);
                let ry = next_rand(&mut inner);
                tx = area.x + (rx % (max_x - area.x + 1).max(1) as u64) as i32;
                ty = area.y + (ry % (max_y - area.y + 1).max(1) as u64) as i32;
                if (tx - pos.x).abs() + (ty - pos.y).abs() >= 60 {
                    break;
                }
            }
            let dir = if tx < pos.x - 8 {
                -1
            } else if tx > pos.x + 8 {
                1
            } else {
                inner.dir
            };
            inner.dir = dir;
            inner.motion = Some(Motion { tx, ty, dir, kind: MotionKind::Cruise });
            inner.walking = true;
            do_emit = Some((true, dir, "cruise"));
        }
    }

    if let Some((x, y)) = set_pos {
        if pos.x != x || pos.y != y {
            let _ = win.set_position(PhysicalPosition::new(x, y));
            // 自动行走与手动拖动共用同一个跟随源：岛的搬运线程只认「桌宠动过」这一信号，
            // 按存储偏移贴着走，不做独立缓动、不自己追赶。
            crate::island::pet_moved(app);
            // 拖动 / 菜单镜像等不会改这里；走动时前端只跟 dir 选 walk_left/right。
        }
    }
    if let Some((walking, dir, kind)) = do_emit {
        emit_state(app, walking, dir, kind);
    }
}

/* ===================== 对外命令 ===================== */

fn emit_config(app: &AppHandle, engine: &WalkEngine) {
    let _ = app.emit("walk:config", status_value(app, engine));
}

/// 主窗回到默认穿透，并让轮询立刻重判命中（框选结束必须恢复，不能卡在可交互）。
fn release_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_ignore_cursor_events(true);
    }
    crate::reset_hit_state(app);
}

fn close_select(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SELECT_LABEL) {
        let _ = w.destroy();
    }
    release_main(app);
}

#[tauri::command]
pub fn walk_get(app: AppHandle, engine: tauri::State<'_, WalkEngine>) -> Value {
    status_value(&app, &engine)
}

#[tauri::command]
pub fn walk_set_enabled(app: AppHandle, engine: tauri::State<'_, WalkEngine>, enabled: bool) -> Value {
    {
        let mut inner = lock(&engine.inner);
        inner.cfg.enabled = enabled;
        if enabled {
            inner.next_cruise_at = now_ms() + 500;
        } else {
            inner.motion = None;
            inner.walking = false;
        }
    }
    if let Err(e) = engine.save() {
        return json!({ "ok": false, "error": e });
    }
    let status = status_value(&app, &engine);
    emit_config(&app, &engine);
    if !enabled {
        let dir = lock(&engine.inner).dir;
        emit_state(&app, false, dir, "disabled");
    }
    status
}

#[tauri::command]
pub fn walk_clear_bounds(app: AppHandle, engine: tauri::State<'_, WalkEngine>) -> Value {
    {
        let mut inner = lock(&engine.inner);
        inner.cfg.bounds = None;
    }
    if let Err(e) = engine.save() {
        return json!({ "ok": false, "error": e });
    }
    emit_config(&app, &engine);
    status_value(&app, &engine)
}

/// 停止命令：暂停巡游（持久化 enabled=false），设置页可再次启用。
#[tauri::command]
pub fn walk_stop(app: AppHandle, engine: tauri::State<'_, WalkEngine>) -> Value {
    let was_enabled;
    {
        let mut inner = lock(&engine.inner);
        was_enabled = inner.cfg.enabled;
        inner.cfg.enabled = false;
        inner.motion = None;
        inner.walking = false;
    }
    let _ = engine.save();
    emit_state(&app, false, lock(&engine.inner).dir, "stop");
    emit_config(&app, &engine);
    json!({ "ok": true, "wasCruising": was_enabled })
}

#[tauri::command]
pub async fn walk_begin_selection(app: AppHandle) -> Result<Value, String> {
    // 框选期间桌宠不要再乱跑；巡游开关保留，选完继续。
    pause_for_interaction(&app, "select");
    if let Some(w) = app.get_webview_window(SELECT_LABEL) {
        let _ = w.destroy();
    }
    let app2 = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = build_selection_window(&app2);
        let _ = sender.send(result);
    })
    .map_err(|e| e.to_string())?;
    let win = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())??;
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(json!({ "ok": true, "label": SELECT_LABEL }))
}

fn build_selection_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let main = app.get_webview_window("main").ok_or_else(|| "主窗不存在".to_string())?;
    let mon = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "读不到显示器".to_string())?;
    let wa = mon.work_area();
    let sf = mon.scale_factor().max(0.5);
    let w = wa.size.width as f64 / sf;
    let h = wa.size.height as f64 / sf;
    let win = WebviewWindowBuilder::new(app, SELECT_LABEL, WebviewUrl::App("walk-select.html".into()))
        .title("walk-select")
        .inner_size(w, h)
        .position(wa.position.x as f64 / sf, wa.position.y as f64 / sf)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focusable(true)
        .visible(false)
        .additional_browser_args(crate::WEBVIEW_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    win.on_window_event(move |ev| match ev {
        tauri::WindowEvent::Focused(false) => {
            // 显示瞬间可能先收到一次失焦；给 450ms 宽限再判断。
            let app3 = app2.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(450));
                if let Some(w) = app3.get_webview_window(SELECT_LABEL) {
                    if !w.is_focused().unwrap_or(false) {
                        close_select(&app3);
                        let _ = app3.emit("walk:selection", json!({"ok": false, "reason": "blur"}));
                    }
                }
            });
        }
        // Alt+F4 / 系统关闭也要释放主窗穿透，不能留下可交互的透明层。
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
            release_main(&app2);
        }
        _ => {}
    });
    Ok(win)
}

/// 框选窗自报坐标用：工作区原点、DPI、已有范围（换算成窗内逻辑坐标）。
#[tauri::command]
pub fn walk_selection_context(app: AppHandle, engine: tauri::State<'_, WalkEngine>) -> Value {
    let Some(sel) = app.get_webview_window(SELECT_LABEL) else {
        return json!({ "ok": false, "error": "框选窗未打开" });
    };
    let (Ok(pos), Ok(size), Ok(sf)) = (sel.outer_position(), sel.outer_size(), sel.scale_factor()) else {
        return json!({ "ok": false, "error": "框选窗几何信息不可用" });
    };
    let main_size = app
        .get_webview_window("main")
        .map(|w| current_size(&w))
        .unwrap_or((204, 340));
    let bounds_local = lock(&engine.inner).cfg.bounds.map(|b| {
        json!({
            "x": (b.x - pos.x) as f64 / sf,
            "y": (b.y - pos.y) as f64 / sf,
            "w": b.w as f64 / sf,
            "h": b.h as f64 / sf,
        })
    });
    json!({
        "ok": true,
        "origin": { "x": pos.x, "y": pos.y },
        "size": { "w": size.width as f64 / sf, "h": size.height as f64 / sf },
        "scale": sf,
        "minW": main_size.0 as f64 / sf,
        "minH": main_size.1 as f64 / sf,
        "bounds": bounds_local,
    })
}

/// 提交框选：x/y/w/h 为框选窗内 CSS 逻辑像素；Rust 转物理坐标并持久化。
#[tauri::command]
pub fn walk_selection_commit(
    app: AppHandle,
    engine: tauri::State<'_, WalkEngine>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Value {
    let Some(sel) = app.get_webview_window(SELECT_LABEL) else {
        return json!({ "ok": false, "error": "框选窗已关闭" });
    };
    let (Ok(pos), Ok(sf)) = (sel.outer_position(), sel.scale_factor()) else {
        return json!({ "ok": false, "error": "框选窗几何信息不可用" });
    };
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return json!({ "ok": false, "error": "框选坐标无效" });
    }
    let main_size = app
        .get_webview_window("main")
        .map(|w| current_size(&w))
        .unwrap_or((204, 340));
    if w < MIN_SELECT_PX || h < MIN_SELECT_PX {
        return json!({ "ok": false, "error": "框选范围太小，请拖出更大区域" });
    }
    let phys = Rect {
        x: pos.x + (x * sf).round() as i32,
        y: pos.y + (y * sf).round() as i32,
        w: (w * sf).round() as i32,
        h: (h * sf).round() as i32,
    };
    if phys.w < main_size.0 || phys.h < main_size.1 {
        return json!({
            "ok": false,
            "error": format!(
                "范围小于桌宠当前窗口（需要至少 {}×{} 逻辑像素），请重新框选",
                (main_size.0 as f64 / sf).round() as i32,
                (main_size.1 as f64 / sf).round() as i32
            ),
            "needW": main_size.0 as f64 / sf,
            "needH": main_size.1 as f64 / sf,
        });
    }
    // 限制在框选窗覆盖的显示器工作区内。
    let mon_rect = Rect {
        x: pos.x,
        y: pos.y,
        w: (sel.outer_size().map(|s| s.width).unwrap_or(0)) as i32,
        h: (sel.outer_size().map(|s| s.height).unwrap_or(0)) as i32,
    };
    let Some(bounds) = phys.intersection(&mon_rect) else {
        return json!({ "ok": false, "error": "框选范围不在当前屏幕内" });
    };
    {
        let mut inner = lock(&engine.inner);
        inner.cfg.bounds = Some(bounds);
    }
    if let Err(e) = engine.save() {
        return json!({ "ok": false, "error": e });
    }
    close_select(&app);
    clamp_window_with(&app, &engine);
    emit_config(&app, &engine);
    let _ = app.emit("walk:selection", json!({ "ok": true, "bounds": bounds }));
    status_value(&app, &engine)
}

#[tauri::command]
pub fn walk_selection_cancel(app: AppHandle) -> Value {
    close_select(&app);
    let _ = app.emit("walk:selection", json!({ "ok": false, "reason": "cancel" }));
    json!({ "ok": true, "cancelled": true })
}

/// 聊天本地指令入口。只有用户当前输入会调用；返回 matched=false 时聊天照旧走原后端。
#[tauri::command]
pub fn walk_command(app: AppHandle, engine: tauri::State<'_, WalkEngine>, text: String) -> Value {
    let Some(cmd) = parse_walk_command(&text) else {
        return json!({ "ok": true, "matched": false });
    };
    match cmd {
        WalkCommand::Stop => {
            let was_enabled;
            {
                let mut inner = lock(&engine.inner);
                was_enabled = inner.cfg.enabled;
                inner.cfg.enabled = false;
                inner.motion = None;
                inner.walking = false;
            }
            let _ = engine.save();
            let dir = lock(&engine.inner).dir;
            emit_state(&app, false, dir, "command");
            emit_config(&app, &engine);
            json!({
                "ok": true,
                "matched": true,
                "action": "stop",
                "wasCruising": was_enabled,
                "reply": if was_enabled { "好，停下了，巡游也暂停了。要再走可以在设置里重新开启巡游。" } else { "好，停下了。" },
            })
        }
        WalkCommand::Move { dx, dy, distance } => {
            let Some(win) = app.get_webview_window("main") else {
                return json!({ "ok": false, "matched": true, "error": "主窗不存在" });
            };
            let (Ok(pos), size, Ok(sf)) = (win.outer_position(), current_size(&win), win.scale_factor()) else {
                return json!({ "ok": false, "matched": true, "error": "主窗几何信息不可用" });
            };
            let (bounds, game_mode) = {
                let inner = lock(&engine.inner);
                (inner.cfg.bounds, inner.game_mode)
            };
            if game_mode {
                return json!({ "ok": false, "matched": true, "error": "游戏模式下桌宠已隐藏" });
            }
            let fit = effective_area(&app, &win, bounds, size);
            let area = match fit {
                AreaFit::Ready(a) => a,
                AreaFit::TooSmall => {
                    // 选框比角色画布还小：不越界走、也不偷偷改用整屏，保留范围给用户改。
                    let sf = sf.max(0.1);
                    let need = format!(
                        "{}×{}",
                        (size.0 as f64 / sf).round() as i32,
                        (size.1 as f64 / sf).round() as i32
                    );
                    let have = bounds
                        .map(|b| format!("{}×{}", (b.w as f64 / sf).round() as i32, (b.h as f64 / sf).round() as i32))
                        .unwrap_or_else(|| "未知".into());
                    let msg = format!(
                        "活动范围 {have} 比角色画布 {need} 小，先框大一点或点「清除范围」再走。范围已保留。"
                    );
                    return json!({
                        "ok": false,
                        "matched": true,
                        "reason": "bounds_too_small",
                        "error": msg,
                        "reply": msg,
                        "needW": size.0 as f64 / sf,
                        "needH": size.1 as f64 / sf,
                    });
                }
            };
            let tx = pos.x + (dx as f64 * sf).round() as i32;
            let ty = pos.y + (dy as f64 * sf).round() as i32;
            let (cx, cy) = clamp_position((tx, ty), size, area);
            let dir = if cx < pos.x - 1 {
                -1
            } else if cx > pos.x + 1 {
                1
            } else {
                0
            };
            let clamped = cx != tx || cy != ty;
            {
                let mut inner = lock(&engine.inner);
                let d = if dir == 0 { inner.dir } else { dir };
                inner.dir = d;
                inner.motion = Some(Motion { tx: cx, ty: cy, dir: d, kind: MotionKind::Command });
                inner.walking = true;
                inner.seq = inner.seq.wrapping_add(1);
                inner.next_cruise_at = now_ms() + 1200;
            }
            emit_state(&app, true, lock(&engine.inner).dir, "command");
            let dir_word = match dx.signum() {
                -1 => "左",
                1 => "右",
                _ => {
                    if dy < 0 {
                        "上"
                    } else {
                        "下"
                    }
                }
            };
            json!({
                "ok": true,
                "matched": true,
                "action": "move",
                "dir": if dx < 0 { "left" } else if dx > 0 { "right" } else if dy < 0 { "up" } else { "down" },
                "distance": distance,
                "clamped": clamped,
                "reply": format!(
                    "好，向{dir_word}走 {distance} 像素{}。",
                    if clamped { "（已到活动范围边界）" } else { "" }
                ),
            })
        }
    }
}

/// 调试/验收：真实窗口位置、范围、运动目标。
#[tauri::command]
pub fn walk_debug(app: AppHandle, engine: tauri::State<'_, WalkEngine>) -> Value {
    let win = app.get_webview_window("main");
    let pos = win.as_ref().and_then(|w| w.outer_position().ok());
    let size = win.as_ref().and_then(|w| w.outer_size().ok());
    let scale = win.as_ref().and_then(|w| w.scale_factor().ok());
    let inner = lock(&engine.inner);
    json!({
        "ok": true,
        "pos": pos.map(|p| json!({"x": p.x, "y": p.y})),
        "size": size.map(|s| json!({"w": s.width, "h": s.height})),
        "scale": scale,
        "bounds": inner.cfg.bounds,
        "enabled": inner.cfg.enabled,
        "walking": inner.walking,
        "dir": if inner.dir < 0 { "left" } else { "right" },
        "motion": inner.motion.as_ref().map(|m| json!({"tx": m.tx, "ty": m.ty})),
        "gameMode": inner.game_mode,
        // 验收要用：真实长按拖动期间 dragging 必须为 true，tick 才会停手。
        "dragging": pet_flags(&app).0,
        "menuOpen": pet_flags(&app).1,
    })
}

/* ===================== 与主窗口/游戏模式联动 ===================== */

/// 拖动、开菜单等手动交互优先：立即停下，巡游保持开启，交互结束后重新抽目标。
pub fn pause_for_interaction(app: &AppHandle, reason: &str) {
    let Some(engine) = app.try_state::<WalkEngine>() else { return };
    let was_walking;
    {
        let mut inner = lock(&engine.inner);
        was_walking = inner.walking;
        inner.motion = None;
        inner.walking = false;
        inner.next_cruise_at = now_ms() + 1800;
    }
    if was_walking {
        emit_state(app, false, lock(&engine.inner).dir, reason);
    }
}

pub fn cancel_motion(app: &AppHandle) {
    if let Some(engine) = app.try_state::<WalkEngine>() {
        let mut inner = lock(&engine.inner);
        inner.motion = None;
        inner.walking = false;
        inner.next_cruise_at = now_ms() + 1800;
    }
}

pub fn set_game_mode(app: &AppHandle, on: bool) {
    if on {
        // 游戏模式隐藏桌宠时，框选窗不能留在屏幕上。
        close_select(app);
    }
    if let Some(engine) = app.try_state::<WalkEngine>() {
        let was_walking;
        {
            let mut inner = lock(&engine.inner);
            inner.game_mode = on;
            was_walking = inner.walking;
            inner.motion = None;
            inner.walking = false;
            if !on {
                inner.next_cruise_at = now_ms() + 1200;
            }
        }
        if was_walking {
            emit_state(app, false, lock(&engine.inner).dir, "gamemode");
        }
        if !on {
            clamp_window(app);
        }
    }
}

pub fn clamp_window(app: &AppHandle) {
    if let Some(engine) = app.try_state::<WalkEngine>() {
        clamp_window_with(app, &engine);
    }
}

fn clamp_window_with(app: &AppHandle, engine: &WalkEngine) {
    let Some(win) = app.get_webview_window("main") else { return };
    let size = current_size(&win);
    let bounds = lock(&engine.inner).cfg.bounds;
    let fit = effective_area(app, &win, bounds, size);
    let area = match fit {
        AreaFit::Ready(a) => a,
        AreaFit::TooSmall => {
            // 尺寸变大后范围装不下：立即停掉在途移动（绝不借整屏工作区继续走），
            // 窗口按「选框原点 + 当前尺寸」摆好；范围本身保留，等用户框大或清掉。
            {
                let mut inner = lock(&engine.inner);
                let was = inner.walking || inner.motion.is_some();
                let dir = inner.dir;
                inner.motion = None;
                inner.walking = false;
                inner.next_cruise_at = now_ms() + 1500;
                drop(inner);
                if was {
                    emit_state(app, false, dir, "bounds");
                }
            }
            hold_area(bounds, size, main_work_area(app, &win))
        }
    };
    let Ok(pos) = win.outer_position() else { return };
    let (x, y) = clamp_position((pos.x, pos.y), size, area);
    if x != pos.x || y != pos.y {
        let _ = win.set_position(PhysicalPosition::new(x, y));
        crate::island::pet_moved(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_exact_commands() {
        assert_eq!(
            parse_walk_command("向左走"),
            Some(WalkCommand::Move { dx: -200, dy: 0, distance: 200 })
        );
        assert_eq!(
            parse_walk_command("往右走 200 像素"),
            Some(WalkCommand::Move { dx: 200, dy: 0, distance: 200 })
        );
        assert_eq!(
            parse_walk_command("向右走200像素。"),
            Some(WalkCommand::Move { dx: 200, dy: 0, distance: 200 })
        );
        assert_eq!(
            parse_walk_command("请帮我往右走 50px！"),
            Some(WalkCommand::Move { dx: 50, dy: 0, distance: 50 })
        );
        assert_eq!(
            parse_walk_command("向下走 100 像素"),
            Some(WalkCommand::Move { dx: 0, dy: 100, distance: 100 })
        );
        assert_eq!(parse_walk_command("停下"), Some(WalkCommand::Stop));
        assert_eq!(parse_walk_command("停止。"), Some(WalkCommand::Stop));
        assert_eq!(parse_walk_command("暂停巡游"), Some(WalkCommand::Stop));
    }

    #[test]
    fn parse_rejects_non_commands() {
        for text in [
            "我今天想向左走",
            "它往右走了 200 像素",
            "向左走然后跟我说说天气",
            "你能向左走吗？",
            "向左走 200 像素，然后停下",
            "",
            "停止思考",
        ] {
            assert_eq!(parse_walk_command(text), None, "不应命中：{text}");
        }
    }

    #[test]
    fn selection_reverse_and_clamp() {
        assert_eq!(normalize_selection(500, 400, 100, 100), Rect { x: 100, y: 100, w: 400, h: 300 });
        assert_eq!(normalize_selection(100, 100, 500, 400), Rect { x: 100, y: 100, w: 400, h: 300 });
        let area = Rect { x: 0, y: 0, w: 1000, h: 800 };
        assert_eq!(clamp_position((-10, 900), (200, 300), area), (0, 500));
        assert_eq!(clamp_position((950, 700), (200, 300), area), (800, 500));
    }

    #[test]
    fn bounds_sanitize_offscreen_and_tiny() {
        let monitors = [Rect { x: 0, y: 0, w: 1920, h: 1040 }];
        assert_eq!(sanitize_bounds(Rect { x: 3000, y: 0, w: 300, h: 300 }, &monitors), None);
        // 小于窗口 → 原样保留（不再静默放大；能不能走由 area_fit 判定）
        let got = sanitize_bounds(Rect { x: 800, y: 400, w: 100, h: 100 }, &monitors).unwrap();
        assert_eq!(got, Rect { x: 800, y: 400, w: 100, h: 100 });
        // 部分越界 → 只裁进显示器
        let got = sanitize_bounds(Rect { x: 1800, y: 900, w: 400, h: 400 }, &monitors).unwrap();
        assert_eq!(got, Rect { x: 1800, y: 900, w: 120, h: 140 });
    }

    #[test]
    fn area_fit_refuses_box_smaller_than_canvas() {
        let work = Rect { x: 0, y: 0, w: 2560, h: 1392 };
        let size = (204, 340);
        // 没设范围 → 整屏工作区可用
        assert_eq!(area_fit(None, size, work), AreaFit::Ready(work));
        // 范围装得下 → 用范围本身当硬边界
        let ok = Rect { x: 100, y: 100, w: 500, h: 450 };
        assert_eq!(area_fit(Some(ok), size, work), AreaFit::Ready(ok));
        // 范围比画布小 → TooSmall（不再静默退回整屏）
        let small = Rect { x: 100, y: 100, w: 120, h: 200 };
        assert_eq!(area_fit(Some(small), size, work), AreaFit::TooSmall);
        assert!(area_fit(Some(small), size, work).ready().is_none());
        // 完全离屏 → 同样 TooSmall
        assert_eq!(
            area_fit(Some(Rect { x: 9000, y: 0, w: 800, h: 800 }), size, work),
            AreaFit::TooSmall
        );
    }

    #[test]
    fn hold_area_stays_inside_work_area() {
        let work = Rect { x: 0, y: 0, w: 2560, h: 1392 };
        let size = (300, 500);
        let small = Rect { x: 2400, y: 1300, w: 100, h: 60 };
        let hold = hold_area(Some(small), size, work);
        assert!(hold.x >= work.x && hold.y >= work.y);
        assert!(hold.right() <= work.right() && hold.bottom() <= work.bottom());
        // 只是摆放用的兜底矩形：不参与走动，尺寸不会小于窗口
        assert!(hold.w >= size.0 || hold.w == work.w);
        assert!(hold.h >= size.1 || hold.h == work.h);
    }

    #[test]
    fn store_roundtrip_in_isolated_dir() {
        let base = std::env::var_os("CATWHALE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("walk-store-{}-{}", std::process::id(), now_ms()));
        let path = base.join("walk.json");
        let store = WalkStore::new(path.clone());
        let (cfg, warn) = store.load();
        assert!(warn.is_none());
        assert!(!cfg.enabled);
        let cfg = WalkConfig {
            version: 1,
            enabled: true,
            bounds: Some(Rect { x: 10, y: 20, w: 300, h: 400 }),
        };
        store.save(&cfg).unwrap();
        let (back, warn) = store.load();
        assert!(warn.is_none());
        assert!(back.enabled);
        assert_eq!(back.bounds, cfg.bounds);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn config_dir_override_is_honored() {
        // 默认目录来自 Tauri app_config_dir → Windows KnownFolder(RoamingAppData)，
        // 不是 %APPDATA% 环境变量；测试用 CATWHALE_WALK_DIR 显式隔离。
        let base = std::env::temp_dir().join("RoamingAppData").join("com.hermes.catwhalepoc");
        assert_eq!(walk_config_path_from(base.clone(), None), base.join("walk.json"));
        assert_eq!(
            walk_config_path_from(base, Some(std::ffi::OsString::from("H:/tmp/walk"))),
            PathBuf::from("H:/tmp/walk").join("walk.json")
        );
        assert_eq!(
            walk_config_path_from(PathBuf::from("H:/base"), Some(std::ffi::OsString::new())),
            PathBuf::from("H:/base").join("walk.json")
        );
    }
}
