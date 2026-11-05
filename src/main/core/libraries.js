'use strict';
/*
 * libraries.js —— Maven 坐标解析与库选择。
 *
 * 参照：
 *   vendor/MultiMC/launcher/minecraft/GradleSpecifier.h   —— 坐标解析 / getFileName / toPath
 *   vendor/MultiMC/launcher/minecraft/Library.cpp         —— isActive / storageSuffix / getApplicableFiles
 *   vendor/MultiMC/launcher/minecraft/LaunchProfile.cpp   —— applyLibrary（同名取版本更高者）
 *   vendor/MultiMC/launcher/Version.cpp                   —— 版本比较（Section 逐段比较）
 */

const path = require('node:path');

const rules = require('./rules');
const { rewriteUrl } = require('./downloader');

/** Mojang 默认库仓库（version json 里没写 url 时用它）。 */
const DEFAULT_LIBRARY_BASE = 'https://libraries.minecraft.net/';

/* ------------------------------------------------------- GradleSpecifier 移植 */

/**
 * 解析 Maven 坐标：group:artifact:version[:classifier][@extension]
 * 与 MultiMC GradleSpecifier.h 的正则一致：
 *   ([^:@]+):([^:@]+):([^:@]+)(?::([^:@]+))?(?:@([^:@]+))?
 */
function parseName(raw) {
  const value = String(raw == null ? '' : raw).trim();
  const m = /^([^:@]+):([^:@]+):([^:@]+)(?::([^:@]+))?(?:@([^:@]+))?$/.exec(value);
  if (!m) {
    return { valid: false, raw: value, group: '', artifact: '', version: '', classifier: '', extension: 'jar' };
  }
  return {
    valid: true,
    raw: value,
    group: m[1],
    artifact: m[2],
    version: m[3],
    classifier: m[4] || '',
    extension: m[5] || 'jar',
  };
}

/** 序列化回坐标字符串。 */
function serialize(spec) {
  if (!spec || !spec.valid) return (spec && spec.raw) || '';
  let out = `${spec.group}:${spec.artifact}:${spec.version}`;
  if (spec.classifier) out += `:${spec.classifier}`;
  if (spec.extension && spec.extension !== 'jar') out += `@${spec.extension}`;
  return out;
}

/** 文件名：artifact-version[-classifier].ext */
function fileName(spec) {
  if (!spec || !spec.valid) return '';
  let name = `${spec.artifact}-${spec.version}`;
  if (spec.classifier) name += `-${spec.classifier}`;
  return `${name}.${spec.extension || 'jar'}`;
}

/**
 * 相对 maven 路径：group（点换斜杠）/artifact/version/文件名
 * @param {string} name 坐标
 * @param {string} [ext] 覆盖扩展名
 * @param {string} [classifierOverride] 覆盖 classifier（natives 用）
 */
function mavenPath(name, ext, classifierOverride) {
  const spec = typeof name === 'string' ? parseName(name) : Object.assign({}, name);
  if (!spec.valid) {
    // 坐标非法时按 MultiMC toPath 的失败语义返回空串，调用方据此跳过
    return '';
  }
  if (ext) spec.extension = String(ext).replace(/^\./, '');
  if (classifierOverride !== undefined) spec.classifier = classifierOverride || '';
  const dir = spec.group.split('.').join('/');
  return `${dir}/${spec.artifact}/${spec.version}/${fileName(spec)}`;
}

/* -------------------------------------------------------------- 版本比较 */

/** 复刻 MultiMC Version::Section。 */
function section(text) {
  const full = String(text == null ? '' : text);
  let cutoff = full.length;
  for (let i = 0; i < full.length; i += 1) {
    if (!(full[i] >= '0' && full[i] <= '9')) {
      cutoff = i;
      break;
    }
  }
  const numValid = cutoff > 0;
  let num = 0;
  if (numValid) {
    // Qt 的 toInt 溢出会失败，这里做同样的钳制，避免 NaN 污染比较
    const parsed = Number.parseInt(full.slice(0, cutoff), 10);
    num = Number.isFinite(parsed) && parsed <= 2147483647 ? parsed : 0;
  }
  return { numValid, num, str: full.slice(cutoff), full };
}

function sectionCompare(a, b) {
  if (a.numValid && b.numValid) {
    if (a.num !== b.num) return a.num < b.num ? -1 : 1;
    if (a.str !== b.str) return a.str < b.str ? -1 : 1;
    return 0;
  }
  if (a.full === b.full) return 0;
  return a.full < b.full ? -1 : 1;
}

function toSections(version) {
  return String(version == null ? '' : version).split('.').map(section);
}

/** 比较两个版本串：a<b 返回 -1，相等 0，a>b 返回 1（等价 MultiMC Version 的运算符）。 */
function compareVersions(a, b) {
  const sa = toSections(a);
  const sb = toSections(b);
  const size = Math.max(sa.length, sb.length);
  const zero = section('0');
  for (let i = 0; i < size; i += 1) {
    const sec1 = i >= sa.length ? zero : sa[i];
    const sec2 = i >= sb.length ? zero : sb[i];
    const cmp = sectionCompare(sec1, sec2);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/* ----------------------------------------------------------- 库条目规范化 */

function archPlaceholderValue(osInfo) {
  const info = rules.currentOs(osInfo);
  const arch = rules.normalizeArch(info.arch);
  return arch === 'x86' || arch === 'arm32' ? '32' : '64';
}

function classifierFor(lib, osInfo) {
  const info = rules.currentOs(osInfo);
  const natives = lib && lib.natives;
  if (!natives || typeof natives !== 'object') return null;
  let classifier = natives[info.name];
  if (classifier === undefined && info.name === 'osx') classifier = natives.osx || natives.macos;
  if (typeof classifier !== 'string' || !classifier) return null;
  if (classifier.includes('${arch}')) {
    classifier = classifier.split('${arch}').join(archPlaceholderValue(osInfo));
  }
  return classifier;
}

function downloadInfo(lib, key) {
  const d = lib && lib.downloads;
  if (!d || typeof d !== 'object') return null;
  const info = d[key];
  if (!info || typeof info !== 'object' || !info.url) return null;
  return info;
}

function classifierDownload(lib, classifier) {
  const d = lib && lib.downloads;
  if (!d || !d.classifiers || typeof d.classifiers !== 'object') return null;
  const info = d.classifiers[classifier];
  if (!info || typeof info !== 'object' || !info.url) return null;
  return info;
}

/** 仓库地址拼接（MultiMC raw_dl 的等价实现）。 */
function joinRepo(repoUrl, relPath) {
  const base = repoUrl && String(repoUrl).trim() ? String(repoUrl).trim() : DEFAULT_LIBRARY_BASE;
  return base.endsWith('/') ? base + relPath : `${base}/${relPath}`;
}

/**
 * 展开一个原始 library 对象为「可直接下载/入 classpath」的条目。
 * @param {object} lib 原始 version json 里的 library 对象
 * @param {{osInfo?:object, source?:'official'|'bmclapi'}} [options]
 * @returns {object|null} null 表示该库在当前系统上不适用
 */
function describeLibrary(lib, options) {
  const opts = options || {};
  if (!lib || typeof lib !== 'object' || !lib.name) return null;
  if (!rules.matches(lib.rules, { os: opts.osInfo })) return null;

  const spec = parseName(lib.name);
  const classifier = classifierFor(lib, opts.osInfo);
  const isNative = classifier !== null;

  const artifactPath = isNative ? mavenPath(spec, 'jar', classifier) : mavenPath(spec, 'jar');
  if (!artifactPath) return null;

  const artifactInfo = !isNative ? downloadInfo(lib, 'artifact') : null;
  const nativeInfo = isNative ? classifierDownload(lib, classifier) : null;

  // 目录前缀：downloads.artifact.path 有时会给出权威相对路径（如 launchwrapper）
  const artifactRel = (artifactInfo && artifactInfo.path) || artifactPath;
  const nativeRel = (nativeInfo && nativeInfo.path) || artifactPath;

  const repoUrl = lib.url;
  const artifactUrl = artifactInfo && artifactInfo.url
    ? rewriteUrl(artifactInfo.url, opts.source)
    : rewriteUrl(joinRepo(repoUrl, artifactRel), opts.source);
  const nativeUrl = nativeInfo && nativeInfo.url
    ? rewriteUrl(nativeInfo.url, opts.source)
    : rewriteUrl(joinRepo(repoUrl, nativeRel), opts.source);

  const excludes = [];
  if (lib.extract && Array.isArray(lib.extract.exclude)) {
    for (const pattern of lib.extract.exclude) {
      if (typeof pattern === 'string' && pattern) excludes.push(pattern);
    }
  }

  return {
    raw: lib,
    name: lib.name,
    spec,
    key: `${spec.group}:${spec.artifact}:${spec.classifier || ''}`,
    version: spec.version,
    classifier: classifier || '',
    isNative,
    // 非 natives 库（进 classpath 的 jar）
    artifactPath: artifactRel,
    artifactUrl,
    artifactSha1: (artifactInfo && artifactInfo.sha1) || null,
    artifactSize: artifactInfo && Number.isFinite(artifactInfo.size) ? artifactInfo.size : null,
    /**
     * ★★★ 2026-11-05 修（用户：「你这三个模组加载器全是空壳」）。
     *
     * 以前是 `hasArtifact: !!artifactInfo` —— 只认 version json 里的 `downloads.artifact`。
     * 但 **Fabric / Quilt 的 profile 里每个库只有 `name` + `url`（maven 仓库地址），
     * 没有 `downloads.artifact`** ⇒ hasArtifact=false ⇒ 这些库**永远不会进 classpath**。
     *
     * 结果就是：Fabric 版本装出来了、jar 也下了，但启动时 classpath 里没有
     * fabric-loader / sponge-mixin / asm，主类 `…KnotClient` 直接 ClassNotFound ——
     * 玩家看到的就是「加载器是个空壳」。
     *
     * 现在只要不是 natives 且能拼出下载地址，就算「有 artifact」（照 HMCL / MultiMC 的做法：
     * 有 maven `url` 就按坐标拼路径，不需要 downloads 字段）。
     */
    hasArtifact: !isNative && !!artifactUrl,
    // natives 库（要解压的 jar）
    nativePath: nativeRel,
    nativeUrl,
    nativeSha1: (nativeInfo && nativeInfo.sha1) || null,
    nativeSize: nativeInfo && Number.isFinite(nativeInfo.size) ? nativeInfo.size : null,
    hasNative: !!nativeInfo,
    excludes,
    rules: lib.rules || null,
  };
}

/**
 * 按 rules 过滤 + 同名取版本更高者，得到最终生效的库清单。
 * @param {object} resolved version.resolve() 的结果
 * @param {{osInfo?:object, source?:'official'|'bmclapi'}} [options]
 */
function resolveLibraries(resolved, options) {
  const opts = options || {};
  const raw = (resolved && Array.isArray(resolved.libraries) && resolved.libraries) || [];
  const jars = new Map();
  const natives = new Map();

  for (const lib of raw) {
    const entry = describeLibrary(lib, opts);
    if (!entry) continue;
    const bucket = entry.isNative ? natives : jars;
    const existing = bucket.get(entry.key);
    if (!existing) {
      bucket.set(entry.key, entry);
      continue;
    }
    // 同名（group:artifact:classifier）取版本更高者 —— MultiMC LaunchProfile::applyLibrary
    if (entry.version && existing.version && compareVersions(entry.version, existing.version) > 0) {
      bucket.set(entry.key, entry);
    }
  }

  const list = [];
  for (const entry of jars.values()) list.push(entry);
  for (const entry of natives.values()) list.push(entry);
  return list;
}

/** 库是否在当前系统生效（给界面灰显用）。 */
function isLibraryActive(lib, osInfo) {
  return rules.matches(lib && lib.rules, { os: osInfo });
}

/* ---------------------------------------------------- 契约冻结的四个导出 */

/**
 * 下载地址：优先用 version json 里写死的 artifact url，其次仓库地址拼接。
 * @param {object|string} lib 原始 library 对象或坐标字符串
 * @param {'official'|'bmclapi'} [source]
 */
function artifactUrl(lib, source) {
  if (typeof lib === 'string') {
    return rewriteUrl(joinRepo('', mavenPath(lib, 'jar')), source);
  }
  if (!lib || typeof lib !== 'object') return '';
  const info = downloadInfo(lib, 'artifact');
  if (info && info.url) return rewriteUrl(info.url, source);
  const rel = mavenPath(lib.name, 'jar');
  if (!rel) return '';
  return rewriteUrl(joinRepo(lib.url, rel), source);
}

/**
 * classpath：只含真实存在（或按 includeMissing 指定）的 jar 绝对路径，主 jar 排在最后。
 * @param {object} resolved
 * @param {{librariesDir:string, osInfo?:object, source?:string, includeMissing?:boolean, gameDir?:string}} options
 */
function classpathList(resolved, options) {
  const opts = options || {};
  const librariesDir = opts.librariesDir;
  if (!librariesDir) return [];
  const fs = require('node:fs');

  const out = [];
  const entries = resolveLibraries(resolved, { osInfo: opts.osInfo, source: opts.source });
  for (const entry of entries) {
    if (entry.isNative) continue; // natives 不进 classpath（MultiMC getApplicableFiles 同此）
    // 有 downloads 却没有 artifact（例如只带 natives 分类器的库）→ 没有可上 classpath 的 jar
    if (entry.raw.downloads && !entry.hasArtifact) continue;
    const abs = path.resolve(librariesDir, entry.artifactPath.split('/').join(path.sep));
    if (opts.includeMissing || fs.existsSync(abs)) out.push(abs);
  }

  // 主 jar 最后加入 —— MultiMC LaunchProfile::getLibraryFiles 注释里明确要求
  const gameDir = opts.gameDir
    || path.dirname(path.resolve(librariesDir));
  // jar 字段（Forge 用 "jar":"1.12.2" 指向原版 jar）优先，其次是继承链里真正带 client 的那层
  const mainJarId = (resolved && (resolved.jar || resolved.clientJarId || resolved.id)) || null;
  if (mainJarId) {
    const abs = path.join(gameDir, 'versions', mainJarId, `${mainJarId}.jar`);
    if (opts.includeMissing || fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

/**
 * 待解压的 natives 清单。
 * @param {object} resolved
 * @param {{osInfo?:object, librariesDir?:string, source?:string}} [options]
 * @returns {Array<{name:string,path:string,absolutePath?:string,excludes:string[],sha1:string|null,size:number|null,url:string}>}
 */
function nativesList(resolved, options) {
  const opts = options || {};
  const out = [];
  const entries = resolveLibraries(resolved, { osInfo: opts.osInfo, source: opts.source });
  for (const entry of entries) {
    if (!entry.isNative) continue;
    const rel = entry.nativePath;
    if (!rel) continue;
    const item = {
      name: entry.spec.artifact + '-' + entry.spec.version + (entry.classifier ? '-' + entry.classifier : '') + '.jar',
      path: rel,
      excludes: entry.excludes.slice(),
      sha1: entry.nativeSha1,
      size: entry.nativeSize,
      url: entry.nativeUrl,
      mavenName: entry.name,
    };
    if (opts.librariesDir) {
      item.absolutePath = path.resolve(opts.librariesDir, rel.split('/').join(path.sep));
    }
    out.push(item);
  }
  return out;
}

module.exports = {
  DEFAULT_LIBRARY_BASE,
  // 契约冻结
  mavenPath,
  artifactUrl,
  classpathList,
  nativesList,
  // 扩展
  parseName,
  serialize,
  fileName,
  compareVersions,
  describeLibrary,
  resolveLibraries,
  isLibraryActive,
  classifierFor,
};
