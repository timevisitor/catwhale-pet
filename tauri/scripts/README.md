# 量测脚本

全部脚本都按「隔离目录跑、不碰用户真实配置」写：启动 exe 时带
`CATWHALE_CONFIG_DIR` + `WEBVIEW2_USER_DATA_FOLDER`，隔离目录默认建在 exe 目录旁边。

## 跑之前要先有一个「带调试口」的构建

CDP 脚本连的是 `--remote-debugging-port=9223`。这个口**必须同时**写进两处：

1. `src-tauri/tauri.conf.json` → `app.windows[0].additionalBrowserArgs`
2. `src-tauri/src/main.rs` → `pub(crate) const WEBVIEW_ARGS`

两处不一致时，主窗和 sao/panel/chat/island 会落在不同的 WebView2 环境上，
第二个 webview 直接创建失败：`WebView2 error WindowsError(HRESULT(0x8007139F))`
（`startup.log` 里是 `[sao] prebuild ERR`）。**交付构建两处都不要带调试口。**

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `check-config-isolation.py` | 隔离目录启动前后对比用户真实配置目录的 sha256（A 项验收） |
| `hitgrid-bench.py` | 新旧 exe 交替量命中网格采样耗时 + 逐格/采样点等价性（B 项） |
| `latency-probe.py` | SAO 菜单 / 综合面板 / 聊天浮窗 / 灵动岛跟随的打开延迟（C 项） |
| `cold-open-probe.py` | 面板与聊天**冷首开**（含 WebView2 初始化），与热开分开量 |
| `measure.cjs` | 一次性采走动/拖动/启动/空闲等体验指标（旧基线脚本，端口用 `CDP_PORT`） |
| `drag.cjs` + `dragprobe.py` | 真实鼠标拖动节拍与滞后 |
| `cpupidle.py` | 按父子关系量进程树 CPU（走系统 API，不起 wmic） |
| `cdp.js` / `ev.py` | 最小 CDP 驱动（`ev.py` 按 URL 选 main/sao/panel/search/chat） |

## 计时纪律

同一台机器上常有别的测量在跑，负载会漂，所以：

- 新旧基线**逐轮交替**测，不要先跑完 A 再跑完 B；
- 每次采样同时记全机 CPU（`GetSystemTimes` 差值），写进结果 JSON；
- 报中位数，被明显污染的轮次丢弃但要在结果里留痕；
- 别在 `cargo build` 的同时采数据。
