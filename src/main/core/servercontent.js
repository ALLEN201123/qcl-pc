'use strict';
/**
 * 服务端的「插件 / 模组」管理
 *
 * ★★★ 为什么单独一层（2026-11-22，用户提的缺口）：
 *   服务端开了之后，玩家真正要的是「装个插件 / 装个模组」，
 *   而之前只有客户端那边的模组安装，服务端目录是空的。
 *
 * ★ 投放目录的区别（这点搞错就白装）：
 *   · **插件服**（Paper / Purpur / Spigot / Bukkit）→ 放进 `plugins/`，
 *     文件必须是 `.jar`，由服务端自己的插件加载器读。
 *   · **模组服**（Fabric / Forge / NeoForge）→ 放进 `mods/`，
 *     而且**客户端也要装同样的模组**才能进（纯服务端模组除外）。
 *   · **原版**（vanilla）→ 两者都不支持。装进去也不会被读。
 *     ⇒ 界面上必须按核心类型给对按钮，不能让玩家白折腾。
 *
 * ★ 数据源复用 core/contentapi.js（Modrinth 官方 API，免费无需 key）：
 *   · project_type = 'plugin'  → 插件（Bukkit/Paper/Spigot 生态）
 *   · project_type = 'mod'     → 模组（Fabric/Forge/NeoForge 生态）
 *   · loader 维度用于筛掉不兼容的
 */

const fs = require('node:fs');
const path = require('node:path');

/** 哪些核心支持插件 */
const PLUGIN_KINDS = new Set(['paper', 'purpur']);
/** 哪些核心支持模组 */
const MOD_KINDS = new Set(['fabric', 'forge', 'neoforge']);

/**
 * 这个服务端该用哪种内容。
 * @returns {'plugin'|'mod'|'none'}
 */
function contentTypeFor(kind) {
  const k = String(kind || '').toLowerCase();
  if (PLUGIN_KINDS.has(k)) return 'plugin';
  if (MOD_KINDS.has(k)) return 'mod';
  return 'none';
}

/** 投放目录名 */
function targetDirName(contentType) {
  if (contentType === 'plugin') return 'plugins';
  if (contentType === 'mod') return 'mods';
  return '';
}

/** 绝对路径 */
function targetDir(workDir, contentType) {
  const name = targetDirName(contentType);
  if (!name) return '';
  return path.join(workDir, name);
}

/** 确保目录存在 */
function ensureDir(workDir, contentType) {
  const dir = targetDir(workDir, contentType);
  if (!dir) throw new Error('这个服务端核心不支持插件/模组（原版服请改用 Paper 或 Fabric/Forge）');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 列出已安装的内容。
 *
 * ★★★ 2026-11-22 修（自测发现的真 bug）：
 *   原来判断扩展名用的是 `/\.(jar|zip)$/i`，于是被禁用的文件
 *   （`Something.jar.disabled`）**不匹配**，直接从列表里消失了 ——
 *   玩家禁用之后再也看不到那个插件，没法再启用回来。
 *   ⇒ 正则改成 `/\.(jar|zip)(\.disabled)?$/i`，并用 `disabled` 标记区分状态。
 */
function installed(workDir, contentType) {
  const dir = targetDir(workDir, contentType);
  if (!dir) return { ok: true, items: [], dir: '', kind: contentType };
  let items = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      // ★ 同时匹配 xxx.jar 与 xxx.jar.disabled
      if (!/\.(jar|zip)(\.disabled)?$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const disabled = /\.disabled$/i.test(e.name);
      items.push({
        name: e.name,
        /** 基名（去掉 .disabled 与扩展名），用于展示 */
        base: e.name.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, ''),
        size: st.size,
        mtime: st.mtimeMs,
        disabled,
        path: full,
      });
    }
  } catch {
    items = [];
  }
  // 同名时禁用的排后面（启用的优先显示）
  items.sort((a, b) => {
    const an = a.base.toLowerCase();
    const bn = b.base.toLowerCase();
    if (an !== bn) return an.localeCompare(bn);
    return Number(a.disabled) - Number(b.disabled);
  });
  return { ok: true, items, dir, kind: contentType };
}

/**
 * 搜索可用的插件 / 模组。
 *
 * ★★★ 数据源选择（2026-11-22 实测确定，别改错）：
 *
 *   **模组 → Modrinth**
 *     Modrinth 的 `categories` 里有 fabric / forge / neoforge / quilt，
 *     按 loader 精确筛，实测 JEI 94 条、Lithium 7 条，都对。
 *
 *   **插件 → CurseForge**
 *     Modrinth **不收编 MC 插件** —— 它的 categories 里根本没有
 *     paper/bukkit/spigot/purpur 这些值，传哪个 loader 都是 0 条。
 *     插件在 CurseForge 是独立分类 `classId=5`（Bukkit Plugins），
 *     走免 key 镜像（contentapi 的 curseforge 源），实测 EssentialsX 能搜到。
 *
 *   ★ 另外别踩：Modrinth 没有 `plugin` 这个 project_type（只有 5 种），
 *     所以查插件不能传 projectType:'plugin' 给 Modrinth。
 */
async function search(opts = {}) {
  const contentapi = require('./contentapi');
  const ct = contentTypeFor(opts.kind);
  if (ct === 'none') {
    throw new Error(
      '原版服务端（vanilla）不支持插件也不支持模组。' +
        '想装插件请改用 Paper 或 Purpur；想装模组请用 Fabric / Forge / NeoForge。'
    );
  }

  const isPlugin = ct === 'plugin';
  const loader = isPlugin ? 'paper' : String(opts.kind || '').toLowerCase();

  const r = await contentapi.search({
    query: String(opts.query || '').trim(),
    /** 插件走 CurseForge 的 Bukkit Plugins 分类；模组走 Modrinth 的 mod */
    projectType: isPlugin ? 'plugin' : 'mod',
    mcVersion: String(opts.mcVersion || '').trim(),
    loader,
    limit: Math.min(50, Math.max(1, Number(opts.limit) || 20)),
    offset: Math.max(0, Number(opts.offset) || 0),
    source: isPlugin ? 'curseforge' : 'modrinth',
  });

  return {
    ok: true,
    contentType: ct,
    loader,
    source: isPlugin ? 'curseforge' : 'modrinth',
    total: (r && r.total) || 0,
    items: ((r && r.hits) || []).map((h) => ({
      id: h.project_id || h.id || '',
      slug: h.slug || '',
      title: h.title || '',
      description: h.description || '',
      author: h.author || '',
      downloads: h.downloads || 0,
      iconUrl: h.icon_url || '',
      categories: h.categories || [],
      versions: h.versions || [],
      source: (r && r.source) || (isPlugin ? 'curseforge' : 'modrinth'),
    })),
  };
}

/** 某个项目对当前服务端可用的版本列表 */
async function versions(projectId, opts = {}) {
  const contentapi = require('./contentapi');
  const ct = contentTypeFor(opts.kind);
  if (ct === 'none') throw new Error('原版服务端不支持插件/模组');
  const isPlugin = ct === 'plugin';
  const loader = isPlugin ? 'paper' : String(opts.kind || '').toLowerCase();

  const r = await contentapi.getVersions(projectId, {
    source: isPlugin ? 'curseforge' : 'modrinth',
    mcVersion: String(opts.mcVersion || '').trim(),
    loader,
  });
  const list = (r && (r.versions || r)) || [];
  return {
    ok: true,
    items: (Array.isArray(list) ? list : []).map((v) => ({
      id: v.id || '',
      name: v.name || v.version_number || '',
      versionNumber: v.version_number || '',
      gameVersions: v.game_versions || [],
      loaders: v.loaders || [],
      downloads: v.downloads || 0,
      files: (v.files || []).map((f) => ({
        name: f.filename || '',
        url: f.url || '',
        size: f.size || 0,
        primary: !!f.primary,
      })),
    })),
  };
}

/**
 * 下载并安装到服务端的 plugins/ 或 mods/。
 * @param {{workDir:string, kind:string, projectId:string, versionId?:string, source?:string, onProgress?:Function}} opts
 */
async function install(opts = {}) {
  const contentapi = require('./contentapi');
  const ct = contentTypeFor(opts.kind);
  if (ct === 'none') throw new Error('原版服务端不支持插件/模组');
  const dir = ensureDir(opts.workDir, ct);

  const r = await contentapi.downloadTo(opts.projectId, opts.versionId, dir, {
    source: opts.source || 'modrinth',
    onProgress: opts.onProgress,
  });
  return {
    ok: true,
    contentType: ct,
    dir,
    file: (r && (r.name || r.file)) || '',
    path: (r && r.path) || '',
  };
}

/** 启用 / 禁用（改扩展名，不删文件） */
function toggle(workDir, contentType, fileName, disabled) {
  const dir = targetDir(workDir, contentType);
  if (!dir) throw new Error('这个核心不支持插件/模组');
  const safe = path.basename(String(fileName || ''));
  if (!safe) throw new Error('没指定文件');
  const full = path.join(dir, safe);
  if (!fs.existsSync(full)) throw new Error(`文件不存在：${safe}`);

  if (disabled) {
    // 加 .disabled 后缀
    if (/\.disabled$/i.test(safe)) return { ok: true, name: safe };
    const to = `${full}.disabled`;
    fs.renameSync(full, to);
    return { ok: true, name: path.basename(to) };
  }
  // 移除 .disabled 后缀
  if (!/\.disabled$/i.test(safe)) return { ok: true, name: safe };
  const to = full.replace(/\.disabled$/i, '');
  fs.renameSync(full, to);
  return { ok: true, name: path.basename(to) };
}

/** 删除（走回收站更安全，由上层决定） */
function remove(workDir, contentType, fileName) {
  const dir = targetDir(workDir, contentType);
  if (!dir) throw new Error('这个核心不支持插件/模组');
  const safe = path.basename(String(fileName || ''));
  const full = path.join(dir, safe);
  // 防目录穿越
  if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
    throw new Error('非法的文件名');
  }
  if (!fs.existsSync(full)) return { ok: true, removed: false };
  fs.rmSync(full, { force: true });
  return { ok: true, removed: true };
}

module.exports = {
  PLUGIN_KINDS,
  MOD_KINDS,
  contentTypeFor,
  targetDirName,
  targetDir,
  ensureDir,
  installed,
  search,
  versions,
  install,
  toggle,
  remove,
};
