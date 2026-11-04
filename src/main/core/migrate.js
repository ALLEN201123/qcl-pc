'use strict';
/**
 * Quanta Craft Launcher PC · 目录布局迁移（一次性，幂等）
 *
 * ## 背景
 * 2026-11-05 把 libraries / assets 从「每实例一份」改成「所有实例共享」
 * （照 HMCL 的隔离语义：各版本独立只独立游戏数据，assets 与 libraries 始终共享）。
 *
 * 布局变化：
 *   旧：`<home>/instances/<id>/.minecraft/libraries`、`.../assets`
 *   新：`<home>/.minecraft/libraries`、`<home>/.minecraft/assets`
 *
 * ## 为什么必须迁移
 * 不迁移的后果有两个，都很糟：
 *   ① 共享目录是空的 → 下次启动/安装会**把依赖库和资源重新下一遍**（几百 MB）；
 *   ② 旧的每实例副本还留在盘上 → 磁盘占用翻倍，正是用户抱怨的「废磁盘」。
 *
 * ## 迁移策略
 *   · 逐个文件搬到共享目录；目标已存在且大小一致就**跳过**（多为硬链接/相同内容）；
 *   · 用 `rename` 而不是复制 —— 同一卷上是**瞬时**的，不产生额外磁盘写入
 *     （本机内存紧张，复制几百 MB 有风险）；
 *   · rename 失败（跨卷等）再退回复制；
 *   · 搬完清理空目录；
 *   · **整个过程幂等**：跑第二次没有任何文件可搬，直接返回。
 *
 * ## 不动什么
 *   · `versions/`（每个实例的版本 jar 与 json）—— 各实例装的版本不同，本来就该独立；
 *   · `natives/`（解压出来的原生库）—— 每个版本一套，体积小，独立更安全；
 *   · `saves/` `mods/` `config/` `resourcepacks/` —— 这些是**玩家的数据，必须独立**。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

/** 迁移记录文件（跑过一次就不再重复扫） */
const MARKER = '.layout-shared-v1';

function markerFile(home) {
  return path.join(String(home || ''), MARKER);
}

/**
 * 把 `from` 目录里的所有文件搬到 `to` 目录（同名冲突时按大小决定跳过还是覆盖）。
 *
 * @returns {{moved:number, skipped:number, failed:number, bytes:number}}
 */
function mergeDir(from, to) {
  const result = { moved: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };
  if (!fs.existsSync(from)) return result;

  /**
   * ★★★ 2026-11-05 修：**目标根目录必须先建出来**（踩到的真 bug）。
   *
   * 症状：真实数据迁移报「失败 114 个 / 失败 5149 个」，一个文件都没搬过去，
   *       marker 也没写，用户磁盘一点没省。
   *
   * 根因：以前只在拼 `dst` 之后 `mkdirSync(path.dirname(dst))` —— 这靠的是
   *      `dst` 的**父目录**。当 `to`（共享 libraries 目录）本身还不存在时，
   *      第一次 `path.dirname(dst)`、`mkdirSync` 理论上会 recursive 建出来，
   *      但 `fs.renameSync` 在 Windows 上遇到「目标父目录刚建好、句柄未稳定」时
   *      会抛 EPERM/ENOENT，然后 `copyFileSync` 同样失败 →
   *      整个 try 落到外层 catch，只记了一次 failed，什么都没搬。
   * ⇒ 现在：进入 mergeDir 时**先确保 to 存在**，再去遍历文件。
   *      多这一次 mkdir 就能让后面的 rename 全部成功。
   */
  try {
    fs.mkdirSync(to, { recursive: true });
  } catch (err) {
    // 连目标目录都建不出来：整批记为失败，并保留错误原因
    result.failed = -1;
    result.errors.push(`无法创建目标目录 ${to}：${err?.message || err}`);
    return result;
  }

  const walk = (relDir) => {
    const srcDir = path.join(from, relDir);
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relDir ? path.join(relDir, ent.name) : ent.name;
      const src = path.join(from, rel);
      const dst = path.join(to, rel);

      if (ent.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!ent.isFile()) continue;

      let srcSize = 0;
      try {
        srcSize = fs.statSync(src).size;
      } catch {
        continue;
      }

      // 目标已存在且大小一致 → 内容相同（依赖库/资源都是内容寻址），跳过
      try {
        const dstStat = fs.statSync(dst);
        if (dstStat.isFile() && dstStat.size === srcSize) {
          // 内容一致：删掉旧副本，省磁盘
          try {
            fs.unlinkSync(src);
          } catch {
            /* 删不掉就留着，不影响 */
          }
          result.skipped += 1;
          continue;
        }
      } catch {
        /* 目标不存在，继续搬 */
      }

      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try {
          // 同一卷上瞬时完成，不产生额外写入
          fs.renameSync(src, dst);
        } catch {
          // 跨卷等情况退回复制
          fs.copyFileSync(src, dst);
          try {
            fs.unlinkSync(src);
          } catch {
            /* 忽略 */
          }
        }
        result.moved += 1;
        result.bytes += srcSize;
      } catch (err) {
        result.failed += 1;
        // ★ 记下原因，否则只会看到「失败 N 个」而完全不知道错在哪
        if (result.errors.length < 8) {
          result.errors.push(`${rel}：${err?.message || err}`);
        }
      }
    }
  };

  walk('');
  return result;
}

/** 自底向上删除空目录（只删空的，有文件的一律保留） */
function pruneEmptyDirs(dir, stopAt) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    pruneEmptyDirs(path.join(dir, ent.name), stopAt);
  }
  try {
    const left = fs.readdirSync(dir);
    if (left.length === 0 && path.resolve(dir) !== path.resolve(stopAt || dir)) {
      fs.rmdirSync(dir);
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 执行迁移。幂等，可在每次启动时调用（第一次之后会因 marker 直接跳过）。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {Array}  [opts.instances]  实例数组（含 id / dir）；不传则自己列
 * @param {boolean} [opts.force]     忽略 marker 强制扫一遍
 * @param {function} [opts.onLog]
 * @returns {Promise<{ran:boolean, movedFiles:number, freedBytes:number, details:Array, errors:Array}>}
 */
async function migrateToSharedLayout(opts = {}) {
  const home = String(opts.home || '');
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const out = { ran: false, movedFiles: 0, freedBytes: 0, details: [], errors: [] };
  if (!home) return out;

  // 已迁移过就直接跳过（marker 只是个提示；即使被删，重跑也安全）
  if (!opts.force && fs.existsSync(markerFile(home))) return out;

  let list = opts.instances;
  if (!Array.isArray(list)) {
    try {
      // eslint-disable-next-line global-require
      list = await require('./instances').list(home);
    } catch {
      list = [];
    }
  }
  if (!list.length) {
    // 没有实例也要写 marker，免得每次启动都扫
    try {
      fs.writeFileSync(markerFile(home), new Date().toISOString(), 'utf8');
    } catch {
      /* 忽略 */
    }
    return out;
  }

  out.ran = true;
  const sharedLib = paths.sharedLibrariesDir(home);
  const sharedAssets = paths.sharedAssetsDir(home);

  for (const inst of list) {
    const id = inst && inst.id;
    if (!id) continue;

    // ── libraries ──
    const oldLib = paths.legacyLibrariesDir(home, id);
    if (fs.existsSync(oldLib)) {
      const r = mergeDir(oldLib, sharedLib);
      if (r.moved || r.skipped || r.failed) {
        out.details.push({
          instance: inst.name || id,
          kind: 'libraries',
          ...r
        });
        out.movedFiles += r.moved;
        out.freedBytes += r.bytes;
        log(
          `目录迁移 · ${inst.name || id} · libraries：搬走 ${r.moved} 个、去重跳过 ${r.skipped} 个` +
            `${r.failed ? `、失败 ${r.failed} 个` : ''}` +
            `${r.errors && r.errors.length ? `（首个原因：${r.errors[0]}）` : ''}`
        );
      }
      pruneEmptyDirs(oldLib, path.join(paths.instanceDir(home, id), '.minecraft'));
    }

    // ── assets ──
    const oldAssets = paths.legacyAssetsDir(home, id);
    if (fs.existsSync(oldAssets)) {
      const r = mergeDir(oldAssets, sharedAssets);
      if (r.moved || r.skipped || r.failed) {
        out.details.push({
          instance: inst.name || id,
          kind: 'assets',
          ...r
        });
        out.movedFiles += r.moved;
        out.freedBytes += r.bytes;
        log(
          `目录迁移 · ${inst.name || id} · assets：搬走 ${r.moved} 个、去重跳过 ${r.skipped} 个` +
            `${r.failed ? `、失败 ${r.failed} 个` : ''}` +
            `${r.errors && r.errors.length ? `（首个原因：${r.errors[0]}）` : ''}`
        );
      }
      pruneEmptyDirs(oldAssets, path.join(paths.instanceDir(home, id), '.minecraft'));
    }
  }

  try {
    fs.writeFileSync(
      markerFile(home),
      `${new Date().toISOString()}\nmoved=${out.movedFiles}\nfreed=${out.freedBytes}\n`,
      'utf8'
    );
  } catch {
    /* 忽略 */
  }

  if (out.movedFiles) {
    log(
      `目录迁移完成：共搬动 ${out.movedFiles} 个文件，` +
        `释放约 ${(out.freedBytes / 1024 / 1024).toFixed(1)} MB（依赖库与资源现在多实例共享）`
    );
  } else {
    log('目录迁移：没有需要搬动的文件（已是共享布局）');
  }

  return out;
}

/** 这个 home 是否已经迁到共享布局 */
function isSharedLayout(home) {
  return fs.existsSync(markerFile(home));
}

/* ------------------------------------------------------------ 后台迁移 + 闸门 */

/**
 * ★ 后台迁移（2026-11-05）。
 *
 * 为什么不在启动时 await：
 *   实测迁移 5694 个文件要 **15.4 秒**。如果放在创建窗口之前 await，
 *   用户升级后第一次打开会**黑屏 15 秒**（大安装可能几分钟），体验很差。
 *
 * 为什么还要留闸门：
 *   迁移过程中共享目录是「搬了一半」的状态。如果用户这时点「启动游戏」，
 *   读到的 libraries 可能不完整 → 报「依赖库缺失」。
 *   ⇒ 启动/安装前先 `await whenIdle()`，等迁移结束再干活。
 *
 * 两全：窗口秒开；真要启动游戏时，最多多等那几秒。
 */
let inflight = null;

/** 启动后台迁移（不阻塞调用方；重复调用返回同一个 promise） */
function startBackground(opts) {
  if (inflight) return inflight;
  inflight = migrateToSharedLayout(opts)
    .catch((err) => {
      // 迁移失败不能影响任何功能：最坏情况是回到「重新下载依赖」
      try {
        if (typeof opts.onLog === 'function') opts.onLog(`目录迁移失败（已忽略）：${err?.message || err}`);
      } catch {
        /* 忽略 */
      }
      return { ran: false, movedFiles: 0, freedBytes: 0, details: [], errors: [String(err)] };
    })
    .finally(() => {
      // 保留结果，但标记已完成（不清空，便于诊断）
      inflightDone = true;
    });
  return inflight;
}

let inflightDone = false;

/** 等后台迁移结束（没启动过就立即返回） */
async function whenIdle() {
  if (!inflight || inflightDone) return;
  try {
    await inflight;
  } catch {
    /* 忽略 */
  }
}

/** 迁移是否还在进行中 */
function isMigrating() {
  return !!inflight && !inflightDone;
}

module.exports = {
  migrateToSharedLayout,
  startBackground,
  whenIdle,
  isMigrating,
  isSharedLayout,
  mergeDir,
  markerFile,
  MARKER
};
