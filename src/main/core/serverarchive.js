'use strict';
/**
 * Betacraft 服务端归档（server-archive）
 *
 * ★★★ 为什么必须有这个模块（2026-11-22，用户纠正了我一个事实错误）：
 *
 * 我一开始以为「远古版本没有服务端」，还说 Mojang 从来没发过 —— **这是错的**。
 * 事实是：Mojang **发过**，但很多版本的服务端 jar **后来被官方从下载清单里删掉了**
 * （最典型的是 1.0 正式版、1 Beta / Alpha / Classic 全系）。
 * Betacraft 社区把这些官方已丢失的服务端 jar 全量保存了下来，它自己就是靠这个开服的。
 *
 * 归档地址（目录可直接浏览，返回 HTML 索引）：
 *   https://files.betacraft.uk/server-archive/
 *     ├ classic/          c1.2.zip / c1.10.jar …（zip 与 jar 混放）
 *     ├ alpha/            a0.1.0.jar / a1.2.6.jar …
 *     ├ beta/             b1.0.jar … b1.8.1.jar（含 .exe）
 *     │   └ prerelease/   b1.9-pre1..pre6、b1.8-pre1/pre2、b1.6-pre …
 *     └ release/          1.0/1.0.0.jar、1.1/1.1.jar、1.2/…、2.0/red|blue|purple
 *
 * ★ 注意：
 *   · 目录里有 .exe（Windows 包装器），我们只要 .jar
 *   · 文件名不一定等于版本 id（b1.3-1647、b1.7-pre-trailer 等带编译时间戳）
 *   · 实现方式是**解析目录 HTML 索引**，因为 Betacraft 没有提供 JSON 清单；
 *     解析结果带缓存（文件系统 meta 缓存 + 内存缓存），避免每次都抓
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');
const jsonstore = require('./jsonstore');

/** 归档根 */
const ARCHIVE_BASE = 'https://files.betacraft.uk/server-archive';

/** 四个大类 */
const CATEGORIES = [
  { id: 'release', label: '正式版', dir: 'release' },
  { id: 'beta', label: 'Beta', dir: 'beta' },
  { id: 'alpha', label: 'Alpha', dir: 'alpha' },
  { id: 'classic', label: 'Classic', dir: 'classic' },
];

/** 内存缓存（同一次会话内不重复抓） */
let memCache = null;
const MEM_TTL_MS = 30 * 60 * 1000;
let memAt = 0;

/** 索引缓存文件 */
function cacheFile(home) {
  return path.join(paths.metaDir(home), 'betacraft_server_archive.json');
}

/**
 * 从目录 HTML 里抽条目（文件和子目录都要）。
 *
 * ★ 2026-11-22 修：初版把 `endsWith('/')` 的条目全过滤了，
 *   但 Betacraft 的目录名在 href 里**带结尾斜杠**（`1.0/`、`prerelease/`），
 *   结果 release 那 14 个版本目录全被丢掉，只剩 beta/alpha/classic 的平铺 jar。
 *   ⇒ 现在返回 `{ name, isDir }`，由调用方决定怎么用。
 */
function parseEntries(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+href="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1];
    if (!href || href === '../' || href === './') continue;
    const raw = href.split('?')[0].split('#')[0];
    const isDir = raw.endsWith('/');
    const name = decodeURIComponent(isDir ? raw.slice(0, -1) : raw);
    if (!name || name === '..' || name === '.') continue;
    const key = (isDir ? 'D:' : 'F:') + name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, isDir });
  }
  return out;
}

/** 只要文件名（兼容旧调用） */
function parseListing(html) {
  return parseEntries(html)
    .filter((e) => !e.isDir)
    .map((e) => e.name);
}

/** 抓一个目录的条目（含 isDir） */
async function fetchEntries(url, options = {}) {
  const http = require('./http');
  const html = await http.fetchText(url, { timeoutMs: options.timeoutMs || 20000, retries: 1 });
  return parseEntries(html);
}

/** 这是不是一个可下载的服务端包（jar 或 zip） */
function isServerPackage(name) {
  return /\.(jar|zip)$/i.test(String(name || ''));
}

/** 这是不是 Windows 包装器（不要） */
function isWindowsExe(name) {
  return /\.exe$/i.test(String(name || ''));
}

/** 递归扫一个目录，把所有服务端包收进来（最多 3 层） */
async function scanTree(category, urlPath, displayDir, options = {}, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries = [];
  try {
    entries = await fetchEntries(`${ARCHIVE_BASE}/${urlPath}`, options);
  } catch (e) {
    if (depth === 0) throw e;
    return out;
  }
  for (const e of entries) {
    if (e.isDir) {
      // eslint-disable-next-line no-await-in-loop
      await scanTree(category, `${urlPath}/${encodeURIComponent(e.name)}`, displayDir ? `${displayDir}/${e.name}` : e.name, options, depth + 1, out);
    } else if (isServerPackage(e.name) && !isWindowsExe(e.name)) {
      out.push({
        category,
        versionDir: displayDir,
        file: e.name,
        url: `${ARCHIVE_BASE}/${urlPath}/${encodeURIComponent(e.name)}`,
      });
    }
  }
  return out;
}

/**
 * 扫 release（release 下是「版本目录」再套文件，2.0 还有 red/blue/purple）
 */
async function scanRelease(options = {}) {
  return scanTree('release', 'release', '', options, 0, []);
}

/** 扫一个平铺目录（beta / alpha / classic，含 prerelease 子目录） */
async function scanFlat(category, options = {}) {
  const cat = CATEGORIES.find((c) => c.id === category);
  if (!cat) return [];
  return scanTree(category, cat.dir, '', options, 0, []);
}

/**
 * 拿完整归档清单（带缓存）。
 * @param {{home:string, force?:boolean, onLog?:Function}} options
 * @returns {Promise<{ok:boolean, items:Array, at:number, error?:string}>}
 */
async function list(options = {}) {
  const home = options.home;
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};

  // ① 内存缓存
  if (!options.force && memCache && Date.now() - memAt < MEM_TTL_MS) {
    return { ok: true, items: memCache, at: memAt, cached: 'memory' };
  }
  // ② 文件缓存
  if (!options.force && home) {
    const c = jsonstore.readJson(cacheFile(home), null);
    if (c && Array.isArray(c.items) && c.items.length && Date.now() - Number(c.at || 0) < MEM_TTL_MS) {
      memCache = c.items;
      memAt = Number(c.at) || Date.now();
      return { ok: true, items: c.items, at: memAt, cached: 'file' };
    }
  }

  // ③ 真抓
  try {
    log('正在读取 Betacraft 服务端归档清单…');
    const results = await Promise.allSettled([
      scanRelease(options),
      scanFlat('beta', options),
      scanFlat('alpha', options),
      scanFlat('classic', options),
    ]);
    const items = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) items.push(...r.value);
    }
    if (!items.length) {
      throw new Error('归档清单为空（网络不通或被挡）');
    }
    memCache = items;
    memAt = Date.now();
    if (home) {
      try {
        fs.mkdirSync(paths.metaDir(home), { recursive: true });
        jsonstore.writeJson(cacheFile(home), { at: memAt, items });
      } catch {
        /* 写缓存失败不影响 */
      }
    }
    log(`归档清单读取完成：${items.length} 个服务端 jar`);
    return { ok: true, items, at: memAt, cached: false };
  } catch (err) {
    return { ok: false, items: [], at: 0, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 把一条归档记录归类到「正式版 / 快照 / 愚人节版 / 远古版」。
 *
 * ★ 2026-11-22（用户要求「搞分类，快照、正式版、愚人节版、还有远古版」）。
 *   分类依据是 **版本 id 的形态**，不是 Betacraft 的目录结构
 *   （它的 release/ 目录里其实混了快照，beta/prerelease 里也有正式预发布）：
 *
 *   · 快照：   周快照 `13w16a`、现代快照 `26.4-snapshot-10`、`1.20.1-pre1`
 *   · 愚人节： `2.0_red` / `2.0_blue` / `2.0_purple` / `15w14a` 这类官方彩蛋版
 *   · 远古版： classic `c*` / alpha `a*` / beta `b*` / indev `in-*` / infdev `inf*` / `rd-*`
 *   · 正式版： 其余 `x.y` / `x.y.z`
 */
const APRIL_FOOLS_IDS = new Set([
  '2.0_red', '2.0_blue', '2.0_purple', '2.0',
  '15w14a', '1.rv-pre1', '3d shareware v1.34', '20w14infinite',
  '22w13oneblockatatime', '23w13a_or_b', '24w14potato', '25w14craftmine',
]);

function classify(versionId) {
  const v = String(versionId || '').trim();
  const low = v.toLowerCase();

  // 愚人节
  if (APRIL_FOOLS_IDS.has(low) || /^2\.0(_|$)/.test(low)) return 'aprilfools';

  // 远古：classic / alpha / beta / indev / infdev / pre-classic
  if (/^(c\d|a\d|b\d|rd-|pc-|in-|inf)/i.test(low)) return 'ancient';

  // 快照：周快照、带 pre/rc/snapshot 的
  if (/^\d{2}w\d{2}[a-h]/i.test(low)) return 'snapshot';
  if (/\d{2}w\d{2}[a-h]/.test(low)) return 'snapshot';
  if (/-snapshot-|-pre\d|-rc\d|^1\.\d+(\.\d+)?-pre/i.test(low)) return 'snapshot';

  // 其余算正式版
  if (/^\d+\.\d+/.test(low)) return 'release';

  return 'other';
}

/** 分类的中文名（界面用） */
const SERVER_GROUPS = [
  { id: 'release', label: '正式版', desc: 'Mojang 发布过的稳定版本' },
  { id: 'snapshot', label: '快照', desc: '开发中的预览版，含周快照' },
  { id: 'aprilfools', label: '愚人节版', desc: '官方彩蛋版本（2.0 三色、15w14a 等）' },
  { id: 'ancient', label: '远古版', desc: 'Classic / Alpha / Beta / Indev / Infdev' },
  { id: 'other', label: '其他', desc: '归不进以上分类的' },
];

/**
 * 从文件名 + 目录推出它对应的 MC 版本 id。
 *
 * ★ 归档文件名不统一，这里按优先级还原（2026-11-22 重写）：
 *
 *   1. **周快照**：`13w16a` / `14w08a` / `13w22a-1608` → 去掉编译时间戳，保留 `13w16a`
 *   2. **Beta 预发布**：`b1.9-pre1` → 原样
 *   3. **愚人节 2.0**：`2.0/red/minecraft_server.jar` → `2.0_red`
 *   4. **正式版带补丁号**：`1.6.4-201309191549` → `1.6.4`；`1.5.2` → `1.5.2`
 *   5. **两段版本**：`1.7` / `1.8` → 原样
 *   6. 兜底用目录名
 *
 * ★ 初版只取 `\d+\.\d+`，把 `13w16a` 全归成 `1.6`、把 `1.6.4` 归成 `1.6` —— 快照全丢，
 *   而且同目录多个版本互相覆盖，无法精确定位。
 */
function versionIdOf(item) {
  const file = String((item && item.file) || '');
  const base = file.replace(/\.(jar|zip|exe)$/i, '');
  const dir = String((item && item.versionDir) || '');

  // ① 周快照：13w16a / 14w08a（可带 -编译时间戳）
  const snap = /\b(\d{2}w\d{2}[a-h])\b/i.exec(base);
  if (snap) return snap[1];

  // ② Beta/Alpha 预发布与普通版：b1.9-pre1 / a0.1.1-1707 / b1.8-pre1-091358
  const bm = /^(b\d+(?:\.\d+)*(?:-pre\d*)?(?:-[a-z0-9]+)*)/i.exec(base);
  if (bm && /^b/i.test(base)) {
    // 去掉纯数字时间戳后缀，保留 -preN
    return bm[1].replace(/-\d{3,}$/,'');
  }
  const am = /^(a\d+(?:\.\d+)*(?:_\d+)?(?:-pre\d*)?)/i.exec(base);
  if (am && /^a/i.test(base)) {
    return am[1].replace(/-\d{3,}$/,'');
  }

  // ③ 愚人节 2.0（文件名都叫 minecraft_server.jar，只能靠目录）
  if (/^2\.0/i.test(dir) || /^2\.0/i.test(base)) {
    const color = /(red|blue|purple|preview)/i.exec(dir);
    return color ? `2.0_${color[1].toLowerCase()}` : '2.0';
  }

  // ④ 正式版：取最长的 x.y.z 数字前缀（去编译时间戳）
  const rel = /^(\d+\.\d+(?:\.\d+)?)/.exec(base);
  if (rel) return rel[1];

  // ⑤ Classic：c1.4-1327 → c1.4
  const cm = /^(c\d+(?:\.\d+)*)/i.exec(base);
  if (cm) return cm[1];

  // ⑥ 兜底
  return dir || base || 'unknown';
}

/**
 * 在归档里找某个 MC 版本的服务端 jar。
 * @param {string} mcVersion
 * @param {{home:string, force?:boolean}} options
 * @returns {Promise<{ok:boolean, item?:object, candidates?:Array, error?:string}>}
 */
async function findServer(mcVersion, options = {}) {
  const want = String(mcVersion || '').trim().toLowerCase();
  if (!want) return { ok: false, error: '没有给版本号' };

  const r = await list(options);
  if (!r.ok) return { ok: false, error: r.error };

  // 精确匹配优先
  const exact = r.items.filter((it) => versionIdOf(it).toLowerCase() === want);
  if (exact.length) {
    // 多个时优先不带 prerelease 的
    const pick = exact.find((x) => (x.versionDir || '') !== 'prerelease') || exact[0];
    return { ok: true, item: pick, candidates: exact };
  }

  // 宽松匹配：文件名以 want 开头（处理 b1.7 → b1.7.3 这类）
  const loose = r.items.filter((it) => versionIdOf(it).toLowerCase().startsWith(want));
  if (loose.length) {
    return { ok: true, item: loose[0], candidates: loose, loose: true };
  }

  return {
    ok: false,
    error: `Betacraft 归档里没有 ${mcVersion} 的服务端 jar`,
    candidates: [],
  };
}

/**
 * 按「正式版 / 快照 / 愚人节版 / 远古版」分组列出归档内容。
 *
 * ★ 注意：这是**按版本形态分类**，跟 Betacraft 的物理目录（classic/alpha/beta/release）不同。
 *   它的 release/ 目录里其实也放了快照（1.6/prerelease/13w16a 之类），
 *   beta/prerelease 里放的是 Beta 的预发布。
 *
 * @returns {{ok:boolean, groups:Array<{id,label,desc,count,items:Array}>, total:number, error?:string}}
 */
async function listByCategory(options = {}) {
  const r = await list(options);
  if (!r.ok) return { ok: false, groups: [], total: 0, error: r.error };

  const buckets = new Map();
  for (const it of r.items) {
    const version = versionIdOf(it);
    const group = classify(version);
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push({
      version,
      file: it.file,
      url: it.url,
      /** Betacraft 的物理分类，保留便于排查 */
      sourceCategory: it.category,
      sourceDir: it.versionDir || '',
      label: it.category === 'release' ? 'Mojang 已下架' : 'Betacraft 归档',
    });
  }

  const groups = SERVER_GROUPS.map((g) => {
    const items = (buckets.get(g.id) || []).sort((a, b) =>
      a.version.localeCompare(b.version, 'en', { numeric: true })
    );
    return { ...g, count: items.length, items };
  }).filter((g) => g.count > 0);

  return { ok: true, groups, total: r.items.length, at: r.at, cached: r.cached };
}

module.exports = {
  ARCHIVE_BASE,
  CATEGORIES,
  parseListing,
  list,
  findServer,
  listByCategory,
  classify,
  SERVER_GROUPS,
  versionIdOf,
  cacheFile,
};
