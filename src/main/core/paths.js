'use strict';
/*
 * paths.js —— QCL 主目录与各子目录解析。
 *
 * 设计要点（照 MultiMC 的实例隔离模型）：
 *   <QCL_HOME>/instances/<id>/.minecraft/   每个实例独立的游戏目录
 *   <QCL_HOME>/meta/                        共享缓存（版本清单 / 版本 JSON / 资源索引）
 *   <QCL_HOME>/logs/latest.log              最近一次启动日志
 *
 * 不依赖 electron：只有「猜默认主目录」时才尝试 require('electron') 拿 app.getPath('documents')，
 * 拿不到就退到 os.homedir()/Documents，因此可以直接 node -e 单独加载测试。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 进程级当前主目录覆盖值（由设置里的 home 覆盖）。 */
let currentHomeOverride = null;

/** 在磁盘上找不到任何「文档」目录时的最后兜底。 */
function documentsDir() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.getPath === 'function') {
      const p = app.getPath('documents');
      if (p && String(p).trim()) return String(p);
    }
  } catch (_) {
    /* 纯 Node 环境下 require('electron') 会抛错，属预期 */
  }
  const home = os.homedir() || process.cwd();
  const candidates = [
    path.join(home, 'Documents'), // 英文 Windows
    path.join(home, '文档'), // 少数中文包会真的建中文名目录
    home,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* 忽略权限问题，继续试下一个 */
    }
  }
  return home;
}

/**
 * 计算默认 QCL 主目录。
 * @param {string} [documentsDirectory] 可注入的「文档」目录（便于测试与设置页展示）
 * @returns {string} 绝对路径
 */
function defaultHome(documentsDirectory) {
  const base = documentsDirectory && String(documentsDirectory).trim()
    ? String(documentsDirectory)
    : documentsDir();
  return path.resolve(base, 'QCL');
}

/** 设置当前主目录（传空则恢复默认）。 */
function setHome(home) {
  currentHomeOverride = home && String(home).trim() ? path.resolve(String(home)) : null;
}

/** 读取当前主目录。 */
function currentHome() {
  return currentHomeOverride || defaultHome();
}

/** 允许所有函数省略 home 参数。 */
function homeOf(home) {
  return home && String(home).trim() ? path.resolve(String(home)) : currentHome();
}

/** 把任意字符串清洗成安全的目录名 / 文件名。 */
function safeId(id) {
  const raw = String(id == null ? '' : id).trim();
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/, '');
  return cleaned || 'unnamed';
}

/** 递归建目录，已存在则静默通过。 */
function ensureDir(dir) {
  if (!dir) return dir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 一次性建多个目录。 */
function ensureDirs(dirs) {
  for (const dir of dirs || []) ensureDir(dir);
  return dirs;
}

/* ---------------------------------------------------------------- 顶层路径 */

/** <home>/settings.json */
function settingsFile(home) {
  return path.join(homeOf(home), 'settings.json');
}

/** <home>/accounts.json */
function accountsFile(home) {
  return path.join(homeOf(home), 'accounts.json');
}

/** <home>/instances.json（实例索引） */
function instancesIndexFile(home) {
  return path.join(homeOf(home), 'instances.json');
}

/** <home>/instances */
function instancesDir(home) {
  return path.join(homeOf(home), 'instances');
}

/** <home>/instances/<id> */
function instanceDir(home, id) {
  return path.join(instancesDir(home), safeId(id));
}

/** <home>/instances/<id>/instance.json */
function instanceJson(home, id) {
  return path.join(instanceDir(home, id), 'instance.json');
}

/** <home>/instances/<id>/.minecraft —— 实例隔离的游戏目录 */
function gameDir(home, id) {
  return path.join(instanceDir(home, id), '.minecraft');
}

/** <home>/instances/<id>/.minecraft/versions */
function versionsDir(home, id) {
  return path.join(gameDir(home, id), 'versions');
}

/* ------------------------------------------------------------------ 共享目录
 *
 * ★★★ 2026-11-05 架构调整（用户要求「把废磁盘的改成和 HMCL 一致的共享」）。
 *
 * 以前（废磁盘）：
 *   `<home>/instances/<id>/.minecraft/libraries`  ← 每个实例各一份
 *   `<home>/instances/<id>/.minecraft/assets`     ← 每个实例各一份
 *   装 3 个不同版本 = 依赖库和资源各下 3 遍（实测单实例 assets 就可到几百 MB）。
 *
 * 现在（照 HMCL 的隔离语义）：
 *   `<home>/.minecraft/libraries`  ← **所有实例共享**
 *   `<home>/.minecraft/assets`     ← **所有实例共享**
 *   每个实例只保留自己的游戏数据（saves / mods / config / resourcepacks …）。
 *
 * HMCL 的「各版本独立」原文就是
 *   「存放在 .minecraft/versions/<实例名>/，**除 assets、libraries 外**」
 * —— 即：游戏数据独立，assets 与 libraries 始终共享。这里与之对齐。
 */

/** 共享根：<home>/.minecraft */
function sharedRoot(home) {
  return path.join(homeOf(home), '.minecraft');
}

/** 共享依赖库目录：<home>/.minecraft/libraries */
function sharedLibrariesDir(home) {
  return path.join(sharedRoot(home), 'libraries');
}

/** 共享资源目录：<home>/.minecraft/assets */
function sharedAssetsDir(home) {
  return path.join(sharedRoot(home), 'assets');
}

/** 旧布局的 libraries 目录（迁移用，不要在新代码里写它） */
function legacyLibrariesDir(home, id) {
  return path.join(gameDir(home, id), 'libraries');
}

/** 旧布局的 assets 目录（迁移用） */
function legacyAssetsDir(home, id) {
  return path.join(gameDir(home, id), 'assets');
}

/**
 * 依赖库目录 —— **共享**。
 * @param {string} home
 * @param {string} [_id] 保留参数以兼容旧调用点，实际不再参与路径
 */
function librariesDir(home, _id) {
  return sharedLibrariesDir(home);
}

/**
 * 资源目录 —— **共享**。
 * @param {string} home
 * @param {string} [_id] 保留参数以兼容旧调用点
 */
function assetsDir(home, _id) {
  return sharedAssetsDir(home);
}

/** <home>/instances/<id>/.minecraft/natives */
function nativesDir(home, id) {
  return path.join(gameDir(home, id), 'natives');
}

/** <home>/instances/<id>/.minecraft（与 gameDir 同义，供 launch 使用） */
function instanceGameDir(home, id) {
  return gameDir(home, id);
}

/* ------------------------------------------------------------ 共享 meta 缓存 */

/** <home>/meta */
function metaDir(home) {
  return path.join(homeOf(home), 'meta');
}

/** <home>/meta/version_manifest_v2.json */
function manifestCache(home) {
  return path.join(metaDir(home), 'version_manifest_v2.json');
}

/** <home>/meta/versions */
function metaVersionsDir(home) {
  return path.join(metaDir(home), 'versions');
}

/** <home>/meta/versions/<id>.json */
function metaVersionJson(home, id) {
  return path.join(metaVersionsDir(home), safeId(id) + '.json');
}

/** <home>/meta/assets/indexes */
function metaIndexesDir(home) {
  return path.join(metaDir(home), 'assets', 'indexes');
}

/** <home>/meta/assets/indexes/<id>.json */
function metaAssetIndex(home, id) {
  return path.join(metaIndexesDir(home), safeId(id) + '.json');
}

/** <home>/meta/assets/objects（官方对象按 hash 存放，跨实例共享） */
function metaObjectsDir(home) {
  return path.join(metaDir(home), 'assets', 'objects');
}

/** <home>/meta/log_configs */
function metaLogConfigsDir(home) {
  return path.join(metaDir(home), 'log_configs');
}

/** <home>/meta/ancient_versions.json（远古版本清单缓存） */
function ancientCache(home) {
  return path.join(metaDir(home), 'ancient_versions.json');
}

/* -------------------------------------------------------------------- 日志 */

/** <home>/logs */
function logsDir(home) {
  return path.join(homeOf(home), 'logs');
}

/** <home>/logs/latest.log */
function latestLog(home) {
  return path.join(logsDir(home), 'latest.log');
}

/* --------------------------------------------------------- 一次性创建所需目录 */

/**
 * 建好主目录骨架（安装/启动前调一次即可）。
 * @returns {string} home
 */
function ensureHomeLayout(home) {
  const root = homeOf(home);
  ensureDirs([
    root,
    instancesDir(root),
    metaDir(root),
    metaVersionsDir(root),
    metaIndexesDir(root),
    metaObjectsDir(root),
    metaLogConfigsDir(root),
    logsDir(root),
  ]);
  return root;
}

module.exports = {
  // 契约冻结接口
  defaultHome,
  instanceDir,
  metaDir,
  logsDir,
  // 扩展
  documentsDir,
  setHome,
  currentHome,
  homeOf,
  safeId,
  ensureDir,
  ensureDirs,
  ensureHomeLayout,
  settingsFile,
  accountsFile,
  instancesIndexFile,
  instancesDir,
  instanceJson,
  gameDir,
  instanceGameDir,
  versionsDir,
  librariesDir,
  assetsDir,
  // 共享目录（2026-11-05：libraries/assets 多实例共用，照 HMCL 隔离语义）
  sharedRoot,
  sharedLibrariesDir,
  sharedAssetsDir,
  // 旧布局路径（仅迁移用）
  legacyLibrariesDir,
  legacyAssetsDir,
  nativesDir,
  manifestCache,
  metaVersionsDir,
  metaVersionJson,
  metaIndexesDir,
  metaAssetIndex,
  metaObjectsDir,
  metaLogConfigsDir,
  ancientCache,
  latestLog,
};
