'use strict';
/*
 * worlds.js —— 存档管理（列表 / 详情 / 备份 / 恢复 / 导出 / 删除）。
 *
 * 参照 HMCL 的 WorldListPage / WorldManagePage / WorldBackupsPage / WorldExportPage，
 * 只做 PC 上真正用得上的部分。
 *
 * ## 存档在哪
 *   <home>/instances/<id>/.minecraft/saves/<folder>/
 * 每个存档目录里最关键的是 `level.dat`（**gzip 压缩的 NBT**），
 * 里面存着 世界名 / 版本 / 上次游玩时间 / 种子 / 游戏模式 / 是否硬核。
 * 本文件自带一个最小 NBT 解析器（只依赖 node:zlib），
 * 解析失败时**优雅降级**（只给文件夹名 + 目录大小，绝不抛错炸掉列表）。
 *
 * ## 备份 / 导出 / 删除的位置（全部在 QCL 主目录下，不碰系统目录）
 *   备份：<home>/backups/worlds/<folder>-<yyyymmdd-HHmmss>.zip
 *   导出：<home>/exports/<folder>-<yyyymmdd-HHmmss>.zip
 *   删除：移到 <home>/recycle/<folder>-<时间>（**不硬删**，防误操作）
 * 恢复前会先把现存档移到 recycle，再解压备份 —— 玩家不会因为一次误点丢存档。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const http = require('./http');
const paths = require('./paths');
const { createZip, readZip } = require('./zipwriter');

/** 存档太大时不建议在启动器里打包（zipwriter 是内存打包，防 OOM） */
const MAX_WORLD_BYTES = 512 * 1024 * 1024;

/** level.dat 里 gameType 的中文名 */
const GAME_MODES = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' };

/* ------------------------------------------------------------------ NBT 解析 */

/** 带偏移的二进制读取器（NBT 是大端序）。 */
function createReader(buf) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new Error('NBT 数据不完整（提前结束）');
  };
  return {
    get pos() {
      return pos;
    },
    u8() {
      need(1);
      const v = buf.readUInt8(pos);
      pos += 1;
      return v;
    },
    i8() {
      need(1);
      const v = buf.readInt8(pos);
      pos += 1;
      return v;
    },
    i16() {
      need(2);
      const v = buf.readInt16BE(pos);
      pos += 2;
      return v;
    },
    i32() {
      need(4);
      const v = buf.readInt32BE(pos);
      pos += 4;
      return v;
    },
    /** 64 位整数：安全范围内返回 number，否则返回十进制字符串（种子常见超大值）。 */
    i64() {
      need(8);
      const big = buf.readBigInt64BE(pos);
      pos += 8;
      const n = Number(big);
      return Number.isSafeInteger(n) ? n : big.toString();
    },
    f32() {
      need(4);
      const v = buf.readFloatBE(pos);
      pos += 4;
      return v;
    },
    f64() {
      need(8);
      const v = buf.readDoubleBE(pos);
      pos += 8;
      return v;
    },
    /** Java 的 modified UTF-8：普通字符与 UTF-8 一致，这里按 utf8 解码即可。 */
    str() {
      const len = this.u16();
      need(len);
      const s = buf.toString('utf8', pos, pos + len);
      pos += len;
      return s;
    },
    u16() {
      need(2);
      const v = buf.readUInt16BE(pos);
      pos += 2;
      return v;
    },
    skip(n) {
      need(n);
      pos += n;
    },
  };
}

/**
 * 读一个 NBT 值（按 tag type）。
 * 只需要 level.dat 里的标量/字符串/compound，其余类型解析成占位或直接跳过。
 */
function readNbtValue(type, r) {
  switch (type) {
    case 1: // TAG_Byte
      return r.i8();
    case 2: // TAG_Short
      return r.i16();
    case 3: // TAG_Int
      return r.i32();
    case 4: // TAG_Long
      return r.i64();
    case 5: // TAG_Float
      return r.f32();
    case 6: // TAG_Double
      return r.f64();
    case 7: { // TAG_Byte_Array
      const n = r.i32();
      r.skip(Math.max(0, n));
      return null;
    }
    case 8: // TAG_String
      return r.str();
    case 9: { // TAG_List
      const elemType = r.u8();
      const n = r.i32();
      if (n < 0 || n > 10_000_000) throw new Error('NBT 列表长度异常');
      const arr = [];
      for (let i = 0; i < n; i += 1) arr.push(readNbtValue(elemType, r));
      return arr;
    }
    case 10: { // TAG_Compound
      const obj = {};
      for (;;) {
        const t = r.u8();
        if (t === 0) break;
        const name = r.str();
        obj[name] = readNbtValue(t, r);
      }
      return obj;
    }
    case 11: { // TAG_Int_Array
      const n = r.i32();
      if (n < 0 || n > 10_000_000) throw new Error('NBT 整型数组长度异常');
      const arr = [];
      for (let i = 0; i < n; i += 1) arr.push(r.i32());
      return arr;
    }
    case 12: { // TAG_Long_Array
      const n = r.i32();
      if (n < 0 || n > 10_000_000) throw new Error('NBT 长整型数组长度异常');
      const arr = [];
      for (let i = 0; i < n; i += 1) arr.push(r.i64());
      return arr;
    }
    default:
      throw new Error(`未知的 NBT tag 类型：${type}`);
  }
}

/**
 * 解析 NBT 二进制（未压缩）。
 * @param {Buffer} buf
 * @returns {object} 根 compound
 */
function parseNbt(buf) {
  const r = createReader(buf);
  const type = r.u8();
  if (type !== 10) throw new Error('NBT 根标签不是 compound');
  r.str(); // 根标签名（通常是空串）
  return readNbtValue(10, r);
}

/**
 * 读 level.dat（自动识别 gzip / 未压缩）。
 * @param {string} file
 * @returns {{root:object, data:object}|null} 失败返回 null（不抛错）
 */
function readLevelDat(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (_) {
    return null;
  }
  if (!raw.length) return null;
  let plain = raw;
  // gzip 魔术字节 1f 8b
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      plain = zlib.gunzipSync(raw);
    } catch (_) {
      return null;
    }
  }
  try {
    const root = parseNbt(plain);
    const data = root && root.Data && typeof root.Data === 'object' ? root.Data : root;
    return { root, data: data || {} };
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ 通用工具 */

/** 统一的启动器错误（中文 + E_* 码） */
function worldError(message, code) {
  return new http.LauncherError(message, { code: code || 'E_WORLD' });
}

/** 存档目录名合法性（防目录穿越） */
function safeFolderName(folder) {
  const name = String(folder == null ? '' : folder).trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
    throw worldError(`存档目录名不合法：${name || '空'}`, 'E_WORLD_BAD_FOLDER');
  }
  return name;
}

/** 时间戳：yyyymmdd-HHmmss */
function stamp(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 递归收集目录里的文件（相对路径用 /） */
function collect(dir, prefix = '', out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      collect(abs, rel, out);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(abs);
        out.push({ abs, rel, size: st.size });
      } catch (_) {
        /* 读不到就跳过 */
      }
    }
  }
  return out;
}

/** 目录占用字节数 + 文件数 */
function measureDir(dir) {
  let bytes = 0;
  let count = 0;
  for (const f of collect(dir)) {
    bytes += f.size;
    count += 1;
  }
  return { bytes, count };
}

/** 实例的 .minecraft 目录 */
function gameDirOf(home, instanceId) {
  const h = paths.homeOf(home);
  const id = String(instanceId == null ? '' : instanceId).trim();
  if (!id) throw worldError('没有指定实例 id', 'E_WORLD_NO_INSTANCE');
  const mcDir = paths.gameDir(h, id);
  if (!fs.existsSync(mcDir)) throw worldError(`实例不存在或还没装游戏：${id}`, 'E_WORLD_NO_INSTANCE');
  return mcDir;
}

/** 存档根目录 */
function savesDirOf(home, instanceId) {
  return path.join(gameDirOf(home, instanceId), 'saves');
}

/** 某个存档目录（并校验没有目录穿越） */
function worldDir(home, instanceId, folder) {
  const name = safeFolderName(folder);
  const saves = savesDirOf(home, instanceId);
  const dir = path.join(saves, name);
  if (path.dirname(dir) !== saves) throw worldError(`存档路径不合法：${folder}`, 'E_WORLD_BAD_FOLDER');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw worldError(`存档不存在：${name}`, 'E_WORLD_NOT_FOUND');
  }
  return dir;
}

/** level.dat 里的时间（毫秒）→ ISO 字符串；无效返回 null */
function isoOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 从 level.dat 摘要出界面需要的字段（拿不到就 null）。
 * @param {string} dir 存档目录
 */
function readWorldMeta(dir) {
  const info = { name: null, version: null, lastPlayed: null, seed: null, gameMode: null, hardcore: false, levelFormat: null };
  const parsed = readLevelDat(path.join(dir, 'level.dat'));
  if (!parsed) return info;
  const d = parsed.data || {};
  if (d.LevelName !== undefined && d.LevelName !== null) info.name = String(d.LevelName);
  // 1.9+ 在 Data.Version.Name；更早的只有 Data.version（整型存档格式号，不是 MC 版本）
  if (d.Version && typeof d.Version === 'object' && d.Version.Name) info.version = String(d.Version.Name);
  else if (typeof d.version === 'number') info.levelFormat = d.version;
  if (d.LastPlayed !== undefined) info.lastPlayed = isoOf(d.LastPlayed);
  if (d.RandomSeed !== undefined) info.seed = d.RandomSeed; // number 或字符串（超大种子）
  if (d.GameType !== undefined) {
    const g = Number(d.GameType);
    info.gameMode = Number.isFinite(g) ? g : null;
  }
  info.hardcore = d.hardcore === 1 || d.hardcore === true;
  return info;
}

/* ------------------------------------------------------------------ 列表/详情 */

/**
 * 列出实例的所有存档。
 * @param {string} home
 * @param {string} instanceId
 * @returns {Array<{folder:string, name:string, version:string|null, sizeBytes:number,
 *                  lastPlayed:string|null, hasIcon:boolean}>}
 */
function list(home, instanceId) {
  const saves = savesDirOf(home, instanceId);
  let entries = [];
  try {
    entries = fs.readdirSync(saves, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const dir = path.join(saves, e.name);
    const meta = readWorldMeta(dir);
    const measure = measureDir(dir);
    let fallbackTime = null;
    try {
      const st = fs.statSync(path.join(dir, 'level.dat'));
      fallbackTime = isoOf(st.mtimeMs);
    } catch (_) {
      try {
        fallbackTime = isoOf(fs.statSync(dir).mtimeMs);
      } catch (_) {
        fallbackTime = null;
      }
    }
    out.push({
      folder: e.name,
      name: meta.name || e.name,
      version: meta.version,
      sizeBytes: measure.bytes,
      lastPlayed: meta.lastPlayed || fallbackTime,
      hasIcon: fs.existsSync(path.join(dir, 'icon.png')),
    });
  }
  // 最近玩的在前；没有时间的排最后
  out.sort((a, b) => {
    const ta = a.lastPlayed ? Date.parse(a.lastPlayed) : 0;
    const tb = b.lastPlayed ? Date.parse(b.lastPlayed) : 0;
    return tb - ta;
  });
  return out;
}

/**
 * 存档详情。
 * @returns {{folder:string, name:string, version:string|null, lastPlayed:string|null,
 *            sizeBytes:number, seed:number|string|null, gameMode:number|null,
 *            hardcore:boolean, fileCount:number}}
 */
function detail(home, instanceId, folder) {
  const dir = worldDir(home, instanceId, folder);
  const meta = readWorldMeta(dir);
  const measure = measureDir(dir);
  const mode = meta.gameMode;
  return {
    folder: safeFolderName(folder),
    name: meta.name || safeFolderName(folder),
    version: meta.version,
    lastPlayed: meta.lastPlayed,
    sizeBytes: measure.bytes,
    seed: meta.seed,
    gameMode: mode,
    // 额外给界面一个中文模式名（契约字段之外，纯便利）
    gameModeName: mode !== null && GAME_MODES[mode] ? GAME_MODES[mode] : null,
    hardcore: meta.hardcore,
    fileCount: measure.count,
  };
}

/* ------------------------------------------------------------ 打包（备份/导出） */

/**
 * 把一个存档目录打成 zip（条目名带 `<folder>/` 前缀，恢复时据此落盘）。
 * @returns {{file:string, name:string, sizeBytes:number, files:number}}
 */
function zipWorld(home, instanceId, folder, targetDir) {
  const name = safeFolderName(folder);
  const dir = worldDir(home, instanceId, name);
  const files = collect(dir);
  let total = 0;
  for (const f of files) total += f.size;
  if (total > MAX_WORLD_BYTES) {
    throw worldError(
      `这个存档有 ${(total / 1024 / 1024).toFixed(0)} MB，超过启动器单次打包上限（${MAX_WORLD_BYTES / 1024 / 1024} MB），请先用系统压缩软件手动备份。`,
      'E_WORLD_TOO_BIG'
    );
  }

  const entries = [];
  for (const f of files) {
    try {
      entries.push({ name: `${name}/${f.rel}`, data: fs.readFileSync(f.abs) });
    } catch (_) {
      /* 单个文件读不到就跳过（被游戏占用等） */
    }
  }
  // 空目录存档也要能备份：至少写一个目录条目
  if (!entries.length) entries.push({ name: `${name}/`, isDirectory: true });

  fs.mkdirSync(targetDir, { recursive: true });
  const base = `${name}-${stamp()}`;
  let fileName = `${base}.zip`;
  let i = 1;
  while (fs.existsSync(path.join(targetDir, fileName))) {
    fileName = `${base}-${i}.zip`;
    i += 1;
  }
  const outPath = path.join(targetDir, fileName);
  createZip(outPath, entries);
  const sizeBytes = fs.statSync(outPath).size;
  return { file: outPath, name: fileName, sizeBytes, files: entries.length };
}

/** 备份存档到 <home>/backups/worlds/ */
function backup(home, instanceId, folder) {
  const target = path.join(paths.homeOf(home), 'backups', 'worlds');
  const r = zipWorld(home, instanceId, folder, target);
  return { file: r.file, sizeBytes: r.sizeBytes, name: r.name, files: r.files };
}

/** 导出存档到 <home>/exports/ */
function exportWorld(home, instanceId, folder) {
  const target = path.join(paths.homeOf(home), 'exports');
  const r = zipWorld(home, instanceId, folder, target);
  return { file: r.file, sizeBytes: r.sizeBytes, name: r.name, files: r.files };
}

/* ---------------------------------------------------------------- 备份列表 */

/** 备份目录 */
function backupsDirOf(home) {
  return path.join(paths.homeOf(home), 'backups', 'worlds');
}

/**
 * 列出某个存档的历史备份（按时间新→旧）。
 * @returns {Array<{file:string, name:string, sizeBytes:number, time:string|null}>}
 */
function listBackups(home, instanceId, folder) {
  const name = safeFolderName(folder);
  const dir = backupsDirOf(home);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.zip') && n.startsWith(`${name}-`));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const n of files) {
    const abs = path.join(dir, n);
    try {
      const st = fs.statSync(abs);
      out.push({ file: abs, name: n, sizeBytes: st.size, time: isoOf(st.mtimeMs) });
    } catch (_) {
      /* 读不到就跳过 */
    }
  }
  out.sort((a, b) => {
    const ta = a.time ? Date.parse(a.time) : 0;
    const tb = b.time ? Date.parse(b.time) : 0;
    return tb - ta;
  });
  return out;
}

/** 把 user 传来的备份 file 解析成真实路径（只允许 backups/worlds 下的 zip） */
function resolveBackupFile(home, file) {
  const raw = String(file == null ? '' : file).trim();
  if (!raw) throw worldError('没有指定备份文件', 'E_WORLD_BAD_BACKUP');
  const dir = backupsDirOf(home);
  const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.join(dir, path.basename(raw));
  const rel = path.relative(dir, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw worldError(`备份文件不在备份目录（<home>/backups/worlds）里：${raw}`, 'E_WORLD_BAD_BACKUP');
  }
  if (!fs.existsSync(candidate)) throw worldError(`备份文件不存在：${raw}`, 'E_WORLD_BAD_BACKUP');
  return candidate;
}

/* ------------------------------------------------------------------ 恢复/删除 */

/** 把一个目录移到回收站（不硬删）；返回新路径 */
function moveToRecycle(home, dir, label) {
  const recycle = path.join(paths.homeOf(home), 'recycle');
  fs.mkdirSync(recycle, { recursive: true });
  const base = `${label}-${stamp()}`;
  let target = path.join(recycle, base);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(recycle, `${base}-${i}`);
    i += 1;
  }
  try {
    fs.renameSync(dir, target);
  } catch (_) {
    // 跨盘等情况：退回复制后删
    copyDir(dir, target);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return target;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 从备份恢复存档：先把现存档移到 recycle，再解压备份到 saves/<folder>。
 * @returns {{ok:boolean, folder:string, file:string, extracted:number, movedTo?:string}}
 */
function restore(home, instanceId, folder, file) {
  const name = safeFolderName(folder);
  const saves = savesDirOf(home, instanceId);
  const backupFile = resolveBackupFile(home, file);
  const entries = readZip(backupFile);
  if (!entries.length) throw worldError(`备份文件是空的：${path.basename(backupFile)}`, 'E_WORLD_BAD_BACKUP');

  // 备份里是 <folder>/xxx 结构；如果名字对不上（用户改过文件夹名），按 zip 里的顶层目录落盘
  const topLevels = new Set();
  for (const e of entries) {
    const seg = String(e.name || '').split('/')[0];
    if (seg) topLevels.add(seg);
  }
  const sourcePrefix = topLevels.size === 1 ? `${[...topLevels][0]}/` : `${name}/`;

  const targetDir = path.join(saves, name);
  let movedTo = null;
  if (fs.existsSync(targetDir)) {
    movedTo = moveToRecycle(home, targetDir, name);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  let extracted = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    let rel = String(e.name || '');
    if (!rel.startsWith(sourcePrefix)) {
      // 不在预期前缀下：跳过，避免把备份里的奇怪路径写出去
      continue;
    }
    rel = rel.slice(sourcePrefix.length);
    if (!rel) continue;
    const target = path.normalize(path.join(targetDir, rel));
    if (!target.startsWith(targetDir + path.sep)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
      extracted += 1;
    } catch (_) {
      /* 单个文件写失败不影响其它文件 */
    }
  }
  return { ok: true, folder: name, file: backupFile, extracted, movedTo };
}

/**
 * 删除存档（移到 <home>/recycle，不硬删）。
 * @returns {{ok:boolean, folder:string, movedTo:string}}
 */
function remove(home, instanceId, folder) {
  const name = safeFolderName(folder);
  const dir = worldDir(home, instanceId, name);
  const movedTo = moveToRecycle(home, dir, name);
  return { ok: true, folder: name, movedTo };
}

module.exports = {
  // 查询
  list,
  detail,
  listBackups,
  // 操作
  backup,
  exportWorld,
  restore,
  remove,
  // 路径 / 工具（IPC 打开目录、测试脚本会用到）
  worldDir,
  savesDirOf,
  backupsDirOf,
  // 解析（测试脚本用）
  readLevelDat,
  parseNbt,
  MAX_WORLD_BYTES,
  GAME_MODES,
};
