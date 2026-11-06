# QCL 电脑版 1.0.2

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-Setup-1.0.2.exe`**（约 128 MB，中文自解压安装程序）← 本 Release 的 Assets
- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0

装完在「设置 → 关于」里应显示 `QCL 1.0.2`。装之前请先关掉正在运行的旧版 QCL。

> 说明：GitHub 会过滤 Release 资产名里的中文，因此附件用 ASCII 名 `QCL-Setup-1.0.2.exe`；
> 它与本地 `QCL-安装程序-1.0.2.exe` 是同一个文件。

---

## 本版重点

### 一、主页新增「我的实例」

以前主页只有公告和 3D 人物，**玩家一进来根本看不到自己装了哪些版本**；
在程序目录里翻找 `instances` 也找不到（真实数据在 `文档\QCL`），很容易以为数据丢了。

现在主页下方直接列出全部实例：

- 卡片显示：实例名 / 真实版本号 / 加载器（原版、Fabric、Forge、NeoForge、Quilt、ModLoader、Babric、OptiFine）
- 当前正在使用的那个标 **「当前」**，其它显示「切换」，点一下即刻切换
- 右上角：**「打开数据目录」**（直接打开真实数据目录）、**「管理实例」**（跳版本列表）
- 顶部显示实例总数，例如「我的实例（2 个）」

### 二、程序目录里能看到自己的数据了

以前装完打开 `C:\Users\<用户>\AppData\Local\Programs\QCL`，里面只有
`QCL.exe` / `resources` / `locales` / `QCL-data`（只是 Electron 的缓存），
**找不到 instances** —— 玩家自然以为数据丢了。

现在启动时会在程序目录里建一个可见入口：

```
Programs\QCL\QCL数据   →   文档\QCL        （目录联接，不需要管理员权限）
```

点进去就是完整数据：`instances`、`accounts.json`、`meta`、`.minecraft` 全都在。
万一某些机器的权限不允许建目录联接，会自动改为在程序目录放一份
**`QCL数据-在这里.txt`**，里面写着真实路径，复制到资源管理器地址栏回车就能进。

**为什么数据不直接放程序目录？** 这是 Windows 的惯例：安装版把数据放 `文档\QCL`，
卸载启动器**不会删掉你的世界、模组和账号**。程序目录那份 `QCL-data` 从来只放缓存。

---

## 1.0.1 已包含

- 修复远古版本（b1.7.3、1.0~1.12）**启动窗口不关**：老式 LWJGL 2 打的是
  `OpenAL initialized.` / `Loading current icons for window`，旧判据只认现代版日志行
- 联机进行中**不再收起启动器窗口**（房间由启动器托管，收起可能中断）
- 游戏内 QCL 签名对齐 HMCL（`--versionType QCL`、`clientmodname`、`minecraft.client.jar`、`QCL_VERSION` 环境变量）
- 主页「GitHub 仓库」按钮

## 1.0.0 已包含

- **版本覆盖**：`rd-132211` → `26.x`；正式版 / 快照 / 愚人节版本 / 远古版本
- **全远古版本自动注入两行 Betacraft 兼容参数**：`-Dhttp.proxyHost=betacraft.uk`、
  `-Djava.util.Arrays.useLegacyMergeSort=true`（覆盖 258 条归档清单；「版本设置 → 启动参数」里能看到）
- **归档快照**：官方已删除、Betacraft 收录的 74 个 11w/12w/13w 周快照补进「快照」分页，标「归档」
- **中文补丁**：安卓版完整移植，77 组规则 / 71 个补丁包
- **微软账号皮肤**：按 Mojang 新 profile 结构取皮肤与披风，不再变史蒂夫
- **远古音效**：资源按老结构铺进 `resources/`，逐文件补齐 `.ogg`
- **多加载器**：Fabric / Forge / NeoForge / Quilt / ModLoader / Babric / OptiFine
- **多人联机**：内置 Terracotta P2P 内网穿透
- 存档管理 / 整合包导入导出 / 前置依赖检测 / Java 自动下载 / 启动前自动补全文件

## 已知限制

- 目前只打包 Windows x64
- 26.x 及部分 1.21.x 官方尚未发布 OptiFine，这些版本的 OptiFine 会置灰
- 两台机器真实联机尚未实测；协议链路已在本机跑通，能否建成隧道取决于 NAT 打洞与公共节点

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)。
