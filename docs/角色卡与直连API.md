# 角色卡与直连 API（v0.5.0 起）

## 一、对话后端：两种选一

设置 → **💬 对话后端**

| 后端 | 适合 | 说明 |
|---|---|---|
| DeepSeek Harness | 让桌宠干活（读文件、跑命令、联网） | 原有方式，需要本机 harness 仓库 |
| 直连 API | 纯聊天 / 角色扮演 | 只要一个 OpenAI 或 Anthropic 兼容的接口地址 + key |

直连 API 要填：

- **接口格式**：`OpenAI 格式`（`POST {网址}/chat/completions`）或 `Anthropic 格式`（`POST {网址}/v1/messages`）
- **API 网址**：OpenAI 格式填到 `/v1` 为止（例：`https://api.deepseek.com`、`https://api.openai.com/v1`、本地 `http://127.0.0.1:8080/v1`）；Anthropic 格式填域名或 `…/v1` 都行
- **模型名**、**API Key**（本地模型可不填）、温度、最大输出、带几轮历史

Key 用 Windows DPAPI（Electron safeStorage）加密存进 `%APPDATA%\桌宠\settings.json`，不以明文落盘。
点「保存并测试连接」会真的发一句话，失败时把服务端原始错误（状态码 + 正文）显示出来。

## 二、角色卡

聊天窗口右上角 **🎭 角色**：

- **导入**：点「导入…」选文件，或把 PNG / JSON 卡**直接拖进聊天窗口**
- **使用**：切到该角色。聊天记录按角色分文件存（`%APPDATA%\桌宠\chat-history\<id>.json`），切回「不扮演」还是原来的默认对话
- **编辑 / 新建**：字段与 SillyTavern 一致（name / description / personality / scenario / first_mes / mes_example / system_prompt / post_history_instructions / tags / creator）
- **导出 PNG**：卡写进图片的 `chara`（V2）+ `ccv3`（V3）文本块，SillyTavern 新旧版都能直接导入；导入时带的原图会保留下来当底图
- **导出 JSON**：`chara_card_v2`

### 卡里只有人设，不含记忆

导出走字段白名单：只输出上面那些人设字段。**不导出**：聊天记录、记忆、世界书（character_book）、
其它程序塞进 `extensions` 的任意数据。别人发来的卡带着这些字段也会在导入时被丢掉。

### 兼容的格式

| 来源 | 支持 |
|---|---|
| SillyTavern / RisuAI 等导出的 PNG（tEXt `chara` 或 `ccv3`，也读 zTXt/iTXt） | ✅ |
| `chara_card_v2` / `chara_card_v3` JSON | ✅ |
| 早期 TavernAI / Pygmalion 扁平 JSON（`char_name` / `char_persona` …） | ✅ |
| `{{char}}` `{{user}}` `<BOT>` `<USER>` 宏 | ✅（`{{user}}` = 设置里的「你的称呼」） |

## 三、人设怎么进提示词（借鉴 SurfCore 的分层）

参考 [Mieksido/surfcore](https://github.com/Mieksido/surfcore) 的 `persona-layers.js`：人格卡只写「你是谁、怎么说话」，
运行规则由宿主注入，按层拼接并设总预算。

```
【身份】  system_prompt；为空时用默认扮演指令
【人设】  description + personality              ← 核心，最后才截断
【场景】  scenario + 桌宠场景（短句、口语、不替用户说话）
【对话示例】mes_example（<START> 分段）          ← 超预算先砍
历史（最近 N 轮，按角色分开）
post_history_instructions（作为最后一条 system，压住跑偏）
本轮用户消息
```

预算默认 6000 字符（`settings.json` 的 `chat.personaMaxChars`）。超出时：先砍示例 → 再砍场景 → 最后截断人设并标注。

- **直连 API**：上面整段作为 system（Anthropic 格式放 `system` 字段，且自动合并相邻同角色消息、保证首条为 user）。
- **Harness**：harness 的 system prompt 改不了，所以人设放在本次运行时的第一条消息里；切角色会重启 harness 运行时，保证一个会话只对应一个角色。

## 四、文件

| 文件 | 作用 |
|---|---|
| `app/llm-client.js` | OpenAI / Anthropic 流式客户端（纯 Node，无依赖） |
| `app/character-card.js` | 角色卡解析、PNG 读写、白名单导出、分层组提示词 |
| `app/persona-store.js` | 本机卡库（`%APPDATA%\桌宠\characters\`）+ 按角色分聊天记录 |
| `web/persona.js` `web/persona.css` | 角色面板（列表 / 编辑 / 拖拽导入 / 导出） |
| `tests/llm-character.test.cjs` | 12 项离线单测（假 SSE 服务、PNG 往返 + CRC、白名单、预算裁剪、卡库） |
