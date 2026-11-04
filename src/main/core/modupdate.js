'use strict';
/*
 * modupdate.js —— 模组更新检查（只查 Modrinth，不查 CurseForge）。
 *
 * 参照 HMCL 的 AddonUpdatesPage / AddonManager.checkUpdates：
 *   1. 读实例 `mods/*.jar`，逐个算 **sha1**（Modrinth 的版本指纹就是 sha1）；
 *   2. 批量 POST https://api.modrinth.com/v2/version_files/update
 *      body: {"hashes":[...], "algorithm":"sha1", "loaders":[...], "game_versions":[...]}
 *   3. 返回的是「每个 hash 匹配到的**最新**版本」；如果它主文件的 sha1 和本地不同，
 *      说明有更新 → 带上新版本的下载地址 / 版本号 / 大小。
 *
 * ★ 为什么用 sha1 判断而不是直接比 version_number：
 *   Modrinth 的 version_number 是作者自由填的（`mc1.20.1-0.5.13-fabric`），
 *   而 jar 里 fabric.mod.json 的 version 往往是 `0.5.13`；直接比会**每次都误报有更新**。
 *   sha1 相同 = 文件完全相同 ⇒ 一定没更新（HMCL 也是按文件指纹判断的）。
 *
 * ★ 只查 Modrinth：CurseForge 官方 API 需要 key，镜像也没有批量按 hash 查版本的接口。
 * ★ 网络失败不抛异常：返回 `{ checked:0, items:[], error:'中文原因' }`，界面照常渲染空列表。
 */

const fs = require('node:fs');
const path = require('node:path');

const http = require('./http');
const modsModule = require('./mods');
const downloader = require('./downloader');

const API_BASE = 'https://api.modrinth.com/v2';
/** Modrinth 硬性要求带 User-Agent */
const USER_AGENT = 'QCL-PC/1.0.0 (github.com/QuantaCraftLauncher)';
/** 一次请求最多带多少个 hash（官方没有硬限制，但别把 URL/body 搞太大） */
const MAX_HASHES_PER_REQUEST = 500;

/**
 * 加载器类型 → Modrinth 的 loaders 值。
 * · Fabric 系（fabric / quilt）直接对应；
 * · Babric 是 Fabric 分支 ⇒ 当作 fabric 查（否则一条都匹配不到）；
 * · ModLoader / OptiFine / 原版 不在 Modrinth 的 loader 枚举里 ⇒ 不传过滤条件。
 */
const LOADER_MAP = {
  fabric: 'fabric',
  quilt: 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
  babric: 'fabric',
  liteloader: 'liteloader',
};

/** 把底层异常翻成中文（按 http.js 的 E_* 码区分） */
function describeError(err) {
  const code = err && err.code;
  if (code === 'E_TIMEOUT') return '检查模组更新超时：连接 Modrinth 超时，请检查网络后重试';
  if (code === 'E_NETWORK') return '检查模组更新失败：连不上 Modrinth（网络不通、DNS 被拦截或对方服务器不可达）';
  if (code === 'E_CANCELLED') return '检查模组更新已取消';
  const status = err && (err.status || err.statusCode);
  if (status === 429) return '检查模组更新失败：请求太频繁被 Modrinth 限流，请稍后再试';
  if (status === 404) return '检查模组更新失败：Modrinth 接口不存在（可能是接口版本变化）';
  if (status >= 500) return `检查模组更新失败：Modrinth 服务器出错（HTTP ${status}），请稍后再试`;
  if (status) return `检查模组更新失败：Modrinth 返回 HTTP ${status}`;
  return `检查模组更新失败：${(err && err.message) || String(err)}`;
}

/** 实例的 mods 目录 */
function modsDirOf(opts) {
  const o = opts || {};
  const instanceDir = o.instance && o.instance.dir ? o.instance.dir : o.instanceDir;
  if (!instanceDir) {
    throw new http.LauncherError('检查模组更新失败：没有指定实例', { code: 'E_MODUPDATE_PARAMS' });
  }
  return path.join(String(instanceDir), '.minecraft', 'mods');
}

/** 实例的 MC 版本 / 加载器 */
function filtersOf(opts) {
  const o = opts || {};
  const instance = o.instance || {};
  const mcVersion = String(o.mcVersion || instance.installedVersion || instance.mcVersion || '').trim();
  const rawLoader = String(
    (o.loader && (o.loader.type || o.loader)) || (instance.loader && instance.loader.type) || ''
  ).toLowerCase();
  const mapped = LOADER_MAP[rawLoader] || '';
  return {
    mcVersion,
    loaderType: rawLoader,
    loaders: mapped ? [mapped] : [],
    gameVersions: mcVersion ? [mcVersion] : [],
  };
}

/**
 * 收集 mods/*.jar 的指纹与元数据。
 * ★ 只收 `.jar`（与契约一致）；`.jar.disabled` 是禁用中的模组，不改名就不参与检查。
 */
async function collectLocalMods(modsDir, onLog) {
  let names = [];
  try {
    names = fs.readdirSync(modsDir).filter((n) => /\.jar$/i.test(n));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const abs = path.join(modsDir, name);
    let size = 0;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size === 0) continue;
      size = st.size;
    } catch (_) {
      continue;
    }
    let sha1 = null;
    try {
      sha1 = await downloader.sha1OfFile(abs);
    } catch (_) {
      sha1 = null;
    }
    if (!sha1) continue;
    let meta = { name, version: null };
    try {
      const m = modsModule.readModMetadata(abs);
      meta = { name: (m && m.name) || name, version: (m && m.version) || null };
    } catch (_) {
      /* 元数据读不到不影响 hash 检查 */
    }
    out.push({ fileName: name, path: abs, size, sha1: String(sha1).toLowerCase(), name: meta.name, current: meta.version || '' });
    if (typeof onLog === 'function') onLog(`  指纹 ${name} → ${sha1.slice(0, 12)}…`);
  }
  return out;
}

/**
 * 批量查 Modrinth（按 hash 分片）。
 * @returns {Promise<Object<string, object>>} sha1 → 最新版本对象
 */
async function queryUpdates(hashes, filters, options) {
  const opts = options || {};
  const result = {};
  for (let i = 0; i < hashes.length; i += MAX_HASHES_PER_REQUEST) {
    const chunk = hashes.slice(i, i + MAX_HASHES_PER_REQUEST);
    const body = { hashes: chunk, algorithm: 'sha1' };
    if (filters.loaders && filters.loaders.length) body.loaders = filters.loaders;
    if (filters.gameVersions && filters.gameVersions.length) body.game_versions = filters.gameVersions;
    // eslint-disable-next-line no-await-in-loop
    const data = await http.fetchJson(`${API_BASE}/version_files/update`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs || 20000,
      retries: 1,
      signal: opts.signal,
    });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [sha, version] of Object.entries(data)) {
        if (version && typeof version === 'object') result[String(sha).toLowerCase()] = version;
      }
    }
  }
  return result;
}

/** 从 Modrinth 版本对象里挑主文件 */
function pickPrimaryFile(version) {
  const files = Array.isArray(version && version.files) ? version.files : [];
  const usable = files.filter((f) => f && f.url);
  if (!usable.length) return null;
  return usable.find((f) => f.primary) || usable[0];
}

/**
 * 检查某个实例的模组更新。
 *
 * @param {{home?:string, instance?:object, instanceDir?:string, mcVersion?:string,
 *          loader?:string|object, onLog?:Function, timeoutMs?:number, signal?:AbortSignal}} opts
 * @returns {Promise<{checked:number, items:Array, error:string|null}>}
 *   items[]: { fileName, name, current, latest, downloadUrl, sha1, size, projectId }
 */
async function checkUpdates(opts) {
  const o = opts || {};
  const onLog = typeof o.onLog === 'function' ? o.onLog : () => {};
  let modsDir;
  try {
    modsDir = modsDirOf(o);
  } catch (err) {
    return { checked: 0, items: [], error: describeError(err) };
  }
  if (!fs.existsSync(modsDir)) {
    onLog('这个实例还没有 mods 目录（没装过模组）');
    return { checked: 0, items: [], error: null };
  }

  const local = await collectLocalMods(modsDir, onLog);
  if (!local.length) {
    onLog('mods 目录里没有 .jar');
    return { checked: 0, items: [], error: null };
  }

  const filters = filtersOf(o);
  onLog(
    `检查 ${local.length} 个模组：MC ${filters.mcVersion || '?'}` +
      `${filters.loaderType ? `，加载器 ${filters.loaderType}` : ''}` +
      `${filters.loaders.length ? `（按 ${filters.loaders.join('/')} 过滤）` : ''}`
  );

  let remote;
  try {
    remote = await queryUpdates(
      local.map((m) => m.sha1),
      filters,
      { timeoutMs: o.timeoutMs || 20000, signal: o.signal }
    );
  } catch (err) {
    const message = describeError(err);
    onLog(message);
    return { checked: 0, items: [], error: message };
  }

  const items = [];
  for (const m of local) {
    const version = remote[m.sha1];
    if (!version) continue; // Modrinth 上没有这个 hash（不是从 Modrinth 下的 / 作者删了）
    const file = pickPrimaryFile(version);
    if (!file) continue;
    const latestSha1 = file.hashes && file.hashes.sha1 ? String(file.hashes.sha1).toLowerCase() : null;
    // ★ 指纹相同 = 文件完全一样 = 没更新（比 version_number 可靠）
    if (!latestSha1 || latestSha1 === m.sha1) continue;
    items.push({
      fileName: m.fileName,
      name: m.name || m.fileName,
      current: m.current || '',
      latest: String(version.version_number || ''),
      downloadUrl: String(file.url),
      sha1: latestSha1,
      size: Number(file.size) || 0,
      projectId: version.project_id ? String(version.project_id) : '',
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  onLog(`检查完成：${local.length} 个模组，${items.length} 个有更新`);
  return { checked: local.length, items, error: null };
}

module.exports = {
  API_BASE,
  USER_AGENT,
  LOADER_MAP,
  MAX_HASHES_PER_REQUEST,
  checkUpdates,
  // 给测试脚本复用
  collectLocalMods,
  queryUpdates,
  filtersOf,
  describeError,
};
