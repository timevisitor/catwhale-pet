'use strict';
/* =====================================================================
   tests/infohub/winnotify.test.js —— winnotify 源模块测试（零依赖，自带 assert）
   · 各应用 toast 文本结构用固定样本断言（微信三段式 / 微信两段式 / QQ / 飞书 / 企业微信）
   · 用「假探针」（队列化返回）驱动整条轮询链路：基线 → 新消息 → 按 id 去重 → 同会话合并
   · 应用开关过滤、正文截断、@提醒升级
   · 最后（Windows 上）真跑一次 winnotify_probe.ps1，把本机真实结论打出来（不因权限失败而红）
   跑法：node tests/infohub/winnotify.test.js
   ===================================================================== */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'app', 'infohub', 'sources', 'winnotify.js');
const mod = require(SRC);
const { parseItem, toEvent, matchApp, splitTexts, parseProbeJson, clip, APPS } = mod._internals;
const createWithProbe = mod._createWithProbe;

/* ---------------- 极简断言框架 ---------------- */
let pass = 0;
const fails = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { pass++; console.log('  ok   ' + name); },
        (e) => { fails.push({ name, e }); console.log('  FAIL ' + name + ' → ' + e.message); });
    }
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fails.push({ name, e });
    console.log('  FAIL ' + name + ' → ' + e.message);
  }
  return Promise.resolve();
}

/* ---------------- 固定样本（形状对齐 winnotify_probe.ps1 的真实输出） ---------------- */
/** 微信 4.x：text[0]=应用名、text[1]=会话名、text[2]="发送者 : 正文" */
const WX_GROUP = {
  app: '微信', aumid: 'TencentWeChatLimited.forWindows10_sdtnhv12zgd7a!App', id: '1001',
  creation: '2026-11-25T10:00:00.0000000+08:00',
  texts: ['微信', '产品讨论组', '张三 : 晚上八点开会，记得带原型图'],
  title: '微信', body: '产品讨论组 / 张三 : 晚上八点开会，记得带原型图',
};
/** 微信私聊两段式（部分版本不带应用名那一段） */
const WX_DM = {
  app: '微信', aumid: 'WeChat', id: '1002', creation: '2026-11-25T10:01:00.0000000+08:00',
  texts: ['李四', '在吗？帮我看下这个'],
  title: '李四', body: '在吗？帮我看下这个',
};
/** 微信只有一段：会话名都拿不到 */
const WX_ONE = {
  app: '微信', aumid: 'WeChat', id: '1003', creation: '', texts: ['王五 : 收到'], title: '王五 : 收到', body: '',
};
/** QQ：texts[0]=群名，其余是正文（本机实测形状） */
const QQ_GROUP = {
  app: 'QQ', aumid: 'QQ', id: '19680', creation: '2026-11-22T11:11:04.1817741+08:00',
  texts: ['约120群', '[@全体成员] 梦幻：下播啦'],
  title: '约120群', body: '[@全体成员] 梦幻：下播啦',
};
/** 飞书：第一行会话名，后面可能多段 */
const FEISHU_GROUP = {
  app: '飞书', aumid: 'Feishu', id: 'fe-1', creation: '2026-11-25T09:30:00.0000000+08:00',
  texts: ['项目组', '李四：文档已更新', '补充一句：附件在群公告'],
  title: '项目组', body: '李四：文档已更新 / 补充一句：附件在群公告',
};
/** 企业微信：必须归到 wecom，不能被 /微信/ 抢走 */
const WECOM_GROUP = {
  app: '企业微信', aumid: 'wxwork', id: 'wc-1', creation: '', texts: ['客户群', '客户：报价单收到了吗'],
  title: '客户群', body: '客户：报价单收到了吗',
};
/** 不是我们管的应用 */
const OTHER = {
  app: 'Intel Driver & Support Assistant', aumid: 'Intel.Dsa.Tray', id: '19688', creation: '',
  texts: ['可用更新', '• Intel® 11th – 14th Gen Proc...'], title: '可用更新', body: '• Intel® 11th – 14th Gen Proc...',
};

const resp = (items) => ({ ok: true, engine: 'winrt', access: 'Allowed', count: items.length, items });

/**
 * 造一个带假探针的实例。
 * @param {object} cfg  源配置
 * @param {Array}  queue 每次探针按顺序消费；用最后一个元素兜底
 */
function makeInst(cfg, queue) {
  const emitted = [];
  const logs = [];
  let i = 0;
  const probeFn = () => {
    const r = queue[Math.min(i, queue.length - 1)];
    i += 1;
    return Promise.resolve(typeof r === 'function' ? r() : JSON.parse(JSON.stringify(r)));
  };
  const conf = Object.assign({ enabled: true, pollMs: 3600000 }, cfg || {});
  const ctx = {
    cfg: () => conf,
    setCfg: () => {},
    emit: (e) => emitted.push(e),
    snapshot: () => {},
    log: (m) => logs.push(m),
    dataDir: path.join(os.tmpdir(), 'infohub-winnotify-test'),
    appDir: path.join(__dirname, '..', '..'),
    paths: {},
  };
  return { inst: createWithProbe(ctx, probeFn), emitted, logs, conf };
}

/* ===================================================================== */
(async function main() {
  console.log('winnotify 源模块测试');
  console.log('— 应用识别 —');

  await test('应用识别：微信 / QQ / 飞书 / 企业微信（企业微信不被微信抢）', () => {
    assert.strictEqual(matchApp(WX_GROUP).id, 'wechat');
    assert.strictEqual(matchApp(QQ_GROUP).id, 'qq');
    assert.strictEqual(matchApp(FEISHU_GROUP).id, 'feishu');
    assert.strictEqual(matchApp(WECOM_GROUP).id, 'wecom', '「企业微信」必须先命中 wecom');
    assert.strictEqual(matchApp({ app: 'WeChat Work', aumid: '' }).id, 'wecom');
    assert.strictEqual(matchApp(OTHER), null, '无关应用应返回 null');
    assert.strictEqual(matchApp(null), null);
    // 应用表顺序：企业微信在微信之前
    assert.ok(APPS.findIndex((a) => a.id === 'wecom') < APPS.findIndex((a) => a.id === 'wechat'));
  });

  console.log('— 各应用文本结构解析 —');

  await test('微信三段式：text[1]=会话名，text[2]="发送者 : 正文"', () => {
    const p = parseItem(WX_GROUP);
    assert.strictEqual(p.app.id, 'wechat');
    assert.strictEqual(p.chatName, '产品讨论组');
    assert.strictEqual(p.body, '张三 : 晚上八点开会，记得带原型图');
  });

  await test('微信两段式（无应用名段）：text[0]=会话名', () => {
    const p = parseItem(WX_DM);
    assert.strictEqual(p.chatName, '李四');
    assert.strictEqual(p.body, '在吗？帮我看下这个');
  });

  await test('微信只有一段：整体当正文，会话名退成应用名', () => {
    const p = parseItem(WX_ONE);
    assert.strictEqual(p.chatName, '微信');
    assert.strictEqual(p.body, '王五 : 收到');
  });

  await test('QQ：第一行=会话名，其余=正文', () => {
    const p = parseItem(QQ_GROUP);
    assert.strictEqual(p.app.id, 'qq');
    assert.strictEqual(p.chatName, '约120群');
    assert.strictEqual(p.body, '[@全体成员] 梦幻：下播啦');
  });

  await test('飞书：多段正文用 / 连接', () => {
    const p = parseItem(FEISHU_GROUP);
    assert.strictEqual(p.app.id, 'feishu');
    assert.strictEqual(p.chatName, '项目组');
    assert.strictEqual(p.body, '李四：文档已更新 / 补充一句：附件在群公告');
  });

  await test('企业微信归到 wecom', () => {
    const p = parseItem(WECOM_GROUP);
    assert.strictEqual(p.app.id, 'wecom');
    assert.strictEqual(p.chatName, '客户群');
  });

  await test('第一段是应用名（QQ）时去掉，不当会话名', () => {
    const p = parseItem({ app: 'QQ', aumid: 'QQ', id: 'x', texts: ['QQ', '约120群', '你好'] });
    assert.strictEqual(p.chatName, '约120群');
    assert.strictEqual(p.body, '你好');
  });

  await test('老格式（无 texts 数组）退 title + body', () => {
    assert.deepStrictEqual(splitTexts({ title: 'A', body: 'B' }), ['A', 'B']);
    const p = parseItem({ app: 'QQ', aumid: 'QQ', id: 'y', title: '约120群', body: '你好' });
    assert.strictEqual(p.chatName, '约120群');
    assert.strictEqual(p.body, '你好');
  });

  console.log('— 事件归一化 —');

  await test('事件：title=应用 · 会话，body 截断 90 字，两个动作', () => {
    const long = { app: 'QQ', aumid: 'QQ', id: 'z', creation: '', texts: ['群', 'x'.repeat(200)] };
    const p = parseItem(long);
    const evt = toEvent(p, long);
    assert.strictEqual(evt.source, 'winnotify');
    assert.strictEqual(evt.kind, 'message');
    assert.strictEqual(evt.title, 'QQ · 群');
    assert.strictEqual(evt.body.length, 90);
    assert.ok(evt.body.endsWith('…'));
    assert.strictEqual(evt.key, 'winnotify:m:qq:QQ:z');
    assert.strictEqual(evt.actions.length, 2);
    assert.strictEqual(evt.actions[0].kind, 'copy');
    assert.strictEqual(evt.actions[1].kind, 'app');
    assert.strictEqual(evt.actions[1].payload, 'qq');
    assert.strictEqual(evt.data.via, 'windows-notification-center');
    // 飞书打开目标是 lark（宿主 map 里是 Feishu）
    assert.strictEqual(toEvent(parseItem(FEISHU_GROUP), FEISHU_GROUP).actions[1].payload, 'lark');
  });

  await test('@提醒升级为 warn', () => {
    const evt = toEvent(parseItem(QQ_GROUP), QQ_GROUP);
    assert.strictEqual(evt.level, 'warn');
    const wx = { app: '微信', aumid: 'WeChat', id: 'w', texts: ['微信', '张三', '张三 : 在吗'] };
    assert.strictEqual(toEvent(parseItem(wx), wx).level, 'info');
  });

  await test('clip：超长截断带省略号，短文本原样', () => {
    assert.strictEqual(clip('abc'), 'abc');
    assert.strictEqual(clip('a'.repeat(95), 90).length, 90);
  });

  await test('parseProbeJson：单元素数组被 PS 压成对象时补回 + texts 归一', () => {
    const one = parseProbeJson(JSON.stringify({ ok: true, items: { app: 'QQ', aumid: 'QQ', id: '1', texts: '只有一段' } }));
    assert.strictEqual(one.items.length, 1);
    assert.deepStrictEqual(one.items[0].texts, ['只有一段']);
    const bad = parseProbeJson('not json at all');
    assert.strictEqual(bad.ok, false);
  });

  console.log('— 轮询链路 —');

  await test('首轮只建基线：历史条目不弹', async () => {
    const { inst, emitted } = makeInst({}, [resp([WX_GROUP, QQ_GROUP])]);
    const r = await inst.start();
    assert.strictEqual(emitted.length, 0, '基线轮不应弹任何卡片');
    assert.strictEqual(r.ok, true);
    assert.match(inst.status().detail, /通知中心 2 条/);
    await inst.stop();
  });

  await test('基线之后：新 id 弹一次，旧 id 不重复；按 id 去重', async () => {
    const neu = Object.assign({}, QQ_GROUP, { id: '20001', texts: ['约120群', '新消息来了'] });
    const { inst, emitted } = makeInst({}, [
      resp([QQ_GROUP]),                       // 基线
      resp([QQ_GROUP, neu]),                  // 新增一条
      resp([QQ_GROUP, neu]),                  // 同一批再来一次（id 已见）
    ]);
    await inst.start();
    await inst.refresh();
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].body, '新消息来了');
    await inst.refresh();
    assert.strictEqual(emitted.length, 1, '同 id 再来一次不应重复弹');
    assert.strictEqual(inst.status().apps.qq.emitted, 1);
    await inst.stop();
  });

  await test('应用开关：qq:false 时 QQ 不弹、微信照弹', async () => {
    const neuWx = Object.assign({}, WX_DM, { id: '1009' });
    const neuQq = Object.assign({}, QQ_GROUP, { id: '20100' });
    const { inst, emitted } = makeInst({ apps: { wechat: true, qq: false, feishu: true, dingtalk: false, wecom: false } }, [
      resp([]),                                 // 基线
      resp([neuWx, neuQq]),
    ]);
    await inst.start();
    await inst.refresh();
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].data.appId, 'wechat');
    assert.strictEqual(inst.status().apps.qq.enabled, false);
    assert.match(inst.status().apps.qq.detail, /未启用/);
    await inst.stop();
  });

  await test('去重集合保留被关掉应用的 id：重新打开不会补弹历史', async () => {
    const neuQq = Object.assign({}, QQ_GROUP, { id: '20200' });
    const { inst, emitted, conf } = makeInst({ apps: { qq: false } }, [
      resp([]),
      resp([neuQq]),        // QQ 关着 → 只记 id
      resp([neuQq]),        // 打开后同一 id 不应再弹
    ]);
    await inst.start();
    await inst.refresh();
    conf.apps = { qq: true, wechat: true, feishu: true };
    await inst.refresh();
    assert.strictEqual(emitted.length, 0);
    await inst.stop();
  });

  await test('同会话 10 秒内合并：3 条只弹 1 条，合并计数=2', async () => {
    const a = Object.assign({}, WX_GROUP, { id: '3001', texts: ['微信', '产品讨论组', '张三 : 一'] });
    const b = Object.assign({}, WX_GROUP, { id: '3002', texts: ['微信', '产品讨论组', '张三 : 二'] });
    const c = Object.assign({}, WX_GROUP, { id: '3003', texts: ['微信', '产品讨论组', '张三 : 三'] });
    const { inst, emitted } = makeInst({}, [resp([]), resp([a, b, c])]);
    await inst.start();
    await inst.refresh();
    assert.strictEqual(emitted.length, 1, '同会话爆发只应弹第一条');
    assert.strictEqual(emitted[0].body, '张三 : 一');
    assert.strictEqual(inst.status().apps.wechat.emitted, 1);
    assert.strictEqual(inst.status().apps.wechat.merged, 2);
    await inst.stop();
  });

  await test('不同会话不互相合并', async () => {
    const a = Object.assign({}, WX_GROUP, { id: '3101', texts: ['微信', '群甲', '张三 : 一'] });
    const b = Object.assign({}, WX_GROUP, { id: '3102', texts: ['微信', '群乙', '李四 : 二'] });
    const { inst, emitted } = makeInst({}, [resp([]), resp([a, b])]);
    await inst.start();
    await inst.refresh();
    assert.strictEqual(emitted.length, 2);
    assert.deepStrictEqual(emitted.map((e) => e.title), ['微信 · 群甲', '微信 · 群乙']);
    await inst.stop();
  });

  await test('合并窗口关闭后（mergeMs:0）同会话每条都弹', async () => {
    const a = Object.assign({}, WX_GROUP, { id: '3201', texts: ['微信', '产品讨论组', '张三 : 一'] });
    const b = Object.assign({}, WX_GROUP, { id: '3202', texts: ['微信', '产品讨论组', '张三 : 二'] });
    const { inst, emitted } = makeInst({ mergeMs: 0 }, [resp([]), resp([a]), resp([b])]);
    await inst.start();
    await inst.refresh();
    await inst.refresh();
    assert.strictEqual(emitted.length, 2);
    assert.strictEqual(inst.status().apps.wechat.merged, 0);
    await inst.stop();
  });

  await test('探针失败：ready=false 且状态写清原因，不抛异常', async () => {
    const { inst, emitted } = makeInst({}, [{ ok: false, error: '系统未允许读取通知（Denied）', items: [] }]);
    const r = await inst.start();
    assert.strictEqual(r.ok, false);
    assert.match(inst.status().detail, /Denied/);
    assert.strictEqual(emitted.length, 0);
    await inst.stop();
  });

  await test('status()：每个应用一条独立明细', async () => {
    const { inst } = makeInst({}, [resp([WX_GROUP, QQ_GROUP, QQ_GROUP, FEISHU_GROUP])]);
    await inst.start();
    const st = inst.status();
    for (const id of ['wechat', 'qq', 'feishu', 'dingtalk', 'wecom']) {
      assert.ok(st.apps[id], '缺少 ' + id + ' 的明细');
      assert.strictEqual(typeof st.apps[id].label, 'string');
      assert.strictEqual(typeof st.apps[id].hits, 'number');
      assert.strictEqual(typeof st.apps[id].detail, 'string');
    }
    assert.strictEqual(st.apps.qq.hits, 2);
    assert.strictEqual(st.apps.wechat.hits, 1);
    assert.strictEqual(st.apps.dingtalk.enabled, false);
    assert.match(st.apps.dingtalk.detail, /未启用/);
    await inst.stop();
  });

  await test('probe()：真跑一次假探针，返回各应用命中数与样本', async () => {
    const { inst } = makeInst({}, [resp([WX_GROUP, QQ_GROUP, OTHER])]);
    const r = await inst.probe();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.access, 'Allowed');
    assert.strictEqual(r.apps.wechat.hits, 1);
    assert.strictEqual(r.apps.qq.hits, 1);
    assert.strictEqual(r.apps.qq.sample[0].chatName, '约120群');
    assert.strictEqual(r.unknown.hits, 1);
    assert.match(r.detail, /access=Allowed/);
    await inst.stop();
  });

  /* ---------------- 真机探测（只在 Windows 上跑，失败不算红） ---------------- */
  if (process.platform === 'win32') {
    console.log('— 真机探测（真跑 winnotify_probe.ps1，约 1~2 秒） —');
    await test('真机：--probe 能读出通知中心（若权限未开则如实报告）', async () => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [SRC, '--probe'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const txt = String(r.stdout || '');
      let o = null;
      try { o = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch (e) { /* 下面统一报 */ }
      assert.ok(o, '探针输出不是 JSON：' + txt.slice(0, 160));
      console.log('       真机结论：' + o.detail + '（' + (Date.now() - t0) + 'ms）');
      if (o.ok) {
        assert.ok(typeof o.access === 'string');
        assert.ok(o.apps && typeof o.apps === 'object');
        console.log('       应用命中：' + Object.keys(o.apps).map((k) => o.apps[k].label + '=' + o.apps[k].hits).join(', ') +
          '；其它=' + (o.unknown ? o.unknown.hits : 0));
      } else {
        console.log('       （本机读不到通知中心，原因如上；不算失败）');
      }
    });
  }

  /* ---------------- 收尾 ---------------- */
  console.log('');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    for (const f of fails) console.log('  · ' + f.name + '\n    ' + (f.e && f.e.stack ? f.e.stack.split('\n').slice(0, 3).join('\n    ') : ''));
    process.exitCode = 1;
  } else {
    console.log('全部通过：' + pass + ' 项');
    process.exitCode = 0;
  }
})();
