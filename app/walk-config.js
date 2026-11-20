'use strict';
/**
 * 桌面走动配置（<userData>/walk.json）
 *
 * 为什么独立成文件、不塞进 settings.json / pet-state.json：
 *   · settings.json 一改主进程就会重启 harness（聊天会话断），走动开关没必要付这个代价；
 *   · pet-state.json 由页面每 5 秒覆盖写（位置/尺寸），范围和开关会被一起冲掉。
 * 本模块是纯 Node 模块（不 require('electron')），主进程只把 userData 路径传进来，
 * 因此可以直接用 node --test 断言「持久化 / 坏文件不阻断启动 / 越界数据被夹住」。
 *
 * 对外约定（与 app/preload.js 的 window.petHost.walk 一一对应）：
 *   store.get() -> { ok:true, config, error? }
 *       文件不存在 → 内置缺省；文件坏了 → 安全缺省（enabled:false, rect:null）+ 可读 error。
 *       永远不抛异常、永远 ok:true，绝不让桌宠因为一份配置起不来。
 *   store.set(cfg) -> { ok:true, config } | { ok:false, error }
 *       严格校验；临时文件 + rename 原子替换，失败时旧的有效配置原样保留。
 */
const fsDefault = require('fs');
const path = require('path');

const MIN_RECT_SIZE = 80;          // 范围最短边；再小连角色都放不进，视为误框
const MIN_SPEED = 40;
const MAX_SPEED = 600;
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,                  // 自由巡游：默认关闭
  rect: null,                      // null = 整个工作区
  win: null,                       // 框选那一刻的窗口尺寸，用于换屏/改分辨率后按比例换算
  displayId: null,                 // 框选时所在显示器，仅用于诊断与换屏判定
  speed: 130,                      // 走动速度 px/s
});

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const describe = (v) => (v === null ? 'null' : typeof v === 'object' ? (Array.isArray(v) ? '数组' : '对象') : String(v));
const msg = (e) => String((e && e.message) || e);
const finite = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

function cloneDefault() {
  return { enabled: DEFAULT_CONFIG.enabled, rect: null, win: null, displayId: null, speed: DEFAULT_CONFIG.speed };
}

function normalizeRect(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'rect 必须是对象或 null（收到 ' + describe(input) + '）' };
  }
  const x = finite(input.x), y = finite(input.y);
  const w = finite(input.width !== undefined ? input.width : input.w);
  const h = finite(input.height !== undefined ? input.height : input.h);
  if (x === null || y === null || w === null || h === null) {
    return { ok: false, error: 'rect 的 x/y/width/height 必须都是有限数值' };
  }
  if (w < MIN_RECT_SIZE || h < MIN_RECT_SIZE) {
    return { ok: false, error: '走动范围太小：宽高都要 ≥ ' + MIN_RECT_SIZE + ' px（当前 ' + w + '×' + h + '）' };
  }
  return { ok: true, rect: { x: Math.max(0, round2(x)), y: Math.max(0, round2(y)), width: round2(w), height: round2(h) } };
}

/** 严格校验 + 规范化；缺字段按缺省补齐（手写只有 enabled 也能用） */
function normalizeConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '走动配置必须是对象（收到 ' + describe(input) + '）' };
  }
  let keys;
  try { keys = Object.keys(input); } catch (e) { return { ok: false, error: '配置对象无法枚举：' + msg(e) }; }
  for (const k of keys) if (PROTO_KEYS.has(k)) return { ok: false, error: '配置不能含原型链关键字字段：' + k };

  const cfg = cloneDefault();
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值（收到 ' + describe(input.enabled) + '）' };
    cfg.enabled = input.enabled;
  }
  if ('rect' in input && input.rect !== null) {
    const r = normalizeRect(input.rect);
    if (!r.ok) return r;
    cfg.rect = r.rect;
  }
  if ('win' in input && input.win !== null) {
    const w = input.win;
    const width = w && finite(w.width), height = w && finite(w.height);
    if (!(width > 0 && height > 0)) return { ok: false, error: 'win 必须是 {width,height} 正数（收到 ' + describe(w) + '）' };
    cfg.win = { width: round2(width), height: round2(height) };
  }
  if ('displayId' in input && input.displayId !== null) {
    const id = finite(input.displayId);
    if (id === null) return { ok: false, error: 'displayId 必须是数值或 null（收到 ' + describe(input.displayId) + '）' };
    cfg.displayId = id;
  }
  if ('speed' in input) {
    const v = finite(input.speed);
    if (v === null) return { ok: false, error: 'speed 必须是有限数值（收到 ' + describe(input.speed) + '）' };
    if (v <= 0) return { ok: false, error: 'speed 必须大于 0（收到 ' + v + '）' };
    cfg.speed = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)));
  }
  return { ok: true, config: cfg };
}

/** 窗口尺寸变了（换屏 / 改分辨率 / DPI）→ 范围按比例换算，避免范围整块跑到窗口外 */
function rescaleConfig(cfg, win) {
  const src = Object.assign(cloneDefault(), cfg || {});
  const toW = win && finite(win.width), toH = win && finite(win.height);
  if (!src.rect || !src.win || !(toW > 0) || !(toH > 0)) return src;
  if (src.win.width === toW && src.win.height === toH) return src;
  const sx = toW / src.win.width, sy = toH / src.win.height;
  return Object.assign({}, src, {
    rect: { x: round2(src.rect.x * sx), y: round2(src.rect.y * sy),
            width: round2(src.rect.width * sx), height: round2(src.rect.height * sy) },
    win: { width: round2(toW), height: round2(toH) },
  });
}

let tmpSeq = 0;

/** 两份配置是不是「同值」。
 *  读路径（walk:get）每次都会按窗口尺寸换算一遍，得到的**永远是另一个对象**；
 *  按引用比较会让每次读都写一次盘（同版本同值也重写，无谓改文件时间戳、无谓触发磁盘 IO）。
 *  这里按规范化后的字段逐项比值，值没变就不写。 */
function sameConfig(a, b) {
  const x = normalizeConfig(a === null || a === undefined ? {} : a);
  const y = normalizeConfig(b === null || b === undefined ? {} : b);
  if (!x.ok || !y.ok) return false;
  const p = x.config, q = y.config;
  if (p.enabled !== q.enabled || p.speed !== q.speed || p.displayId !== q.displayId) return false;
  const eqSize = (m, n) => (m === null && n === null) ||
    (!!m && !!n && Math.abs(m.width - n.width) < 0.01 && Math.abs(m.height - n.height) < 0.01);
  return eqSize(p.rect, q.rect) && eqSize(p.win, q.win);
}

/**
 * @param {{file:string, fs?:object}} opts file 由主进程用 app.getPath('userData') 拼；fs 可注入（测试用）
 */
function createStore(opts) {
  const file = opts && opts.file;
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('createStore 需要 file 路径');
  const fsi = (opts && opts.fs) || fsDefault;
  const dir = path.dirname(file);

  function get() {
    let raw;
    try {
      raw = fsi.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, config: cloneDefault() };
      return { ok: true, config: cloneDefault(), error: '读取走动配置失败，已按“不巡游、范围=工作区”处理：' + msg(e) };
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return { ok: true, config: cloneDefault(), error: '走动配置不是合法 JSON，已按缺省处理：' + msg(e) }; }
    const v = normalizeConfig(parsed);
    if (!v.ok) return { ok: true, config: cloneDefault(), error: '走动配置无效，已按缺省处理：' + v.error };
    return { ok: true, config: v.config };
  }

  function set(input) {
    const v = normalizeConfig(input);
    if (!v.ok) return { ok: false, error: v.error };
    let tmp = '';
    try {
      fsi.mkdirSync(dir, { recursive: true });
      tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + (++tmpSeq).toString(36);
      fsi.writeFileSync(tmp, JSON.stringify(v.config, null, 2) + '\n', 'utf8');
      try { fsi.renameSync(tmp, file); }
      catch (e) { try { fsi.unlinkSync(tmp); } catch (_) {} throw e; }
      return { ok: true, config: v.config };
    } catch (e) {
      if (tmp) { try { fsi.unlinkSync(tmp); } catch (_) {} }
      return { ok: false, error: '写入走动配置失败（原配置未改动）：' + msg(e) };
    }
  }

  return { file, get, set };
}

module.exports = { DEFAULT_CONFIG, MIN_RECT_SIZE, MIN_SPEED, MAX_SPEED, normalizeConfig, rescaleConfig, sameConfig, createStore };
