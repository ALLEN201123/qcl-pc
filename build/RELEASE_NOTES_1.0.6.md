# QCL 电脑版 1.0.6

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-Setup-1.0.6.exe`**（约 128 MB，中文自解压安装程序）← 本 Release 的 Assets
- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0

装完在「设置 → 关于」里应显示 `QCL 1.0.6`。装之前请先关掉正在运行的旧版 QCL。

---

## 先纠正一处我说错的事实

1.0.5 的说明里我写过「远古版本 Mojang 从来没发过服务端」——**这是错的**。

实际情况：Mojang 当年**发过**，只是后来把很多 jar 从下载清单里删掉了
（最典型的是 **1.0 正式版**、Beta 全系、Alpha 全系、Classic、以及大量周快照）。
**Betacraft 社区把这些官方已丢失的服务端全量保存了下来，它自己就是靠这个开服的。**

本版把这条链路补上了。

---

## 一、服务端版本覆盖（三层来源，222 个 jar / 193 个版本）

### ① Mojang 官方（还在清单里的）

`26.3` · `26.4-snapshot-10` · `1.21.11` · `1.20.1` · `1.16.5` · `1.12.2` · `1.8.9` · `1.7.10` · `1.6.4` · `1.2.5` …

### ② Betacraft 服务端归档（官方已下架的那批）

从 `files.betacraft.uk/server-archive/` 实时索引，按四类分开：

| 分类 | 数量 | 举例 |
|---|---|---|
| **正式版** | 45 | `1.0.0` `1.0.1` `1.1` `1.2` … ← 就是「1.0 正式版服务端丢了」那批 |
| **快照** | 100 | `11w47a` `13w16a` `14w08a` … 官方都删了的周快照 |
| **远古版** | 73 | `b1.7.3` `b1.9-pre1`~`pre6` `b1.8.1` `a0.2.8` `c1.4` … |
| **愚人节版** | 4 | `2.0_red` `2.0_blue` `2.0_purple` `2.0_preview` |

目录 HTML 索引解析（Betacraft 没有 JSON 清单），支持 `.jar` 与 `.zip`（Classic 有些是 zip），
版本号从文件名 + 目录结构还原（`b1.3-1647` → `b1.3`、`13w16a-181800` → `13w16a`、
`2.0/red/minecraft_server.jar` → `2.0_red`）。清单缓存 30 分钟。

### ③ 内置社区服务端（前两者都没有的）

| 内置 | 覆盖 | 为什么需要 |
|---|---|---|
| **Infdev Ultimate Server** | 23 个 Infdev 版本 | **Mojang 从没发过 Infdev 服务端**。实测能跑：启动后自己生成 `world/`、`server.properties`、白名单文件 |
| **Beta 1.7.3 PEMod** | `b1.7.3` | 原版 b1.7.3 服务端**不支持插件**，这是 Beta 时代的插件化实现（PE = Plugin Enabled） |

两个都随安装包分发（`assets/ancient-servers/` → `<resources>/ancient-servers`）。

### 取服务端的顺序

```
Mojang 官方清单 → Betacraft 归档 → 内置社区服务端
```

`b1.7.3` 默认拿归档的**原版**服务端；想要插件支持，可在下载时选内置插件版。

### 已知缺口（不编造）

`a1.2.6` 及部分 Alpha 后期版本：Mojang 已下架、Betacraft 归档只到 `a0.2.8`、
内置服务端也没覆盖。这些版本**目前开不了原版服**，界面会明确说明，
并建议改用 Paper / Purpur（1.8.8+）。

---

## 二、内网穿透（上一版完全没做）

开了服务端朋友进不来，等于只能自己玩。本版接的是 **frp**（Fast Reverse Proxy）：

### 两条路

| 方式 | 适合 | 需要什么 |
|---|---|---|
| **樱花frp（免费）** | 没有公网服务器的玩家 | 注册拿一个 token，隧道在樱花控制台建 |
| **自建 frps** | 有自己的 VPS | 服务器地址 / 端口 / token / 远程端口 |

### 实现细节

- **frpc 引擎自动下载**：官方 frp `0.71.0`，GitHub 直连失败会自动回退 3 个国内镜像
  （实测本机 GitHub 不可达时自动走 `ghfast.top` 下完 13.3 MB，`frpc --version` 返回 0.71.0）
- **TOML 配置自动生成**（自建）：`serverAddr` / `serverPort` / `auth.token` / `[[proxies]]`
  的 `localIP` / `localPort` / `remotePort`，代理名会清洗非法字符
- **樱花frp v4 API**：`/user/info`（账号+等级）、`/tunnels`（隧道列表）、
  `/nodes`（节点，含 UDP/离线/VIP 标记）、`POST /tunnel/config`（**直接返回 TOML**）
- **公网地址自动识别**：从 frpc 日志里捞 `start proxy success` 与 `host:port`
- **中文诊断**：连不上 / token 错 / 端口被占用 / 域名解析失败，逐个给能照做的建议

### ★ 为什么不用 Terracotta

Terracotta 是「MC 客户端开房间联机」用的 —— 它扫的是**本机游戏世界开的那个端口**，
把客户端之间打通。独立服务端要的是**标准端口映射**，两者不是一回事。

---

## 三、修的两个问题

### 「新建服务端」按钮点不动

根因：我在页面里手写了一个 `.modal-overlay` 浮层，但**项目 CSS 里只有 `.modal`、
没有 `.modal-overlay`** —— 那个 div 被当成普通块元素塞进文档流末尾（要滚到底才看得到），
所以点按钮看起来毫无反应。

改用项目统一的 `openModal()`（走 `#modal-root`、带遮罩与关闭按钮）。
新增 `build/verify-server-createdialog.js` 专测这条，**12/12 PASS**。

### Paper 核心全线拿不到

官方旧 API `api.papermc.io/v2` 已下线，**全线返回 HTTP 410**。
改用新 API `fill.papermc.io/v3`（下载键从 `application` 变成 `server:default`），
实测 `26.3` / `1.21.11` / `1.20.1` / `1.16.5` / `1.12.2` / `1.8.8` / `1.7.10` 全部拿到了 STABLE 构建。

---

## 验收

| 脚本 | 结果 |
|---|---|
| `build/verify-server.js` | **105/105 PASS** — 状态机、端口预检、46 项配置、备份、RCON、**真跑服务端进程**（启动→就绪→下发命令→优雅停止→退出码 0→诊断）、接线 |
| `build/verify-server-versions.js` | **55/55 PASS** — 26.3 / 快照 / 1.0.0 / b1.7.3 / b1.9-pre1~6 / a0.2.8 / c1.4 / 2.0 三色 / Infdev / Paper / Purpur / Fabric 逐个实测 |
| `build/verify-server-tunnel.js` | **50/50 PASS** — frpc 引擎安装+`--version`、TOML 生成、进程生命周期、真跑日志与诊断、樱花 API（假 token 得到 `"访问密钥无效"`，说明接口通）、接线 |
| `build/verify-server-createdialog.js` | **12/12 PASS** — 按钮点开、弹窗渲染 5943 字节、标题/输入框/4 个核心按钮/创建按钮齐全、切核心、输名字 |
| `build/verify-server-ui.js` | **27/27 PASS** — 导航入口、6 个 tab、46 字段/5 组/5 预设、RCON 与备份按钮 |
| `build/verify-toolbox.js` | **64/64 PASS**（回归） |
| `build/verify-toolbox-icon.js` | **10/10 PASS**（回归） |

真跑测试用的服务端进程是现场 `javac -encoding UTF-8` 编出来的极简服务端，
完整走通 spawn → 日志管道 → stdin 命令 → `Done (1.234s)!` 就绪 → `stop` 优雅退出。

## 已知限制

- 目前只打包 Windows x64
- 樱花frp 需要玩家自己的 token（免费注册），这一步无法代替
- 自建 frps 需要玩家有一台有公网 IP 的服务器
- `a1.2.6` 等 Alpha 后期版本目前无服务端来源（见上文缺口说明）

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)。
