# QCL 电脑版 1.0.8

Windows 上的 Minecraft Java 版启动器，全中文界面，基于 Electron。**双击安装包即装，无需管理员权限，不依赖任何外部运行库。**

## 下载

- **`QCL-Setup-1.0.8.exe`**（约 130 MB，中文自解压安装程序）← 本 Release 的 Assets
- 仓库：<https://github.com/ALLEN201123/qcl-pc>
- 许可：GNU GPL-3.0

装完在「设置 → 关于」里应显示 `QCL 1.0.8`。装之前请先关掉正在运行的旧版 QCL。

---

## 一、端口不再撞

以前 `defaultMeta` 把端口**写死 25565**，建第二个服务端必然撞端口，
要等启动失败才报错 —— 属于「先让你犯错再告诉你」。

现在建服会**自动往上找空位**：

```
第 1 个 → 25565
第 2 个 → 25566
第 3 个 → 25567
```

规则：

- 跳过已被本项目其它服务端占用的端口
- 再真绑一次确认系统层没被占（不是查表格）
- **你自己填了端口就原样用**，不覆盖
- 顺手把端口写进 `server.properties`，meta 与配置不会打架

---

## 二、插件 / 模组管理（之前完全没有）

新增「插件 / 模组」标签页，按服务端核心自动给对按钮：

| 核心 | 装什么 | 目录 | 来源 |
|---|---|---|---|
| Paper / Purpur | **插件** | `plugins/` | CurseForge |
| Fabric / Forge / NeoForge | **模组** | `mods/` | Modrinth |
| 原版 vanilla | 不支持 | — | 界面会说明换哪个核心 |

**为什么插件走 CurseForge、模组走 Modrinth**：
Modrinth **不收编 MC 插件** —— 它的 `categories` 里只有 fabric/forge/neoforge/quilt，
根本没有 paper/bukkit/spigot，传哪个 loader 都是 0 条（实测过）。
插件在 CurseForge 是独立分类 `classId=5`（Bukkit Plugins），走免 key 镜像。

**能做的事**：

- 搜索（自动带上你服的 MC 版本 + 核心类型筛选）
- 一键安装到 `plugins/` 或 `mods/`
- 查看已安装、**启用/禁用**（改名 `.disabled`，不删文件）、删除
- 一键打开目录，自己往里丢也行

实测：插件搜 `essentials` 拿到 **EssentialsX（249 万下载）**；
模组搜 `lithium` 拿到 **Lithium（1.45 亿下载）**、`jei` 拿到 **JEI（8665 万下载）**。

---

## 三、部署位置看得到

服务端详情顶部新增「部署位置」，直接显示真实磁盘路径，可复制。
鼠标悬停还能看到世界、备份、日志各自的目录。

---

## 四、配置能改

「配置」标签页 **46 项全部可改并保存**：端口、最大人数、标语、难度、
视距、正版验证、白名单、刷怪、世界边界……

带校验：人数超 1000、端口超 65535 会被拦下来，不会写坏配置。

---

## 五、上一版遗留的两个问题也一起修了

### 点「新建服务端」卡住

原来是先拉 900+ 条版本清单才弹窗，网络慢的时候点了半天没反应。
现在**先弹窗、后台加载**，实测 **1.2 秒内**出来。

### 新建对话框补上版本分组与核心

- 版本分四组：**正式版 / 快照 / 远古版本 / 手动填**
  - 快照 835 个（含官方已删除、Betacraft 归档保留的）
  - 远古版本 70+ 个（含 `b1.9-pre1`~`pre6`、`a0.2.8`、`c1.4`）
  - 都带内置兜底清单，秒出，不用等 17 秒的归档抓取
- 核心补上 **Forge** 与 **NeoForge**
  - Forge：1.7.10 → 26.3（实测 1.20.1=47.4.28、1.12.2=14.23.5.2859）
  - NeoForge：1.20.2 → 26.3（实测 26.3=26.3.0.115、1.21.1=21.1.267）

**Forge/NeoForge 不是「下载即用」** —— 它们发布的是 installer，
必须跑 `--installServer` 生成 `libraries/` 才能启动。这次把它做完整了：
下载 installer → 写 `launcher_profiles.json` → 执行安装 → 自动识别启动方式
（老版本 `-jar forge-x.jar`，1.17+ 用 `@libraries/.../win_args.txt`）。

---

## 六、修的一个真 bug

禁用插件后文件变成 `xxx.jar.disabled`，而列表只认 `.jar` 结尾，
于是禁用完那个插件就从列表里**消失**了，没法再启用回来。已修
（正则改成 `\.(jar|zip)(\.disabled)?$`）。

---

## 验收

| 脚本 | 结果 |
|---|---|
| `build/verify-server-108.js` | **58/58 PASS** — 端口递增 25565/25566/25567、显式端口不覆盖、端口不重复、46 项配置可改含端口人数、非法值拦截、插件搜 CurseForge、模组搜 Modrinth、安装目录、启用禁用删除、目录穿越防护、UI 与 8 个 IPC 通道 |
| `build/verify-server.js` | **105/105 PASS** — 含真跑服务端进程（启动→就绪→下发命令→优雅停止→诊断） |
| `build/verify-server-createdialog2.js` | **17/17 PASS** — 1.2 秒弹窗、6 个核心、4 个版本分组、远古版 70 个、快照 835 个 |
| `build/verify-server-tunnel-multi.js` | **28/28 PASS** — bore 真起隧道 + 真从公网连回收到数据、四种穿透方案 |
| `build/verify-server-versions.js` | **55/55 PASS** — 26.3 / 快照 / 1.0.0 / b1.7.3 / b1.9-pre / a0.2.8 / c1.4 / Paper / Purpur / Fabric |
| `build/verify-toolbox.js` | **64/64 PASS**（回归） |

## 已知限制

- 目前只打包 Windows x64
- **原版服不能装插件/模组** —— 这是 Minecraft 本身的规则，不是没做；界面会提示换核心
- 模组服装的模组，**客户端也要装同样的**才能进（纯服务端模组除外）
- 装插件/模组前需要先停服（运行中会被文件占用），界面会拦
- `a1.2.6` 等 Alpha 后期版本仍无服务端来源（Mojang 已下架、归档只到 a0.2.8）
- STUN 打洞未放进界面：Windows 上 Node 的 `net.connect` 不暴露 SO_REUSEADDR，
  「同端口既监听又外连」做不到（五台 STUN 服务器全部复现 EADDRINUSE），
  与其给个必然失败的按钮，不如不放

详细文档见仓库 [README.md](https://github.com/ALLEN201123/qcl-pc#readme)。
