# 桌宠「信息中枢」模块契约（v1）

本文是各功能模块的实现契约。**先读完全文再动手**。所有模块由主进程 `app/infohub/index.js` 统一装载。

## 0. 硬规则（违反即返工）

1. **只用 Node 内置模块**（`node:net` / `node:tls` / `node:http` / `node:https` / `node:fs` / `node:crypto` / `node:child_process` / `node:path` / `node:os`）。
   `app/node_modules` 里只有 electron 本身，**没有任何第三方包可用**，禁止 `require('axios')` 之类。
2. **不碰别人的文件**：只允许新建/修改 `app/infohub/**` 与 `tests/infohub/**`。
   绝对不要改 `app/main.js`、`app/preload.js`、`web/index.html`（集成由主会话做，同时改必冲突）。
3. **工作目录只放 H 盘**。临时文件写到 `ctx.scratchDir`（由宿主传 `%TEMP%` 同级 scratch），不要新建 C 盘目录。
4. **密钥永不落日志**：日志里只允许出现前 4 位 + `…` + 长度。事件 `data` 里不放原始 key/cookie/授权码。
5. **所有网络/子进程调用必须带超时**（HTTP ≤ 15s，子进程 ≤ 20s），失败走 `status()` 报告，不抛到顶层。
6. 代码注释、日志、README 一律中文。缩进 2 空格，风格对齐现有 `app/*.js`（`'use strict'`，CommonJS）。
7. **必须自己跑通测试并贴真实输出**。禁写"已验证"而没跑。测试用 `node tests/infohub/<name>.test.js`（自带 assert，不依赖 jest）。

## 1. 统一接口

每个源模块导出一个工厂：

```js
'use strict';
/**
 * @param {object} ctx  宿主上下文
 * @returns {object}    源实例
 */
module.exports = function create(ctx) {
  // ctx = {
  //   cfg:      () => object,      // 本源的配置（可能是空对象，一律按默认值兜底）
  //   setCfg:   (patch) => void,   // 需要持久化配置时调用（合并写盘，宿主负责落盘）
  //   emit:     (evt) => void,     // 上报归一化事件（见 §2）
  //   snapshot: (kind, data) => void, // 上报"面板数据快照"（不进弹窗队列）
  //   log:      (msg) => void,     // 统一日志（自动加 [infohub:<name>] 前缀）
  //   dataDir:  string,            // %APPDATA%\桌宠 可写目录
  //   appDir:   string,            // app/ 目录（用来定位 lark-cli、ps1 等）
  //   paths:    { localAppData, home, hermesHome }
  //   hasFeature:(name)=>boolean    // 可选能力探测
  // }
  let timer = null;
  let state = { ready: false, detail: '未启动' };

  return {
    name: 'napcat',            // 唯一 id，小写
    label: 'QQ 消息',          // 设置页显示名
    defaults: { enabled: false, wsUrl: 'ws://127.0.0.1:3000' },  // 配置默认值，宿主会合并
    async start() { /* 起定时器/连接 */ state = { ready: true, detail: '运行中' }; },
    async stop()  { if (timer) clearInterval(timer), timer = null; },
    status() { return state; },                       // {ready, detail} 给设置页
    async refresh() { return { ok: true }; },          // 手动刷新（面板"刷新"按钮）
    async probe() { /* 可选：连通性自检，返回 {ok, detail} */ }
  };
};
```

- `start()` 可被反复调用（宿主会先 `stop()`）。
- **不允许 `process.exit`、不允许 `app.quit`、不允许改动全局 env**。
- 长跑定时器一律 `unref()`，并在 `stop()` 里清干净。

## 2. 归一化事件（进弹窗队列）

```js
ctx.emit({
  source: 'napcat',            // = 模块 name
  kind: 'message',             // message | mail | reminder | balance
  level: 'info',               // info | warn | alert
  title: 'QQ · 约120群 / 张三',
  body: '晚上吃饭吗（不超过 90 字，超了截断加 …）',
  ts: Date.now(),
  key: 'napcat:m:123456',      // 去重键：同 key 在 60 秒内只弹一次
  actions: [                   // 最多 2 个；kind 见下
    { id: 'copy', label: '复制', kind: 'copy', payload: '晚上吃饭吗' },
    { id: 'open', label: '打开', kind: 'app',  payload: 'qq' }   // app 由宿主映射到具体程序
  ],
  data: { ... }                // 源自有字段，面板用；不放密钥
});
```

`kind` 语义：
- `message`：人发来的消息（QQ/飞书/微信）→ 弹窗。
- `mail`：新邮件 + 验证码 → 弹窗，验证码放 `data.code`。
- `reminder`：待办/专注/喝水到点 → 弹窗。
- `balance`：额度异常（低于阈值）才弹；正常数据走 `snapshot`。

## 3. 面板快照（不进弹窗）

```js
ctx.snapshot('balance', { items: [...], updatedAt: 1763... });
ctx.snapshot('weather', { city, temp, text, days: [...], updatedAt });
ctx.snapshot('calendar', { today: [...], updatedAt });
ctx.snapshot('reminders', { todos: [...], focus: {...}, water: {...} });
ctx.snapshot('mail', { list: [...] });
```

宿主会把最近一次快照缓存并推给面板。**快照里也不许出现密钥**。

## 4. 各模块分工与验收

> 现状（v2）：消息统一走 `winnotify.js`（读 Windows 通知中心，非侵入）。下面 4.1/4.2 是历史实现，
> 文件已移到 `app/infohub/sources/optional/`，不再装载。

### 4.1 `app/infohub/sources/napcat.js` —— QQ 消息（OneBot/NapCat）
- 连接 `cfg.wsUrl`（默认 `ws://127.0.0.1:3000`），可带 `cfg.token`（`Authorization: Bearer`）。
- Node 22 有全局 `WebSocket`；**若 `typeof WebSocket === 'undefined'` 必须自己用 `node:net` 实现最小 WS 客户端**（握手 + 文本帧 + ping/pong + 掩码），不能报错退出。
- 只处理 `post_type === 'message'`；忽略自己发的（`message_sent`、`user_id === self_id`）。
- 文本清洗：剥 `[CQ:face,...]`→`[表情]`、`[CQ:image,...]`→`[图片]`、`[CQ:at,...]`→`@某人`；空白折叠。
- 群里被 @ 自己、或私聊 → `level:'warn'`；其余 `info`。
- 断线重连：指数退避 2s→30s 封顶，`status()` 里体现 `已断线，重试中`。
- **验收**：自带假 WS 服务端（`node:net` 手写，能完成握手与会话），用假 OneBot JSON 驱动，断言：
  1. 私聊/群聊各产出一条 `message` 事件，title/body 正确；2. CQ 码被清洗；3. 自己消息被忽略；4. 断线后能重连（或至少状态变 `重试中`）。

### 4.2 `app/infohub/sources/wechat.js` —— 微信消息（Windows 11 通知中心，尽力而为）
- 用 PowerShell + UIAutomationClient 读"通知中心"里应用名含 `微信`/`WeChat` 的条目，轮询 3s。
- 脚本独立成文件 `app/infohub/sources/wechat_probe.ps1`，可单独跑：`node app/infohub/sources/wechat.js --probe` 输出 JSON。
- 本机实测拿不到就**如实**把 `status().detail` 写成"本机通知中心读不到微信（Windows 版本/微信版本不支持）"，并让 `start()` 不报错、只是不通。
- **验收**：贴 `--probe` 的真实输出（拿到什么都行，必须是真跑出来的）。

### 4.3 `app/infohub/sources/lark.js` —— 飞书消息
- 优先用 `lark-cli`（先探测 `%LOCALAPPDATA%\hermes\node\lark-cli`，再试 PATH）。
- 先真跑 `lark-cli im --help` 摸清可用的未读/最近消息命令，把真实命令写进注释。
- 轮询 30s，新未读会话 → `message` 事件（title=`飞书 · <会话名>`，body=最后一条摘要；拿不到摘要就写"N 条未读"）。
- 分页/去重：按 chat_id + 消息 id 去重，首次启动只建基线不炸屏（前 60 秒不弹）。
- **验收**：贴真实命令输出片段（脱敏），断言解析函数用固定 JSON 样本能产出正确事件。

### 4.4 `app/infohub/sources/mail.js` + `lib/imap-lite.js` + `lib/code-extract.js` —— 邮箱验证码
- `imap-lite.js`：纯 `node:tls` 的极简 IMAP 客户端，支持 `LOGIN`、`SELECT`、`UID SEARCH UNSEEN`、`UID FETCH <uid> (BODY.PEEK[])`、字面量 `{n}` 读取、IDLE 不要求（轮询即可）。
- 支持 UTF-7 邮箱名、GBK/GB18030 正文（`new TextDecoder('gbk')`）、base64 / quoted-printable、multipart 递归取 `text/plain`，取不到再用 `text/html` 去标签。
- `code-extract.js`：从主题+正文抽验证码。规则：优先"验证码/校验码/动态码/verification code"附近 4~8 位数字；排除手机号（11 位）、金额、日期；返回 `{code, context}`。
- 配置：`{enabled, host, port:993, user, pass, folder:'INBOX', pollSec:60}`。`pass` 由宿主用 `safeStorage` 加密存储，**模块只拿到明文一份，不落盘不打日志**。
- 基线：首次启动只记 uid 基线不弹历史邮件。
- **验收**：自带 `node:net` 假 IMAP 服务端（回 `* OK` / `A1 OK` 等真实报文，含一条 base64+GBK 的验证码邮件），断言：登录→搜索→抓取→解码→抽出 `123456`。贴真实输出。

### 4.5 `app/infohub/sources/balance.js` —— AI 额度
- 适配器：
  - `deepseek`：`GET https://api.deepseek.com/user/balance`（`Authorization: Bearer <key>`）→ `balance_infos[].total_balance` + `currency`。
  - `puretokens`：`GET https://console.puretokensx.com/api/product/console/api-keys/usage`（Bearer，key 无 `sk-` 前缀时内存里补）→ 取 `total_available`；再 `GET .../status`（不带 key）取 `quota_per_unit` 换算金额。**不要**用旧 billing 接口或 `100000000` 占位。
  - `openai_billing`：`GET {base_url}/dashboard/billing/credit_grants`（可选，失败静默）。
- 配置形态：`{enabled, accounts:[{id,label,type,base_url,keyEnv,key}]}`；`keyEnv` 优先取环境变量，其次 `key`。
- 首次启动自动从 `%LOCALAPPDATA%\hermes\config.yaml` **尽力**抽取（正则可，别写 YAML 解析器）：只要 provider 名、`base_url`、`key_env`；抽不到就空着，用户手填。
- 轮询 10 分钟；`snapshot('balance', {items:[{id,label,amount,currency,detail,ok,error}]})`；任一账户 `amount < cfg.warnBelow`（默认 1）→ `emit` 一条 `level:'warn'` 的 `balance` 事件（同 key 6 小时只弹一次）。
- **验收**：用本机真实 key 跑一次 DeepSeek（若 config/env 里有），贴真实返回的金额；其余账户用本地假 http 服务断言解析。

### 4.6 `app/infohub/sources/weather.js` —— 天气
- `https://ipwho.is/` 取大致城市（失败退 `https://freeipapi.com/api/json`）；`https://api.open-meteo.com/v1/forecast` 取实况+7 日（`current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature,wind_speed_10m` + `daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`）。
- 中文城市名支持：`cfg.city` 填了就 `https://geocoding-api.open-meteo.com/v1/search?name=<city>&language=zh`。
- 15 分钟刷新，30 秒内重复请求直接返回缓存。WMO code → 中文现象（自建映射表，零依赖）。
- **验收**：真实调通并贴出返回的城市/温度。

### 4.7 `app/infohub/sources/reminders.js` —— 待办 / 专注 / 喝水
- 数据存 `ctx.dataDir/infohub-reminders.json`（原子写：写 `.tmp` 再 rename）。
- 待办：`{id, text, repeat:'none'|'daily'|'weekly', weekday?[], at:'HH:mm', doneUntil}`；到点 `emit` `reminder`，重复项自动滚到下一次。
- 专注：`start(minutes)` / `stop()` / `status()`；结束 `emit`。
- 喝水：`{goalMl, cupMl, everyMin, from, to, today:[]}`，累计与撤销。
- 对外 API 除统一接口外额外导出：`addTodo/removeTodo/toggleTodo/focusStart/focusStop/waterAdd/waterUndo/getState`（挂到实例上，宿主直接调）。
- **验收**：断言"到点触发一次且只一次"、"重复待办滚动到明天"、"喝水累计+撤销"。

### 4.8 `app/infohub/sources/calendar.js` —— 飞书日历
- `lark-cli calendar +agenda`（先真跑摸清输出），10 分钟刷新，`snapshot('calendar', {today:[{time,title}], updatedAt})`。
- 失败静默 + `status()` 体现原因（未登录/网络）。
- **验收**：贴真实命令输出（脱敏）与解析断言。

## 5. 交付要求

每个模块目录下留一份 `README.md`：能干什么、怎么配、实测结论（真跑出来的）、已知限制。
最后的回答里必须包含：**改了哪些文件**、**测试命令 + 真实输出摘要**、**没做成的部分和原因**。
