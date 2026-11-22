'use strict';
/**
 * 服务端备份 / 恢复 / 导出
 *
 * ★ 安卓 1.6.6 完全没有备份。玩家装了几十个模组、跑了几个月的世界，
 *   一次误删或一次崩溃就没了。PC 版把这件事做扎实：
 *
 *   ① 手动备份：世界目录（可含 server.properties / mods / config / plugins）
 *   ② 定时备份：按分钟间隔，自动轮转，保留 N 份
 *   ③ **备份前先让服务端保存世界**（save-off → save-all → 备份 → save-on），
 *      否则拷到的是写到一半的区块文件 —— 这是最容易踩的坑
 *   ④ 恢复：把当前世界改名存档，再把备份解回去（可回滚）
 *   ⑤ 导出：打包成 zip 便于分享/转移
 *
 * 目录：
 *   <serverDir>/backups/<时间戳>-<reason>/
 *     world/            世界数据
 *     server.properties 配置快照
 *     meta.json         说明（版本、时间、大小、是否含模组）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const serverMod = require('./server');

/* ============================================================
 * 工具
 * ============================================================ */

/** 递归复制目录（跳过符号链接指向的外部内容，避免把系统目录拉进来） */
async function copyDir(src, dest, opts = {}) {
  const skip = new Set((opts.skip || []).map((s) => s.toLowerCase()));
  let bytes = 0;
  let files = 0;

  async function walk(from, to) {
    await fsp.mkdir(to, { recursive: true });
    let entries;
    try {
      entries = await fsp.readdir(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name.toLowerCase())) continue;
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) {
        await walk(s, d);
      } else if (e.isFile()) {
        try {
          await fsp.copyFile(s, d);
          const st = await fsp.stat(d);
          bytes += st.size;
          files += 1;
        } catch {
          /* 单个文件拷不动就跳过（可能被占用） */
        }
      }
      // 符号链接一律跳过
    }
  }

  await walk(src, rootSafeDest(dest));
  return { bytes, files };
}

/** 确保目标目录在允许范围内（防路径逃逸） */
function rootSafeDest(dest) {
  const abs = path.resolve(dest);
  return abs;
}

/** 目录体积 */
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard < 500000) {
    const cur = stack.pop();
    guard += 1;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          bytes += fs.statSync(full).size;
          files += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes, files };
}

/** 时间戳（用于备份目录名，可排序） */
function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 世界目录名（从 server.properties 的 level-name 读） */
function worldName(home, id) {
  try {
    const props = require('./serverprops');
    const r = props.read(serverMod.workDir(home, id));
    const name = String(r.values['level-name'] || 'world').trim();
    return name || 'world';
  } catch {
    return 'world';
  }
}

/* ============================================================
 * 创建备份
 * ============================================================ */

/**
 * 创建一份备份。
 * @param {{reason?:string, full?:boolean, saveWorld?:boolean, onLog?:Function}} opts
 *        full=true 时连 mods/config/plugins/server.properties 一起备
 * @returns {Promise<{ok:boolean, name:string, dir:string, bytes:number, files:number, error?:string}>}
 */
async function create(home, id, opts = {}) {
  const sid = String(id || '');
  const work = serverMod.workDir(home, sid);
  if (!fs.existsSync(work)) {
    return { ok: false, name: '', dir: '', bytes: 0, files: 0, error: '服务端工作目录不存在' };
  }

  const reason = String(opts.reason || 'manual');
  const wname = worldName(home, sid);
  const worldPath = path.join(work, wname);
  if (!fs.existsSync(worldPath)) {
    return {
      ok: false,
      name: '',
      dir: '',
      bytes: 0,
      files: 0,
      error: `还没有世界数据（${wname} 目录不存在）。先启动一次服务端让它生成世界。`,
    };
  }

  // ① 让服务端先把世界写盘（关键！否则备份到的是半写状态）
  const rt = serverMod.getRuntime(sid);
  const running = !!(rt && rt.child && !rt.stopped);
  if (running && opts.saveWorld !== false) {
    try {
      serverMod.sendCommand(home, sid, 'save-off');
      serverMod.sendCommand(home, sid, 'save-all flush');
      if (typeof opts.onLog === 'function') opts.onLog('已通知服务端保存世界（save-off + save-all flush）');
      // 给服务端几秒钟真正写完
      await new Promise((r) => setTimeout(r, 2500));
    } catch {
      /* 保存失败也继续备份，但下面会记一笔 */
    }
  }

  const name = `${stampName()}-${reason}`;
  const dest = path.join(serverMod.backupsDir(home, sid), name);
  try {
    fs.mkdirSync(dest, { recursive: true });

    // ② 世界
    let total = { bytes: 0, files: 0 };
    const w = await copyDir(worldPath, path.join(dest, wname), {
      skip: ['session.lock'], // 会锁文件，跳掉
    });
    total.bytes += w.bytes;
    total.files += w.files;

    // ③ 配置快照
    const propsFile = path.join(work, 'server.properties');
    if (fs.existsSync(propsFile)) {
      await fsp.copyFile(propsFile, path.join(dest, 'server.properties')).catch(() => {});
    }
    for (const extra of ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']) {
      const f = path.join(work, extra);
      if (fs.existsSync(f)) await fsp.copyFile(f, path.join(dest, extra)).catch(() => {});
    }

    // ④ 全量备份：模组/插件/配置
    if (opts.full) {
      for (const sub of ['mods', 'config', 'plugins', 'defaultconfigs', 'scripts']) {
        const src = path.join(work, sub);
        if (!fs.existsSync(src)) continue;
        const r = await copyDir(src, path.join(dest, sub));
        total.bytes += r.bytes;
        total.files += r.files;
      }
    }

    // ⑤ 说明文件
    const meta = serverMod.readMeta(home, sid) || {};
    const info = {
      name,
      reason,
      full: !!opts.full,
      world: wname,
      created: Date.now(),
      bytes: total.bytes,
      files: total.files,
      serverKind: meta.kind || '',
      mcVersion: meta.mcVersion || '',
      wasRunning: running,
      savedBeforeBackup: running && opts.saveWorld !== false,
    };
    fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(info, null, 2), 'utf8');

    // ⑥ 恢复服务端的自动保存
    if (running && opts.saveWorld !== false) {
      try {
        serverMod.sendCommand(home, sid, 'save-on');
      } catch {
        /* ignore */
      }
    }

    return { ok: true, name, dir: dest, bytes: total.bytes, files: total.files, info };
  } catch (err) {
    // 失败时清掉半成品
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, name, dir: dest, bytes: 0, files: 0, error: err.message };
  }
}

/* ============================================================
 * 列出 / 删除 / 轮转
 * ============================================================ */

/** 列出全部备份（新→旧） */
function list(home, id) {
  const root = serverMod.backupsDir(home, id);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      info = null;
    }
    if (!info) {
      // 没有 meta.json 的（老版本或手工放的）按目录时间估算
      let st = null;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      info = { name, reason: 'unknown', created: st.mtimeMs, bytes: 0, files: 0 };
    }
    out.push({ ...info, dir, name });
  }
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out;
}

/** 删除一份备份 */
function remove(home, id, name) {
  const safe = String(name || '').replace(/[\\/]/g, '');
  if (!safe) return { ok: false, error: '备份名为空' };
  const dir = path.join(serverMod.backupsDir(home, id), safe);
  if (!fs.existsSync(dir)) return { ok: false, error: '备份不存在' };
  // 防逃逸：必须真的在 backups 目录里
  const root = path.resolve(serverMod.backupsDir(home, id));
  if (!path.resolve(dir).startsWith(root + path.sep)) return { ok: false, error: '路径非法' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/**
 * 轮转：只保留最新 keep 份。
 * @returns {{deleted:string[], kept:number}}
 */
function prune(home, id, keep = 10) {
  const n = Math.max(1, Number(keep) || 10);
  const all = list(home, id);
  const deleted = [];
  for (let i = n; i < all.length; i += 1) {
    const r = remove(home, id, all[i].name);
    if (r.ok) deleted.push(all[i].name);
  }
  return { deleted, kept: Math.min(n, all.length) };
}

/* ============================================================
 * 恢复
 * ============================================================ */

/**
 * 从备份恢复世界。
 * ★ 安全做法：先把当前世界**改名留底**（world.old-时间戳），再解回备份；
 *   解压失败时把旧的改回来。绝不直接删当前世界。
 *
 * @param {{name:string, onLog?:Function}} opts
 */
async function restore(home, id, opts = {}) {
  const sid = String(id || '');
  const name = String(opts.name || '').replace(/[\\/]/g, '');
  const src = path.join(serverMod.backupsDir(home, sid), name);
  if (!fs.existsSync(src)) return { ok: false, error: '备份不存在' };

  const rt = serverMod.getRuntime(sid);
  if (rt && rt.child && !rt.stopped) {
    return { ok: false, error: '服务端正在运行，请先停止再恢复（否则文件会被占用）' };
  }

  let info = {};
  try {
    info = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8'));
  } catch {
    /* ignore */
  }
  const wname = info.world || worldName(home, sid);
  const worldPath = path.join(serverMod.workDir(home, sid), wname);
  const srcWorld = path.join(src, wname);
  if (!fs.existsSync(srcWorld)) return { ok: false, error: `备份里没有世界目录（${wname}）` };

  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  // ① 当前世界改名留底
  let backupOfCurrent = '';
  if (fs.existsSync(worldPath)) {
    backupOfCurrent = `${worldPath}.old-${stampName()}`;
    try {
      fs.renameSync(worldPath, backupOfCurrent);
      log(`当前世界已改名留底：${path.basename(backupOfCurrent)}`);
    } catch (err) {
      return { ok: false, error: `无法移动当前世界（可能被占用）：${err.message}` };
    }
  }

  // ② 解回备份
  try {
    const r = await copyDir(srcWorld, worldPath);
    log(`已恢复 ${r.files} 个文件（${serverMod.formatBytes(r.bytes)}）`);
  } catch (err) {
    // 失败 → 把原来的改回来
    try {
      fs.rmSync(worldPath, { recursive: true, force: true });
      if (backupOfCurrent && fs.existsSync(backupOfCurrent)) fs.renameSync(backupOfCurrent, worldPath);
    } catch {
      /* ignore */
    }
    return { ok: false, error: `恢复失败，已回滚到原世界：${err.message}` };
  }

  // ③ 配置也一并恢复（可选）
  if (opts.withConfig !== false) {
    for (const f of ['server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']) {
      const s = path.join(src, f);
      if (!fs.existsSync(s)) continue;
      try {
        await fsp.copyFile(s, path.join(serverMod.workDir(home, sid), f));
        log(`配置已恢复：${f}`);
      } catch {
        /* ignore */
      }
    }
  }

  return { ok: true, world: wname, backupOfCurrent: backupOfCurrent || null };
}

/* ============================================================
 * 导出 zip
 * ============================================================ */

/**
 * 把一份备份打成 zip（便于分享）。
 * 用系统的 Compress-Archive（Windows 自带，不引第三方库）。
 */
async function exportZip(home, id, opts = {}) {
  const name = String(opts.name || '').replace(/[\\/]/g, '');
  const src = path.join(serverMod.backupsDir(home, id), name);
  if (!fs.existsSync(src)) return { ok: false, error: '备份不存在' };
  const outDir = opts.outDir || path.join(serverMod.serverDir(home, id), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${name}.zip`);

  if (process.platform === 'win32') {
    const { execFile } = require('node:child_process');
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Compress-Archive -Path '${src.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`],
        { windowsHide: true, timeout: 300000 },
        (err) => (err ? reject(err) : resolve())
      );
    }).catch((err) => {
      throw new Error(`打包失败：${err.message}`);
    });
  } else {
    const { execFile } = require('node:child_process');
    await new Promise((resolve, reject) => {
      execFile('zip', ['-r', '-q', zipPath, '.'], { cwd: src, timeout: 300000 }, (err) => (err ? reject(err) : resolve()));
    }).catch((err) => {
      throw new Error(`打包失败：${err.message}`);
    });
  }

  const st = fs.statSync(zipPath);
  return { ok: true, path: zipPath, bytes: st.size };
}

module.exports = {
  create,
  list,
  remove,
  prune,
  restore,
  exportZip,
  worldName,
  copyDir,
  dirSize,
  stampName,
};
