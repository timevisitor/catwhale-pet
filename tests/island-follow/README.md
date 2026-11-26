# 灵动岛跟随 / 拖动：冒烟 / 对比 / 端到端

四组可复跑的检查，全部**不联网、不读通知、不碰用户 %APPDATA%**（用隔离 userData，
`hasHubNotify` 恒 true 使通知探针不启动；拖动 e2e 另把 `infohub.json` 的 enabled 置 false）。

## 1. 纯逻辑：上报器与拖动口径

```bash
node --test tests/island-anchor.test.cjs        # 按帧合并 / 只在变化时发 / 头顶扫描节流 / 呼吸不算移动
node --test tests/island-anchor-state.test.cjs  # 主进程采纳策略 + 重启恢复 + 松手落盘
node --test tests/island-wiring.test.cjs        # 真实页面/主进程的接线（谁该调谁，旧的轮询是否拆干净）
node --test tests/island-drag.test.cjs          # 拖动落盘 / 重启还原 / 贴边不回写 / 球↔胶囊底边不动 / 空闲 0 setBounds
node --test tests/island-drag-wiring.test.cjs   # 拖动在页面/preload/主进程的接线
```

## 2. 对比：祖先版 vs v0.7.1，同一条轨迹

需要一棵 e9a9f77 的导出树作对照（只读，不动旧工作树）：

```bash
git -C <repo> archive e9a9f77 | tar -x -C <repo>/../_env/base
node tests/island-follow/run.cjs --compare          # 约 40s（两次各 15s + 启动）
```

它会起两个 Electron 冒烟进程（窗口 `setOpacity(0)`，屏幕上不出现东西），用同一个合成桌宠页
跑「慢走 130px/s 3.5s → 快拖 500px/s 1.5s → 走下来 1.5s → 静止 5.5s」，
采样 20ms：真值取页面里角色的真实矩形与静态头顶，落点取岛窗口的 `getBounds()`。

输出：`<repo>/../_logs/island-follow/{base,new}.json` + `compare.txt`。

## 3. 端到端：候选包内启动 + 真实链路

```bash
node tests/island-follow/e2e-real.cjs --bootonly   # 只验证「包能起来、桌宠页与岛页都在」
node tests/island-follow/e2e-real.cjs              # 再用 CDP 驱动真实 place() 走一段，量误差
```

`--remote-debugging-port` 连两个 target（桌宠页 / 岛页），在桌宠页里用 rAF 调真实的 `place()`，
同时按 20ms 采样。隔离 userData 里预置 `island.json{msg:false,music:false,video:false}`，
所以它**绝不会启动通知探针**。结束后只 `taskkill` 自己起的那棵进程树。

## 4. 拖动端到端：真实候选包

```bash
node tests/island-follow/e2e-drag.cjs --phase after   # 两次落点 / 拖宠 / 重启 / 短点击 / 缩放 / 贴边 / 空闲
node tests/island-follow/e2e-drag.cjs --exe <旧包> --phase before   # 旧包应失败（无拖动入口）
```

输入用 `Input.dispatchMouseEvent`（渲染进程级合成事件，不移动系统物理鼠标），
窗口几何从岛页面 `screenX/screenY/outerWidth` 读，落盘值直接读隔离 userData 的 `island.json`，
期望落点由测试按文档几何独立复算。输出 `../_logs/island-drag/e2e-<phase>.json`。

## 未覆盖

Windows 显示缩放 100%/200% 切换、拖动过程中切换 DPI、游戏模式下的隐藏恢复、长时间巡游的内存/CPU 曲线。
多显示器只覆盖了「拖到第二块屏的贴边夹取」，未做跨屏 + DPI 组合。
