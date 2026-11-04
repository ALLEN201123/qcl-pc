# QCL 电脑版 · Quanta Craft Launcher for Windows

> QCL（Quanta Craft Launcher，量子方块启动器）的 **Windows 桌面版**。
> 界面照搬安卓版 QCL 1.5.9 的「新排版」，启动核心逻辑**参照 MultiMC 源码**（`vendor/MultiMC`）实现。

**仓库**：<https://github.com/ALLEN201123/qcl-pc> · **下载**：<https://github.com/ALLEN201123/qcl-pc/releases>

---

## 安装与运行

发布版是**中文自解压安装程序**：`QCL-安装程序-1.0.0.exe`（约 128 MB，双击即装，装到
`%LOCALAPPDATA%\Programs\QCL`，无需管理员权限，也不依赖任何外部库）。

游戏数据默认在 `文档\QCL`。

## 这是什么

安卓版 QCL 是手机上唯一支持下载**全部考古社区已归档远古版本**、并给**全远古版本**做好中文的启动器。
电脑版把这些能力搬到 Windows：同一套界面语言（全屏壁纸 + 左右常驻半透明浮层 + 主题色 `#865D58`）、
同一份远古版本归档清单（`src/main/core/data/legacy_version_archive.json`，来自 Betacraft 归档快照），
启动链路重新按 PC 的方式实现（不再需要 Pojav/SDL 那套，直接 `spawn` Java）。

## 快速开始

```powershell
cd qcl-pc
npm start            # 直接运行（开发）
npm run pack         # 打目录版：dist\win-unpacked\QCL.exe
# 出中文安装程序（.NET csc 自绘，NSIS 在本机会因 mmap 失败）
powershell -ExecutionPolicy Bypass -File build\make-installer.ps1 -Version 1.0.0
```

打包依赖本机已有的 `node_modules/electron/dist`（配置里 `electronDist` 指过去），
打包后由 `electron-builder.config.js` 的 `afterPack` 钩子调 `rcedit` 写入 QCL 图标与中文版本信息。
最终安装程序由 `build/make-installer.ps1` 生成：把 `dist\win-unpacked` 压成 payload.zip，
用系统自带 `csc.exe` 编译 `build/installer/Installer.cs`（WinForms 全中文界面）并把 zip 内嵌进去。

## 目录结构

```
qcl-pc/
  electron-builder.config.js   打包配置（含 afterPack 写图标/版本信息）
  build/make-icon.py           由 icon.png 生成多尺寸 icon.ico
  docs/CONTRACT.md             接口契约（IPC / 数据结构 / 核心模块签名）
  src/main/index.js            主进程入口
  src/main/window.js           无边框融合窗口（透明 + 圆角 + 阴影边距）
  src/main/ipc.js              IPC 路由（通道见 docs/CONTRACT.md §3）
  src/main/settings.js         设置持久化
  src/main/logger.js           启动日志（<QCL_HOME>/logs/latest.log）
  src/main/core/               启动器核心（启动核心逻辑，参照 MultiMC）
  src/preload/index.js         contextBridge 桥（window.qcl）
  src/renderer/                界面（原生 HTML/CSS/JS，无构建步骤）
  vendor/MultiMC/              MultiMC 源码（只读参照）
```

## 数据目录

默认 `文档\QCL`（可在设置里改）：

```
<QCL_HOME>/
  settings.json              设置
  accounts.json              账号
  instances.json             实例索引
  instances/<id>/
      instance.json
      .minecraft/            隔离的游戏目录（照 MultiMC 的实例隔离模型）
  meta/                      版本 JSON / 资源索引缓存
  logs/latest.log            最近一次启动或安装的日志
```

## 与安卓版、MultiMC 的关系

| | 说明 |
|---|---|
| **安卓版 QCL** | 界面与功能的产品来源（`D:\QCL-build`，1.5.9）。远古版本清单、主题色、排版都照它。 |
| **MultiMC** | 启动核心的**实现参照**（C++/Qt 源码，本机没有 Qt 工具链，不编译，只读）。库规则匹配、natives 解压、资源索引、Java 检测、命令行拼装都照它的做法。 |
| **FCL** | 安卓版 QCL 界面版式的参照（左常驻栏 + 右账号/启动栏 + 中间公告与人物）。 |

## 界面：窗口边缘与壁纸的融合

- 窗口 `frame:false + transparent:true`，比内容卡片大 18px；
- 卡片用 CSS 做 `border-radius:12px` + 外阴影，**窗口物理边缘之外是柔和阴影，不是灰色边框**；
- 壁纸 `cover` 铺满卡片，控件是浮在壁纸上的半透明层（`backdrop-filter: blur()`）；
- 最大化时 `inset` 归零，卡片铺满整屏（主进程推 `win:state` 事件，渲染层改 CSS 变量 `--inset`）。

## 已知限制

- 目前只打包 Windows x64。
- 微软正版登录走设备码流程，需要联网；离线账号随时可用。
- 远古版本依赖 Betacraft 归档（`.info`）与 Mojang 的旧版本元数据，网络不通时只能看到缓存清单。
- 5 个 Alpha 时期的 ModLoader 官方只发了 `.rar`，启动器解不开，界面上会灰掉并说明原因。

## 加载器支持

| 加载器 | 适用版本 | 说明 |
|---|---|---|
| 原版 | 全部 | 纯净 |
| Fabric | 1.14+ | 轻量，优化模组首选（1.14 起才推荐） |
| Forge | 1.0 ~ 1.13.2 首选 | 老版本生态几乎全靠它 |
| NeoForge | 1.20.2+ | Forge 分支 |
| Quilt | 1.14+ | Fabric 分支，生态小 |
| **ModLoader** | 远古（1.6.2 / Beta / 部分 Alpha） | Risugami's ModLoader，把 class 注入本体 jar；装完自动打 `.modloader` 标记并跳过文件校验 |
| **Babric** | b1.7.3 | Fabric 分支，能跑现代性能模组与 Mixin；库走 glass-launcher 自己的 maven，**不走 BMCLAPI**（镜像上没有会 404） |

安装游戏时会弹出加载器选择框，并按 MC 版本自动标出「推荐」：**1.14 之前推荐 Forge**、
**1.14 及以后推荐 Fabric**、**远古版本推荐 ModLoader（b1.7.3 推荐 Babric）**。
每个加载器会异步查出该 MC 版本能用的最新稳定版本号，选中后连版本号一起交给安装器。

## 目录布局

`libraries` 与 `assets` **多实例共享**于 `<QCL_HOME>/.minecraft/`（照 HMCL「除 assets、libraries 外各版本独立」的语义），
游戏数据（mods / config / saves / resourcepacks）仍按实例隔离在 `instances/<id>/.minecraft/`。
旧版本装出来的实例会在后台自动迁移到新布局（迁移期间启动/安装会被闸门挡住，避免读到搬一半的库）。
