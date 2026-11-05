'use strict';
/**
 * Quanta Craft Launcher PC · 远古版本兼容参数（单一事实来源）
 *
 * 用户确认要注入的就是这两行（Betacraft 那套）：
 *     -Dhttp.proxyHost=betacraft.uk
 *     -Djava.util.Arrays.useLegacyMergeSort=true
 *
 * ① `-Djava.util.Arrays.useLegacyMergeSort=true`
 *    Java 7+ 的 TimSort 遇到旧版比较器会抛
 *    "Comparison method violates its general contract!" → 加载世界时崩。
 * ② `-Dhttp.proxyHost=betacraft.uk`
 *    极老版本的会话/皮肤/资源请求指向早已废弃的地址，走 BetaCraft 代理才能通过。
 *
 * ★★★ 2026-11-05 修：以前 launch.js 里是手写前缀判定，跟「下载页的远古分类」
 *    和 `legacy_version_archive.json` 不是一套，实测漏掉 81 个版本
 *    （11w/12w/13w 周快照、1.0.0-rc*、2.0_* 愚人节版等）。
 *    现在改成：**归档清单 258 条精确匹配 + 官方 old_alpha/old_beta 前缀**，
 *    一个不漏；且这个模块被启动流程与「版本设置」界面共用，界面显示的
 *    就是启动器真正会加的那两行。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 用户确认的两行参数（顺序固定，界面与启动共用） */
const LEGACY_JVM_ARGS = [
  '-Dhttp.proxyHost=betacraft.uk',
  '-Djava.util.Arrays.useLegacyMergeSort=true',
];

/** 归档清单路径 */
const ARCHIVE_FILE = path.join(__dirname, 'data', 'legacy_version_archive.json');

let cachedIds = null;

/** 读归档清单里的全部版本 id（低内存、只读一次） */
function archiveIds() {
  if (cachedIds) return cachedIds;
  const set = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    const entries = Array.isArray(j && j.entries) ? j.entries : [];
    for (const e of entries) {
      if (!e) continue;
      const id = String(e.id || e.version || e.name || '').trim();
      if (id) set.add(id.toLowerCase());
    }
  } catch {
    /* 读不到就退回前缀判定 */
  }
  cachedIds = set;
  return set;
}

/**
 * 官方 manifest 里的 old_alpha / old_beta 前缀，以及归档里各种老 id 的兜底前缀。
 * 覆盖：pre-classic(rd-/pc-)、classic(c0.)、indev(in-)、infdev(inf-)、
 *       alpha(a1.x)、beta(b1.x / b1.9-pre)、周快照(11w~13w)、1.0 RC、2.0 愚人节。
 */
const LEGACY_PREFIX_RE = /^(rd-|pc-|c0\.|in-|inf-|inf|a\d|b\d|1\.0\.0-rc|2\.0_|1[123]w|pre-?classic|classic|indev|infdev|alpha|beta)/i;

/**
 * 这个版本 id 算不算「远古版本」（= 要不要自动注入那两行）。
 * @param {string} versionId  installedVersion / mcVersion / 版本目录名
 * @returns {boolean}
 */
function isLegacyVersion(versionId) {
  const s = String(versionId || '').trim().toLowerCase();
  if (!s) return false;
  // ① 归档清单精确命中（最权威）
  if (archiveIds().has(s)) return true;
  // ② 官方 old_alpha / old_beta 与各类老 id 前缀
  return LEGACY_PREFIX_RE.test(s);
}

/**
 * 玩家在「版本设置 → JVM 参数」里显式写了代理/排序参数时，启动器不自动加
 * （与安卓版同规则）。
 * @param {string} extraJvmArgs
 */
function hasPlayerOverride(extraJvmArgs) {
  const s = String(extraJvmArgs || '');
  return s.includes('useLegacyMergeSort') || s.includes('proxyHost');
}

/**
 * 算出「这个版本最终会注入哪几行」（供启动流程与界面共用）。
 * @returns {{ legacy:boolean, args:string[], overridden:boolean }}
 */
function legacyArgsFor(versionId, extraJvmArgs) {
  const legacy = isLegacyVersion(versionId);
  if (!legacy) return { legacy: false, args: [], overridden: false };
  if (hasPlayerOverride(extraJvmArgs)) {
    return { legacy: true, args: [], overridden: true };
  }
  return { legacy: true, args: LEGACY_JVM_ARGS.slice(), overridden: false };
}

module.exports = {
  LEGACY_JVM_ARGS,
  LEGACY_PREFIX_RE,
  isLegacyVersion,
  hasPlayerOverride,
  legacyArgsFor,
  archiveIds,
};
