'use strict';
/**
 * 天气（weather）测试
 *
 * 跑法：node tests/infohub/weather.test.js
 * 环境变量 SKIP_NET=1 可只跑离线用例（WMO 映射 / 快照整形）。
 *
 * 覆盖契约 §4.6 的验收点：
 *   1) WMO code → 中文现象映射（自建表，0~99 无空洞）
 *   2) open-meteo 返回 → 快照形状 {city,temp,text,days,updatedAt}
 *   3) 30 秒内重复 refresh() 直接回缓存
 *   4) 真实调通一次（记录返回城市/温度，这就是验收要求的实证）
 *   5) 中文城市名走 geocoding（编码正确 + 真实返回中文城市名）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const create = require('../../app/infohub/sources/weather.js');

const SKIP_NET = String(process.env.SKIP_NET || '') === '1';
const OUT_DIR = path.join(__dirname, '.tmp-weather');

let pass = 0;
let fail = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

/* ---------- 固定样本：open-meteo forecast（2026-11-25 真实抓取后精简，日期对齐样本日） ---------- */
const SAMPLE = {
  latitude: 39.9075,
  longitude: 116.39723,
  timezone: 'Asia/Shanghai',
  current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
  current: {
    time: '2026-11-25T09:00',
    interval: 900,
    temperature_2m: 0.4,
    weather_code: 0,
    relative_humidity_2m: 45,
    apparent_temperature: -2.6,
    wind_speed_10m: 1.2,
  },
  daily: {
    time: ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'],
    weather_code: [0, 3, 2, 61, 63, 95, 71],
    temperature_2m_max: [6.9, 11.2, 10.1, 9.8, 7.4, 11.9, 12.6],
    temperature_2m_min: [-2.1, 0.2, 3.9, 0.4, -0.3, -1.2, 2.8],
    precipitation_probability_max: [0, 10, 20, 80, 90, 70, 60],
  },
};

function makeCtx(clockRef, cfgPatch) {
  const snaps = [];
  const logs = [];
  const ctx = {
    cfg: () => Object.assign({ enabled: true, city: '', refreshMin: 15 }, cfgPatch || {}),
    setCfg: () => {},
    emit: () => {},
    snapshot: (k, v) => snaps.push({ kind: k, data: v }),
    log: (m) => logs.push(m),
    dataDir: OUT_DIR,
    appDir: path.join(__dirname, '../../app'),
    paths: {},
    now: clockRef ? () => clockRef.t : undefined,
  };
  return { ctx, snaps, logs };
}

/* ---------------- 离线用例 ---------------- */

test('WMO code → 中文现象：关键码全覆盖', () => {
  const map = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '有雾', 48: '雾凇',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴冰雹',
  };
  for (const [code, text] of Object.entries(map)) {
    assert.strictEqual(create.wmoText(Number(code)), text, 'code ' + code + ' 映射不对');
  }
  // 0~99 全段都不能回落到「未知」
  for (let c = 0; c <= 99; c++) {
    const t = create.wmoText(c);
    assert.strictEqual(typeof t, 'string');
    assert.ok(t.length > 0, 'code ' + c + ' 应有中文描述');
  }
  assert.strictEqual(create.wmoText(3), '阴');
  assert.strictEqual(create.wmoText(95), '雷阵雨');
  assert.strictEqual(create.wmoText(999), '代码 999', '表外代码应显式标出');
  assert.strictEqual(create.wmoText(null), '未知');
});

test('固定样本整形：city/temp/text/days 都对', () => {
  const ref = { t: new Date(2026, 10, 25, 9, 0, 0).getTime() };
  const { ctx, snaps } = makeCtx(ref, { city: '北京' });
  const w = create(ctx);
  const place = { city: '北京', lat: 39.9075, lon: 116.39723, source: 'geocoding' };
  const d = w._shape(place, SAMPLE);

  assert.strictEqual(d.city, '北京');
  assert.strictEqual(d.temp, 0, '0.4 应四舍五入成 0，实际 ' + d.temp);
  assert.strictEqual(d.text, '晴');
  assert.strictEqual(d.icon, '☀️');
  assert.strictEqual(d.feels, -3, '-2.6 应为 -3');
  assert.strictEqual(d.humidity, 45);
  assert.strictEqual(d.wind, 1);
  assert.strictEqual(d.days.length, 7);
  assert.strictEqual(d.days[0].date, '2026-11-25');
  assert.strictEqual(d.days[0].week, '周三');
  assert.strictEqual(d.days[3].text, '小雨', '61 应为小雨');
  assert.strictEqual(d.days[5].text, '雷阵雨', '95 应为雷阵雨');
  assert.strictEqual(d.days[0].pop, 0);
  assert.strictEqual(d.days[4].pop, 90);
  assert.strictEqual(d.updatedAt, ref.t, 'updatedAt 应取注入时钟');
  assert.strictEqual(snaps.length, 0, '整形函数本身不应上报快照');
});

test('中文城市名 → geocoding URL 编码正确', () => {
  const { ctx } = makeCtx(null);
  const w = create(ctx);
  const url = w._geocodeUrl('北京');
  assert.ok(url.startsWith('https://geocoding-api.open-meteo.com/v1/search?'), 'geocoding 域名不对：' + url);
  assert.ok(url.includes('name=%E5%8C%97%E4%BA%AC'), '中文应被 UTF-8 百分号编码：' + url);
  assert.ok(url.includes('language=zh'), '应带 language=zh');
});

test('缺字段的响应不炸（空 daily）', () => {
  const { ctx } = makeCtx(null);
  const w = create(ctx);
  const d = w._shape({ city: 'X', lat: 1, lon: 2, source: 'test' }, { current: {} });
  assert.strictEqual(d.days.length, 0);
  assert.strictEqual(d.temp, null, '没有温度应为 null 而不是 NaN');
  assert.strictEqual(d.text, '未知');
});

/* ---------------- 联网用例 ---------------- */

test('真实调通：拿到城市 + 温度 + 7 日', async () => {
  if (SKIP_NET) { console.log('     （SKIP_NET=1，跳过联网用例）'); return; }
  const ref = { t: Date.now() };
  const { ctx, snaps } = makeCtx(ref, { city: '' });
  const w = create(ctx);
  const r = await w.probe();
  assert.strictEqual(r.ok, true, '真实取数应成功：' + r.detail);
  assert.strictEqual(snaps.length, 1, '应上报一次 weather 快照');
  const s = snaps[0].data;
  assert.strictEqual(snaps[0].kind, 'weather');
  assert.ok(s.city && s.city.length > 0, '城市不能为空');
  assert.strictEqual(typeof s.temp, 'number', '温度应是数字，实际 ' + s.temp);
  assert.ok(s.temp > -80 && s.temp < 60, '温度应在合理区间，实际 ' + s.temp);
  assert.ok(s.text.length > 0, '应有中文现象');
  assert.strictEqual(s.days.length, 7, '应有 7 天预报');
  assert.ok(s.days.every((d) => typeof d.max === 'number' && typeof d.min === 'number'), '每天的 max/min 应为数字');
  assert.ok(s.days.every((d) => d.text && d.text.length > 0), '每天应有中文现象');
  assert.ok(s.updatedAt > 0);
  console.log('     实测：' + s.city + ' ' + s.temp + '°C ' + s.text + '（' + s.placeSource
    + '），未来 7 天 ' + s.days[0].min + '~' + s.days[0].max + '°C');
  await w.stop();
});

test('30 秒内重复 refresh() 回缓存', async () => {
  if (SKIP_NET) { console.log('     （SKIP_NET=1，跳过联网用例）'); return; }
  const ref = { t: Date.now() };
  const { ctx } = makeCtx(ref, { city: '' });
  const w = create(ctx);
  const r1 = await w.probe();                       // 强制真打
  assert.strictEqual(r1.ok, true, '首次取数应成功：' + r1.detail);
  const r2 = await w.refresh();                     // 30s 内：应命中缓存
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.cached, true, '30 秒内应命中缓存，实际 cached=' + r2.cached);
  await w.stop();
});

test('中文城市 cfg.city 走 geocoding（真实返回中文名）', async () => {
  if (SKIP_NET) { console.log('     （SKIP_NET=1，跳过联网用例）'); return; }
  const ref = { t: Date.now() };
  const { ctx, snaps } = makeCtx(ref, { city: '上海' });
  const w = create(ctx);
  const r = await w.probe();
  assert.strictEqual(r.ok, true, 'geocoding 路径应成功：' + r.detail);
  const s = snaps[0].data;
  assert.strictEqual(s.placeSource, 'geocoding', '应走 geocoding 而不是 IP 定位');
  assert.strictEqual(s.city, '上海', '城市名应保持中文，实际 ' + s.city);
  assert.ok(Math.abs(s.lat - 31.22) < 1.5, '上海纬度应接近 31.2，实际 ' + s.lat);
  console.log('     实测：' + s.city + ' ' + s.lat + ',' + s.lon + ' ' + s.temp + '°C ' + s.text);
  await w.stop();
});

test('start/stop 生命周期：定时器能清干净', async () => {
  if (SKIP_NET) { console.log('     （SKIP_NET=1，跳过联网用例）'); return; }
  const ref = { t: Date.now() };
  const { ctx } = makeCtx(ref, { city: '北京' });
  const w = create(ctx);
  await w.start();
  assert.strictEqual(w.status().ready, true, 'start 后应 ready：' + JSON.stringify(w.status()));
  await w.stop();
  const st = w.status();
  assert.strictEqual(st.ready, false, 'stop 后应 not ready');
  assert.strictEqual(st.detail, '已停止');
  // 再 start 一次不应报错（宿主会反复 start）
  await w.start();
  assert.strictEqual(w.status().ready, true);
  await w.stop();
});

/* ---------------- 执行 ---------------- */

(async () => {
  for (const [name, fn] of cases) {
    try {
      await fn();
      pass++;
      console.log('  ✓ ' + name);
    } catch (e) {
      fail++;
      console.log('  ✗ ' + name + '\n     ' + (e && e.message));
    }
  }
  try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('\nweather: ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + cases.length
    + (SKIP_NET ? '（SKIP_NET=1，只跑了离线用例）' : ''));
  if (fail) process.exitCode = 1;
})();
