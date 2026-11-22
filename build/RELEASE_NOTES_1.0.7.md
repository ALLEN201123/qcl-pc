# QCL 电脑版 1.0.7

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-Setup-1.0.7.exe`**（约 130 MB，中文自解压安装程序）← 本 Release 的 Assets
- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0

装完在「设置 → 关于」里应显示 `QCL 1.0.7`。装之前请先关掉正在运行的旧版 QCL。

---

## 本版重点：没有身份证 / 未满 18 也能开服给人玩

1.0.6 只接了樱花frp 和自建 frps —— 这两条**都要实名或成人身份**，
很多玩家根本用不了。这是真实缺口，本版补上。

### ★ bore 零注册（现已作为默认）

- 服务端是公开的 **bore.pub**，**不用注册、不用实名、不用装任何组件**
- 连上就分配一个随机公网端口，把这个地址发给朋友，他们在游戏里「直接连接」填进去就能进
- 纯 Node 实现（内置在启动器里），不需要下载任何二进制

**实测（`build/verify-server-tunnel-multi.js`）**：

```
★ bore 隧道建立（无需任何账号）  → "bore.pub:54768"
★ 从公网地址连回来能收到本地数据  → "QCL-MC-HELLO"
```

这不是「启动成功就算」，而是**真的起了一个本地服务、真的从公网地址连回来、真的收到了数据**。

**代价（界面里也写清楚了）**：

- 每次地址都不一样（重启就变）
- 没有密码 —— 谁拿到地址都能连
- 延迟取决于公共节点线路

适合临时和朋友玩；长期公开服还是建议自建 frps。

### 四种方案，按门槛从低到高

| 方案 | 门槛 | 说明 |
|---|---|---|
| **① bore 零注册** | **无** | 匿名，什么都不用填（默认） |
| ② 樱花frp | 需 token | 节点多、稳定，需实名注册 |
| ③ 魅frp | 需 token | 另一家 frp 服务商 |
| ④ 自建 frps | 需公网服务器 | 最快最稳，配置自动生成 |

frp 系三种共用同一个 frpc 引擎（官方 0.71.0，带国内镜像回退）；
「停止」会同时停掉 bore 与 frp，避免残留。

---

## 修了一个协议级 bug

bore 第一版连上 `bore.pub` 后发了 Hello，却永远收不到响应。

翻官方源码 `src/shared.rs` 才看清：

```rust
let codec = AnyDelimiterCodec::new_with_max_length(vec![0], vec![0], MAX_FRAME_LENGTH);
```

**帧分隔符是 NULL 字节 `\0`，不是换行符**，单帧上限 256 字节。
我按换行符写，服务端当然读不出完整帧。改对之后一次就通。

顺带按 serde 的枚举序列化规则补齐了所有消息格式：

| 消息 | 线上格式 |
|---|---|
| `ClientMessage::Hello(port)` | `{"Hello":25565}` |
| `ClientMessage::Accept(uuid)` | `{"Accept":"<uuid>"}` |
| `ServerMessage::Hello(port)` | `{"Hello":12345}` |
| `ServerMessage::Connection(uuid)` | `{"Connection":"<uuid>"}` |
| `ServerMessage::Heartbeat` | `"Heartbeat"` ← 单元枚举是**字符串**，不是对象 |
| `ServerMessage::Error(msg)` | `{"Error":"..."}` |

---

## 一点说明（避免再混淆）

之前提过的 **Terracotta** 是「游戏里开房间」联机用的 —— 它扫的是本机游戏世界开的那个端口，
把客户端之间打通。**独立服务端需要的是标准端口映射**，两者不是一回事，所以没有混进来。

魅frp 与樱花frp 的接口都已实测（用假 token 会得到各自平台的标准错误返回，
例如樱花的 `"访问密钥无效"`、魅frp 的 `"ME Frp 5.21 API Server is OK!"`），
说明接口是通的；真用需要玩家自己去注册。

---

## 验收

| 脚本 | 结果 |
|---|---|
| `build/verify-server-tunnel-multi.js` | **28/28 PASS** — bore 真起隧道 + 真从公网连回来收到数据、bore 停止、魅frp/樱花接口、TOML、四种方案 UI 齐全、默认是 bore、IPC 接线 |
| `build/verify-server-tunnel.js` | **50/50 PASS** — frpc 引擎安装 + `--version`、TOML 生成、进程生命周期、真跑日志与中文诊断、樱花 API、接线 |
| `build/verify-server-createdialog.js` | **12/12 PASS** — 「新建服务端」按钮真能弹窗 |
| `build/verify-server-versions.js` | **55/55 PASS** — 26.3 / 快照 / 1.0.0 / b1.7.3 / b1.9-pre / a0.2.8 / c1.4 / 2.0 三色 / Infdev / Paper / Purpur / Fabric |
| `build/verify-server.js` | **105/105 PASS** — 含真跑服务端进程 |
| `build/verify-server-ui.js` | **27/27 PASS** |
| `build/verify-toolbox*.js` | 64/64 + 10/10（回归） |

## 已知限制

- 目前只打包 Windows x64
- bore.pub 是公共资源，端口随机且不保证带宽；长期服建议自建 frps
- 樱花frp / 魅frp 需要玩家自己注册（这两家要求实名，未成年人请用 bore）
- `a1.2.6` 等 Alpha 后期版本仍无服务端来源（Mojang 已下架、归档只到 a0.2.8）

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)。
