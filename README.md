# 猫鲸桌宠（catwhale-pet）

一只**透明无边框的 Windows 桌面宠物**：角色素材由绿幕视频抠像 → 统一画布对齐 → 编码成带 alpha 的 VP9 WebM，
再由一个 Electron 应用（透明窗、点击穿透、状态机、SAO 风格菜单、DeepSeek 聊天面板、Everything 文件搜索）驱动。

| | |
|---|---|
| **安装包** | [Releases](../../releases) → `catwhale-pet-v0.1.1-win-x64.zip`：解压后双击 `桌宠.exe`，免安装、免运行库 |
| **网页版演示** | 双击 `web/启动桌宠.bat`，或直接打开 `web/index.html`（网页版与桌面版共用同一套素材与状态机） |
| **许可证** | MIT |

运行环境：Windows 10/11 x64。**安装包不含任何 API key** —— key 由用户自己在设置面板里填，只存在本机
`%APPDATA%\桌宠\settings.json`（Windows 凭据加密）。

桌宠本体（宠物动画、菜单、拖动、托盘、硬件看板）**开箱即用**；另外两个功能各自需要一点本地准备，
桌宠会自己去找，找不到会在设置面板里给出明确提示：

| 功能 | 需要你准备 | 桌宠怎么找 |
|---|---|---|
| 文件搜索 | 装 [Everything](https://www.voidtools.com) 并**保持运行**（Everything 本身不用做任何设置） | `es.exe`（Everything 官方命令行工具）**已随包附带**，不需要你另外下载；实例名 1.4 / 1.5 / 1.5a 自动识别 |
| DeepSeek 聊天 | 一份 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 仓库，**克隆后必须先装依赖**（官方 `pnpm install`，只 clone 不装依赖会报 `Cannot find package 'tsx'`）；Node.js 20+ 可选（没装会退回用 Electron 自带的运行时） | 设置面板「浏览…」直接选仓库根目录最省事；或点「重新探测」按常见布局自动找（含 `git clone` 的默认布局 `<家目录>\deepseek-harness`、`Documents\GitHub\…`、各盘根目录，并会向下探一层）；也认环境变量 `DSH_HARNESS_REPO` |

## 功能

- **8 个状态的状态机**：待机 / 抓着 / 操作中 / 松手落下 / 睁眼摇尾 / 站立抬胳膊 / 闭眼摇尾 / 吃米饭。
  优先级＝拖动 > 菜单打开 > 长任务 > 一次性动作 > 待机空闲阶梯（12 秒没人管就进入随机空闲行为）。
- **交互**：拖动角色＝抓着；单击＝随机互动；右键＝菜单从"抬手指向的那一侧"弹出；单击空白处＝走过去；
  空格＝随机互动；H＝显隐控制面板（大小 120~620px、播放速度 0.5~2.0x）。角色位置和大小自动记住。
- **点击穿透**：角色以外的区域完全不挡鼠标，和平时一样操作电脑。
- **SAO 风格菜单**（右键角色）：卡片式菜单 + 子菜单，Esc 关闭，贴边自动翻面、出屏自动夹回。
- **DeepSeek 聊天**（`Ctrl+Shift+D`）：背后是真·agent 运行时，流式文本 + 工具调用卡片 + 计时 + 取消。
- **文件搜索**（`Ctrl+Shift+F`）：走 Everything 官方命令行 `es.exe`（随包附带），不改动你的 Everything 设置。
- **托盘**：控制面板 / 大小 / 开机自启 / 设置 / 退出。

## 形象来源与致谢

角色的原始形象来自 B 站的二创作品，本项目做的是把它们的画面变成能跑的桌面宠物：

| 形象 | 来源 |
|---|---|
| 猫鲸 | B 站《[[deepseek] 人是猫？！](https://www.bilibili.com/video/BV1KmMy6tEJd/)》 UP：蒙德砍壬 |
| 鲸鱼娘 | B 站 UP：[ZipZipPipe](https://space.bilibili.com/4168597) 的空间 |

形象版权归原作者所有；本仓库的 **MIT 许可只覆盖代码与素材处理管线，不覆盖角色形象本身**。
若原作者对使用方式有异议，请联系仓库作者下架相关素材。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `app/` | Electron 应用源码（`main.js` 主进程、`preload.js`、`harness-client.js` 运行时客户端、`sysinfo.js`、`tools/`） |
| `web/` | 网页版桌宠：`index.html` + 状态机 + **已抠像的透明 WebM**（`web/assets/video/`），不需要打包即可运行 |
| `app/renderer/` | 由 `web/` 同步生成（`npm run sync`），**不入库** |
| `key_clips.py` | 绿幕抠像：逐帧估背景绿度 → alpha → 去溢色，输出带 alpha 的 PNG 序列 |
| `build_sprites.py` | 对齐到统一画布 900×1500、鞋底基线 y=1450；边缘色扩散防绿边；跨片段尺度统一 |
| `encode_webm.py` | 编码 yuva420p / libvpx-vp9 透明 WebM，并生成状态机配置 `states.json` |
| `make_preview.py` | 出交付预览件（棋盘格背景的多状态预览 MP4 / 对比图） |
| `pack_portable.py` / `pack_release.py` | 打便携版 / 发布版（发布版带个人信息与密钥门禁扫描） |
| `tools/` | 开发期自检脚本（渲染器通道检查、菜单几何检查等）；`tools/record/record.js` 是按分镜自动录演示素材的录制器（离屏渲染 + ffmpeg，不录屏、不暴露真实桌面，用法见文件头注释） |

> 说明：本仓库只含**独立 Electron 桌宠**这一条线。同一套素材还做过 Hermes 自带桌宠系统的图集包（8 列×9 行精灵表），
> 那部分脚本依赖开发机本地路径与中间产物，未纳入本仓库。

## 构建

```bash
# 桌面版：开发运行 / 打便携 exe
cd app && npm install
npm run start      # 先同步 renderer 再 electron .
npm run dist       # electron-builder 打单文件便携 exe

# 打包脚本版（不依赖 electron-builder，零额外下载）
python pack_portable.py     # → dist/桌宠/
python pack_release.py      # → dist/桌宠_发布版/ + zip（带个人信息门禁扫描）

# 网页版：不用构建，直接打开 web/index.html
```

素材管线（需要自备绿幕素材，仓库不含原始 MP4）：

```bash
python key_clips.py 素材 build/alpha            # 抠像
python build_sprites.py build/alpha build/sprite # 对齐
python encode_webm.py build/sprite web/assets/video  # 编码透明 WebM + states.json
```

## 版本记录

- **v0.1.1**
  - 设置面板新增 **「浏览…」目录选择**（直接选 harness 仓库根目录；选深了/选浅了都会自动归一到仓库根）与 **Provider** 字段；
  - harness 仓库**自动探测大扩展**：补上 `git clone` 的标准布局 `<家目录>\deepseek-harness`、`Documents\GitHub\…`、`source\repos`、`code\projects\dev\Desktop`，以及各盘根目录与其下一层；探测顺序改为「环境变量 → 家目录布局 → 家目录下探 → 盘符布局 → 盘符下探」；
  - 设置面板显示版本号；《使用说明》补上「harness 克隆后必须先装依赖（`pnpm install`）」「`es.exe` 已随包附带，只需装并运行 Everything」；
  - 新增两个验收自检入口：`--detecttest`（环境探测）与 `--repotest=<目录>`（选目录归一化）。
- **v0.1.0**：首个公开版本（透明桌宠 + SAO 菜单 + DeepSeek 聊天 + Everything 搜索）。

---

以下为开发过程记录（按时间累积，部分早期描述已被后续版本推翻，最新使用方式见上方与 [SAO菜单改进记录](SAO菜单改进记录.md)）。

> **2026-09-19 菜单更新：** SAO 菜单的点击、子菜单、Esc、边缘定位与样式已完善。当前使用方式和验证边界见 [SAO菜单改进记录](SAO菜单改进记录.md)。下文保留历史记录，早期“占位菜单”等描述不再代表当前版本。

# 桌宠项目（绿幕素材 → 透明动画 → Web 桌宠）

素材：`素材/` 下 7 个绿幕 MP4（724×1274，24fps，97 帧，4.04s）。
产出：扣掉绿底、带 alpha 通道的透明动画 + 一个可拖动/可互动的 Web 桌宠，含完整状态机。

---

## 一、快速开始

双击 **`web/启动桌宠.bat`** → 自动起本地服务并打开浏览器。

直接双击 `web/index.html` 也能看（走 `file://`：此时"透明区域不响应鼠标"会退化成矩形，其余一样）。

| 操作 | 效果 |
|---|---|
| 拖动角色 | 切「抓着」状态，拖动中一直保持 |
| 松开鼠标 | 播一次「松手落下」→ 自动回「待机」 |
| 单击角色 | 互动一下（随机「睁眼摇尾 / 闭眼摇尾」）→ 回待机 |
| 右键角色 | 打开/关闭菜单（菜单打开期间保持「站立抬胳膊」） |
| 单击空白处 | 桌宠走过去，之后待机一段 |
| 空格 | 随机互动一次 |
| H | 显隐面板 |
| 面板滑块 | 大小 120~620px / 播放速度 0.5~2.0x |

放 OBS / 录屏用透明背景：`index.html?bg=none&controls=0`；
`?bg=checker` 棋盘格透明预览，`?size=420` 初始大小，`?auto=0` 关掉空闲自动行为，`?debug=1` 面板常显状态，`?menu=1` 打开页面就直接弹菜单（截图/调试用）。

---

## 二、状态机（核心逻辑）

7 个状态，`web/assets/states.json` 里的 `role` 决定它在状态机里的角色：

| 状态 id | 名称 | role | 什么时候出现 |
|---|---|---|---|
| `idle` | 待机 | idle | 默认态；刚换完位置、刚操作完的这段时间 |
| `tail_open` | 睁眼摇尾 | lounge | 长时间没被操作的空闲时段，随机切到它 |
| `tail_closed` | 闭眼摇尾 | lounge | 同上 |
| `working` | 操作中 | task | 长任务处理中（以后接真实任务）；空闲时段也可能随机切进来 |
| `stand_arms` | 站立抬胳膊 | menu | 菜单打开期间（以后换成正式菜单） |
| `grabbed` | 抓着 | drag | 按住并拖动调整位置时 |
| `drop` | 松手落下 | release | 拖到位松开鼠标后播一次（默认 **2 倍速**），播完接待机 |

**优先级（高 → 低）**：拖动 > 菜单打开 > 长任务 > 一次性动作 > 待机/空闲阶梯。
比如长任务正在跑时去拖动，显示的是「抓着」；松手后自动回到「操作中」。

**菜单位置 = 抬手指向的方向**（`index.html` 的 `HAND_TIP`）：

「站立抬胳膊」那只抬起的手，指尖在画布中的相对位置是 **x = 61/900，y = 514/1500**。
菜单竖向对着指尖居中、横向贴在指尖左侧并留 14px 间隙，三角朝向指尖；左侧放不下会自动翻到右侧，出屏会被夹回视口内。
所以菜单永远从"指尖那一侧"弹出来，且不会挡住脸和手。

> 量法（换手部素材后重新量一次即可）：在 `build/sprite/站立抬胳膊` 上做**肤色检测**
> `alpha>127 & R>195 & R>B+18 & R>G+6`，只保留画布左侧（x<300）的那块手，
> 取它的**最左点**（指尖）在 97 帧里的中位值。实测 (61, 514)，逐帧波动 ±16px。

**空闲阶梯**（`resolveState()` 的 5、6 两条）：
1. 任何操作（拖动、单击、点空白、开菜单、任务起止）都会把计时重置 → 回到「待机」，保持 `IDLE_HOLD_MS = 12s`；
2. 超过 12s 没人管 → 进入空闲随机：在 `lounge` 状态（权重 35 / 40）和 `task`（权重 25，即"闲着也会自己忙起来"）之间按权重抽一个，每 7~14s 换一次。

**给后续功能预留的接口**（以后加菜单/长任务直接调，不用改状态机）：

```js
petAPI.openMenu(x, y)      // 打开菜单 → 站立抬胳膊
petAPI.closeMenu() / toggleMenu()
petAPI.startTask()         // 长任务开始 → 操作中（支持并发计数）
petAPI.endTask()           // 长任务结束（计数归零才回待机）
petAPI.react(stateId)      // 播一次性动作
petAPI.setState(stateId)   // 强制切状态（调试）
petAPI.moveTo(x, y) / getState() / getMode()
```

---

## 三、交付物清单

本项目**两条线并行维护**（用户 2026-09 确认：独立 exe 与 Hermes 宠物都要，互不冲突）：

| 线 | 产物 | 说明 |
|---|---|---|
| **A. 独立桌宠程序** | `dist\桌宠\桌宠.exe`（+ `dist\桌宠_便携版.zip`） | Electron 透明全屏置顶窗；网页端素材原样复用 |
| **B. Hermes 宠物包** | `hermes_pet\dist\shouer-maid\`（+ 打包 zip） | 1536×1872 Codex 图集，装到 `%LOCALAPPDATA%\hermes\pets\shouer-maid\`，`hermes pets select shouer-maid` 激活；由 agent 状态驱动（工具执行=操作中、思考=睁眼摇尾…） |

```
桌宠/
├─ web/                      ← 桌宠本体（可整体拷走）
│  ├─ index.html             页面 + 状态机 + 拖动/互动/菜单占位 + 桌面宿主桥
│  ├─ 启动桌宠.bat           一键起服务+开浏览器
│  ├─ _selftest.html         透明视频自检（画布读 alpha 验证解码）
│  ├─ _interaction_test.html 状态机自动化测试
│  └─ assets/
│     ├─ states.json         状态配置（role/权重/时长/额外缩放）
│     └─ video/              7 个透明 VP9 WebM + 首帧预览 PNG（576×960，共 10.5 MB）
├─ app/                      ← Electron 外壳
│  ├─ main.js                透明窗口/托盘/点击穿透/自启/基准台
│  ├─ preload.js             宿主桥（contextBridge）
│  ├─ renderer/              构建时从 web/ 同步（node tools/sync-renderer.js）
│  └─ tools/sync-renderer.js
├─ pack_portable.py          打绿色便携版 → dist/桌宠/ + zip
├─ dist/桌宠/ + 桌宠_便携版.zip
├─ hermes_pet/               ← Hermes 宠物包（第二条线）
│  ├─ make_hermes_pet.py     素材 → 1536×1872 图集（行↔素材映射在文件开头）
│  ├─ make_pet_preview.py    图集标注图 + 九状态动画 mp4 + 实际尺寸对照
│  ├─ dist/shouer-maid/      pet.json + spritesheet.png
│  └─ preview/               三份预览
├─ 交付预览/
│  ├─ 预览_全状态.mp4        7 个状态依次播放，棋盘格底 + 基线参考线
│  └─ 预览_对比图.png        各状态同画布对齐对比
├─ key_clips.py              ① 绿幕抠像 → 带 alpha 的 PNG 序列
├─ build_sprites.py          ② 边缘色扩散 + 尺度/锚点对齐 → 统一画布
├─ encode_webm.py            ③ 编码透明 VP9 WebM（可传 scale/fps 降采样省 CPU）
├─ make_preview.py           ④ 生成预览视频/对比图
├─ build/alpha/             ①的产物（可随时重跑重建）
└─ build/sprite/            ②的产物（统一画布 900×1500）
```

**托盘菜单**（A 线）：显示/隐藏控制面板、回待机、回到底部右侧、大小（240/340/460/620）、
**开机自启（复选框，默认关）**、重新加载界面、退出桌宠。

- 命令行等价物：`桌宠.exe --autostart=on|off`。
- 自启写的是**当前 exe 的路径**；从临时目录（如自解压包）运行时**拒绝写入**并在菜单里置灰
  （否则下次开机会指向一个已消失的路径）。
- 看它开没开：`桌宠.exe --diag` → `resources/app/diag/report.json` 里的 `autostart` 字段，
  或直接看注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。


---

## 四、抠像原理与参数（`key_clips.py`）

**绿度**：`g = G - max(R,B)`。绿幕像素 g≈190~240，角色像素（深蓝/白/肤色）g≤0，中间只有抗锯齿边缘。

1. **逐帧估背景**：取画面外圈 8px 的 g 中位数当该帧背景绿度 `gbg`。
   7 个素材的绿底色值并不一致（实测 176~240，且逐帧有波动），**必须逐帧自适应**，固定色值会漏抠。
2. **软阈值**：`t = g / gbg`，`alpha = 1 - clamp((t-0.15)/(0.55-0.15), 0, 1)`（软边）。
3. **去溢色**：`G = min(G, max(R,B))`，只改动被绿幕污染的边缘像素。

只想重抠某几个片段：`python key_clips.py 素材 build/alpha 抓着 松手落下`

## 五、缩放与对齐规格（`build_sprites.py`）

各素材机位/画幅/人物大小都不一致，不统一就会出现"切动作时人忽然变大变小、脚忽然离地"。

画布 **900×1500**，基线（鞋底）**y=1450**，水平中心 **x=450**。上方留 250px 是给「抓着」的：那只手要伸到画面上方，不留白会被画布顶边切掉。

1. **边缘色扩散**：全透明像素的 RGB 用最近的不透明像素颜色填充。不做这步，缩放和视频压缩会把透明区的颜色渗进边缘，出现黑边/绿边。
2. **鞋底取样必须避开「画在地上的接地阴影」**（踩过的坑）：
   素材在脚下画了一层接地阴影，它的核心**又深又完全不透明**（亮度 20~50、alpha 255），
   所以 alpha 和亮度都分不开——按「alpha>127 且行宽≥60」取样会取到阴影底，
   整个角色被抬高 **14~18px**，看起来浮在地面上。
   能分开的是**颜色**：鞋子是深蓝（`B-R ≥ 6`），阴影是中性灰（`B-R ≈ 0`）。
   鞋底行 = 从下往上第一个「有 ≥20 个深蓝像素」的行。
   实测修正量（源图像素）：待机 −18 / 操作中 −18 / 闭眼摇尾 −16 / 松手落下 −16 / 站立抬胳膊 −14 / 抓着 −4。
3. **尺度统一**（`ANCHORS`）：
   - 站立类片段：以「鞋底往上 50 行内的横向宽度」为尺度不变量（双脚站立最稳，不受抬胳膊/摇尾影响），全部归一到鞋宽 200px；
   - 「抓着」「松手落下」两段素材里人物偏小，按人工实测放大到原尺寸的 **1.2 倍**（放完正好和站立素材一样大）。
4. **锚点对齐**（`mode`）：当前 7 个状态**全部**用 `sole`——鞋底（深蓝判据）对齐到基线 y=1450。
   锚点默认取**第一帧**的鞋底（配置 `ref_frame=-1` 时取末帧；「松手落下」用它保证落地那一下正好踩在基线上）。
   （代码里另留了 `crown`＝按头顶对齐、`mid`＝按头脚中点对齐两种模式，需要时可用。）

对齐实测（避开阴影取样 + 1.2 倍之后，三个状态几乎重合）：

| 状态 | 头顶 y | 鞋底 y | 身高 |
|---|---|---|---|
| 待机 | 305 | 1450 | 1146 |
| 抓着（被提起） | 305 | 1450（脚尖；手从画布右缘出画） | 1145 |
| 松手落下·末帧 | 299 | 1450 | 1151 |

五个站立状态的鞋底实测都落在 1448~1452（基线 1450），"落下 → 待机"的接缝基本看不出来。

> ⚠ 缩放只在这一步做一次并烘进 sprite。`states.json` 里的 `scale` 是页面上的**额外**微调，必须保持 `1.00`，
> 否则会二次放大（烘 1.2 再乘 1.2）。

## 六、编码（`encode_webm.py`）

VP9 + `yuva420p` 写进 WebM，浏览器 `<video>` 直接播透明通道（Chrome/Edge/Firefox 均支持）。同一个脚本顺便生成 `states.json`。

- `-auto-alt-ref 0 -lag-in-frames 0`：VP9 的 alt-ref 帧与 alpha 不兼容，必须关。
- alpha 保真度实测 **0.04/255**（近乎无损），不透明区 RGB 误差 ~2。
- `rate`：状态自己的播放速率（`states.json` 里配，会与速度滑块相乘）；「松手落下」默认 **2.0**。
- 依赖 ffmpeg 的 `libvpx-vp9`。⚠ **验证 alpha 时必须加 `-c:v libvpx-vp9` 指定解码器**
  （`ffmpeg -c:v libvpx-vp9 -i idle.webm -frames:v 1 out.png`），
  ffmpeg 自带的原生 vp9 解码器**不读 alpha**，会得到全不透明的结果，会被误判成"alpha 丢了"。
- 降采样/降帧省 CPU：`python encode_webm.py build/sprite web/assets/video 24 0.64 15`（scale=0.64、fps=15）。
- 只重编某几个片段：后面追加中文片段名，例如 `... 24 0.64 24 闭眼摇尾`
  （此时 `states.json` 会**合并**进旧记录，不会把其它状态写没）。

### 末尾静止帧修剪（`TRIM_TAIL`）

AI 生成的片段常在结尾**定格几帧**；循环播放时这段定格就是肉眼可见的"卡一下"。
判据、切点都用数：**帧间差**（相邻帧平均绝对差）掉到全片中位的 10% 以下即为静止。

实测「闭眼摇尾」末尾 **90~96 共 7 帧完全静止**（|Δ|≤0.1，中位 5.19）→ 每循环白等 **0.29 秒**。
保留前 **90 帧**后（`TRIM_TAIL={"闭眼摇尾": 90}`）：末尾静止帧 **7 → 0**，循环接缝 |末帧→首帧| = **0.79**
（= 0.15× 中位，与修剪前的 0.82 同级，接得上、不跳变）。视频 97 帧/4.04s → **90 帧/3.75s**。

- **只改视频编码，不动 `build/sprite` 源帧** —— Hermes 图集按帧号取样（0/16/32/48/64/80），不受影响。
- 其余 6 段量过：没有硬静止（结尾只是略微减速，如「待机」末 3 帧 |Δ|≈0.9~1.3 = 中位的 17~25%），
  所以没动。要一起修就把片段名加进 `TRIM_TAIL`。

---

## 七、改素材 / 加动作

**换或加绿幕素材**：把 mp4 丢进 `素材/`，依次跑三条命令（`build_sprites.py` / `key_clips.py` 支持只处理指定片段）：

```bash
python key_clips.py 素材 build/alpha
python build_sprites.py build/alpha build/sprite
python encode_webm.py build/sprite web/assets/video 24    # 同时刷新 states.json
```

**加一个状态**：在 `encode_webm.py` 的 `STATE_MAP` 里加一条（中文素材名 → id/role/权重），
或者手工把 webm 放进 `web/assets/video/` 并在 `web/assets/states.json` 加一条：

```json
"new_state": { "name":"动作名", "file":"new_state.webm", "mode":"once", "role":"release",
               "duration":4.04, "scale":1.0, "rate":1.0, "weight":20, "react":30 }
```

- `mode`：`loop` 循环 / `once` 播一次；
- `role`：决定优先级角色，可取 `idle / lounge / task / menu / drag / release`（新角色要在 `index.html` 的 `resolveState()` 里加分支）；
- `weight`：空闲时段被抽中的权重；`react`：被单击互动时抽中的权重（不填就不会被抽到）；
- `rate`：该状态自己的播放速率，例如「松手落下」= 2.0（不填按 1.0）。

注意**状态 id 要和 states.json 的键名完全一致**（页面里写 `wave` 而配置叫 `stand_arms` 这类不一致会静默失效；已有兜底：认不出的 id 退回随机动作）。

---

## 八、性能（CPU 占用）与调优记录

真实桌面实测下来 CPU 偏高，逐项定位后改了 4 处，**根因是「不用的视频没 pause」**：

| 优化 | 改前 | 改后 | 证据 |
|---|---|---|---|
| **① 切换状态时 pause 上一个视频** | 每激活一个状态就永久多一路解码，跑一会儿 7 路全在解 → **188% 单核**（≈2 个核） | 始终只解 1 路 → 稳态实测 **~12~27% 单核** | 基准台 A/B 阶段：1 路 1.5% vs 6 路 5.0%（Electron 自身进程指标）；OS 级 CPU 时间 5.5 vs 13.25 CPU秒/7.1s |
| **② 视频降采样 900×1500 → 576×960** | 单段实时解码耗 **9.6% 单核** | **3.3% 单核**（2.9×），体积 21.5→10.5MB | `ffmpeg -benchmark -c:v libvpx-vp9` 逐段实测（与 Chromium 同款解码器） |
| **③ 调试用 60fps rAF 循环不再启动** | 全屏透明窗被 60 次/秒唤醒合成器 | 桌面宿主里根本不启动（浏览器 Demo 里仍保留 fps 读数） | 代码位置：`if (!window.petHost \|\| opt.debug)` |
| **④ 窗口隐藏/最小化时暂停解码** | 看不见也在解码 | `visibilitychange` → pause，恢复可见再 play | — |

补充说明：

- **VP9 透明视频只能软解**（硬件解码器不支持 alpha），所以解码开销≈与像素数成正比 → ② 是最有效的第二档。
- 再低可以降到 15fps：`python encode_webm.py build/sprite web/assets/video 24 0.64 15`（单段 3.3%→2.3%，画面会稍顿）。
- **不要**用"任务管理器里看一眼"来判断这类优化：这台机器上同一配置连续三次测出来是 26.6% / 16.4% / 2.3%（系统里其它程序的噪声比配置差异大一个量级）。
  要么用 `ffmpeg -benchmark` 这种隔离仪器，要么用 `--bench` / `--benchlite` 基准台固定状态测（`--fixed=idle`）。
- 已实测**不需要**做的：把全屏透明窗缩成桌宠大小（多次对比无稳定收益）、给 mousemove 加节流
  （`elementFromPoint` 本身就便宜，而节流会让"快速移入+点击"漏掉 50ms 抓不住角色）。这两项都试过并撤回。

基准台用法（诊断用，不影响正常使用）：

```
electron . --benchlite --fixed=idle     # 固定状态测稳态
electron . --bench                      # 五阶段：初始/7路全解/只留当前/停FPS循环/窗口隐藏
结果写 app/diag/bench.json
```

## 十、功能：文件搜索（Everything）+ DeepSeek 聊天（Harness）

两个功能都做成**贴角色左侧、不遮挡角色、竖向中心对齐**的面板（`placePanel()` 统一摆位），
打开时桌宠演「站立抬胳膊」；harness 干活时演「操作中」（优先级高于菜单）。

### 10.1 文件搜索（Everything）

- 后端在 Electron 主进程调 **voidtools 官方 es.exe**（随程序附在 `app/assets/es.exe`），走 IPC 查询，
  **不改用户 Everything 的任何配置**。
- 三个实测坑（都已在代码里处理）：
  1. **es.exe 输出是 GBK**（中文路径按 utf-8 解会炸）→ 必须 `new TextDecoder('gbk')` 解码（Node 自带 full-icu）。
  2. **Everything 1.5 便携 alpha 版**的 IPC 窗口类带后缀 `EVERYTHING_TASKBAR_NOTIFICATION_(1.5a)`，
     es.exe 默认只找不带后缀的老窗口 → 报 `Error 8: IPC window not found`。所以启动时**自动探测实例名**
     （`''`/`1.5a`/`1.5`/`1.4`，第一个能出结果的记住并写进 `pet-state.json` 的 `esInstance`）。
  3. es.exe 失败时**仍然打到 stdout 且退出码 0** → 必须按内容判错。
- 查询用 `-csv -full-path-and-name -extension -size -dm -date-format 1 -size-format 0 -n 30`，
  自己解析 CSV（含引号/逗号/中文）。
- 交互：输入防抖 140ms、竞态用序号丢弃过期响应、↑↓ 选择、Enter 打开、Ctrl+Enter 打开所在文件夹、Ctrl+C 复制路径、Esc 关闭。
- **入口**：托盘菜单「🔍 文件搜索…」/ 双击托盘图标 / 右键桌宠菜单 / 全局热键（见下）。

### 10.2 DeepSeek 聊天 = 真·harness 客户端（长驻 SDK 协议，流式）

**不是"调一次 CLI 取答案"**，而是把 harness 当成常驻后端驱动——这样桌宠的对话界面**就是 harness 界面本身**。

- 机制：harness 自带对外协议 `packages/sdk`（stdio 换行分隔的 JSON-RPC 2.0）。
  用一个**补丁层**把 `@deepseek-ai/dsh-sdk-jsonrpc-server` 挂到官方 headless 组合上，
  同时把 `headless-startup` 与 `headless-runner` 两行 disabled（否则它强制要任务参数、并把答案打到
  stdout 撕碎 JSON-RPC 帧）。补丁：`app/harness-sdk/pet-sdk.patch.yml`（随包分发）。

  ```bash
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
       --patch app/harness-sdk/pet-sdk.patch.yml
  ```

- 客户端：`app/harness-client.js`（自写，零依赖，~300 行）。事件 → UI 的映射：

  | harness 事件 | 桌宠里的表现 |
  |---|---|
  | `assistant/chunk` `text-delta` | **打字机式流式输出**（带光标） |
  | `tool/call` / `tool/result` | 工具卡片：调了什么工具、参数、返回值（可展开） |
  | `assistant/chunk` `usage` | token 计量（输入/输出/cache） |
  | `session/title` | harness 自动起的会话标题，显示在状态条 |
  | `session.status` running/idle | 桌宠演「操作中」/ 恢复待机；状态条上的状态点 |
  | `turn/end` reason.kind=error | **明确报错**（不会再"等半天没动静也不说"） |
  | `assistant/message` | 以提交版文本为准，纠正流式内容的漂移 |

- **冷启动 ~5~7 秒**（tsx 转译 + 插件树装配），只发生一次（首次打开聊天时）；
  之后每条消息只有模型自己的耗时。空闲 15 分钟自动回收，下次发消息自动重启。
- **会话与上下文**：同进程内是**真正的 harness 会话**（多轮记忆由 harness 自己维护）。
  实测 `sessionId` 与进程绑定：换个进程复用同一 id 会报
  `already has a persisted log on disk that does not match this live session (id collision)`，
  所以每次启动用新 id；跨重启的上下文用「首条消息内联最近 6 轮」+ harness 自己的持久记忆兜住。
- **取消**：协议没有 cancel/close 方法 → 取消 = 杀掉运行时（会话日志已在盘上），下次发消息自动重启。
  实测取消后**无孤儿 node 进程**（`before-quit` 也会优雅 shutdown）。
- 对话记录另存 `%APPDATA%\桌宠\chat-history.json`（界面渲染用，跨重启保留）。
- 配置（写在 `pet-state.json`，不硬编码）：`harnessRepo`（默认空串，由用户在设置面板里填自己的
  harness 仓库路径，或用环境变量 `DSH_HARNESS_REPO`）、
  `harnessProfile`（默认 `headless`）、`harnessPatch`、`harnessCwd`、`harnessProvider`/`harnessModel`
  （默认读 `~/.dsh/settings.yaml` 的 `agent-default-model`）、`harnessMaxTokens`（默认 8192）。

- **实测案例（"看今天天气"）**：真去抓了中国天气网 / wttr.in / Open-Meteo 做交叉核对，
  给出实况 26.9℃ 晴、AQI 80 良、今日 20~29℃、明日阴转雷阵雨——**耗时 58 秒**。
  这条正是"发了消息以为没回复"的真相：任务本身要联网多源查询，而旧界面全程零反馈。
  现在流式文本 + 工具卡片 + 秒数 + 取消按钮都在，能看到它在干什么。

### 10.3 入口与热键（注册失败会自动降级到下一候选）

| 功能 | 托盘/菜单 | 全局热键（实测注册到的） |
|---|---|---|
| 文件搜索 | 托盘「🔍 文件搜索…」/ 右键桌宠「🔍 文件搜索…」 | **Ctrl+Shift+F** |
| DeepSeek 聊天 | 托盘「💬 和 DeepSeek 聊天…」/ 右键桌宠「💬 和 DeepSeek 聊天…」 | **Ctrl+Shift+D** |

热键候选表在 `main.js` 顶部（`SEARCH_HOTKEYS` / `CHAT_HOTKEYS`）；Ctrl+Alt+F 在本机被别的程序占用，所以自动退到了 Ctrl+Shift+F。

### 10.4 自检入口（改完必跑）

```bash
# 后端自检（不起界面）
桌宠.exe --searchtest="ext:pdf"                       # Everything 查询 → 打印 JSON
桌宠.exe --detecttest --exit-after-test               # 环境探测：harness 仓库 / es.exe / node 来源 / 版本
桌宠.exe --repotest="D:\\deepseek-harness\\src\\apps\\cli\\src" --exit-after-test   # 验"浏览…"选目录后的归一化
桌宠.exe --chattest="只回答两个字：成功"                # harness 聊天 → 打印 JSON
# 界面自检（真渲染器里跑完整链路，结果打到 stdout，可加 --exit-after-test）
桌宠.exe --searchui="桌宠"                             # 开搜索面板 → 灌查询 → 读回渲染结果+几何
桌宠.exe --chatui="你好" --chatwait=60000              # 开聊天面板 → 发送 → 等真回复 → 读回
桌宠.exe --chatui="写篇长文" --chatcancel=3500          # 测取消：3.5 秒后点"取消当前请求"
```

⚠ 起测试服务时**别用 8899**：本机 `MiPCAudio.exe`（小米电脑管家）占着 `0.0.0.0:8899`，
自绑 `127.0.0.1:8899` 会被它顶掉/串线（表现是 curl 返回 000、预览页空白）。用 `8917` 之类没人用的端口：
`python -m http.server 8917 --bind 127.0.0.1`（在 `web/` 目录下）。

状态机回归自检：浏览器打开 `web/_interaction_test.html`（真实渲染，11 组 / 56 项断言，含两个面板的
"不遮挡角色 / 在角色左侧 / 垂直居中 / 打开时演站立抬胳膊 / harness 处理中演操作中"）。

---

## 九、已知限制 / 后续可做

- **这版是网页 Demo**：浏览器窗口本身不透明，做真正贴桌面的桌宠要套 Electron 透明无边框窗口
  （`transparent:true, frame:false, alwaysOnTop`，页面直接用 `?bg=none&controls=0`），素材原样复用。
- 菜单是**占位**的（右键/面板按钮触发，只有几个演示项），以后换成正式菜单时只要调 `petAPI.openMenu/closeMenu`。
- 长任务也是手动模拟（面板"模拟长任务"10 秒），接真实任务时调 `petAPI.startTask/endTask`。
- 备选方案：用围裙上的「像素鲸鱼」图案做对齐。它的**尺寸**在 AI 生成的不同片段间会差 3~11%（图案被重画过），
  而且「站立抬胳膊」被手挡住、「操作中」被电脑挡住，所以最终没采用（鞋底判据更稳、每帧都可用）。
- 「抓着」素材本身把手臂切在画面右上边缘，所以手臂会"从画布右缘出画"（源视频里就是切在画面边缘上），
  这是素材自带的，不是抠像问题。
- 素材是 AI 生成的，同一角色在不同片段里比例略有出入；「抓着」「松手落下」当前按 **1.2** 倍放大
  （用户实测值）。想换倍率改 `build_sprites.py` 的 `ANCHORS` 重跑即可。
- 摇尾两段首末帧不完全严丝合缝（alpha 差 0.24~3.3），单次播放看不出来；要无缝循环可做首尾交叉淡化。

## 十一、交互调整（按用户反馈改的，别再改回去）

| 反馈 | 处理 |
|---|---|
| "鼠标点击自动移动到位置，误触概率非常大" | **取消**"点空白走过去"。根因：全屏透明窗在"可交互/穿透"之间有切换延迟，鼠标刚从角色上移开就点击时那一下会落进页面 → 角色被瞬移。现在点空白只关面板。 |
| "发了消息 30 秒没回复，想关又按 Esc 关不掉" | ①**Esc 修复**：原来面板打开时全局快捷键处理器会提前 return，把 Esc 吃掉；现在 Esc 在文档级处理，且**面板打开期间主进程临时注册全局 Esc**（窗口失焦也能关）。②反馈问题：现在有流式/工具卡片/秒数，且 harness 报错会显示出来。 |
| "只能右键菜单重新点一次聊天再按 Esc 才能关" | 同一根因（焦点 + Esc 被吃掉），已一并修复。 |

## 十二、发布版（可以直接发给别人用）

`python pack_release.py` → `dist\桌宠_发布版\` + `dist\桌宠_发布版.zip`。
与"自己用的便携版"（`pack_portable.py`）的区别：

| | 便携版（自己用） | 发布版（发出去） |
|---|---|---|
| 开发文档 README.md | 带 | **不带** |
| 开发工具 tools/、harness 探针脚本 | 带 | **不带** |
| Electron 语言包 | 全部 55 个 | **只留 zh-CN + en-US**（省 48MB → 381MB 变 333MB，zip 164MB → 152MB） |
| 个人信息扫描 | 无 | **出包前硬门禁**：扫到 API key / 用户名 / 个人路径 / 业务敏感词就拒绝出包 |
| 首用说明 | 简版 | 完整版（含"key 填在哪、需要装什么"） |

**发布版怎么做到"集成 harness/Everything 但不含我的个人信息"**：

1. **API key 从不进包**：key 由使用者自己在桌宠的**设置面板**里填，只存本机
   （`%APPDATA%\桌宠\settings.json`，Electron `safeStorage`＝Windows 凭据加密），
   运行时通过**环境变量** `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 注入给 harness
   （harness 的凭据优先级：继承环境 > 它自己的 `$DSH_HOME/.credentials.yaml`），
   所以既不用改使用者的 harness 配置，也不会把 key 写进随包文件。
   *实测*：把网址改成 `https://selftest.invalid` → 报 `DeepSeek API request to https://selftest.invalid failed`（证明设置真的注入了）；
   清掉后恢复正常（证明清除后走使用者自有凭据）。
2. **harness 仓库位置自动探测**：配置 → `DSH_HARNESS_REPO` → 常见位置（`%USERPROFILE%\deepseek-harness\src`、`C:/D:/F:` 各盘）；
   找不到就在聊天面板给明确指引。
3. **Everything 集成**：随包带官方 `es.exe`，用使用者本机的 Everything（自动探测实例名 1.5a/1.4）；
   没装 Everything 时搜索不可用，其它功能不受影响，设置面板里会显示状态。
4. **扫不到个人信息才算过**：`pack_release.py` 出包后会自动复扫（也可单独跑
   `python pack_release.py --scan-only dist\桌宠_发布版`）。

**发布版实测**（在成品目录里跑）：通道检查 CHANNELS-PASS ✔ / Everything 搜索真结果 ✔ /
harness 聊天回复"都正常"(9.0s) ✔ / 页面自检 idle 无错误 ✔ / 设置面板回显与几何正确 ✔

## 十三、事故复盘：打开面板后同屏窗口全都点不动（2026-09-19）

**症状**：一进行 DeepSeek 对话，屏幕上其它窗口都点不动了（关掉面板也不恢复）。

**根因（两处叠加，都在"面板打开"这条路径上）**：
1. `web/index.html` 的交互判定写成 `M.dragging || M.menuOpen || M.searchOpen || M.chatOpen ? true : uiHitAt(...)`
   —— 面板一开就把**整个全屏窗口**标成"可交互" → `setIgnoreMouseEvents(false)` → 整块屏幕吞鼠标。
   正确做法：只有 `M.dragging` 才强制 true，其余一律走 `uiHitAt()`（面板/菜单区域本来就覆盖得到）。
2. `app/main.js` 的 `pet:focus` 处理器里写着 `win.setIgnoreMouseEvents(false)`（开面板时抢焦点顺手关穿透）
   且关闭时**没有对称恢复** → 状态卡死。
3. **加重项**：`ipcMain.on('pet:interactive')` 与 `ipcMain.on('pet:save')` 在一次大块代码替换中被**静默删除**了
   （它们不是 function 声明，`node --check` 和"未定义函数扫描"都抓不到）→ 于是"恢复穿透"的路径整条消失，
   首次打开面板后**永久**吞鼠标。

**修法**：交互态只由命中测试决定；`pet:focus` 只抢键盘焦点、不碰鼠标穿透；补回两个处理器；
面板开关时立刻重算交互态；不知道光标位置时按安全侧（穿透）。

**防回归**：
- `node tools/check-channels.js` —— 按 preload 的通道清单核对 main 侧处理器是否齐活，
  并检查 `setIgnoreMouseEvents` 调用点数量（>2 就是警号）。反向对照已验：删掉处理器它会精确报错。
- `web/_interaction_test.html` 第【13】组：面板开着 + 光标在空白 → 必须穿透；在角色/面板上 → 必须可交互。

**验证方法（不靠日志自证）**：
- `桌宠.exe --clicktest=blank|pet|panel [--clickat=x,y]` → 开面板、把合成鼠标移到指定点、打印命中结果并每秒汇报交互态。
- 外部用**真光标 + 真点击**复核：`SetCursorPos` 移动（Python 侧必须先 `SetProcessDpiAwareness(2)`，
  否则坐标被系统虚拟化、测出来的位置全是错的）、`mouse_event` 点击，然后读 `GetForegroundWindow`：
  面板开着时点空白 → 前台应是别的窗口（记事本 ✔）；点角色 → 前台回到桌宠（角色拖得动 ✔）。
- 注意：`WindowFromPoint` 探不到这种分层/透明窗（会被跳过），别拿它当证据。

## 十四、已知限制

- 冷启动 5~7 秒（tsx 转译）；要更快可先把 harness `pnpm run build`，改走构建产物启动。
- 协议无 cancel/close：取消 = 杀进程重启（可接受，代价是下次要重新启动 + 新会话）。
- `sessionId` 跨进程复用会被拒（id collision），故重启后上下文靠内联历史 + harness 持久记忆。
- 回复的 markdown 只做了极简渲染（代码块 / 行内码 / 粗体）。
