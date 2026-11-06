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
