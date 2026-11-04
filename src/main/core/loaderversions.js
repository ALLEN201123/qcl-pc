'use strict';
/**
 * Quanta Craft Launcher PC · 加载器版本查询
 *
 * ## 为什么需要它
 * 用户要求：「那个推荐当前玩家版本是否能正确地推荐玩家当前版本的
 *            Fabric / Forge / NeoForge 的最新版本」。
 *
 * 以前「安装」弹窗只让玩家选加载器类型，但**不告诉他能装哪个版本**，
 * 玩家选完才在后台默默去挑，选错了也不知道为什么失败。
 * ⇒ 现在选加载器时直接显示「这个 MC 版本能装的最新稳定版」，并且允许手动指定。
 *
 * ## 数据来源（全部官方 / 镜像，免登录）
 *   · Fabric    https://meta.fabricmc.net/v2/versions/loader/<mc>
 *   · Quilt     https://meta.quiltmc.org/v3/versions/loader/<mc>
 *   · Babric    https://meta.babric.glass-launcher.net/v2/versions/loader/<mc>
 *               （b1.7.3 的 Fabric 分支；不带 mc 的列表端点是 .../loader/）
 *   · ModLoader **不用联网**：查本地版本表 core/modloaderversions.js
 *               （Risugami's ModLoader 是覆盖式注入 jar，没有「加载器版本」概念，
 *                所以 versions 恒为空、只告诉界面能不能装 + 标签）
 *   · Forge     https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json
 *               （里面是 `"1.20.1-latest": "47.4.28"` 这种键值，最准）
 *   · NeoForge  https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml
 *               （官方 maven.neoforged.net 在本机网络下不可达，走 BMC 镜像）
 *               ★ NeoForge 的 maven 元数据**不标 MC 版本**，只能按版本号前缀推：
 *                 1.20.1→47.x / 1.20.2→48.x / 1.20.4→49.x / 1.20.6→50.x /
 *                 1.21→51.x / 1.21.1→52.x / 1.21.4→54.x …；26.x 直接用 `26.x.`
 *               推不出来就返回空（界面显示「自动选择」，不会瞎装）
 */

const http = require('./http');
const babric = require('./babric');
const modloaderversions = require('./modloaderversions');

/** 统一 10 秒超时 + 1 次重试，超时别拖垮界面 */
const T = { timeoutMs: 12000, retries: 1 };

/**
 * NeoForge 版本号前缀（2026-11-05 实测确认）。
 *
 * ★ 镜像（bmclapi2）上用的是**新方案** `<MC次版本>.<MC补丁>.<构建>`：
 *     1.20.2 → `20.2.x`
 *     1.20.4 → `20.4.x`
 *     1.21   → `21.0.x`
 *     1.21.1 → `21.1.x`
 *     26.3   → `26.3.x`
 *   实测镜像里**没有** `20.1.x`（1.20.1 用的是老的 47.x 方案，镜像未收录），
 *   所以 1.20.1 会返回空 —— 界面显示「该版本没有 NeoForge」，这是事实，不瞎装。
 */
function neoForgePrefix(mcVersion) {
  const v = String(mcVersion || '').trim();
  // 26.x / 27.x …：直接用 `26.3.`
  if (/^2[6-9]\./.test(v)) return `${v}.`;
  // 1.X.Y → `X.Y.`
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(v);
  if (m) {
    const minor = Number.parseInt(m[1], 10);
    const patch = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
    return `${minor}.${patch}.`;
  }
  return null;
}

/** 是不是预发布版（beta / alpha / snapshot / pre / rc） */
function isPrerelease(version) {
  return /-(beta|alpha|pre|rc)|-(beta|alpha)|snapshot|\+pre|\+snapshot/i.test(String(version || ''));
}

/**
 * 版本号比较（按 . 分段数字比）。
 * ★ 预发布版（-beta 等）在同数字下**排在稳定版之后**，保证「最新」永远是稳定版。
 */
function compareVersionDesc(a, b) {
  const strip = (x) => String(x).split(/[-+]/)[0];
  const pa = strip(a).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = strip(b).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  // 数字相同：稳定版 > 预发布版
  const ra = isPrerelease(a) ? 0 : 1;
  const rb = isPrerelease(b) ? 0 : 1;
  return ra - rb;
}

/** Fabric：/v2/versions/loader/<mc> 返回 [{loader:{version,build,stable}}...] */
async function fabricVersions(mcVersion) {
  const list = await http.fetchJson(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
    T
  );
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((x) => (x && x.loader ? String(x.loader.version || '') : ''))
    .filter(Boolean);
}

/** Quilt：/v3/versions/loader/<mc> 结构类似 */
async function quiltVersions(mcVersion) {
  const list = await http.fetchJson(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`,
    T
  );
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((x) => (x && x.loader ? String(x.loader.version || '') : ''))
    .filter(Boolean);
}

/** Forge：promotions_slim.json 里 `"<mc>-latest"` / `"<mc>-recommended"` */
async function forgeVersions(mcVersion) {
  const data = await http.fetchJson(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
    T
  );
  const promos = (data && data.promos) || {};
  const latest = promos[`${mcVersion}-latest`];
  const recommended = promos[`${mcVersion}-recommended`];
  const out = [];
  if (latest) out.push(String(latest));
  if (recommended && String(recommended) !== String(latest)) out.push(String(recommended));
  return out;
}

/** NeoForge：maven-metadata.xml（走 BMC 镜像），按前缀过滤 */
async function neoforgeVersions(mcVersion) {
  const text = await http.fetchText(
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml',
    T
  );
  const all = [...String(text).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);

  const prefix = neoForgePrefix(mcVersion);
  if (!prefix) return [];

  const hit = all.filter((v) => String(v).startsWith(prefix));
  // 稳定版优先；只有完全没有稳定版时才退而用预发布版
  const stable = hit.filter((v) => !isPrerelease(v));
  return stable.length ? stable : hit;
}

/**
 * Babric：/v2/versions/loader/<mc> 返回 [{loader:{version,stable}, ...}]。
 * ★ 只有 b1.7.3 这类版本有（实测 b1.7.3 34 个、b1.7.2 / b1.8.1 都是 0 个）。
 *   接口不支持「不带加载器版本的 profile」，所以这里只取版本号给界面选。
 */
async function babricVersions(mcVersion) {
  const list = await babric.listLoaderVersions(mcVersion, T);
  return list.map((x) => x.version).filter(Boolean);
}

/**
 * ModLoader：**不用联网**，直接查本地版本表。
 *
 * Risugami's ModLoader 没有「加载器版本」概念（它就是往 jar 里塞 class），
 * 所以 versions 恒为空、latest 恒为 null，界面只看 available + label。
 * ★ 少数版本（a1.2.6 / 1.1 等）官方只有 .rar、Gitee 重打包镜像又已失效，
 *   available=false 并在 error 里给出中文原因（界面灰掉按钮 + 显示原因）。
 *
 * @param {string} mcVersion
 * @returns {{versions:string[], latest:null, error:string|null, available:boolean,
 *            label:string|null, fileName:string|null, note:string|null}}
 */
function modloaderInfo(mcVersion) {
  const entry = modloaderversions.find(mcVersion);
  if (!entry) {
    return { versions: [], latest: null, error: null, available: false, label: null, fileName: null, note: null };
  }
  const available = !!entry.installable && entry.available !== false;
  let error = null;
  if (!available) {
    error = entry.note || `ModLoader ${entry.mcVersion} 官方只提供 .rar 包，启动器暂不支持`;
  }
  return {
    versions: [],
    latest: null,
    error,
    available,
    label: modloaderversions.labelOf(entry),
    fileName: entry.fileName,
    note: entry.note || null,
  };
}

/**
 * 查某个 MC 版本可用的加载器版本。
 *
 * @param {object} opts
 * @param {string} opts.mcVersion  例如 '1.20.1' / '26.3' / 'b1.7.3'
 * @param {string} [opts.loader]   只查一个（fabric/forge/neoforge/quilt/babric/modloader）
 * @returns {Promise<Object<string, {versions:string[], latest:string|null, error:string|null}>>}
 *   modloader 额外带 `available`（能否装）与 `label`（'ModLoader b1.7.3'）
 */
async function listLoaderVersions(opts = {}) {
  const mcVersion = String(opts.mcVersion || '').trim();
  const only = opts.loader ? String(opts.loader).toLowerCase() : '';
  const out = {};

  const tasks = [
    ['fabric', () => fabricVersions(mcVersion)],
    ['forge', () => forgeVersions(mcVersion)],
    ['neoforge', () => neoforgeVersions(mcVersion)],
    ['quilt', () => quiltVersions(mcVersion)],
    ['babric', () => babricVersions(mcVersion)],
    // ★ ModLoader 不需要联网，也不依赖 mcVersion（查不到就是 available:false）
    ['modloader', null]
  ];

  for (const [name, fn] of tasks) {
    if (only && only !== name) continue;
    if (name === 'modloader') {
      out.modloader = modloaderInfo(mcVersion);
      continue;
    }
    if (!mcVersion) {
      out[name] = { versions: [], latest: null, error: '缺少 MC 版本' };
      continue;
    }
    try {
      let versions = await fn();
      versions = [...new Set(versions.filter(Boolean))];
      // 降序：最新的在前
      versions.sort(compareVersionDesc).reverse();
      out[name] = { versions, latest: versions[0] || null, error: null };
    } catch (err) {
      out[name] = { versions: [], latest: null, error: err?.message || String(err) };
    }
  }

  return out;
}

module.exports = {
  listLoaderVersions,
  fabricVersions,
  forgeVersions,
  neoforgeVersions,
  quiltVersions,
  babricVersions,
  modloaderInfo,
};
