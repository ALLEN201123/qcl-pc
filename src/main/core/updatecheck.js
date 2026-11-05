'use strict';
/**
 * Quanta Craft Launcher PC · 更新检查
 *
 * 用途：未来发布新版本时，启动器能主动提示玩家「有新版本」。
 * 数据源固定为本仓库的 GitHub Releases（不需要额外服务器）：
 *     https://api.github.com/repos/ALLEN201123/qcl-pc/releases/latest
 *
 * 设计原则：
 *   · 纯检查、不自动下载、不自动安装（安装程序是 exe，交给玩家双击）
 *   · 失败一律静默（离线 / 被墙 / 限流都不弹错误，不打扰玩家）
 *   · 有缓存（默认 6 小时），不在每次启动都打网络
 *   · 版本号比较按语义版本（1.0.0 < 1.0.1 < 1.1.0）
 */

const path = require('node:path');
const fs = require('node:fs');
const jsonstore = require('./jsonstore');

const REPO = 'ALLEN201123/qcl-pc';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const CACHE_MS = 6 * 60 * 60 * 1000;

/** 把 "v1.0.0" / "1.0.1-beta" 之类拆成可比较的数字段 */
function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+](.+))?$/.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] || 0),
    pre: m[4] ? String(m[4]).toLowerCase() : '',
    raw: s,
  };
}

/** a > b 返回 1，a < b 返回 -1，相等 0；预发布版低于同号正式版 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;   // 正式版 > 预发布
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function cacheFile(home) {
  return path.join(String(home || ''), 'meta', 'update_check.json');
}

function readCache(home) {
  try {
    const j = jsonstore.readJson(cacheFile(home), null);
    if (j && j.checkedAt && j.latest) return j;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(home, data) {
  try {
    const file = cacheFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    jsonstore.writeJson(file, data);
  } catch {
    /* 写缓存失败无所谓 */
  }
}

/** 从 Release 里挑出 Windows 安装包资产（中文名或 ASCII 名都认） */
function pickInstallerAsset(release) {
  const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
  const hit = assets.find((a) => {
    const n = String((a && a.name) || '');
    return /\.exe$/i.test(n) && (/QCL/i.test(n) || /Setup|安装/i.test(n));
  }) || assets.find((a) => /\.exe$/i.test(String((a && a.name) || '')));
  if (!hit) return null;
  return {
    name: String(hit.name || ''),
    size: Number(hit.size) || 0,
    url: String(hit.browser_download_url || ''),
  };
}

/**
 * 检查更新。
 * @param {{home:string, currentVersion:string, force?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, hasUpdate:boolean, current:string, latest:string,
 *                    releaseName:string, notes:string, url:string, asset:object|null,
 *                    cached:boolean, error?:string}>}
 */
async function checkUpdate(opts = {}) {
  const home = opts.home;
  const current = String(opts.currentVersion || '1.0.0');
  const force = !!opts.force;
  const base = {
    ok: false,
    hasUpdate: false,
    current,
    latest: current,
    releaseName: '',
    notes: '',
    url: RELEASES_URL,
    asset: null,
    cached: false,
  };

  if (!force) {
    const c = readCache(home);
    if (c && Date.now() - Number(c.checkedAt) < CACHE_MS) {
      return {
        ...base,
        ok: true,
        hasUpdate: compareVersions(c.latest, current) > 0,
        latest: c.latest,
        releaseName: c.releaseName || '',
        notes: c.notes || '',
        asset: c.asset || null,
        cached: true,
      };
    }
  }

  try {
    const res = await fetch(API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `QCL-PC/${current}`,
      },
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || 12000),
    });
    if (!res.ok) {
      // 404 = 还没有发布过 Release；限流/网络问题也一律静默
      return { ...base, ok: true, error: `HTTP ${res.status}` };
    }
    const j = await res.json();
    const latest = String(j.tag_name || j.name || '').replace(/^v/i, '');
    if (!latest) return { ...base, ok: true, error: '返回里没有版本号' };
    const asset = pickInstallerAsset(j);
    const info = {
      checkedAt: Date.now(),
      latest,
      releaseName: String(j.name || ''),
      notes: String(j.body || '').slice(0, 4000),
      asset,
    };
    writeCache(home, info);
    return {
      ...base,
      ok: true,
      hasUpdate: compareVersions(latest, current) > 0 && !j.draft && !j.prerelease,
      latest,
      releaseName: info.releaseName,
      notes: info.notes,
      url: String(j.html_url || RELEASES_URL),
      asset,
    };
  } catch (err) {
    return { ...base, ok: true, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  REPO,
  API_URL,
  RELEASES_URL,
  checkUpdate,
  compareVersions,
  parseVersion,
  pickInstallerAsset,
};
