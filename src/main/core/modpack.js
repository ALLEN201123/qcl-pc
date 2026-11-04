'use strict';
/**
 * Quanta Craft Launcher PC · 整合包导出 / 导入
 *
 * 参照 HMCL 的 ModpackExportInfo / ModpackFile / ModpackManifest，只实现 PC 上最实用的子集。
 *
 * ## 导出
 * 打一个 `.zip`，结构与主流整合包兼容：
 *   manifest.json    —— 魔数 + 版本 + 游戏版本 + 加载器 + 模组清单（含 sha1，便于校验）
 *   overrides/       —— 直接覆盖到 .minecraft 的内容（config / saves / resourcepacks / 部分模组）
 *   mods/            —— 模组 jar（放在 overrides 外更利于复用，按 CurseForge 习惯）
 *
 * ## 导入
 * 认两种：
 *   1. 我们导出的 zip（含 manifest.json）
 *   2. 任意「人工打包的 .minecraft 文件夹」zip —— 检测到没有 manifest 就走「整包覆盖」，
 *      这与手机版一致（安卓版会提示「该整合包不是启动器导出的，是否继续」）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createZip, readZip } = require('./zipwriter');
const http = require('./http');

const MANIFEST = 'manifest.json';
const FORMAT_NAME = 'qcl-modpack';
const FORMAT_VERSION = 1;

/** 算 sha1 */
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 递归收集目录里的文件（相对路径） */
function collect(dir, prefix = '', out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) collect(abs, rel, out);
    else out.push({ abs, rel });
  }
  return out;
}

/**
 * 导出整合包。
 *
 * @param {{home:string, instance:object, includeSaves?:boolean,
 *          includeConfig?:boolean, includeResourcePacks?:boolean, includeMods?:boolean,
 *          onLog?:Function}} opts
 *   · includeMods           默认 true（模组 jar）
 *   · includeConfig         默认 true（config / defaultconfigs）
 *   · includeResourcePacks  默认 true（resourcepacks / shaderpacks）
 *   · includeSaves          默认 false（存档很大，要玩家明确勾选）
 * @returns {Promise<{file:string, dir:string, bytes:number, sizeBytes:number, mods:number, overrides:number}>}
 */
async function exportModpack(opts) {
  const {
    home,
    instance,
    includeSaves = false,
    includeConfig = true,
    includeResourcePacks = true,
    includeMods = true,
    onLog = () => {},
  } = opts || {};
  if (!instance || !instance.dir) throw new http.LauncherError('实例信息不完整', { code: 'E_MODPACK_PARAMS' });
  const mcDir = path.join(instance.dir, '.minecraft');
  if (!fs.existsSync(mcDir)) throw new http.LauncherError(`找不到实例的游戏目录：${mcDir}`, { code: 'E_MODPACK_NO_DIR' });

  const outDir = path.join(String(home || ''), 'modpacks');
  fs.mkdirSync(outDir, { recursive: true });

  const entries = [];
  const modList = [];

  // 1. 模组（含 sha1，便于导入时校验）
  const modsDir = path.join(mcDir, 'mods');
  if (includeMods !== false && fs.existsSync(modsDir)) {
    for (const f of collect(modsDir)) {
      // 只带启用中的 jar
      if (!/\.jar$/i.test(f.rel)) continue;
      const data = fs.readFileSync(f.abs);
      entries.push({ name: `overrides/mods/${f.rel}`, data });
      modList.push({ file: f.rel, sha1: sha1(data), size: data.length });
    }
  }
  onLog(`模组 ${modList.length} 个`);

  // 2. overrides：配置 / 资源包 / 光影 /（可选）存档
  const overrideDirs = [];
  if (includeConfig !== false) overrideDirs.push('config', 'defaultconfigs');
  if (includeResourcePacks !== false) overrideDirs.push('resourcepacks', 'shaderpacks');
  if (includeSaves) overrideDirs.push('saves');
  let overrideCount = 0;
  for (const d of overrideDirs) {
    const abs = path.join(mcDir, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of collect(abs)) {
      try {
        const st = fs.statSync(f.abs);
        if (st.size > 256 * 1024 * 1024) continue; // 单文件 256MB 上限
        entries.push({ name: `overrides/${d}/${f.rel}`, data: fs.readFileSync(f.abs) });
        overrideCount += 1;
      } catch {
        /* 跳过读不到的文件 */
      }
    }
  }
  onLog(`配置/资源包等 ${overrideCount} 个文件`);

  // 3. manifest
  const manifest = {
    formatName: FORMAT_NAME,
    formatVersion: FORMAT_VERSION,
    name: instance.name || instance.mcVersion || 'QCL 整合包',
    mcVersion: instance.mcVersion,
    loader: instance.loader || null,
    chinesePack: instance.chinesePack || null,
    exportedAt: new Date().toISOString(),
    exportedBy: 'Quanta Craft Launcher PC',
    files: modList
  };
  entries.push({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = String(manifest.name).replace(/[\\/:*?"<>|]/g, '_');
  let fileName = `${safe}_${stamp}.zip`;
  let i = 1;
  while (fs.existsSync(path.join(outDir, fileName))) {
    fileName = `${safe}_${stamp}-${i}.zip`;
    i += 1;
  }
  const outPath = path.join(outDir, fileName);

  onLog('打包中…');
  createZip(outPath, entries);
  const bytes = fs.statSync(outPath).size;
  onLog(`整合包已导出：${outPath}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);

  return { file: fileName, dir: outDir, bytes, sizeBytes: bytes, mods: modList.length, overrides: overrideCount };
}

/**
 * 给 inspect 结果补上 IPC 契约字段（`version / modCount / fileCount / format`），
 * 同时保留原有字段（`isModpack / ours / mcVersion / mods / files`）不破坏老调用方。
 */
function shapeInspect(info) {
  const it = info || {};
  return {
    ...it,
    version: it.mcVersion || null,
    modCount: Number(it.mods) || 0,
    fileCount: Number(it.files) || 0,
    // format: 'qcl' = 启动器导出的；'manifest' = 其它启动器带 manifest 的；'raw' = 直接压的 .minecraft
    format: it.ours ? 'qcl' : (it.rawPack ? 'raw' : 'manifest'),
  };
}

/**
 * 检查一个 zip 是不是整合包，返回元信息（不真正导入）。
 *
 * @returns {{isModpack:boolean, ours:boolean, name?:string, mcVersion?:string, loader?:object,
 *            mods?:number, files?:number, version:string|null, modCount:number,
 *            fileCount:number, format:'qcl'|'manifest'|'raw'}}
 */
function inspectModpack(zipPath) {
  const entries = readZip(zipPath);
  const names = entries.map((e) => e.name);
  const manifestEntry = entries.find((e) => e.name.toLowerCase() === MANIFEST.toLowerCase());
  if (manifestEntry) {
    try {
      const m = JSON.parse(manifestEntry.data.toString('utf8'));
      if (m && m.formatName === FORMAT_NAME) {
        return shapeInspect({
          isModpack: true,
          ours: true,
          name: m.name,
          mcVersion: m.mcVersion,
          loader: m.loader || null,
          mods: Array.isArray(m.files) ? m.files.length : 0,
          files: names.length
        });
      }
      // 别的启动器的 manifest 也能认（缺少字段就给默认）
      return shapeInspect({
        isModpack: true,
        ours: false,
        name: m.name || m.modpackName || path.basename(zipPath, '.zip'),
        mcVersion: m.mcVersion || m.minecraft || null,
        loader: m.loader || null,
        mods: Array.isArray(m.files) ? m.files.length : 0,
        files: names.length
      });
    } catch {
      /* 落到下面 */
    }
  }
  // 没有 manifest：看有没有 .minecraft 的结构特征
  const looksLikeGame = names.some((n) => /(^|\/)mods\//.test(n)) || names.some((n) => /(^|\/)saves\//.test(n)) || names.some((n) => /(^|\/)config\//.test(n));
  return shapeInspect({
    isModpack: looksLikeGame,
    ours: false,
    name: path.basename(zipPath, '.zip'),
    files: names.length,
    rawPack: true
  });
}

/**
 * 导入整合包到指定实例。
 *
 * @param {object} opts
 * @param {string} opts.zipPath
 * @param {string} opts.instanceDir
 * @param {boolean} [opts.overwriteFiles] 已存在同名文件是否覆盖（默认 true）
 * @returns {Promise<{extracted:number, skipped:number, hadManifest:boolean, name:string}>}
 */
async function importModpack({ zipPath, instanceDir, overwriteFiles = true, onLog = () => {} }) {
  const mcDir = path.join(String(instanceDir || ''), '.minecraft');
  fs.mkdirSync(mcDir, { recursive: true });

  const entries = readZip(zipPath);
  const info = inspectModpack(zipPath);
  let extracted = 0;
  let skipped = 0;

  for (const e of entries) {
    if (e.isDirectory) continue;
    let rel = e.name;
    if (rel.toLowerCase() === MANIFEST.toLowerCase()) continue;

    // 去掉 overrides/ 前缀（我们的格式）
    if (rel.startsWith('overrides/')) rel = rel.slice('overrides/'.length);
    // 去掉 .minecraft/ 前缀（人工打包常见）
    if (rel.startsWith('.minecraft/')) rel = rel.slice('.minecraft/'.length);
    // 安全：禁止目录穿越
    const target = path.normalize(path.join(mcDir, rel));
    if (!target.startsWith(mcDir + path.sep) && target !== mcDir) {
      skipped += 1;
      continue;
    }
    if (!overwriteFiles && fs.existsSync(target)) {
      skipped += 1;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
      extracted += 1;
    } catch (err) {
      onLog(`写入失败（${rel}）：${err?.message || err}`);
      skipped += 1;
    }
  }

  onLog(`导入完成：写入 ${extracted} 个文件，跳过 ${skipped} 个`);
  return { extracted, skipped, hadManifest: info.ours, name: info.name || '' };
}

/**
 * 把整合包导入到**一个新实例**（IPC `modpack:import` 的实现）。
 *
 * 流程：先 inspect 拿名字/游戏版本 → instances.create 建实例 → importModpack 解包。
 * ★ 只解「玩家数据」（mods / config / saves / resourcepacks…），**不含** 游戏本体，
 *   所以导入完仍需要玩家在「版本」里装对应游戏版本（与 HMCL 的整合包导入语义一致）。
 *
 * @param {{home:string, zipPath:string, name?:string, overwriteFiles?:boolean, onLog?:Function}} opts
 * @returns {Promise<{instanceId:string, instance:object, extracted:number, skipped:number, info:object}>}
 */
async function importToNewInstance(opts) {
  const { home, zipPath, name, overwriteFiles = true, onLog = () => {} } = opts || {};
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new http.LauncherError(`整合包文件不存在：${zipPath || '（空）'}`, { code: 'E_MODPACK_FILE' });
  }
  // eslint-disable-next-line global-require
  const instances = require('./instances');

  const info = inspectModpack(zipPath);
  if (!info.isModpack) {
    throw new http.LauncherError('这个 zip 不像整合包（里面没有 manifest.json，也没有 mods / config / saves 目录）', { code: 'E_MODPACK_NOT_PACK' });
  }

  const mcVersion = info.mcVersion || '';
  const displayName = String(name || info.name || path.basename(zipPath, '.zip') || '导入的整合包').trim();
  onLog(`准备导入：${displayName}（${mcVersion || '未知游戏版本'}，${info.format} 格式）`);

  const instance = await instances.create(String(home || ''), {
    name: displayName,
    mcVersion,
    loader: info.loader || undefined,
  });
  onLog(`已创建实例：${instance.name}（${instance.id}）`);

  const result = await importModpack({
    zipPath,
    instanceDir: instance.dir,
    overwriteFiles: overwriteFiles !== false,
    onLog,
  });

  return {
    instanceId: instance.id,
    instance: await instances.get(String(home || ''), instance.id),
    extracted: result.extracted,
    skipped: result.skipped,
    info,
  };
}

/** 列出已导出的整合包（附 IPC 契约字段：file / name / sizeBytes / time） */
function listModpacks(home) {
  const dir = path.join(String(home || ''), 'modpacks');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.zip'));
  } catch {
    return [];
  }
  return names.map((n) => {
    try {
      const st = fs.statSync(path.join(dir, n));
      return {
        file: path.join(dir, n),
        name: n.replace(/\.zip$/i, ''),
        sizeBytes: st.size,
        // 与 worlds 那边统一：ISO 时间字符串
        time: new Date(st.mtimeMs).toISOString(),
        // 老字段保留，避免已有调用方坏掉
        path: path.join(dir, n),
        bytes: st.size,
        mtime: st.mtimeMs,
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

module.exports = { exportModpack, importModpack, importToNewInstance, inspectModpack, listModpacks, FORMAT_NAME };
