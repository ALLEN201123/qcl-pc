# QCL 电脑版 1.0.0 · 首个正式版

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-安装程序-1.0.0.exe`**（127.7 MB，中文自解压安装程序）← 就在本 Release 的 Assets 里
- 校验：`SHA256 86152AA6C301887FDB86050DBBF1DE209F0005F6966A3A6CF114D764E8BD4D05`

装完在「设置 → 关于」里应显示 `QCL 1.0.0`。装之前请先关掉正在运行的旧版。

---

## 主要功能

- **版本覆盖**：`rd-132211` → `26.x`；正式版 / 快照 / 12 个愚人节版本 / 197 个远古版本
- **加载器**：原版 / Fabric / Forge / NeoForge / Quilt / ModLoader / Babric / OptiFine（高清修复）
  - 安装时默认原版，可自定义**版本名称**、自选每个加载器的**具体版本**
  - 按 MC 版本自动标推荐：1.14 前 → Forge，1.14 后 → Fabric，远古 → ModLoader（b1.7.3 → Babric）
  - OptiFine 可叠加：1.13+ 勾上自动配 Forge；≤1.12.2 走官方 Patcher 补丁
  - 已装好的实例可在「版本设置 → 概览 → 安装/更换加载器」里只补装加载器，不重下游戏
- **中文补丁**：安卓版 `LegacyChinesePack.java` 完整移植，77 组规则 / 71 个补丁包，字模 256→4096、4359 字符表、223 张官方点阵；按版本决定 `lang` 大小写（规避 1.1 崩溃 BUG）
- **下载**：8 大分类（游戏/整合包/模组/资源包/光影/世界/数据包/收藏）+ 混合源（Modrinth + CurseForge 镜像）；装模组自动列必需前置并一起装
- **存档 / 整合包**：详情、备份、恢复、导出、删除到回收站；整合包导出/导入、模组更新检查
- **Java**：按 MC 版本自动挑选；一个 Java 都没有时支持免登录一键下载
- **启动前检查**：按 sha1 校验 jar 与库，缺失/损坏**自动补全**
- **多人联机**：内置 Terracotta（陶瓦联机）P2P 内网穿透
- **窗口**：无边框融合窗口，壁纸铺到物理边缘，主菜单 3D 人物显示账号真实皮肤与披风

游戏启动参数带 `-Dminecraft.launcher.brand=QCL` 与 `--versionType QCL 1.0.0`（F3 与崩溃报告可见 QCL 标识）。

## 联机实测说明（如实）

Terracotta 按 HMCL 真实协议重写（`--hmcl <临时文件>` + 本机 HTTP 控制端口）。
本次在本机真跑通过：组件下载与 SHA-512 校验、启动拿到控制端口、`/state` 读到状态、
节点列表可用、房主扫描接口进入 `host_scanning`、退出清理。
**能否真正建成隧道拿到邀请码**取决于本机 NAT 打洞与 Terracotta 公共节点，属外部网络条件；
界面若一直停在扫描会如实提示，不会假装连接成功。

## 已知限制

- 目前只打包 Windows x64
- 26.x 及部分 1.21.x 官方尚未发布 OptiFine，这些版本的 OptiFine 会置灰
- 5 个 Alpha 时期的 ModLoader 官方只有 `.rar`，无法安装（界面会说明）
- 尚未移植：Betacraft 皮肤站/老版本认证服务、HMCL 的 NBT 编辑器、截图管理、投影管理、下载限速、自动定时备份

## 开源与许可

- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0
- 启动核心参照 MultiMC 源码，界面与功能来源安卓版 QCL 1.5.9，目录布局/自动安装/联机/OptiFine 参照 HMCL，远古版本思路参照 Betacraft。

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)；
「中文补丁怎么移植过来的」和「为什么说是中国版 Betacraft」见启动器内 **设置 → 关于 → 使用说明**。
