/* 走动几何（纯函数，浏览器与 Node 共用同一份）
 *
 * 为什么单独成文件：走动的正确性几乎全在几何上——「画布不越界」「二维有界」
 * 「朝向只看水平分量」「窗口/分辨率变了范围要跟着换算」。这些都能脱离 DOM 断言，
 * 所以放在这里，由 tests/walk-geom.test.cjs 直接 require（浏览器侧挂 window.CatwhaleWalkGeom）。
 *
 * 坐标约定：全部是窗口内 CSS 像素。rect 是「允许走动的矩形」（左上角 + 尺寸），
 * pet 的位置是它自己的左上角（不是脚底），尺寸 = height × 900/1500 宽。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatwhaleWalkGeom = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_SIZE = 80;      // 框选矩形最短边：再小连角色都放不进，按误框处理
  const round2 = (v) => Math.round(v * 100) / 100;
  function num(v) {
    const n = typeof v === 'string' ? Number(v.trim()) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }

  /** 拖拽起止两点 → 规范化矩形（支持反方向拖、任意顺序） */
  function rectFromDrag(a, b) {
    const ax = num(a && a.x), ay = num(a && a.y);
    const bx = num(b && b.x), by = num(b && b.y);
    const x1 = ax === null ? 0 : ax, y1 = ay === null ? 0 : ay;
    const x2 = bx === null ? 0 : bx, y2 = by === null ? 0 : by;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2),
             width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  /** 脏数据清洗：接受 {x,y,width,height} 或 {x,y,w,h}；负数尺寸归 0；无效坐标返回 null */
  function normalizeRect(r) {
    if (!r || typeof r !== 'object') return null;
    const x = num(r.x), y = num(r.y);
    const w = num(r.width !== undefined ? r.width : r.w);
    const h = num(r.height !== undefined ? r.height : r.h);
    if (x === null || y === null || w === null || h === null) return null;
    return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
  }

  /** 矩形是否算一个「有效范围」（单击/误拖出来的零面积不算） */
  function rectOk(rect) {
    const r = normalizeRect(rect);
    return !!r && r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  /** 把矩形裁进可用区域；完全无交集返回 null（屏幕变小后旧范围可能整体越界） */
  function intersectRect(rect, area) {
    const r = normalizeRect(rect);
    const a = normalizeRect(area);
    if (!r) return null;
    if (!a) return r;
    const x = Math.max(r.x, a.x), y = Math.max(r.y, a.y);
    const right = Math.min(r.x + r.width, a.x + a.width);
    const bottom = Math.min(r.y + r.height, a.y + a.height);
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }

  /** 角色左上角可以落在的闭区间。矩形比角色还小时只能居中（此时唯一解） */
  function petBox(rect, petW, petH) {
    const r = normalizeRect(rect) || { x: 0, y: 0, width: 0, height: 0 };
    const w = Math.max(1, num(petW) || 1), h = Math.max(1, num(petH) || 1);
    let minX, maxX, centeredX;
    if (r.width >= w) { minX = r.x; maxX = r.x + r.width - w; centeredX = false; }
    else { minX = maxX = r.x + (r.width - w) / 2; centeredX = true; }
    let minY, maxY, centeredY;
    if (r.height >= h) { minY = r.y; maxY = r.y + r.height - h; centeredY = false; }
    else { minY = maxY = r.y + (r.height - h) / 2; centeredY = true; }
    return { minX, maxX, minY, maxY, centeredX, centeredY };
  }

  /** 把角色位置夹进包围盒；clamped 用来区分「走到了」和「卡在边界上」 */
  function clampPet(x, y, box) {
    const px = num(x), py = num(y);
    if (!box || px === null || py === null) return { x: px || 0, y: py || 0, clamped: false };
    const cx = Math.min(Math.max(px, box.minX), box.maxX);
    const cy = Math.min(Math.max(py, box.minY), box.maxY);
    return { x: cx, y: cy, clamped: (Math.abs(cx - px) > 1e-6) || (Math.abs(cy - py) > 1e-6) };
  }

  /** 朝目标直线推进最多 maxDist 像素；剩余距离不足时精确落在目标上。
   *  返回的 dx/dy 是**这一步实际走了多少**（不是剩余量），distance 是移动前到目标的距离。 */
  function stepToward(x, y, tx, ty, maxDist) {
    const d = num(maxDist);
    const dist = Math.hypot(tx - x, ty - y);
    let nx = tx, ny = ty, arrived = true;
    if (dist > 0 && !(d !== null && d >= dist)) {
      const k = Math.max(0, d === null ? 0 : d) / dist;
      nx = x + (tx - x) * k; ny = y + (ty - y) * k; arrived = false;
    }
    return { x: nx, y: ny, arrived, dx: nx - x, dy: ny - y, distance: dist };
  }

  /** 朝向：只由水平分量决定（纯竖直移动沿用上一次朝向 = 返回 ''） */
  function facingOf(dx) {
    const v = num(dx);
    if (v === null || v === 0) return '';
    return v < 0 ? 'left' : 'right';
  }

  /** 窗口/分辨率变化后按比例换算矩形；缺少任一尺寸就原样返回，绝不瞎猜 */
  function scaleRect(rect, fromWin, toWin) {
    const r = normalizeRect(rect);
    const from = normalizeRect(fromWin ? { x: 0, y: 0, width: fromWin.width, height: fromWin.height } : null);
    const to = normalizeRect(toWin ? { x: 0, y: 0, width: toWin.width, height: toWin.height } : null);
    if (!r) return null;
    if (!from || !to || from.width <= 0 || from.height <= 0) return r;
    if (from.width === to.width && from.height === to.height) return r;
    const sx = to.width / from.width, sy = to.height / from.height;
    return { x: round2(r.x * sx), y: round2(r.y * sy),
             width: round2(r.width * sx), height: round2(r.height * sy) };
  }

  /** 巡游的下一个目标点：包围盒内均匀随机（含边界） */
  function cruiseTarget(box, rnd) {
    const f = typeof rnd === 'function' ? rnd : Math.random;
    if (!box) return { x: 0, y: 0 };
    return { x: box.minX + f() * (box.maxX - box.minX),
             y: box.minY + f() * (box.maxY - box.minY) };
  }

  /** 范围能不能真的走动：整块画布必须放得下。
   *  放不下（框比角色画布还小）时不是「夹一夹凑合」，而是根本不该开始走动——
   *  否则 petBox 会把画布钉在框中心，走出框、或者头被屏幕边缘裁掉。 */
  function fitsRect(rect, petW, petH) {
    const r = normalizeRect(rect);
    const w = Math.max(1, num(petW) || 1), h = Math.max(1, num(petH) || 1);
    const need = { w: Math.ceil(w), h: Math.ceil(h) };
    if (!r) return { ok: false, error: '走动范围无效', need };
    if (r.width + 0.5 >= w && r.height + 0.5 >= h) return { ok: true, error: '', need };
    return { ok: false, need,
             error: '范围 ' + Math.round(r.width) + '×' + Math.round(r.height) +
                    ' 比角色画布 ' + need.w + '×' + need.h + ' 还小' };
  }

  /** 把走动目标夹进包围盒：窗口/范围变了以后目标可能落到框外，
   *  不重算的话「往那走」这一步永远差一点，循环不收敛（Promise 也永远不 resolve）。 */
  function clampTarget(target, box) {
    const t = target || {};
    const c = clampPet(num(t.x) === null ? 0 : t.x, num(t.y) === null ? 0 : t.y, box);
    return { x: c.x, y: c.y, moved: c.clamped };
  }

  return { MIN_SIZE, rectFromDrag, normalizeRect, rectOk, intersectRect, petBox, clampPet,
           fitsRect, clampTarget,
           stepToward, facingOf, scaleRect, cruiseTarget };
});
