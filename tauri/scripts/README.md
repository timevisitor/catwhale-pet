# 量测脚本

全部脚本都按「隔离目录跑、不碰用户真实配置」写：启动 exe 时带
`CATWHALE_CONFIG_DIR` + `WEBVIEW2_USER_DATA_FOLDER`，隔离目录默认建在 exe 目录旁边。

## 调试口：优先用环境变量注入，不必再造一个「带调试口的构建」

CDP 脚本连的是 `--remote-debugging-port=9223`。2026-11-27 实测：**只设**

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" ./catwhale-poc.exe
```

就能让主窗和 sao/panel/chat/island 全部可连（WebView2 把这条环境变量并进同一条环境），
`/json/list` 能看到 5 个 page，也没有 0x8007139F。好处是被量的 exe 与交付 exe **逐字节相同**，
不用为测量单独改两处参数、也不会出现「量的是另一份构建」。
`cold-open-probe.py` / `latency-probe.py` / `startup-cost.py` 现在都这么干。

要往 exe 里写死调试口时，仍然**必须同时**改两处（漏一处就是上面那个 0x8007139F）：

1. `src-tauri/tauri.conf.json` → `app.windows[0].additionalBrowserArgs`
2. `src-tauri/src/main.rs` → `pub(crate) const WEBVIEW_ARGS`

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `check-config-isolation.py` | 隔离目录启动前后对比用户真实配置目录的 sha256（A 项验收） |
| `hitgrid-bench.py` | 新旧 exe 交替量命中网格采样耗时 + 逐格/采样点等价性（B 项） |
| `latency-probe.py` | SAO 菜单 / 综合面板 / 聊天浮窗 / 灵动岛跟随的打开延迟（C 项）+ 重复打开（热开） |
| `cold-open-probe.py` | 面板与聊天**冷首开**（含 WebView2 初始化），与热开分开量；`--settle` 控「就绪后多久才点」 |
| `startup-cost.py` | 主窗首帧可见 / 视频就绪 / SAO 菜单就绪 + 启动后 10s 进程树 CPU 与 RSS（预热的启动代价） |
| `measure.cjs` | 一次性采走动/拖动/启动/空闲等体验指标（旧基线脚本，端口用 `CDP_PORT`） |
| `drag.cjs` + `dragprobe.py` | 真实鼠标拖动节拍与滞后 |
| `cpupidle.py` | 按父子关系量进程树 CPU（走系统 API，不起 wmic） |
| `cdp.js` / `ev.py` | 最小 CDP 驱动（`ev.py` 按 URL 选 main/sao/panel/search/chat） |

## 两个坑

- **冷首开必须看 `--settle`**：`cold-open-probe.py` 默认在页面就绪后 1.5s 就点，此时应用自己
  还在启动尾巴上，面板/聊天首开在 0.6~2.0s 之间**双峰波动**（把预热延到 30s 仍复现，与本轮的预热无关）。
  量「预热后的首开」要用 `--settle 6`（预热在就绪后 2.5s / 4.2s 完成）。
- **`latency-probe.py` 的面板热开每轮有一半会 `hide() 后仍可见`**：面板 Tauri 内部可见标志与真值
  脱钩时会跳过该轮（`panel_ms` 的 n 只有 3/6），这是既有行为，不是新回归。

## 计时纪律

同一台机器上常有别的测量在跑，负载会漂，所以：

- 新旧基线**逐轮交替**测，不要先跑完 A 再跑完 B；
- 每次采样同时记全机 CPU（`GetSystemTimes` 差值），写进结果 JSON；
- 报中位数，被明显污染的轮次丢弃但要在结果里留痕；
- 别在 `cargo build` 的同时采数据。
