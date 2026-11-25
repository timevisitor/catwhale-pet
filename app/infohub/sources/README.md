# infohub 数据源（sources/）

每个源一个文件，统一由 `app/infohub/index.js` 装载，接口见 `docs/infohub-contract.md` §1。
本文件按模块分节记录：能干什么、怎么配、实测结论、已知限制。**只写模型本身实测跑出来的数字**。

---

## balance —— AI 额度

文件：`balance.js`　测试：`node tests/infohub/balance.test.js`（26 条断言，零依赖）

### 能干什么

轮询各家的余额/额度，汇总成面板快照；余额低于阈值时弹一次提醒。

| 适配器 | 请求 | 解析 |
| --- | --- | --- |
| `deepseek` | `GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>` | `balance_infos[].total_balance` + `currency`（多币种优先 CNY） |
| `puretokens` | `GET https://console.puretokensx.com/api/product/console/api-keys/usage`（Bearer）<br>`GET https://console.puretokensx.com/api/product/console/status`（不带 key） | `total_available` ÷ `quota_per_unit` = 金额，币种取 `quota_display_type` |
| `openai_billing` | `GET {base_url}/dashboard/billing/credit_grants`（Bearer） | `total_available`，没有则 `total_granted - total_used`；失败静默 |

行为约定：

- 轮询 **10 分钟**（定时器 `unref()`，`stop()` 清干净并中断在途请求）；`start()` 时先跑一轮。
- 每轮 `ctx.snapshot('balance', { items, updatedAt })`，`items[]` 字段：
  `{ id, label, type, ok, amount, currency, detail, error? }`。
- 账户 `amount < warnBelow`（默认 **1**）→ `ctx.emit({ kind:'balance', level:'warn', key:'balance:warn:<id>' })`；
  **同一账户 6 小时只弹一次**，冷却时间戳落在 `ctx.dataDir/infohub-balance-warn.json`（原子写），重启不重置。
- 单请求 **15s 超时**；任何异常都收敛成 `ok:false` + 中文 `detail`，不抛顶层。
- 日志只出现 `前 4 位…(长度)`，事件 `data`、快照里都没有密钥。

### 怎么配

```js
// infohub 配置里 balance 段
{
  enabled: true,          // false 时 start() 不联网（仍可手动 refresh；账户抽取照做）
  warnBelow: 1,           // 低于这个金额弹提醒
  timeoutMs: 15000,       // 可选，单请求超时；默认 15000，测试里调小用
  accounts: [
    {
      id: 'ds',                        // 唯一 id，也是告警冷却键
      label: 'DeepSeek',
      type: 'deepseek',                // deepseek | puretokens | openai_billing
      base_url: 'https://api.deepseek.com',   // 可留空用默认；末尾 /v1 会被剥掉
      keyEnv: 'DEEPSEEK_API_KEY',      // 优先读 process.env[keyEnv]
      key: ''                          // 兜底明文；有 keyEnv 时不用它
    }
  ]
}
```

- `keyEnv` 优先于 `key`；两者都没有时按类型回落到默认环境变量
  （`DEEPSEEK_API_KEY` / `PURE_TOKENS_API_KEY` / `OPENAI_API_KEY`）。
- **`key` 只用于用户手填**。`config.yaml` 里的 `api_key` 一律不采用：那里可能是脱敏占位
  （`sk-abc…xyz`、`«redacted:sk-…»`、`***`），这类值会被 `isUsableKey()` 直接判死。
- puretokens 的 key 若没有 `sk-` 前缀，**只在内存里补一次**再发请求，绝不回写配置。
- puretokens 必须打 `console.puretokensx.com`（不是 `api.puretokensx.com`，后者没有 console 接口）。

### 首次启动自动抽取

`start()` 若发现 `accounts` 为空且没抽过（`bootstrapped !== true`），会（**即使当前 enabled 为 false 也照做**，
这样用户打开开关立刻有数据）：

1. 读 `ctx.paths.hermesHome || %LOCALAPPDATA%\hermes` 下的 `config.yaml`，用**正则**扫 `providers:` 段，
   只认 **provider 名 / name / base_url / key_env**（不写 YAML 解析器，不碰 `api_key`）；
2. 名字或 base_url 含 `deepseek` → deepseek 账户；含 `puretokens` / `pure tokens` → puretokens 账户
   （base_url 自动纠正到 console 域）；同类型同 host 去重，只留一个；
3. 环境变量兜底：config.yaml 里没有该 provider，但 `DEEPSEEK_API_KEY` / `PURE_TOKENS_API_KEY` 有可用值时补一个账户；
4. 结果通过 `ctx.setCfg({ accounts, bootstrapped: true })` 写回。抽不到就留空，用户在设置页手填。

`openai_billing` 不做自动抽取（必须有 `base_url`）。

### 实测结论（2026-11-25，本机真实 key）

`DEEPSEEK_API_KEY`、`PURE_TOKENS_API_KEY` 在 `%LOCALAPPDATA%\hermes\.env` 里，本机 `process.env` 默认没有。

```
$ node "<本地脚本目录>/verify-real.js"

=== 密钥可用性（只报长度）===
  DEEPSEEK_API_KEY：已就绪，长度 35，sk-8…(35)
  PURE_TOKENS_API_KEY：已就绪，长度 51，sk-r…(51)
  OPENAI_API_KEY：未找到

=== 从真实 config.yaml 抽取 ===
  [log] 首次启动从 hermes config.yaml 抽取到 2 个额度账户：puretokens-claude(puretokens), deepseek(deepseek)

=== 真实接口 refresh() ===
  [log] 查询 puretokens-claude（puretokens），密钥 sk-r…(51) 来源 env:PURE_TOKENS_API_KEY
  [log] 查询 deepseek（deepseek），密钥 sk-8…(35) 来源 env:DEEPSEEK_API_KEY
  [log] 额度刷新完成：2/2 成功
  OK   puretokens-claude (puretokens)：-64.551836 USD / 不限额度（账面 $-64.55，-32275918 / 500000） · Pure GPT
  OK   deepseek (deepseek)：172.51 CNY / 可用 ¥172.51（充值 ¥115.29 / 赠送 ¥57.22）
  status(): {"ready":true,"detail":"2/2 个账户有数据（09:33 更新）"}
```

（DeepSeek 余额在两次验证之间从 173.33 → 172.87 → 172.51 变化，就是这台机器上正在消耗的真实扣费，
说明取到的是实时值而不是缓存。）

真实返回原文（已脱敏，仅摘字段）：

```json
// GET https://api.deepseek.com/user/balance  → HTTP 200
{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"172.51",
 "granted_balance":"57.22","topped_up_balance":"115.29"}]}

// GET https://console.puretokensx.com/api/product/console/api-keys/usage → HTTP 200
{"code":true,"data":{"total_available":-32275918,"total_used":32275918,
 "unlimited_quota":true,"money":{"remaining":-64.551836,"used":64.551836,"currency":"USD"}}}

// GET https://console.puretokensx.com/api/product/console/status → HTTP 200（不带 key）
{"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"USD"}}
```

结论：`-32275918 / 500000 = -64.551836`，与接口自带的 `money.remaining` 完全一致，换算公式确认无误。
`openai_billing` 本机没有 `OPENAI_API_KEY`，**未做真实调用**，只用本地假服务断言了解析与失败静默。

### 已知限制

- **`unlimited_quota: true` 的 key 不报警**。Pure Tokens 这种 key 的账面 `total_available` 可能是负数
  （本机 -32275918，即 $-64.55），但按套餐不限额度，报警只会是噪音。这类账户 `detail` 写「不限额度」，
  内部 `warnable=false`，跳过阈值判断。如果你希望负数也提醒，需要改 `parsePuretokensUsage` 里的 `warnable`。
- `quota_per_unit` 拿不到时退用返回体里的 `money.remaining`；两者都没有则该账户 `ok:false`。
- 直接连网，不读 `HTTP_PROXY`/`HTTPS_PROXY`（`node:https` 本身不认），要走代理得给 `base_url` 指本地代理。
- 告警冷却按 `id` 记，改了 id 等于重置冷却；`dataDir` 为空（测试环境）时不落盘，只内存去重。
- 首次抽取只跑一次（`bootstrapped` 标记）；之后用户在设置里清空账户不会被自动填回来。
- 抽 `providers:` 依赖「两空格缩进的 provider、四空格缩进的直接子键」这套缩进约定；config.yaml 换风格会抽不到（不影响手填）。

---

## mail —— 邮箱验证码

文件：`mail.js`（配 `../lib/imap-lite.js` / `../lib/mail-parse.js` / `../lib/code-extract.js`）
测试：`node tests/infohub/mail.test.js`（10 个用例，自带假 IMAP 服务端，零依赖）

### 能干什么

轮询 IMAP 邮箱的未读邮件，命中「验证码」类关键词就抽 4~8 位数字，弹一条 `kind:'mail'` 事件，
验证码放 `data.code`，`actions` 里带「复制验证码」；同时 `snapshot('mail', { list })` 给面板。
首次启动**只建 UID 基线**，历史未读一封都不弹；取正文用 `BODY.PEEK[]`，不会把用户的未读改成已读。

### 怎么配

```js
// infohub 配置里 mail 段；pass 由宿主用 safeStorage 加密存，模块只拿明文一份
{
  enabled: true,
  host: 'imap.qq.com',
  port: 993,
  user: '123456789@qq.com',
  pass: 'xxxxxxxxxxxxxxxx',   // IMAP 授权码，不是登录密码
  folder: 'INBOX',            // 中文邮箱名也行（内部转修改版 UTF-7 再上线）
  pollSec: 60,                // 最小 15 秒
  timeoutMs: 15000,           // 可选：单命令超时
  secure: null                // 可选：null=按端口判断（143 明文，其余隐含 TLS）
}
```

| 邮箱 | host:port | 授权码怎么拿 |
| --- | --- | --- |
| QQ 邮箱 | `imap.qq.com:993` | 网页版 → 设置 → 账号 → 开启 IMAP 服务 → 生成授权码（16 位） |
| 163 / 126 | `imap.163.com:993` | 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP → 设客户端授权密码 |
| Gmail | `imap.gmail.com:993` | 开启两步验证后生成「应用专用密码」 |
| Outlook / M365 | `outlook.office365.com:993` | 账户安全 → 应用密码（组织策略可能直接禁 IMAP） |

### 实测结论（2026-11-25，本地假 IMAP 服务端）

**没有实连真实邮箱**（手上没有授权码，见限制第 1 条）。协议正确性用 `node:net` 手写的假服务端证明：
它按真实报文回话（`* OK` 问候 / `* 2 EXISTS` / `* OK [UIDNEXT 103]` / `* SEARCH 101 102` /
`* 2 FETCH (UID 102 ... BODY[] {1036}\r\n<原始字节>)` / `A5 OK ...`），并把 FETCH 响应
**拆成三段 TCP 写入**，逼客户端处理半包与字面量。

```
$ node tests/infohub/mail.test.js
[MIME] 主题=【QQ邮箱】登录验证码 发件人=QQ邮箱安全中心 验证码=123456
  验证码抽取 14 条用例全部通过
ok 1 - MIME：multipart + base64 + GBK 正文与 GBK 主题都能解对
ok 2 - 字面量边界：正文里嵌伪造的 IMAP 响应也必须按长度原样取回
ok 3 - MIME：quoted-printable + UTF-8 + 折行 RFC2047（B 与 Q 混用）
ok 4 - 验证码抽取：关键词优先，排除手机号/金额/日期/订单号
  [全链路] caps=IMAP4rev1,UIDPLUS uids=[101,102] 主题=【QQ邮箱】登录验证码 验证码=123456 原文=1036 字节
ok 5 - IMAP 全链路：CAPABILITY → LOGIN → SELECT → UID SEARCH → UID FETCH → 解码
  [source] 基线=101 事件={"title":"邮件 · QQ邮箱安全中心","body":"验证码 123456｜【QQ邮箱】登录验证码","code":"123456","key":"mail:127.0.0.1:102"}
ok 6 - source 端到端：首次只建基线不弹历史，新邮件 emit + snapshot
  [错误路径] status.detail=连接失败：IMAP 命令失败（LOGIN）：NO [AUTHENTICATIONFAILED] 认证失败
ok 7 - 密码错误：不抛顶层，状态报错且日志脱敏
  [超时] 300ms 内正确报超时
ok 8 - 服务器不回话：连接阶段超时，错误可捕获
ok 9 - 非 ASCII 凭据走字面量 LOGIN（{n} 续行）
ok 10 - 脱敏与 UTF-7 编码
# tests 10  # pass 10  # fail 0  # duration_ms ≈ 353
```

那封验证码邮件是**真 GBK 字节**（测试里用 `TextDecoder('gbk')` 建反查表造出来的编码器：
正文 base64+GBK、HTML 部分 quoted-printable+GBK、主题 `=?GBK?B?...?=`），抽出的就是 `123456`；
同一封正文里还塞了「客服电话 400-670-0700」「订单号 202611250001234567」，都没被误当成验证码。
`# pass 10` 连跑两次稳定复现。

行为约定：

- 轮询 `pollSec`（下限 15s / 默认 60s），定时器 `unref()`，`stop()` 清定时器并立刻断开在途连接。
- 首轮只做 `SELECT + UID SEARCH UNSEEN` 记基线（`UIDNEXT - 1`），跳过的 uid 全部进 `seen`。
- 之后只处理 `uid > 基线 && 未见过` 的邮件，单轮最多抓 5 封；单封失败重试 3 次后放弃（日志留痕）。
- `emit` 的 `level`：抽到验证码 `warn`，否则 `info`；`key = mail:<host>:<uid>` 保证同一封只弹一次。
- 任何异常都收敛成 `status().detail` 里的中文原因（不抛顶层）；授权码在日志/状态里只出现 `前2位…长度`。

### 实现要点（改代码前先看）

- `lib/imap-lite.js`：**逻辑行 = 文本片段 + 字面量**。读到行尾 `{n}` 就精确读 n 字节存进 `literals`，
  文本里留占位继续读同一逻辑行的剩余部分——正文里就算出现 `)\r\nA9 OK FETCH completed` 这种伪造响应
  也不会被截断（测试 2 专治这个）。只有 `<tag> OK/NO/BAD` 结束命令，`*` 开头的行全收进 `lines`。
- 文本行解码先试严格 UTF-8、失败退 latin1，所以服务器回中文状态文本时错误信息不会是乱码。
- 建连与每条命令各 15s 超时（`timeoutMs` 可调）；`close()` 会把在途读取立刻打醒。
- `lib/mail-parse.js`：按声明 charset 严格解码（`TextDecoder(..., {fatal:true})`），失败退
  utf-8 → gb18030 → 宽松 utf-8 → latin1，永不抛；base64 / QP 都**先解成字节再按 charset 解**，
  否则 GBK 双字节会被 QP 软换行拆坏。
- `lib/code-extract.js`：强关键词 60 字内优先、距离越近分越高、关键词在数字前面再加分；强关键词紧邻时
  跳过「账号/号码」类弱排除；金额（元/USD/%）、日期（2026-11-25、年月日）、订单/运单/发票/邮编、
  11 位手机号一律丢；长邮件没关键词就判无验证码（宁可不弹也不误弹）。

### 已知限制

1. **没有实连过真实邮箱**：没有 IMAP 授权码。协议正确性由假服务端证明；真连需要用户在设置里自己填
   授权码，然后先点「测试连接」（走 `probe()`：只登录 + SELECT，不抓正文）。
2. 只支持**隐含 TLS**（993 / 自定义端口）和明文 143，**不支持 STARTTLS**；163/126 部分账号要求先发
   `ID` 命令（否则回 `Unsafe Login`），本模块没发，遇到就换 QQ/Gmail。
3. 用 `UID SEARCH UNSEEN` 轮询，没有 IDLE；最坏要等一个轮询周期（默认 60s）。
4. 只解析 `text/plain` / `text/html` 正文，**不解析附件**，不递归 `message/rfc822`。
5. 只抽**纯数字** 4~8 位验证码；`A1B2C3` 这类字母数字混合的不抽。
6. 基线取 `UIDNEXT - 1`，个别服务器 `UIDNEXT` 不准时基线可能偏大/偏小。
7. `secure` 是按端口推的默认值（143 明文、其余 TLS），自建服务器端口特殊时要在配置里显式写 `secure`。

---

## weather —— 天气

文件：`weather.js`　测试：`node tests/infohub/weather.test.js`（8 个用例，4 条联网、4 条离线）

### 能干什么

定位 + 实况 + 7 日预报，压成 `ctx.snapshot('weather', { city, temp, text, days, updatedAt })`。

- 定位：`cfg.city`（中文名）→ Open-Meteo Geocoding（`language=zh`）；留空 → `https://ipwho.is/`，
  失败自动退 `https://freeipapi.com/api/json`。
- 预报：`https://api.open-meteo.com/v1/forecast`
  `current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature,wind_speed_10m`
  `daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`，`forecast_days=7`。
- WMO `weather_code` → 中文现象：模块内自建映射表（0/1/2/3、45/48、51/53/55、56/57、61/63/65、66/67、
  71/73/75/77、80/81/82、85/86、95/96/99），另配一份同表 emoji；表外代码显式回 `代码 N`，缺值回 `未知`。
- 快照字段：`{ city, lat, lon, temp, text, icon, code, feels, humidity, wind, days[], placeSource, updatedAt }`，
  `days[i] = { date, week, max, min, pop, code, text, icon }`。

行为约定：

- **15 分钟**刷新（`refreshMin` 可覆盖），定时器 `unref()`，`stop()` 清干净；`start()` 先同步跑一轮。
- **30 秒内**重复 `refresh()` 直接回内存缓存，返回 `{ ok:true, cached:true }`，不打网。
- 单次 HTTP ≤ 15s（每次尝试 7s，一轮总预算 14s）；失败只写 `status().detail`，有旧数据就继续用旧的，不抛顶层。
- 定位结果内存缓存 6 小时，避免每分钟都打 geocoding。

### 怎么配

```js
{ enabled: true, city: '北京', refreshMin: 15 }   // city 留空 = IP 定位
```

面板「刷新」走缓存语义；`probe()` 是强制真打一次并返回 `城市 温度 现象（定位来源）`。

### 实测结论（2026-11-25 本机真实返回）

```
# cfg.city 留空 → IP 定位
[weather] 定位（IP）→ Danzhou 19.499,109.583
快照 {"city":"Danzhou","temp":18,"text":"阴","icon":"☁️","feels":18,"humidity":82,"wind":15,"placeSource":"ipwho.is"}
七天 2026-11-25周三 17~19 小毛毛雨 | 26 17~22 阴 | 27 20~27 阵雨 | 28 19~24 小毛毛雨 | 29 19~25 小毛毛雨 | 30 21~28 小毛毛雨 | 12-01 22~29 小毛毛雨

# cfg.city = "北京" → 真走 geocoding（返回中文城市名）
[weather] 定位（配置城市）→ 北京 39.907,116.397
快照 {"city":"北京","temp":0,"text":"晴","feels":-3,"humidity":45,"placeSource":"geocoding"}
七天 -2~7 多云 | 0~11 阴 | 4~10 多云 | 0~10 多云 | 0~7 阴 | -1~12 阴 | 3~13 阴
probe(): {"ok":true,"detail":"北京 0°C 晴（geocoding）"}

# cfg.city = "上海"
实测：上海 31.222,121.458 9°C 晴
```

（IP 定位在两次验证之间出现过 `Danzhou` 与 `Singapore`：本机出口是移动网络/代理，
IP 归属地会变，属正常；要稳定就填 `cfg.city`。）

### 已知限制

- **必须处理代理**：本机出网走 `https_proxy=http://127.0.0.1:17891`，Node 原生 `fetch` 不读环境变量代理，
  直连 `api.open-meteo.com` 会被断开。模块自带最小代理隧道（`CONNECT` + `node:tls` + 手写 chunked 解码）：
  有代理变量就先走代理、失败再直连；没有代理变量的机器就是普通直连。**`socks5://` 不支持**（忽略，退直连）。
- IP 定位只到城市级；跨境出口会定位到境外城市。
- 温度取整；`pop` 是当日最大降水概率，可能为 `null`；不做逐小时、空气质量、灾害预警。
- 只认 Open-Meteo，换源要改 `buildUrl/shape`（都在单文件里，`_shape` 已抽成纯函数方便断言）。

---

## reminders —— 待办 / 专注 / 喝水

文件：`reminders.js`　测试：`node tests/infohub/reminders.test.js`（10 个用例，自带可变时钟，零依赖）

### 能干什么

- 待办：`none`（单次）/ `daily` / `weekly`（指定星期）+ `HH:mm`；到点 `ctx.emit({kind:'reminder'})`，
  重复项自动滚到下一次，单次项触发后标完成。
- 专注：`focusStart(minutes)` / `focusStop()` / `status()`；到点弹一条 `reminder`，手动中止返回已用分钟。
- 喝水：目标量 / 单杯量 / 提醒间隔 / 生效时段（支持 `from > to` 的跨夜时段），累计与撤销，喝够目标自动静音。
- 数据落 `ctx.dataDir/infohub-reminders.json`，**原子写**：写 `.tmp` → `fs.renameSync` 覆盖。
  文件损坏时备份成 `infohub-reminders.json.corrupt-<时间戳>` 再按默认值重建，不崩。
- 额外 API（宿主 `doAction` 已按这些名字接好）：`addTodo / removeTodo / toggleTodo / focusStart /
  focusStop / waterAdd / waterUndo / getState`。

### 数据结构

```json
{
  "version": 1,
  "todos": [{"id":"td_…","text":"交周报","repeat":"daily","weekdays":[1,3,5],"at":"18:00",
             "done":false,"doneUntil":0,"dueAt":1795…,"lastFiredKey":"rem:todo:td_…:1795…"}],
  "focus": {"active":false,"minutes":25,"startedAt":0,"endsAt":0,"endedAt":0},
  "water": {"goalMl":2000,"cupMl":250,"everyMin":60,"from":"09:00","to":"21:00",
            "today":[{"ts":1795…,"ml":250}],"day":"2026-11-25","nextAt":0},
  "savedAt": 1795…
}
```

- `dueAt` = 下一次触发的毫秒时间戳；`doneUntil` = 已推进到哪一刻（完成/上次触发时刻）。
- 单次待办的 `at` 今天已过 → 排到明天同一时刻（不会创建完立刻炸一条）。
- `lastFiredKey` 跟数据一起落盘，**重启后同一 occurrence 不会补弹**。

### 怎么配

```js
{ enabled: true,
  water: { goalMl: 2000, cupMl: 250, everyMin: 60, from: '09:00', to: '21:00' } }
```

面板动作名：`todoAdd / todoRemove / todoToggle / focusStart / focusStop / waterAdd / waterUndo / remindersState`。

### 实测结论

```
$ node tests/infohub/reminders.test.js
  ✓ 待办：到点只触发一次
  ✓ 待办：重复（每天）触发后滚到下次
  ✓ 待办：每周指定日只在指定星期触发
  ✓ 喝水：累计与撤销
  ✓ 喝水：到间隔会提醒，且同一槽不重复
  ✓ 专注：到点提醒一次
  ✓ 持久化：重启后状态保持（原子写落盘）
  ✓ 持久化：文件损坏能自愈
  ✓ 参数校验：非法时间/空文本被拒绝
  ✓ 接口完整性：契约要求的额外 API 都在实例上
reminders: 10 通过 / 0 失败 / 共 10
```

关键断言：08:59 建 `09:00` 单次待办 → 08:59:30 不弹、09:00:05 弹 1 条、继续 tick 到 09:01 仍只有 1 条；
`daily` 触发后 `dueAt` = 次日 09:00（`dueText` 显示「明天 09:00」），次日再弹并继续滚；
`weekly [1,3]` 周三触发后跳到下周一；喝水 250+250→撤销→250→再撤销→0，喝够 2000ml 后不再提醒；
同 `dataDir` 重建实例后待办文本/repeat/`dueAt`、喝水累计都保持且 `.tmp` 不残留；
坏 JSON 自愈（备份 `.corrupt-*`）；`H:mm` 被归一成 `09:05`，`25:99` 被拒。

### 已知限制

- 最小节拍 15 秒（待办粒度本来就是分钟），最长延迟约 15 秒。
- 喝水提醒重启后若 `nextAt` 已过期，会补弹一次，属预期。
- 只按本地时区算，不处理时区切换（中国无夏令时）。
- 弹的是主进程的小卡片，不做 Windows 系统通知、不响铃。
- `weekdays` 用 0=周日…6=周六；`weekly` 不填星期默认周一~周五。

---

## calendar —— 飞书日历

文件：`calendar.js`　测试：`node tests/infohub/calendar.test.js`（7 个用例，含一次真实调用）

### 能干什么

跑 `lark-cli calendar +agenda`，把当天日程压成 `ctx.snapshot('calendar', { today:[{time,title}], updatedAt })`。

- lark-cli 探测：`%LOCALAPPDATA%\hermes\node\lark-cli(.cmd)` → 环境变量 `LARK_CLI` → `PATH`。
- 10 分钟刷新（`refreshMin` 可覆盖）＋首刷延迟 1.5s（同步子进程，避免卡住窗口创建）。
- 失败**静默**：不 emit、不清空旧快照，只在 `status()` 给原因（未登录 / 缺权限 / 没装 / 超时）。
- `status:"cancelled"` 过滤；全天日程 `time:"全天"` 并排最前，其余按时间升序；标题截 40 字，最多 30 条。

### 真实命令（参数来自 `--help`，2026-11-25 实跑）

```
$ lark-cli calendar +agenda --help
Usage: lark-cli calendar +agenda [flags]
  --as string            identity type: user | bot
  --calendar-id string   calendar ID (default: primary)
  --end string           end time (ISO 8601, default: end of start day)
  --format string        output format: json (default) | pretty | table | ndjson | csv
  --start string         start time (ISO 8601, default: start of today)

# 模块实际执行的命令（日期用 YYYY-MM-DD，避免 cmd.exe 把带 '+' 的时区偏移吃掉）
lark-cli calendar +agenda --format json --start 2026-11-25 --end 2026-11-25
```

### 真实输出片段（脱敏，本机 2026-11-25 09:29 / 14:4x 两次一致）

```
[lark-cli] uat-client: refresh_token expired for ou_a9ad…, clearing
{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authentication",
    "subtype": "token_missing",
    "message": "need_user_authorization (user: ou_a9ad…)"
  }
}
```

即本机 **user 身份登录态已过期**（`lark-cli auth status` → `user: missing`，`bot: ready`）。
`--as bot` 则是应用没申请日历权限：

```
{"ok":false,"identity":"bot","error":{"type":"authorization","code":99991672,
 "message":"access denied: app cli_aa955… has not applied for the required scope(s):
 calendar:calendar:readonly, calendar:calendar, calendar:calendar.event:read"}}
```

所以本机现状是「**命令跑得通、数据拿不到**」：模块的 `status()` = `未登录飞书（登录态过期，跑 lark-cli auth login）`，
`probe()` = `{"ok":true,"detail":"身份 bot:ready / user:missing"}`，面板不受影响。
恢复办法：`lark-cli auth login --scope "calendar:calendar.event:read"`（需要用户本人授权）。

顺带一个实测坑：Windows 下经 `cmd.exe` 跑 `.cmd` 包装脚本时，**结果 JSON 整段落在了 stderr、stdout 为空**，
所以模块先解析 stdout，空了再解析 stderr（`extractJson` 还会跳过 `[lark-cli] …` 那行提示）。

### 解析断言（固定样本）

```
$ node tests/infohub/calendar.test.js
  ✓ 固定样本：排序、全天置顶、跳过已取消、HH:mm 正确
  ✓ JSON 前的提示行不影响解析（真机实测存在）
  ✓ 登录态过期 → 静默失败 + 人话原因
  ✓ 应用缺权限 → 原因点明权限
  ✓ 脏输入不抛异常
  ✓ maskId 脱敏 open_id / 邮箱
     lark-cli = C:\Users\…\AppData\Local\hermes\node\lark-cli.cmd
     真实结果：失败（符合预期，登录态问题）→ 未登录飞书（登录态过期，跑 lark-cli auth login）
  ✓ 本机真实跑一次 lark-cli calendar +agenda
calendar: 7 通过 / 0 失败 / 共 7
```

样本按真实结构构造（`data.items[]` + `start_time.{timestamp|date}`）：

```json
{"ok":true,"identity":"user","data":{"items":[
  {"event_id":"evt_9f2c1a","summary":"产品周会","status":"confirmed",
   "start_time":{"timestamp":"1795…","timezone":"Asia/Shanghai"}},
  {"event_id":"evt_早9","summary":"与客户对齐需求（腾讯会议）","status":"confirmed",
   "start_time":{"timestamp":"1795…","timezone":"Asia/Shanghai"}},
  {"event_id":"evt_全天","summary":"公司团建","status":"confirmed",
   "start_time":{"date":"2026-11-25","timezone":"UTC"}},
  {"event_id":"evt_取消","summary":"已取消的会","status":"cancelled","start_time":{"timestamp":"1795…"}}
]}}
```

断言结果 `["全天","09:00","14:30"]`（全天置顶 + 升序）、cancelled 被过滤、提示行不影响解析、
两种 `ok:false` 都翻成中文原因、空/脏输入不抛、`maskId` 不泄露完整 open_id。

### 已知限制

1. **本机拿不到真实日程**：user 登录态过期、bot 缺日历权限，两项都需要用户本人操作。解析正确性由固定样本保证。
2. 只取「当天」；跨天/周视图没做（`+agenda --start/--end` 支持，扩起来容易）。
3. 子进程是同步 `spawnSync`（20s 上限）：极慢的 CLI 会让主进程卡一下，这是已知代价。
4. 日程标题只进面板快照、不进日志（日志只记条数/失败原因）；`open_id` 在日志里走 `maskId`。

