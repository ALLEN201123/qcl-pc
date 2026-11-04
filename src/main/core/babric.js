'use strict';
/*
 * babric.js —— Babric（b1.7.3 的 Fabric 分支）的 meta 查询与安装标记。
 *
 * ★ 逐条照抄安卓版（QCL 1.5.2）：
 *   backup_code_1.5.2/QCL/src/main/java/com/qcl/launcher/launcher/download/babric/BabricInstallTask.java
 *
 * 【Babric 是什么】
 * Babric 是 Glass Launcher 维护的 **Fabric 分支**，只服务 b1.7.3 这类远古版本。
 * 它的 meta 接口和官方 Fabric **形状完全一样**，只是域名不同：
 *   官方 Fabric → https://meta.fabricmc.net/v2/versions/loader/{mc}/{loader}/profile/json
 *   Babric      → https://meta.babric.glass-launcher.net/v2/versions/loader/{mc}/{loader}/profile/json
 * 返回的 profile 同样是「继承原版 + 换 mainClass + 加一堆库」，
 * 所以安装逻辑可以直接复用 Fabric 那套（install.js 的 fetchLoaderProfile 分支）。
 *
 * 实测（2026-11-05）：
 *   · b1.7.3 有 34 个加载器版本，最新稳定版 0.20.1（stable=true）
 *   · b1.7.2 / b1.8.1 返回 **0 个**（Babric 只做 b1.7.3 系）
 *   · b1.7.3 + 0.20.1 → profile id = fabric-loader-0.20.1-b1.7.3，
 *     inheritsFrom = b1.7.3，mainClass = net.fabricmc.loader.impl.launch.knot.KnotClient，22 个库
 *   · ★ 不带加载器版本的 `/b1.7.3/profile/json` 是 **404**（Fabric 支持，Babric 不支持）
 *     ⇒ 没指定版本时必须先用列表端点挑最新稳定版，再拼带版本的 URL。
 *
 * 【★ 库地址绝不能被改写】
 * Babric 的库有一部分只在它自家 maven 上：
 *     https://maven.glass-launcher.net/babric/…
 *   （babric:intermediary-upstream:b1.7.3、babric:log4j-config:1.0.0、
 *     org.lwjgl.lwjgl:lwjgl:2.9.4-babric.1 等；BMCLAPI 镜像上没有这些产物）
 * 官方 Fabric 那套「按下载源把 libraries.minecraft.net 换成 bmclapi」逻辑
 * 一旦作用到 Babric 上就会把地址换坏 → 404。
 * ⇒ install.js 对 babric 强制使用 `source: 'official'`（见 librarySourceFor()），
 *   用 profile json 里自带的原始地址，不做任何源切换。
 */

const fs = require('node:fs');
const path = require('node:path');

const http = require('./http');

/** Babric meta 根地址（比 Fabric 多了个 `babric.`） */
const META_BASE = 'https://meta.babric.glass-launcher.net/v2/versions/loader';

/** 版本目录下的标记文件（gamecheck 靠它跳过校验，界面也用它判断加载器） */
const MARKER_NAME = '.babric';

/** Babric 独占的 maven 主机（这些地址不能走 BMCLAPI 改写） */
const BABRIC_MAVEN_HOSTS = ['maven.glass-launcher.net'];

/** 默认超时 / 重试（和 loaderversions.js 一致） */
const DEFAULT_TIMEOUT_MS = 15000;

function logOf(options) {
  return typeof (options && options.onLog) === 'function' ? options.onLog : () => {};
}

/**
 * Babric 的加载器版本列表。
 *
 * @param {string} [mcVersion] 传了就查该 MC 版本的可用列表（每项 `{loader:{version,stable}}`）；
 *                             不传就查全局列表（每项 `{version,stable}`）
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
 * @returns {Promise<Array<{version:string, stable:boolean}>>}
 */
async function listLoaderVersions(mcVersion, options) {
  const opts = options || {};
  const mc = String(mcVersion == null ? '' : mcVersion).trim();
  // ★ 列表端点两种形态都接受带尾斜杠的写法；带 mc 时是 /loader/<mc>
  const url = mc ? `${META_BASE}/${encodeURIComponent(mc)}` : `${META_BASE}/`;
  const data = await http.fetchJson(url, {
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    retries: 1,
  });
  const arr = Array.isArray(data) ? data : [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    // 带 mc 的接口把版本信息放在 loader 对象里；全局列表是平铺的
    const holder = item.loader && typeof item.loader === 'object' ? item.loader : item;
    const version = holder.version !== undefined && holder.version !== null ? String(holder.version) : '';
    if (!version) continue;
    out.push({ version, stable: holder.stable === true });
  }
  return out;
}

/**
 * 取最新的**稳定版**加载器版本；没有稳定的就退而取列表第一个；都没有返回 null。
 *
 * @param {string} [mcVersion]
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
 * @returns {Promise<string|null>}
 */
async function latestStableLoaderVersion(mcVersion, options) {
  let list = [];
  try {
    list = await listLoaderVersions(mcVersion, options);
  } catch (_) {
    return null;
  }
  const stable = list.find((x) => x.stable);
  if (stable) return stable.version;
  return list.length ? list[0].version : null;
}

/**
 * 取 Babric 的 profile JSON（`<base>/<mc>/<loader>/profile/json`）。
 *
 * ★ 不指定 loaderVersion 时先查该 MC 版本的最新稳定版 —— Babric **不支持**
 *   `/ <mc>/profile/json` 这种「不给版本」的端点（实测 404，Fabric 支持）。
 *
 * @param {string} mcVersion 例如 b1.7.3
 * @param {string} [loaderVersion] 例如 0.20.1
 * @param {{timeoutMs?:number, signal?:AbortSignal, onLog?:Function}} [options]
 * @returns {Promise<object>} profile JSON（id / inheritsFrom / mainClass / libraries …）
 */
async function fetchProfile(mcVersion, loaderVersion, options) {
  const opts = options || {};
  const mc = String(mcVersion == null ? '' : mcVersion).trim();
  if (!mc) {
    throw new http.LauncherError('获取 Babric 安装信息失败：没有指定 Minecraft 版本', { code: 'E_BABRIC_PARAMS' });
  }
  const log = logOf(opts);
  let version = String(loaderVersion == null ? '' : loaderVersion).trim();
  if (!version) {
    version = await latestStableLoaderVersion(mc, opts);
    if (!version) {
      throw new http.LauncherError(
        `获取 Babric 安装信息失败：${mc} 没有可用的 Babric 加载器版本（Babric 目前只支持 b1.7.3 这类版本）。`,
        { code: 'E_BABRIC_NO_VERSION' }
      );
    }
    log(`Babric 未指定加载器版本，自动选用最新稳定版 ${version}`);
  }

  const url = `${META_BASE}/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`;
  let profile;
  try {
    profile = await http.fetchJson(url, {
      timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      retries: 1,
    });
  } catch (err) {
    throw new http.LauncherError(
      `获取 Babric ${mc}（加载器 ${version}）的安装信息失败：${err && err.message ? err.message : '网络不可用'}`,
      { code: 'E_BABRIC_META', cause: err }
    );
  }
  if (!profile || typeof profile !== 'object' || !profile.id) {
    throw new http.LauncherError(`获取 Babric ${mc} 的安装信息失败：返回内容缺少 id`, { code: 'E_BABRIC_META' });
  }
  if (!Array.isArray(profile.libraries) || profile.libraries.length === 0) {
    throw new http.LauncherError(`获取 Babric ${mc} 的安装信息失败：返回内容里没有 libraries`, {
      code: 'E_BABRIC_META',
    });
  }
  log(`已获取 Babric profile：${profile.id}（继承 ${profile.inheritsFrom || '?'}，${profile.libraries.length} 个库）`);
  return profile;
}

/** 标记文件路径 */
function markerPath(versionDir) {
  return path.join(versionDir, MARKER_NAME);
}

/** 这个版本目录装过 Babric 吗（只看标记文件） */
function isInstalled(versionDir) {
  if (!versionDir) return false;
  try {
    return fs.existsSync(markerPath(versionDir));
  } catch (_) {
    return false;
  }
}

/**
 * 写 Babric 安装标记（版本目录下的 `.babric`）。
 *
 * ★ 不写 0 字节空文件：玩家在文件管理器里看到「0B 文件」会以为下载坏了，
 *   所以写几行纯文本（照安卓版 1.2.5 的修法）。
 */
function writeMarker(versionDir, info) {
  const data = info || {};
  const text = [
    'loader=babric',
    `mcVersion=${data.mcVersion || '?'}`,
    `loaderVersion=${data.loaderVersion || '?'}`,
    `libraries=${Number.isFinite(data.libraries) ? data.libraries : 'unknown'}`,
    `profileId=${data.profileId || '?'}`,
    `time=${new Date().toISOString()}`,
  ].join('\n');
  fs.mkdirSync(versionDir, { recursive: true });
  const file = markerPath(versionDir);
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  return file;
}

/** 读标记内容（解析失败返回 null） */
function readMarker(versionDir) {
  try {
    const text = fs.readFileSync(markerPath(versionDir), 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  } catch (_) {
    return null;
  }
}

/** 这个 URL 是不是 Babric 独占的 maven（不能走 BMCLAPI 改写） */
function isBabricMavenUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return BABRIC_MAVEN_HOSTS.includes(host);
  } catch (_) {
    return false;
  }
}

module.exports = {
  META_BASE,
  MARKER_NAME,
  BABRIC_MAVEN_HOSTS,
  listLoaderVersions,
  latestStableLoaderVersion,
  fetchProfile,
  markerPath,
  isInstalled,
  writeMarker,
  readMarker,
  isBabricMavenUrl,
};
