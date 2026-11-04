'use strict';
/**
 * QCL 电脑版 · 全局设置持久化
 * 存 <QCL_HOME>/settings.json；写入用「临时文件 + rename」保证不会写坏。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function defaultHome(documentsDir) {
  const base = documentsDir || path.join(os.homedir(), 'Documents');
  return path.join(base, 'QCL');
}

const DEFAULTS = () => ({
  home: '', // 空 = 用 defaultHome（首次启动时填上）
  javaPath: null,
  theme: {
    accent: '#865D58',
    mode: 'auto',
    wallpaperId: 'builtin:day',
    panelAlpha: 0.7,
    /** 面板底色（空 = 跟随昼夜；照安卓版 1.5.2「重置面板色」的默认行为） */
    panelColor: '',
    /** 壁纸自动轮换（安卓版 1.3.4 的「动态背景/自动切换」） */
    wallpaperRotate: false
  },
  memory: { mode: 'auto', mb: 4096 },
  launch: {
    width: 854,
    height: 480,
    fullscreen: false,
    extraJvmArgs: '',
    extraGameArgs: ''
  },
  downloader: { threads: 16, source: 'official' },
  /**
   * ★ 全局「关闭文件校验」（照 HMCL `settings.advanced.dont_check_game_completeness`）。
   *
   *   true（默认）  启动前校验 libraries / assets / 客户端 jar 的完整性，坏了自动修
   *   false        不校验内容，只查关键文件在不在
   *
   * ★ 与实例级 `instance.notCheckGameFiles` 的关系（照安卓版 QclVersionConfig）：
   *   **实例级优先** —— 任一为「关闭」就跳过内容校验。
   *   因为注入了中文补丁 / 装了 ModLoader 的版本必须跳过，否则补丁会被「修复」冲掉。
   *   另外：从**文件系统**检出已打中文补丁时，无论这两个开关怎么设都会跳过（见 gamecheck）。
   */
  checkGameFiles: true,
  /**
   * 全局游戏设置（照安卓版「全局游戏设置」里 PC 适用的部分移植，2026-11-05 加）。
   *
   * ★ 只保留 PC 有意义的项；手机专属的（渲染器 / 触屏布局 / 触摸注入 /
   *   运行时位数 / Pojav 启动器选择）**故意不做**。
   */
  game: {
    /** 游戏窗口分辨率 */
    resolution: { width: 854, height: 480 },
    /** 启动后自动进入的服务器（空 = 正常进主菜单） */
    serverAddress: '',
    /** 启动时先分配的堆（-Xms） */
    minMemoryMb: 512,
    /** 是否写完整游戏日志 */
    debugLog: true,
    /** 游戏启动后是否保持启动器在前台（默认 false = 启动后把启动器收起来，不占游戏资源） */
    keepLauncherOpen: false,

    /**
     * ★ 默认版本隔离策略（照 HMCL `settings.game.default_isolation`）。
     *
     *   'always'  隔离所有实例（默认）
     *   'modded'  只隔离可装模组的实例
     *   'never'   不隔离
     *
     * ★ PC 版的实情：实例目录天生就是
     *   `<QCL_HOME>/instances/<id>/.minecraft/{versions,libraries,assets,natives}`
     *   —— 比 HMCL 的「各版本独立」还彻底（HMCL 会共享 assets/libraries）。
     *   这个设置用于**新装实例**时决定默认值，以及将来支持共享目录时的行为。
     */
    defaultIsolation: 'always',

    /** 游戏窗口类型：'windowed' | 'maximized' | 'fullscreen'（照 HMCL settings.game.window_type） */
    windowType: 'windowed',

    /** 默认图形 API：'default' | 'opengl' | 'vulkan'（仅 Minecraft 26.2+ 生效） */
    graphicsBackend: 'default',

    /** 自动补齐缺失依赖（libraries / assets） */
    autoInstallDependencies: true,

    /** 找不到匹配 Java 时自动下载 */
    autoInstallJava: true,

    /**
     * ★ 预设游戏语言为中文（2026-11-05，用户要求「给游戏预设中文」）。
     *
     * true（默认）= 启动前把 options.txt 的 lang 设成中文，第一次进游戏就是中文界面。
     * false       = 不碰玩家的语言设置。
     *
     * ★★ 大小写按版本自动决定（这是 1.1 崩溃 BUG 的关键）：
     *   1.1~1.10 → `zh_CN`（地区大写） | 1.11+ / 26.x → `zh_cn`（地区小写）
     *   1.0 及更早 → 完全不写（写了会崩） | 远古版本 → 跳过（靠中文补丁）
     */
    forceChinese: true,
    /** 目标语言代码（内部会按版本修正大小写） */
    forceChineseLang: 'zh_CN',

    /**
     * ★ 重复下载内容（模组/资源包/光影）时的处理策略（2026-11-05，用户要求）。
     *
     *   'replace'（默认）  同一个模组换版本时，**自动删掉旧 jar** 只留新的
     *                      —— 否则 mods/ 里会堆两份，游戏同时加载导致冲突/崩溃
     *   'skip'            目标文件已存在就跳过，不覆盖也不删
     *   'keep'            新旧都留着（高级用户才用）
     *
     * ★ 另外：只要 sha1 完全相同（重复下同一个版本），一律**跳过不重下**，省流量。
     */
    contentOverwrite: 'replace',
  },
  closeToTray: false,
  layout: 'new',
  selectedInstance: null,
  windowBounds: null,
  tutorialDone: false
});

/** 深合并：只覆盖对象里的值，数组整体替换 */
function merge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = key in base ? merge(base[key], patch[key]) : patch[key];
  }
  return out;
}

function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

class Settings {
  /**
   * @param {object} opts
   * @param {string} opts.documentsDir Documents 目录（主进程传 app.getPath('documents')）
   * @param {string} [opts.homeOverride] 强制指定 QCL 主目录（测试用）
   */
  constructor(opts = {}) {
    this.documentsDir = opts.documentsDir || null;
    this.homeOverride = opts.homeOverride || null;
    this.file = null;
    this.data = DEFAULTS();
    this.listeners = new Set();
  }

  load() {
    const fallbackHome = this.homeOverride || defaultHome(this.documentsDir);
    // 先探一次 home（settings.json 自己就住在 home 里，所以先用默认 home 找）
    const bootstrapFile = path.join(fallbackHome, 'settings.json');
    const raw = readJsonSafe(bootstrapFile, null);
    this.data = merge(DEFAULTS(), raw || {});
    if (!this.data.home) this.data.home = fallbackHome;
    // 如果设置里写了别的 home，真实文件在那边
    this.file = path.join(this.data.home, 'settings.json');
    if (this.file !== bootstrapFile) {
      const moved = readJsonSafe(this.file, null);
      if (moved) {
        this.data = merge(DEFAULTS(), moved);
        if (!this.data.home) this.data.home = fallbackHome;
        this.file = path.join(this.data.home, 'settings.json');
      }
    }
    return this.get();
  }

  save() {
    writeJsonAtomic(this.file, this.data);
    return this.data;
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /** 取某个路径键（渲染层常用） */
  value(key) {
    return this.data[key];
  }

  set(patch) {
    const before = this.data.home;
    this.data = merge(this.data, patch || {});
    if (!this.data.home) this.data.home = defaultHome(this.documentsDir);
    if (this.data.home !== before) {
      // 主目录变了：把设置写到新目录（旧目录保留，不删数据）
      this.file = path.join(this.data.home, 'settings.json');
    }
    this.save();
    const snapshot = this.get();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* 监听器异常不能影响设置写入 */
      }
    }
    return snapshot;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { Settings, DEFAULTS, writeJsonAtomic, readJsonSafe, merge, defaultHome };
