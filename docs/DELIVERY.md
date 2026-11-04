# QCL 电脑版 · 交付说明

> **交付物**：`D:\HMCL-PE重构QCL计划\outputs\QCL-1.0.0-win-x64.exe`（80.4 MB，单文件绿色版）
> **源码**：`D:\HMCL-PE重构QCL计划\qcl-pc\`

---

## 一、这是什么

QCL（Quanta Craft Launcher，量子方块启动器）的 **Windows 桌面版**。

- **界面**：照搬安卓版 QCL 1.5.9 的「新排版」——全屏壁纸 + 左下右三栏常驻浮层 + 主题色 `#865D58`
- **启动核心**：参照 **MultiMC**（`vendor/MultiMC`，C++/Qt 源码，只读参照不编译）实现版本解析、库规则、natives、资源索引、Java 检测、命令行拼装
- **差异化能力**：远古版本（pre-classic / classic / indev / infdev / alpha / beta）+ **中文补丁**

## 二、怎么用

双击 `QCL-1.0.0-win-x64.exe` 即可（绿色版，首次运行会自解压到临时目录，数据写在 `文档\QCL`）。

开发调试：
```powershell
cd D:\HMCL-PE重构QCL计划\qcl-pc
node build\run.js          # 起界面（自动处理 ELECTRON_RUN_AS_NODE）
node build\play.js         # 列出已装版本
node build\play.js b1.7.3  # 直接启动某个版本
```

打包：
```powershell
pwsh -File build\make-portable.ps1    # 一条命令出单文件 exe
```

## 三、已验证的功能（都是真跑出来的，不是"编译通过"）

### 启动器核心
| 项 | 结果 |
|---|---|
| 官方版本清单 | 922 个版本，最新 26.3 |
| 远古版本清单 | **315 条**（ancient 139 / snapshot 115 / old_alpha 35 / old_beta 26） |
| Java 检测 | 认出 **10 个** Java（1.8 / 11 / 17 / 21 / 25，含版本+架构+厂商） |
| 离线 UUID | 与官方算法逐字节一致（MD5 + 版本位 3 + 变体位） |
| natives | 老版本 1.12.2 正确列出 3 个 natives 包 |

### 端到端（真实下载 + 真实启动 Java）
| 版本 | 安装 | 启动 | 说明 |
|---|---|---|---|
| **b1.7.3**（Beta） | ✅ 480 文件 / 50MB / 86s | ✅ **进游戏主循环** | 日志 `151 recipes` / `16 achievements` |
| **pc-132011**（pre-classic） | ✅ 12 文件 | ✅ **RubyDung 初始化成功** | 日志 `com.mojang.rubydung.RubyDung.init` |
| **c0.0.13a**（Classic） | ✅ | ✅ **找到 MinecraftApplet** | 日志 `Found likely Minecraft candidate` |
| **b1.7.3 + 中文补丁** | ✅ jar 1.40→2.95MB | ✅ **主界面全是中文** | 截图存证 |

### 中文补丁（QCL 核心特色）
```
node build\verify-chinesepack.js b1.7.3
════════ 结果：12/12 通过 ════════
```
游戏内实证：`单人游戏` / `多人游戏` / `模组与材质包` / `选项` / `退出游戏`，
标题标语「绝对没有桶」—— 中文渲染完全正确。

详见 [`docs/CHINESE_PACK.md`](./CHINESE_PACK.md)。

## 四、窗口「边缘完美融合」是怎么做的

1. `frame: false` —— 没有系统标题栏、没有灰色边框
2. `transparent: true` —— 窗口底色全透明
3. 窗口比卡片大 **18px**，阴影用 CSS 画，窗口物理边缘之外就是柔和阴影渐变到桌面
4. 壁纸 `background-size: cover` 铺满卡片，圆角以内**每一个像素都是壁纸**
5. 最大化时 `inset` 归零，卡片铺满整屏

## 五、这一轮修掉的真实 bug（都有硬证据）

| Bug | 症状 | 根因 |
|---|---|---|
| **electron 起不来** | 秒崩 0xC0000005 / `protocol` 是 undefined | DSH 宿主设了 `ELECTRON_RUN_AS_NODE=1`，子进程继承 → Electron 降级成纯 Node |
| **界面卡在启动画面** | 「正在准备界面…」永不消失 | `index.html` 缺 **importmap**，`import ... from 'three'` 解析失败 |
| **importmap 被拦** | `Failed to resolve module specifier "three"` | CSP `script-src` 没允许内联 → 加 sha256 hash |
| **壁纸不显示** | 整屏灰色 | `background-image: var(--wallpaper)` 里变量值是 `url()` → CSS 判为无效值整条丢弃 |
| **左栏图标空白方块** | 3 个图标是灰块 | 同上：`mask-image: var(--mask)` 无效值 |
| **人物不显示（第一层）** | 画布全空 | `_applySkin` 方法不存在（真名是 `_applyTextureToModel`） |
| **人物不显示（第二层）** | 模型可见但画布空 | `_refreshCurrentModel` 在模型未加载时**静默 return**，皮肤被丢弃 |
| **人物太小** | 只占画布 4.9% | 照抄规格书 `16.5` 常数，但 PC 模型只有 2 单位高 → 改按模型包围盒反算 |
| **人物被合成丢失** | GL 里有 14 万像素但窗口看不到 | 缺 `preserveDrawingBuffer: true` |
| **pre-classic 启动崩溃** | `ClassNotFoundException: MinecraftApplet` | `pc-*` 被一律甩给 AlphaVanillaTweaker，但它硬查 Applet；RubyDung 时代主类其实是 `com.mojang.rubydung.RubyDung` |
| **中文补丁后游戏崩溃** | `SecurityException: SHA1 digest error` | 改了 jar 内容但没清 Mojang 签名（`MOJANG_C.SF/DSA` + MANIFEST 摘要） |

## 六、已知限制（如实说明，没做的就是不做的）

1. **中文补丁目前只做 b1.7.3** —— 安卓版有 77 组（119 个 jar / 13.2MB），
   按你的选择「先跑通一个再铺开」，机制已验证，扩展方式见 `docs/CHINESE_PACK.md`。
2. **Forge / NeoForge / OptiFine / LiteLoader 安装未实现** —— 这些要跑官方安装器改写客户端 jar。
   **Fabric / Quilt / 原版 / 全部远古版本都可以**。
3. **Betacraft 的 proxy-args**（`-Dhttp.proxyHost=betacraft.uk`）只记录未启用（离线启动用不到）。
4. **只打包 Windows x64**。
5. 微软正版登录走设备码流程（需要联网）；离线账号随时可用。

## 七、目录结构

```
qcl-pc/
  build/                       打包与诊断脚本
    make-portable.ps1          一条命令出单文件 exe
    run.js                     开发启动器（处理 ELECTRON_RUN_AS_NODE）
    play.js                    直接启动某个已装版本
    e2e.js                     端到端验收（真下载 + 真启动）
    verify-chinesepack.js      中文补丁验证
    selftest.js                核心自测（15 项）
  docs/
    CONTRACT.md                接口契约（IPC / 数据结构）
    SKIN_RENDERER_SPEC.md      3D 人物移植规格书
    CHINESE_PACK.md            中文补丁实现与踩坑
  src/main/
    index.js                   主进程入口（qcl:// 协议、userData 兜底）
    window.js                  无边框融合窗口
    ipc.js                     IPC 路由
    settings.js / logger.js
    core/                      启动器核心（17 个模块）
      install.js launch.js version.js libraries.js natives.js
      assets.js downloader.js java.js mojang.js instances.js accounts.js
      chinesepack.js zipwriter.js zip.js rules.js paths.js ...
      data/                    远古版本清单 + 中文补丁资源（1.13MB）
  src/preload/index.js         contextBridge 桥
  src/renderer/                界面（原生 ESM，无构建步骤）
    js/skin.js                 three.js + glTF 人物渲染
    vendor/three/              本地 three.js（不走 CDN）
    assets/skin_model/         glTF 模型 + 皮肤
  vendor/MultiMC/              MultiMC 源码（只读参照）
```
