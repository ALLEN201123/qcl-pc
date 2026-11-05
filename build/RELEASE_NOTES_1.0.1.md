# QCL 电脑版 1.0.1

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-Setup-1.0.1.exe`**（约 128 MB，中文自解压安装程序）← 本 Release 的 Assets
- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0

装完在「设置 → 关于」里应显示 `QCL 1.0.1`。装之前请先关掉正在运行的旧版 QCL。

> 说明：GitHub 会过滤 Release 资产名里的中文，因此附件用 ASCII 名 `QCL-Setup-1.0.1.exe`；
> 它与本地 `QCL-安装程序-1.0.1.exe` 是同一个文件。

---

## 本版修复

### 远古 / 老版本启动窗口不关（实机反馈）

**现象**：b1.7.3（以及 1.0~1.12 这些老式 LWJGL 2 版本）游戏窗口早就出来了，
启动窗口却一直卡在「等待游戏窗口」，直到玩家自己退出游戏都不关。

**根因**：就绪判据只认现代版的
`Sound engine started` / `blocks.png 图集`，以及老版弱信号 `LWJGL Version:` / `Starting Minecraft:`。
而 b1.7.3 的真实日志是：

```
18:50:01  Loading current icons for window from: ...icon_16x16.png   ← 窗口已建好
18:50:03  Starting up SoundSystem... / Initializing LWJGL OpenAL
18:50:04  OpenAL initialized.                                        ← 音频与主循环就绪
18:50:52  Stopping!（玩家自己退的游戏）
```

这几行**一条都不匹配**旧判据，所以 `launch:game-ready` 永远不发，窗口一直挂着。

**修复**：补上老式 LWJGL 2 的就绪信号
`OpenAL initialized.`（句点结尾）与 `Loading current icons for window`，
**对所有版本启用**（1.0 以上同样用这套声音系统）。
关键是正则用 `(?!\s*on\s+device)` 排除了现代 1.13+ 的
`OpenAL initialized on device ...` —— 那一行出现在 `Sound engine started` **之前**，
认了会提前关窗（历史踩过的坑），所以不会造成 26.3 等现代版回归。
另加 spawn 后 2 秒延迟门槛，避免启动即打印的怪版本误报。

**实测**（`build/verify-legacy-game-ready.js`，13/13 PASS）：
- 喂你提供的 b1.7.3 真实日志 → 在 `Loading current icons`（窗口已建好）触发一次
- 现代版 `OpenAL initialized on device` 不误报，仍由 `Sound engine started` 触发
- 1.x 的 `OpenAL initialized.` 能触发，覆盖 1.0 以上
- `Stopping!` 不触发、2 秒门槛生效、只回调一次

原有 `build/verify-game-ready.js` 回归也修正了过期断言后 0 失败（旧脚本曾错误地断言
`Backend library` / `Setting user` 该命中，那些其实是有意排除的误报源）。

### 主页

- 新增「GitHub 仓库」按钮，一键直达本仓库
- 更新检查就绪后，未来发新版会自动在主页顶部提示（详见「设置 → 关于 → 使用说明 → 更新」）

### 联机：进行中不再收起启动器窗口

房间由启动器进程托管，窗口被收起可能让联机中断。现在只要联机在跑，
启动游戏后启动器会**保持在前台**，并提示「联机进行中，窗口会保持在前台（避免房间中断）」。
房主走「创建房间（我是房主）」拿邀请码，访客走「加入房间（我是访客）」填码；
点「结束联机」后启动器才恢复正常收起行为。
补上了 HMCL 的 `host_starting` / `guest_starting` 两个状态文案。

### 游戏内 QCL 签名（对齐 HMCL）

以前游戏里几乎看不出是 QCL 启动的。现在补齐四层标识：

| 标识 | 作用 |
|---|---|
| `--versionType QCL 1.0.1` | F3 调试界面 / 崩溃报告里的版本类型 |
| `-Dminecraft.launcher.brand=QCL` + `-Dminecraft.launcher.version` | 崩溃报告的 Launcher 一行 |
| `-Dnet.minecraft.clientmodname=QCL` | 安卓版 QCL 同款，模组可读 |
| `-Dminecraft.client.jar=<真实 jar>` | 模组识别版本 jar（加载器空壳时自动取父版本 jar） |

另外启动游戏时给子进程注入 `QCL_VERSION` / `QCL_TAG_NAME` / `QCL_LAUNCHER` 环境变量
（对应 HMCL 的 `HMCL_VERSION` / `HMCL_TAG_NAME`）。

---

## 1.0.0 已包含的主要功能

- **版本覆盖**：`rd-132211` → `26.x`；正式版 / 快照 / 愚人节版本 / 远古版本
- **加载器**：原版 / Fabric / Forge / NeoForge / Quilt / ModLoader / Babric / OptiFine
- **全远古版本自动注入两行 Betacraft 兼容参数**：
  `-Dhttp.proxyHost=betacraft.uk`、`-Djava.util.Arrays.useLegacyMergeSort=true`
  （覆盖 258 条归档清单 + 官方 old_alpha/old_beta；装 OptiFine/Forge/中文补丁改名后照样命中；
   「版本设置 → 启动参数」里能看到启动器真正会加的这两行）
- **归档快照**：官方 manifest 已删除、Betacraft 收录的 74 个 11w/12w/13w 周快照补进「快照」分页，标「归档」，走 `.info` 还原
- **中文补丁**：安卓版完整移植，77 组规则 / 71 个补丁包
- **微软账号皮肤**：按 Mojang 新 profile 结构取皮肤与披风，不再变史蒂夫
- **远古音效**：资源按老结构铺进 `resources/`，逐文件补齐 `.ogg`
- **存档 / 整合包 / 前置依赖 / Java 自动下载 / 启动前自动补全文件**
- **多人联机**：内置 Terracotta P2P 内网穿透（协议按 HMCL 真实实现重写）
- **启动参数带 QCL 标识**：`-Dminecraft.launcher.brand=QCL`、`--versionType QCL 1.0.1`

## 已知限制

- 目前只打包 Windows x64
- 26.x 及部分 1.21.x 官方尚未发布 OptiFine，这些版本的 OptiFine 会置灰
- 两台机器真实联机尚未实测；协议链路已在本机跑通，能否建成隧道取决于 NAT 打洞与公共节点

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)。
