# napcat —— QQ 消息源（OneBot v11 / NapCat）

`app/infohub/sources/napcat.js` · 测试 `tests/infohub/napcat.test.js`

## 能干什么

连 NapCat 的 OneBot WebSocket 正向服务，把私聊/群聊消息转成信息中枢的归一化事件，
弹窗显示「谁、在哪个群、说了什么」，可一键复制或跳到 QQ。

- 只处理 `post_type === 'message'`；`message_sent`、`notice`、`meta_event` 全部忽略
- 自己发的（`message_sent` 或 `user_id === self_id`）忽略，不会自己弹自己
- CQ 码清洗：`[CQ:face]`→`[表情]`、`[CQ:image]`→`[图片]`、`[CQ:record]`→`[语音]`、
  `[CQ:at,qq=自己]`→`@我`、`[CQ:at,qq=all]`→`@全体成员`、`[CQ:reply]` 丢弃、未知 CQ 码剥掉；
  NapCat 转义过的 `&#91;` 会先还原
- 分级：私聊 / 群里被 @ → `level:'warn'`；其余群消息 `info`
- 正文超 90 字截断加 `…`
- 断线自动重连：2s → 4s → 8s → 16s → 30s 封顶，`status().detail` 显示
  `已断线，重试中（Ns 后重连）`

## 怎么配

设置页（或 `%APPDATA%\桌宠\infohub.json`）里：

```json
{
  "napcat": {
    "enabled": true,
    "wsUrl": "ws://127.0.0.1:3000",
    "token": "你 NapCat 里配的 access_token"
  }
}
```

NapCat 侧：`网络配置 → 新建 → WebSocket 服务器`，端口 3000（或任意），
`access_token` 填了这边就要填同一个。默认值 `enabled:false`，即不启用。
另有只在测试里用的 `reconnectBase` / `reconnectMax`（毫秒）和 `wsImpl: 'auto'|'native'|'lite'`。

## WebSocket 客户端

Node 22 自带全局 `WebSocket`，优先用它。若宿主环境里 `typeof WebSocket === 'undefined'`
（老 Electron / 被裁掉的安全环境），自动退回文件内手写的 `WsLite`：

- `node:net` / `node:tls` 建连，手写 `GET` 升级请求 + `Sec-WebSocket-Accept` SHA1 校验
- 客户端掩码、文本帧、分片重组、ping→pong、close 全部实现
- 建连超时 10s，单帧上限 8MB
- 原生 WebSocket 不能自定义 header，token 走 query（NapCat 两种都认）；
  `WsLite` 走 `Authorization: Bearer ***`

## 实测（2026-11-25，本机 Node v22.22.3）

```
$ node tests/infohub/napcat.test.js
[纯函数]
  ok   cleanCq：face/image/at/未知码 全部转成中文占位
  ok   toEvent：非法/空消息返回 null
  ok   clip：90 字上限
  ok   群聊未被@ → info 级
[内建 WsLite（node:net 手写 WS）]
  ok   接口形状：name/label/defaults/方法齐全
  ok   start() 后完成 WS 握手并进入运行中
  ok   私聊消息 → 一条 message 事件，title/body 正确
  ok   群聊 + CQ 码清洗 + 被@ → warn、title 含群名/昵称
  ok   自己的消息被忽略（message_sent / user_id==self_id）
  ok   正文截断到 90 字以内并加省略号
  ok   服务端杀连接 → 状态变「已断线，重试中」并自动重连
  ok   重连后仍能收消息
  ok   stop() 清干净定时器且状态为已停止
[原生 WebSocket]
  …（同上 9 项，全部 ok）
[auto 模式]
  ok   typeof WebSocket = function
  ok   auto 模式自动选择实现并连上假 OneBot
  ok   auto 模式收消息正常，stop() 后干净退出
[auto 模式，且删除全局 WebSocket]
  ok   typeof WebSocket = undefined（内建实现接管）
  ok   auto 模式自动选择实现并连上假 OneBot
  ok   auto 模式收消息正常，stop() 后干净退出

===============================
全部通过：28 项
```

测试里自带一个 `node:net` 假 OneBot 服务端（真握手、真掩码帧解析），
断言覆盖：私聊/群聊事件、CQ 码清洗、自己消息忽略、90 字截断、断线→重试中→自动重连、
重连后继续收消息、`stop()` 后不再有事件。

本机没有跑真实 NapCat（QQ 已在跑但没开 WS 服务端），所以没有真机连通的日志；
`probe()` 在 NapCat 没监听时会返回
`{ok:false, detail:'连接超时（10s），NapCat 没在 ws://127.0.0.1:3000 上监听'}`，不抛异常。

## 已知限制

- 只做「正向 WS 客户端」，不支持 NapCat 的反向 WS（需要时得再写服务端）
- 群里被 @ 的判定依赖 `raw_message` 里的 `[CQ:at,qq=self]`；如果 NapCat 关掉了 CQ 码
  （`messagePostFormat: array`），会退化成分段数组解析，`@` 判定仍可用但不含昵称
- 不下载图片/语音，只给占位符
- 频道（guild）消息、戳一戳等 notify 事件不处理
