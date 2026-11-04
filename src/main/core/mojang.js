'use strict';
/*
 * mojang.js —— 官方版本清单与远古版本清单。
 *
 * 官方清单：https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
 *
 * 远古版本清单 = 三份数据合并去重（Lead 指定）：
 *   ① 官方 manifest 里 type 为 old_alpha / old_beta 的条目（有官方版本 JSON，最可靠）
 *   ② core/data/legacy_version_archive.json —— QCL 安卓版自带的 Betacraft 归档快照（258 条）
 *      url 是 .info（纯文本元数据，里面 url: 那行就是真正的客户端 jar）
 *   ③ core/data/unlisted_versions.json —— 官方清单没有、但 piston-meta / zkitefly 上有 JSON 的版本（41 条）
 *
 * 类型判定（照安卓版 LegacyVersionArchive.java，两处细节不要改）：
 *   · 周快照：id 前两位是数字 + 下标 2 是 'w' + 下标 3 是数字 ⇒ type='snapshot'
 *     （命中 11w47a / 12w05a；不误伤 a1.0.14 / b1.8 / rd-132211 / c0.0.13a / in-20100223）
 *   · 其余归档条目 ⇒ type='ancient'
 *   · 走不走归档安装流程看**地址结尾**（.info ⇒ 归档；.json ⇒ 正常），不看 type
 */

const fs = require('node:fs');
const path = require('node:path');

const http = require('./http');
const jsonstore = require('./jsonstore');
const downloader = require('./downloader');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const DATA_DIR = path.join(__dirname, 'data');

// eslint-disable-next-line global-require
const LEGACY_ARCHIVE = require(path.join(DATA_DIR, 'legacy_version_archive.json'));
// eslint-disable-next-line global-require
const UNLISTED = require(path.join(DATA_DIR, 'unlisted_versions.json'));

/** 清单缓存超过这个时长才重新联网（同一次会话里连续点主页不必反复拉）。 */
const DEFAULT_MANIFEST_MAX_AGE_MS = 10 * 60 * 1000;

function dataDir() {
  return DATA_DIR;
}

/** 官方清单地址（bmclapi 同路径镜像，downloadWithRetry 会改写）。 */
function manifestUrl(source) {
  if (source === 'bmclapi') return downloader.rewriteUrl(MANIFEST_URL, 'bmclapi');
  return MANIFEST_URL;
}

/** 版本 JSON 的候选地址。 */
function versionJsonUrls(id, url, source) {
  const out = [];
  if (url) out.push(url);
  if (id) {
    // piston-meta 的镜像路径与官方路径不同，所以显式补一条
    out.push(`https://bmclapi2.bangbang93.com/version/${encodeURIComponent(id)}/json`);
  }
  if (source !== 'bmclapi' && !url && id) {
    out.push(MANIFEST_URL);
  }
  return Array.from(new Set(out.filter(Boolean)));
}

function toIso(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function timeValue(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * 归档清单里有 1 条（b1.2_02-dev-20110517）三个时间字段都是 0 ——
 * 从 id 结尾的 8 位日期把它猜回来，免得在时间轴上排到 1970 年。
 */
function dateFromId(id) {
  const m = /(\d{4})(\d{2})(\d{2})$/.exec(String(id || ''));
  if (!m) return 0;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2009 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return 0;
  return Date.UTC(year, month - 1, day);
}

/** 周快照判定（照 LegacyVersionArchive.isWeeklySnapshot，下标固定）。 */
function isWeeklySnapshot(id) {
  const text = String(id || '');
  if (text.length < 4) return false;
  const c0 = text.charCodeAt(0);
  const c1 = text.charCodeAt(1);
  const c2 = text.charCodeAt(2);
  const c3 = text.charCodeAt(3);
  return c0 >= 48 && c0 <= 57 && c1 >= 48 && c1 <= 57 && c2 === 119 /* w */ && c3 >= 48 && c3 <= 57;
}

/** 是否走 Betacraft 归档安装流程：只看地址，不看 type。 */
function isArchiveBuild(entry) {
  if (!entry) return false;
  if (entry.type === 'archive') return true;
  const url = String(entry.url || '');
  return url.endsWith('.info');
}

function normalizeManifestVersion(entry) {
  if (!entry || !entry.id) return null;
  return {
    id: entry.id,
    type: entry.type || 'release',
    url: entry.url || null,
    releaseTime: toIso(entry.releaseTime) || toIso(entry.time),
    time: toIso(entry.time) || toIso(entry.releaseTime),
    sha1: entry.sha1 || null,
    complianceLevel: Number.isFinite(entry.complianceLevel) ? entry.complianceLevel : undefined,
    source: 'mojang',
  };
}

/**
 * 拉官方版本清单（带缓存与回退）。
 * @param {{cacheDir?:string, source?:'official'|'bmclapi', timeoutMs?:number, maxAgeMs?:number, force?:boolean, signal?:AbortSignal}} [options]
 * @returns {Promise<{latest:{release:string,snapshot:string}, versions:Array, cached:boolean, fetchedAt:number}>}
 */
async function manifest(options) {
  const opts = options || {};
  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, 'version_manifest_v2.json') : null;

  const readCache = () => {
    if (!cacheFile) return null;
    const data = jsonstore.readJson(cacheFile, null);
    if (!data || !Array.isArray(data.versions) || !data.versions.length) return null;
    return data;
  };

  // 新鲜缓存直接命中（避免界面每点一次主页都联网）
  const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MANIFEST_MAX_AGE_MS;
  if (!opts.force && cacheFile && maxAge > 0) {
    try {
      const stat = fs.statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < maxAge) {
        const cached = readCache();
        if (cached) return { ...shapeManifest(cached), cached: true, fetchedAt: stat.mtimeMs };
      }
    } catch (_) {
      /* 没有缓存就继续联网 */
    }
  }

  try {
    const data = await http.fetchJson(manifestUrl(opts.source), {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    if (!data || !Array.isArray(data.versions)) {
      throw new http.LauncherError('版本清单格式不正确：缺少 versions 数组');
    }
    if (cacheFile) {
      try {
        jsonstore.writeJson(cacheFile, data);
      } catch (_) {
        /* 缓存写失败不影响本次使用 */
      }
    }
    return { ...shapeManifest(data), cached: false, fetchedAt: Date.now() };
  } catch (err) {
    const cached = readCache();
    if (cached) {
      return { ...shapeManifest(cached), cached: true, fetchedAt: 0, warning: err && err.message };
    }
    throw err instanceof http.LauncherError ? err : new http.LauncherError(http.describeError(err, '获取版本清单'));
  }
}

function shapeManifest(data) {
  const versions = (data.versions || []).map(normalizeManifestVersion).filter(Boolean);
  versions.sort((a, b) => timeValue(b.releaseTime) - timeValue(a.releaseTime));
  return {
    latest: {
      release: (data.latest && data.latest.release) || '',
      snapshot: (data.latest && data.latest.snapshot) || '',
    },
    versions,
  };
}

/**
 * 取单个版本的原始 JSON（不合并继承链，合并交给 version.resolve）。
 * @param {{id:string, url?:string, cacheDir?:string, source?:string, timeoutMs?:number, force?:boolean, sha1?:string, signal?:AbortSignal}} options
 */
async function versionJson(options) {
  const opts = options || {};
  const id = opts.id;
  if (!id) throw new http.LauncherError('获取版本 JSON 失败：没有给出版本号');

  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, 'versions', `${id}.json`) : null;

  if (cacheFile && !opts.force) {
    const cached = jsonstore.readJson(cacheFile, null);
    if (cached && typeof cached === 'object' && cached.id) {
      if (!opts.sha1) return cached;
      const actual = await downloader.sha1OfFile(cacheFile);
      if (actual && actual.toLowerCase() === String(opts.sha1).toLowerCase()) return cached;
    }
  }

  let url = opts.url;
  if (!url) {
    const cachedManifest = opts.cacheDir ? jsonstore.readJson(path.join(opts.cacheDir, 'version_manifest_v2.json'), null) : null;
    if (cachedManifest && Array.isArray(cachedManifest.versions)) {
      const hit = cachedManifest.versions.find((v) => v && v.id === id);
      if (hit && hit.url) url = hit.url;
    }
  }
  if (!url) {
    // 归档版本（.info）与远古版本没有官方 JSON，这是正常情况，由 install.js 兜底生成
    const err = new http.LauncherError(`版本清单里找不到 ${id} 的下载地址（该版本可能属于归档版本）`, { code: 'E_NO_VERSION_URL' });
    err.versionId = id;
    throw err;
  }

  const urls = versionJsonUrls(id, url, opts.source);
  const task = {
    url: urls[0],
    fallbackUrls: urls.slice(1),
    dest: cacheFile || path.join(require('node:os').tmpdir(), `qcl-version-${id}.json`),
    sha1: opts.sha1 || undefined,
    name: `versions/${id}/${id}.json`,
  };
  const result = await downloader.downloadAll([task], {
    threads: 1,
    source: opts.source,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (result.failed.length) {
    throw new http.LauncherError(`下载版本 ${id} 的 JSON 失败：${result.failed[0].error}`, { code: 'E_VERSION_JSON' });
  }
  const data = jsonstore.readJson(task.dest, null);
  if (!data || typeof data !== 'object') {
    throw new http.LauncherError(`版本 ${id} 的 JSON 内容无法解析`);
  }
  if (!data.id) data.id = id;
  return data;
}

/** 内置归档清单（Betacraft 快照）转成 VersionEntry。 */
function builtinArchiveEntries() {
  const out = [];
  for (const entry of (LEGACY_ARCHIVE && LEGACY_ARCHIVE.entries) || []) {
    if (!entry || !entry.id) continue;
    const stamp = entry.sortTime || entry.compileTime || entry.releaseTime || dateFromId(entry.id);
    const type = isWeeklySnapshot(entry.id) ? 'snapshot' : 'ancient';
    out.push({
      id: entry.id,
      type,
      url: entry.infoUrl || null,
      releaseTime: toIso(stamp),
      time: toIso(stamp),
      sha1: null,
      category: entry.category || null,
      officialId: !!entry.officialId,
      otherName: entry.otherName || null,
      source: 'betacraft',
      archive: true,
      _t: timeValue(stamp),
    });
  }
  return out;
}

/** 未收录版本（官方清单没有、piston-meta / zkitefly 有 JSON）转成 VersionEntry。 */
function builtinUnlistedEntries() {
  const out = [];
  for (const entry of (UNLISTED && UNLISTED.entries) || []) {
    if (!entry || !entry.id) continue;
    const url = entry.url || null;
    const archive = !!url && url.endsWith('.info');
    let type = entry.type || 'snapshot';
    if (isWeeklySnapshot(entry.id) || archive) type = isWeeklySnapshot(entry.id) ? 'snapshot' : 'ancient';
    else if (type !== 'release' && type !== 'snapshot' && type !== 'old_alpha' && type !== 'old_beta') {
      // 'pending' / 'unobfuscated' 这类官方枚举里没有的值，界面上归到快照更合理
      type = 'snapshot';
    }
    if (type === 'ancient') type = 'ancient';
    out.push({
      id: entry.id,
      type,
      url,
      releaseTime: toIso(entry.releaseTime) || toIso(entry.time),
      time: toIso(entry.time) || toIso(entry.releaseTime),
      sha1: null,
      category: entry.category || null,
      officialId: !!entry.officialId,
      otherName: entry.otherName || null,
      rawType: entry.type || null,
      source: 'unlisted',
      archive,
      _t: timeValue(entry.releaseTime || entry.time),
    });
  }
  return out;
}

/**
 * 远古版本总清单：官方 old_alpha/old_beta + Betacraft 归档 + 未收录版本，去重后按时间排序。
 * @param {{cacheDir?:string, source?:string, timeoutMs?:number, order?:'asc'|'desc', signal?:AbortSignal}} [options]
 * @returns {Promise<Array>} VersionEntry[]（额外带 category / officialId / archive / source）
 */
async function ancientList(options) {
  const opts = options || {};
  /**
   * ★ 默认排序改为「新 → 旧」（desc）。
   *
   * 之前默认 asc（最老的 pc-132011 排最前），用户打开「远古版本」看到的是
   * 一堆名字陌生的 pre-classic，得一直往下翻才能找到 b1.7.3 / a1.2.6 这些常玩的。
   * Minecraft 启动器（HMCL / PCL）的惯例都是「新版本在上」，这里对齐。
   * 仍然支持传 order:'asc' 拿升序。
   */
  const order = opts.order === 'asc' ? 'asc' : 'desc';

  let official = [];
  try {
    const m = await manifest({ cacheDir: opts.cacheDir, source: opts.source, timeoutMs: opts.timeoutMs, signal: opts.signal });
    official = m.versions
      .filter((v) => v.type === 'old_alpha' || v.type === 'old_beta')
      .map((v) => ({
        id: v.id,
        type: v.type,
        url: v.url,
        releaseTime: v.releaseTime,
        time: v.time,
        sha1: v.sha1 || null,
        category: v.type === 'old_beta' ? 'official/beta' : 'official/alpha',
        officialId: true,
        source: 'mojang',
        archive: false,
        _t: timeValue(v.releaseTime),
      }));
    // 官方清单里没有任何远古条目时（离线且无缓存）不要写坏缓存
    if (opts.cacheDir && official.length) {
      try {
        jsonstore.writeJson(path.join(opts.cacheDir, 'ancient_official.json'), official.map((o) => ({ ...o, _t: undefined })));
      } catch (_) {
        /* ignore */
      }
    }
  } catch (err) {
    // 离线：退回上次缓存的官方远古条目，仍然要把内置清单给界面
    official = [];
    if (opts.cacheDir) {
      const cached = jsonstore.readJson(path.join(opts.cacheDir, 'ancient_official.json'), []);
      if (Array.isArray(cached)) {
        official = cached.map((o) => ({ ...o, _t: timeValue(o.releaseTime) }));
      }
    }
  }

  const merged = new Map();
  // 优先级：官方 manifest > 未收录 > Betacraft 归档
  const push = (list) => {
    for (const item of list) {
      if (!item || !item.id) continue;
      // ★★ 只收「远古版本」：把现代版本的快照挡在外面。
      //   未收录清单（unlisted_versions.json）里混了一批 `1.21.11_unobfuscated` /
      //   `25w46a_unobfuscated` 这类**现代未混淆快照** —— 它们不是远古版本，
      //   出现在「远古版本」标签下会让列表又长又乱（用户实测：「下面还有一堆正式版的快照跑进来了」）。
      if (!isAncientId(item.id)) continue;

      const existing = merged.get(item.id);
      if (!existing) {
        merged.set(item.id, item);
        continue;
      }
      // 官方条目已经存在（type 更权威、url 是 piston-meta）→ 保留官方，但补上分类信息
      if (existing.source === 'mojang') {
        if (!existing.category && item.category) existing.category = item.category;
        if (existing.officialId === undefined) existing.officialId = item.officialId;
        continue;
      }
      if (item.source === 'mojang') {
        merged.set(item.id, item);
        continue;
      }
      // 同为非官方：有 url 的优先
      if (!existing.url && item.url) merged.set(item.id, item);
    }
  };
  push(official);
  push(builtinUnlistedEntries());
  push(builtinArchiveEntries());

  const list = Array.from(merged.values());
  list.sort((a, b) => {
    const ta = a._t || timeValue(a.releaseTime);
    const tb = b._t || timeValue(b.releaseTime);
    if (ta !== tb) return order === 'asc' ? ta - tb : tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });

  return list.map((item) => {
    const { _t, ...rest } = item;
    return rest;
  });
}

/**
 * 这个 id 是不是**远古版本**（pre-classic → 1.0 RC/正式）。
 *
 * 远古版本的 id 形态（照安卓版 LegacyVersionArchive + WikiPageTable 的判定）：
 *   · rd-*     RubyDung 时代（pre-classic 最早）
 *   · pc-*     pre-classic
 *   · c0.*     classic
 *   · in-*     indev
 *   · inf-*    infdev
 *   · a1.*     alpha
 *   · b1.*     beta
 *   · 1.0*     正式版起点**及其所有 RC**（1.0 / 1.0.0 / 1.0.0-rc1 / 1.0.0-rc2-1633 …）
 *
 * ★★ 2026-11-05 修正（用户反馈「远古版本为什么没有 1.0 RC1 和 RC2」）：
 *   以前这里写的是 `/^1\.0(\.0)?$/` —— 只精确匹配 "1.0" 和 "1.0.0"，
 *   而 `legacy_version_archive.json` 里的 `1.0.0-rc1` / `1.0.0-rc2-1633` 这些
 *   **带后缀的 RC 版本全被判成「不是远古」而被过滤掉**，用户在远古列表里根本看不到它们。
 *   ⇒ 改为 `/^1\.0(?!\d)/`：凡是 `1.0` 开头的都算（`1.0` / `1.0.0` / `1.0.0-rc1` …），
 *     但 `1.01` 这种紧接数字的不算，避免误伤。
 *
 * 明确排除：
 *   · `*_unobfuscated` —— 现代未混淆快照（1.21.11_unobfuscated / 25w46a_unobfuscated）
 *   · `1.1` 及以上      —— 正式版
 *   · `NNwNNa` 周快照   —— 现代快照
 */
function isAncientId(id) {
  const s = String(id || '').trim();
  if (!s) return false;
  const low = s.toLowerCase();

  // 现代未混淆快照一律排除
  if (low.includes('_unobfuscated')) return false;

  // 现代周快照：11w47a / 25w46a（前两位数字 + w + 数字）
  if (/^\d{2}w\d{2}/i.test(s)) return false;

  // 纯数字开头的（1.20.1 / 26.3）：只有 1.0 系列算远古
  if (/^\d+\.\d+/.test(s)) {
    // 1.0 / 1.0.0 / 1.0.0-rc1 / 1.0.0-rc2-1633 都算；1.1+ 不算
    return /^1\.0(?!\d)/i.test(s);
  }

  // 远古前缀
  return (
    low.startsWith('rd-') ||
    low.startsWith('pc-') ||
    low.startsWith('c0.') ||
    low.startsWith('in-') ||
    low.startsWith('inf-') ||
    low.startsWith('infdev') ||
    /^a\d/.test(low) ||
    /^b\d/.test(low)
  );
}

/* ------------------------------------------------------------- 愚人节版本清单 */

/**
 * ★★★ 愚人节版本白名单（12 个 = 官方 manifest 9 个 + 内置归档 3 个）。
 *
 * 为什么不能自动识别：官方 manifest 把愚人节版本也标成 `type: "snapshot"`，
 * 和普通快照混在一起；按「4 月 1 日发布」去筛又会误伤正常快照
 * （例如 20w14a 也是 4 月 1~2 日发的，但它是正常快照）。
 * ⇒ 只能按 **id 精确匹配**白名单。
 *
 * ★ 注意 id 的写法很坑：
 *   · `3D Shareware v1.34` —— 里面有空格和点，不是 3d-shareware；
 *   · `1.RV-Pre1` —— 大小写敏感（RV 大写、Pre1）；
 *   · 这两个都不是常见的 `15w14a` 形态，写错了就查不到。
 *
 * ★★★ 2013 年的 Minecraft 2.0（红/蓝/紫三色版）**官方 manifest 里没有** ——
 *   只存在于内置归档 `core/data/legacy_version_archive.json`（category: 'april-fools'）。
 *   所以这 3 个走 source:'archive' 分支，从归档里捞，不能去 manifest 找。
 *
 * manifest 会变（远古版本还在陆续补），命中不了的 id 直接跳过、不报错。
 * 实测（2026-11-05，manifest 共 922 条 + 归档 258 条）：12 个 id 全部命中。
 */
const APRIL_FOOLS = [
  // ── 官方 manifest 里能精确命中的 9 个 ──
  { id: '15w14a', foolTitle: '2015 愚人节：爱的抱抱（Love and Hugs Update）', source: 'manifest' },
  { id: '1.RV-Pre1', foolTitle: '2016 愚人节：时尚更新（Trendy Update）', source: 'manifest' },
  { id: '3D Shareware v1.34', foolTitle: '2019 愚人节：电子游戏（3D Shareware）', source: 'manifest' },
  { id: '20w14infinite', foolTitle: '2020 愚人节：无限维度（Infinite Dimensions）', source: 'manifest' },
  { id: '22w13oneblockatatime', foolTitle: '2022 愚人节：一次一个方块（One Block at a Time）', source: 'manifest' },
  { id: '23w13a_or_b', foolTitle: '2023 愚人节：投票更新（Vote Update）', source: 'manifest' },
  { id: '24w14potato', foolTitle: '2024 愚人节：毒马铃薯（Poisonous Potato Update）', source: 'manifest' },
  { id: '25w14craftmine', foolTitle: '2025 愚人节：Craftmine（挖矿宇宙）', source: 'manifest' },
  { id: '26w14a', foolTitle: '2026 愚人节：牧群更新（HerdCraft Update）', source: 'manifest' },
  // ── 官方 manifest 没有、只在归档里的 2013 Minecraft 2.0 三色版 ──
  { id: '2.0_red', foolTitle: '2013 愚人节：Minecraft 2.0（红色版）', source: 'archive' },
  { id: '2.0_blue', foolTitle: '2013 愚人节：Minecraft 2.0（蓝色版）', source: 'archive' },
  { id: '2.0_purple', foolTitle: '2013 愚人节：Minecraft 2.0（紫色版）', source: 'archive' },
];

/**
 * 取愚人节版本列表（12 个）。
 *
 * 来源两类，**归一化成同一结构**，用 source 区分：
 *   · source:'manifest' —— 官方版本清单里的 9 个（url 是 piston-meta 的版本 JSON，带 sha1）
 *   · source:'archive'  —— 内置归档里的 3 个 2.0 系列（url 是 zkitefly 归档的 JSON，没有 sha1）
 *
 * ★ 归档部分**不依赖网络**：manifest 拉不到（离线且无缓存）时仍然返回 2.0 那 3 个，
 *   而不是整份清单都失败；只有连归档数据都一条都捞不到时才把 manifest 的错误抛出去。
 *
 * @param {{cacheDir?:string, source?:string, timeoutMs?:number, force?:boolean,
 *          order?:'asc'|'desc', signal?:AbortSignal}} [options]
 * @returns {Promise<Array<{id:string,type:string,url:string|null,releaseTime:string|null,
 *                          time:string|null,sha1:string|null,foolTitle:string,
 *                          source:'manifest'|'archive'}>>}
 */
async function aprilFoolsList(options) {
  const opts = options || {};
  const order = opts.order === 'asc' ? 'asc' : 'desc';

  // 1) 官方 manifest（失败不立刻抛：归档那 3 个不依赖它）
  let manifestVersions = [];
  let manifestError = null;
  try {
    const m = await manifest({
      cacheDir: opts.cacheDir,
      source: opts.source,
      timeoutMs: opts.timeoutMs,
      force: opts.force,
      maxAgeMs: opts.maxAgeMs,
      signal: opts.signal,
    });
    manifestVersions = m.versions;
  } catch (err) {
    manifestError = err;
  }
  const byId = new Map();
  for (const v of manifestVersions) if (v && v.id) byId.set(v.id, v);

  // 2) 逐条按来源取数据
  const out = [];
  for (const fool of APRIL_FOOLS) {
    if (fool.source === 'archive') {
      /**
       * ★ 2013 Minecraft 2.0：官方 manifest 没有，只能从内置归档捞。
       *   归档条目字段结构与 manifest 不同：地址叫 infoUrl / url（没有 manifest 的 url 语义），
       *   没有 sha1、没有 type，时间字段是 epoch 毫秒的 sortTime / compileTime / releaseTime。
       */
      const entry = archiveEntryFor(fool.id);
      if (!entry) continue;
      const releaseStamp = entry.releaseTime !== undefined && entry.releaseTime !== null
        ? entry.releaseTime
        : entry.sortTime !== undefined && entry.sortTime !== null
          ? entry.sortTime
          : entry.compileTime;
      const timeStamp = entry.sortTime !== undefined && entry.sortTime !== null
        ? entry.sortTime
        : releaseStamp;
      out.push({
        id: String(entry.id || fool.id),
        type: 'snapshot', // 归档条目的 category 是 april-fools，不是官方 type，统一标快照
        url: entry.url || entry.infoUrl || null,
        releaseTime: releaseStamp === undefined || releaseStamp === null ? null : toIso(releaseStamp),
        time: timeStamp === undefined || timeStamp === null ? null : toIso(timeStamp),
        sha1: entry.sha1 || null, // 归档条目没有 sha1
        foolTitle: fool.foolTitle,
        source: 'archive',
      });
      continue;
    }

    // 精确匹配（区分大小写、保留空格/点）；官方清单里没有就跳过
    const v = byId.get(fool.id);
    if (!v) continue;
    out.push({
      id: v.id,
      type: v.type || 'snapshot',
      url: v.url || null,
      releaseTime: v.releaseTime || null,
      time: v.time || v.releaseTime || null,
      sha1: v.sha1 || null,
      foolTitle: fool.foolTitle,
      source: 'manifest',
    });
  }

  // 一条都没捞到（白名单与归档数据同时失效）→ 把 manifest 的错误抛出去，别静默返回空
  if (!out.length && manifestError) throw manifestError;

  // 默认「新 → 旧」，与其他版本列表一致；传 order:'asc' 拿最早 → 最新
  out.sort((a, b) => {
    const ta = timeValue(a.releaseTime);
    const tb = timeValue(b.releaseTime);
    return order === 'asc' ? ta - tb : tb - ta;
  });
  return out;
}

/** 内置归档清单原始对象（install.js 需要 entries 里的 infoUrl 细节）。 */
function legacyArchive() {
  return LEGACY_ARCHIVE;
}

/** 未收录版本原始对象。 */
function unlistedVersions() {
  return UNLISTED;
}

/**
 * 某个 id 是否属于归档版本。
 * ★ 必须把 url 归一化出来：Betacraft 归档条目里字段名是 infoUrl，
 *   未收录版本里是 url；调用方（install.js）只看 `url`。
 */
function archiveEntryFor(id) {
  const entries = (LEGACY_ARCHIVE && LEGACY_ARCHIVE.entries) || [];
  const hit = entries.find((e) => e && e.id === id);
  if (hit) {
    const url = hit.infoUrl || hit.url || null;
    return {
      ...hit,
      url,
      infoUrl: url,
      type: isWeeklySnapshot(id) ? 'snapshot' : 'ancient',
      archive: !!url && String(url).endsWith('.info'),
      source: 'betacraft',
    };
  }
  const un = ((UNLISTED && UNLISTED.entries) || []).find((e) => e && e.id === id);
  if (un) {
    const url = un.url || null;
    return {
      ...un,
      url,
      archive: !!url && String(url).endsWith('.info'),
      source: 'unlisted',
    };
  }
  return null;
}

module.exports = {
  MANIFEST_URL,
  DATA_DIR,
  DEFAULT_MANIFEST_MAX_AGE_MS,
  manifest,
  versionJson,
  ancientList,
  aprilFoolsList,
  APRIL_FOOLS,
  legacyArchive,
  unlistedVersions,
  archiveEntryFor,
  isWeeklySnapshot,
  isArchiveBuild,
  dateFromId,
  versionJsonUrls,
  manifestUrl,
  dataDir,
};
