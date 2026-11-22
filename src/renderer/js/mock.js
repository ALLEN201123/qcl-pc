/**
 * QCL 电脑版 · 内置示例数据 + 降级实现
 *
 * 用途（契约 §6 / Lead 约定）：主进程未连接、或 core 模块尚未就绪时，
 * 界面必须**照常有内容**，绝不白屏。所有示例数据都在这里。
 *
 * 另：`install:start` 在降级模式下会模拟 `task:progress` 事件，
 * 让「下载进度条」这条链路即使没有 core 也能被验证。
 */

/** 由 bridge.js 在初始化时注入，避免模块循环依赖 */
let emitter = null;
export function setMockEmitter(fn) {
  emitter = fn;
}
function emit(evt, payload) {
  if (typeof emitter === 'function') emitter(evt, payload);
}

const HOUR = 3600 * 1000;

/* ------------------------------ 公告（电脑版首发公告） ------------------------------ */

/**
 * ★ 电脑版（Quanta Craft Launcher PC）1.0.0 首发公告。
 *
 * 以前这里是直接搬安卓版 1.5.9 的公告，标题写着「QCL 1.5.9」「JAR 启动」之类 ——
 * 那些是**手机版**的版本号和功能，放在电脑版里纯属误导（JAR 启动在 PC 上已经移除了）。
 * ⇒ 改成电脑版自己的首发说明，版本号跟安卓版最初的 1.0.0 对齐。
 */
export const ANNOUNCEMENTS = [
  {
    id: 107,
    date: '2026-11-22',
    title: 'QCL 电脑版 1.0.7 · 内网穿透补齐：零注册方案 + 四种可选',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、必须补的：没有身份证 / 未满 18 也能开服给人玩',
      '上一版只接了樱花frp 和自建 frps —— 这两条都要实名或成人身份，',
      '很多玩家根本用不了。这次补了**零门槛**方案：',
      '',
      '★「bore 零注册」现已作为默认',
      '· 服务端是公开的 bore.pub，不用注册、不用实名、不用装任何组件',
      '· 连上就分配一个随机公网端口，把这个地址发给朋友就能进',
      '· 实测：从公网地址连回来，真的收到了本地服务端发出的数据',
      '· 代价：每次地址都变、没有密码（谁拿到地址都能连）、延迟看公共节点线路',
      '  适合临时一起玩；长期公开服还是建议用自建 frps',
      '',
      '二、现在一共四种，按门槛从低到高：',
      '① bore 零注册 —— 匿名，什么都不用填（默认）',
      '② 樱花frp —— 需注册拿 token（节点多、稳定）',
      '③ 魅frp —— 需注册拿 token（另一家服务商）',
      '④ 自建 frps —— 自己有公网服务器时用，最快最稳',
      '',
      '三、修了一个协议级 bug',
      'bore 一开始连上却不响应。查官方源码（src/shared.rs）发现：',
      '协议用 **NULL 字节 \\0 分帧**，不是换行符，单帧上限 256 字节。',
      '改对之后一次就通，实测能真转发。',
      '',
      '四、两点说明',
      '· 之前提过的 Terracotta 是「游戏里开房间」联机用的（扫本机游戏世界端口），',
      '  不是给独立服务端做端口映射的，所以没有混进来',
      '· 魅frp 与樱花的接口都已实测（假 token 会得到各自平台的标准错误返回），',
      '  真要用需要你自己去注册',
    ].join('\n'),
  },
  {
    id: 106,
    date: '2026-11-22',
    title: 'QCL 电脑版 1.0.6 · 服务端全版本覆盖 + 内网穿透',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、先纠正我之前的错误说法',
      '我之前说「远古版本没有服务端、Mojang 从没发过」—— 那是错的。',
      '事实是：Mojang 当年**发过**，只是后来把很多 jar 从下载清单里删掉了。',
      'Betacraft 社区把这些官方已丢失的服务端全量保存了下来，它自己就是靠这个开服的。',
      '',
      '二、服务端版本覆盖（三层来源，共 222 个 jar / 193 个版本）',
      '① Mojang 官方仍在清单里的：',
      '   26.3 / 26.4-snapshot-10 / 1.21.11 / 1.20.1 / 1.16.5 / 1.12.2 / 1.8.9 / 1.7.10 / 1.6.4 / 1.2.5 …',
      '② Betacraft 服务端归档（官方已下架的那批，按四类分好）：',
      '   · 正式版 45 个 —— 1.0.0 / 1.0.1 / 1.1 / 1.2 …（就是你说的「1.0 正式版服务端丢了」）',
      '   · 快照 100 个 —— 含 11w47a / 13w16a / 14w08a 这些官方都删了的周快照',
      '   · 远古版 73 个 —— Beta 全系（含 b1.9-pre1 ~ pre6）、Alpha 0.1~0.2、Classic 全系',
      '   · 愚人节版 4 个 —— 2.0 的 red / blue / purple / preview',
      '③ 内置社区服务端（前两者都没有的）：',
      '   · Infdev 专用服务端 —— 官方从没发过 Infdev 服务端，这个实测能跑（会自己生成世界）',
      '   · Beta 1.7.3 插件化服务端（PEMod）—— 原版 b1.7.3 不支持插件，这个可以',
      '',
      '三、内网穿透（上一版完全没做，这次补上）',
      '开了服务端朋友进不来，等于只能自己玩。现在接的是 **frp**：',
      '· 樱花frp（免费公共节点）：填 token 即可，隧道在樱花控制台建好后一键启动',
      '· 自建 frps：填地址 / 端口 / token / 远程端口，TOML 配置自动生成',
      '· frpc 引擎自动下载（官方 frp 0.71.0，带 3 个国内镜像回退）',
      '· 启动后从 frpc 日志里自动识别公网地址',
      '· 连不上 / token 错 / 端口被占用，都给中文诊断',
      '',
      '★ 用的是 frp，不是 MC 客户端联机那个 Terracotta ——',
      '  后者是给「游戏里开房间」用的（扫本机游戏世界），独立服务端要的是标准端口映射。',
      '',
      '四、修的两个问题',
      '· 「新建服务端」按钮点不动 —— 我手写了 .modal-overlay 浮层，',
      '  但项目 CSS 里只有 .modal，那个 div 被塞到页面底部去了。已改用项目统一弹窗。',
      '· Paper 核心全线拿不到 —— 官方旧 API（api.papermc.io/v2）已下线返回 410，',
      '  改接新 API（fill.papermc.io/v3），26.3 也有构建。',
      '',
      '五、已知缺口（不编造）',
      'Alpha 1.2.6 及部分 Alpha 后期版本：Mojang 已下架、Betacraft 归档只到 a0.2.8、',
      '内置服务端也没覆盖。这些版本目前开不了原版服，界面会明确说明并建议改用 Paper / Purpur。',
    ].join('\n'),
  },
  {
    id: 105,
    date: '2026-11-22',
    title: 'QCL 电脑版 1.0.5 · 新增「服务端」（一键开服）',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、左侧导航新增「服务端」',
      '安卓版 1.6.6 的一键开服只有「选版本 → 下载 → 起进程 → 看控制台」，',
      '配置十来个选项、没有备份。PC 版这次做完整了：',
      '',
      '· 四种服务端核心：原版（Mojang）/ Paper / Purpur / Fabric',
      '· 开服前检查：端口占用、Java 版本、jar 是否在、EULA 是否同意，',
      '  有问题当场说清楚，不用等启动失败再猜',
      '· Java 自动匹配：按 MC 版本挑（1.20 用 17、1.21 用 21、26.x 用 25、远古用 8），',
      '  本机装了多个 Java 也能挑对',
      '· 完整 server.properties：46 项配置，分 5 组，全中文说明',
      '  （安卓只有 15 项）',
      '· 5 套一键预设：好友联机 / 公开服 / 创造建筑服 / 硬核生存 / 低配省性能',
      '',
      '二、RCON（安卓没有）',
      '开了 RCON 之后，即使控制台关了也能管服务器：',
      '查在线玩家、发任意命令、全服广播、踢人、设 OP、重载白名单。',
      '「一键开启 RCON」会自动生成密码，端口被占还会自动换一个。',
      '',
      '三、备份（安卓完全没有）',
      '· 手动备份世界 / 全量备份（含模组与配置）',
      '· 定时自动备份，可设间隔与保留份数，自动轮转',
      '· 恢复时**先把当前世界改名留底**，再解回备份 —— 不会直接删你的世界',
      '· 一键导出 zip，方便换机器或分享',
      '· 备份前会先让服务端 save-off + save-all flush，避免拷到写一半的区块',
      '',
      '四、崩溃诊断',
      '启动失败时不是只丢给你一串英文，而是给出中文结论：',
      '端口被占 / 没同意 EULA / Java 版本太低 / 内存不足 / 模组不兼容 …',
      '并挑出日志里最关键的那几行，方便复制反馈。',
      '',
      '五、其他',
      '· 优雅停止：先发 stop 让服务端保存世界，超时才强杀（Windows 下杀整棵进程树，不留孤儿）',
      '· 可选自动重启：崩溃后自动拉起来，可设次数上限',
      '· 控制台中文不再乱码（修了 Java 往管道输出时的编码问题）',
      '· 可同时管理多个服务端',
    ].join('\n'),
  },
  {
    id: 104,
    date: '2026-11-21',
    title: 'QCL 电脑版 1.0.4 · 新增「百宝箱」',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、新增「百宝箱」（左侧导航栏，工具下面）',
      '功能清单照 PCL 的做法，六个真能用的工具：',
      '',
      '· 今日人品 —— 同一天同一账号结果固定，跨天才变。',
      '  用的是用户名+日期的确定性哈希，连算 20 次都一样，不会刷新出来糊弄你。',
      '',
      '· 内存优化 —— 把进程工作集页刷到页面文件。',
      '  ★ 说清楚：这不会让电脑变快。系统显示的「可用内存」会变大，',
      '  但刚切回的程序可能要重新从磁盘读页，短暂卡一下。真正内存不够请关程序。',
      '',
      '· 清理游戏垃圾 —— 先扫描、列出清单让你确认，再走回收站删除。',
      '  只清日志 / 崩溃报告 / 下载残骸。',
      '  ★ 存档、模组、配置、资源包、光影一律不动（代码里写死的保护，不是靠自觉）。',
      '',
      '· 磁盘占用 —— 按目录统计体积，降序排列，每项能一键打开。只统计不删除。',
      '',
      '· 回声洞 —— 反复点会不断出新句子，偶尔附带一条实用小提示。',
      '',
      '· 下载自定义文件 —— 填地址就能下，文件名留空会从地址自动推断，',
      '  保存目录可自选（默认在主目录的 MyDownload）。支持进度与速度显示。',
      '',
      '· 千万别点 —— 就是个彩蛋，点了只会弹句废话。',
      '',
      '二、百宝箱有自己的图标了',
      '不是拿星星凑数，是单独画的宝箱造型（箱盖 / 箱体 / 中缝 / 锁扣 / 锁孔），',
      '导航栏和页面标题都用它。',
    ].join('\n'),
  },
  {
    id: 103,
    date: '2026-11-07',
    title: 'QCL 电脑版 1.0.3 · 修复实例图标不生效',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、修复：版本设置里选的图标完全不生效（本版重点）',
      '以前不管你在「版本设置 → 图标」里选哪个，版本列表、主页、右下角版本行',
      '永远显示草方块 —— 那 24 个 MultiMC 风格图标一个都没用上。',
      '',
      '根因有三处，全部修好：',
      '① 版本列表取图标的表达式写成了「加载器类型 || 图标名」——',
      '   加载器永远有值，图标名永远轮不到，等于玩家选什么都被无视；',
      '② 右下角版本行的图标被写死成草方块；',
      '③ 后端根本不返回自定义图片路径，即使存了也拿不到。',
      '',
      '现在统一走一套解析逻辑，优先级：',
      '  自定义图片 → 24 个预置图标 → 兜底草方块',
      '四处显示点全部生效：主页实例卡、右栏版本行、版本列表、版本设置「当前」大图。',
      '',
      '二、自定义图片也能用了',
      '在「版本设置 → 图标 → 自定义图标」选一张 PNG，会复制到数据目录的 icons/ 下，',
      '四个显示点立刻跟着变。启动器内部为它单独开了一条只读通道，',
      '不会因此放开整个目录的访问权限。',
      '',
      '三、程序目录的「QCL数据」入口',
      '上一版加的「Programs\\QCL\\QCL数据 → 文档\\QCL」目录联接已确认可用，',
      '打开程序目录就能点进去看到 instances / accounts / meta。',
    ].join('\n'),
  },
  {
    id: 102,
    date: '2026-11-06',
    title: 'QCL 电脑版 1.0.2 · 主页直接看到「我的实例」',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、主页新增「我的实例」面板（本版重点）',
      '以前主页只有公告和 3D 人物 —— 玩家一进来根本看不到自己装了哪些版本，',
      '在程序目录里也找不到 instances，很容易以为数据丢了。',
      '现在主页下方直接列出全部实例：名字、真实版本号、加载器（Fabric/Forge/原版…），',
      '当前正在用的那个标「当前」，点其它卡片一键切换，「当前」标记跟着走。',
      '面板右侧还有「打开数据目录」「管理实例」两个按钮。',
      '',
      '二、程序目录里能看到数据了',
      '安装版的数据在「文档\\QCL」（实例、账号、模组、存档都在那里），',
      '但玩家习惯去程序目录找。现在启动时会在程序目录建一个「QCL数据」入口',
      '（目录联接，不需要管理员权限），点进去就是完整数据；',
      '万一某些机器权限不允许建联接，会自动放一份「QCL数据-在这里.txt」说明文件，',
      '写着真实路径，复制到资源管理器地址栏就能进。',
      '',
      '三、为什么数据和程序是分开的',
      '安装版把数据放「文档\\QCL」是 Windows 惯例：卸载启动器不会删掉你的世界和模组。',
      '程序目录那份 QCL-data 只是 Electron 的缓存，从来不放实例 —— 所以以前你在那里找不到。',
    ].join('\n'),
  },
  {
    id: 101,
    date: '2026-11-05',
    title: 'QCL 电脑版 1.0.1 · 远古启动窗口修复 · 联机保窗 · 游戏内 QCL 签名',
    significant: true,
    text: [
      '仓库与下载：https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、修复：远古版本启动窗口不关（本版重点）',
      'b1.7.3 以及 1.0~1.12 这些老式 LWJGL 2 版本，游戏窗口早就出来了，',
      '启动窗口却一直卡在「等待游戏窗口」不走，直到你自己退出游戏。',
      '原因：老版本日志打的是 OpenAL initialized. / Loading current icons for window，',
      '而旧判据只认现代版的 Sound engine started 与 LWJGL Version:，一条都不匹配。',
      '现在补上老式信号，并且用「句点结尾、不带 on device」把现代版的',
      'OpenAL initialized on device ... 排除在外 —— 26.3 这类现代版不会因此提前误关窗。',
      '',
      '二、联机：进行中不再收起启动器窗口',
      '房间是由启动器托管的，窗口被收起可能让联机中断。',
      '现在只要联机在跑，启动游戏后启动器会保持在前台，',
      '并提示「联机进行中，窗口会保持在前台（避免房间中断）」。',
      '房主用「创建房间（我是房主）」拿邀请码，访客用「加入房间（我是访客）」填码，',
      '结束后点「结束联机」，启动器才恢复正常收起行为。',
      '',
      '三、游戏内 QCL 签名（对齐 HMCL）',
      '以前只能靠 game 界面自己猜，现在补齐了四层标识，玩家和模组都看得到：',
      '· --versionType QCL 1.0.1  → F3 调试界面 / 崩溃报告里的版本类型',
      '· -Dminecraft.launcher.brand=QCL + launcher.version  → 崩溃报告的 Launcher 一行',
      '· -Dnet.minecraft.clientmodname=QCL  → 安卓版 QCL 同款，模组可读',
      '· -Dminecraft.client.jar=<真实 jar>  → 模组识别版本 jar 用',
      '另外启动游戏时会给子进程注入 QCL_VERSION / QCL_TAG_NAME / QCL_LAUNCHER 环境变量',
      '（对应 HMCL 的 HMCL_VERSION / HMCL_TAG_NAME）。',
      '',
      '四、主页',
      '顶部新增「GitHub 仓库」按钮，一键直达；同时会自动检查新版本',
      '（详见「设置 → 关于 → 使用说明 → 更新」）。',
    ].join('\n'),
  },
  {
    id: 100,
    date: '2026-11-05',
    title: '1.0.0 更新：远古参数全覆盖 · 归档快照 · 微软皮肤 · 更新推送',
    significant: true,
    text: [
      '首个正式版 1.0.0 的更新说明。仓库与下载：',
      'https://github.com/ALLEN201123/qcl-pc',
      '',
      '一、远古版本的两行 Betacraft 参数，现在全部覆盖',
      '-Dhttp.proxyHost=betacraft.uk',
      '-Djava.util.Arrays.useLegacyMergeSort=true',
      '装好任何一个远古版本（含官方已删除、被 Betacraft 收录的 11w/12w/13w 周快照、1.0 RC、2.0 愚人节版）',
      '启动都会自动注入这两行：老版本的皮肤 / 会话 / 资源请求走 Betacraft 代理，',
      'Java 7+ 的 TimSort 也不会再让加载世界时崩。判定按 258 条归档清单精确匹配，',
      '装了 OptiFine / Forge / 中文补丁导致版本改名也照样命中。',
      '想亲眼确认：版本设置 → 启动参数，里面显示的就是启动器真正会加的这两行。',
      '',
      '二、顺带修好的微软账号皮肤',
      'Mojang 把 profile 里的 skins[].id 改成纹理哈希、披风挪到 capes 数组，',
      '旧写法匹配不到就全变史蒂夫。这一版按新结构取，主界面 3D 人物和账号页头像',
      '会正确显示你的真实皮肤与披风。',
      '',
      '三、远古音效',
      '远古版本的音效 / 音乐资源按老结构铺进 resources/sound、resources/music，',
      '逐文件补齐 .ogg（资产来自 Mojang asset index 与 Betacraft 归档的资源对象），',
      '修掉了「目录非空就跳过复制」导致进游戏没声音的问题。',
      '',
      '四、官方删掉、Betacraft 还留着的快照',
      '下载页「快照」分页补入 74 个归档周快照（卡片标「归档」），走 .info 还原启动结构，',
      '不需要官方 JSON。',
      '',
      '五、更新推送',
      '打开主页会静默查一次本仓库的 GitHub Releases，有正式新版就在顶部提示，',
      '点「查看更新」跳转下载页；离线 / 限流一律不打扰，只提示不自动安装。',
      '以后发新版不用改客户端代码。详见「设置 → 关于 → 使用说明」。',
    ].join('\n'),
  },
  {
    id: 1,
    date: '2026-11-04',
    title: 'Quanta Craft Launcher PC 1.0.0 正式发布',
    significant: true,
    text: [
      '量子方块启动器电脑版，第一个正式版本。',
      '',
      '一、界面',
      '照安卓版 1.5.x 的「新排版」1:1 还原：左侧常驻图标栏、中间公告 + 3D 人物、右侧常驻账号与启动栏。',
      '窗口无边框，壁纸铺到窗口物理边缘，控件是浮在壁纸上的半透明层 —— 边缘与界面完全融合。',
      '主题色默认 #865D58（苍白花园取色），按钮一律深底浅字；昼夜两套配色成对翻转。',
      '',
      '二、3D 人物（微软账号皮肤）',
      '从安卓版的 glTF 管线彻底移植：Blockbench 模型（13 个网格 + 骨骼层级 + 6 段动画），',
      '基础网格无光照、实心层半兰伯特光照（光方向 0.371/0.743/0.557）、图层 alpha<0.1 丢弃。',
      '拖拽旋转、滚轮缩放、双击复位；微软正版账号的皮肤与披风会自动换上。',
      '（Mojang 改过 profile 结构：skins[].id 变成纹理哈希、披风挪到独立的 capes 数组；',
      '  这一版已按新结构取，主界面人物和账号页头像不会再变成史蒂夫。）',
      '',
      '三、远古版本（QCL 的看家本领）',
      '• 官方清单 900+ 个版本；远古归档清单 258 条（pre-classic / classic / indev / infdev / alpha / beta / RC），',
      '  外加官方已删除、由 Betacraft 收录的 74 个 11w/12w/13w 周快照（下载页「快照」分页标「归档」）。',
      '• 按 jar 实际内容判断时代：RubyDung 时代直启 com.mojang.rubydung.RubyDung，',
      '  Classic 走 AlphaVanillaTweaker，Indev / Infdev / Alpha 各自对应正确的 tweaker。',
      '• 中文补丁：77 条规则 / 71 个补丁包 / 4359 字符表 / 223 张官方点阵，覆盖 alpha 到 beta 全系。',
      '• 装好任何一个远古版本，启动都会自动注入两行 Betacraft 兼容参数：',
      '  -Dhttp.proxyHost=betacraft.uk 和 -Djava.util.Arrays.useLegacyMergeSort=true',
      '  （老版本皮肤/会话/资源走 Betacraft 代理，Java 7+ 的 TimSort 不再让世界加载崩溃）。',
      '  这两行在「版本设置 → 启动参数」里能直接看到，玩家自己写了同名字参数则以玩家为准。',
      '• 远古音效与资源按老结构铺进 resources/：修过「目录非空就跳过复制」的坑，',
      '  现在会逐文件补齐 sound/music 的 .ogg（资产来自 Mojang asset index / Betacraft 归档资源对象），',
      '  进游戏能听到远古版本本来该有的声音。',
      '',
      '四、和手机版不同的地方（PC 化）',
      '• 移除「JAR 启动」—— PC 上双击 jar 或走实例启动就够了。',
      '• 「上次启动日志」并入「工具」页（崩溃分析 + 日志查看）。',
      '• 「实验室」换成「工具」：实例文件夹、崩溃日志分析、实例备份。',
      '• 没有「正在等待」黑屏 —— 启动进度直接显示在右栏按钮上。',
      '',
      '五、注意',
      '远古版本装完会自动打开「不检查游戏文件」：中文补丁改写过游戏 jar，',
      '全量 SHA1 校验会把它当成损坏还原掉，这一点和手机版行为一致。',
    ].join('\n'),
  },
  {
    id: 2,
    date: '2026-11-04',
    title: '关于「检查游戏文件」为什么默认对远古版本关闭',
    significant: false,
    text: [
      'QCL 给远古版本注入中文补丁，做的是「改写游戏 jar」：',
      '换掉该版本的 FontRenderer 类、注入 222 张中文字形点阵、替换 lang 文件、并合并界面翻译 jar。',
      '',
      '因此这些文件的 SHA1 必然和 Mojang 原版对不上。如果启动前跑全量完整性校验：',
      '1) 会被判定「文件损坏」；',
      '2) 检查器会重新下载原版 jar，把中文补丁冲掉；',
      '3) 原版 jar 带 Mojang 数字签名，下次注入又要重新删一遍签名。',
      '',
      '所以：远古版本装完自动打开「不检查游戏文件」（只作用于该版本，不影响其他实例）。',
      '如果你确实想校验，可以在「版本设置」里手动关掉这个开关 —— 但要清楚中文补丁会被还原。',
      '',
      '顺带说明：注入补丁时我们会主动移除 META-INF 下的签名文件并清空 MANIFEST 的逐条目摘要，',
      '否则 JVM 的 JarVerifier 会抛 SecurityException: SHA1 digest error，游戏连主界面都进不去。',
    ].join('\n'),
  },
  {
    id: 3,
    date: '2026-11-04',
    title: '界面与操作提示',
    significant: false,
    text: [
      '左侧常驻栏（从上到下）：主页 / 当前版本设置 / 版本列表 / 下载 / 工具 / 多人联机 / 设置 / 返回上一层。',
      '右侧常驻栏：账号信息垂直居中，底部「版本行 + 启动游戏」两块同宽同高。',
      '',
      '主页人物：拖拽旋转、滚轮缩放、双击复位。',
      '公告：◀ / ▶ 翻页，可展开全文，也可以隐藏。',
      '快捷键：Ctrl + , 打开设置；F5 刷新；Esc 关闭弹窗或返回。',
      '',
      '和手机版最大的不同：启动器关闭后，游戏进程不会跟着退出。',
      '手机上一个 App 杀掉就全没了，PC 上游戏是独立进程，你可以关掉启动器继续玩。',
    ].join('\n'),
  },
];

/* ------------------------------ 设置默认值（与契约 §3.3 一致） ------------------------------ */

export const DEFAULT_SETTINGS = {
  home: 'C:\\Users\\123\\Documents\\QCL',
  javaPath: null,
  theme: {
    accent: '#865D58',
    mode: 'auto',
    wallpaperId: 'builtin:pale',
    panelAlpha: 0.7,
  },
  memory: { mode: 'auto', mb: 2048 },
  launch: { width: 1280, height: 720, fullscreen: false, extraJvmArgs: '', extraGameArgs: '' },
  downloader: { threads: 16, source: 'official' },
  closeToTray: false,
  layout: 'new',
};

/* ------------------------------ 示例实例 ------------------------------ */

export const SAMPLE_INSTANCES = [
  {
    id: 'pale-garden-1214',
    name: '苍白花园 · 1.21.4',
    icon: 'grass',
    mcVersion: '1.21.4',
    loader: null,
    java: { path: null, memoryMb: null },
    created: Date.now() - 42 * HOUR,
    lastPlayed: Date.now() - 3 * HOUR,
    playTime: 5 * HOUR,
    dir: 'C:\\Users\\123\\Documents\\QCL\\instances\\pale-garden-1214',
  },
  {
    id: 'gtnh-1710',
    name: '格雷科技 · 1.7.10',
    icon: 'forge',
    mcVersion: '1.7.10',
    loader: { type: 'forge', version: '10.13.4.1614' },
    java: { path: 'C:\\Program Files\\Java\\jre1.8.0_401\\bin\\javaw.exe', memoryMb: 4096 },
    created: Date.now() - 30 * 24 * HOUR,
    lastPlayed: Date.now() - 2 * 24 * HOUR,
    playTime: 96 * HOUR,
    dir: 'C:\\Users\\123\\Documents\\QCL\\instances\\gtnh-1710',
  },
  {
    id: 'ancient-c030',
    name: '远古考古 · c0.30_01c',
    icon: 'grass',
    mcVersion: 'c0.30_01c',
    loader: null,
    java: { path: null, memoryMb: 1024 },
    created: Date.now() - 6 * 24 * HOUR,
    lastPlayed: null,
    playTime: 0,
    dir: 'C:\\Users\\123\\Documents\\QCL\\instances\\ancient-c030',
  },
  {
    id: 'fabric-1206',
    name: '生电向 · Fabric 1.20.6',
    icon: 'grass',
    mcVersion: '1.20.6',
    loader: { type: 'fabric', version: '0.16.9' },
    java: { path: null, memoryMb: 6144 },
    created: Date.now() - 9 * 24 * HOUR,
    lastPlayed: Date.now() - 26 * HOUR,
    playTime: 18 * HOUR,
    dir: 'C:\\Users\\123\\Documents\\QCL\\instances\\fabric-1206',
  },
];

/* ------------------------------ 示例账号 ------------------------------ */

export const SAMPLE_ACCOUNTS = [
  {
    uuid: '0f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8',
    name: 'Rod123456',
    type: 'microsoft',
    accessToken: 'sample',
    refreshToken: 'sample',
    expiresAt: Date.now() + 20 * HOUR,
    avatar: '',
  },
  { uuid: '9e8d7c6b-5a49-3827-1605-f4e3d2c1b0a9', name: 'Steve', type: 'offline', avatar: '' },
];

/* ------------------------------ 示例 Java ------------------------------ */

export const SAMPLE_JAVA = [
  {
    path: 'C:\\Program Files\\Java\\jre1.8.0_401\\bin\\javaw.exe',
    version: '1.8.0_401',
    arch: 'x64',
    vendor: 'Oracle',
    major: 8,
    isJre: true,
    source: 'auto',
  },
  {
    path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.11.9-hotspot\\bin\\javaw.exe',
    version: '17.0.11',
    arch: 'x64',
    vendor: 'Eclipse Adoptium',
    major: 17,
    isJre: false,
    source: 'manual',
  },
  {
    path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\javaw.exe',
    version: '21.0.5',
    arch: 'x64',
    vendor: 'Eclipse Adoptium',
    major: 21,
    isJre: false,
    source: 'auto',
  },
];

/* ------------------------------ 示例版本清单 ------------------------------ */

function v(id, type, releaseTime) {
  return {
    id,
    type,
    releaseTime,
    url: `https://piston-meta.mojang.com/v1/packages/示例/${id}.json`,
  };
}

export const SAMPLE_MANIFEST = {
  latest: { release: '1.21.4', snapshot: '24w45a' },
  versions: [
    v('24w45a', 'snapshot', '2026-11-06T10:00:00+00:00'),
    v('1.21.4', 'release', '2026-10-22T09:12:00+00:00'),
    v('1.21.3', 'release', '2026-09-24T11:20:00+00:00'),
    v('1.21.2', 'release', '2026-09-17T08:40:00+00:00'),
    v('24w40a', 'snapshot', '2026-10-01T12:00:00+00:00'),
    v('1.21.1', 'release', '2026-08-27T10:05:00+00:00'),
    v('1.21', 'release', '2026-08-15T09:00:00+00:00'),
    v('1.20.6', 'release', '2026-05-23T10:30:00+00:00'),
    v('1.20.4', 'release', '2026-02-07T10:00:00+00:00'),
    v('1.20.1', 'release', '2025-08-02T09:30:00+00:00'),
    v('1.19.4', 'release', '2025-03-14T10:00:00+00:00'),
    v('1.18.2', 'release', '2024-02-28T10:15:00+00:00'),
    v('1.17.1', 'release', '2023-07-06T10:00:00+00:00'),
    v('1.16.5', 'release', '2023-01-15T10:00:00+00:00'),
    v('1.12.2', 'release', '2022-09-18T10:00:00+00:00'),
    v('1.8.9', 'release', '2021-12-09T10:00:00+00:00'),
    v('1.7.10', 'release', '2021-05-12T10:00:00+00:00'),
    v('1.6.4', 'release', '2020-09-19T10:00:00+00:00'),
    v('1.5.2', 'release', '2020-05-02T10:00:00+00:00'),
  ],
};

/** 远古版本（QCL 的看家本领：考古社区归档） */
export const SAMPLE_ANCIENT = [
  v('rd-132211', 'ancient', '2009-05-13T00:00:00+00:00'),
  v('rd-132328', 'ancient', '2009-05-13T00:00:00+00:00'),
  v('c0.0.13a', 'ancient', '2009-05-21T00:00:00+00:00'),
  v('c0.0.13a_03', 'ancient', '2009-05-21T00:00:00+00:00'),
  v('c0.30_01c', 'ancient', '2009-06-11T00:00:00+00:00'),
  v('in-20100125', 'ancient', '2010-01-25T00:00:00+00:00'),
  v('inf-20100618', 'ancient', '2010-06-18T00:00:00+00:00'),
  v('a1.0.4', 'ancient', '2010-07-08T00:00:00+00:00'),
  v('a1.1.2_01', 'ancient', '2010-09-23T00:00:00+00:00'),
  v('a1.2.6', 'ancient', '2010-12-02T00:00:00+00:00'),
  v('b1.0', 'ancient', '2010-12-20T00:00:00+00:00'),
  v('b1.4_01', 'ancient', '2011-04-05T00:00:00+00:00'),
  v('b1.7.3', 'ancient', '2011-07-08T00:00:00+00:00'),
  v('1.0.0-rc1', 'ancient', '2011-11-13T00:00:00+00:00'),
  v('1.0.0-rc2', 'ancient', '2011-11-14T00:00:00+00:00'),
];

/* ------------------------------ 示例本地版本 ------------------------------ */

export const SAMPLE_LOCAL = [
  { id: '1.21.4', jarExists: true, jsonExists: true, loader: null, installedAt: Date.now() - 42 * HOUR, sizeBytes: 742 * 1024 * 1024 },
  { id: '1.20.6', jarExists: true, jsonExists: true, loader: { type: 'fabric', version: '0.16.9' }, installedAt: Date.now() - 9 * 24 * HOUR, sizeBytes: 604 * 1024 * 1024 },
  { id: '1.7.10', jarExists: true, jsonExists: true, loader: { type: 'forge', version: '10.13.4.1614' }, installedAt: Date.now() - 30 * 24 * HOUR, sizeBytes: 322 * 1024 * 1024 },
  { id: 'c0.30_01c', jarExists: true, jsonExists: false, loader: null, installedAt: Date.now() - 6 * 24 * HOUR, sizeBytes: 3 * 1024 * 1024 },
];

/* ------------------------------ 示例日志 ------------------------------ */

export const SAMPLE_LOG = [
  '[21:04:11] [QCL] 启动器版本 1.0.0（电脑版）',
  '[21:04:11] [QCL] 实例：苍白花园 · 1.21.4（pale-garden-1214）',
  '[21:04:11] [QCL] 游戏目录：C:\\Users\\123\\Documents\\QCL\\instances\\pale-garden-1214\\.minecraft',
  '[21:04:11] [QCL] 已选 Java：C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\javaw.exe（21.0.5 x64）',
  '[21:04:11] [QCL] 分配内存：4096 MB',
  '[21:04:11] [QCL] 版本 JSON 已合并继承链：1.21.4 → 1.21.3 → …',
  '[21:04:12] [QCL] 资源索引：1.21.4（objects 4821 个，已就绪 4821 个）',
  '[21:04:12] [QCL] 类路径条目：61 个',
  '[21:04:12] [QCL] 启动命令已构造完成，正在拉起 Java 进程…',
  '[21:04:12] [游戏输出] Java 版本检查通过',
  '[21:04:13] [游戏输出] [main/INFO]: Loading Minecraft 1.21.4 with Fabric Loader 0.16.9',
  '[21:04:13] [游戏输出] [main/INFO]: Loading 12 mods: fabric-api, sodium, lithium, …',
  '[21:04:14] [游戏输出] [Render thread/INFO]: Backend library: LWJGL version 3.3.3+5',
  '[21:04:14] [游戏输出] [Render thread/INFO]: OpenGL 4.6.0 NVIDIA 566.36',
  '[21:04:15] [游戏输出] [Render thread/INFO]: Narrator library for x64 successfully loaded',
  '[21:04:16] [游戏输出] [Worker-Main-1/INFO]: Preparing spawn area: 34%',
  '[21:04:18] [游戏输出] [Render thread/INFO]: Sound engine started',
  '[21:04:18] [游戏输出] [Render thread/INFO]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas',
  '[21:04:19] [游戏输出] [Render thread/INFO]: Time elapsed: 4821 ms',
  '[21:04:19] [QCL] 游戏已进入主界面（窗口 1280×720，未全屏）',
  '[21:09:52] [QCL] 收到退出信号，正在等待 Java 进程结束…',
  '[21:09:53] [游戏输出] [Render thread/INFO]: Stopping!',
  '[21:09:53] [QCL] Java 进程已退出，退出码 0',
  '[21:09:53] [QCL] 本次游戏时长：5 分 41 秒',
];

/* ------------------------------ mock 派发 ------------------------------ */

let taskSeq = 0;
const mockTasks = new Map();

function startMockTask(kind, label) {
  taskSeq += 1;
  const taskId = `示例任务-${taskSeq}`;
  const total = kind === 'install' ? 812 : 120;
  let current = 0;
  const phases = [
    '正在获取版本信息',
    '正在下载客户端 jar',
    '正在下载依赖库',
    '正在解压 natives',
    '正在下载资源文件',
    '正在写入实例配置',
  ];
  const timer = setInterval(() => {
    const step = kind === 'install' ? 9 + Math.random() * 26 : 14 + Math.random() * 30;
    current = Math.min(total, current + step);
    const ratio = current / total;
    const idx = Math.min(phases.length - 1, Math.floor(ratio * phases.length));
    emit('task:progress', {
      taskId,
      phase: kind,
      stage: phases[idx],
      current: Math.floor(current),
      total,
      file: kind === 'install' ? 'assets/objects/' + Math.random().toString(16).slice(2, 6) + '/示例文件' : '示例任务',
      speed: 2.4 * 1024 * 1024 + Math.random() * 3 * 1024 * 1024,
      done: current >= total,
    });
    if (current >= total) {
      clearInterval(timer);
      mockTasks.delete(taskId);
    }
  }, 420);
  mockTasks.set(taskId, timer);
  return { taskId, label };
}

function stopMockTask(taskId) {
  const timer = mockTasks.get(taskId);
  if (timer) {
    clearInterval(timer);
    mockTasks.delete(taskId);
  }
}

let mockInstanceSeq = SAMPLE_INSTANCES.length;
let mockAccountSeq = SAMPLE_ACCOUNTS.length;

/**
 * 同步的 mock 派发：主进程不可用时用它顶上。
 * 注意返回值必须与契约里对应通道的返回类型一致。
 */
export function mockInvoke(channel, payload = {}) {
  switch (channel) {
    case 'app:info':
      return {
        name: 'QCL',
        version: '1.0.0',
        platform: 'win32',
        home: DEFAULT_SETTINGS.home,
        arch: 'x64',
      };
    case 'win:minimize':
    case 'win:toggleMaximize':
    case 'win:close':
    case 'instances:select':
    case 'install:cancel':
    case 'launch:kill':
    case 'accounts:remove':
      return { ok: true };
    case 'win:state':
      return { maximized: false, fullscreen: false, inset: 18 };
    case 'settings:get':
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    case 'settings:set':
      return Object.assign({}, DEFAULT_SETTINGS, payload, {
        theme: Object.assign({}, DEFAULT_SETTINGS.theme, payload.theme),
        memory: Object.assign({}, DEFAULT_SETTINGS.memory, payload.memory),
        launch: Object.assign({}, DEFAULT_SETTINGS.launch, payload.launch),
        downloader: Object.assign({}, DEFAULT_SETTINGS.downloader, payload.downloader),
      });
    case 'instances:list':
      return SAMPLE_INSTANCES.slice();
    case 'instances:create': {
      mockInstanceSeq += 1;
      const name = payload.name || `新实例 ${mockInstanceSeq}`;
      return {
        id: `sample-${mockInstanceSeq}`,
        name,
        icon: 'grass',
        mcVersion: payload.mcVersion || '1.21.4',
        loader: payload.loader ? { type: payload.loader, version: '示例版本' } : null,
        java: { path: null, memoryMb: null },
        created: Date.now(),
        lastPlayed: null,
        playTime: 0,
        dir: `${DEFAULT_SETTINGS.home}\\instances\\sample-${mockInstanceSeq}`,
      };
    }
    case 'instances:delete':
    case 'instances:rename':
    case 'instances:update': {
      const found = SAMPLE_INSTANCES.find((x) => x.id === payload.id) || SAMPLE_INSTANCES[0];
      if (channel === 'instances:update') return Object.assign({}, found, payload.patch);
      if (channel === 'instances:rename') return Object.assign({}, found, { name: payload.name });
      return { ok: true };
    }
    case 'versions:manifest':
      return JSON.parse(JSON.stringify(SAMPLE_MANIFEST));
    case 'versions:ancient':
      return JSON.parse(JSON.stringify(SAMPLE_ANCIENT));
    case 'versions:local':
      return SAMPLE_LOCAL.slice();
    case 'install:start': {
      const t = startMockTask('install', payload.mcVersion || payload.id || '示例版本');
      return { taskId: t.taskId };
    }
    case 'launch:start':
      return { pid: 12345 };
    case 'accounts:list':
      return SAMPLE_ACCOUNTS.slice();
    case 'accounts:addOffline': {
      mockAccountSeq += 1;
      return {
        uuid: `sample-offline-${mockAccountSeq}`,
        name: payload.name || `玩家${mockAccountSeq}`,
        type: 'offline',
        avatar: '',
      };
    }
    case 'accounts:addMicrosoft':
      return {
        flowId: 'sample-flow',
        userCode: 'K7QP2-WD4NT',
        verificationUri: 'https://www.microsoft.com/link',
        expiresIn: 900,
      };
    case 'accounts:microsoftPoll':
      return { status: 'pending', message: '示例模式：等待你在浏览器里完成登录…' };
    case 'java:list':
      return SAMPLE_JAVA.slice();
    case 'java:add':
      return {
        path: payload.path || 'C:\\示例\\Java\\bin\\javaw.exe',
        version: '示例',
        arch: 'x64',
        vendor: '示例',
        major: 21,
        isJre: false,
        source: 'manual',
      };
    case 'java:detect':
      return SAMPLE_JAVA.slice();
    case 'log:recent':
      return SAMPLE_LOG.slice(-(payload.limit || 300));
    case 'shell:openPath':
      return { ok: false, error: '未连接到主进程，无法打开文件夹（示例数据）' };
    case 'shell:openExternal':
      return { ok: true };
    default:
      return null;
  }
}

/** 供页面在降级模式下主动结束示例任务 */
export function cancelMockTask(taskId) {
  stopMockTask(taskId);
}
