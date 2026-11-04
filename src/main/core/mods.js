'use strict';
/**
 * Quanta Craft Launcher PC · 模组 / 资源包 / 世界 管理
 *
 * 参照 HMCL 的 addon 模块（AddonLoaderType / LocalAddonFile / FabricModMetadata /
 * ForgeNewModMetadata / ForgeOldModMetadata），只做 PC 上真正用得上的部分：
 *
 *   · 列出 mods/ 下的文件，从 jar 里读出**显示名与版本**（不是只显示文件名）
 *   · 启用 / 禁用（改名 .jar ↔ .jar.disabled，这是业界通行做法，不破坏文件内容）
 *   · 删除（移到回收目录，不直接删，防止误操作）
 *   · 资源包 / 世界 的列出与删除
 *
 * ★ 注意：用户提过手机版「模组管理图标显示不出来」—— 那是因为只读了文件名清单，
 *   没做真正的元数据解析。这里从 jar 内读取：
 *      Fabric  → fabric.mod.json 的 id / name / version
 *      Forge   → META-INF/mods.toml 或 mcmod.info
 *      远古版   → 没有元数据，退回文件名
 */

const fs = require('node:fs');
const path = require('node:path');

const zip = require('./zip');

/** 从 jar 里读一个文本文件（限制大小） */
function readEntryText(jarPath, entryName, maxBytes = 256 * 1024) {
  try {
    const handle = zip.open(jarPath);
    const entry = handle.entries.find((e) => e.name.toLowerCase() === entryName.toLowerCase());
    if (!entry) return null;
    if (entry.uncompressedSize > maxBytes) return null;
    const buf = handle.readEntry(entry);
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** 极简 TOML 取值：只抓顶层 `key = "value"` 与 `[[mods]]` 段里的同名字段 */
function pickTomlValue(text, key) {
  if (!text) return null;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'im');
  const m = text.match(re);
  return m ? m[1] : null;
}

/** 从 mcmod.info（JSON 数组）里取第一个条目 */
function pickMcmodInfo(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const first = Array.isArray(data) ? data[0] : data && data.modListSize ? data.modList?.[0] : data;
    if (!first || typeof first !== 'object') return null;
    return {
      id: first.modid || first.modId || first.id || null,
      name: first.name || null,
      version: first.version || null,
      description: first.description || null
    };
  } catch {
    return null;
  }
}

/**
 * 从 jar 里读出模组图标，转成 data URL。
 *
 * ★★★ 这是「模组管理图标显示不出来」的正解。
 *   手机版只列文件名，从来没去 jar 里找过 icon，所以永远显示不出图标。
 *   PC 版按各加载器的约定去读：
 *     · Fabric / Quilt ：fabric.mod.json 的 `"icon"` 字段（可能是单个路径或 {size:path} 映射）
 *     · Forge / NeoForge：META-INF/mods.toml 的 `logoFile`
 *     · 远古 Forge      ：mcmod.info 的 `logoFile`
 *   PNG/JPG 直接读字节，转 `data:image/png;base64,...` 交给渲染层 <img>。
 *
 * @returns {string|null} data URL；找不到就 null（界面回落到内置图标）
 */
function readModIcon(filePath) {
  const candidates = [];

  // 1. Fabric
  const fabricText = readEntryText(filePath, 'fabric.mod.json');
  if (fabricText) {
    try {
      const j = JSON.parse(fabricText);
      const ic = j.icon;
      if (typeof ic === 'string') candidates.push(ic);
      else if (ic && typeof ic === 'object') {
        // {"128": "assets/x/icon_128.png", "64": "..."} 取最大尺寸
        const sizes = Object.keys(ic)
          .map((k) => Number(k))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => b - a);
        for (const s of sizes) if (typeof ic[s] === 'string' || typeof ic[String(s)] === 'string') candidates.push(ic[String(s)]);
        for (const v of Object.values(ic)) if (typeof v === 'string') candidates.push(v);
      }
    } catch {
      /* 忽略 */
    }
  }

  // 2. Forge / NeoForge
  const tomlText = readEntryText(filePath, 'META-INF/mods.toml') || readEntryText(filePath, 'META-INF/neoforge.mods.toml');
  if (tomlText) {
    const logo = pickTomlValue(tomlText, 'logoFile') || pickTomlValue(tomlText, 'logoBlob');
    if (logo) candidates.push(logo);
  }

  // 3. 老 Forge mcmod.info
  const mcmodText = readEntryText(filePath, 'mcmod.info');
  if (mcmodText) {
    try {
      const data = JSON.parse(mcmodText);
      const first = Array.isArray(data) ? data[0] : data;
      if (first && first.logoFile) candidates.push(first.logoFile);
    } catch {
      /* 忽略 */
    }
  }

  // 4. 常见兜底路径
  candidates.push('pack.png', 'logo.png', 'icon.png');

  // 逐个尝试，读到第一个能用的就返回
  let handle = null;
  try {
    handle = zip.open(filePath);
  } catch {
    return null;
  }
  const entryNames = handle.entries.map((e) => e.name.toLowerCase());

  for (const rel of candidates) {
    if (!rel) continue;
    const want = String(rel).replace(/^\/+/, '').toLowerCase();
    const idx = entryNames.indexOf(want);
    if (idx < 0) continue;
    const entry = handle.entries[idx];
    // 图标不该太大（>512KB 基本不是图标）
    if (entry.uncompressedSize > 512 * 1024) continue;
    try {
      const buf = handle.readEntry(entry);
      const ext = want.slice(want.lastIndexOf('.'));
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/**
 * 解析一个模组文件的元数据。
 * @returns {{name:string, id:string|null, version:string|null, loader:string, description:string|null}}
 */
function readModMetadata(filePath) {
  const base = path.basename(filePath).replace(/\.jar\.disabled$/i, '').replace(/\.jar$/i, '');

  // Fabric / Quilt
  const fabricText = readEntryText(filePath, 'fabric.mod.json');
  if (fabricText) {
    try {
      const j = JSON.parse(fabricText);
      return {
        name: j.name || base,
        id: j.id || null,
        version: j.version || null,
        loader: 'fabric',
        description: j.description || null
      };
    } catch {
      /* 落到下一个 */
    }
  }

  // NeoForge / Forge（新）
  const tomlText = readEntryText(filePath, 'META-INF/neoforge.mods.toml') || readEntryText(filePath, 'META-INF/mods.toml');
  if (tomlText) {
    const isNeo = /neoforge/i.test(tomlText);
    return {
      name: pickTomlValue(tomlText, 'displayName') || pickTomlValue(tomlText, 'modId') || base,
      id: pickTomlValue(tomlText, 'modId'),
      version: pickTomlValue(tomlText, 'version'),
      loader: isNeo ? 'neoforge' : 'forge',
      description: pickTomlValue(tomlText, 'description')
    };
  }

  // Forge（老）
  const mcmod = pickMcmodInfo(readEntryText(filePath, 'mcmod.info'));
  if (mcmod) {
    return {
      name: mcmod.name || base,
      id: mcmod.id,
      version: mcmod.version,
      loader: 'forge',
      description: mcmod.description
    };
  }

  // 远古版本 / 无元数据：退回文件名
  return { name: base, id: null, version: null, loader: 'unknown', description: null };
}

/** 列一个目录下的条目（只统计文件） */
function listFiles(dir, exts) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isFile()) {
      const lower = e.name.toLowerCase();
      if (exts && !exts.some((x) => lower.endsWith(x))) continue;
      try {
        const st = fs.statSync(abs);
        out.push({ file: e.name, path: abs, bytes: st.size, mtime: st.mtimeMs, enabled: !lower.endsWith('.disabled') });
      } catch {
        /* 忽略 */
      }
    } else if (e.isDirectory() && !exts) {
      // 资源包/世界可能是目录
      out.push({ file: e.name, path: abs, bytes: 0, mtime: 0, enabled: true, isDir: true });
    }
  }
  return out;
}

/** 列出模组（含元数据 + 图标） */
function listMods(instanceDir) {
  const modsDir = path.join(String(instanceDir || ''), '.minecraft', 'mods');
  const files = listFiles(modsDir, ['.jar', '.jar.disabled', '.zip', '.zip.disabled']);
  return files.map((f) => {
    const enabled = !/\.disabled$/i.test(f.file);
    let meta = { name: f.file, id: null, version: null, loader: 'unknown', description: null };
    let iconDataUrl = null;
    if (/\.jar(\.disabled)?$/i.test(f.file)) {
      meta = readModMetadata(f.path);
      // ★ 读图标（手机版从没做过这件事，所以图标永远空白）
      try {
        iconDataUrl = readModIcon(f.path);
      } catch {
        iconDataUrl = null;
      }
    }
    return {
      file: f.file,
      path: f.path,
      bytes: f.bytes,
      enabled,
      name: meta.name || f.file,
      id: meta.id,
      version: meta.version,
      loader: meta.loader,
      description: meta.description,
      iconDataUrl
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 启用 / 禁用（改名，不动内容） */
function setModEnabled(filePath, enabled) {
  const p = String(filePath || '');
  if (!p) throw new Error('路径为空');
  const isDisabled = /\.disabled$/i.test(p);
  if (enabled && isDisabled) {
    const target = p.replace(/\.disabled$/i, '');
    fs.renameSync(p, target);
    return { path: target, enabled: true };
  }
  if (!enabled && !isDisabled) {
    const target = `${p}.disabled`;
    fs.renameSync(p, target);
    return { path: target, enabled: false };
  }
  return { path: p, enabled: !isDisabled };
}

/** 删除到回收目录（不直接删，防误操作） */
function moveToTrash(home, filePath) {
  const trashDir = path.join(String(home || ''), 'recycle');
  fs.mkdirSync(trashDir, { recursive: true });
  const base = path.basename(filePath);
  let target = path.join(trashDir, base);
  let i = 1;
  while (fs.existsSync(target)) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    target = path.join(trashDir, `${stem}-${i}${ext}`);
    i += 1;
  }
  fs.renameSync(filePath, target);
  return { movedTo: target };
}

/** 列出资源包 / 世界 */
function listResourcePacks(instanceDir) {
  const dir = path.join(String(instanceDir || ''), '.minecraft', 'resourcepacks');
  return listFiles(dir, null).map((f) => ({ file: f.file, path: f.path, bytes: f.bytes, isDir: !!f.isDir }));
}

/**
 * ★ 2026-11-05：光影 / 数据包 / 资源包统一入口（照 HMCL 的 AddonListPage）。
 *   这四类目录结构一致（.zip 文件或目录，`.disabled` 表示停用），所以一个函数够用。
 *
 * @param {string} instanceDir 实例根目录（含 .minecraft）
 * @param {'mods'|'resourcepacks'|'shaderpacks'|'datapacks'} kind
 */
const ADDON_SUBDIRS = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  datapacks: 'datapacks'
};

function addonDir(instanceDir, kind) {
  const sub = ADDON_SUBDIRS[String(kind || 'mods')] || 'mods';
  return path.join(String(instanceDir || ''), '.minecraft', sub);
}

function listAddonDir(instanceDir, kind) {
  const dir = addonDir(instanceDir, kind);
  return listFiles(dir, null).map((f) => ({
    file: f.file,
    path: f.path,
    bytes: f.bytes,
    mtime: f.mtime,
    isDir: !!f.isDir,
    enabled: !/\.disabled$/i.test(f.file)
  }));
}

function listWorlds(instanceDir) {
  const dir = path.join(String(instanceDir || ''), '.minecraft', 'saves');
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  return dirs.map((e) => {
    const abs = path.join(dir, e.name);
    let hasLevelDat = false;
    let lastPlayed = 0;
    try {
      hasLevelDat = fs.existsSync(path.join(abs, 'level.dat'));
      lastPlayed = fs.statSync(path.join(abs, 'level.dat')).mtimeMs;
    } catch {
      /* 忽略 */
    }
    return { name: e.name, path: abs, hasLevelDat, lastPlayed };
  }).sort((a, b) => b.lastPlayed - a.lastPlayed);
}

module.exports = {
  listMods,
  setModEnabled,
  moveToTrash,
  listResourcePacks,
  listWorlds,
  readModMetadata,
  addonDir,
  listAddonDir,
  ADDON_SUBDIRS
};
