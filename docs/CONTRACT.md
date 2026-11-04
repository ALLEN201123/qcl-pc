# QCL 电脑版 · 接口契约 v1（Lead 冻结，改动必须找 Lead）

> 目标：Electron 桌面版 QCL（Quanta Craft Launcher），启动核心逻辑参照 `vendor/MultiMC`（C++/Qt 源码，只读参照，不编译）。
> 交付：Windows x64 单文件 exe（electron-builder portable）。

## 0. 铁律

1. **全程简体中文**（界面文案、日志、注释、报错，一个英文单词都不许漏在界面上）。
2. **不许搭空壳**：每个 IPC 通道都必须有真实实现；界面按钮点下去必须有真实反应。
3. **不许自己 `npm install`**（依赖已装好：electron 33 + electron-builder）。核心代码只用 Node 内置模块 + `electron`。
4. **写作用域**（越界改文件视为冲突，立刻停手找 Lead）：
   - Lead：`src/main/index.js`、`src/main/window.js`、`src/main/ipc.js`、`src/preload/**`、`build/**`、`docs/**`、`package.json`
   - core-dev：`src/main/core/**`
   - ui-dev：`src/renderer/**`
5. 改完必须自测（`npm start` 能起来 / `node -e "require('./src/main/core/xxx')"` 不炸）。

## 1. 目录布局

```
qcl-pc/
  package.json
  src/main/index.js        主进程入口（Lead）
  src/main/window.js       无边框融合窗口（Lead）
  src/main/ipc.js          IPC 路由（Lead）
  src/main/core/*.js       启动器核心（core-dev）—— CommonJS，无第三方依赖
  src/preload/index.js     contextBridge 桥（Lead）
  src/renderer/            界面（ui-dev）—— 纯 HTML/CSS/JS，无构建步骤
  vendor/MultiMC/          MultiMC 源码参照（只读）
```

## 2. 数据目录布局（QCL 主目录，默认 `文档\QCL`，可在设置里改）

```
<QCL_HOME>/
  settings.json                 全局设置
  accounts.json                 账号
  instances.json                实例索引（id -> 实例路径）
  instances/<id>/
      instance.json             实例元数据
      .minecraft/               隔离的游戏目录（照 MultiMC 实例隔离模型）
          versions/<ver>/<ver>.json|<ver>.jar
          libraries/  assets/  natives/  mods/  saves/  resourcepacks/
  meta/                         共享缓存
      version_manifest_v2.json  官方清单缓存
      versions/<id>.json        版本 JSON 缓存
      assets/indexes/<id>.json
  logs/latest.log               最近一次启动日志（供「查看上次启动日志」）
```

## 3. IPC 契约

渲染进程统一用 `window.qcl.invoke(通道, 参数)` → `Promise<结果>`；
主进程推进度/日志用 `window.qcl.on(事件, 回调)`。
**preload 会把两者暴露为 `window.qcl.invoke` / `window.qcl.on` / `window.qcl.off`。**

### 3.1 请求（invoke）

| 通道 | 入参 | 返回 |
|---|---|---|
| `app:info` | `{}` | `{name,version,platform,home,arch}` |
| `win:minimize` | `{}` | `{ok:true}` |
| `win:toggleMaximize` | `{}` | `{maximized:boolean}` |
| `win:close` | `{}` | `{ok:true}` |
| `win:state` | `{}` | `{maximized:boolean}` |
| `settings:get` | `{}` | `Settings` |
| `settings:set` | `Partial<Settings>` | `Settings` |
| `instances:list` | `{}` | `Instance[]` |
| `instances:create` | `{name,mcVersion,loader?}` | `Instance` |
| `instances:delete` | `{id}` | `{ok:true}` |
| `instances:rename` | `{id,name}` | `Instance` |
| `instances:select` | `{id}` | `{ok:true}` |
| `instances:update` | `{id,patch}` | `Instance` |
| `versions:manifest` | `{}` | `{latest:{release,snapshot},versions:[VersionEntry]}` |
| `versions:ancient` | `{}` | `[VersionEntry]`（远古版本，见 §5） |
| `versions:local` | `{id}` | `[LocalVersion]` |
| `install:start` | `{id,mcVersion,loader?}` | `{taskId}` |
| `install:cancel` | `{taskId}` | `{ok:true}` |
| `launch:start` | `{id}` | `{pid}` |
| `launch:kill` | `{id}` | `{ok:true}` |
| `accounts:list` | `{}` | `Account[]` |
| `accounts:addOffline` | `{name}` | `Account` |
| `accounts:addMicrosoft` | `{}` | `{flowId,userCode,verificationUri,expiresIn}` |
| `accounts:microsoftPoll` | `{flowId}` | `{status:'pending'\|'done'\|'error',account?,message?}` |
| `accounts:remove` | `{uuid}` | `{ok:true}` |
| `java:list` | `{}` | `JavaInstall[]` |
| `java:add` | `{path}` | `JavaInstall` |
| `java:detect` | `{}` | `JavaInstall[]` |
| `log:recent` | `{limit}` | `string[]`（最新启动日志尾部） |
| `shell:openPath` | `{path}` | `{ok:true}`（不存在则 `{ok:false,error}`） |
| `shell:openExternal` | `{url}` | `{ok:true}` |

### 3.2 事件（main → renderer）

| 事件 | payload |
|---|---|
| `task:progress` | `{taskId,phase,stage,current,total,file,speed,done,error?}` |
| `launch:log` | `{id,line,stream:'stdout'\|'stderr'}` |
| `launch:state` | `{id,state:'starting'\|'running'\|'exited',pid?,code?}` |
| `instances:changed` | `{}` |
| `accounts:changed` | `{}` |
| `settings:changed` | `Settings` |
| `win:state` | `{maximized}` |

### 3.3 数据结构

```js
Settings = {
  home: string,                 // QCL 主目录（绝对路径）
  javaPath: string|null,        // 全局 Java，null = 自动检测
  theme: {
    accent: string,             // 默认 '#865D58'（QCL 主题色）
    mode: 'auto'|'light'|'night',
    wallpaperId: string,        // 'builtin:day' | 'builtin:night' | 'builtin:classic' | 'file:<绝对路径>'
    panelAlpha: number          // 0.3~1.0，左右浮层不透明度，默认 0.7
  },
  memory: { mode:'auto'|'manual', mb:number },
  launch: { width:number, height:number, fullscreen:boolean, extraJvmArgs:string, extraGameArgs:string },
  downloader: { threads:number, source:'official'|'bmclapi' },
  closeToTray: false,
  layout: 'new'|'old'           // 新排版（左常驻栏，默认）/ 旧排版
}

Instance = {
  id, name, icon,               // icon 为 'grass'|'forge'|... 或图片路径
  mcVersion: string,
  loader: { type:'vanilla'|'forge'|'fabric'|'quilt'|'neoforge'|'optifine'|'liteloader', version:string } | null,
  java: { path:string|null, memoryMb:number|null },
  created: number, lastPlayed: number|null, playTime: number,
  dir: string                   // <QCL_HOME>/instances/<id>
}

Account = { uuid, name, type:'offline'|'microsoft', accessToken?, refreshToken?, expiresAt?, avatar? }

JavaInstall = { path, version, arch:'x64'|'x86'|'arm64', vendor, major, isJre, source:'auto'|'manual' }

VersionEntry = { id, type:'release'|'snapshot'|'old_beta'|'old_alpha'|'ancient', url, releaseTime, sha1? }
LocalVersion = { id, jarExists, jsonExists, loader, installedAt, sizeBytes }
```

## 4. 核心实现要求（core-dev）

参照 MultiMC 的实现，**必须真读源码再写**，关键文件：

| 主题 | MultiMC 参照文件 | 要求 |
|---|---|---|
| 版本 JSON 解析 | `launcher/minecraft/VersionFile.cpp`、`MojangVersionFormat.cpp` | 支持 `inheritsFrom` 继承合并（子覆盖父） |
| rules 匹配 | `launcher/minecraft/Rule.cpp`、`Library.cpp` | `os.name`(windows)、`os.arch`(x86/x64/arm64)、`os.version` 正则、`features`（is_demo_user / has_custom_resolution / has_quick_plays_support / is_quick_play_*） |
| 库解析 | `launcher/minecraft/Library.cpp` | `name`→ Maven 路径 `group/artifact/version/artifact-version[-classifier].ext`；`natives` 按 arch 取 classifier；重复 artifact 取版本更高者（MultiMC 用 GradleSpecifier 比较） |
| natives 解压 | `launcher/minecraft/launch/ExtractNatives.cpp` | 解到实例 `.minecraft/natives/`，**排除 META-INF/**；支持 `extract.exclude` |
| 资源索引 | `launcher/minecraft/AssetsUtils.cpp` | `assets/indexes/<id>.json` → 每个对象 `objects/<前2位>/<hash>`，URL `https://resources.download.minecraft.net/<前2位>/<hash>` |
| 命令行 | `launcher/minecraft/MinecraftInstance.cpp`（`createLaunchScript`/`getLaunchArguments`）| 参数占位符 `${auth_player_name}` `${version_name}` `${game_directory}` `${assets_root}` `${assets_index_name}` `${auth_uuid}` `${auth_access_token}` `${user_type}` `${version_type}` `${natives_directory}` `${launcher_name}` `${launcher_version}` `${classpath}` `${classpath_separator}` `${library_directory}` `${game_assets}`；新版本用 `arguments.jvm`/`arguments.game` 数组（含条件），老版本用 `minecraftArguments` 字符串 |
| Java 检测 | `launcher/java/JavaInstallList.cpp`、`JavaChecker.cpp` | 扫注册表/常见目录/PATH；`java -version` 解析版本与架构；按 MC 版本选 Java（≤1.16 → 8；1.17~1.20.4 → 17；1.20.5+ → 21；26.x → 25） |
| 启动 | `launcher/minecraft/launch/DirectJavaLaunch.cpp` | `spawn(java, args, {cwd: .minecraft, windowsHide:true})`，stdout/stderr 按行推 `launch:log` |

**其他硬要求**

- 并发下载器：默认 16 线程，sha1 校验，失败重试 3 次；`downloader.source='bmclapi'` 时把 `piston-meta.mojang.com`/`launchermeta.mojang.com`/`resources.download.minecraft.net`/`libraries.minecraft.net` 换成 `bmclapi2.bangbang93.com` 对应镜像。
- 进度必须真实（按文件数与字节数算），推 `task:progress`。
- 安装流程：拉版本 JSON（含继承链）→ 下载 client.jar → 下载 libraries → 解压 natives → 下载 assets（含虚拟资源 `virtual/legacy`、`map_to_resources` 两种 legacy 处理）→ 写 `instance.json`。
- 必须能取消（`install:cancel` 用 AbortController 或标志位真正中断）。
- **所有网络请求带超时与重试**；离线时给出中文错误，不许抛英文栈。
- `log:recent` 读 `<QCL_HOME>/logs/latest.log`，尾部 N 行。

## 5. 远古版本（QCL 的看家本领，必须做）

安卓版支持**考古社区已归档的全部远古版本**（pre-classic / classic / indev / infdev / alpha / beta / RC）。PC 版必须同样能装能启动：

- `versions:ancient` 从 `https://raw.githubusercontent.com/...` 不可用（本机走 SteamTools 代理会失败）时，**回落到本地内置清单** `src/main/core/data/ancient-versions.json`（core-dev 生成，字段与 `VersionEntry` 一致，至少含 id / url / releaseTime / type='ancient'）。
- 远古版本 JSON 里的库是**老式 `minecraftArguments` 字符串**，且常缺 `assets`/`natives` 字段 → 必须有兜底：无 assets 时跳过资源下载，`inheritsFrom` 缺失时按独立版本处理。
- 远古版本的资源挂载：`virtual/legacy`（把 objects 铺进 `assets/virtual/legacy/`）必须实现，否则声音/语言文件找不到。

## 6. 界面要求（ui-dev）

**核心视觉：窗口边缘与界面完美融合** —— 没有系统标题栏、没有灰色边框，**壁纸铺到窗口物理边缘**（`border-radius` 圆角以内的每一个像素都是壁纸），所有控件是浮在壁纸上的半透明层。

照安卓版 1.5.x「新排版」（`ui_main_new*.xml`）：

- **左侧常驻图标导航条**（宽 64px，半透明底板 `rgba(237,237,237,.70)`，夜间 `rgba(23,28,34,.70)`，圆角 12px），自上而下纯图标入口：
  主页 / 当前版本 / 版本列表 / 下载 / 实验室 / JAR 启动 / 上次日志 / 多人联机 / 设置 / 返回。
- **中间内容区**：公告卡（约 40% 宽，可翻页 ◀ ▶、展开收起、隐藏）+ 3D 人物区（约 48%，垂直居中）。
- **右侧常驻栏**（宽 25%）：账号头像 64px + 账号名（16px 粗）+ 状态（12px）**垂直居中**；底部「版本行」与「启动游戏」按钮**同宽同高、圆角半透明**，版本行在上、启动按钮贴底。
- **主题色**：默认 `#865D58`（棕红，取色自苍白花园壁纸）。按钮 = **深底浅字**（底色跟随主题色，文字 `#F2F6FA`），**不要白色按钮**。
- **昼夜成对**：浅色态面板近白半透明 + 深色文字；夜间态面板深色半透明 + 白色文字。**绝不允许深底黑字/白底白字**。
- 自绘标题栏（右上角 最小化/最大化/关闭，`-webkit-app-region: no-drag`），窗口可拖拽区 `-webkit-app-region: drag`。

**必须实现的页面**（左侧栏能全部点开，不是空页）：主页、版本列表、下载（版本/远古版本/整合包安装入口）、版本设置、账号管理、设置（外观/Java/内存/下载源/关于）、启动日志、关于。

**资源来源**（直接复制，不要重画）：
- 壁纸：`D:\QCL-build\QCL\src\main\res\drawable-nodpi\qcl_bg_day.jpg`（日）、`qcl_bg_1..6.jpg`、`drawable\ic_background.jpg`（苍白花园 2560×1600 主壁纸）、`drawable\ic_background_classic.jpg`
- 图标：`res\drawable\ic_qcl_*.xml|png`（是矢量/PNG，PNG 直接用；XML 矢量照 pathData 转成内联 SVG）、`ic_baseline_home_white.xml`、`ic_baseline_arrow_white.xml`、`ic_baseline_star_black.xml`、`ic_qcl_last_log_white.xml`、`ic_grass*`
- 复制到 `src/renderer/assets/`

**技术约束**：无构建步骤（原生 ES module + CSS），`index.html` 直接跑在 Electron 渲染进程里；通过 `window.qcl` 与主进程通信；**不许用 CDN**（离线可用）；3D 人物用 canvas 2D 画一个可旋转的 Minecraft 皮肤模型（正版皮肤从账号皮肤站拉，取不到就用默认 Steve），不许留空白占位。

## 7. 验收

- `npm start` 能起窗口，无控制台报错。
- 窗口截图：四角圆角内全部是壁纸，无灰边、无系统标题栏。
- 主页能真实拉取版本清单（网络可用时）、能创建实例、能下载安装原版、能启动 Java。
- 「查看上次启动日志」能读到真实日志。
