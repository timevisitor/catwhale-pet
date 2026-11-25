# wechat —— 微信消息（Windows 通知中心，尽力而为）

`app/infohub/sources/wechat.js` + `app/infohub/sources/wechat_probe.ps1` · 默认**关闭**（`enabled:false`）

## 能干什么

Windows 上应用收到消息会往「通知中心」推一条 toast。本模块每 3 秒跑一次
`wechat_probe.ps1`，把通知中心里的条目读出来，过滤应用名 / AUMID 含
`微信|WeChat|Weixin` 的条目，按通知 id 去重后转成统一事件：

- `title` = `微信 · <toast 第一行，通常是联系人/群名>`
- `body` = 其余文本，超 90 字截断
- 首轮只建基线（历史通知不弹），之后只弹新出现的 id
- 拿不到就把原因写进 `status().detail`，`start()` 不报错、只是不通

## 探针两条引擎（`wechat_probe.ps1`）

| 引擎 | 实现 | 本机实测 |
|---|---|---|
| `winrt`（默认优先） | `Windows.UI.Notifications.Management.UserNotificationListener` | ✅ 可用，`GetAccessStatus() = Allowed`，读到通知中心 20 条 |
| `uia` | `UIAutomationClient` 扫通知中心面板节点 | ❌ 面板不是 UIA 顶层子窗口（Win11 26H2 的 `XamlExplorerHostIslandWindow` 在 Win+N 打开后也没出现在 `RootElement` 子节点里），扫不到 |

`winrt` 是 Windows 官方读通知中心的 API，拿到的就是面板里显示的那些卡片
（应用名 + 标题 + 正文 + 创建时间），比 UIA 扫界面稳。PS 5.1 上的坑：
方法是 `GetNotificationsAsync()`（不是 `GetNotifications()`），
返回值必须走 `[System.WindowsRuntimeSystemExtensions]::AsTask(...)` 才拿得到。

可单独跑：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File app\infohub\sources\wechat_probe.ps1 -OutFile out.json
powershell ... -File wechat_probe.ps1 -Engine uia          :: 只走 UIA
powershell ... -File wechat_probe.ps1 -RequestAccess       :: 系统没授权时弹一次授权框
```

> 注意：`.ps1` 必须存成 **UTF-8 带 BOM**。Windows PowerShell 5.1 会按 ANSI(GBK) 读无 BOM 文件，
> 中文注释会被读成乱码并直接语法报错（本轮踩过）。`wechat.js` 里的探针输出走
> `-OutFile` + UTF-8 写盘再由 Node 读，避免控制台代码页（GBK）把中文搞乱。

## 实测输出（真跑，2026-11-25）

```
$ node app/infohub/sources/wechat.js --probe
{
  "ok": true,
  "detail": "WinRT/UIA 可用（access=Allowed），通知中心 20 条，微信 0 条",
  "count": 20,
  "wechatCount": 0,
  "engine": "winrt",
  "access": "Allowed",
  "sample": [
    {
      "app": "QQ",
      "aumid": "QQ",
      "id": "19680",
      "title": "卡米莉娅的舰长通知群",
      "body": "[@全体成员] 梦幻：[图片]卡米莉娅睡不醒ovo 下播啦，本次直播了 2小时30分48秒 https://live.bilibili.com/31347839",
      "creation": "2026-11-22T11:11:04.1817741+08:00"
    },
    {
      "app": "Intel Driver & Support Assistant",
      "aumid": "Intel.Dsa.Tray",
      "id": "19688",
      "title": "可用更新",
      "body": "• Intel® 11th – 14th Gen Proc...",
      "creation": "2026-11-22T15:08:41.2882639+08:00"
    }
  ],
  "elapsedMs": 1068,
  "ps1": "<仓库根>\\app\\infohub\\sources\\wechat_probe.ps1"
}
```

（`sample` 只贴前 2 条，实际 20 条；应用分布：QQ / Intel Driver & Support Assistant / 截图工具）

`start()` → `poll` 的真实状态行：

```
运行中（WinRT）· 通知中心 20 条，微信 0 条（本机微信当前没往通知中心推消息；微信 4.x 默认不推聊天消息）
```

## 结论：本机拿不到微信条目，原因是微信自己没往通知中心推

不是脚本读不到，而是**没有可读的东西**：

1. 本机微信是 4.x 新客户端：`D:\Program Files\Tencent\Weixin\Weixin.exe`，主窗口类名
   `mmui::MainWindow` → 传统 Win32 进程，不是 MSIX 包。
2. 它没有注册任何 toast AUMID：
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings` 下
   **查不到任何 `WeChat|Weixin|Tencent` 子键**（同一个键下 QQ、Intel DSA、截图工具都在）。
   没注册 AUMID 就不能往通知中心推卡片，只能自己弹托盘气泡。
3. 同期抓到的通知里最大头就是 QQ（20 条里 16 条是 QQ），说明通知中心本身工作正常。

对照：微信 3.x 的包版本（AUMID `TencentWeChatLimited.forWindows10_sdtnhv12zgd7a!App`）
会注册通知并有 toast；4.x 砍掉了。因此本模块**默认关闭**，`enabled:true` 也只是
「有微信 toast 时能收到」，不保证有。

## 怎么配

```json
{ "wechat": { "enabled": true, "pollSec": 3 } }
```

想验证本机是否真的没有微信 toast：开着微信让人给你发条消息，然后
`node app/infohub/sources/wechat.js --probe`，看 `wechatCount` 是否 > 0。

## 已知限制

- 依赖通知中心：用户点掉通知 / 通知过期就没了；本模块只读「当前还在面板里」的条目
- 3 秒轮询 = 每轮起一个 PowerShell（本机实测单次约 1.0~1.1s），CPU 占用不高但不算零成本；
  嫌费可以调 `pollSec: 5`
- toast 正文由发送方决定，可能是「3 条新消息」这种聚合文案，拿不到逐条内容
- 需要「通知访问」权限（`GetAccessStatus()=Allowed`）。若是 `Denied`，
  去 `设置 → 系统 → 通知 → 允许通知访问`（部分系统叫「通知助手」）打开，
  或用 `-RequestAccess` 触发系统授权框
- 非 Windows 平台本模块不可用（`start()` 会返回失败并写清原因）
