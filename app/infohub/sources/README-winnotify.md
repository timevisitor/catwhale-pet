# winnotify —— Windows 通知中心统一消息源（微信 / QQ / 飞书 / 钉钉 / 企业微信）

`app/infohub/sources/winnotify.js` + `app/infohub/sources/winnotify_probe.ps1` · 默认**关闭**（`enabled:false`）

## 为什么是它

NapCat / OneBot 这类第三方协议客户端要登录协议号，有封号风险，已弃用。
本模块只做一件事：**用 Windows 官方 API 读系统已经画出来的通知卡片**
（`Windows.UI.Notifications.Management.UserNotificationListener`）。
不注入进程、不碰协议、不读本地数据库、不登录任何账号 —— 零封号风险，代价是
只能拿到通知中心里还在的那几条，且受应用自身是否推送 toast 的限制。

`wechat.js` / `wechat_probe.ps1` 已移到 `optional/`（微信专用旧版，不装载），本模块是它的泛化版。

## 各应用的 toast 文本结构（解析依据）

同一套 `title+body` 糊在一起不行，微信 4.x 的 toast 是三段：

| 应用 | 文本结构 | 解析结果 |
|---|---|---|
| 微信 4.x | `texts[0]`=应用名「微信」、`texts[1]`=会话名、`texts[2]`=`发送者 : 正文` | `title=微信 · 会话名`，`body=发送者 : 正文` |
| 微信（两段式/私聊） | `texts[0]`=会话名、`texts[1]`=正文 | 同上（自动识别是否有应用名段） |
| 微信（只有一段） | 拿不到会话名 | `title=微信 · 微信`，`body`=整段 |
| QQ / 飞书 / 钉钉 / 企业微信 | `texts[0]`=第一行（会话名），其余是正文 | `body`=其余，多段用 ` / ` 连接 |

微信三段式来源：**PepsiColaya/wechat-notifier README**。
旧版 `wechat_probe.ps1` 把 `texts[1..]` 用 `' / '` 拼成 body，微信会被拼成
「群名 / 发送者 : 正文」，会话名和正文分不开，所以泛化版探针改为返回**原始
`texts[]` 数组**，解析全部放在 JS 里按应用分支做。

应用识别按「应用显示名 + AUMID」匹配，**企业微信排在微信前面**（否则
`企业微信` 会被 `/微信/` 抢走）；QQ 的 aumid 就是 `QQ`（本机实测）。

## 为什么是轮询，不是事件订阅

`UserNotificationListener.NotificationChanged` 事件订阅在**未打包（非 MSIX）**
应用上注册会失败 —— HaloPixelToolBox 实测报 `80070490`（Element not found）。
所以本模块不订阅事件，改轮询；主流开源项目轮询间隔 500~1000ms，
这里默认 **800ms**（`pollMs` 可调）。

实现上用的是「上一轮跑完再排下一轮」的链式 `setTimeout`，不是 `setInterval`：
单次探针本身约 0.9~1.1s（PowerShell 启动 + WinRT 初始化），
若用 800ms 的 `setInterval` 会不断堆积 PowerShell 进程。实际节奏 ≈
`max(pollMs, 探针耗时)`。定时器全部 `unref()`，`stop()` 里清干净。

## 配置

```json
{
  "winnotify": {
    "enabled": false,
    "pollMs": 800,
    "mergeMs": 10000,
    "apps": { "wechat": true, "qq": true, "feishu": true, "dingtalk": false, "wecom": false }
  }
}
```

- `apps.*` 按应用独立开关；关掉的应用**仍然记 id**，重新打开不会补弹历史。
- `mergeMs` 同会话合并窗口，默认 10000ms。
- `status()` 里每个应用一条独立明细：`{_label, enabled, hits, emitted, merged, detail}`。

## 事件

```js
{
  source: 'winnotify', kind: 'message', level: 'info' | 'warn',
  title: '微信 · 产品讨论组',
  body:  '张三 : 晚上八点开会，记得带原型图',   // 超 90 字截断加 …
  key:   'winnotify:m:wechat:<aumid>:<通知id>',
  actions: [
    { id: 'copy', label: '复制', kind: 'copy', payload: <正文> },
    { id: 'open', label: '打开微信', kind: 'app', payload: 'wechat' }   // qq / lark / dingtalk / wecom
  ],
  data: { app, appId, aumid, notificationId, chatName, texts, via: 'windows-notification-center' }
}
```

- 正文含 `@我 / @所有人 / @全体成员` → `level:'warn'`。
- **首轮只建基线**：启动后第一次探测把通知中心里现有的 id 全记下，不弹历史。
- 去重：按通知 id（AUMID + id），同一条永远只弹一次。
- 合并：同应用 + 同会话名，10 秒窗口内只弹第一条，后续计入 `merged`，不重复打扰。
- 打开按钮的 payload：QQ→`qq`、飞书→`lark`、钉钉→`dingtalk`、微信→`wechat`、
  企业微信→`wecom`（**宿主 `index.js` 的 openApp 映射目前没有 `wecom`**，
  需主会话加一条 `wecom: 'WeCom'` 才能唤起企微；企微默认关闭，不影响现状）。

## 探针（`winnotify_probe.ps1`）

与 `wechat_probe.ps1` 同源，改动：不按「微信」过滤、多返回原始 `texts[]`、
UIA 兜底不再只看含「微信」的节点。

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File app\infohub\sources\winnotify_probe.ps1 -OutFile out.json
powershell ... -File winnotify_probe.ps1 -Engine uia
powershell ... -File winnotify_probe.ps1 -RequestAccess     :: 系统没授权时弹一次授权框
```

> `.ps1` 必须存成 **UTF-8 带 BOM**。PowerShell 5.1 会按 ANSI(GBK) 读无 BOM 文件，
> 中文注释直接语法报错。输出走 `-OutFile` + UTF-8 写盘再由 Node 读，
> 避免控制台代码页把中文搞乱。

`--probe` 命令行（`node app/infohub/sources/winnotify.js --probe`）输出：
各应用命中数 + 样本 + `access` 状态。可选 `--engine winrt|uia`、`--request-access`、`--verbose`。

## 实测输出（真跑，2026-11-25，未做任何修改）

```
$ node app/infohub/sources/winnotify.js --probe
{
  "ok": true,
  "detail": "WinRT 可用（access=Allowed），通知中心 20 条；企业微信 0 / 微信 0 / 钉钉 0 / 飞书 0 / QQ 15；其它应用 5 条",
  "access": "Allowed",
  "engine": "winrt",
  "count": 20,
  "apps": {
    "wecom": { "label": "企业微信", "enabled": false, "hits": 0, "sample": [] },
    "wechat": { "label": "微信", "enabled": true, "hits": 0, "sample": [] },
    "dingtalk": { "label": "钉钉", "enabled": false, "hits": 0, "sample": [] },
    "feishu": { "label": "飞书", "enabled": true, "hits": 0, "sample": [] },
    "qq": {
      "label": "QQ",
      "enabled": true,
      "hits": 15,
      "sample": [
        {
          "app": "QQ", "aumid": "QQ", "notificationId": "19680",
          "texts": [
            "卡米莉娅的舰长通知群",
            "[@全体成员] 梦幻：[图片]卡米莉娅睡不醒ovo 下播啦，本次直播了 2小时30分48秒 https://live.bilibili.com/31347839"
          ],
          "chatName": "卡米莉娅的舰长通知群",
          "body": "[@全体成员] 梦幻：[图片]卡米莉娅睡不醒ovo 下播啦，本次直播了 2小时30分48秒 https://live.…",
          "creation": "2026-11-22T11:11:04.1817741+08:00"
        },
        {
          "app": "QQ", "aumid": "QQ", "notificationId": "19862",
          "texts": [
            "解构原典（？）交流群",
            "[@全体成员] 五月不蓝：@全体成员 我们在noob2的内测页做了类似NAI的体力条设定，方便大家使用，具体来说，是加了一个指示标，说明目前用户的繁忙程度，同时，调度队列会有优先和普通，按照使用的GPU时来计算个人在整个队列中的位置的，在一定时间内，一个人使用的GPU时越多，他排队的速度就越[图片]"
          ],
          "chatName": "解构原典（？）交流群",
          "body": "[@全体成员] 五月不蓝：@全体成员 我们在noob2的内测页做了类似NAI的体力条设定，方便大家使用，具体来说，是加…",
          "creation": "2026-11-23T15:42:40.9798173+08:00"
        },
        {
          "app": "QQ", "aumid": "QQ", "notificationId": "19890",
          "texts": [
            "新邮件来自 CHITUBOX <marketing@chitubox.com>",
            "Black Friday Deals: Save Big & Win Big! ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌"
          ],
          "chatName": "新邮件来自 CHITUBOX <marketing@chitubox.com>",
          "body": "Black Friday Deals: Save Big & Win Big! ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌ ͏ ‌…",
          "creation": "2026-11-23T22:15:14.6472567+08:00"
        }
      ]
    }
  },
  "unknown": {
    "hits": 5,
    "sample": [
      { "app": "Intel Driver & Support Assistant", "aumid": "Intel.Dsa.Tray",
        "texts": ["可用更新", "• Intel® 11th – 14th Gen Proc..."] }
    ]
  },
  "elapsedMs": 1125,
  "ps1": "<仓库根>\\app\\infohub\\sources\\winnotify_probe.ps1"
}
```

（上面 `sample` 为节选，原输出 `unknown` 有 3 条样本、每个应用最多 3 条；`hits`/`count`/`detail`/`elapsedMs` 是原样。）

同一次探测的原始条目分布（`winnotify_probe.ps1` 直出，20 条）：

```
总数 20 access Allowed engine winrt
 15 QQ | QQ
  3 Intel Driver & Support Assistant | Intel.Dsa.Tray
  1 Electron | com.nousresearch.hermes
  1 截图工具 | Microsoft.ScreenSketch_8wekyb3d8bbwe!App
```

> 通知中心是活数据：本轮连续两次真跑分别看到 **19 条**和 **20 条**，中间
> 新到了一条 Hermes 自己的 Electron 通知 —— 数字差 1 是正常的，不是脚本不稳定。

**结论：本机通知中心里有 QQ（15 条），没有微信、飞书、钉钉、企业微信。**
微信 0 条不是脚本读不到，而是**微信自己没往通知中心推**：本机微信是 4.x 新客户端
（`D:\Program Files\Tencent\Weixin\Weixin.exe`，主窗口类名 `mmui::MainWindow`），
不是 MSIX 包，`HKCU\...\Notifications\Settings` 下查不到任何 `WeChat|Weixin|Tencent`
子键 —— 没注册 AUMID 就不能推 toast。微信 3.x 的包版本
（AUMID `TencentWeChatLimited.forWindows10_sdtnhv12zgd7a!App`）才有。
所以微信能否收到，取决于你装的是哪个版本 + 客户端里是否开了「系统通知」。

`start()` 的真实状态行（2026-11-25 真跑）：

```
[log] 建立基线：通知中心 20 条（QQ 15），历史条目不弹
start → {"ok":true,"detail":"运行中（WinRT）· 通知中心 20 条 · 微信 0 / 飞书 0 / QQ 15"}
首轮弹窗数 = 0 （历史不补发）
```

## 测试

```
$ node tests/infohub/winnotify.test.js
```

24 项全绿：应用识别（企业微信不被微信抢）、微信三段式/两段式/单段、QQ、飞书、
老格式回退、正文 90 字截断、@提醒→warn、首轮基线不弹、按 id 去重、应用开关过滤、
关掉的应用重新打开不补历史、同会话合并（3 条→1 条、merged=2）、不同会话不合并、
`mergeMs:0` 时逐条弹、探针失败不抛、`status()` 五应用明细、`probe()` 命中数与样本，
最后在 Windows 上真跑一次脚本并打印本机结论（不因权限失败而红）。

## 接入方式

主会话（不是本模块）需要把 `app/infohub/index.js` 的 `SOURCE_LIST` 里
`['wechat','./sources/wechat.js']` 与 `['napcat','./sources/napcat.js']`（现均已移到 `optional/`）换成
`['winnotify','./sources/winnotify.js']`，并在 `openApp` 的映射里补
`wecom: 'WeCom'`。本模块自身**不改** `index.js` / `main.js` / `preload.js` / `web/**`。

## 已知限制

- 只能看到**当前还在通知中心里**的条目：用户点掉、通知过期（默认几小时）就没了；
  靠 800ms 轮询抢在过期前读到，关着桌宠期间的消息会漏（除非还在面板里）。
- 微信 4.x 不注册 toast AUMID（见上），大概率 0 条；3.x 包版本才有。
- toast 文案由应用决定，可能是「3 条新消息」这类聚合文案，拿不到逐条内容。
- 每轮起一个 PowerShell（本机约 1.0~1.1s），CPU 不高但不是零成本；
  嫌费把 `pollMs` 调到 1500~2000。
- UIA 兜底在本机不可用（Win11 通知中心面板不是 `RootElement` 的顶层子窗口），
  且就算扫到也拿不到应用归属，只能当最后手段。
- 需要「通知访问」权限（`GetAccessStatus() = Allowed`）。若是 `Denied`，
  去 `设置 → 系统 → 通知 → 允许通知访问` 打开，或用 `--request-access` 触发授权框。
- 非 Windows 平台 `start()` 直接返回失败并写清原因。
