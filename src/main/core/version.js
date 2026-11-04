'use strict';
/*
 * version.js —— 版本 JSON 解析与 inheritsFrom 继承链合并。
 *
 * 参照：
 *   vendor/MultiMC/launcher/minecraft/VersionFile.h            —— 版本文件字段
 *   vendor/MultiMC/launcher/minecraft/MojangVersionFormat.cpp  —— 官方格式读取
 *   vendor/MultiMC/launcher/minecraft/LaunchProfile.cpp        —— applyXxx 的「子覆盖父、合并而非整体替换」语义
 *
 * 合并语义（照 LaunchProfile::apply*）：
 *   · mainClass / minecraftArguments / assets / type 等标量：父为空才用父，子非空就覆盖；
 *   · libraries：父子**拼接**（不同名都保留），重名取版本更高者在 libraries.js 里做；
 *   · arguments.jvm / arguments.game：父子**拼接**（Forge / NeoForge 就是把补丁参数追加到原版参数之后）；
 *   · 子有 arguments 而父有 minecraftArguments 时两者都保留 —— 启动时老式字符串先铺开、新式数组再追加。
 */

const rules = require('./rules');

/** 官方早已从清单里删掉、但仍可通过固定地址取到的两个 legacy 资源索引。 */
const KNOWN_ASSET_INDEXES = Object.freeze({
  legacy: {
    id: 'legacy',
    sha1: '770572e819335b6c0a053f8378ad88eda189fc14',
    size: 134758,
    totalSize: 152783480,
    url: 'https://launchermeta.mojang.com/v1/packages/770572e819335b6c0a053f8378ad88eda189fc14/legacy.json',
  },
  'pre-1.6': {
    id: 'pre-1.6',
    sha1: '3d8e55480977e32acd9844e545177e69a52f594b',
    size: 74091,
    totalSize: 49505710,
    url: 'https://launchermeta.mojang.com/v1/packages/3d8e55480977e32acd9844e545177e69a52f594b/pre-1.6.json',
  },
});

/** 官方 minecraftArguments 字符串的分词：支持双引号，并把引号剥掉（spawn 不走 shell，引号会变字面量）。 */
function splitArgs(text) {
  const out = [];
  const src = String(text == null ? '' : text);
  let buf = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < src.length && (src[i + 1] === quote || src[i + 1] === '\\')) {
        buf += src[i + 1];
        i += 1;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (buf || has) {
        out.push(buf);
        buf = '';
        has = false;
      }
      continue;
    }
    buf += ch;
  }
  if (buf || has) out.push(buf);
  return out;
}

function asString(value) {
  return typeof value === 'string' && value ? value : null;
}

/** 把任意 version json 规范成内部结构（保留原始 libraries 对象以便后续按 rules 处理）。 */
function normalize(raw) {
  const json = raw && typeof raw === 'object' ? raw : {};
  const id = asString(json.id) || asString(json.minecraftVersion) || '';
  let argumentsObj = null;
  if (json.arguments && typeof json.arguments === 'object') {
    argumentsObj = {
      jvm: Array.isArray(json.arguments.jvm) ? json.arguments.jvm.slice() : [],
      game: Array.isArray(json.arguments.game) ? json.arguments.game.slice() : [],
    };
  }

  let assetIndex = null;
  if (json.assetIndex && typeof json.assetIndex === 'object' && asString(json.assetIndex.id)) {
    assetIndex = {
      id: json.assetIndex.id,
      url: asString(json.assetIndex.url),
      sha1: asString(json.assetIndex.sha1),
      size: Number.isFinite(json.assetIndex.size) ? json.assetIndex.size : null,
      totalSize: Number.isFinite(json.assetIndex.totalSize) ? json.assetIndex.totalSize : null,
    };
  }

  const downloads = {};
  if (json.downloads && typeof json.downloads === 'object') {
    for (const key of Object.keys(json.downloads)) {
      const info = json.downloads[key];
      if (info && typeof info === 'object') {
        downloads[key] = {
          url: asString(info.url),
          sha1: asString(info.sha1),
          size: Number.isFinite(info.size) ? info.size : null,
          path: asString(info.path),
        };
      }
    }
  }

  let logging = null;
  if (json.logging && typeof json.logging === 'object' && json.logging.client && typeof json.logging.client === 'object') {
    logging = {
      client: {
        argument: asString(json.logging.client.argument) || '-Dlog4j.configurationFile=${path}',
        file: {
          id: asString(json.logging.client.file && json.logging.client.file.id) || 'client-1.12.xml',
          url: asString(json.logging.client.file && json.logging.client.file.url),
          sha1: asString(json.logging.client.file && json.logging.client.file.sha1),
          size: json.logging.client.file && Number.isFinite(json.logging.client.file.size)
            ? json.logging.client.file.size
            : null,
        },
      },
    };
  }

  let javaVersion = null;
  if (json.javaVersion && typeof json.javaVersion === 'object') {
    javaVersion = {
      component: asString(json.javaVersion.component),
      majorVersion: Number.isFinite(json.javaVersion.majorVersion) ? json.javaVersion.majorVersion : null,
    };
  }

  return {
    id,
    inheritsFrom: asString(json.inheritsFrom),
    type: asString(json.type),
    mainClass: asString(json.mainClass),
    appletClass: asString(json.appletClass),
    minecraftArguments: asString(json.minecraftArguments),
    arguments: argumentsObj,
    assets: asString(json.assets),
    assetIndex,
    jar: asString(json.jar),
    libraries: Array.isArray(json.libraries) ? json.libraries.slice() : [],
    downloads,
    logging,
    javaVersion,
    releaseTime: asString(json.releaseTime) || asString(json.time),
    time: asString(json.time) || asString(json.releaseTime),
    minimumLauncherVersion: Number.isFinite(json.minimumLauncherVersion) ? json.minimumLauncherVersion : null,
    complianceLevel: Number.isFinite(json.complianceLevel) ? json.complianceLevel : null,
    // 远古归档版专用：客户端 jar 直接给地址（Betacraft 的 .info 里读出来的 url）
    archiveJarUrl: asString(json.archiveJarUrl),
    // 客户端 jar 归属哪个版本目录：继承链里「真正提供 downloads.client」的那一层
    clientJarId: downloads.client && id ? id : null,
    chain: id ? [id] : [],
    raw: json,
  };
}

/**
 * 子版本叠加到父版本之上。
 * @param {object} parent 已 normalize
 * @param {object} child 已 normalize
 */
function merge(parent, child) {
  const out = Object.assign({}, parent);

  out.id = child.id || parent.id;
  out.type = child.type || parent.type;
  out.mainClass = child.mainClass || parent.mainClass;
  out.appletClass = child.appletClass || parent.appletClass;
  out.jar = child.jar || parent.jar;
  out.assets = child.assets || parent.assets;
  out.assetIndex = child.assetIndex || parent.assetIndex;
  out.javaVersion = child.javaVersion || parent.javaVersion;
  out.releaseTime = child.releaseTime || parent.releaseTime;
  out.time = child.time || parent.time;
  out.minimumLauncherVersion = child.minimumLauncherVersion !== null
    ? child.minimumLauncherVersion
    : parent.minimumLauncherVersion;
  out.complianceLevel = child.complianceLevel !== null ? child.complianceLevel : parent.complianceLevel;
  out.archiveJarUrl = child.archiveJarUrl || parent.archiveJarUrl;
  out.inheritsFrom = null;

  // downloads：逐个 classifier 覆盖（客户端的 client.jar 通常只由父提供）
  const downloads = Object.assign({}, parent.downloads);
  for (const key of Object.keys(child.downloads)) downloads[key] = child.downloads[key];
  out.downloads = downloads;
  // 客户端 jar 落在哪个版本目录：子自己带 client 就算子自己的，否则沿用父的
  out.clientJarId = child.downloads && child.downloads.client
    ? (child.id || parent.clientJarId || null)
    : (parent.clientJarId || null);

  // logging：子的 client 覆盖父的
  out.logging = child.logging || parent.logging;

  // arguments：父子拼接（不是整体替换）
  const parentArgs = parent.arguments || { jvm: [], game: [] };
  if (child.arguments) {
    out.arguments = {
      jvm: parentArgs.jvm.concat(child.arguments.jvm || []),
      game: parentArgs.game.concat(child.arguments.game || []),
    };
  } else {
    out.arguments = parent.arguments
      ? { jvm: parentArgs.jvm.slice(), game: parentArgs.game.slice() }
      : null;
  }

  // minecraftArguments：子非空即覆盖；父子都有时子胜（老 Forge 就靠这一步换掉原版参数）
  out.minecraftArguments = child.minecraftArguments || parent.minecraftArguments || null;

  // libraries：拼接（重名取高版本在 libraries.js 里做，不是在这里丢）
  out.libraries = (parent.libraries || []).concat(child.libraries || []);

  out.chain = (parent.chain || []).concat(child.id ? [child.id] : []);
  out.raw = child.raw;
  return out;
}

/** 展开 arguments 数组里带 rules 的元素。 */
function expandArguments(list, ctx) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (!rules.matches(item.rules, ctx)) continue;
    const value = item.value;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

/**
 * 解析版本（含继承链合并）。
 * @param {object} rawJson 原始 version json
 * @param {{fetchJson?:Function, features?:object, maxDepth?:number}} [options]
 *        fetchJson(idOrUrl) -> Promise<rawVersionJson>
 * @returns {Promise<object>} 合并后的 resolved
 */
async function resolve(rawJson, options) {
  const opts = options || {};
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 12;

  const chain = [normalize(rawJson)];
  const seen = new Set();
  if (chain[0].id) seen.add(chain[0].id);

  let cursor = chain[0];
  let depth = 0;
  while (cursor && cursor.inheritsFrom) {
    depth += 1;
    if (depth > maxDepth) {
      throw new Error(`版本继承链过深（超过 ${maxDepth} 层），可能存在循环引用：${chain.map((v) => v.id).join(' -> ')}`);
    }
    const parentId = cursor.inheritsFrom;
    if (seen.has(parentId)) {
      throw new Error(`版本继承链出现循环：${Array.from(seen).join(' -> ')} -> ${parentId}`);
    }
    if (typeof opts.fetchJson !== 'function') {
      throw new Error(`版本 ${cursor.id} 声明继承自 ${parentId}，但没有提供获取父版本 JSON 的方法`);
    }
    const parentRaw = await opts.fetchJson(parentId);
    if (!parentRaw || typeof parentRaw !== 'object') {
      throw new Error(`获取父版本 ${parentId} 的 JSON 失败：返回内容不是对象`);
    }
    const parent = normalize(parentRaw);
    if (!parent.id) parent.id = parentId;
    seen.add(parent.id);
    chain.unshift(parent);
    cursor = parent;
  }

  let merged = chain[0];
  for (let i = 1; i < chain.length; i += 1) merged = merge(merged, chain[i]);

  merged.features = Object.assign({}, rules.DEFAULT_FEATURES, opts.features || {});
  merged.resolvedChain = chain.map((v) => v.id);
  // 继承链上每一层的原始 JSON，供安装时一并落盘（这样启动时不再依赖网络）
  merged.chainVersions = chain.map((v) => ({ id: v.id, raw: v.raw }));
  return merged;
}

/** 主类。 */
function mainClass(resolved) {
  return (resolved && resolved.mainClass) || '';
}

/**
 * 资源索引信息：优先 version json 里的 assetIndex，其次按 assets 字符串查内置的 legacy 索引。
 * @returns {{id:string,url:string|null,sha1:string|null,size:number|null,totalSize:number|null}|null}
 */
function assetIndex(resolved) {
  if (!resolved) return null;
  if (resolved.assetIndex && resolved.assetIndex.id) {
    const known = KNOWN_ASSET_INDEXES[resolved.assetIndex.id];
    return {
      id: resolved.assetIndex.id,
      url: resolved.assetIndex.url || (known && known.url) || null,
      sha1: resolved.assetIndex.sha1 || (known && known.sha1) || null,
      size: resolved.assetIndex.size != null ? resolved.assetIndex.size : (known ? known.size : null),
      totalSize: resolved.assetIndex.totalSize != null ? resolved.assetIndex.totalSize : (known ? known.totalSize : null),
    };
  }
  if (resolved.assets) {
    const known = KNOWN_ASSET_INDEXES[resolved.assets];
    return {
      id: resolved.assets,
      url: (known && known.url) || null,
      sha1: (known && known.sha1) || null,
      size: known ? known.size : null,
      totalSize: known ? known.totalSize : null,
    };
  }
  return null;
}

/**
 * 按 rules 过滤 + 同名取高版本后的库清单。
 * @param {object} resolved
 * @param {{osInfo?:object, source?:string}} [options]
 */
function libraryList(resolved, options) {
  // 循环依赖规避：libraries.js 依赖 rules/downloader，不依赖 version.js
  // eslint-disable-next-line global-require
  const libraries = require('./libraries');
  return libraries.resolveLibraries(resolved, options || {});
}

/**
 * 展开启动参数（占位符仍保留，由 launch.js 替换）。
 * @param {object} resolved
 * @param {{features?:object, osInfo?:object}} [options]
 * @returns {{jvm:string[], game:string[]}}
 */
function argumentList(resolved, options) {
  const opts = options || {};
  if (!resolved) return { jvm: [], game: [] };
  const features = Object.assign({}, rules.DEFAULT_FEATURES, resolved.features || {}, opts.features || {});
  const ctx = { features, os: opts.osInfo };

  const game = [];
  // 老式 minecraftArguments：先铺开（Forge 1.12 就是用字符串换掉原版参数）
  if (resolved.minecraftArguments) {
    for (const part of splitArgs(resolved.minecraftArguments)) game.push(part);
  }
  const jvm = [];
  if (resolved.arguments) {
    for (const v of expandArguments(resolved.arguments.jvm, ctx)) jvm.push(v);
    for (const v of expandArguments(resolved.arguments.game, ctx)) game.push(v);
  }
  // logging 的 -Dlog4j.configurationFile=${path} 在 1.12+ 是 version json 里没写的，
  // 官方启动器由 arguments.jvm 里已经带了，这里只兜底：没有就补上（由 launch.js 决定是否落 ${path}）
  return { jvm, game };
}

module.exports = {
  KNOWN_ASSET_INDEXES,
  splitArgs,
  normalize,
  merge,
  resolve,
  mainClass,
  assetIndex,
  libraryList,
  argumentList,
  expandArguments,
};
