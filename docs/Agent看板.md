# Agent 看板（虚拟按键台）

给猫鲸桌宠加的一块「跟随本机 AI Agent」的看板：本机上任何一个 Agent 在干活、在等你确认、出错了，桌宠会**演出来**；点一下桌宠旁的小胶囊，弹出会话卡片列表。

> 交互只有点：**点卡片＝选中该会话，再点同一张＝展开/收起详情**；头部一个静音图标 + 关闭。
> 早期版本照搬了 HachimoDock 实体小屏的「3 键 + 五向摇杆」虚拟按键台，用户评估后判定在鼠标场景下纯冗余（点卡片已能完成全部导航），已整体删除。

> 只借鉴「功能表现」，代码全部自己写：不依赖 HachimoDock、不需要 ESP32 硬件、不读对方程序的凭据。

---

## 1. 它由三部分组成

| 层 | 文件 | 职责 |
|---|---|---|
| 中枢 | `app/agent-dock.js` | 本地 HTTP 收状态（默认 `127.0.0.1:8770`）、按会话日志跟随后台 Agent、状态归一、快照 |
| 接线 | `app/main.js`（`AGENT_DOCK` 段）+ `app/preload.js`（`petHost.dock`） | 起服务、把快照经 IPC 推给页面、转发 harness 事件 |
| 界面 | `web/dock.js` + `web/dock.css` | 桌宠旁胶囊、按键台面板、按键动作；只把「最紧急状态」以 `dock:state` 事件告诉状态机 |

桌宠状态机只加了 3 行（`resolveState` 里的 1.6 两行 + `M.dockState`），拖拽/菜单/聊天/长任务的优先级链一行没动。

## 2. 支持哪些 Agent（诚实版）

| 通道 | 接入方式 | 本机实测 |
|---|---|---|
| **Hermes** | `hooks.outbound` → `POST /state`（一行命令装好，见 §5） | ✅ 配置已被 `hermes hooks list` 识别；事件映射 17 个 |
| **ChatGPT Codex** | 不需要配置：读 `~/.codex/sessions/**/*.jsonl` 活跃度与最后一句 | ✅ 本机已装（有过会话就能跟） |
| **Claude Code** | 同上：`~/.claude/projects/**/*.jsonl`；也可让它自己的 hook 推 `/state` | ⚠️ 本机未安装（通道显示"未安装"，不假装有数） |
| **OpenClaw** | 用它自己的网关/插件钩子推 `POST /state`（`agent:"openclaw"`） | ⚠️ 本机未安装 |
| **MiMoCode** | 插件推送 `POST /state`（`agent:"mimocode"`） | ⚠️ 本机未安装 |
| **WorkBuddy** | 它的 hook 推 `POST /state`（`agent:"workbuddy"`） | ⚠️ 本机未安装（目录探测通过即显示可用） |
| **DeepSeek Harness** | 桌宠内置：聊天时的 `harness:status` / `harness:event` 直接喂中枢 | ✅ 通道可用（聊天即上报） |
| 其它/自定义 | 任何程序 `POST /state`，`agent` 可写任意 id | ✅ 通用通道 |

**没有一个在装"假装能监控"**：没装的通道在面板里明确写"未安装 + 怎么接"。

## 3. 推送契约（两种形状都收）

**A. Hermes / Claude Code hook 形状**（字段来自事件本身，最省事）

```jsonc
POST http://127.0.0.1:8770/state
{
  "hook_event_name": "pre_tool_call",   // 事件名，映射成状态
  "session_id": "abc123",
  "tool_name": "terminal",
  "cwd": "H:\\project",
  "prompt": "帮我整理日志",              // 可选：标题/最后一句的来源
  "last_assistant_message": "…",        // 可选
  "session_title": "…"                  // 可选：显式气泡标题
}
```

**B. 通用形状**（谁都能发）

```jsonc
{ "agent": "my-bot", "state": "working", "session_id": "s1", "session_title": "压测", "prompt": "跑起来" }
```

- `state` 认 `working / speaking / waiting_user / done / error / idle / sleeping`；
  也认别人家的词（`attention→done`、`juggling→working`、`notification→waiting_user`…）。
- 不给 `state` 时按 `hook_event_name` 推：`pre_tool_call→working`、`on_human_input_request→waiting_user`、
  `agent_loop_stopped/on_session_end→done`、`api_request_error→error`、`on_stream_delta→speaking`。
- 只绑 `127.0.0.1`；body 上限 64 KB；坏 JSON 400、超大 413。

## 4. 状态 → 桌宠动作

| 最紧急的状态 | 桌宠演 | 说明 |
|---|---|---|
| `waiting_user` | `stand_arms`（举手） | 你该去点确认了 —— 真机截图里就是这个姿势 |
| `working` | `working`（操作中） | 有 Agent 在干活 |
| `speaking` | `working` | 流式输出中也算在处理 |
| `done`（刚从 working 变过来） | 一次性 `jump_high`（跳一下） | 只在状态**变化**时演一次，不会每 2 秒重演 |
| `error`（刚变过来） | 一次性 `dizzy`（晕菜） | 同上 |
| `idle` | 不干预 | 交给原来的待机/作息导演层 |

排序优先级：`waiting_user > error > working > speaking > done > idle`——"等你确认"永远压在最上面。
`done/error` 只留 60 秒（可配置）；`working` 150 秒没新推送自动收掉；
`waiting_user` 10 分钟没结果也收掉——防止 Agent 进程已经死了、"等确认"却在面板上挂一整天。
会话状态只存内存，桌宠重启即清空（不做持久化，避免陈旧状态被当成"还在干活"）。

## 5. 接 Hermes（一条命令）

```bash
node tools/dock-install-hermes-hooks.js            # 写入 hooks.outbound（幂等，自动备份）
node tools/dock-install-hermes-hooks.js --dry-run  # 只看要写什么
node tools/dock-install-hermes-hooks.js --remove   # 摘掉
```

- 它只往 `%LOCALAPPDATA%\hermes\config.yaml` **追加** `hooks.outbound`，写前备份、写完跑 `hermes hooks list` 自检。
- **Hermes 的 hooks 在进程启动时注册 → 改完要重启 Hermes**（新开会话不够）。
- 推送是 Hermes 侧的 fire-and-forget 队列，桌宠没开也不会拖慢工具调用（2 秒超时、丢弃）。

## 6. 面板怎么操作

| 操作 | 效果 |
|---|---|
| 点桌宠旁的胶囊 | 打开 / 收起面板 |
| 点一张卡片 | 选中（钉住）该会话，详情若开着就跟着换人 |
| 再点同一张卡片 | 展开 / 收起这条会话的详情（卡片右侧 ▸ / ▾ 提示当前状态） |
| 头部喇叭图标 | 静音：桌宠不再为 Agent 演动作（数字照常更新）；再点立刻恢复 |
| 头部 × / Esc / 点空白 | 收起面板 |

详情区给：Agent、会话 id、标题、状态（含原始事件名）、当前工具、目录、来源（hook 推送 / 日志推断 / 内置通道）、最后你说、最后它说。
`done/error` 的气泡 60 秒后自动消失，不需要手动清。

## 7. 配置

`%APPDATA%\桌宠\dock.json`（首次运行自动生成，可手改，改端口需重启桌宠）：

```json
{ "enabled": true, "port": 8770, "keepDoneSec": 60 }
```

## 8. 自检 / 验收（都能复跑）

```bash
node tools/dock-selftest.js        # 中枢逻辑 37 项：HTTP 契约/三套 payload/生命周期/日志适配/大包坏包
node tools/dock-demo.js            # 往面板推一段 14 秒剧本，肉眼验收桌宠动作与气泡
node tools/dock-cdp-test.js        # 真窗口 29 项：面板/气泡/8 个按键/短按长按/状态机联动/截图
```

`dock-cdp-test.js` 要求桌宠带调试口启动（用临时 user-data 目录，不影响你日常那份）：

```bash
./app/node_modules/electron/dist/electron.exe app \
  --user-data-dir="H:/hermes project/桌宠/build/_dock_ud" --remote-debugging-port=9333
```

实测基线（2026-10-29，精简版）：中枢 39/39、真窗口 38/38（连跑两遍都过，无残留污染）、
打包版（`dist/桌宠/桌宠.exe`）同样 39/39 + 38/38。

> `dock-cdp-test.js` 遇到"别的 Agent 正在活跃"时，主导状态/庆祝动作那几项会打 `SKIP`（不算失败）——
> 因为桌宠本来就按最紧急状态演，别的 Agent 在干活时不该演"完成"。

## 9. 坑（都踩过）

1. **`taskkill //F //IM` 在 git-bash 里是无效参数**（MSYS 不转换），要写 `taskkill /F /IM electron.exe`；否则旧实例杀不掉，新实例被单实例锁吞掉，你会以为"改了没生效"（本次就因此跑了两轮旧代码）。
2. **首次启动的环境自检向导 z-index=60，会正好盖住看板**：`DockUI.open()` 里要主动 `closeEnv()`（部署进行中不动它），看板 z-index 提到 61/62。
3. **`applyState()` 早于页面 init 完成会踩 `els.stateLine` 未定义**：看板事件监听里必须 try/catch，`updateStateLine` 加 `if (!els.stateLine) return;`。
4. **`.js` 改完要 `node app/tools/sync-renderer.js`**（`app/renderer/` 是 `web/` 的生成物），再 `python pack_portable.py` 重打，否则用户手上那份还是旧代码。
5. **`pack_portable.py` 的 `FILES` 要加 `agent-dock.js`**：白名单漏文件会变成打包后运行时 `require` 失败，只在真机才炸。
6. 气泡正文别把状态词重复一遍（"刚结束 · 刚结束"）：无 lastUser/lastAgent/tool 时不渲染正文行。
7. **详情区不要写成固定 `max-height` 的小滚动框**：9 行详情会正好把最后一行切一半、底部提示文字看着像压在上面。改成 `flex: 0 1 auto; max-height: 300px`，让列表让位。
8. **静音/取消静音必须主动补发一次 `dock:state`**：状态机的监听器只在"状态变化"时触发，取消静音后如果等下一次事件，桌宠会一直不动。
