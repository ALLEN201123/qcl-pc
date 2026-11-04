'use strict';
/*
 * java.js —— Java 运行时探测。
 *
 * 参照：
 *   vendor/MultiMC/launcher/java/JavaUtils.cpp       —— JAVA_HOME / 注册表 / 常见目录候选
 *   vendor/MultiMC/launcher/java/JavaChecker.cpp     —— 执行 java 拿 os.arch / java.version / java.vendor
 *   vendor/MultiMC/launcher/java/JavaInstallList.cpp —— 探测结果去重成列表
 *
 * 与 MultiMC 的差异（有意为之）：
 *   · MultiMC 靠 JavaCheck.jar 打印属性；这里用 `java -XshowSettings:properties -version`，
 *     它把同样的 java.version / java.vendor / os.arch 打到 **stderr**，不需要额外产物；
 *   · 能直接读到 JDK 的 release 文件时优先用文件（不启动进程，扫描快得多）。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const rules = require('./rules');

const IS_WINDOWS = process.platform === 'win32';
const JAVA_EXE = IS_WINDOWS ? 'java.exe' : 'java';

/* ------------------------------------------------------------ 常用安装位置 */

/** Windows 上常见的 Java 根目录（含本机实测存在的 Microsoft / Eclipse Adoptium / Java）。 */
const WINDOWS_JAVA_ROOTS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files (x86)\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Eclipse Foundation',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Amazon Corretto',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\Azul Systems\\Zulu',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files\\BellSoft\\LibericaJDK',
  'C:\\Program Files\\AdoptOpenJDK',
  'C:\\Program Files\\Semeru',
  'C:\\Program Files\\IBM\\Semeru',
  'C:\\Program Files\\Temurin',
  'C:\\Program Files\\JetBrains',
  'C:\\Program Files\\Android\\Android Studio\\jbr',
];

/** 注册表枚举位置（照 JavaUtils.cpp 的 KEY_WOW64_* 组合）。 */
const REGISTRY_ROOTS = [
  'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
  'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
  'HKLM\\SOFTWARE\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\JavaSoft\\JRE',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JRE',
  'HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK',
  'HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE',
  'HKLM\\SOFTWARE\\WOW6432Node\\Eclipse Adoptium\\JDK',
  'HKLM\\SOFTWARE\\WOW6432Node\\Eclipse Adoptium\\JRE',
  'HKLM\\SOFTWARE\\Microsoft\\JDK',
];

/* ---------------------------------------------------------------- 小工具 */

function execFileText(file, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs || 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '' });
      });
    } catch (err) {
      resolve({ err, stdout: '', stderr: '' });
    }
  });
}

/** 从 java 目录推断可执行文件（JDK 是 bin/java，老 JDK 还可能有 jre/bin/java）。 */
function resolveJavaExe(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const trimmed = dir.trim().replace(/^"|"$/g, '');
  if (!trimmed) return null;
  // 直接给的就是 java.exe
  if (/java(w)?\.exe$/i.test(trimmed) || /\/java$/.test(trimmed)) {
    return fs.existsSync(trimmed) ? trimmed : null;
  }
  const candidates = [
    path.join(trimmed, 'bin', JAVA_EXE),
    path.join(trimmed, 'jre', 'bin', JAVA_EXE),
    path.join(trimmed, 'Contents', 'Home', 'bin', JAVA_EXE), // macOS
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/** 解析 JDK 的 release 文件（比启动进程快几个数量级）。 */
function readReleaseFile(javaExe) {
  const home = path.dirname(path.dirname(javaExe));
  const file = path.join(home, 'release');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const get = (key) => {
    const m = new RegExp(`^${key}="?([^"\\r\\n]*)"?`, 'm').exec(text);
    return m ? m[1].trim() : null;
  };
  const version = get('JAVA_VERSION') || get('JAVA_RUNTIME_VERSION');
  if (!version) return null;
  const implementor = get('IMPLEMENTOR');
  const runtimeName = get('JAVA_RUNTIME_NAME') || '';
  const osArch = get('OS_ARCH');
  let isJre = true;
  try {
    isJre = !fs.existsSync(path.join(home, 'bin', IS_WINDOWS ? 'javac.exe' : 'javac'));
  } catch (_) {
    isJre = true;
  }
  return {
    version,
    vendor: implementor || (runtimeName ? runtimeName.split(' ')[0] : '未知') || '未知',
    arch: osArch ? rules.normalizeArch(osArch) : rules.normalizeArch(process.arch),
    isJre,
  };
}

/** 从版本串里取主版本号：'21.0.8' → 21，'1.8.0_402' → 8。 */
function majorOf(version) {
  if (!version) return 0;
  const text = String(version).trim();
  const m = /^(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return 0;
  const first = Number.parseInt(m[1], 10);
  if (first === 1 && m[2] !== undefined) return Number.parseInt(m[2], 10);
  return first;
}

/** 解析 `java -XshowSettings:properties -version` 的 stderr。 */
function parseShowSettings(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^([a-zA-Z0-9_.]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  // 老版本 java 不带 -XshowSettings 时退回经典输出：openjdk version "1.8.0_402"
  if (!out['java.version']) {
    const m = /version\s+"([^"]+)"/.exec(String(text || ''));
    if (m) out['java.version'] = m[1];
  }
  if (!out['java.vendor']) {
    const m = /(OpenJDK|Java\(TM\)|Java)\s+(?:Runtime Environment|HotSpot)/i.exec(String(text || ''));
    if (m) out['java.vendor'] = m[1];
  }
  return out;
}

/**
 * 探测一个 java 可执行文件。
 * @param {string} javaExePath 可以是 java.exe 路径，也可以是 JAVA_HOME 目录
 * @returns {Promise<object|null>} JavaInstall = {path,version,arch,vendor,major,isJre,source}
 */
async function probe(javaExePath) {
  const exe = resolveJavaExe(javaExePath);
  if (!exe) return null;

  let version = null;
  let vendor = '未知';
  let arch = rules.normalizeArch(process.arch);
  let isJre = true;

  const fromRelease = readReleaseFile(exe);
  if (fromRelease) {
    version = fromRelease.version;
    vendor = fromRelease.vendor;
    arch = fromRelease.arch;
    isJre = fromRelease.isJre;
  }

  // release 文件读不到（JRE 安装包常常没有）→ 真跑一次
  const { stdout, stderr } = await execFileText(exe, ['-XshowSettings:properties', '-version'], 15000);
  const props = parseShowSettings(`${stderr}\n${stdout}`);
  if (!version) version = props['java.version'] || null;
  if (props['java.vendor']) vendor = props['java.vendor'];
  if (props['os.arch']) arch = rules.normalizeArch(props['os.arch']);
  if (isJre) {
    const home = path.dirname(path.dirname(exe));
    isJre = !fs.existsSync(path.join(home, 'bin', IS_WINDOWS ? 'javac.exe' : 'javac'));
  }

  if (!version) return null;

  return {
    path: exe,
    version,
    arch,
    vendor: vendor || '未知',
    major: majorOf(version),
    isJre,
    source: 'auto',
  };
}

/** 枚举注册表里的 JavaHome / Path。 */
async function registryCandidateDirs() {
  if (!IS_WINDOWS) return [];
  const out = [];
  for (const root of REGISTRY_ROOTS) {
    // eslint-disable-next-line no-await-in-loop
    const { stdout } = await execFileText('reg', ['query', root, '/s'], 8000);
    if (!stdout) continue;
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      const m = /^(JavaHome|Path)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i.exec(line);
      if (m && m[2]) out.push(m[2].trim());
    }
  }
  return out;
}

/** 列出一个根目录下的所有一级子目录。 */
function listChildren(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => path.join(dir, d.name));
  } catch (_) {
    return [];
  }
}

/** 从 PATH 里找 java。 */
function pathCandidateDirs() {
  const raw = process.env.PATH || process.env.Path || '';
  const out = [];
  for (const part of raw.split(path.delimiter)) {
    const dir = part.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, JAVA_EXE))) out.push(dir);
    } catch (_) {
      /* ignore */
    }
  }
  return out;
}

/**
 * 扫描本机所有 Java。
 * @param {{extraDirs?:string[], home?:string}} [options]
 * @returns {Promise<Array<object>>} JavaInstall[]
 */
async function detect(options) {
  const opts = options || {};
  const candidates = [];

  // ① JAVA_HOME
  const javaHome = process.env.JAVA_HOME || process.env.JDK_HOME || '';
  if (javaHome) candidates.push(javaHome);

  // ② QCL 自带 / 用户手放的运行时目录：<home>/java/*、<home>/runtime/*
  if (opts.home) {
    for (const sub of ['java', 'runtime', 'jre']) {
      for (const child of listChildren(path.join(opts.home, sub))) candidates.push(child);
    }
  }

  // ③ 注册表
  for (const dir of await registryCandidateDirs()) candidates.push(dir);

  // ④ 常见安装目录
  if (IS_WINDOWS) {
    for (const root of WINDOWS_JAVA_ROOTS) {
      candidates.push(root);
      for (const child of listChildren(root)) candidates.push(child);
      for (const grand of listChildren(root)) {
        for (const child of listChildren(grand)) candidates.push(child);
      }
    }
  } else {
    for (const root of ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/opt/java']) {
      for (const child of listChildren(root)) candidates.push(child);
    }
  }

  // ⑤ PATH
  for (const dir of pathCandidateDirs()) candidates.push(dir);

  // ⑥ 调用方补充
  for (const dir of opts.extraDirs || []) candidates.push(dir);

  const seenExe = new Set();
  const results = [];
  const uniqDirs = Array.from(new Set(candidates.filter(Boolean).map((d) => String(d).trim()).filter(Boolean)));

  for (const dir of uniqDirs) {
    const exe = resolveJavaExe(dir);
    if (!exe) continue;
    let real = exe;
    try {
      real = fs.realpathSync.native ? fs.realpathSync.native(exe) : fs.realpathSync(exe);
    } catch (_) {
      real = exe;
    }
    const key = real.toLowerCase();
    if (seenExe.has(key)) continue;
    seenExe.add(key);
    // eslint-disable-next-line no-await-in-loop
    const info = await probe(exe);
    if (info) {
      info.path = exe;
      results.push(info);
    }
  }

  // 按主版本降序（新版本在前，界面默认选推荐版本更方便）
  results.sort((a, b) => (b.major || 0) - (a.major || 0) || String(a.path).localeCompare(String(b.path)));
  return results;
}

/* ------------------------------------------------------------------ 缓存 */

/**
 * ★★★ Java 检测结果缓存（2026-11-05 加）。
 *
 * 为什么要缓存：`detect()` 会扫注册表 + 一堆常见目录，并对每个候选跑一次
 * `java -version`（每个都起一个 JVM 进程）。实测 **5775 ms** ——
 * 而它被「点击启动游戏 → launch:precheck」直接调用，
 * 于是用户点完要等 5~6 秒才看到确认框（用户反馈「点完半天才响应」的真因）。
 *
 * 策略：
 *   · 结果缓存 5 分钟；
 *   · 用户手动添加/更换 Java 时 `invalidateCache()` 立刻失效；
 *   · 启动时后台预热一次，用户第一次点启动就是瞬时。
 */
const DETECT_TTL_MS = 5 * 60 * 1000;
let detectCache = null; // { at:number, list:JavaInstall[], key:string }
let detectInflight = null; // 并发去重：同时多次调用只跑一次

/** 让缓存失效（增减 Java、改设置后调用） */
function invalidateCache() {
  detectCache = null;
  detectInflight = null;
}

/**
 * 带缓存的 detect。
 * @param {object} [options] 与 detect 相同的参数；带 home 时会参与缓存键
 */
async function detectCached(options) {
  const opts = options || {};
  const key = String(opts.home || '');
  const now = Date.now();

  if (detectCache && detectCache.key === key && now - detectCache.at < DETECT_TTL_MS) {
    return detectCache.list.map((x) => ({ ...x }));
  }

  if (detectInflight && detectInflight.key === key) {
    return detectInflight.promise;
  }

  const promise = (async () => {
    const list = await detect(opts);
    detectCache = { at: Date.now(), list, key };
    detectInflight = null;
    return list.map((x) => ({ ...x }));
  })();

  detectInflight = { key, promise };
  try {
    return await promise;
  } catch (err) {
    detectInflight = null;
    throw err;
  }
}

/** 后台预热（启动时调一次，不阻塞界面） */
function warmUp(options) {
  detectCached(options).catch(() => {
    /* 预热失败忽略 */
  });
}

/** 收集 release 文件里的信息（不启动进程），供界面秒开用。 */
async function quickList(options) {
  const opts = options || {};
  const dirs = [];
  const javaHome = process.env.JAVA_HOME || '';
  if (javaHome) dirs.push(javaHome);
  if (opts.home) {
    for (const sub of ['java', 'runtime', 'jre']) {
      for (const child of listChildren(path.join(opts.home, sub))) dirs.push(child);
    }
  }
  if (IS_WINDOWS) {
    for (const root of WINDOWS_JAVA_ROOTS) {
      for (const child of listChildren(root)) dirs.push(child);
      for (const grand of listChildren(root)) {
        for (const child of listChildren(grand)) dirs.push(child);
      }
    }
  }
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const exe = resolveJavaExe(dir);
    if (!exe) continue;
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = readReleaseFile(exe);
    if (!rel) continue;
    out.push({
      path: exe,
      version: rel.version,
      arch: rel.arch,
      vendor: rel.vendor,
      major: majorOf(rel.version),
      isJre: rel.isJre,
      source: 'auto',
    });
  }
  out.sort((a, b) => (b.major || 0) - (a.major || 0));
  return out;
}

/** 解析版本号（1.20.4 / 26.3 / b1.7.3 / 24w14a ...）成 [主, 次, 修订]。 */
function parseMcVersion(mcVersion) {
  const text = String(mcVersion || '').trim();
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [
    Number.parseInt(m[1], 10),
    m[2] !== undefined ? Number.parseInt(m[2], 10) : 0,
    m[3] !== undefined ? Number.parseInt(m[3], 10) : 0,
  ];
}

/**
 * 按 MC 版本推荐 Java 主版本。
 * 规范：≤1.16 → 8；1.17~1.20.4 → 17；1.20.5~1.21.x → 21；26.x → 25。
 * 远古版本（pre-classic ~ RC 与所有 old_alpha/old_beta）→ 8。
 * @param {string} mcVersion
 * @returns {number}
 */
function recommendMajor(mcVersion) {
  const parsed = parseMcVersion(mcVersion);
  if (!parsed) return 8; // rd-132211 / c0.0.13a / b1.7.3 这类远古 id
  const [major, minor, patch] = parsed;
  if (major >= 26) return 25;
  if (major < 1 || (major === 1 && minor <= 16)) return 8;
  if (major === 1 && minor === 17) return 17;
  if (major === 1 && minor === 18) return 17;
  if (major === 1 && minor === 19) return 17;
  if (major === 1 && minor === 20) return patch >= 5 ? 21 : 17;
  return 21; // 1.21.x 及以上
}

/** 版本 JSON 里若自带 javaVersion.majorVersion，以它为准（照官方启动器）。 */
function recommendForResolved(resolved, mcVersion) {
  const fromJson = resolved && resolved.javaVersion && resolved.javaVersion.majorVersion;
  if (Number.isFinite(fromJson) && fromJson > 0) return fromJson;
  return recommendMajor(mcVersion || (resolved && resolved.id));
}

/** 从已探测列表里挑一个满足 major 的（优先同 major 里版本最低的，够用就好）。 */
function pickForMajor(list, major) {
  const candidates = (list || []).filter((j) => (j.major || 0) === major);
  if (!candidates.length) return null;
  const sorted = candidates.slice().sort((a, b) => String(a.version).localeCompare(String(b.version)));
  return sorted[0];
}

/** 从已探测列表里挑一个能跑的（>= 推荐版本里最小的那个）。 */
function pickBest(list, mcVersion) {
  const want = recommendMajor(mcVersion);
  const exact = pickForMajor(list, want);
  if (exact) return exact;
  const ok = (list || []).filter((j) => (j.major || 0) >= want).sort((a, b) => (a.major || 0) - (b.major || 0));
  if (ok.length) return ok[0];
  const any = (list || []).filter(Boolean).sort((a, b) => (b.major || 0) - (a.major || 0));
  return any.length ? any[0] : null;
}

/** 某个 Java 是否满足版本要求。 */
function satisfies(java, major) {
  return !!java && (java.major || 0) >= major;
}

module.exports = {
  IS_WINDOWS,
  WINDOWS_JAVA_ROOTS,
  REGISTRY_ROOTS,
  detect,
  detectCached,
  invalidateCache,
  warmUp,
  quickList,
  probe,
  recommendMajor,
  recommendForResolved,
  pickForMajor,
  pickBest,
  satisfies,
  majorOf,
  resolveJavaExe,
  readReleaseFile,
  parseShowSettings,
};
