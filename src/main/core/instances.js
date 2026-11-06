'use strict';
/*
 * instances.js —— 实例 CRUD。
 *
 * 照 MultiMC 的实例隔离模型：每个实例有自己的目录与独立的 .minecraft，
 * 共享的只有 <QCL_HOME>/meta 缓存。
 *
 * 存储：
 *   <home>/instances.json           索引（只存 id 顺序与少量冗余字段，方便秒开列表）
 *   <home>/instances/<id>/instance.json   权威元数据
 *   <home>/instances/<id>/.minecraft/     隔离的游戏目录
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const jsonstore = require('./jsonstore');
const paths = require('./paths');

/** 合法的 loader 类型（契约 §3.3；babric / modloader 是远古版本的两种加载器）。 */
const LOADER_TYPES = ['vanilla', 'forge', 'fabric', 'quilt', 'neoforge', 'optifine', 'liteloader', 'babric', 'modloader'];

/**
 * 把「自定义图标文件路径」转成渲染层 <img src> 能用的地址。
 *
 * 自定义图标存在 `<home>/icons/<id>.png`，不在 renderer 目录里，
 * 所以走 index.js 里单开的 `qcl://app/__instanceicon__/<文件名>` 通道。
 * 拿不到文件名（路径异常）时返回 null，让上层回落预置图标。
 */
function iconFileToUrl(file) {
  try {
    const name = path.basename(String(file || ''));
    if (!/^[A-Za-z0-9_-]+\.png$/i.test(name)) return null;
    return `qcl://app/__instanceicon__/${name}`;
  } catch {
    return null;
  }
}

/** .minecraft 下要预先建好的子目录。 */
const GAME_SUBDIRS = ['versions', 'libraries', 'assets', 'natives', 'mods', 'saves', 'resourcepacks', 'shaderpacks', 'config', 'logs'];

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeLoader(loader) {
  if (!loader || typeof loader !== 'object') return null;
  const type = String(loader.type || 'vanilla').toLowerCase();
  if (!LOADER_TYPES.includes(type)) return null;
  const base = { type, version: String(loader.version || '') };
  if (type === 'vanilla') return base;
  /**
   * ★ 2026-11-05：保留加载器的**附加字段**，不要只留 type/version。
   *
   * 起因：OptiFine 从「互斥加载器」改成「可叠加项」后，Forge + OptiFine 的实例
   * 要记 `loader = { type:'forge', version:'47.4.28', optifine:'HD_U_I6' }`。
   * 以前这里只返回 {type, version}，会把 optifine 子字段悄悄丢掉 ——
   * 写进 instance.json 后一读就没了（实测：installedVersion 对、optifine 消失）。
   * ⇒ 这里把**基本类型**的附加字段原样带上（对象/函数不复制，避免不可序列化）。
   */
  for (const [key, value] of Object.entries(loader)) {
    if (key === 'type' || key === 'version') continue;
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      base[key] = value;
    }
  }
  return base;
}

function readIndex(home) {
  const data = jsonstore.readJson(paths.instancesIndexFile(home), null);
  if (!data || typeof data !== 'object') return { version: 1, instances: [] };
  return {
    version: 1,
    instances: Array.isArray(data.instances) ? data.instances.filter((x) => typeof x === 'string' && x) : [],
  };
}

function writeIndex(home, index) {
  jsonstore.writeJson(paths.instancesIndexFile(home), index);
}

function addToIndex(home, id) {
  const index = readIndex(home);
  if (!index.instances.includes(id)) {
    index.instances.push(id);
    writeIndex(home, index);
  }
}

function removeFromIndex(home, id) {
  const index = readIndex(home);
  index.instances = index.instances.filter((x) => x !== id);
  writeIndex(home, index);
}

/** 建好实例目录骨架。 */
function ensureInstanceLayout(home, id) {
  paths.ensureDir(paths.instanceDir(home, id));
  const game = paths.gameDir(home, id);
  paths.ensureDir(game);
  for (const sub of GAME_SUBDIRS) paths.ensureDir(path.join(game, sub));
  return game;
}

/** 补齐字段并算出 dir（绝对路径）。 */
function hydrate(home, id, data) {
  const dir = paths.instanceDir(home, id);
  const record = data && typeof data === 'object' ? data : {};
  const loader = normalizeLoader(record.loader);
  return {
    id,
    name: record.name || id,
    icon: record.icon || 'grass',
    /**
     * ★★★ 2026-11-07 修（用户反馈「自定义实例图标与实际显示完全不准确，永远显示草方块」）。
     *
     * 以前 `iconFile` 只写进 instance.json，**hydrate 从来不读** ——
     * 渲染层拿不到自定义图片路径，也没法把它变成 <img src> 能用的地址，
     * 于是三处显示点（版本列表 / 主页 / 右栏版本行）全写死草方块。
     *
     * 这里同时给两个字段：
     *   · iconFile —— 磁盘上的绝对路径（排查用）
     *   · iconUrl  —— 可直接放进 <img src> 的 qcl:// 地址（渲染层用这个）
     */
    iconFile: record.iconFile || null,
    iconUrl: record.iconFile ? iconFileToUrl(record.iconFile) : null,
    mcVersion: record.mcVersion || '',
    installedVersion: record.installedVersion || record.mcVersion || '',
    loader: loader && loader.type !== 'vanilla' ? loader : (loader || null),
    java: {
      path: record.java && record.java.path ? record.java.path : null,
      memoryMb: record.java && Number.isFinite(record.java.memoryMb) ? record.java.memoryMb : null,
    },
    created: Number.isFinite(record.created) ? record.created : Date.now(),
    lastPlayed: Number.isFinite(record.lastPlayed) ? record.lastPlayed : null,
    playTime: Number.isFinite(record.playTime) ? record.playTime : 0,
    dir,
    notes: record.notes || '',
    group: record.group || '',
    /**
     * ★ 跟着安卓版走的两个字段：
     *   · notCheckGameFiles ——「不检查游戏文件」（远古版本装完自动打开）。
     *     远古版本的中文补丁改写了游戏 jar，全量 SHA1 校验会把它当成"损坏"还原掉。
     *   · chinesePack —— 中文补丁状态（语言 / 补丁目录），供工具页与校验逻辑判断。
     * ★ hydrate 是**白名单**，新字段必须在这里显式列出，否则会被静默丢弃（踩过）。
     */
    notCheckGameFiles: record.notCheckGameFiles === true,
    chinesePack: record.chinesePack && typeof record.chinesePack === 'object' ? record.chinesePack : null,

    /* ---------------- HMCL 对齐的逐实例设置（2026-11-05 加）----------------
     * ★ hydrate 是白名单：这里不列出来的字段会被静默丢掉（踩过）。
     */

    /** 版本隔离：'isolated'（各版本独立，默认）| 'default'（跟随全局共享目录） */
    isolation: record.isolation === 'default' ? 'default' : 'isolated',

    /** 游戏窗口类型：'windowed' | 'maximized' | 'fullscreen' */
    windowType:
      record.windowType === 'maximized' || record.windowType === 'fullscreen'
        ? record.windowType
        : 'windowed',

    /** 逐实例分辨率覆盖（为空则跟随全局 game.resolution） */
    resolution:
      record.resolution && Number.isFinite(record.resolution.width) && Number.isFinite(record.resolution.height)
        ? { width: record.resolution.width, height: record.resolution.height }
        : null,

    /** 不检查 Java 虚拟机与游戏的兼容性（照 HMCL settings.advanced.dont_check_jvm_validity） */
    dontCheckJvmValidity: record.dontCheckJvmValidity === true,

    /** 不尝试自动替换本地库（照 HMCL settings.advanced.dont_patch_natives） */
    dontPatchNatives: record.dontPatchNatives === true,

    /** 图形 API：'default' | 'opengl' | 'vulkan'（照 HMCL settings.advanced.graphics_backend，仅 26.2+ 生效） */
    graphicsBackend:
      record.graphicsBackend === 'opengl' || record.graphicsBackend === 'vulkan'
        ? record.graphicsBackend
        : 'default',

    /** 快速游玩：{ type:'none'|'singleplayer'|'multiplayer', target:string } */
    quickPlay:
      record.quickPlay && typeof record.quickPlay === 'object'
        ? {
            type: ['singleplayer', 'multiplayer'].includes(record.quickPlay.type)
              ? record.quickPlay.type
              : 'none',
            target: String(record.quickPlay.target || '')
          }
        : { type: 'none', target: '' },

    /** 启动前自动补齐缺失的依赖库与资源（照「自动安装」语义） */
    autoInstallDependencies: record.autoInstallDependencies !== false,

    /** 找不到匹配 Java 时自动下载（照 HMCL settings.game.java_directory.auto） */
    autoInstallJava: record.autoInstallJava !== false,
  };
}

/** 把实例记录落盘（instance.json + 索引）。 */
function persist(home, instance) {
  const { dir, ...rest } = instance;
  jsonstore.writeJson(paths.instanceJson(home, instance.id), rest);
  addToIndex(home, instance.id);
  return instance;
}

/** 列出全部实例；每个都带 dir 绝对路径。 */
async function list(home) {
  const root = paths.instancesDir(home);
  paths.ensureDir(root);
  const index = readIndex(home);
  const ids = index.instances.slice();
  const known = new Set(ids);

  // 自愈：磁盘上有但索引里没有的实例目录也认（比如手工拷进来的）
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (known.has(entry.name)) continue;
    if (fs.existsSync(paths.instanceJson(home, entry.name))) {
      ids.push(entry.name);
      known.add(entry.name);
    }
  }

  const out = [];
  for (const id of ids) {
    const data = jsonstore.readJson(paths.instanceJson(home, id), null);
    if (!data) continue; // 目录被删了但索引还在
    out.push(hydrate(home, id, data));
  }
  out.sort((a, b) => b.created - a.created);
  return out;
}

/** 取一个实例。 */
async function get(home, id) {
  if (!id) return null;
  const data = jsonstore.readJson(paths.instanceJson(home, id), null);
  if (!data) return null;
  return hydrate(home, id, data);
}

/** 新建实例。 */
/**
 * 实例名去重：同名时自动加 `-2` / `-3` …
 *
 * ★ 2026-11-05：用户反馈「不能自定义版本的名字，想装多个一样的版本就会重复」。
 *   界面上已经给了「＋ 新建实例…」+ 名字输入框，这里再做一层兜底 ——
 *   即使调用方连着传同一个名字（脚本、整合包导入、界面没刷新），也不会出现两个同名实例。
 *   比较不区分大小写（`1.20.1` 和 `1.20.1 ` 看着一样，容易让玩家点错）。
 *
 * @param {string} home
 * @param {string} wanted  想要的名字
 * @param {string} [exceptId]  改名时排除自己
 */
async function uniqueName(home, wanted, exceptId) {
  const want = String(wanted || '').trim() || '新实例';
  const set = new Set();
  try {
    const all = await list(home);
    for (const i of all) {
      if (exceptId && i.id === exceptId) continue;
      set.add(String(i.name || '').toLowerCase());
    }
  } catch {
    /* 读不到索引就当没有重名 */
  }
  if (!set.has(want.toLowerCase())) return want;
  for (let n = 2; n < 10000; n++) {
    const cand = `${want}-${n}`;
    if (!set.has(cand.toLowerCase())) return cand;
  }
  return `${want}-${Date.now()}`;
}

async function create(home, input) {
  const opts = input || {};
  const name = await uniqueName(home, opts.name);
  const mcVersion = String(opts.mcVersion || '').trim();

  let id = opts.id ? paths.safeId(opts.id) : newId();
  if (fs.existsSync(paths.instanceDir(home, id))) id = newId();

  ensureInstanceLayout(home, id);
  const instance = hydrate(home, id, {
    name,
    icon: opts.icon || 'grass',
    mcVersion,
    installedVersion: '',
    loader: normalizeLoader(opts.loader),
    java: { path: null, memoryMb: null },
    created: Date.now(),
    lastPlayed: null,
    playTime: 0,
    notes: '',
  });
  persist(home, instance);
  return instance;
}

/** 删除实例（连同 .minecraft 一起删）。 */
async function remove(home, id) {
  const dir = paths.instanceDir(home, id);
  fs.rmSync(dir, { recursive: true, force: true });
  removeFromIndex(home, id);
}

/** 改名。 */
async function rename(home, id, name) {
  const instance = await get(home, id);
  if (!instance) throw new Error(`实例不存在：${id}`);
  // 改名也要去重，否则玩家可以把两个实例改成同名
  instance.name = await uniqueName(home, String(name || '').trim() || instance.name, id);
  delete instance.dir;
  jsonstore.writeJson(paths.instanceJson(home, id), instance);
  return get(home, id);
}

/** 增量更新字段。 */
async function update(home, id, patch) {
  const current = jsonstore.readJson(paths.instanceJson(home, id), null);
  if (!current) throw new Error(`实例不存在：${id}`);
  const next = { ...current, ...(patch || {}) };
  if (patch && patch.java) next.java = { ...(current.java || {}), ...patch.java };
  if (patch && patch.loader !== undefined) next.loader = normalizeLoader(patch.loader);
  jsonstore.writeJson(paths.instanceJson(home, id), next);
  return hydrate(home, id, next);
}

/** 记录一次启动（lastPlayed + playTime 累加）。 */
async function markPlayed(home, id, addMs) {
  const current = jsonstore.readJson(paths.instanceJson(home, id), null);
  if (!current) return null;
  const now = Date.now();
  const next = {
    ...current,
    lastPlayed: now,
    playTime: (Number(current.playTime) || 0) + (Number(addMs) || 0),
  };
  jsonstore.writeJson(paths.instanceJson(home, id), next);
  return hydrate(home, id, next);
}

/** 确保实例目录完整（启动前调一次，防止用户手工删了子目录）。 */
async function ensure(home, id) {
  const instance = await get(home, id);
  if (!instance) throw new Error(`实例不存在：${id}`);
  ensureInstanceLayout(home, id);
  addToIndex(home, id);
  return instance;
}

module.exports = {
  LOADER_TYPES,
  GAME_SUBDIRS,
  list,
  get,
  create,
  remove,
  rename,
  update,
  ensure,
  markPlayed,
  newId,
  normalizeLoader,
  hydrate,
};
