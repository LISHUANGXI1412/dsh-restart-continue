# dsh-restart-continue

让 DSH 里的 Agent 自己重启 DSH Desktop，并在新进程启动后**自动回到同一个会话继续对话**。

> npm 包名：`dsh-restart-continue`（`dsh-restart` 已被他人占用，源码目录仍为 `E:\dsh的工作区\dsh-restart`）。

## 解决的问题

装插件、改配置、换原生依赖之后，DSH 经常需要重启才能生效。原来的流程是：

1. Agent 说“需要重启”；
2. 用户手动重启；
3. 用户回到会话，再补一句“继续”。

这个插件把 1→3 串起来：Agent 调一次工具，重启完成后插件自己往会话里投递一条续聊指令，Agent 接着干。**全程没有确认弹窗、不需要点任何东西。**

## 工作方式

```
工具调用 dsh_restart
   │  ① 拒绝：其他对话有 turn 正在运行（重启会打断它们）
   │  ② 写 hand-off 文件 ~/.dsh/restart/continuation.json
   │  ③ 挂一个一次性 agent/status 监听
   ▼
本轮结束（Agent 进入 idle）
   │  ④ 再次检查：这期间有没有别的对话开始跑
   │  ⑤ flush 当前会话，保证最终消息落盘
   │  ⑥ 写 launch.vbs（UTF-16LE + BOM）并启动 wscript.exe
   ▼
wscript（GUI 子系统，无控制台）
   └→ WScript.Shell.Run(..., 0, False) 隐藏启动 PowerShell worker
        ├─ 清掉 ELECTRON_RUN_AS_NODE（否则新进程变成 Node 模式秒退）
        ├─ 优雅 taskkill 主进程（WM_CLOSE）
        ├─ closeToTray 只隐藏窗口 → forcing：先 kill Host，再 kill 主进程
        └─ 用原始命令行重新启动 DSH NEXT.exe
   ▼
新进程启动，插件读到 hand-off 文件
   │  ⑦ 校验：记录早于本次启动 + 10 分钟内 + 尝试次数 < 3 + 同 Profile
   │  ⑧ 用 sessionController.prompt(..., mode: 'queue') 投递续聊消息
   ▼
原会话恢复上下文，开一轮新 turn 继续工作
```

几个刻意的设计：

- **不用桌面壳的重启确认框**：`desktopActions.requestRestart()` 会弹 Electron 原生对话框，而且默认按钮是「取消」。静默重启走“优雅关闭 + 重新拉起”，窗口会关掉再打开，约 3~8 秒。
- **为什么是 wscript 而不是直接 spawn PowerShell**：Node 用 `detached: true` 启动 PowerShell 会在执行脚本前静默退出；普通子进程又会跟着父控制台一起被销毁。`wscript` 是无控制台的 GUI 宿主，配合 `WScript.Shell.Run(cmd, 0, False)` 能拉起一个独立、隐藏、继承正确用户环境的 worker。
- **VBS 必须 UTF-16LE + BOM**：否则 `WScript` 按 ANSI 读，`C:\Users\木\...` 这类中文路径会被读坏。
- **必须清 `ELECTRON_RUN_AS_NODE`**：桌面壳用 Node 模式启动 Host，会把 `ELECTRON_RUN_AS_NODE=1` 注入 Host 环境；worker 继承后若原样传给 App，Electron 会以纯 Node 运行、没有脚本参数就立即退出（表现为“拉起后秒退、什么都没发生”）。
- **等本轮结束再重启**：tool result 和最终回复先落盘，重启不会吞掉它们。
- **其他对话在跑就拒绝**：调度时检查一次，真正触发前再检查一次；有别的 Agent 正在跑 turn 就放弃重启（只记日志，不强制）。
- **只认“比本次启动更早”的记录**：10 分钟过期、最多跨启动重试 3 次，避免复活旧会话或陷入重启循环。
- **续聊走公开审计路径**：消息以普通 user message 出现在对话里，头部标注 `[DSH 自动重启 · 已完成]`。
- **插件 dispose 不删 hand-off 文件**：Host 关闭时插件会被卸载，只有 `cancel` 或成功续聊后才删。

## 安装

```powershell
plugin_manager install_bundle E:\dsh的工作区\dsh-restart
```

插件改代码后：在 Settings → Plugins 里把它关掉再打开即可热重载（不必重启 Host）。

## 用法

```json
{ "action": "restart", "reason": "plugin 已升级", "prompt": "重启后继续验收 Settings 面板" }
```

- `action: restart`（默认）：预约重启。
- `action: status`：只读，报告重启能力（`silent-app-relaunch` / `desktop-confirm` / `unsupported`）、正在跑的对话、挂起请求、hand-off 路径。
- `action: cancel`：撤销挂起的请求（同时删掉 hand-off 文件）。

Agent 侧约定：调用完工具后**正常结束本轮**，不要在本轮里等重启。

## 限制

- **静默重启仅 Windows**：靠 `taskkill`（WM_CLOSE）+ 重新拉起实现。macOS/Linux 会退回桌面壳的 `requestRestart()`，那一步需要用户确认。
- **重启 = 整个 App 退出再启动**：窗口会关掉；正在跑的**其他**对话会被拒绝保护，但已经打开的其他会话页面会一起重载。
- **10 分钟有效窗口**：超时后不会续聊（会话本身不受影响）。
- **续聊是 user message**：会以用户消息出现在对话里。
- **`closeToTray` 开启时**：优雅关闭会变成隐藏窗口，助手等 12 秒后强制结束进程再拉起。

## 验证状态

- 单元测试：`node --test`，18 项全过（状态过期、启动先后、重试与放弃、续聊文本、运行中对话守卫）。
- `dsh_restart action=status` 在 DSH Desktop 返回 `silentRelaunch: true`、`mode: "silent-app-relaunch"`。
- **端到端实测通过**（2026-11-15 18:28）：Agent 调用工具 → 本轮结束后窗口自动关闭 → worker 重新拉起 App（`relaunch.log`：`clearing ELECTRON_RUN_AS_NODE=1` → `graceful quit timed out; forcing` → `relaunch attempt 1 pid=24700` → `done started=True`）→ 新 Host 启动 → 同一会话自动注入续聊消息并继续。
- **守卫实测**：另起一个子会话跑长任务时，`status.runningAgents` 列出它，`action=restart` 返回 `ok:false` 并给出 `running` 列表，不重启。

