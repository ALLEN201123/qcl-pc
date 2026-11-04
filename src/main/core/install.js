'use strict';
/*
 * install.js —— 安装流程。
 *
 * 流程（照契约 §4 + 安卓版 LegacyArchiveInstallTask）：
 *   ① 解析版本 JSON（含 inheritsFrom 继承链）
 *   ② 下载 client.jar
 *   ③ 下载 libraries（含 natives 分类器 jar）
 *   ④ 解压 natives 到 .minecraft/natives/
 *   ⑤ 下载资源（assets/objects；legacy 走 virtual / map_to_resources 挂载）
 *   ⑥ 写 instance.json（installedVersion）
 *   全程推 onProgress；支持 signal 取消；已存在且校验通过的文件直接跳过（第二次安装秒完成）。
 *
 * 远古版本（QCL 看家本领）：id 命中内置归档清单且地址以 .info 结尾时，
 *   先读 Betacraft 的 .info 拿到真正的客户端 jar 地址，再用 core/data/legacy_launch_template.json
 *   拼一份完整的版本 JSON（launchwrapper + LWJGL 2.9.0 + pre-1.6 资源索引），
 *   这样它就和普通版本一样能装能启动 —— 与安卓版行为一致。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const paths = require('./paths');
const jsonstore = require('./jsonstore');
const http = require('./http');
const mojang = require('./mojang');
const versionModule = require('./version');
const libraries = require('./libraries');
const nativesModule = require('./natives');
// ★ 必须有：detectClientKind 要靠它读客户端 jar 的条目表来判断时代。
//   少了这行会抛 ReferenceError，而外层 try/catch 会把它当「探测失败」吞掉，
//   于是永远走不到 RubyDung 分支（踩过：表现为「改了但没生效」）。
const zip = require('./zip');
const assetsModule = require('./assets');
const javaModule = require('./java');
const downloader = require('./downloader');
const instancesModule = require('./instances');
const rulesModule = require('./rules');
const logger = require('./logger');

/* ----------------------------------------------------- 远古版本模板与特例 */

const LW = {
  1.5: { sha1: '5150b9c2951f0fde987ce9c33496e26add1de224', size: '27787' },
  1.6: { sha1: '4ea0aca9c022a234ebaf14b51fb119055955fc9d', size: '27583' },
};

/** launchwrapper 版本：alpha 用 1.5，其余（classic/indev/infdev/beta）用 1.6。 */
function launchWrapperVersionFor(id) {
  return String(id || '').toLowerCase().startsWith('a') ? '1.5' : '1.6';
}

/** tweaker 选择（照安卓版 tweakClassFor，但补了 RubyDung 时代那一档）。 */
function tweakClassFor(id) {
  const lower = String(id || '').toLowerCase();
  // ★★★ pre-classic（RubyDung 时代，如 pc-132011 / rd-132211）**不走 launchwrapper**：
  //   那个 jar 里只有 com.mojang.rubydung.*，主类是 com.mojang.rubydung.RubyDung，
  //   压根没有 net.minecraft.client.MinecraftApplet / com.mojang.minecraft.MinecraftApplet，
  //   套 AlphaVanillaTweaker 必定 ClassNotFoundException（实测日志）。
  //   是否 RubyDung 由 jar 内容探测决定（见 detectClientKind），这里只兜底 rd- 前缀。
  if (lower.startsWith('rd-')) return '';
  if (lower.startsWith('in-')) {
    return ' --tweakClass net.minecraft.launchwrapper.IndevVanillaTweaker';
  }
  if (lower.startsWith('inf') || lower.startsWith('a') || lower.startsWith('c0.')) {
    return ' --tweakClass net.minecraft.launchwrapper.AlphaVanillaTweaker';
  }
  // pc-* 留空，交给 detectClientKind 决定（pre-classic 里有一部分已是 classic 结构）
  if (lower.startsWith('pc-')) return '';
  return '';
}

/**
 * 探测客户端 jar 的真实「时代」，决定主类与 tweaker。
 *
 * ★ 为什么必须探测而不是按 id 前缀猜：
 *   同样叫 pre-classic 的版本，Betacraft 归档里既有 RubyDung 结构（`com/mojang/rubydung/RubyDung`），
 *   也有后来的 classic 结构（`com/mojang/minecraft/MinecraftApplet`）。
 *   按前缀一律甩给 AlphaVanillaTweaker，RubyDung 那一批就会 ClassNotFoundException。
 *
 * @returns {{ kind: 'rubydung'|'classic'|'alpha'|'beta'|'unknown', mainClass: string|null, tweak: string }}
 */
function detectClientKind(clientJarPath, id) {
  let entries = [];
  try {
    entries = zip.list(clientJarPath) || [];
  } catch (err) {
    entries = [];
  }
  const has = (name) => entries.includes(name);
  if (has('com/mojang/rubydung/RubyDung.class')) {
    return { kind: 'rubydung', mainClass: 'com.mojang.rubydung.RubyDung', tweak: '' };
  }
  if (has('com/mojang/minecraft/MinecraftApplet.class')) {
    return {
      kind: 'classic',
      mainClass: 'com.mojang.minecraft.MinecraftApplet',
      tweak: ' --tweakClass net.minecraft.launchwrapper.AlphaVanillaTweaker'
    };
  }
  if (has('net/minecraft/client/MinecraftApplet.class')) {
    return {
      kind: 'alpha',
      mainClass: 'net.minecraft.client.MinecraftApplet',
      tweak: ' --tweakClass net.minecraft.launchwrapper.AlphaVanillaTweaker'
    };
  }
  // 探测不到就按原有前缀规则兜底
  const tweak = tweakClassFor(id);
  let mainClass = 'net.minecraft.client.Minecraft';
  const lower = String(id || '').toLowerCase();
  if (lower.startsWith('in-')) mainClass = 'net.minecraft.client.d';
  else if (lower.startsWith('inf') || lower.startsWith('a')) mainClass = 'net.minecraft.client.MinecraftApplet';
  return { kind: 'unknown', mainClass, tweak };
}

function legacyTypeFor(id) {
  const text = String(id || '');
  if (text.startsWith('b')) return 'old_beta';
  if (text.startsWith('1.')) return 'release';
  return 'old_alpha';
}

function readLegacyTemplate() {
  const file = path.join(mojang.dataDir(), 'legacy_launch_template.json');
  return jsonstore.readText(file, null);
}

/**
 * 用归档启动模板拼一份版本 JSON。
 * @param {string} id
 * @param {string} sourceUrl 归档元数据地址（写进 archiveSource 便于溯源）
 * @param {object|null} clientKind 由 detectClientKind 探测出来的客户端时代（可选）
 */
function buildLegacyJson(id, sourceUrl, clientKind) {
  const template = readLegacyTemplate();
  if (!template || !template.trim()) {
    throw new Error('缺少远古版本启动模板（core/data/legacy_launch_template.json），无法安装归档版本');
  }

  const kind = clientKind && clientKind.kind ? clientKind.kind : 'unknown';
  const lwVersion = launchWrapperVersionFor(id);
  const lw = LW[lwVersion];
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // ★★★ RubyDung 时代（pre-classic 里最早那批）：完全不走 launchwrapper。
  //   主类直接用 jar 里的 com.mojang.rubydung.RubyDung，参数里也不追加 --tweakClass；
  //   否则 AlphaVanillaTweakInjector 会去找不存在的 MinecraftApplet → ClassNotFoundException。
  if (kind === 'rubydung') {
    let tpl = readLegacyTemplate();
    const parsed = fillTemplate(tpl, id, sourceUrl, '', lwVersion, lw, time);
    parsed.mainClass = 'com.mojang.rubydung.RubyDung';
    // 去掉 tweak 参数，并去掉 launchwrapper / asm 之类的包装库（直接用原版 jar 起）
    parsed.minecraftArguments = String(parsed.minecraftArguments || '')
      .replace(/\s*--tweakClass\s+\S+/g, '')
      .trim();
    parsed.libraries = (parsed.libraries || []).filter(
      (l) => !/launchwrapper|asm-all|jopt-simple/i.test(String(l.name || ''))
    );
    parsed.qclClientKind = 'rubydung';
    parsed.qclLegacyProxyArgs = parsed.qclLegacyProxyArgs || undefined;
    return parsed;
  }

  const tweak = clientKind && clientKind.tweak !== undefined ? clientKind.tweak : tweakClassFor(id);
  const filled = template
    .replace(/__ID__/g, id)
    .replace(/__TIME__/g, time)
    .replace(/__TYPE__/g, legacyTypeFor(id))
    .replace(/__TWEAK__/g, tweak)
    .replace(/__SOURCE__/g, sourceUrl || '')
    .replace(/__LWVER__/g, lwVersion)
    .replace(/__LWSHA1__/g, lw.sha1)
    .replace(/__LWSIZE__/g, lw.size);
  try {
    const parsed = JSON.parse(filled);
    parsed.qclClientKind = kind;
    return parsed;
  } catch (err) {
    throw new Error(`远古版本启动模板内容不合法：${err && err.message ? err.message : err}`);
  }
}

/** 把模板占位换成真实值并解析 */
function fillTemplate(template, id, sourceUrl, tweak, lwVersion, lw, time) {
  const filled = template
    .replace(/__ID__/g, id)
    .replace(/__TIME__/g, time)
    .replace(/__TYPE__/g, legacyTypeFor(id))
    .replace(/__TWEAK__/g, tweak)
    .replace(/__SOURCE__/g, sourceUrl || '')
    .replace(/__LWVER__/g, lwVersion)
    .replace(/__LWSHA1__/g, lw.sha1)
    .replace(/__LWSIZE__/g, lw.size);
  return JSON.parse(filled);
}

/** 解析 Betacraft 的 .info（纯文本，每行 `键: 值`）。 */
function parseBetacraftInfo(text) {
  const out = { clientUrl: null, proxyArgs: null, launchMethod: null, releaseDate: null, raw: text };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'url' && value && !out.clientUrl) out.clientUrl = value;
    else if (key === 'proxy-args') out.proxyArgs = value;
    else if (key === 'launch-method') out.launchMethod = value;
    else if (key === 'release-date') out.releaseDate = value;
  }
  return out;
}

/* ------------------------------------------------------------- loader 支持 */

/**
 * 取 loader 的 profile JSON。
 *   fabric / quilt —— 官方 meta 直接给「继承原版」的 profile json，写进 versions/<profileId>/ 即可。
 *   babric         —— b1.7.3 的 Fabric 分支，接口形状与 Fabric 一致，只是域名不同（见 core/babric.js）。
 *   modloader      —— **没有 profile**：先装原版，再把 class 覆盖进 minecraft.jar（见 ⑤.7）。
 *   forge / neoforge / optifine / liteloader —— 必须跑安装器改 jar，见 core/loaderinstall.js。
 */
async function fetchLoaderProfile(mcVersion, loader, ctx) {
  const type = loader && loader.type;
  if (!type || type === 'vanilla') return null;
  const wanted = loader.version ? String(loader.version).trim() : '';

  if (type === 'fabric') {
    const base = 'https://meta.fabricmc.net/v2/versions/loader';
    const urls = wanted
      ? [`${base}/${encodeURIComponent(mcVersion)}/${encodeURIComponent(wanted)}/profile/json`]
      : [`${base}/${encodeURIComponent(mcVersion)}/profile/json`];
    return { profile: await fetchJsonWithFallback(urls, ctx, `Fabric ${mcVersion}`), source: 'fabric' };
  }
  if (type === 'quilt') {
    const base = 'https://meta.quiltmc.org/v3/versions/loader';
    const urls = wanted
      ? [`${base}/${encodeURIComponent(mcVersion)}/${encodeURIComponent(wanted)}/profile/json`]
      : [`${base}/${encodeURIComponent(mcVersion)}/profile/json`];
    return { profile: await fetchJsonWithFallback(urls, ctx, `Quilt ${mcVersion}`), source: 'quilt' };
  }
  /**
   * ★ Babric（b1.7.3 的 Fabric 分支）：profile 结构与 Fabric 一致，只换域名。
   *   注意它**不支持**「不带加载器版本」的 profile 端点（实测 404，Fabric 支持），
   *   所以交给 core/babric.js 去「先查最新稳定版、再拼带版本的 URL」。
   */
  if (type === 'babric') {
    const babric = require('./babric');
    const profile = await babric.fetchProfile(mcVersion, wanted, {
      timeoutMs: ctx && ctx.timeoutMs,
      signal: ctx && ctx.signal,
      onLog: (line) => ctx && ctx.log && ctx.log.log(line),
    });
    return { profile, source: 'babric' };
  }

  // ★ ModLoader 不生成 profile：它没有 tweakClass、没有依赖库，
  //   装法就是「原版装好后把 .class 覆盖进 minecraft.jar」（见 ⑤.7）。
  if (type === 'modloader') {
    return null;
  }

  // ★ Forge / NeoForge / OptiFine / LiteLoader：不在这里处理 fetchLoaderProfile，
  //   它们需要「先装好原版客户端，再运行官方安装器改写 jar」。
  //   这条分支返回 null 表示「本次只装原版」，安装器在 ⑤.6 阶段单独跑（见下面）。
  //   以前这里直接抛「暂不支持」，现在真的实现了。
  if (needsInstallerType(type)) {
    return null;
  }

  throw new Error(`不支持的加载器类型：${type}`);
}

/**
 * 解析依赖库该用哪个下载源。
 *
 * ★★★ Babric 必须用官方源（'official'），**绝不能**走 BMCLAPI：
 *   Babric 的库有一部分只在 Glass Launcher 自家 maven 上
 *   （`https://maven.glass-launcher.net/babric/…`，如 babric:intermediary-upstream、
 *     babric:log4j-config、org.lwjgl.lwjgl:lwjgl:2.9.4-babric.1），BMCLAPI 上没有这些产物；
 *   一旦按镜像规则改写地址就会 404，装到一半失败。
 *
 * @param {string} loaderType 加载器类型
 * @param {'official'|'bmclapi'} source 用户选择的下载源
 * @returns {'official'|'bmclapi'} 实际给 libraries.resolveLibraries / 下载器用的源
 */
function librarySourceFor(loaderType, source) {
  return String(loaderType || '').toLowerCase() === 'babric' ? 'official' : source;
}

/** 需要运行官方安装器的加载器 */
function needsInstallerType(type) {
  return ['forge', 'neoforge', 'optifine', 'liteloader'].includes(String(type || '').toLowerCase());
}

async function fetchJsonWithFallback(urls, ctx, what) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await http.fetchJson(url, { timeoutMs: ctx.timeoutMs, signal: ctx.signal, retries: 1 });
    } catch (err) {
      lastError = err;
    }
  }
  throw new http.LauncherError(`获取 ${what} 的安装信息失败：${lastError && lastError.message ? lastError.message : '网络不可用'}`, {
    code: 'E_LOADER',
    cause: lastError,
  });
}

/* ------------------------------------------------------------- 进度工具 */

/**
 * 进度统计：cumulative = 已结算阶段的实际完成量 + 当前阶段的实时进度。
 * 相位数/文件数/字节数全部来自下载器与解压器的真实计数，没有任何估算。
 */
function createTracker(onProgress) {
  const state = {
    phase: 'prepare',
    stage: '',
    current: 0,
    total: 0,
    bytes: 0,
    bytesTotal: 0,
    speed: 0,
    done: false,
  };
  let committedFiles = 0;
  let committedBytes = 0;

  const emit = (file) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      phase: state.phase,
      stage: state.stage,
      current: state.current,
      total: state.total,
      file: file || state.stage,
      speed: state.speed,
      bytes: state.bytes,
      bytesTotal: state.bytesTotal,
      done: state.done,
    });
  };

  return {
    state,
    /** 开始一个新阶段，并把上一阶段的真实完成量结算进累计基准。 */
    beginPhase(phase, stage, files, bytes) {
      // 注意：state.current / state.bytes 本身就已经是「累计值」
      // （progress/endPhase 里都是按 committed + 阶段内进度 算出来的），
      // 所以这里是赋值而不是累加 —— 累加会把上一阶段重复计一遍。
      committedFiles = state.current;
      committedBytes = state.bytes;
      state.phase = phase;
      state.stage = stage || '';
      state.current = committedFiles;
      state.total = committedFiles + (files || 0);
      state.bytes = committedBytes;
      state.bytesTotal = committedBytes + (bytes || 0);
      state.speed = 0;
      state.done = false;
      emit();
    },
    /** 阶段内进度（数据来自下载器：current/total 是文件数，bytes 是已下载字节）。 */
    progress(done, total, bytes, bytesTotal, file, speed) {
      state.current = committedFiles + (done || 0);
      if (total) state.total = committedFiles + total;
      state.bytes = committedBytes + (bytes || 0);
      if (bytesTotal) state.bytesTotal = committedBytes + bytesTotal;
      state.speed = speed || 0;
      state.done = false;
      emit(file);
    },
    /** 阶段结束：把该阶段的最终计数结算掉（不传则以「本阶段全部完成」计）。 */
    endPhase(files) {
      const done = files === undefined ? state.total - committedFiles : files;
      state.current = committedFiles + done;
      state.total = Math.max(state.total, state.current);
      emit();
    },
    /** 包装下载器回调。 */
    wrap() {
      return (p) => this.progress(p.current, p.total, p.bytes, p.bytesTotal, p.file, p.speed);
    },
    emit,
  };
}

/* ------------------------------------------------------------- 主流程 */

/**
 * 安装一个版本到一个实例。
 * @param {{home:string, instanceId:string, mcVersion:string, loader?:object, source?:string,
 *          threads?:number, onProgress?:Function, onLog?:Function, signal?:AbortSignal, timeoutMs?:number,
 *          reinstall?:boolean}} params
 * @returns {Promise<{version:string, files:number, bytes:number, gameDir:string, instance:object, mainClass:string, logFile:string}>}
 */
async function install(params) {
  const opts = params || {};
  const home = paths.homeOf(opts.home);
  const instanceId = opts.instanceId;
  if (!instanceId) throw new Error('安装失败：没有指定实例');
  const mcVersion = String(opts.mcVersion || '').trim();
  if (!mcVersion) throw new Error('安装失败：没有指定游戏版本');
  const source = opts.source === 'bmclapi' ? 'bmclapi' : 'official';
  const threads = Number.isFinite(opts.threads) && opts.threads > 0 ? opts.threads : downloader.DEFAULT_THREADS;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : http.DEFAULT_TIMEOUT_MS;
  const signal = opts.signal;
  /** 本次要装的加载器类型（提前取出来：依赖库解析与下载源都要用） */
  const requestedLoaderType = opts.loader && opts.loader.type ? String(opts.loader.type).toLowerCase() : '';

  paths.ensureHomeLayout(home);
  const instance = await instancesModule.ensure(home, instanceId);
  const gameDir = paths.gameDir(home, instanceId);
  const versionsDir = paths.versionsDir(home, instanceId);
  const librariesDir = paths.librariesDir(home, instanceId);
  const assetsDir = paths.assetsDir(home, instanceId);
  const nativesDir = paths.nativesDir(home, instanceId);
  paths.ensureDir(versionsDir);
  paths.ensureDir(librariesDir);
  paths.ensureDir(assetsDir);
  paths.ensureDir(nativesDir);

  const log = logger.createLogger(home, { reset: true, echo: opts.onLog });
  const tracker = createTracker(opts.onProgress);
  const ctx = { home, gameDir, versionsDir, librariesDir, assetsDir, nativesDir, source, threads, timeoutMs, signal, log };

  log.log(`开始安装：实例 ${instance.name}（${instanceId}），游戏版本 ${mcVersion}，下载源 ${source === 'bmclapi' ? 'BMCLAPI 镜像' : '官方源'}`);
  tracker.beginPhase('prepare', '准备安装', 0, 0);

  const checkAborted = () => {
    if (signal && signal.aborted) throw new http.LauncherError('安装已取消', { code: 'E_CANCELLED' });
  };

  // ── ① 版本 JSON ────────────────────────────────────────────────
  tracker.beginPhase('version', '获取版本信息', 1, 0);
  const manifestResult = await mojang.manifest({ cacheDir: paths.metaDir(home), source, timeoutMs, signal }).catch((err) => {
    // 没有清单也能装（本地已有版本 JSON 时），但需要告知用户
    log.log(`提示：获取官方版本清单失败（${err.message}），将只使用本地已有信息`);
    return { latest: { release: '', snapshot: '' }, versions: [], cached: false };
  });
  const manifestIndex = new Map(manifestResult.versions.map((v) => [v.id, v]));

  const loaderInfo = await fetchLoaderProfile(mcVersion, opts.loader, {
    timeoutMs, signal, log,
  });
  const loaderProfile = loaderInfo ? loaderInfo.profile : null;
  if (loaderProfile && !loaderProfile.id) {
    throw new http.LauncherError(`获取 ${loaderInfo.source} 安装信息失败：返回内容缺少 id`);
  }

  const targetId = loaderProfile ? loaderProfile.id : mcVersion;
  const versionDir = path.join(versionsDir, targetId);
  const targetJsonPath = path.join(versionDir, `${targetId}.json`);
  paths.ensureDir(versionDir);

  let rawJson = null;
  let archiveEntry = null;

  if (fs.existsSync(targetJsonPath)) {
    rawJson = jsonstore.readJson(targetJsonPath, null);
    if (rawJson) log.log(`使用本地已有的版本 JSON：${targetJsonPath}`);
  }

  checkAborted();

  if (!rawJson) {
    const manifestHit = manifestIndex.get(mcVersion);
    const archiveCandidate = mojang.archiveEntryFor(mcVersion);
    // 判据看**地址结尾**（照安卓版 LegacyVersionArchive.isArchiveBuild）：
    //   .info ⇒ Betacraft 归档，需要按骨架重建 JSON
    //   .json ⇒ 正常 piston-meta / zkitefly，直接下载
    const archiveEntryUsable = !!(archiveCandidate && archiveCandidate.url && String(archiveCandidate.url).endsWith('.info'));

    const loadArchive = async () => {
      archiveEntry = archiveCandidate;
      log.log(`识别为考古归档版本（Betacraft 源）：${mcVersion}`);
      const infoText = await http.fetchText(archiveEntry.url, { timeoutMs, signal, retries: 2 });
      const info = parseBetacraftInfo(infoText);
      if (!info.clientUrl) {
        throw new http.LauncherError(`归档版本 ${mcVersion} 的元数据里没有客户端下载地址，无法安装`, { code: 'E_ARCHIVE' });
      }
      if (info.proxyArgs) log.log(`归档元数据建议的代理参数：${info.proxyArgs}`);
      const json = buildLegacyJson(mcVersion, archiveEntry.url);
      json.archiveJarUrl = info.clientUrl;
      if (info.proxyArgs) json.qclLegacyProxyArgs = info.proxyArgs;
      log.log(`已按 b1.7.3 骨架重建 ${mcVersion} 的版本 JSON（launchwrapper ${launchWrapperVersionFor(mcVersion)}）`);
      return json;
    };

    const loadFromMojang = async (url, sha1, what) => {
      try {
        const json = await mojang.versionJson({
          id: mcVersion,
          url,
          sha1,
          cacheDir: paths.metaDir(home),
          source,
          timeoutMs,
          signal,
        });
        log.log(`已下载 ${what}：${mcVersion}`);
        return json;
      } catch (err) {
        throw new http.LauncherError(
          `获取版本 ${mcVersion} 的安装信息失败：${err && err.message ? err.message : '网络不可用'}`,
          { code: 'E_VERSION_JSON', cause: err },
        );
      }
    };

    if (loaderProfile) {
      rawJson = loaderProfile;
      log.log(`已获取 ${loaderInfo.source} 安装信息：${targetId}`);
    } else if (manifestHit) {
      // ★ 官方清单里有（old_alpha / old_beta / 正式版 / 快照）就优先用官方 JSON ——
      //   官方 JSON 自带真实 libraries / downloads.client / assetIndex，比骨架重建准确得多。
      try {
        rawJson = await loadFromMojang(manifestHit.url, manifestHit.sha1, '官方版本信息');
      } catch (err) {
        if (!archiveEntryUsable) throw err;
        log.log(`官方版本信息下载失败（${err.message}），改用 Betacraft 归档重建`);
        rawJson = await loadArchive();
      }
    } else if (archiveEntryUsable) {
      rawJson = await loadArchive();
    } else {
      // 未收录版本（piston-meta / zkitefly 上有 JSON）或用户手工传 id 的情况
      rawJson = await loadFromMojang(archiveCandidate && archiveCandidate.url, null, '版本信息');
    }
    if (!rawJson) throw new http.LauncherError(`版本 ${mcVersion} 的安装信息为空，无法安装`);
  }

  // 继承链取父版本 JSON 的方法
  const fetchParentJson = async (idOrUrl) => {
    checkAborted();
    const local = path.join(versionsDir, idOrUrl, `${idOrUrl}.json`);
    if (fs.existsSync(local)) {
      const data = jsonstore.readJson(local, null);
      if (data) return data;
    }
    const hit = manifestIndex.get(idOrUrl);
    return mojang.versionJson({
      id: idOrUrl,
      url: hit && hit.url,
      sha1: hit && hit.sha1,
      cacheDir: paths.metaDir(home),
      source,
      timeoutMs,
      signal,
    });
  };

  // ★ 用 let 而不是 const：下面「客户端时代探测」发现是 RubyDung 时代时要重新解析一次
  let resolved = await versionModule.resolve(rawJson, { fetchJson: fetchParentJson });
  if (!resolved.mainClass) {
    throw new http.LauncherError(`版本 ${targetId} 缺少启动主类（mainClass），无法启动`);
  }
  if (!rawJson.id) rawJson.id = targetId;
  jsonstore.writeJson(targetJsonPath, rawJson);
  log.log(`版本 JSON 已就绪：${resolved.id}（继承链 ${resolved.resolvedChain.join(' → ')}），主类 ${resolved.mainClass}`);

  // 继承链上的父版本 JSON 也一并落盘 —— 否则每次启动都要联网去取父版本，
  // 断网就打不开游戏（Forge / Fabric / Quilt 这类继承版本尤其明显）。
  if (Array.isArray(resolved.chainVersions)) {
    for (const item of resolved.chainVersions) {
      if (!item || !item.id || !item.raw) continue;
      if (item.id === targetId) continue;
      const parentDir = path.join(versionsDir, item.id);
      const parentJson = path.join(parentDir, `${item.id}.json`);
      if (fs.existsSync(parentJson)) continue;
      try {
        paths.ensureDir(parentDir);
        jsonstore.writeJson(parentJson, item.raw);
        log.log(`已把父版本 JSON 落盘：versions/${item.id}/${item.id}.json`);
      } catch (err) {
        log.log(`警告：父版本 JSON 写入失败（${item.id}）：${err && err.message ? err.message : err}`);
      }
    }
  }

  // ── ② 汇总下载计划 ────────────────────────────────────────────
  tracker.beginPhase('plan', '整理需要下载的文件', 0, 0);

  const osInfo = rulesModule.currentOs();
  /**
   * ★ Babric 的库必须走原始地址（BMCLAPI 上没有 Glass Launcher 的产物），
   *   所以这里按加载器类型决定给 libraries.resolveLibraries 用的源。
   */
  const librarySource = librarySourceFor(requestedLoaderType, source);
  if (requestedLoaderType === 'babric' && source !== librarySource) {
    log.log('Babric 的依赖库必须用原始 maven 地址（BMCLAPI 镜像上没有），本次依赖库已强制走官方源');
  }
  const libEntries = libraries.resolveLibraries(resolved, { osInfo, source: librarySource });

  const clientId = resolved.clientJarId || resolved.jar || resolved.id;
  const clientJarPath = path.join(versionsDir, clientId, `${clientId}.jar`);
  const clientDownload = resolved.downloads && resolved.downloads.client;
  const clientUrl = (clientDownload && clientDownload.url) || resolved.archiveJarUrl || null;

  const tasks = [];
  const nativeJars = [];

  // 客户端 jar
  if (clientUrl) {
    tasks.push({
      url: clientUrl,
      fallbackUrls: clientDownload ? [`https://bmclapi2.bangbang93.com/version/${encodeURIComponent(clientId)}/client`] : [],
      dest: clientJarPath,
      sha1: clientDownload && clientDownload.sha1 ? clientDownload.sha1 : undefined,
      size: clientDownload && clientDownload.size ? clientDownload.size : undefined,
      name: `versions/${clientId}/${clientId}.jar`,
      phase: 'client',
    });
  } else {
    log.log(`警告：版本 JSON 里没有客户端 jar 下载地址（远古版本常见），如果本地已存在就继续`);
  }

  // 库 + natives jar
  for (const entry of libEntries) {
    if (entry.hasArtifact) {
      tasks.push({
        url: entry.artifactUrl,
        dest: path.join(librariesDir, entry.artifactPath.split('/').join(path.sep)),
        sha1: entry.artifactSha1 || undefined,
        size: entry.artifactSize || undefined,
        name: `libraries/${entry.artifactPath}`,
        phase: 'libraries',
      });
    }
    if (entry.isNative) {
      const abs = path.join(librariesDir, entry.nativePath.split('/').join(path.sep));
      tasks.push({
        url: entry.nativeUrl,
        dest: abs,
        sha1: entry.nativeSha1 || undefined,
        size: entry.nativeSize || undefined,
        name: `libraries/${entry.nativePath}`,
        phase: 'libraries',
      });
      nativeJars.push({
        name: entry.spec.artifact + '-' + entry.spec.version + (entry.classifier ? '-' + entry.classifier : '') + '.jar',
        path: entry.nativePath,
        absolutePath: abs,
        excludes: entry.excludes,
      });
    }
    if (!entry.hasArtifact && !entry.isNative) {
      // 老式版本 JSON 里库常常没有 downloads 字段 → 按仓库地址拼
      const rel = entry.artifactPath;
      if (rel) {
        tasks.push({
          url: entry.artifactUrl,
          dest: path.join(librariesDir, rel.split('/').join(path.sep)),
          name: `libraries/${rel}`,
          phase: 'libraries',
        });
      }
    }
  }

  // 日志配置（1.12+ 的 -Dlog4j.configurationFile=${path}）
  let logConfigPath = null;
  if (resolved.logging && resolved.logging.client && resolved.logging.client.file && resolved.logging.client.file.url) {
    const f = resolved.logging.client.file;
    logConfigPath = path.join(assetsDir, 'log_configs', f.id);
    tasks.push({
      url: f.url,
      dest: logConfigPath,
      sha1: f.sha1 || undefined,
      size: f.size || undefined,
      name: `assets/log_configs/${f.id}`,
      phase: 'libraries',
    });
  }

  // ── ③ 执行下载 ────────────────────────────────────────────────
  if (tasks.length) {
    const clientTasks = tasks.filter((t) => t.phase === 'client');
    const libTasks = tasks.filter((t) => t.phase !== 'client');
    const bytesOf = (list) => list.reduce((sum, t) => sum + (t.size || 0), 0);

    if (clientTasks.length) {
      tracker.beginPhase('client', '下载客户端 jar', clientTasks.length, bytesOf(clientTasks));
      const r = await downloader.downloadAll(clientTasks, {
        threads: 1,
        source,
        onProgress: tracker.wrap(),
        signal,
        timeoutMs,
      });
      if (r.failed.length) throw new http.LauncherError(`下载客户端失败：${r.failed[0].error}`, { code: 'E_CLIENT' });
      tracker.endPhase(clientTasks.length);
      log.log(`客户端 jar 就绪：${clientJarPath}`);
    }

    if (libTasks.length) {
      tracker.beginPhase('libraries', '下载依赖库', libTasks.length, bytesOf(libTasks));
      log.log(`需要处理 ${libTasks.length} 个依赖文件`);
      const r = await downloader.downloadAll(libTasks, {
        threads,
        // ★ Babric 用 librarySource（= official），别让镜像改写 Glass Launcher 的库地址
        source: librarySource,
        onProgress: tracker.wrap(),
        signal,
        timeoutMs,
      });
      if (r.failed.length) {
        const first = r.failed[0];
        throw new http.LauncherError(`有 ${r.failed.length} 个依赖文件下载失败，例如 ${first.task && first.task.name}：${first.error}`, {
          code: 'E_LIBRARIES',
        });
      }
      tracker.endPhase(libTasks.length);
      log.log(`依赖库完成：新下载 ${r.done} 个，已存在跳过 ${r.skipped} 个`);
    }
  }

  // 客户端 jar 内容兜底检查（归档源偶尔会返回空文件或 HTML）
  if (clientUrl && fs.existsSync(clientJarPath)) {
    const stat = await fsp.stat(clientJarPath);
    let head = Buffer.alloc(0);
    try {
      const fd = await fsp.open(clientJarPath, 'r');
      const buf = Buffer.alloc(2);
      await fd.read(buf, 0, 2, 0);
      await fd.close();
      head = buf;
    } catch (_) {
      head = Buffer.alloc(0);
    }
    if (stat.size < 1024 || head.toString('latin1') !== 'PK') {
      throw new http.LauncherError(`客户端 jar 内容不合法（${stat.size} 字节，不是 ZIP 文件），可能是下载源返回了错误页面，请重试或更换下载源`, {
        code: 'E_CLIENT_INVALID',
      });
    }
  }

  checkAborted();

  // ── ③.5 客户端时代探测（RubyDung / Classic / Alpha 分派）──────
  //
  // ★★★ 为什么必须在这一步做：Betacraft 归档里的 pre-classic 有两种结构 ——
  //   · 最早那批是 RubyDung 时代：jar 里只有 com/mojang/rubydung/*，
  //     主类 com.mojang.rubydung.RubyDung，**没有** MinecraftApplet；
  //   · 稍晚的 classic：com/mojang/minecraft/MinecraftApplet。
  //   如果一律套 AlphaVanillaTweaker（安卓版就是这么写的），RubyDung 那批
  //   会在启动时报 `ClassNotFoundException: com.mojang.minecraft.MinecraftApplet`（已实测）。
  //   ⇒ 按 jar 实际内容分派，而不是按 id 前缀猜。
  // ★ 探测触发条件只看两件事：客户端 jar 真的存在 + 这是远古/归档版本。
  //   不要依赖 archiveEntry 变量（官方 manifest 路径下它是 null，会把整段跳过 —— 已踩过）。
  const isLegacyish =
    !!archiveEntry ||
    !!rawJson.archiveSource ||
    !!rawJson.archiveJarUrl ||
    /^(rd-|pc-|c0\.|in-|inf-?|a1\.|b1\.)/i.test(String(mcVersion || ''));
  if (rawJson && isLegacyish && fs.existsSync(clientJarPath)) {
    let kind = null;
    try {
      kind = detectClientKind(clientJarPath, mcVersion);
    } catch (err) {
      log.log(`警告：客户端 jar 内容探测失败（${err && err.message ? err.message : err}），按版本号前缀兜底`);
    }
    const expectKind = rawJson.qclClientKind;
    if (kind && kind.kind === 'rubydung' && expectKind !== 'rubydung') {
      log.log(`检测到 RubyDung 时代客户端（jar 里只有 com/mojang/rubydung/*），改用直启主类 ${kind.mainClass}，不套 launchwrapper`);
      const rebuilt = buildLegacyJson(mcVersion, archiveEntry && archiveEntry.url, kind);
      if (rawJson.archiveJarUrl) rebuilt.archiveJarUrl = rawJson.archiveJarUrl;
      if (rawJson.qclLegacyProxyArgs) rebuilt.qclLegacyProxyArgs = rawJson.qclLegacyProxyArgs;
      if (!rebuilt.id) rebuilt.id = targetId;
      jsonstore.writeJson(targetJsonPath, rebuilt);
      // 重新解析：主类/库/参数都变了，classpath 必须重算
      resolved = await versionModule.resolve(rebuilt, { fetchJson: fetchParentJson });
      log.log(`版本 JSON 已按 RubyDung 结构重写：主类 ${resolved.mainClass}`);
    } else if (kind && kind.kind !== 'unknown' && kind.kind !== expectKind) {
      log.log(`客户端时代为 ${kind.kind}（版本号前缀推断为 ${expectKind || '未定'}），以 jar 实测为准`);
      rawJson.qclClientKind = kind.kind;
      jsonstore.writeJson(targetJsonPath, rawJson);
    }
  }

  // ── ④ 解压 natives ────────────────────────────────────────────
  tracker.beginPhase('natives', '解压 natives', nativeJars.length ? 1 : 0, 0);
  if (nativeJars.length) {
    const result = await nativesModule.extract(nativeJars, { nativesDir, librariesDir });
    if (result.missing.length) {
      log.log(`警告：有 ${result.missing.length} 个 natives jar 不存在，已跳过`);
    }
    log.log(`natives 解压完成：${result.count} 个文件，共 ${(result.bytes / 1024).toFixed(1)} KB`);
  } else {
    log.log('该版本不需要解压 natives');
  }
  tracker.endPhase(nativeJars.length ? 1 : 0);

  // ── ⑤ 资源 ───────────────────────────────────────────────────
  checkAborted();
  tracker.beginPhase('assets', '下载游戏资源', 0, 0);
  const assetsResult = await assetsModule.install(resolved, {
    assetsDir,
    source,
    threads,
    timeoutMs,
    signal,
    metaObjectsDir: paths.metaObjectsDir(home),
    onProgress: tracker.wrap(),
    onLog: (line) => log.log(line),
  });
  tracker.endPhase(assetsResult.total || 0);
  log.log(`资源完成：对象 ${assetsResult.objectsTotal || 0} 个，新下载 ${assetsResult.done}，已存在跳过 ${assetsResult.skipped}`);

  checkAborted();

  // ── ⑤.5 远古版本中文补丁（QCL 的核心特色）──────────────────────
  //
  // ★ 为什么放在这里：中文补丁要**改游戏 jar**（换字体类 + 注入 222 张中文字形点阵 +
  //   替换 lang），必须在 client.jar 下载完、natives 解压之后做。
  //   b1.7.3 的字体是固定 256 个 ASCII 字模，不换字体中文全是方框。
  //
  // ★ 只在「远古版本」上尝试：现代版本自带 Unicode 字体与语言文件，不需要也不该动它的 jar。
  const isLegacyForPatch = /^(rd-|pc-|c0\.|in-|inf-?|a1\.|b1\.)/i.test(String(mcVersion || ''));
  if (isLegacyForPatch && fs.existsSync(clientJarPath)) {
    try {
      const chinesePack = require('./chinesepack');
      if (chinesePack.isSupported(mcVersion)) {
        tracker.beginPhase('chinesepack', '注入中文补丁', 1, 0);
        const packResult = await chinesePack.applyChinesePack({
          versionDir,
          versionId: mcVersion,
          lang: opts.lang || chinesePack.LANG_ZH,
          onLog: (line) => log.log(line),
        });
        tracker.endPhase(1);
        if (packResult.applied) {
          log.log(`中文补丁已注入（语言 ${packResult.lang}，${packResult.entries} 个条目）`);
        } else {
          log.log(`中文补丁未注入：${packResult.reason || '原因未知'}`);
        }
      } else {
        log.log(`该版本（${mcVersion}）暂不提供中文补丁，保持原版`);
      }
    } catch (err) {
      // 中文补丁失败绝不能把整个安装搞挂 —— 原版英文照样能玩
      log.log(`警告：中文补丁注入失败（${err && err.message ? err.message : err}），游戏仍可正常启动`);
    }
  }

  // ── ⑤.6 运行加载器安装器（Forge / NeoForge / OptiFine / LiteLoader）──
  //
  // ★ 这些加载器无法只靠一份 profile JSON 装好：它们的安装器要改写客户端 jar、
  //   生成 versions/<id>/ 与大量库文件。所以必须「先装好原版，再跑安装器」。
  //   以前这里是抛「暂不支持」，现在真的实现了（见 core/loaderinstall.js）。
  let installedLoaderVersion = null;
  let loaderManualHint = null;
  /** ModLoader 注入的 class 数（0 = 没装 / 未执行） */
  let modloaderInjected = 0;
  const loaderType = opts.loader && opts.loader.type ? String(opts.loader.type).toLowerCase() : '';
  if (needsInstallerType(loaderType) && opts.loader) {
    // 安装器要跑 java -jar，先挑一个可用的 Java（优先设置里指定的，其次自动检测）
    let javaForInstaller = null;
    try {
      const wanted = opts.settings && opts.settings.javaPath ? opts.settings.javaPath : null;
      if (wanted && fs.existsSync(wanted)) {
        javaForInstaller = wanted;
      } else {
        const detected = await javaModule.detect({ home });
        const best = javaModule.pickBest ? javaModule.pickBest(detected, mcVersion) : detected[0];
        javaForInstaller = best ? best.path : null;
      }
    } catch (err) {
      log.log(`警告：查找 Java 失败（${err && err.message ? err.message : err}）`);
    }
    if (!javaForInstaller) {
      log.log('警告：没有可用的 Java，跳过加载器安装器（请先到设置里配置 Java）');
    } else {
      try {
        const loaderInstall = require('./loaderinstall');
        tracker.beginPhase('loader', '运行加载器安装器', 1, 0);
        const r = await loaderInstall.installLoader({
          home,
          instanceDir: path.dirname(gameDir), // gameDir 是 .minecraft，实例根是它的父目录
          mcVersion,
          loader: opts.loader,
          javaPath: javaForInstaller,
          onLog: (line) => log.log(line),
          onProgress: () => tracker.emit(),
        });
        tracker.endPhase(1);
        if (r.installed) {
          installedLoaderVersion = r.versionId;
          log.log(`加载器安装完成：${r.versionId}`);
        } else if (r.manual) {
          loaderManualHint = r.hint || '该加载器需要手动安装';
          log.log(`需要手动安装：${r.hint || ''}`);
          log.log(`下载页：${r.manual}`);
        }
      } catch (err) {
        tracker.endPhase(1);
        // 加载器装失败要如实报错（不能假装装好了），但原版已经装完、仍可启动
        const msg = err && err.message ? err.message : String(err);
        log.log(`加载器安装失败：${msg}`);
        throw new http.LauncherError(
          `原版 ${mcVersion} 已装好，但 ${loaderType} 安装失败：${msg}。` +
            `你可以先在「版本列表」里启动原版，或稍后重试加载器安装。`,
          { code: 'E_LOADER' }
        );
      }
    }
  }

  // ── ⑤.7 Babric 标记 + ModLoader 注入 ─────────────────────────
  //
  // ★ Babric 是「Fabric 分支」：装法与 Fabric 一样（profile + 库 + 换 mainClass），
  //   jar 本身没被改，但要在版本目录写 `.babric` 标记：
  //   ① gamecheck 见到它就跳过文件校验；② 界面/检测用它判断「这个版本是 Babric」。
  if (loaderType === 'babric') {
    try {
      const babric = require('./babric');
      const marker = babric.writeMarker(versionDir, {
        mcVersion,
        loaderVersion: (opts.loader && opts.loader.version) || '',
        libraries: Array.isArray(resolved.libraries) ? resolved.libraries.length : 0,
        profileId: targetId,
      });
      log.log(`已写入 Babric 标记：${marker}`);
    } catch (err) {
      // 标记写失败不影响已装好的 Babric，下次再装会补
      log.log(`警告：Babric 标记写入失败（不影响启动）：${err && err.message ? err.message : err}`);
    }
  }

  /**
   * ★ ModLoader 是「文件覆盖式」安装：**必须先有原版 jar**，再把 .class 写进去。
   *   所以它排在原版安装 + 中文补丁之后单独跑（不能像 Forge 那样跑安装器）。
   *   失败要如实报错（原版已装好、仍可启动），绝不假装装好了。
   */
  if (loaderType === 'modloader') {
    tracker.beginPhase('loader', '注入 ModLoader', 1, 0);
    try {
      const modloader = require('./modloader');
      const r = await modloader.install({
        home,
        instanceId,
        mcVersion,
        versionId: targetId,
        signal,
        onLog: (line) => log.log(line),
        onProgress: (p) => {
          // 进度条按百分比推进（ModLoader 只有一个包，没有文件数概念）
          const percent = p && Number.isFinite(p.percent) ? p.percent : 0;
          tracker.progress(percent / 100, 1, 0, 0, (p && (p.file || p.stage)) || 'ModLoader');
        },
      });
      tracker.endPhase(1);
      installedLoaderVersion = targetId;
      modloaderInjected = r.injected;
      log.log(`ModLoader 注入完成：${r.injected} 个 class（标记 ${r.marker}）`);
    } catch (err) {
      tracker.endPhase(1);
      const msg = err && err.message ? err.message : String(err);
      log.log(`ModLoader 安装失败：${msg}`);
      throw new http.LauncherError(
        `原版 ${mcVersion} 已装好，但 ModLoader 安装失败：${msg}` +
          `。你可以先在「版本列表」里启动原版，或稍后重试。`,
        { code: 'E_LOADER' }
      );
    }
  }

  // ── ⑥ 写 instance.json ───────────────────────────────────────
  tracker.beginPhase('finish', '写入实例信息', 1, 0);

  /**
   * ★★★ 远古版本自动打开「不检查游戏文件」。
   *
   * 为什么：QCL 给远古版本**改写过游戏 jar**（注入中文字体类 + 点阵 + lang + 界面翻译）。
   * 一旦跑全量 SHA1 校验：
   *   ① 被改过的条目必然对不上原版 sha1 → 判定「文件损坏」；
   *   ② 检查器会重新下载原版 jar / 还原条目 → **中文补丁被冲掉**；
   *   ③ 原版 jar 带 Mojang 签名，下次注入又要重新删签名。
   * ⇒ 安卓版的做法（LegacyArchiveInstallTask 1.3.0 / QclVersionConfig）：
   *    **远古版本装完就把「不检查游戏文件」打开**，而且只作用于该版本。
   * ⇒ PC 版照做，并且额外记下中文补丁状态，让 gamecheck 也能据此跳过内容校验。
   */
  const isLegacyInstall = /^(rd-|pc-|c0\.|in-|inf-?|a1\.|b1\.)/i.test(String(mcVersion || ''));
  let chinesePackInfo = null;
  try {
    const chinesePack = require('./chinesepack');
    const applied = chinesePack.appliedLang(versionDir);
    if (applied) chinesePackInfo = { applied: true, lang: applied, dir: chinesePack.ruleFor(mcVersion)?.dir || '' };
  } catch {
    /* 中文包模块异常不影响安装 */
  }

  const updated = await instancesModule.update(home, instanceId, {
    installedVersion: targetId,
    mcVersion,
    /**
     * ★ ModLoader 的「加载器版本」就是它对应的 MC 版本（它没有独立版本号），
     *   与安装结果约定一致：`{ type:'modloader', version:<mcVersion> }`。
     */
    loader: loaderType === 'modloader'
      ? { type: 'modloader', version: mcVersion }
      : (opts.loader && opts.loader.type && opts.loader.type !== 'vanilla'
        ? { type: opts.loader.type, version: opts.loader.version || '' }
        : (loaderProfile ? { type: loaderInfo.source, version: '' } : { type: 'vanilla', version: '' })),
    // ★ 远古版本 / 装了 ModLoader 的版本自动关掉完整性检查（只影响这一个实例）
    notCheckGameFiles: isLegacyInstall || loaderType === 'modloader' ? true : undefined,
    chinesePack: chinesePackInfo || undefined,
  });
  tracker.endPhase(1);

  const bytes = tracker.state.bytes;
  const files = tracker.state.current;
  tracker.beginPhase('done', '安装完成', 0, 0);
  tracker.state.done = true;
  tracker.emit();
  log.log(`安装完成：版本 ${targetId}，共处理 ${files} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）`);

  return {
    version: targetId,
    files,
    bytes,
    gameDir,
    instance: updated,
    mainClass: resolved.mainClass,
    logFile: log.file,
    // 加载器安装结果（Forge 系列给版本 id；ModLoader 给注入的 class 数）
    loader: loaderType || 'vanilla',
    installedLoaderVersion,
    modloaderInjected,
    loaderManualHint,
  };
}

module.exports = {
  install,
  buildLegacyJson,
  parseBetacraftInfo,
  // 供 build/verify-modloader-babric.js 等测试脚本直接验证（不对外暴露给渲染层）
  fetchLoaderProfile,
  librarySourceFor,
  tweakClassFor,
  launchWrapperVersionFor,
  legacyTypeFor,
};
