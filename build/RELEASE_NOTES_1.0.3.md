# QCL 电脑版 1.0.3

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-Setup-1.0.3.exe`**（约 128 MB，中文自解压安装程序）← 本 Release 的 Assets
- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0

装完在「设置 → 关于」里应显示 `QCL 1.0.3`。装之前请先关掉正在运行的旧版 QCL。

> 说明：GitHub 会过滤 Release 资产名里的中文，因此附件用 ASCII 名 `QCL-Setup-1.0.3.exe`；
> 它与本地 `QCL-安装程序-1.0.3.exe` 是同一个文件。

---

## 本版修复

### 实例图标完全不生效（实机反馈）

**现象**：在「版本设置 → 图标」里选了任意图标（24 个 MultiMC 风格图标里的任何一个），
版本列表、主页、右下角版本行**永远显示草方块** —— 那些图标一个都没用上。

**根因有三处，缺一不可**：

| # | 位置 | 问题 |
|---|---|---|
| ① | 版本列表 | 取值写成了 `inst.loader.type \|\| inst.icon` —— **加载器永远有值，`inst.icon` 永远轮不到**，而且所有加载器都映射到 `ic_grass` |
| ② | 右下角版本行 | `iconEl.src` 被写死成 `./assets/icon/ic_grass.png` |
| ③ | 后端 `hydrate()` | **从不返回 `iconFile`** —— 自定义图片即使存进去了，前端也拿不到地址 |

**修复**：

- 新增 `src/renderer/js/instanceicon.js` 作为唯一解析入口，优先级为
  **自定义图片 → 24 个预置图标 → 兜底草方块**
- 四处显示点全部改用它：主页实例卡、右栏版本行、版本列表、版本设置「当前」大图
- 后端 `hydrate()` 补上 `iconFile` + `iconUrl`
- 主进程新增 `qcl://app/__instanceicon__/<id>.png` 只读通道 ——
  自定义图片存在 `<数据目录>/icons/` 下，不在 renderer 目录里，
  原协议会因目录穿越防护返回 403；新通道只允许读该目录下的 png，
  **不放宽整体安全边界**
- 版本设置页的图标白名单也统一到共享模块，避免两处定义漂移

**实测**（`build/verify-icon-dom.js`，7/7 PASS）：把实例图标设为 `diamond` 后，

| 显示点 | 结果 |
|---|---|
| 主页实例卡 | `./assets/instance-icons/diamond.png` ✅ |
| 右栏版本行 | `./assets/instance-icons/diamond.png` ✅ |
| 版本列表行 | `./assets/instance-icons/diamond.png` ✅ |
| 版本设置「当前」大图 | `./assets/instance-icons/diamond.png` ✅ |
| 版本设置网格高亮 | `./assets/instance-icons/diamond.png` ✅ |
| 图标网格数量 | 24 ✅ |

后端链路另有 8 项独立验证（`iconFile` 写入 → `iconUrl` 转换 → 通道地址 → 文件存在 → 还原），同样全过。

### 程序目录的「QCL数据」入口

上一版 1.0.2 新增的目录联接已在实机确认可用：

```
Programs\QCL\QCL数据   --Junction-->   文档\QCL
```

打开程序目录点进去，`instances`、`accounts.json`、`meta` 全部可见。

---

## 1.0.2 已包含

- 主页「我的实例」面板：列出全部实例、显示真实版本与加载器、一键切换当前实例
- 程序目录可见数据入口（目录联接，权限不允许时自动改为指路文件）

## 1.0.1 已包含

- 修复远古版本（b1.7.3、1.0~1.12）启动窗口不关（老式 LWJGL 2 的 `OpenAL initialized.` 判据）
- 联机进行中不再收起启动器窗口
- 游戏内 QCL 签名对齐 HMCL

## 1.0.0 已包含

- 版本覆盖 `rd-132211` → `26.x`；正式版 / 快照 / 愚人节版本 / 远古版本
- 全远古版本自动注入两行 Betacraft 兼容参数
- 归档快照（官方已删除、Betacraft 收录的 74 个周快照）
- 中文补丁 / 微软账号皮肤披风 / 远古音效 / 多加载器 / Terracotta 联机

## 已知限制

- 目前只打包 Windows x64
- 26.x 及部分 1.21.x 官方尚未发布 OptiFine，这些版本的 OptiFine 会置灰
- 两台机器真实联机尚未实测

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)。
