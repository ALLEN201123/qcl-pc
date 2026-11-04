'use strict';
/*
 * launch.js —— 拼装命令行并启动游戏。
 *
 * 参照：
 *   vendor/MultiMC/launcher/minecraft/MinecraftInstance.cpp
 *     · replaceTokensIn —— ${...} 占位符替换
 *     · processMinecraftArgs —— 老式 minecraftArguments 分词后逐个替换
 *     · javaArguments / getClassPath / getNativePath
 *   vendor/MultiMC/launcher/minecraft/launch/DirectJavaLaunch.cpp
 *     · args = javaArguments() + -Djava.library.path=<natives> + -cp <classpath> + mainClass + 游戏参数
 *     · spawn 时 cwd 用实例的游戏目录，退出码非 0 视为崩溃
 *
 * 新老两种参数格式都在这里统一：
 *   · 新式（1.13+）：版本 JSON 的 arguments.jvm / arguments.game 已经包含 -cp ${classpath} 等全部内容，
 *     所以**不再**自己补 -cp（否则 java 会因为重复 -cp 取错classpath）；
 *   · 老式（1.12-）：只有 minecraftArguments 字符串，由本文件补 -Djava.library.path 与 -cp。
 *   · Forge/NeoForge 这类继承版本：父的参数在前、子的参数在后（arguments 已在 version.js 里拼好）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const paths = require('./paths');
const jsonstore = require('./jsonstore');
const http = require('./http');
const mojang = require('./mojang');
const versionModule = require('./version');
const librariesModule = require('./libraries');
const assetsModule = require('./assets');
const javaModule = require('./java');
const rulesModule = require('./rules');
const accountsModule = require('./accounts');
const logger = require('./logger');

const LAUNCHER_NAME = 'QCL';
const CLASS_SUFFIX_WIN = ';';
const CLASS_SUFFIX_OTHER = ':';

/**
 * ★★★ 「游戏主循环真的起来了」的标志行（2026-11-05 修「游戏屁都没启动，窗口就消失了」）。
 *
 * 问题：以前 `stage('running')` 在 Java 进程 spawn 成功后**立刻**发出，
 * 界面收到就当成启动完成、把启动窗口关掉 —— 而此时游戏画面还没出来。
 *
 * ★★ 2026-11-05 二次修正（实测数据推翻了第一版判据）：
 *   第一版把 `Backend library` 和裸 `LWJGL` 也算作就绪，实测 26.3 的时序是：
 *       spawn            5.8s
 *       Backend library 30.2s   ← 第一版在这里就报"就绪"
 *       OpenAL/Sound    37.5s   ← 真正的窗口/声音在 **7 秒之后**才出现
 *   于是启动窗口在游戏画面出来前 7 秒就关了，用户原话「窗口连毛都没拉出来」。
 *   ⇒ 把标志拆成两档：
 *
 *   **强信号**（现代版本，出现时窗口一定已经建好、主循环在跑）：
 *     · `Sound engine started`                                  音频引擎起来
 *     · `Created: 1024x512x4 minecraft:textures/atlas/blocks.png` 图集上传完成
 *   这两个都在渲染线程完成窗口创建之后，是最可靠的"画面要出来了"。
 *
 *   **弱信号**（老版本 1.6~1.12 没有 Sound engine 那两行，只能用这些）：
 *     · `LWJGL Version: 2.9.4`      —— 注意是现代是 `Backend library: LWJGL version 3.x`，格式不同
 *     · `Setting user: <name>`
 *     · `Starting Minecraft: <version>`
 *   老版本这些行出现得早（窗口可能还没好），所以要求 **spawn 后至少 8 秒**才认。
 */
const GAME_READY_STRONG_RE = /Sound engine started|Created:\s+\d+x\d+(?:x\d+)?\s+.*blocks\.png/i;
/**
 * ★ 弱信号（只给 1.6~1.12 这些没有 Sound engine 的老版本用，且必须等 spawn 满 8 秒）。
 *   **故意不含 `Setting user`** —— 实测 26.3 在 28 秒时就打了 `Setting user`，
 *   但那时窗口还没显示，是最坑的误报源（比 Backend library 更早、更隐蔽）。
 */
const GAME_READY_WEAK_RE = /LWJGL Version:|Starting Minecraft:/i;

/** 弱信号生效前的最短等待（毫秒）：给老版本窗口创建留时间 */
const GAME_READY_WEAK_MIN_DELAY_MS = 8000;

/** 兼容旧名字（测试脚本/外部引用还在用） */
const GAME_READY_RE = GAME_READY_STRONG_RE;

/** 兜底计时：这么久还没命中就只写一条日志，不报错（界面自己按超时收尾）。 */
const GAME_READY_TIMEOUT_MS = 90000;

/**
 * 这一行是不是「游戏已就绪」标志（强信号）。
 * 单独抽出来是为了能直接写测试脚本喂真实日志行（build/verify-game-ready.js）。
 */
function isGameReadyLine(line) {
  return typeof line === 'string' && GAME_READY_STRONG_RE.test(line);
}

/** 是不是「可能是就绪」的弱信号（老版本） */
function isWeakGameReadyLine(line) {
  return typeof line === 'string' && GAME_READY_WEAK_RE.test(line);
}

/**
 * 创建一次性「游戏就绪」检测器：命中标志时**只**回调一次。
 *
 * 为什么要防重复：这些标志在游戏运行期间可能重复打印
 * （切资源包/重载声音会再打 `Sound engine started`），
 * 不拦的话界面会被反复通知、甚至反复关窗。
 *
 * ★ 2026-11-05：支持弱信号 + 延迟门槛（老版本的 LWJGL/Setting user 出现太早，
 *   窗口还没建好就报就绪，必须等 spawn 满 8 秒才认）。
 *
 * @param {(line:string)=>{}} [onReady] 首次命中时回调（异常会被吞掉，不影响游戏）
 * @param {{startedAt?:number, weakMinDelayMs?:number}} [opts]
 */
function createGameReadyDetector(onReady, opts = {}) {
  let fired = false;
  let matchedLine = '';
  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  const weakMinDelayMs = Number.isFinite(opts.weakMinDelayMs)
    ? opts.weakMinDelayMs
    : GAME_READY_WEAK_MIN_DELAY_MS;

  const fire = (line) => {
    fired = true;
    matchedLine = line;
    try {
      if (typeof onReady === 'function') onReady(line);
    } catch (_) {
      /* 界面回调异常绝不能影响游戏进程 */
    }
    return true;
  };

  return {
    /** 喂一行游戏日志；命中且是第一次返回 true。 */
    feed(line) {
      if (fired || typeof line !== 'string') return false;

      // 强信号：现代版本，窗口已建好，直接认
      if (GAME_READY_STRONG_RE.test(line)) return fire(line);

      // 弱信号：老版本，必须等够时间（否则窗口还没出来就误报）
      if (GAME_READY_WEAK_RE.test(line) && Date.now() - startedAt >= weakMinDelayMs) {
        return fire(line);
      }

      return false;
    },
    /** 已经触发过没有。 */
    get fired() {
      return fired;
    },
    /** 命中的那一行原文（写日志 / 排查用）。 */
    get matchedLine() {
      return matchedLine;
    },
  };
}

/** 读 package.json 里的版本号（拿不到就退回 1.0.0）。 */
function launcherVersion() {
  try {
    const pkg = jsonstore.readJson(path.join(__dirname, '..', '..', '..', 'package.json'), null);
    if (pkg && pkg.version) return String(pkg.version);
  } catch (_) {
    /* ignore */
  }
  return '1.0.0';
}

/**
 * MultiMC replaceTokensIn 的等价实现：只替换认识的 ${key}，不认识的保留原样。
 */
function replaceTokensIn(text, mapping) {
  if (typeof text !== 'string' || !text.includes('${')) return text;
  return text.replace(/\$\{([^}]+)\}/g, (whole, key) => {
    const value = mapping[key];
    return value === undefined || value === null ? whole : String(value);
  });
}

/** 自动内存：按物理内存的 1/4 取，夹在 1G~4G（32 位 Java 上限 1G）。 */
function autoMemoryMb(javaArch) {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const quarter = Math.floor(totalMb / 4);
  const cap = javaArch === 'x86' || javaArch === 'arm32' ? 1024 : 4096;
  const floor = 1024;
  const value = Math.max(floor, Math.min(cap, quarter));
  return Math.round(value / 512) * 512;
}

/**
 * 账号 → 启动参数里的凭据字段。
 *
 * ★ 2026-11-05：新增 `authlib`（第三方 Yggdrasil）账号类型。
 *   它和微软账号在参数上完全一样（用 accessToken 当令牌、user_type=msa），
 *   区别只在「谁来验证这个令牌」—— 由 -javaagent:authlib-injector.jar=<apiRoot> 指定。
 */
function authTokens(account, versionType, versionId) {
  const acc = account || {};
  const isAuthlib = acc.type === 'authlib';
  const type = acc.type === 'microsoft' || isAuthlib ? 'microsoft' : 'offline';
  const name = acc.name || 'Player';
  const uuid = acc.uuid || accountsModule.offlineUuid(name);
  const token = acc.accessToken || '0';
  const uuidBare = String(uuid).replace(/-/g, '');

  // 老版本（pre-1.7 / alpha / beta）走 session 格式：token:<accessToken>:<uuid>
  const isLegacy = versionType === 'old_alpha' || versionType === 'old_beta'
    || !/^1\.(?:[7-9]|[1-9]\d)/.test(String(versionId || ''));

  return {
    auth_player_name: name,
    auth_uuid: isLegacy ? uuidBare : uuid,
    auth_access_token: token,
    auth_session: `token:${token}:${uuidBare}`,
    user_type: type === 'microsoft' ? 'msa' : (isLegacy ? 'legacy' : 'msa'),
    user_properties: '{}',
    profile_name: name,
  };
}

/** 从实例目录读版本 JSON（含继承链解析）。 */
async function loadResolvedVersion(ctx) {
  const { home, instance, source, timeoutMs, signal } = ctx;
  const id = instance.installedVersion || instance.mcVersion;
  if (!id) throw new http.LauncherError('该实例还没有安装任何版本，请先到「下载」里安装游戏');
  const versionsDir = paths.versionsDir(home, instance.id);
  const ownJson = path.join(versionsDir, id, `${id}.json`);
  let raw = jsonstore.readJson(ownJson, null);
  if (!raw) {
    // 退回版本目录（手工放置的情况）
    const alt = path.join(versionsDir, instance.mcVersion, `${instance.mcVersion}.json`);
    raw = jsonstore.readJson(alt, null);
    if (!raw) {
      throw new http.LauncherError(`找不到版本文件：${ownJson}。请先在「下载」里重新安装该版本`, { code: 'E_NO_VERSION_JSON' });
    }
  }

  const manifestResult = await mojang
    .manifest({ cacheDir: paths.metaDir(home), source, timeoutMs, signal })
    .catch(() => ({ versions: [] }));
  const manifestIndex = new Map(manifestResult.versions.map((v) => [v.id, v]));

  const fetchParentJson = async (parentId) => {
    const local = path.join(versionsDir, parentId, `${parentId}.json`);
    if (fs.existsSync(local)) {
      const data = jsonstore.readJson(local, null);
      if (data) return data;
    }
    const hit = manifestIndex.get(parentId);
    return mojang.versionJson({
      id: parentId,
      url: hit && hit.url,
      sha1: hit && hit.sha1,
      cacheDir: paths.metaDir(home),
      source,
      timeoutMs,
      signal,
    });
  };

  return versionModule.resolve(raw, { fetchJson: fetchParentJson, features: ctx.features });
}

/**
 * 启动游戏。
 * @param {{home:string, instance:object, account:object, settings:object,
 *          onLog?:Function, onExit?:Function, onStage?:Function,
 *          onGameReady?:(info:{elapsedMs:number})=>void,
 *          signal?:AbortSignal, source?:string, timeoutMs?:number}} params
 *   onStage   —— 每个启动阶段开始（resolve/check/spawn/running …）
 *   onGameReady —— **游戏真的就绪**（日志命中主循环标志）时回调，只回调一次；
 *                  在这之前 stage('running') 只代表「进程已启动，正在加载」。
 * @returns {Promise<{pid:number, kill:Function, child:object, java:string, args:string[]}>}
 */
async function launch(params) {
  const opts = params || {};
  const home = paths.homeOf(opts.home);
  const instance = opts.instance;
  if (!instance || !instance.id) throw new Error('启动失败：没有指定实例');
  const settings = opts.settings || {};
  const source = opts.source === 'bmclapi' ? 'bmclapi' : (settings.downloader && settings.downloader.source) || 'official';
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : http.DEFAULT_TIMEOUT_MS;

  const gameDir = paths.gameDir(home, instance.id);
  const versionsDir = paths.versionsDir(home, instance.id);
  const librariesDir = paths.librariesDir(home, instance.id);
  const assetsDir = paths.assetsDir(home, instance.id);
  const nativesDir = paths.nativesDir(home, instance.id);
  if (!fs.existsSync(gameDir)) {
    throw new http.LauncherError(`实例目录不存在：${gameDir}`);
  }
  paths.ensureDir(nativesDir);

  const log = logger.createLogger(home, { reset: true, echo: opts.onLog });
  const emit = (line) => log.raw(`[游戏] ${line}`);

  const launchCfg = settings.launch || {};

  /**
   * ★ 分辨率的取值顺序（2026-11-05）：
   *   ① settings.launch.width/height（右栏「启动设置」弹窗写入的，最具体）
   *   ② instance.resolution（「版本设置 → 游戏」逐实例覆盖）
   *   ③ settings.game.resolution（「设置 → 游戏」里的全局默认）
   *   ④ 兜底 854×480（Minecraft 默认窗口）
   */
  const gameCfg = settings.game || {};
  const gameRes = gameCfg.resolution || {};
  const instRes = instance.resolution || null;
  const width =
    Number.isFinite(launchCfg.width) && launchCfg.width > 0
      ? launchCfg.width
      : instRes && Number.isFinite(instRes.width)
        ? instRes.width
        : Number.isFinite(gameRes.width) && gameRes.width > 0
          ? gameRes.width
          : 854;
  const height =
    Number.isFinite(launchCfg.height) && launchCfg.height > 0
      ? launchCfg.height
      : instRes && Number.isFinite(instRes.height)
        ? instRes.height
        : Number.isFinite(gameRes.height) && gameRes.height > 0
          ? gameRes.height
          : 480;

  /**
   * ★ 游戏窗口类型（照 HMCL `settings.game.window_type`，2026-11-05 加）。
   *   实例级优先于全局。'fullscreen' → 加 --fullscreen；分辨率仍传（游戏退出全屏后用它）。
   */
  const windowType = instance.windowType || gameCfg.windowType || 'windowed';

  /**
   * ★ 快速游玩（照 HMCL `settings.game.quick_play`，2026-11-05 加）。
   *   Minecraft 1.20+ 支持 --quickPlaySingleplayer / --quickPlayMultiplayer，
   *   启动后直接进指定存档或服务器，跳过主菜单。
   */
  const quickPlay = instance.quickPlay && instance.quickPlay.type !== 'none' ? instance.quickPlay : null;

  const features = {
    is_demo_user: false,
    has_custom_resolution: true,
    // ★ 快速游玩：version JSON 里带 --quickPlaySingleplayer 等条件参数时要靠这些开关放行
    has_quick_plays_support: !!quickPlay,
    is_quick_play_singleplayer: !!(quickPlay && quickPlay.type === 'singleplayer'),
    is_quick_play_multiplayer: !!(quickPlay && quickPlay.type === 'multiplayer'),
    is_quick_play_realms: false,
  };

  log.log(`准备启动：${instance.name}（版本 ${instance.installedVersion || instance.mcVersion}）`);

  /**
   * ★★★ 启动阶段回调（2026-11-05 加）。
   *
   * 为什么：用户点「启动游戏」后界面要**立刻**显示「正在启动」并逐步打勾，
   * 现在只有一堆日志，界面上什么都看不到（用户反馈「启动窗口半天才响应、步骤还很少」）。
   * ⇒ 每个阶段开始时调一次 onStage({key,label,detail})，界面据此画步骤列表。
   *   阶段划分对齐 HMCL 的启动流程（检查 Java → 解析版本 → 校验文件 → 组装参数 → 起进程 → 等窗口）。
   */
  const stage = (key, label, detail) => {
    try {
      if (typeof opts.onStage === 'function') opts.onStage({ key, label, detail: detail || '' });
    } catch {
      /* 界面回调异常不能影响启动 */
    }
  };

  stage('resolve', '解析版本信息', `版本 ${instance.installedVersion || instance.mcVersion}`);
  const resolved = await loadResolvedVersion({ home, instance, source, timeoutMs, signal: opts.signal, features });
  const osInfo = rulesModule.currentOs();

  // ── 游戏文件完整性检查 ─────────────────────────────────────────
  //
  // ★ 默认做检查（缺文件就补），但**远古版本 / 注入了中文补丁的版本会自动跳过内容校验**：
  //   中文补丁改写了游戏 jar（字体类 / font.txt / lang / 界面翻译），
  //   全量 SHA1 校验必然判「损坏」→ 会把补丁还原成原版、甚至把 Mojang 签名补回来。
  //   照安卓版语义（CheckLibTask 1.2.5）：开了「不检查游戏文件」时，
  //   只查「关键文件是否存在」，缺失也**不拦启动**（离线也能进）。
  try {
    const gamecheck = require('./gamecheck');
    stage('check', '检查游戏文件', '客户端 jar、依赖库、资源索引');
    const mcDir = path.join(instance.dir, '.minecraft');
    const versionId = resolved.id || instance.installedVersion || instance.mcVersion;
    const versionDir = path.join(mcDir, 'versions', versionId);
    const check = await gamecheck.checkGameFiles({
      versionDir,
      versionId,
      minecraftDir: mcDir,
      // ★ 传 home 让 gamecheck 用共享的 libraries / assets 目录（布局迁移后必须）
      home,
      resolved,
      instance,
      settings
    });
    if (check.skipContentCheck) {
      log.log(`跳过游戏文件内容校验：${check.reason}`);
    }
    if (check.missing.length) {
      const critical = check.missing.filter((m) => m.critical);
      const others = check.missing.filter((m) => !m.critical);
      if (others.length) {
        log.log(`提示：有 ${others.length} 个非关键文件缺失（${others.slice(0, 3).map((m) => m.name).join(', ')}…），一般是资源/库不全，可重新安装补齐`);
      }
      if (critical.length) {
        // 关键文件缺失 = 游戏根本起不来，这个必须拦
        throw new http.LauncherError(
          `游戏文件缺失：${critical.map((m) => m.name).join('、')}。请到「版本列表 → 该版本 → 重新安装」补齐`,
          { code: 'E_GAME_FILES' }
        );
      }
    }
    if (check.corrupted.length) {
      /**
       * ★★★ 检测到损坏 → **真的修**（2026-11-05 改）。
       *
       * 以前这里只打一行提示「N 个文件内容与官方记录不一致…若启动异常可重新安装」，
       * 然后就继续启动 —— 用户看到游戏崩了却不知道怎么修。
       * 实测踩到的：26.3.jar 与 fastutil/icu4j 内容损坏，
       * 报错是 `NoClassDefFoundError` 和 `ZipFile invalid LOC header`，
       * 从错误信息根本看不出「文件坏了、重下就好」。
       * ⇒ 现在直接按 sha1 重新下载，下完再校验，失败才报错。
       */
      const criticalCorrupted = check.corrupted.filter((c) => c.critical || c.kind === 'client-jar');
      log.log(
        `检测到 ${check.corrupted.length} 个文件损坏（${check.corrupted
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')}${check.corrupted.length > 3 ? '…' : ''}），正在自动修复…`
      );

      try {
        const downloader = require('./downloader');
        const repair = await gamecheck.repairFiles({
          corrupted: check.corrupted,
          missing: check.missing.filter((m) => !!m.url),
          downloader,
          source,
          onProgress: (done, total, name) => {
            if (name) stage('repair', `修复文件 ${done + 1}/${total}`, name);
          }
        });

        if (repair.repaired.length) {
          log.log(`已修复 ${repair.repaired.length} 个文件：${repair.repaired.map((r) => r.name).join(', ')}`);
        }
        if (repair.failed.length) {
          log.log(`修复失败 ${repair.failed.length} 个：${repair.failed.map((f) => `${f.name}（${f.error}）`).join('；')}`);
          // 关键文件（客户端 jar）修不好就没必要硬启了，给明确指引
          const criticalFailed = repair.failed.some((f) =>
            criticalCorrupted.some((c) => c.name === f.name)
          );
          if (criticalFailed) {
            throw new http.LauncherError(
              `客户端 jar 损坏且自动修复失败：${repair.failed.map((f) => f.name).join('、')}。` +
                `请检查网络后到「版本列表 → 该版本 → 重新安装」。`,
              { code: 'E_CORRUPTED_FIX_FAILED' }
            );
          }
        }
      } catch (err) {
        if (err && err.code === 'E_CORRUPTED_FIX_FAILED') throw err;
        log.log(`警告：自动修复失败（${err?.message || err}），按原样继续启动`);
      }
    }
  } catch (err) {
    // ★ 检查本身出错绝不能拦住启动（宁可让游戏试着跑，也不要因为检查器 bug 打不开）
    if (err && err.code === 'E_GAME_FILES') throw err;
    log.log(`警告：游戏文件检查失败（${err && err.message ? err.message : err}），跳过检查继续启动`);
  }

  // ── Java ─────────────────────────────────────────────────────
  stage('java', '检测 Java 运行时', '匹配游戏所需版本');
  const wantMajor = javaModule.recommendForResolved(resolved, instance.mcVersion);
  let javaPath = (instance.java && instance.java.path) || settings.javaPath || null;
  let javaInfo = null;
  if (javaPath) {
    javaInfo = await javaModule.probe(javaPath).catch(() => null);
    if (!javaInfo) {
      throw new http.LauncherError(`指定的 Java 不可用：${javaPath}。请到「设置 → Java」里重新选择`, { code: 'E_JAVA' });
    }
  } else {
    // ★ 用带缓存的检测：首次约 5s，之后 0ms（预热后点启动几乎瞬时）
    const detected = await javaModule.detectCached({ home, extraDirs: settings.javaExtraDirs || [] });
    javaInfo = javaModule.pickBest(detected, instance.mcVersion);
    if (!javaInfo) {
      /**
       * ★ 新玩家最常见的第一道坎：机器上一个 Java 都没有。
       *
       * 以前这里只说「请到设置 → Java 里手动添加 java.exe」——
       * 但玩家根本**没有 java.exe 可添加**，等于把人卡死。
       * 而 Oracle 官网下载 JDK 又要登录注册，体验更差。
       *
       * ⇒ 现在报错里直接说清楚三件事：
       *     ① 这是「没装 Java」，不是游戏坏了；
       *     ② 启动器**可以一键帮你下**（无需登录）；
       *     ③ 想自己去下的话，列出去哪儿下（全部免登录）。
       */
      throw new http.LauncherError(
        `这台电脑上还没有安装 Java，所以没法启动游戏。\n\n` +
          `游戏 ${instance.mcVersion} 需要 Java ${wantMajor}。\n\n` +
          `怎么办（二选一）：\n` +
          `· 让启动器帮你下：打开「设置 → Java」，点「一键下载 Java ${wantMajor}」（不需要登录任何账号）\n` +
          `· 自己去下：Adoptium（https://adoptium.net/temurin/releases/），免登录，选 Java ${wantMajor} 解压后\n` +
          `  回到「设置 → Java」点「添加 Java」选到 bin\\java.exe\n\n` +
          `提示：不要去 Oracle 官网下，那里要注册登录账号，很麻烦。`,
        { code: 'E_NO_JAVA', needJavaMajor: wantMajor }
      );
    }
    javaPath = javaInfo.path;
  }
  /**
   * ★ JVM 兼容性检查（照 HMCL `settings.advanced.dont_check_jvm_validity`，2026-11-05 加）。
   *   玩家明确勾了「不检查 Java 虚拟机与游戏的兼容性」就不再提醒 ——
   *   有些玩家（或整合包）就是要在不匹配的 Java 上跑，不该反复念。
   */
  if (instance.dontCheckJvmValidity === true) {
    log.log(`Java：${javaInfo.version}（${javaInfo.arch}，${javaInfo.vendor}）→ ${javaPath}（已跳过兼容性检查）`);
  } else {
    if (!javaModule.satisfies(javaInfo, wantMajor)) {
      log.log(`警告：本版本推荐 Java ${wantMajor}，当前使用 ${javaInfo.version}（主版本 ${javaInfo.major}），可能无法启动`);
      log.log('提示：如果确定要用这个 Java，可以在「版本设置 → 高级」里勾选「不检查 Java 虚拟机与游戏的兼容性」。');
    }
    log.log(`Java：${javaInfo.version}（${javaInfo.arch}，${javaInfo.vendor}）→ ${javaPath}`);
  }

  // ── 内存 ────────────────────────────────────────────────────
  const memCfg = settings.memory || { mode: 'auto', mb: 2048 };
  let memoryMb = (instance.java && instance.java.memoryMb) || null;
  if (!memoryMb) {
    memoryMb = memCfg.mode === 'manual' && Number.isFinite(memCfg.mb) && memCfg.mb > 0
      ? Number(memCfg.mb)
      : autoMemoryMb(javaInfo.arch);
  }
  if ((javaInfo.arch === 'x86' || javaInfo.arch === 'arm32') && memoryMb > 1024) {
    log.log(`提示：32 位 Java 最多只能用约 1GB 内存，已把 ${memoryMb}MB 下调到 1024MB`);
    memoryMb = 1024;
  }

  // ── classpath / natives / 资源目录 ────────────────────────────
  stage('classpath', '组装 classpath', '依赖库与客户端 jar');
  const classpathEntries = librariesModule.classpathList(resolved, {
    librariesDir,
    gameDir,
    osInfo,
    source,
  });
  if (!classpathEntries.length) {
    throw new http.LauncherError('classpath 为空：版本文件或依赖库缺失，请重新安装该版本', { code: 'E_EMPTY_CLASSPATH' });
  }
  const classpath = classpathEntries.join(process.platform === 'win32' ? CLASS_SUFFIX_WIN : CLASS_SUFFIX_OTHER);

  const indexInfo = versionModule.assetIndex(resolved);
  const indexId = (indexInfo && indexInfo.id) || 'legacy';
  const assetsRoot = assetsDir;
  const gameAssets = assetsModule.getAssetsDir(assetsDir, indexId);

  /**
   * ★★★ legacy 资源铺开（2026-11-05 加，照安卓版 CheckLibTask 1.2.5 的 reconstructAssets）。
   *
   * 为什么必须在**每次启动**都做，而不是只在安装时做：
   *   远古版本（alpha/beta）的 MC 是从 `<gameDir>/resources/` 读音效和音乐的。
   *   资源索引里 `map_to_resources: true` 就是告诉启动器「把对象按原名铺到 resources/」。
   *
   *   只靠安装时铺的问题：
   *     · 用旧版启动器装的、或装完又删了 resources/ 的，进游戏**完全没声音**；
   *     · 玩家换过游戏目录、或从别处拷贝的版本，同样没声音。
   *   安卓版就是把这段放在启动校验任务里，每次启动幂等地补缺失文件。
   *
   * ★ reconstruct 内部已改成**逐文件检查**，只补真正缺的，不会重复复制、很快返回。
   */
  try {
    const idx = assetsModule.loadIndex(assetsDir, indexId);
    if (idx && (idx.virtual || idx.map_to_resources)) {
      stage('assets', '铺开 legacy 资源目录', idx.map_to_resources ? 'resources/（远古版本音效音乐）' : 'virtual/');
      const r = await assetsModule.reconstruct(assetsDir, indexId, idx, {
        onLog: (line) => log.log(line)
      });
      if (r.copied > 0) {
        log.log(`音效资源已补齐 ${r.copied} 个文件 → ${r.targets.join('、')}`);
      } else {
        log.log(`legacy 资源目录已就绪（无需补齐）：${r.targets.join('、')}`);
      }
      if (r.missing > 0) {
        log.log(
          `提示：有 ${r.missing} 个资源对象在本地找不到（assets/objects 不完整），` +
            `这部分音效/音乐可能缺失。可到「下载」页对该版本点「重新安装」补齐。`
        );
      }
    }
  } catch (err) {
    // 资源铺开失败不该拦住启动（没声音总比进不去好）
    log.log(`警告：legacy 资源铺开失败（${err?.message || err}），继续启动`);
  }

  // 日志配置路径（1.12+ 的 -Dlog4j.configurationFile=${path}）
  let logConfigPath = null;
  if (resolved.logging && resolved.logging.client && resolved.logging.client.file && resolved.logging.client.file.id) {
    const candidate = path.join(assetsDir, 'log_configs', resolved.logging.client.file.id);
    if (fs.existsSync(candidate)) logConfigPath = candidate;
  }

  const versionId = resolved.id || instance.installedVersion || instance.mcVersion;
  const versionType = resolved.type || 'release';

  /**
   * ★★★ 账号与 token 校验（2026-11-05 新增）。
   *
   * 用户反馈：「启动流程不可能这么快吧？微软账号的登录校验之类的都没有。」
   * 查证属实：以前这里直接 `const account = opts.account`，**从不校验 token**，
   * 于是：
   *   · token 过期了照样拿去拼参数 → 游戏里显示「登录已过期」或进不了正版服务器；
   *   · 用户看不到任何提示，以为是启动器坏了。
   * `accounts.refreshAccount()` 其实早就实现了（10 分钟内过期自动用 refreshToken 换新），
   * 只是**从来没被调用过**。现在启动前先过一遍。
   */
  stage('account', '校验账号', '检查登录状态与令牌');
  let account = opts.account && opts.account.uuid
    ? opts.account
    : (await accountsModule.list(home))[0] || { name: 'Player', type: 'offline' };

  if (account && account.type === 'microsoft') {
    try {
      const before = account.accessToken;
      account = await accountsModule.refreshAccount(account, home);
      if (account.accessToken && account.accessToken !== before) {
        log.log('微软账号令牌已自动刷新');
      }
      // 刷新后仍然过期 → 明确告诉用户，不假装能登正版
      if (account.expiresAt && account.expiresAt < Date.now()) {
        log.log('警告：微软账号令牌已过期且刷新失败，本次将以「未登录正版」状态启动（只能进离线服务器）');
      } else {
        log.log(`账号校验通过：${account.name}（微软正版）`);
      }
    } catch (err) {
      log.log(`警告：账号校验失败（${err?.message || err}），继续用现有令牌启动`);
    }
  } else if (account) {
    log.log(`账号：${account.name}（离线）`);
  }

  const tokenMap = Object.assign(
    {
      version_name: versionId,
      version_type: versionType,
      game_directory: gameDir,
      assets_root: assetsRoot,
      assets_index_name: indexId,
      natives_directory: nativesDir,
      launcher_name: LAUNCHER_NAME,
      launcher_version: launcherVersion(),
      classpath,
      classpath_separator: process.platform === 'win32' ? CLASS_SUFFIX_WIN : CLASS_SUFFIX_OTHER,
      library_directory: librariesDir,
      game_assets: gameAssets,
      resolution_width: String(width),
      resolution_height: String(height),
    },
    authTokens(account, versionType, versionId),
  );
  if (logConfigPath) tokenMap.path = logConfigPath;

  // ── 参数 ────────────────────────────────────────────────────
  const parsed = versionModule.argumentList(resolved, { features, osInfo });
  const extraJvm = splitExtra(launchCfg.extraJvmArgs);
  const extraGame = splitExtra(launchCfg.extraGameArgs);

  const useModernJvm = !!(resolved.arguments && parsed.jvm.length > 0);

  const jvmArgs = [];
  /**
   * ★ -Xms（初始堆）现在可配（2026-11-05）。
   *   照安卓版「全局游戏设置 → 最低分配」移植：默认 512 MB，
   *   用户可在「设置 → 游戏」里调大，避免进世界时因扩容而卡顿。
   *   上限不超过 -Xmx，否则 JVM 直接拒绝启动。
   */
  const wantMin = Number(gameCfg.minMemoryMb);
  const minMb = Number.isFinite(wantMin) && wantMin >= 256 ? Math.min(wantMin, memoryMb) : Math.min(memoryMb, 512);
  jvmArgs.push(`-Xms${minMb}m`);
  jvmArgs.push(`-Xmx${memoryMb}m`);
  jvmArgs.push('-Dfile.encoding=UTF-8');

  /**
   * ★★★ 远古版本兼容参数（照安卓版 PojavLauncher 第 424~469 行移植）。
   *
   * 这些参数不加，远古版本会出现「能启动但进不去世界 / 连不上 / 排序崩」：
   *
   *   ① `-Djava.util.Arrays.useLegacyMergeSort=true`
   *      Java 7+ 的 TimSort 遇到旧版比较器会抛
   *      "Comparison method violates its general contract!" → 世界加载时崩。
   *   ② `-Dhttp.proxyHost=betacraft.uk`
   *      极老版本的会话/资源请求指向早已废弃的地址，走社区 BetaCraft 代理才能通过验证。
   *
   * ★ 版本判定必须覆盖**全部**远古前缀（安卓版 1.4.0 修过一次遗漏）：
   *     inf-* / in-* / pc-* / a* / b* / c0.* / rd-*，以及名字里含 infdev 的。
   *   漏掉 `in-`（indev）和 `pc-`（pre-classic）会导致「部分远古版本进不了游戏」。
   *
   * ★ 玩家可以在「版本设置 → JVM 参数」里显式写 useLegacyMergeSort / proxyHost 覆盖，
   *   与安卓版同规则：玩家自己写了就不自动加。
   */
  const legacyVerId = String(instance.installedVersion || instance.mcVersion || '').toLowerCase();
  const isLegacyBuild =
    legacyVerId.startsWith('inf') ||
    legacyVerId.startsWith('in-') ||
    legacyVerId.startsWith('a') ||
    legacyVerId.startsWith('b') ||
    legacyVerId.startsWith('c0.') ||
    legacyVerId.startsWith('pc-') ||
    legacyVerId.startsWith('rd') ||
    legacyVerId.includes('infdev');

  if (isLegacyBuild) {
    const overrides =
      String(launchCfg.extraJvmArgs || '').includes('useLegacyMergeSort') ||
      String(launchCfg.extraJvmArgs || '').includes('proxyHost');
    if (!overrides) {
      jvmArgs.push('-Dhttp.proxyHost=betacraft.uk');
      jvmArgs.push('-Djava.util.Arrays.useLegacyMergeSort=true');
      log.log(`远古版本（${legacyVerId}）：已自动注入兼容参数 -Dhttp.proxyHost=betacraft.uk / -Djava.util.Arrays.useLegacyMergeSort=true`);
    } else {
      log.log(`远古版本（${legacyVerId}）：玩家已自定义代理/排序参数，跳过自动注入`);
    }
    // applet 容器尺寸（AlphaVanillaTweakInjector 会优先读这两个属性）
    if (Number.isFinite(Number(launchCfg.width))) jvmArgs.push(`-Dqcl.applet.width=${launchCfg.width}`);
    if (Number.isFinite(Number(launchCfg.height))) jvmArgs.push(`-Dqcl.applet.height=${launchCfg.height}`);
  }

  if (!useModernJvm) {
    // 老版本自己补：natives 与 classpath（新式版本 JSON 的 arguments.jvm 里已经带了）
    jvmArgs.push(`-Djava.library.path=${nativesDir}`);
    jvmArgs.push('-Dminecraft.launcher.brand=${launcher_name}');
    jvmArgs.push('-Dminecraft.launcher.version=${launcher_version}');
    jvmArgs.push('-cp');
    jvmArgs.push('${classpath}');
  }
  for (const arg of parsed.jvm) jvmArgs.push(arg);

  /**
   * ★★★ 第三方账号（authlib-injector）注入（2026-11-05）。
   *
   * 用 authlib 账号启动时，必须让游戏去第三方站验证令牌，否则会显示「登录失败 / 无效会话」。
   * 做法就是加一个 javaagent：
   *     -javaagent:<authlib-injector.jar>=<认证服务器地址>
   * authlib-injector 会劫持游戏里所有与 Mojang API 的通信，转去第三方站。
   */
  if (account && account.type === 'authlib' && account.apiRoot) {
    try {
      const authlib = require('./authlib');
      const agent = authlib.buildJavaAgent(home, account.apiRoot);
      if (agent) {
        jvmArgs.push(agent);
        log.log(`已注入第三方认证：${account.apiRoot}`);
      } else {
        log.log(
          '警告：第三方账号需要 authlib-injector.jar，但本机还没下载。' +
            '请到「设置 → 第三方登录」点「下载组件」，否则游戏会提示会话无效。'
        );
      }
    } catch (err) {
      log.log(`警告：注入第三方认证失败（${err?.message || err}）`);
    }
  }

  for (const arg of extraJvm) jvmArgs.push(arg);

  const gameArgs = [];
  for (const arg of parsed.game) gameArgs.push(arg);

  /**
   * ★ 服务器地址 → 自动进入（2026-11-05 加）。
   *   照安卓版「全局游戏设置 → 服务器地址」移植：
   *   填了就在启动参数里加 --server <host> [--port <port>]，
   *   游戏启动后直接连这个服务器，跳过主菜单。
   *   ★ 只有 1.6 之后的版本才有 --server 参数；远古版本加了会因为不认参数而报错，
   *     所以这里按版本判断，老版本忽略并记一条日志。
   */
  const serverRaw = String(gameCfg.serverAddress || '').trim();
  if (serverRaw) {
    const versionId = resolved.id || instance.installedVersion || instance.mcVersion;
    const supportsServerArg = /^1\.(?:[6-9]|[1-9]\d)/.test(String(versionId)) || /^(?:2[0-9]|[3-9]\d)\./.test(String(versionId));
    if (supportsServerArg) {
      // 支持 host:port 写法
      const m = /^(.+?):(\d{1,5})$/.exec(serverRaw);
      if (m) {
        gameArgs.push('--server', m[1], '--port', m[2]);
      } else {
        gameArgs.push('--server', serverRaw);
      }
      log.log(`已设置启动后自动进入服务器：${serverRaw}`);
    } else {
      log.log(`提示：${versionId} 不支持 --server 自动进服（1.6 以前没有这个参数），已忽略服务器地址设置`);
    }
  }

  /**
   * ★ 窗口类型 → --fullscreen（照 HMCL settings.game.window_type，2026-11-05 加）。
   */
  if (windowType === 'fullscreen') {
    gameArgs.push('--fullscreen');
    log.log('窗口类型：全屏');
  }

  /**
   * ★ 快速游玩 → --quickPlaySingleplayer / --quickPlayMultiplayer（照 HMCL quick_play）。
   *   需要 1.20+；老版本加了会因为不认参数而报错，所以按版本判断。
   */
  if (quickPlay) {
    const versionId = resolved.id || instance.installedVersion || instance.mcVersion;
    const supportsQuickPlay = /^1\.(?:2[0-9]|[3-9]\d)/.test(String(versionId)) || /^(?:2[6-9]|[3-9]\d)\./.test(String(versionId));
    if (supportsQuickPlay && quickPlay.target) {
      if (quickPlay.type === 'singleplayer') {
        gameArgs.push('--quickPlaySingleplayer', quickPlay.target);
        log.log(`快速游玩：进入存档「${quickPlay.target}」`);
      } else if (quickPlay.type === 'multiplayer') {
        gameArgs.push('--quickPlayMultiplayer', quickPlay.target);
        log.log(`快速游玩：进入服务器「${quickPlay.target}」`);
      }
    } else if (!supportsQuickPlay) {
      log.log(`提示：${versionId} 不支持快速游玩（需要 1.20+），已忽略该设置`);
    }
  }

  /**
   * ★ 图形 API（照 HMCL settings.advanced.graphics_backend，2026-11-05 加）。
   *   Minecraft 26.2+ 才认 `--graphicsBackend`；老版本加了会直接把参数当未知项。
   */
  {
    const gfx = instance.graphicsBackend || gameCfg.graphicsBackend || 'default';
    if (gfx !== 'default') {
      const versionId = resolved.id || instance.installedVersion || instance.mcVersion;
      const supportsGfx = /^(?:2[6-9]|[3-9]\d)\./.test(String(versionId)) || /^26\.[2-9]/.test(String(versionId));
      if (supportsGfx) {
        gameArgs.push('--graphicsBackend', gfx === 'vulkan' ? 'vulkan' : 'opengl');
        log.log(`图形 API：${gfx === 'vulkan' ? 'Vulkan' : 'OpenGL'}`);
      } else {
        log.log(`提示：${versionId} 不支持切换图形 API（需要 26.2+），已忽略该设置`);
      }
    }
  }

  for (const arg of extraGame) gameArgs.push(arg);

  const substitute = (list) => {
    const out = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      // ${path} 没有对应文件时整条丢掉，免得把字面量 "${path}" 塞给 log4j
      if (raw.includes('${path}') && !logConfigPath) continue;
      out.push(replaceTokensIn(raw, tokenMap));
    }
    return out;
  };

  const finalArgs = substitute(jvmArgs).concat([resolved.mainClass], substitute(gameArgs));

  // 隐藏日志里的令牌（与 MultiMC censorPrivateInfo 同样的考虑：
  // 「查看上次启动日志」是给玩家看/复制的，令牌写进去等于账号可被冒用）
  const secrets = [account.accessToken, tokenMap.auth_session]
    .filter((s) => typeof s === 'string' && s.length > 8);
  const maskLine = (arg) => {
    let out = arg;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join('***');
    }
    return out;
  };
  log.log('启动命令（令牌已隐去）：');
  log.log(finalArgs.map(maskLine).join(' '));

  // ── spawn ───────────────────────────────────────────────────
  if (opts.dryRun) {
    log.log('（干跑模式：只拼装命令行，不真正启动游戏进程）');
    return {
      pid: 0,
      kill: () => false,
      child: null,
      java: javaPath,
      args: finalArgs,
      memoryMb,
      javaVersion: javaInfo.version,
      classpathEntries,
      nativesDir,
      gameDir,
      logFile: log.file,
      dryRun: true,
      exited: Promise.resolve({ code: 0 }),
    };
  }

  /**
   * ★★★ 预设游戏语言为中文（2026-11-05 新增，用户要求）。
   *
   * 让玩家装完游戏第一次进去就是中文界面，不用自己去 Options → Language 翻。
   *
   * ★★ **大小写陷阱**（这就是「1.1 崩溃 BUG」，安卓版 QCL 修过）：
   *   · 1.1 ~ 1.10  → `zh_CN`（地区**大写**）
   *   · 1.11+ / 26.x → `zh_cn`（地区**小写**）
   *   · 1.0 及更早  → **一个字都不能写**，那两个世代的 options.txt 没这个字段，写了会崩
   *   · 远古版本     → 跳过（中文靠补丁注入，改 lang 反而可能加载失败）
   *   具体判定见 core/gameoptions.js 的 normalizeLangCase()。
   *
   * 顺带把玩家以前写错的大小写纠正回来（fixLangCase）。
   */
  try {
    const gameOptions = require('./gameoptions');
    const gcfg = settings.game || {};
    const forceLang = gcfg.forceChinese === false ? null : String(gcfg.forceChineseLang || 'zh_CN');
    const verId = resolved.id || instance.installedVersion || instance.mcVersion;

    if (forceLang) {
      // ① 先纠正历史遗留的错误大小写（比如别的启动器写成 zh_cn 给 1.7.10 用）
      const fix = gameOptions.fixLangCase(gameDir, verId);
      if (fix.fixed) {
        log.log(`已修正游戏语言大小写：${fix.from} → ${fix.to}（${fix.reason}）`);
      }

      // ② 再按需写入目标语言
      const r = gameOptions.applyLanguage({ gameDir, mcVersion: verId, lang: forceLang });
      if (r.applied) {
        log.log(`已预设游戏语言：${r.lang}（${verId}）`);
      } else if (r.error) {
        log.log(`警告：预设游戏语言失败（${r.error}），不影响启动`);
      } else if (r.skipped && r.skipped !== '已经是目标语言') {
        log.log(`提示：跳过预设语言 —— ${r.skipped}`);
      }
    }
  } catch (err) {
    // 预设语言失败绝不能拦启动
    log.log(`警告：预设游戏语言异常（${err?.message || err}），继续启动`);
  }

  stage('spawn', '启动 Java 进程', `${javaInfo.version}（${javaInfo.arch}）· 内存 ${memoryMb} MB`);
  const child = spawn(javaPath, finalArgs, {
    cwd: gameDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid;
  log.log(`游戏进程已启动，PID = ${pid}`);
  /**
   * ★ 注意：这条 stage 只表示「进程已启动，正在加载游戏」，
   *   **不代表**游戏画面已经出来。真正就绪看下面的 readyDetector
   *   （命中日志主循环标志 → opts.onGameReady() → 界面才关启动窗口）。
   */
  stage('running', '等待游戏窗口', '进程已启动，正在加载游戏');

  let started = Date.now();
  let exited = false;
  let readyTimer = null;

  /**
   * ★★★ 「游戏真就绪」检测器（2026-11-05）。
   *   只有日志里出现 GAME_READY_RE 的那一行才回调一次 opts.onGameReady()；
   *   上层（ipc.js）把它转成 `launch:game-ready` 事件，界面收到才关启动窗口。
   */
  const readyDetector = createGameReadyDetector(
    () => {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      log.log(
        `游戏已就绪：检测到主循环标志「${String(readyDetector.matchedLine).trim().slice(0, 120)}」，启动耗时 ${seconds} 秒`
      );
    try {
      // 带上耗时，界面可以显示「游戏已就绪（用时 X 秒）」
      if (typeof opts.onGameReady === 'function') opts.onGameReady({ elapsedMs: Date.now() - started });
    } catch (_) {
      /* 界面回调异常不能影响游戏进程 */
    }
    },
    /**
     * ★ 弱信号必须等 spawn 满 8 秒才认（老版本的 LWJGL/Setting user 出现太早，
     *   那时游戏窗口还没建好，直接认会重演「画面没出来窗口就关了」）。
     */
    { startedAt: started }
  );

  const pump = (stream, tag) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let idx = buffer.search(/\r?\n/);
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        const nl = buffer.slice(idx).match(/^\r?\n/)[0].length;
        buffer = buffer.slice(idx + nl);
        // ★ 先喂「就绪」检测器：看日志原文，不看后面加了 [错误] 前缀的展示文本
        readyDetector.feed(line);
        if (line.trim()) emit(tag === 'stderr' ? `[错误] ${line}` : line);
        idx = buffer.search(/\r?\n/);
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) {
        readyDetector.feed(buffer);
        emit(tag === 'stderr' ? `[错误] ${buffer}` : buffer);
      }
    });
  };
  pump(child.stdout, 'stdout');
  pump(child.stderr, 'stderr');

  /**
   * 兜底：90 秒还没命中就只记一条日志，**不报错、不发事件**。
   * 有些整合包加载极慢（或 log4j 配置把这几行日志吞了），
   * 这时界面按自己的超时收尾即可，绝不能让启动流程失败。
   */
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (readyDetector.fired || exited) return;
    log.log(
      `提示：启动 ${GAME_READY_TIMEOUT_MS / 1000} 秒仍未检测到「游戏就绪」标志，继续等待（不影响游戏运行，界面按自己的超时处理）`
    );
  }, GAME_READY_TIMEOUT_MS);
  if (typeof readyTimer.unref === 'function') readyTimer.unref(); // 别为了这个计时器拖住进程退出

  const kill = (timeoutMs) => {
    if (exited || !child.pid) return false;
    try {
      if (process.platform === 'win32') {
        // Java 会派生子进程，必须整棵树一起结束，否则会留下孤儿
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        child.kill('SIGTERM');
      }
    } catch (_) {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
    }
    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => {
        try {
          if (!exited) child.kill('SIGKILL');
        } catch (_) {
          /* ignore */
        }
      }, timeoutMs);
    }
    return true;
  };

  const exitPromise = new Promise((resolve) => {
    // 进程结束（正常 / 崩溃 / 起不来）都要把兜底计时器收掉，别留悬挂的 90 秒定时器
    const clearReadyTimer = () => {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
    };
    child.on('error', (err) => {
      exited = true;
      clearReadyTimer();
      const message = `启动游戏进程失败：${err && err.message ? err.message : err}`;
      log.log(message);
      if (typeof opts.onExit === 'function') opts.onExit({ code: -1, error: message, state: 'exited' });
      resolve({ code: -1, error: message });
    });
    child.on('exit', (code, signal) => {
      if (exited) return;
      exited = true;
      clearReadyTimer();
      const seconds = Math.round((Date.now() - started) / 1000);
      log.log(`游戏进程已退出：退出码 ${code}${signal ? `，信号 ${signal}` : ''}，运行 ${seconds} 秒`);
      try {
        // 记一次游玩时长（异步，不阻塞返回）
        // eslint-disable-next-line global-require
        require('./instances').markPlayed(home, instance.id, Date.now() - started).catch(() => {});
      } catch (_) {
        /* ignore */
      }
      if (typeof opts.onExit === 'function') opts.onExit({ code, signal, state: 'exited' });
      resolve({ code, signal });
    });
  });

  return {
    pid,
    kill,
    child,
    java: javaPath,
    args: finalArgs,
    memoryMb,
    javaVersion: javaInfo.version,
    logFile: log.file,
    exited: exitPromise,
    /** 游戏是否已经真的就绪（检测到主循环标志）；供上层/测试查询，不改变事件语义。 */
    isGameReady: () => readyDetector.fired,
  };
}

/** 拆用户填的额外参数（支持引号）。 */
function splitExtra(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

module.exports = {
  LAUNCHER_NAME,
  launch,
  replaceTokensIn,
  authTokens,
  autoMemoryMb,
  splitExtra,
  loadResolvedVersion,
  launcherVersion,
  // 「游戏就绪」检测（给 ipc 层与 build/verify-game-ready.js 用）
  GAME_READY_RE,
  GAME_READY_TIMEOUT_MS,
  isGameReadyLine,
  isWeakGameReadyLine,
  GAME_READY_STRONG_RE,
  GAME_READY_WEAK_RE,
  createGameReadyDetector,
};
