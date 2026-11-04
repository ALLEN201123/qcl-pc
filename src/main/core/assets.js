'use strict';
/*
 * assets.js —— 资源索引与资源对象。
 *
 * 参照 vendor/MultiMC/launcher/minecraft/AssetsUtils.cpp：
 *   · 索引文件 <assets>/indexes/<id>.json，形如 {"objects": {"名字": {"hash","size"}}}
 *   · 对象落盘 <assets>/objects/<hash 前 2 位>/<hash>
 *   · 下载地址 https://resources.download.minecraft.net/<前2位>/<hash>
 *   · index.virtual === true      → 把对象按资源名铺到 <assets>/virtual/<id>/
 *   · index.map_to_resources === true → 把对象按资源名铺到 <gameDir>/resources/
 *   · getAssetsDir()：virtual 时返回 virtual/<id>，map_to_resources 时返回 resources/，
 *     否则也返回 virtual/<id>（MultiMC 的等价实现），供 ${game_assets} 占位符使用。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const jsonstore = require('./jsonstore');
const downloader = require('./downloader');
const versionModule = require('./version');

const RESOURCE_BASE = 'https://resources.download.minecraft.net';
const MIRROR_BASE = 'https://bmclapi2.bangbang93.com';

/** <assets>/indexes */
function indexesDir(assetsDir) {
  return path.join(assetsDir, 'indexes');
}

/** <assets>/indexes/<id>.json */
function indexPath(assetsDir, id) {
  return path.join(indexesDir(assetsDir), `${id}.json`);
}

/** <assets>/objects/<前2位>/<hash> */
function objectPath(assetsDir, hash) {
  const h = String(hash || '');
  return path.join(assetsDir, 'objects', h.slice(0, 2), h);
}

/** 官方资源对象地址。 */
function objectUrl(hash) {
  const h = String(hash || '');
  return `${RESOURCE_BASE}/${h.slice(0, 2)}/${h}`;
}

/** 资源索引的候选下载地址（官方 + 镜像，逐个回退）。 */
function indexUrlCandidates(assetsDir, info, source) {
  const id = info && info.id;
  const out = [];
  if (info && info.url) out.push(info.url);
  if (info && info.sha1 && id) {
    out.push(`https://piston-meta.mojang.com/v1/packages/${info.sha1}/${id}.json`);
  }
  if (id) {
    if (source === 'bmclapi') {
      out.push(`${MIRROR_BASE}/indexes/${id}.json`);
      out.push(`${MIRROR_BASE}/assets/indexes/${id}.json`);
    }
    out.push(`${MIRROR_BASE}/indexes/${id}.json`);
  }
  // 去重
  return Array.from(new Set(out.filter(Boolean)));
}

/** 读取索引 JSON；不存在或损坏返回 null。 */
function loadIndex(assetsDir, id) {
  const file = indexPath(assetsDir, id);
  if (!fs.existsSync(file)) return null;
  const data = jsonstore.readJson(file, null);
  if (!data || typeof data !== 'object' || !data.objects || typeof data.objects !== 'object') return null;
  return data;
}

/** ${game_assets} 占位符该指向哪个目录（照 AssetsUtils::getAssetsDir）。 */
function getAssetsDir(assetsDir, id, index) {
  const data = index || loadIndex(assetsDir, id);
  if (data && data.virtual) return path.join(assetsDir, 'virtual', id);
  if (data && data.map_to_resources) {
    // resources/ 与 assets/ 同级（都在游戏目录下）
    return path.join(path.dirname(assetsDir), 'resources');
  }
  return path.join(assetsDir, 'virtual', id);
}

/** 目标目录存在且非空即视为已铺好。 */
function dirHasFiles(dir) {
  try {
    const list = fs.readdirSync(dir);
    return list.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * 把文件放到目标位置：优先硬链接（同卷、零拷贝、不重复占磁盘），失败退回复制。
 * QCL 的 meta 缓存与实例目录都在 <QCL_HOME> 下，正常情况同一卷。
 */
async function linkOrCopy(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.link(from, to);
    return 'link';
  } catch (_) {
    await fsp.copyFile(from, to);
    return 'copy';
  }
}

/**
 * legacy 资源挂载：把 objects 里的文件按「资源名」复制到目标目录。
 * @param {string} assetsDir
 * @param {string} id
 * @param {object} index
 * @param {{onLog?:Function, force?:boolean}} [options]
 * @returns {Promise<{target:string|null, copied:number, missing:number}>}
 */
/**
 * 判断「目标目录里有没有这个资源对象」。
 *
 * ★★★ 2026-11-05 修正（用户实测「远古版本没有游戏音效」的根因）。
 *
 * 以前这里用 `dirHasFiles(target)` —— **只要目录非空就认定已铺好**，然后整个跳过复制。
 * 但远古版本（alpha/beta）的游戏自己会在 `resources/` 里生成
 * `pack.mcmeta`、`READ_ME_I_AM_VERY_IMPORTANT` 以及一批**空的** sound/music 目录。
 * 于是：
 *   ① `dirHasFiles('resources/')` 因为看到 README 就返回 true；
 *   ② reconstruct 直接 `return { alreadyDone: true }`，**749 个资源对象一个都没复制**；
 *   ③ 玩家听到的就是「进游戏完全没声音」。
 * 实测数据：`resources/` 有 10 个顶层项但 **0 个 .ogg**；
 *          而 `assets/objects/` 里 749 个对象其实**全都在**（468 个文件，按 hash 去重）。
 *
 * ⇒ 现在照安卓版 `CheckLibTask` 的做法改成**逐文件判断**（`if (!target.isFile())`），
 *   只补真正缺的那个文件，既不会误跳过，也不会重复复制。
 */
function needsCopy(from, to) {
  try {
    const src = fs.statSync(from);
    if (!src.isFile() || src.size === 0) return false;
    const dst = fs.statSync(to);
    return !(dst.isFile() && dst.size === src.size);
  } catch {
    // 目标不存在（statSync 抛错）⇒ 需要复制
    return fs.existsSync(from);
  }
}

/**
 * 铺开 legacy 资源目录（照安卓版 CheckLibTask 1.2.5 的 reconstructAssets）。
 *
 * @param {string} assetsDir  <gameDir>/assets
 * @param {string} id         资源索引 id
 * @param {object} index      索引 JSON（含 objects / virtual / map_to_resources）
 * @param {{force?:boolean, onLog?:Function, gameDir?:string}} options
 * @returns {Promise<{targets:string[], copied:number, missing:number, alreadyDone:boolean}>}
 */
async function reconstruct(assetsDir, id, index, options) {
  const opts = options || {};

  /**
   * ★ 关键：**两个目标都要铺**，不是二选一。
   *
   * 以前写的是 `if (virtual) ... else if (map_to_resources) ...` —— 二选一。
   * 但索引完全可能**同时**带这两个标记，那样 `resources/` 永远拿不到文件 → 没声音。
   * 安卓版的行为是：virtual 一定铺；`needMapToResources()` 为真时**再**铺一份到 gameDir/resources。
   */
  const targets = [];
  if (index && index.virtual) {
    targets.push({ kind: 'virtual', dir: path.join(assetsDir, 'virtual', id) });
  }
  if (index && index.map_to_resources) {
    // resources/ 与 assets/ 同级（都在游戏目录下）
    targets.push({ kind: 'resources', dir: path.join(path.dirname(assetsDir), 'resources') });
  }

  if (!index || !targets.length) {
    return { targets: [], copied: 0, missing: 0, alreadyDone: false };
  }

  let copied = 0;
  let missing = 0;
  const names = Object.keys(index.objects || {});

  for (const t of targets) {
    for (const name of names) {
      const obj = index.objects[name] || {};
      const hash = obj.hash;
      if (!hash) continue;
      // 防目录穿越（照安卓版的 key.contains("..") 检查）
      if (!name || name.includes('..')) continue;

      const from = objectPath(assetsDir, hash);
      const to = path.join(t.dir, name.split('/').join(path.sep));

      if (!needsCopy(from, to)) {
        if (!fs.existsSync(from)) missing += 1;
        continue;
      }

      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        // legacy 资源量大（几百个），硬链接比复制快得多且不重复占盘
        await linkOrCopy(from, to);
        copied += 1;
      } catch (err) {
        missing += 1;
        if (typeof opts.onLog === 'function') {
          opts.onLog(`资源铺开失败：${name}（${err && err.message ? err.message : err}）`);
        }
      }
    }
  }

  if (typeof opts.onLog === 'function' && copied > 0) {
    opts.onLog(
      `已铺开 legacy 资源目录：${targets.map((t) => t.dir).join('、')}` +
        `（新复制 ${copied} 个文件${missing ? `，缺失 ${missing} 个` : ''}）`
    );
  }

  return {
    targets: targets.map((t) => t.dir),
    copied,
    missing,
    alreadyDone: copied === 0
  };
}

/**
 * 安装/校验一个版本用到的全部资源。
 * @param {object} resolved version.resolve() 的结果
 * @param {{assetsDir:string, source?:string, threads?:number, onProgress?:Function, onLog?:Function, signal?:AbortSignal, metaObjectsDir?:string, timeoutMs?:number}} options
 * @returns {Promise<{total:number,done:number,skipped:number,failed:Array}>}
 */
async function install(resolved, options) {
  const opts = options || {};
  const assetsDir = opts.assetsDir;
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!assetsDir) throw new Error('安装资源失败：没有给出 assets 目录');

  const info = versionModule.assetIndex(resolved);
  if (!info || !info.id) {
    log('该版本没有资源索引（远古版本常见），跳过资源下载');
    return { total: 0, done: 0, skipped: 0, failed: [] };
  }

  await fsp.mkdir(indexesDir(assetsDir), { recursive: true });
  await fsp.mkdir(path.join(assetsDir, 'objects'), { recursive: true });

  const dest = indexPath(assetsDir, info.id);
  let index = loadIndex(assetsDir, info.id);

  // 索引缺失或 sha1 不符 → 重新下载（多候选地址逐个回退）
  let indexOk = !!index;
  if (indexOk && info.sha1 && fs.existsSync(dest)) {
    const actual = await downloader.sha1OfFile(dest);
    if (!actual || actual.toLowerCase() !== String(info.sha1).toLowerCase()) indexOk = false;
  }
  if (!indexOk) {
    const candidates = indexUrlCandidates(assetsDir, info, opts.source);
    const result = await downloader.downloadAll(
      [{
        url: candidates[0],
        fallbackUrls: candidates.slice(1),
        dest,
        sha1: info.sha1 || undefined,
        size: info.size || undefined,
        name: `assets/indexes/${info.id}.json`,
      }],
      {
        threads: 1,
        source: opts.source,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onProgress: opts.onProgress,
      },
    );
    if (result.failed.length) {
      throw new Error(`下载资源索引 ${info.id}.json 失败：${result.failed[0].error}`);
    }
    index = loadIndex(assetsDir, info.id);
  }

  if (!index) {
    throw new Error(`资源索引 ${info.id}.json 无法解析，资源安装中止`);
  }

  const names = Object.keys(index.objects || {});
  log(`资源索引 ${info.id}：共 ${names.length} 个资源对象`);

  // 铺对象到 objects/<前2位>/<hash>
  // 共享缓存（<home>/meta/assets/objects）与实例目录在同一卷上，用硬链接互通：
  // 第一个实例下载、后面的实例几乎瞬间完成，且不重复占磁盘。
  const sharedRoot = opts.metaObjectsDir || null;
  let linked = 0;
  const tasks = [];
  const seen = new Set();
  for (const name of names) {
    const obj = index.objects[name] || {};
    const hash = obj.hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);

    const target = objectPath(assetsDir, hash);
    if (fs.existsSync(target)) continue; // 已经有（含上一轮硬链接过来的）

    if (sharedRoot) {
      const shared = objectPath(sharedRoot, hash);
      if (fs.existsSync(shared)) {
        try {
          await linkOrCopy(shared, target);
          linked += 1;
          continue;
        } catch (_) {
          /* 链接失败就走下载 */
        }
      }
    }
    tasks.push({
      url: objectUrl(hash),
      dest: sharedRoot ? objectPath(sharedRoot, hash) : target,
      sha1: hash,
      size: Number.isFinite(obj.size) ? obj.size : undefined,
      name: `assets/objects/${hash.slice(0, 2)}/${hash}`,
      // 下载完成后要落到实例目录的目标（共享缓存模式下与 dest 不同）
      instanceDest: target,
    });
  }

  const result = await downloader.downloadAll(tasks, {
    threads: opts.threads,
    source: opts.source,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });

  if (result.failed.length) {
    throw new Error(`有 ${result.failed.length} 个资源文件下载失败，例如：${result.failed[0].error}`);
  }

  // 下载到共享缓存的对象，链接进实例目录
  for (const task of tasks) {
    if (!task.instanceDest) continue;
    if (fs.existsSync(task.instanceDest)) continue;
    if (!fs.existsSync(task.dest)) continue;
    try {
      await linkOrCopy(task.dest, task.instanceDest);
      linked += 1;
    } catch (err) {
      throw new Error(`复制资源对象到实例目录失败（${path.basename(task.dest)}）：${err && err.message ? err.message : err}`);
    }
  }

  // legacy 挂载（virtual / map_to_resources）
  if (index.virtual || index.map_to_resources) {
    await reconstruct(assetsDir, info.id, index, { onLog: log });
  }

  return {
    total: tasks.length,
    done: result.done,
    skipped: result.skipped,
    linked,
    objectsTotal: names.length,
    failed: result.failed,
    assetsIndex: info.id,
    gameAssetsDir: getAssetsDir(assetsDir, info.id, index),
  };
}

module.exports = {
  RESOURCE_BASE,
  indexesDir,
  indexPath,
  objectPath,
  objectUrl,
  indexUrlCandidates,
  loadIndex,
  getAssetsDir,
  reconstruct,
  linkOrCopy,
  install,
};
