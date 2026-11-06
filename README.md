# QCL 电脑版 · Quanta Craft Launcher for Windows

> QCL（Quanta Craft Launcher，量子方块启动器）的 **Windows 桌面版**。
> 全中文界面，基于 Electron。启动核心参照 MultiMC 源码实现，界面照安卓版 QCL 1.5.9 的新排版，
> 远古版本方案与归档/代理依赖 Betacraft，加载器、联机、OptiFine 方案参照 HMCL，版式参照 FCL。

**仓库**：<https://github.com/ALLEN201123/qcl-pc> · **下载**：<https://github.com/ALLEN201123/qcl-pc/releases>
**许可**：GNU GPL-3.0（见 [LICENSE](LICENSE)）

---

## 安装

下载 `QCL-安装程序-1.0.2.exe`（约 128 MB），双击即可安装。

- 全中文安装界面（Windows Forms 自绘），**无需管理员权限**
- 默认装到 `%LOCALAPPDATA%\Programs\QCL`
- **不依赖任何外部运行库**（.NET Framework 4.x 是 Windows 自带）
- 游戏数据默认在 `文档\QCL`

> 装之前请先关掉正在运行的旧版 QCL。装完在「设置 → 关于」里应显示 `QCL 1.0.2`。

## 版本历史

- **1.0.2**：主页新增「我的实例」面板 —— 列出全部实例、显示真实版本与加载器、一键切换当前实例、可直接打开数据目录；启动时在程序目录建立指向真实数据的「QCL数据」入口（目录联接，权限不允许时自动改为写一份指路文件）。
- **1.0.1**：修复远古版本（b1.7.3、1.0~1.12）游戏窗口已出来但启动窗口一直卡在「等待游戏窗口」的 BUG —— 老式 LWJGL 2 打的是 `OpenAL initialized.` / `Loading current icons for window`，旧判据只认现代版日志行，一条都不匹配。主页新增「GitHub 仓库」按钮。
- **1.0.0**：首个正式版。全远古版本自动注入两行 Betacraft 兼容参数、补入 74 个归档周快照、微软账号皮肤/披风修复、远古音效铺开、更新推送检查。

---

## 这是什么

安卓版 QCL 是手机上唯一支持下载**全部考古社区已归档远古版本**、并给全远古版本做好中文的启动器。
电脑版把这些能力搬到 Windows：同一套界面语言（全屏壁纸 + 左右常驻半透明浮层 + 主题色 `#865D58`）、
同一份远古版本归档清单（Betacraft 快照，258 条），启动链路按 PC 方式重写（直接 `spawn` Java，
不再需要 Pojav/SDL 那套）。

**这个启动器基本等于「中国版 Betacraft」**：远古版本全量归档、`.info` 还原启动结构、
老版本皮肤/会话走 Betacraft 代理、Java 7+ 的 TimSort 兼容参数、老音效资源铺开 —— 另外多了
**77 组全远古版本中文补丁**（详见「设置 → 关于 → 使用说明」页）。

**全部远古版本（Betacraft 归档 258 条 + 官方 old_alpha/old_beta）装好后，启动时会自动注入这两行 Java 参数**，
不需要玩家手动设置：

```
-Dhttp.proxyHost=betacraft.uk
-Djava.util.Arrays.useLegacyMergeSort=true
```

覆盖范围包括 pre-classic / classic / indev / infdev / alpha / beta / 1.0 RC / 2.0 愚人节版，
以及**官方已删除、被 Betacraft 收录的 74 个 11w/12w/13w 周快照**（这些会补进「快照」分页并标「归档」徽标，
走 `.info` 还原启动结构）。装了 OptiFine / Forge / 中文补丁导致版本目录改名时也照样命中。
「版本设置 → 启动参数」页有一块卡片显示的就是启动器真正会加的这两行；玩家自己在 JVM 参数里
写了 `proxyHost` / `useLegacyMergeSort` 时启动器跳过自动注入，不覆盖玩家设置。

## 主要功能

| 分类 | 内容 |
|---|---|
| **版本覆盖** | `rd-132211` → `26.x`；官方正式版/快照 + 12 个愚人节版本 + 197 个远古版本 |
| **加载器** | 原版 / Fabric / Forge / NeoForge / Quilt / ModLoader / Babric / **OptiFine（高清修复）** |
| **安装对话框** | 默认原版；可自定义**这个版本的名称**、自选每个加载器的**具体版本**、勾选「顺便一起装」前置（Fabric API / Sodium / QFAPI / Sinytra Connector） |
| **中文补丁** | 安卓版 `LegacyChinesePack.java` 完整移植：77 组规则、71 个补丁包、字模 256→4096、4359 字符表、223 张官方点阵；按版本决定 `lang` 大小写（规避 1.1 崩溃 BUG） |
| **下载** | 8 大分类（游戏/整合包/模组/资源包/光影/世界/数据包/收藏）+ 混合下载源（Modrinth + CurseForge 镜像） |
| **前置依赖** | 装模组时自动列出必需前置并默认全勾一起装；重复安装同项目默认覆盖旧文件 |
| **存档管理** | 详情（种子/模式/大小）、备份、备份列表、恢复、导出、删除到回收站、打开文件夹 |
| **整合包** | 导出（可选模组/配置/存档/资源包）、导入（QCL `.zip` / Modrinth `.mrpack`）、模组更新检查 |
| **Java** | 按 MC 版本自动挑 Java（≤1.16.5→8 / 1.17~1.20.4→17 / 1.20.5~1.21.11→21 / 26.x→25）；没有 Java 时支持免登录一键下载 |
| **多人联机** | 内置 Terracotta（陶瓦联机）P2P 内网穿透，创建房间/加入房间 |
| **启动前检查** | 按 sha1 校验客户端 jar 与库，缺失/损坏**自动补全**，不用玩家手动重装 |
| **更新推送** | 打开主页时静默查 GitHub Releases，发现正式新版显示中文提示条 + 一键跳转（6 小时缓存，离线静默跳过，只提示不自动下载） |
| **窗口** | 无边框融合窗口，壁纸铺到物理边缘，控件为半透明浮层 |

游戏启动参数里带 `-Dminecraft.launcher.brand=QCL` 和 `--versionType QCL 1.0.0`
（F3 调试界面与崩溃报告里能看到 QCL 标识）。

## 快速开始（开发）

```powershell
cd qcl-pc
npm start            # 直接运行（开发）
npm run pack         # 打目录版：dist\win-unpacked\QCL.exe
# 出中文安装程序（.NET csc 自绘；NSIS 在本机因内存不足会失败）
powershell -ExecutionPolicy Bypass -File build\make-installer.ps1 -Version 1.0.0
```

`make-installer.ps1` 把 `dist\win-unpacked` 压成 `payload.zip`，再用系统自带 `csc.exe`
编译 `build/installer/Installer.cs`（全中文 WinForms 界面）并把 zip 内嵌进去，产出单文件 exe。

## 目录结构

```
qcl-pc/
  electron-builder.config.js   打包配置（afterPack 用 rcedit 写图标/版本信息）
  build/make-installer.ps1    生成中文安装程序
  build/installer/Installer.cs 安装程序源码（WinForms）
  build/verify-*.js            各功能真机验收脚本
  docs/CONTRACT.md             接口契约（IPC / 数据结构 / 核心模块签名）
  src/main/index.js            主进程入口
  src/main/window.js           无边框融合窗口
  src/main/ipc.js              IPC 路由
  src/main/core/               启动器核心（参照 MultiMC / HMCL）
  src/preload/index.js         contextBridge 桥（window.qcl）
  src/renderer/                界面（原生 HTML/CSS/JS，无构建步骤）
  vendor/                     MultiMC / HMCL 源码（只读参照，不进仓库）
```

## 数据目录

默认 `文档\QCL`（可在设置里改）：

```
<QCL_HOME>/
  settings.json / accounts.json / instances.json
  .minecraft/
      libraries/            ← 所有实例共享
      assets/               ← 所有实例共享
  instances/<id>/
      instance.json
      .minecraft/           ← 这个实例的游戏数据（mods / saves / config / versions）
  meta/                    版本 JSON / 资源索引缓存
  logs/latest.log           最近一次启动或安装的日志
  backups/                   存档备份
  exports/                   导出的整合包 / 存档
  recycle/                   删除的东西（可恢复，不硬删）
```

`libraries` 与 `assets` 多实例共享（照 HMCL 语义），其余按实例隔离，实测能省一半空间。
老版本装出来的实例会在后台自动迁移到新布局，迁移期间启动/安装会等闸门，避免读到搬一半的库。

## 加载器支持与推荐规则

| 加载器 | 适用版本 | 说明 |
|---|---|---|
| 原版 | 全部 | 默认项，纯净 |
| Fabric | 1.14+ | 轻量，优化模组首选 |
| Forge | 1.0 ~ 1.13.2 首选 | 老版本生态几乎全靠它 |
| NeoForge | 1.20.2+ | Forge 分支 |
| Quilt | 1.14+ | Fabric 分支，生态小 |
| ModLoader | 远古（1.6.2 / Beta / 部分 Alpha） | Risugami's ModLoader，把 class 注入本体 jar |
| Babric | b1.7.3 | Fabric 分支；库走 glass-launcher 自己的 maven，**不走 BMCLAPI** |
| OptiFine | ≤1.12.2 补丁模式 / ≥1.13 需配 Forge | 高清修复，可叠加项；官方没出 26.x 版本 |

安装游戏时点「安装」会先弹选择框，**默认原版**，按版本标出推荐：
1.14 之前 → Forge，1.14 及以后 → Fabric，远古 → ModLoader（b1.7.3 → Babric）。
每行都能自己挑加载器版本；OptiFine 是「另外一起装」里的勾选项，1.13+ 勾上会自动切 Forge。
已经装好的实例也能在「版本设置 → 概览 → 安装/更换加载器」里只补装加载器，不重下游戏。

## 多人联机（Terracotta）

内置 HMCL 团队与 burningtnt 的 Terracotta P2P 内网穿透组件（v0.4.2）：

- 「准备联机组件」下载 exe + VCRUNTIME140.DLL 并做 SHA-512 校验
- 启动后通过本机控制端口（`127.0.0.1:<port>/state`）驱动界面
- 房主 `/state/scanning` 拿邀请码，访客 `/state/guesting` 拿游戏里要填的服务器地址
- 公共节点来自 `https://terracotta.glavo.site/nodes`

**实测状态**：组件下载/校验、启动拿控制端口、`/state` 读状态、`/state/ide` 退出、
节点列表、房主扫描接口（进入 `host_scanning`）均已在本机真跑通过。
但**能否真正建成隧道拿到邀请码**取决于本机 NAT 打洞与 Terracotta 公共节点，
属于外部网络条件，本机单测环境不保证；界面上若一直停在扫描会如实提示，不会假装连接成功。

## 已知限制

- 目前只打包 Windows x64。
- 微软正版登录走设备码流程，需要联网；离线账号随时可用。
- 远古版本依赖 Betacraft 归档（`.info`）与 Mojang 旧版本元数据，网络不通时只能看到缓存清单。
- 5 个 Alpha 时期的 ModLoader 官方只发了 `.rar`，启动器解不开，界面会灰掉并说明原因。
- 26.x 及部分 1.21.x 官方尚未发布 OptiFine，这些版本的 OptiFine 勾选框会置灰。
- 还没从 Betacraft 移植的：皮肤站、一体化老版本认证服务、服务器列表与在线人数、网页版档案浏览。
- 尚未移植的 HMCL 功能：NBT 编辑器、截图管理页、投影（Schematics）管理、启动器自更新检查、下载限速/断点续传、自动定时备份。

## 与安卓版 QCL / MultiMC / HMCL / Betacraft / FCL 的关系

| | 说明 |
|---|---|
| **安卓版 QCL** | 界面与功能的产品来源（1.5.9）。远古版本清单、中文补丁、主题色、排版都照它。 |
| **MultiMC** | 启动核心的**实现参照**（C++/Qt 源码，只读）。库规则匹配、natives 解压、资源索引、Java 检测、命令行拼装。 |
| **HMCL** | 目录布局、自动安装加载器、Terracotta 联机、OptiFine 安装策略的参照；游戏内签名与环境变量（`HMCL_VERSION` → `QCL_VERSION`）也照它的做法。 |
| **Betacraft** | **实际在用的运行依赖**，不只是思路来源：258 条远古版本归档清单与 `.info` 清单、`.info` 还原启动结构、74 个官方已删除周快照的 jar 直链、`-Dhttp.proxyHost=betacraft.uk` 老版本皮肤/会话/资源代理、老版本音效资源对象，全部来自 Betacraft。 |
| **FCL** | 安卓版界面版式的参照（左常驻栏 + 右账号/启动栏 + 中间公告与 3D 人物）。 |

## 界面：窗口边缘与壁纸的融合

- 窗口 `frame:false + transparent:true`，比内容卡片大 18px；
- 卡片用 CSS `border-radius:12px` + 外阴影，**窗口物理边缘之外是柔和阴影，不是灰色边框**；
- 壁纸 `cover` 铺满卡片，控件是浮在壁纸上的半透明层（`backdrop-filter: blur()`）；
- 最大化时 `inset` 归零，卡片铺满整屏（主进程推 `win:state` 事件，渲染层改 CSS 变量 `--inset`）。
