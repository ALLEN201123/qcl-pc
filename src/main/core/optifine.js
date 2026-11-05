'use strict';
/*
 * optifine.js —— OptiFine（高清修复）自动安装。
 *
 * ## 数据来源（免登录、无验证码）
 * BMCLAPI 帮我们镜像了 optifine.net 的列表与下载：
 *   · 列表：GET https://bmclapi2.bangbang93.com/optifine/<mcVersion>
 *           → [{ mcversion, type: 'HD_U', patch: 'I6', filename: 'OptiFine_1.20.1_HD_U_I6.jar', forge }, …]
 *           ★ 预览版的 type 会变成 `HD_U_I5` 这类、patch 是 `pre4`、filename 以 `preview_` 开头
 *   · 下载：GET https://bmclapi2.bangbang93.com/optifine/<mcVersion>/<type>/<patch>
 *   （1.20.1 实测 14 条：2 个正式 + 12 个预览；1.12.2 实测 17 条：14 个正式 + 3 个预览）
 *
 * ## 两个时代，装法完全不同（照 HMCL OptiFineInstallTask）
 *
 * ### A. MC ≤ 1.12.2 —— OptiFine 自带 Patcher，可以离线打补丁
 *   安装器 jar 里有 `optifine/Patcher.class`，用 Java 无界面执行：
 *     java -cp <installer.jar> optifine.Patcher <minecraft.jar> <installer.jar> <out.jar>
 *   产出「补丁后的 OptiFine jar」，放进 libraries/optifine/OptiFine/<mc>_<ver>/；
 *   再生成一个 inheritsFrom 原版的版本 JSON：
 *     mainClass = net.minecraft.launchwrapper.Launch
 *     游戏参数追加 --tweakClass optifine.OptiFineTweaker
 *   实测（2026-11-05）：Java 21 跑 1.12.2_HD_U_G5 的 Patcher 退出码 0，2.2 秒，
 *   产出 2,457,427 字节、含 optifine/OptiFineTweaker.class。
 *
 * ### B. MC ≥ 1.13 —— OptiFine 变成 Forge 模组
 *   不跑 Patcher，直接把这个 jar 放进 mods/，**必须先装 Forge**。
 *   （1.20.1 的安装器里其实也有 Patcher.class，但 1.13+ 的 OptiFine 必须由 Forge 加载，
 *     自己打补丁出来是跑不起来的 —— 别被文件存在误导。）
 *
 * ## 安全约定
 *   · 不改动玩家原版 jar：Patcher 读原版、写新文件；
 *   · 所有临时文件都在 <home>/cache/optifine 下；失败会清理半成品；
 *   · 全中文错误 + E_* 错误码（http.LauncherError）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const http = require('./http');
const paths = require('./paths');
const jsonstore = require('./jsonstore');
const zip = require('./zip');
const { readZip, createZip } = require('./zipwriter');
const downloader = require('./downloader');
const javaModule = require('./java');

/** BMCLAPI OptiFine 列表 / 下载根 */
const BMCL_BASE = 'https://bmclapi2.bangbang93.com/optifine';
/** BMCLAPI 的 maven 镜像（OptiFine 自己的库不在 libraries.minecraft.net） */
const BMCL_MAVEN = 'https://bmclapi2.bangbang93.com/maven/';
/** 安装器下载到 <home>/cache/optifine/ 下 */
const CACHE_SUBDIR = ['cache', 'optifine'];
/** Patcher 最长跑 3 分钟（实测 2 秒，给足余量） */
const PATCHER_TIMEOUT_MS = 180000;
/** 列表/下载超时 */
const LIST_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 180000;
/** OptiFine 官方的 tweakClass / 主类 */
const TWEAK_CLASS = 'optifine.OptiFineTweaker';
const LAUNCHWRAPPER_MAIN = 'net.minecraft.launchwrapper.Launch';
const USER_AGENT = 'QCL-PC/1.0.0 (github.com/QuantaCraftLauncher)';

/* ------------------------------------------------------------------ 版本判定 */

/**
 * 这个 MC 版本走哪条安装路线？
 *   · 'patch' —— ≤ 1.12.2（OptiFine 自带 Patcher）
 *   · 'mod'   —— ≥ 1.13（Forge 模组）
 * 远古版本（a1.x / b1.x / rd- / c0. 等）没有 OptiFine，按 patch 路线尝试（列表会是空）。
 *
 * @param {string} mcVersion
 * @returns {'patch'|'mod'}
 */
function modeFor(mcVersion) {
  const v = String(mcVersion == null ? '' : mcVersion).trim();
  // 1.x：minor ≤ 12 是旧时代；1.13 起是 Forge 模组
  const m = /^1\.(\d+)/.exec(v);
  if (m) return Number(m[1]) <= 12 ? 'patch' : 'mod';
  // 远古版本 / 快照 / 2.x+：没有 OptiFine 的正式支持，按新式处理（列表通常为空）
  if (/^(\d{2}w|a\d|b\d|rd-|pc-|c0\.|in-|inf)/i.test(v)) return 'patch';
  return 'mod';
}

/** 是否旧时代（≤1.12.2） */
function isLegacy(mcVersion) {
  return modeFor(mcVersion) === 'patch';
}

/* ------------------------------------------------------------------ 版本列表 */

/** 把一条 BMCL 原始记录归一化成内部结构 */
function normalize(raw, mcVersion) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  const patch = String(raw.patch || '').trim();
  if (!type || !patch) return null;
  const version = `${type}_${patch}`; // 例如 HD_U_G5 / HD_U_I6
  const filename = String(raw.filename || `OptiFine_${mcVersion}_${version}.jar`);
  // 预览版判据：filename 以 preview_ 开头，或 patch 以 pre 开头
  const preview = /^preview_/i.test(filename) || /^pre/i.test(patch);
  return {
    mcVersion: String(mcVersion),
    type,
    patch,
    version,
    filename,
    preview,
    // 界面显示用，例如「OptiFine HD U I6（1.20.1）」
    label: `OptiFine ${type.replace(/_/g, ' ')} ${patch}（${mcVersion}）`,
    forge: raw.forge ? String(raw.forge) : null,
    // maven 坐标里的版本是 <mc>_<type>_<patch>（照 HMCL：Artifact("optifine","OptiFine", mc+"_"+selfVersion)）
    mavenVersion: `${mcVersion}_${version}`,
    downloadUrl: `${BMCL_BASE}/${encodeURIComponent(String(mcVersion))}/${encodeURIComponent(type)}/${encodeURIComponent(patch)}`,
  };
}

/**
 * 取某个 MC 版本的**全部** OptiFine 版本（含预览版，新→旧）。
 * @param {string} mcVersion
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
 * @returns {Promise<Array<object>>}
 */
async function listAll(mcVersion, options) {
  const opts = options || {};
  const mc = String(mcVersion == null ? '' : mcVersion).trim();
  if (!mc) {
    throw new http.LauncherError('获取 OptiFine 版本列表失败：没有指定 Minecraft 版本', { code: 'E_OPTIFINE_PARAMS' });
  }
  let data;
  try {
    data = await http.fetchJson(`${BMCL_BASE}/${encodeURIComponent(mc)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeoutMs: opts.timeoutMs || LIST_TIMEOUT_MS,
      retries: 1,
      signal: opts.signal,
    });
  } catch (err) {
    throw new http.LauncherError(
      `获取 OptiFine 版本列表失败（${mc}）：${err && err.message ? err.message : '网络不可用'}`,
      { code: 'E_OPTIFINE_LIST', cause: err }
    );
  }
  if (!Array.isArray(data)) {
    throw new http.LauncherError(`获取 OptiFine 版本列表失败（${mc}）：BMCLAPI 返回的不是数组`, {
      code: 'E_OPTIFINE_LIST',
    });
  }
  const out = [];
  for (const raw of data) {
    const item = normalize(raw, mc);
    if (item) out.push(item);
  }
  // BMCLAPI 的列表是按发布时间正序的 → 反转成新→旧（与其它加载器一致）
  out.reverse();
  return out;
}

/**
 * 正式版列表（过滤预览版，新→旧）。
 * @param {string} mcVersion
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
 * @returns {Promise<Array<object>>}
 */
async function listStable(mcVersion, options) {
  const all = await listAll(mcVersion, options);
  return all.filter((x) => !x.preview);
}

/**
 * 挑一个版本：给了 version 就用它（接受 `HD_U_G5` 或 `OptiFine_1.12.2_HD_U_G5.jar` 形式），
 * 没给就取最新正式版。
 * @param {string} mcVersion
 * @param {string} [version]
 * @param {{timeoutMs?:number, signal?:AbortSignal, allowPreview?:boolean}} [options]
 */
async function pickVersion(mcVersion, version, options) {
  const opts = options || {};
  const list = opts.allowPreview ? await listAll(mcVersion, opts) : await listStable(mcVersion, opts);
  if (!list.length) {
    throw new http.LauncherError(
      `BMCLAPI 上没有 ${mcVersion} 的 OptiFine 正式版（这个版本可能不支持 OptiFine）`,
      { code: 'E_OPTIFINE_NO_VERSION' }
    );
  }
  const wanted = String(version == null ? '' : version).trim();
  if (!wanted) return list[0];
  const lower = wanted.toLowerCase();
  const hit = list.find((x) => {
    const candidates = [x.version, x.filename, x.mavenVersion, `${x.type}_${x.patch}`];
    return candidates.some((c) => String(c).toLowerCase() === lower);
  });
  if (!hit) {
    throw new http.LauncherError(
      `OptiFine 版本「${wanted}」不在 ${mcVersion} 的可用列表里（可用：${list
        .slice(0, 6)
        .map((x) => x.version)
        .join(', ')}${list.length > 6 ? ' …' : ''}）`,
      { code: 'E_OPTIFINE_BAD_VERSION' }
    );
  }
  return hit;
}

/* ------------------------------------------------------------------ 通用工具 */

/** 缓存目录 <home>/cache/optifine */
function cacheDirOf(home) {
  const dir = path.join(paths.homeOf(home), ...CACHE_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 读实例元数据（用于判断有没有 Forge） */
function readInstance(home, instanceId) {
  const file = paths.instanceJson(home, instanceId);
  const data = jsonstore.readJson(file, null);
  if (!data) {
    throw new http.LauncherError(`找不到实例 ${instanceId} 的信息（instance.json）`, { code: 'E_OPTIFINE_NO_INSTANCE' });
  }
  return data;
}

function emitProgress(onProgress, patch) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(patch || {});
  } catch (_) {
    /* 进度回调异常不影响安装 */
  }
}

function logOf(onLog) {
  return typeof onLog === 'function' ? onLog : () => {};
}

function ensureNotAborted(signal) {
  if (signal && signal.aborted) {
    throw new http.LauncherError('OptiFine 安装已取消', { code: 'E_CANCELLED' });
  }
}

/** 文件是否是能打开的 zip（用于判断下载到的安装器是否完整） */
function isZipFile(file) {
  try {
    zip.open(file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 下载安装器到缓存（已有且是合法 zip 就跳过）。
 * @returns {Promise<string>} 安装器路径
 */
async function ensureInstaller(entry, opts) {
  const dir = cacheDirOf(opts.home);
  /**
   * ★ 安装器用**原始文件名**（OptiFine_1.12.2_HD_U_G5.jar），
   *   避免和 Patcher 的产出（OptiFine-1.12.2_HD_U_G5.jar）撞名。
   *   第一版就因为两者同名、跑 Patcher 前把安装器当成旧产物删掉，
   *   导致 java 报「找不到或无法加载主类 optifine.Patcher」。
   */
  const dest = path.join(dir, entry.filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0 && isZipFile(dest)) {
    logOf(opts.onLog)(`安装器已存在，跳过下载：${path.basename(dest)}`);
    return dest;
  }
  // 坏文件先删掉，避免一直命中
  try {
    fs.rmSync(dest, { force: true });
  } catch (_) {
    /* ignore */
  }
  logOf(opts.onLog)(`下载 OptiFine 安装器：${entry.filename}`);
  emitProgress(opts.onProgress, { stage: '下载 OptiFine 安装器', file: entry.filename, percent: 5 });
  const r = await downloader.downloadAll(
    [{ url: entry.downloadUrl, dest, name: entry.filename }],
    {
      threads: 1,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      signal: opts.signal,
      onProgress: (p) => {
        const total = Number(p && p.bytesTotal) || 0;
        const bytes = Number(p && p.bytes) || 0;
        const percent = total > 0 ? Math.min(55, 5 + Math.round((bytes / total) * 50)) : 5;
        emitProgress(opts.onProgress, { stage: '下载 OptiFine 安装器', file: entry.filename, percent });
      },
    }
  );
  if (r.failed.length) {
    throw new http.LauncherError(`下载 OptiFine 安装器失败：${r.failed[0].error}`, {
      code: 'E_OPTIFINE_DOWNLOAD',
    });
  }
  if (!isZipFile(dest)) {
    try {
      fs.rmSync(dest, { force: true });
    } catch (_) {
      /* ignore */
    }
    throw new http.LauncherError(`下载到的 OptiFine 安装器不是合法 jar（可能下载不完整），已删除，请重试`, {
      code: 'E_OPTIFINE_DOWNLOAD',
    });
  }
  return dest;
}

/**
 * 从 jar 里删掉指定条目（默认删 META-INF/mods.toml）。
 * 做法：读出全部条目 → 过滤 → 重新打包 → 原子替换。
 * @returns {boolean} 是否真的删掉了东西
 */
function stripJarEntries(jarPath, names) {
  const wanted = new Set((names || ['META-INF/mods.toml']).map((n) => String(n).toLowerCase()));
  let entries;
  try {
    entries = readZip(jarPath);
  } catch (_) {
    return false;
  }
  const kept = entries.filter((e) => !wanted.has(String(e.name).toLowerCase()));
  if (kept.length === entries.length) return false;
  const tmp = `${jarPath}.optmp`;
  try {
    createZip(tmp, kept.map((e) => ({ name: e.name, data: e.data, method: 0 })));
    fs.rmSync(jarPath, { force: true });
    fs.renameSync(tmp, jarPath);
    return true;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* ignore */
    }
    throw new http.LauncherError(`清理 ${path.basename(jarPath)} 的签名/元数据失败：${err && err.message ? err.message : err}`, {
      code: 'E_OPTIFINE_STRIP',
      cause: err,
    });
  }
}

/** 选一个能跑 Patcher 的 Java（优先设置里指定的） */
async function resolveJava(home, mcVersion, javaPath) {
  const wanted = String(javaPath || '').trim();
  if (wanted && fs.existsSync(wanted)) return { path: wanted, version: null };
  let detected = [];
  try {
    detected = await javaModule.detect({ home });
  } catch (_) {
    detected = [];
  }
  const best = javaModule.pickBest ? javaModule.pickBest(detected, mcVersion) : detected[0];
  if (!best || !best.path) {
    throw new http.LauncherError(
      '没有找到可用的 Java，无法运行 OptiFine 安装器。请到「设置 → Java」下载或指定一个 Java（1.12.2 推荐 Java 8）。',
      { code: 'E_OPTIFINE_NO_JAVA' }
    );
  }
  return best;
}

/**
 * 跑 OptiFine 自带的 Patcher（无界面）。
 * @returns {Promise<{code:number, stdoutTail:string, stderrTail:string, ms:number}>}
 */
function runPatcher(javaPath, installerPath, minecraftJar, outJar, options) {
  const opts = options || {};
  const args = ['-cp', installerPath, 'optifine.Patcher', minecraftJar, installerPath, outJar];
  const log = logOf(opts.onLog);
  log(`正在运行 OptiFine Patcher（Java: ${javaPath}）`);
  log(`Patcher 参数：${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(javaPath, args, { cwd: path.dirname(installerPath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(
        new http.LauncherError(`启动 OptiFine Patcher 失败：${err && err.message ? err.message : err}`, {
          code: 'E_OPTIFINE_PATCHER',
          cause: err,
        })
      );
      return;
    }
    let outTail = '';
    let errTail = '';
    let outLines = 0;
    const started = Date.now();
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
    }, opts.timeoutMs || PATCHER_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      outLines += (text.match(/\r?\n/g) || []).length;
      outTail = (outTail + text).slice(-1500); // 只留尾部，防内存膨胀
    });
    child.stderr.on('data', (chunk) => {
      errTail = (errTail + String(chunk)).slice(-1500);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new http.LauncherError(`运行 OptiFine Patcher 失败：${err && err.message ? err.message : err}`, {
          code: 'E_OPTIFINE_PATCHER',
          cause: err,
        })
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === 0) {
        log(`OptiFine Patcher 完成：退出码 0，处理 ${outLines} 行日志，耗时 ${ms} ms`);
      }
      resolve({ code: typeof code === 'number' ? code : -1, stdoutTail: outTail, stderrTail: errTail, ms });
    });
  });
}

/* -------------------------------------------------------- 模式 B：Forge 模组 */

/** 1.13+：放进 mods/，必须先有 Forge */
async function installAsMod(entry, ctx) {
  const { home, instanceId, mcVersion } = ctx;
  const inst = ctx.instance || readInstance(home, instanceId);
  const loaderType = inst.loader && inst.loader.type ? String(inst.loader.type).toLowerCase() : '';
  if (loaderType !== 'forge') {
    throw new http.LauncherError(
      '1.13 以后的 OptiFine 需要先装 Forge：请先选 Forge 安装这个版本，再回来装 OptiFine。',
      { code: 'E_OPTIFINE_NEED_FORGE' }
    );
  }

  const installer = await ensureInstaller(entry, ctx);
  const modsDir = path.join(paths.gameDir(home, instanceId), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, entry.filename);
  emitProgress(ctx.onProgress, { stage: '放入 mods 目录', file: entry.filename, percent: 70 });
  // ★ 1.13+ 的安装器**就是** Forge 模组本体：原样复制，不要删 META-INF/mods.toml
  fs.copyFileSync(installer, dest);
  logOf(ctx.onLog)(`OptiFine 已放入 mods：${dest}`);
  emitProgress(ctx.onProgress, { stage: '完成', file: entry.filename, percent: 100, done: true });
  return {
    mode: 'mod',
    mcVersion,
    version: entry.version,
    label: entry.label,
    filename: entry.filename,
    file: dest,
    installer,
  };
}

/* --------------------------------------------------- 模式 A：Patcher 打补丁 */

/** ≤1.12.2：用 Patcher 生成补丁 jar + 版本 JSON */
async function installWithPatcher(entry, ctx) {
  const { home, instanceId, mcVersion } = ctx;
  const log = logOf(ctx.onLog);
  const versionsDir = paths.versionsDir(home, instanceId);
  const minecraftJar = path.join(versionsDir, mcVersion, `${mcVersion}.jar`);
  if (!fs.existsSync(minecraftJar) || fs.statSync(minecraftJar).size === 0) {
    throw new http.LauncherError(
      `请先装好原版 ${mcVersion}（版本目录里没有 ${mcVersion}.jar，OptiFine 需要拿它来打补丁）`,
      { code: 'E_OPTIFINE_NO_CLIENT_JAR' }
    );
  }

  // 1) Java
  const java = await resolveJava(home, mcVersion, ctx.javaPath);
  log(`Patcher 使用的 Java：${java.path}`);

  // 2) 安装器
  const installer = await ensureInstaller(entry, ctx);

  // 3) Patcher 输出路径（先写缓存，成功后再放进 libraries）
  const cacheDir = cacheDirOf(home);
  const outJar = path.join(cacheDir, `OptiFine-${entry.mavenVersion}.jar`);
  try {
    fs.rmSync(outJar, { force: true });
  } catch (_) {
    /* ignore */
  }
  ensureNotAborted(ctx.signal);
  emitProgress(ctx.onProgress, { stage: '正在打 OptiFine 补丁', file: entry.filename, percent: 58 });
  log(`原版 jar：${minecraftJar}`);
  const result = await runPatcher(java.path, installer, minecraftJar, outJar, {
    onLog: log,
    timeoutMs: ctx.timeoutMs || PATCHER_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    try {
      fs.rmSync(outJar, { force: true });
    } catch (_) {
      /* ignore */
    }
    const detail = result.stderrTail.trim() || result.stdoutTail.trim() || '（Patcher 没有输出）';
    throw new http.LauncherError(
      `OptiFine 补丁失败（Patcher 退出码 ${result.code}）。原始错误：${detail.slice(0, 300)}`,
      { code: 'E_OPTIFINE_PATCHER' }
    );
  }
  if (!fs.existsSync(outJar) || fs.statSync(outJar).size === 0) {
    throw new http.LauncherError('OptiFine 补丁失败：Patcher 没有生成输出 jar', { code: 'E_OPTIFINE_PATCHER' });
  }
  // 校验产物里真的有 OptiFine 的 tweaker（防止 Patcher 静默失败）
  let outEntries = [];
  try {
    outEntries = zip.list(outJar);
  } catch (err) {
    throw new http.LauncherError(`OptiFine 补丁产物不是合法 jar：${err && err.message ? err.message : err}`, {
      code: 'E_OPTIFINE_PATCHER',
    });
  }
  if (!outEntries.includes('optifine/OptiFineTweaker.class')) {
    throw new http.LauncherError('OptiFine 补丁产物里没有 optifine/OptiFineTweaker.class，Patcher 可能没真正生效', {
      code: 'E_OPTIFINE_PATCHER',
    });
  }
  log(`补丁产物：${path.basename(outJar)}（${fs.statSync(outJar).size} 字节，${outEntries.length} 个条目）`);

  // 4) 丢掉 mods.toml（老版本 OptiFine 偶尔带；HMCL 也这么做，否则 Forge 会抢）
  if (stripJarEntries(outJar, ['META-INF/mods.toml'])) log('已移除补丁 jar 里的 META-INF/mods.toml');
  if (stripJarEntries(installer, ['META-INF/mods.toml'])) log('已移除安装器里的 META-INF/mods.toml');

  // 5) 放进 libraries/optifine/OptiFine/<mavenVersion>/
  const libsDir = paths.librariesDir(home, instanceId);
  const optifineJar = path.join(libsDir, 'optifine', 'OptiFine', entry.mavenVersion, `OptiFine-${entry.mavenVersion}.jar`);
  fs.mkdirSync(path.dirname(optifineJar), { recursive: true });
  fs.copyFileSync(outJar, optifineJar);
  log(`OptiFine 补丁 jar 已就位：${optifineJar}`);

  // 6) launchwrapper：安装器里带哪个就用哪个（照 HMCL）
  const libraries = [{ name: `optifine:OptiFine:${entry.mavenVersion}`, url: BMCL_MAVEN }];
  let launchwrapper = null;
  const installerEntries = zip.list(installer);
  if (installerEntries.includes('launchwrapper-2.0.jar')) {
    const target = path.join(libsDir, 'optifine', 'launchwrapper', '2.0', 'launchwrapper-2.0.jar');
    extractEntry(installer, 'launchwrapper-2.0.jar', target);
    libraries.push({ name: 'optifine:launchwrapper:2.0', url: BMCL_MAVEN });
    launchwrapper = { version: '2.0', file: target };
    log('已解出 launchwrapper-2.0.jar');
  } else if (installerEntries.includes('launchwrapper-of.txt')) {
    // 1.12.2 的安装器带的是 launchwrapper-of-2.2.jar
    const versionText = readEntryText(installer, 'launchwrapper-of.txt').trim();
    const jarName = `launchwrapper-of-${versionText}.jar`;
    if (versionText && installerEntries.includes(jarName)) {
      const target = path.join(libsDir, 'optifine', 'launchwrapper-of', versionText, jarName);
      extractEntry(installer, jarName, target);
      libraries.push({ name: `optifine:launchwrapper-of:${versionText}`, url: BMCL_MAVEN });
      launchwrapper = { version: versionText, file: target };
      log(`已解出 ${jarName}`);
    }
  }
  if (!launchwrapper) {
    // 兜底：原版 launchwrapper 1.12（libraries.minecraft.net 上有）
    libraries.push({ name: 'net.minecraft:launchwrapper:1.12' });
    launchwrapper = { version: '1.12', file: null };
    log('安装器里没有自带 launchwrapper，将使用 net.minecraft:launchwrapper:1.12');
  }

  // 7) 版本 JSON
  const versionId = `${mcVersion}-OptiFine_${entry.version}`;
  const versionDir = path.join(versionsDir, versionId);
  fs.mkdirSync(versionDir, { recursive: true });
  const versionJson = {
    id: versionId,
    inheritsFrom: mcVersion,
    type: 'release',
    // ★ 告诉启动器「客户端 jar 用原版那层」（Mojang 的 Forge/LiteLoader 补丁也这么写）
    jar: mcVersion,
    mainClass: LAUNCHWRAPPER_MAIN,
    // ★ 用 arguments.game 而不是 minecraftArguments：version.js 会把它**追加**到父版参数之后，
    //   不需要复制父版的整串参数（复制的话父版一改就错位）。
    arguments: { game: ['--tweakClass', TWEAK_CLASS] },
    libraries,
  };
  const jsonPath = path.join(versionDir, `${versionId}.json`);
  jsonstore.writeJson(jsonPath, versionJson);
  log(`版本 JSON 已生成：${jsonPath}`);

  /**
   * ★★ gamecheck 会检查 `<版本目录>/<版本id>.jar` 是否存在（缺了算 critical），
   *   但补丁版本身没有自己的客户端 jar —— 真正启动时 classpath 用的是原版那层
   *   （version.js 的 clientJarId 继承父版，classpathList 只加 versions/<mc>/<mc>.jar）。
   *   ⇒ 用**硬链接**指向原版 jar：同一卷、不占额外空间，完整性检查也不会误报。
   *   （不复制：1.12.2 的 jar 有 10MB，复制既慢又占空间。）
   */
  try {
    const linkPath = path.join(versionDir, `${versionId}.jar`);
    if (!fs.existsSync(linkPath)) {
      fs.linkSync(minecraftJar, linkPath);
      log('已把原版 jar 硬链接到补丁版本目录（供完整性检查用，不额外占空间）');
    }
  } catch (err) {
    log(`警告：无法为补丁版本建立原版 jar 硬链接（不影响启动，但完整性检查可能提示缺 jar）：${err && err.message ? err.message : err}`);
  }

  emitProgress(ctx.onProgress, { stage: '完成', file: entry.filename, percent: 100, done: true });
  return {
    mode: 'patch',
    mcVersion,
    version: entry.version,
    label: entry.label,
    versionId,
    versionJson: jsonPath,
    optifineJar,
    launchwrapper,
    installer,
    libraries,
  };
}

/** 从 zip 里解出一个条目到目标路径 */
function extractEntry(zipPath, entryName, dest) {
  const handle = zip.open(zipPath);
  const entry = handle.entries.find((e) => e.name === entryName);
  if (!entry) throw new http.LauncherError(`安装器里找不到 ${entryName}`, { code: 'E_OPTIFINE_LAUNCHWRAPPER' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, handle.readEntry(entry));
  return dest;
}

/** 从 zip 里读一个文本条目 */
function readEntryText(zipPath, entryName) {
  const handle = zip.open(zipPath);
  const entry = handle.entries.find((e) => e.name.toLowerCase() === String(entryName).toLowerCase());
  if (!entry) return '';
  return handle.readEntry(entry).toString('utf8');
}

/* ------------------------------------------------------------------ 安装入口 */

/**
 * 安装 OptiFine。
 *
 * @param {{home:string, instanceId:string, mcVersion:string, version?:string,
 *          instance?:object, javaPath?:string, onProgress?:Function, onLog?:Function,
 *          signal?:AbortSignal, timeoutMs?:number}} params
 * @returns {Promise<object>} 模式 A：{mode:'patch', versionId, versionJson, optifineJar, launchwrapper, …}
 *                            模式 B：{mode:'mod', file, filename, …}
 */
async function install(params) {
  const opts = params || {};
  const home = paths.homeOf(opts.home);
  const instanceId = String(opts.instanceId || '').trim();
  const mcVersion = String(opts.mcVersion || '').trim();
  if (!instanceId) throw new http.LauncherError('安装 OptiFine 失败：没有指定实例', { code: 'E_OPTIFINE_PARAMS' });
  if (!mcVersion) throw new http.LauncherError('安装 OptiFine 失败：没有指定 Minecraft 版本', { code: 'E_OPTIFINE_PARAMS' });
  if (!fs.existsSync(paths.gameDir(home, instanceId))) {
    throw new http.LauncherError(`实例不存在：${instanceId}`, { code: 'E_OPTIFINE_NO_INSTANCE' });
  }

  const entry = await pickVersion(mcVersion, opts.version, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  const log = logOf(opts.onLog);
  log(
    `准备安装 ${entry.label}（${entry.filename}，${modeFor(mcVersion) === 'patch' ? 'Patcher 打补丁' : '放进 mods（需要 Forge）'}）`
  );

  if (modeFor(mcVersion) === 'mod') {
    return installAsMod(entry, { ...opts, home, instanceId, mcVersion });
  }
  return installWithPatcher(entry, { ...opts, home, instanceId, mcVersion });
}

module.exports = {
  BMCL_BASE,
  BMCL_MAVEN,
  TWEAK_CLASS,
  LAUNCHWRAPPER_MAIN,
  modeFor,
  isLegacy,
  listAll,
  listStable,
  pickVersion,
  cacheDirOf,
  stripJarEntries,
  resolveJava,
  runPatcher,
  install,
};
