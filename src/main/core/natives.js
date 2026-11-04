'use strict';
/*
 * natives.js —— 解压 natives。
 *
 * 参照 vendor/MultiMC/launcher/minecraft/launch/ExtractNatives.cpp：
 *   · 目标目录固定为实例的 <实例>/.minecraft/natives/；
 *   · 解压前把整个 natives 目录清空（MultiMC 在 finalize 里 removeRecursively）；
 *   · 排除 META-INF/（extract.exclude 里通常就写着它），并支持任意 exclude 通配；
 *   · Java 8+ 的 jnilib → dylib hack 只影响 macOS，Windows 下不涉及。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const zip = require('./zip');

/** 无条件排除：MultiMC 的 extract.exclude 里 META-INF/ 是标配，缺了也要排。 */
const ALWAYS_EXCLUDES = ['META-INF/'];

function escapeRegExpChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

const regexCache = new Map();
function cachedGlob(pattern) {
  let re = regexCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

/**
 * 条目名是否被排除。
 * 排除写法兼容三种：目录（`META-INF/`）、通配（`*.git`、`**\/x`）、精确名（`META-INF`）。
 */
function isExcluded(name, patterns) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return false;
  const list = ALWAYS_EXCLUDES.concat(patterns || []);
  for (const raw of list) {
    if (!raw) continue;
    const pattern = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!pattern) continue;
    if (pattern.endsWith('/')) {
      if (normalized === pattern.slice(0, -1) || normalized.startsWith(pattern)) return true;
      continue;
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      const re = cachedGlob(pattern);
      if (re.test(normalized)) return true;
      // 模式不含目录分隔符时也尝试匹配文件名（`*.txt` 这类写法）
      if (!pattern.includes('/')) {
        const base = normalized.slice(normalized.lastIndexOf('/') + 1);
        if (re.test(base)) return true;
      }
      continue;
    }
    if (normalized === pattern || normalized.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

/** 防止 zip 里的相对路径跳出目标目录。 */
function safeJoin(root, entryName) {
  const target = path.resolve(root, entryName.split('/').join(path.sep));
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  return target;
}

/**
 * 解压 natives 到实例 natives 目录。
 * @param {Array<{name?:string,path:string,absolutePath?:string,excludes?:string[]}>} nativesList
 * @param {{nativesDir:string, librariesDir:string}} options
 * @returns {Promise<{count:number, bytes:number, missing:string[]}>}
 */
async function extract(nativesList, options) {
  const opts = options || {};
  const nativesDir = opts.nativesDir;
  const librariesDir = opts.librariesDir;
  if (!nativesDir) throw new Error('解压 natives 失败：没有给出目标目录');
  if (!librariesDir) throw new Error('解压 natives 失败：没有给出 libraries 目录');

  // 先清空（照 MultiMC：旧文件留着会污染新版本）
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });

  const list = Array.isArray(nativesList) ? nativesList : [];
  let count = 0;
  let bytes = 0;
  const missing = [];

  for (const item of list) {
    if (!item) continue;
    const jarPath = item.absolutePath
      || path.resolve(librariesDir, String(item.path || '').split('/').join(path.sep));
    if (!fs.existsSync(jarPath)) {
      missing.push(jarPath);
      continue;
    }

    let archive;
    try {
      archive = zip.open(jarPath);
    } catch (err) {
      throw new Error(`解压 natives 失败：${path.basename(jarPath)} 不是可读的 ZIP 文件（${err && err.message ? err.message : err}）`);
    }

    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      if (isExcluded(entry.name, item.excludes)) continue;
      const target = safeJoin(nativesDir, entry.name);
      if (!target) continue; // 路径穿越，跳过
      let data;
      try {
        data = archive.readEntry(entry);
      } catch (err) {
        throw new Error(`解压 natives 失败：读取 ${path.basename(jarPath)} 中的 ${entry.name} 出错（${err && err.message ? err.message : err}）`);
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
      count += 1;
      bytes += data.length;
    }
  }

  return { count, bytes, missing };
}

module.exports = {
  ALWAYS_EXCLUDES,
  isExcluded,
  globToRegExp,
  extract,
};
