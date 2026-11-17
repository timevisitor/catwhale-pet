# 猫鲸桌宠 · Tauri (Rust) 版

当前 exe 为 **5.23 MiB（5,488,640 字节）**。SAO 菜单已按原版重做为四列、五分类 21 项；文件搜索和聊天使用原版风格独立浮窗，综合面板保留系统监控、环境自检、角色卡和 Agent 看板等功能。

双击 `catwhale-poc.exe` 运行。目标机需要 WebView2 Runtime，Windows 11 通常已自带。

![最终四列菜单验收截图](shots/verify4_menu.png)

## 一、运行时必须保留的文件

```text
catwhale-poc.exe          主程序
WebView2Loader.dll        必须与 exe 同目录
assets/es.exe             Everything 搜索组件
frontend/assets/          26 个外置内置回落 WebM
```

HTML 已嵌入 exe，但回落视频没有内嵌。移动程序时请移动整个 `tauri-pet` 目录，或至少保留上面四组运行文件；`src-tauri`、验收脚本和截图不参与运行。

最终 exe SHA-256：

```text
1072a1728a39ecc2399a948d06497720fe596e65e4fb99a90c57ed4053ea001d
```

## 二、桌宠操作

| 操作 | 效果 |
|---|---|
| 按住角色拖动 | 切换抓手动作并跟随鼠标，松手播落下动作 |
| 双击角色 | 随机互动动作 |
| 右键角色 | 打开/关闭 SAO 菜单，不抢当前外部应用前台 |
| Esc | 第一次收三级菜单，再次关闭 SAO 菜单 |
| 点击其他窗口 | 菜单失焦关闭 |
| 托盘右键 | 显示/隐藏、互动、换肤、皮肤目录、自启、尺寸和退出 |

皮肤继续读取 `%APPDATA%\桌宠\skins`，与 Electron 版共用。该目录是用户资产，测试或构建流程不应改写。

## 三、SAO 菜单

菜单逻辑尺寸为 **708×374**，左侧条目、中间分类、圆形分类轴和右侧详情卡组成四列。详情卡显示立绘及 CPU/GPU/内存/硬盘真实读数。

| 分类 | 条目 |
|---|---|
| 互动 | 打个招呼、摇摇尾巴、和它说话、随机动作、吃点米饭 |
| 外观 | 显示大小、脚下阴影、演示背景 |
| 动作 | 回待机、再摇一次尾、表情、聊天时演表情、陪它忙起来 |
| 工具 | 文件搜索、DeepSeek 聊天、控制面板、设置 |
| 设置 | 开机自启、所在屏幕、重新加载界面、退出桌宠 |

显示大小提供 240/340/460/620 四档；表情和所在屏幕也会展开第三级。第三级在原条目区域替换，支持方向键、Home、End 和 Enter，不会额外增加一列。

菜单位于角色右侧时，角色动画按原版中轴水平镜像并朝向菜单；菜单位于左侧时恢复默认朝向。逐像素点击命中网格同步翻转，关闭菜单后恢复默认状态。

## 四、独立搜索 / 聊天浮窗与综合面板

从菜单「工具」进入文件搜索，或从「和它说话」进入聊天。两者不再作为综合设置面板的页面：

- **文件搜索**：470px 宽原版浅色浮窗，按内容调整高度；Everything 查询，Enter 打开、Ctrl+Enter 定位、Ctrl+C 复制路径、Esc 关闭。
- **DeepSeek 聊天**：470×570 独立浮窗，包含历史、角色卡、停止生成、清空和 Harness 状态。关闭只隐藏窗口，不取消生成或清空草稿。
- **综合面板**：保留控制、设置、角色卡和 Agent 看板导航，环境自检由设置进入；不再显示搜索和聊天页面入口。

搜索和聊天浮窗优先贴角色左侧，空间不足时换到右侧，并驱动角色朝向对应浮窗。拖动角色时浮窗同步跟随，工作区边缘会限制浮窗位置，避免被移出屏幕。

聊天凭据使用 Windows DPAPI 加密保存；文档和日志不应记录真实 API Key。

## 五、当前验收结果

在交付目录运行：

```bash
bash verify4.sh
```

最终交付副本已完整运行并输出 **`verify4 全部 PASS`**。覆盖 main/sao/panel/search/chat 启动与事件权限、屏幕左右边缘角色镜像与命中网格、真实右键、21 项菜单、四列几何、真实硬件读数、三级菜单、键盘、尺寸底边锚定、真实两级 Esc、失焦关闭、不抢前台、Everything、搜索动态高度、Unicode 剪贴板、聊天角色浮层与草稿保留、浮窗拖动跟随、Harness 普通路径、连续点击和真实拖动恢复。

`ev.py` 用 `M`/`S`/`P`/`F`/`C` 选择主窗、菜单、综合面板、搜索和聊天，对应 `shotM`/`shotS`/`shotP`/`shotF`/`shotC` 截图。例如：

```bash
python ev.py M 'window.__petReady'
python ev.py S 'SAO.cat'
python ev.py P 'window.__panelReady'
python ev.py F 'window.__searchTest.ready'
python ev.py C 'window.__chatTest.ready'
```

`verify3.sh` 及更早脚本只作历史资料；旧脚本中的 15 项、660×372 和旧 DOM 断言不适用于当前版本。

### 仍需外部条件的验收

- **Harness 真实回复尚未通过**：本机 Harness 凭据文件中的 `version` 类型错误会使子进程退出；本轮只确认仓库、Node 和普通路径探测正常，未擅自修改用户凭据。
- **实际媒体演出尚未验证**：探针链路可运行，但验收时没有正在播放的媒体，需要后续用真实歌曲/视频补测。

因此，`verify4` 全部通过表示本轮核心交互与集成的自动验收通过，不代表上述两个外部场景已成功。

## 六、从源码构建

构建工作区必须保持纯 ASCII 路径：

```text
H:\_rust\catwhale-poc
```

运行：

```bash
bash /h/_rust/catwhale-poc/build.sh
```

工具链和 target 均位于 `H:\_rust\catwhale-poc\toolchain`，不占用 C 盘。release 已配置尺寸优化、LTO 和 strip。

`build.sh` 只把 index、sao、panel、search、chat 五个 HTML 复制到 `frontend-embed` 供 Tauri 内嵌；26 个 WebM 外置到 exe 旁 `frontend/assets`，同时复制 `assets/es.exe`。不要把整个 `frontend` 改回 `frontendDist`，否则视频会进入 PE，使 exe 增加约 65 MiB。

构建完成后，将新 exe、DLL、源码和外置资源同步到交付目录，并重新运行 `verify4.sh`。不要通过重命名旧文件冒充新构建。

## 七、维护注意事项

- 不修改 `H:\hermes project\桌宠` 下仍在使用的 Electron 版。
- main/sao 使用 NOACTIVATE；不要在两个窗口间主动 `SetFocus` 或 `SetForegroundWindow`。
- Esc 仅在菜单打开时由键盘钩子消费，其他按键放行。
- `capabilities/default.json` 必须覆盖 `main`、`sao`、`panel`、`search`、`chat`。
- 本地视频需要 `assetProtocol` 与 `protocol-asset` 同时启用。
- Harness 的 Node 入口使用普通盘符/UNC 路径，不传 `\\?\` verbatim 路径。
- 测试结束清理 HKCU Run 中 `CatwhalePet` 测试自启项，并正常关闭验收实例。
