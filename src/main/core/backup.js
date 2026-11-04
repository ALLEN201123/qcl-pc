'use strict';
/**
 * Quanta Craft Launcher PC · 实例备份
 *
 * 把整个实例目录（含 .minecraft：存档、配置、模组）打包成 zip，
 * 存到 `<QCL_HOME>/backups/`。换电脑 / 重装系统时直接带走。
 *
 * 为什么不备份 assets 和 libraries：
 *   这两块动辄几 GB，而且是「可重新下载」的公共数据。
 *   备份只保留**玩家自己产生的东西**：存档、配置、模组、资源包、截图。
 *   真要全量带走，用「导出整合包」而不是备份。
 */

const fs = require('node:fs');
const path = require('node:path');

const { createZip } = require('./zipwriter');

/** 备份时**跳过**的目录（相对 .minecraft） */
const SKIP_DIRS = new Set(['assets', 'libraries', 'versions', 'natives', 'logs', 'crash-reports', 'temp', 'logs']);

/** 单个文件大小上限（超过就跳过，避免备份变成几十 GB） */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** 递归收集文件 */
function collectFiles(rootDir, basePrefix = '', out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(rootDir, e.name);
    const rel = basePrefix ? `${basePrefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      collectFiles(abs, rel, out);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        out.push({ abs, rel, size: st.size });
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return out;
}

/** 生成一个不会重名的备份文件名 */
function uniqueName(dir, base, ext) {
  let name = `${base}${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base}-${i}${ext}`;
    i += 1;
  }
  return name;
}

/**
 * 备份一个实例。
 *
 * @param {object} opts
 * @param {string} opts.home         QCL 主目录（备份存到 <home>/backups）
 * @param {object} opts.instance     实例对象（要有 dir / name）
 * @param {function} [opts.onLog]
 * @returns {Promise<{file:string, dir:string, bytes:number, files:number}>}
 */
async function backupInstance({ home, instance, onLog = () => {} }) {
  if (!instance || !instance.dir) throw new Error('实例信息不完整，无法备份');
  if (!fs.existsSync(instance.dir)) throw new Error(`实例目录不存在：${instance.dir}`);

  const backupsDir = path.join(String(home || ''), 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const mcDir = path.join(instance.dir, '.minecraft');
  const rootDir = fs.existsSync(mcDir) ? mcDir : instance.dir;

  onLog(`收集文件：${rootDir}`);
  const files = collectFiles(rootDir, '');
  if (files.length === 0) throw new Error('实例目录里没有可备份的文件');

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  onLog(`共 ${files.length} 个文件，${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = String(instance.name || instance.mcVersion || 'instance').replace(/[\\/:*?"<>|]/g, '_');
  const fileName = uniqueName(backupsDir, `${safeName}_${stamp}`, '.zip');
  const outPath = path.join(backupsDir, fileName);

  // 组装 zip 条目：外加一份 instance.json 便于恢复时识别
  const entries = [];
  for (const f of files) {
    entries.push({ name: f.rel, data: fs.readFileSync(f.abs) });
  }
  // 清单
  const manifest = {
    qclBackup: 1,
    instanceName: instance.name,
    mcVersion: instance.mcVersion,
    loader: instance.loader || null,
    chinesePack: instance.chinesePack || null,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes
  };
  entries.push({ name: '_qcl-backup.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  onLog(`打包中：${fileName}`);
  const result = createZip(outPath, entries);

  const bytes = fs.statSync(outPath).size;
  onLog(`备份完成：${outPath}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);

  return { file: fileName, dir: backupsDir, bytes, files: files.length, entries: result.entries };
}

/** 列出已有备份 */
function listBackups(home) {
  const dir = path.join(String(home || ''), 'backups');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.zip'));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      try {
        const st = fs.statSync(path.join(dir, n));
        return { file: n, bytes: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = { backupInstance, listBackups };
