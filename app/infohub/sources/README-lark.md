# lark —— 飞书消息源（lark-cli）

`app/infohub/sources/lark.js` · 测试 `tests/infohub/lark.test.js`

## 能干什么

用本机 `lark-cli` 轮询飞书会话，会话的「最后一条消息 id」变了就弹一条
`飞书 · <会话名> / <发送人>`，正文是消息摘要（拿不到摘要就写「有新消息」）。

- 30 秒轮询
- 按 `chat_id + message_id` 去重，同一条绝不重复弹
- 启动前 60 秒只建基线不弹（`warmupSec` 可调，默认 60）
- 分级：消息里带 `@我 / @所有人` → `warn`，其余 `info`
- identity 自动选：`lark-cli auth status` 里 user 就绪用 user，否则降级 bot 并记住；
  真正调用时 user token 失效也会自动降级一次
- 所有子进程 20s 超时；CLI 缺失 / 未登录 / 无会话都只写 `status().detail`，不抛异常

## 实测过的真实命令（lark-cli 1.0.96，2026-11-25）

```bash
$ lark-cli im --help
Available Commands:
  +chat-list              List chats the current user/bot is a member of; defaults to groups;
                          pass --types=p2p,group to include p2p single chats (user-only)
  +chat-messages-list     List messages in a chat or P2P conversation; user/bot;
                          accepts --chat-id or --user-id, resolves P2P chat_id
  +messages-search        Search messages across chats (supports keyword, sender, time range filters)
  +feed-group-list-item   List feed cards in a feed group (tag); user-only
  …
```

模块真正用的是这两条（`--dry-run` 已验证请求形状）：

```bash
$ lark-cli im +chat-list --as user --types p2p,group --sort active_time --page-size 50 --dry-run
{"ok":true,"identity":"user","dry_run":true,"data":{"api":[{"method":"GET",
 "url":"/open-apis/im/v1/chats",
 "params":{"page_size":50,"sort_type":"ByActiveTimeDesc","types":"p2p,group","user_id_type":"open_id"}}]}}

$ lark-cli im +chat-messages-list --as user --chat-id oc_test --page-size 1 --order desc --no-reactions --dry-run
{"ok":true,"identity":"user","dry_run":true,"data":{"api":[{"method":"GET",
 "url":"/open-apis/im/v1/messages",
 "params":{"card_msg_content_type":"raw_card_content","container_id":"oc_test",
 "container_id_type":"chat","only_thread_root_messages":"true","page_size":"1",
 "sort_type":"ByCreateTimeDesc","with_sender_name":"true"}}]}}
```

认证状态（open_id 已打码）：

```bash
$ lark-cli auth status
{
  "appId": "cli_aa95…",
  "brand": "feishu",
  "defaultAs": "user",
  "identities": {
    "bot":  { "status": "ready",   "available": true,  "message": "Bot identity: ready" },
    "user": { "status": "missing", "available": false, "message": "User identity: missing (no token in keychain for ou_a9ad…)" }
  },
  "identity": "bot"
}
```

bot 身份的会话列表（本机 bot 没加入任何群，所以是空的）：

```bash
$ lark-cli im +chat-list --as bot --page-size 3
{"ok": true, "identity": "bot",
 "data": { "chats": null, "has_more": false, "page_token": "" },
 "meta": { "pagination": { "complete": true, "pages": 1, "items": 0 } }}
```

## 关键结论：lark-cli 没有「未读计数」接口

`lark-cli` 没有现成的 unread 命令：`im --help` 全表里没有 unread 相关项，
包里 `grep -ri unread` 只在 `bin/lark-cli.exe` 二进制里命中（无可用 CLI/文档）。
`+chat-list` 返回的字段只有 `chat_id / name / chat_type / external …`，不含未读数。

所以本模块的方案是：**会话 + 该会话最后一条 message_id**。
`message_id` 变了 = 有新消息；条数拿不到就写「有新消息」，
`toEvent()` 预留了 `unread` 参数，将来若接口给出条数会显示「N 条未读」。

## 实测（2026-11-25，本机 Node v22.22.3）

```
$ node app/infohub/sources/lark.js --probe
[log] user 身份不可用（authentication），降级到 bot 身份
{
  "ok": true,
  "detail": "lark-cli 可用（exe）· bot 身份 · 0 个会话",
  "identity": "bot",
  "cliPath": "C:\\Users\\<你>\\AppData\\Local\\hermes\\node\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe",
  "chats": 0,
  "sample": [],
  "elapsedMs": 805
}
```

```
$ node tests/infohub/lark.test.js
[解析函数]
  ok   parseChats：群名/单聊兜底名/类型/顺序
  ok   parseChats：兼容 data.items 与空返回
  ok   parseMessages：text / post 富文本 / image 都能抠出正文
  ok   toEvent：title/body/key 正确
  ok   toEvent：@我 → warn；无正文 → 「有新消息」；deleted → null
  ok   parseCliJson：能从夹着日志的输出里取对象
[轮询链路（假 lark-cli）]
  ok   接口形状：name/label/defaults/方法齐全
  ok   start()：首轮只建基线，不弹历史消息
  ok   会话最后一条消息变了 → 产出一条 message 事件
  ok   同一条消息再轮询 → 按 chat_id+message_id 去重，不重复弹
  ok   又来一条新消息 → 正常再弹
  ok   stop() 后状态为已停止，不再轮询
[启动 60 秒静默]
  ok   基线建立后，静默期内的新消息不弹但被记为已见
  ok   静默期内同一 id 不会被下次补弹（不炸屏）
[认证失败路径]
  ok   lark-cli 报 token 失效 → status 如实写原因，不抛异常
  ok   probe() 返回 ok:false + errorType=authentication
[本机真实 lark-cli]
       入口：C:\Users\<你>\AppData\Local\hermes\node\node_modules\@larksuite\cli\bin\lark-cli.exe（exe）
  ok   能定位到 lark-cli 可执行文件
       lark-cli version 1.0.96
  ok   lark-cli --version 真跑成功
       detail=lark-cli 可用（exe）· bot 身份 · 0 个会话  identity=bot  chats=0
  ok   probe() 真跑（身份/会话数按本机实际情况，不伪造）

===============================
全部通过：19 项
```

整条轮询链路用「假 lark-cli」（`cfg.cliPath` 指向一个 node 脚本）驱动，
断言：基线不弹 → 新 message_id 弹一条 → 同 id 去重 → 再来新的照弹 →
`stop()` 后不再轮询 → 60 秒静默期不弹且不补弹 → token 失效只改 status。

## 怎么配

```json
{
  "lark": {
    "enabled": true,
    "pollSec": 30,
    "maxChats": 6,
    "as": ""
  }
}
```

- `as`：留空 = 自动（user 优先，失败降 bot）；填 `user` / `bot` 可强制
- `maxChats`：每轮最多跟踪几个会话（按活跃时间倒序的头部）。每个会话要一条子进程，
  默认 6，网络慢可调小
- `cliPath`：可选，手动指定 lark-cli 路径

看自己的消息必须用 user 身份，先登录一次：

```bash
lark-cli auth login        # 设备码流程，会给出 verification_url
```

登录后 `--probe` 的 `identity` 会变成 `user`，`chats` 才是你自己的会话数。

## 已知限制

- **没有未读计数**（见上），只能判断「有新消息」
- 每个会话一次 `+chat-messages-list` 调用，`maxChats=6` 就是每 30 秒最多 7 次子进程；
  会话多时要么调小 `maxChats`，要么等接口层面出批量消息列表
- 只跟踪活跃度最高的前 `maxChats` 个会话，冷门群的新消息不会弹
- 消息正文只做文本抽取：`text` / `post` 富文本 / 图片语音等给中文占位；
  卡片类（interactive）只能拿到 `[卡片]`
- user token 会过期（过期后 `auth status` 里 user 变 `missing`），需要重新
  `lark-cli auth login`；模块会自动降级 bot 并在 `status()` 里写清
- 本机 bot 未加入任何群，所以真实环境只验证到「0 个会话」，没验证到真实消息流
