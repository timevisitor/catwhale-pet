'use strict';
/**
 * 动画片段循环配置（<userData>/animation-loop.json）
 *
 * 独立于聊天设置（settings.json / config:set）：写这份配置绝不会重启或 kill harness。
 * 本模块是纯 Node 模块（不 require('electron')），主进程只负责把 userData 路径传进来，
 * 因此可以直接用 node --test 跑公开行为测试。
 *
 * 对外约定（与 app/preload.js 的 window.petHost.animationLoop 一一对应）：
 *   store.get() -> { ok:true, config:{enabled,actionId,start,end}, error? }
 *       文件不存在 → 内置缺省；文件损坏/字段非法 → 安全缺省（enabled:false）+ 可读 error，
 *       永远不抛异常、永远 ok:true，不会让桌宠启动失败。
 *   store.set(cfg) -> { ok:true, config:canonical } | { ok:false, error:string }
 *       严格校验；写盘用「临时文件 + rename」原子替换，失败时旧的有效配置原样保留。
 *
 * 片段上界（视频真实 duration）不由后端裁剪，交给前端按当前动作视频长度处理。
 */
const fsDefault = require('fs');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({ enabled: false, actionId: 'idle', start: 0, end: 2 });
const MIN_SPAN_SEC = 0.2;        // 循环片段最短 0.2 秒，防止 0 长度死循环/狂切
const SPAN_EPSILON = 1e-6;       // 浮点容差：0.3-0.1 = 0.19999999999999998 要放行
const MAX_ACTION_ID_LEN = 64;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// 动作 id 会参与前端视频查找/拼接，禁止路径分隔符与控制字符；中文等 Unicode 允许
const ACTION_ID_RE = /^[^\u0000-\u001f\u007f/\\]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function msg(e) { return String((e && e.message) || e); }

function describe(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v.length > 24 ? v.slice(0, 24) + '…' : v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'undefined') return String(v);
  if (Array.isArray(v)) return '数组';
  if (typeof v === 'function') return '函数';
  return typeof v;
}

function cloneDefault() {
  return { enabled: DEFAULT_CONFIG.enabled, actionId: DEFAULT_CONFIG.actionId, start: DEFAULT_CONFIG.start, end: DEFAULT_CONFIG.end };
}

function validateActionId(v) {
  if (typeof v !== 'string') return { ok: false, error: 'actionId 必须是字符串（收到 ' + describe(v) + '）' };
  // 控制字符（含 \n \t）任何位置都不接受：它只会来自 UI 拼错，绝不是合法动作 id
  if (CONTROL_RE.test(v)) return { ok: false, error: 'actionId 含非法字符（不能含 / \\ 或控制字符）' };
  const s = v.trim();
  if (!s) return { ok: false, error: 'actionId 不能为空' };
  if (s.length > MAX_ACTION_ID_LEN) return { ok: false, error: 'actionId 太长（最多 ' + MAX_ACTION_ID_LEN + ' 字符）' };
  if (PROTO_KEYS.has(s)) return { ok: false, error: 'actionId 不能是原型链关键字：' + s };
  if (s.charAt(0) === '.') return { ok: false, error: 'actionId 不能以 . 开头' };
  if (!ACTION_ID_RE.test(s)) return { ok: false, error: 'actionId 含非法字符（不能含 / \\ 或控制字符）' };
  return { ok: true, value: s };
}

/** 严格校验 + 规范化。缺字段按内置缺省补齐（手改文件只写 enabled 也能用）。 */
function normalizeConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置必须是对象（收到 ' + describe(input) + '）' };
  }
  let keys;
  try { keys = Object.keys(input); } catch (e) { return { ok: false, error: '配置对象无法枚举：' + msg(e) }; }
  for (const k of keys) {
    if (PROTO_KEYS.has(k)) return { ok: false, error: '配置不能含原型链关键字字段：' + k };
  }
  const read = (k) => {
    try { return { has: keys.indexOf(k) >= 0, value: input[k] }; }
    catch (e) { return { has: true, value: undefined, failed: msg(e) }; }
  };

  const cfg = cloneDefault();
  const got = {};
  for (const k of ['enabled', 'actionId', 'start', 'end']) got[k] = read(k);

  if (got.enabled.has) {
    if (typeof got.enabled.value !== 'boolean') {
      return { ok: false, error: 'enabled 必须是布尔值 true/false（收到 ' + describe(got.enabled.value) + '）' };
    }
    cfg.enabled = got.enabled.value;
  }
  if (got.actionId.has) {
    const a = validateActionId(got.actionId.value);
    if (!a.ok) return a;
    cfg.actionId = a.value;
  }
  for (const k of ['start', 'end']) {
    if (!got[k].has) continue;
    const v = got[k].value;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: k + ' 必须是有限数值（收到 ' + describe(v) + '）' };
    }
    cfg[k] = v === 0 ? 0 : v;                 // 把 -0 归一成 0，落盘/回读一致
  }
  if (cfg.start < 0) return { ok: false, error: 'start 不能小于 0（收到 ' + cfg.start + '）' };
  if (!(cfg.end > cfg.start)) return { ok: false, error: 'end 必须大于 start（start=' + cfg.start + ' end=' + cfg.end + '）' };
  if (cfg.end - cfg.start < MIN_SPAN_SEC - SPAN_EPSILON) {
    return { ok: false, error: '循环片段太短：end - start 至少要 ' + MIN_SPAN_SEC + ' 秒（当前 ' + (cfg.end - cfg.start) + '）' };
  }
  return { ok: true, config: cfg };
}

let tmpSeq = 0;

/**
 * @param {{file:string, fs?:object}} opts  file 由主进程用 app.getPath('userData') 拼；
 *        fs 可注入（测试用），默认 node:fs。
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
      if (e && e.code === 'ENOENT') return { ok: true, config: cloneDefault() };   // 没配置过 = 缺省，不是错误
      return { ok: true, config: cloneDefault(), error: '读取动画循环配置失败，已按“关闭循环”处理：' + msg(e) };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: true, config: cloneDefault(), error: '动画循环配置不是合法 JSON，已按“关闭循环”处理：' + msg(e) };
    }
    const v = normalizeConfig(parsed);
    if (!v.ok) return { ok: true, config: cloneDefault(), error: '动画循环配置无效，已按“关闭循环”处理：' + v.error };
    return { ok: true, config: v.config };
  }

  function set(input) {
    const v = normalizeConfig(input);
    if (!v.ok) return { ok: false, error: v.error };
    let tmp = '';
    try {
      fsi.mkdirSync(dir, { recursive: true });      // 运行时目录按需创建（启动时不写）
      tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + (++tmpSeq).toString(36);
      fsi.writeFileSync(tmp, JSON.stringify(v.config, null, 2) + '\n', 'utf8');
      try {
        fsi.renameSync(tmp, file);                  // 同目录 rename：Windows 上原子替换
      } catch (e) {
        try { fsi.unlinkSync(tmp); } catch (_) { /* 清不掉也不影响旧文件 */ }
        throw e;
      }
      return { ok: true, config: v.config };
    } catch (e) {
      if (tmp) { try { fsi.unlinkSync(tmp); } catch (_) {} }
      return { ok: false, error: '写入动画循环配置失败（原配置未改动）：' + msg(e) };
    }
  }

  return { file, get, set };
}

module.exports = {
  DEFAULT_CONFIG,
  MIN_SPAN_SEC,
  SPAN_EPSILON,
  MAX_ACTION_ID_LEN,
  normalizeConfig,
  createStore,
};
