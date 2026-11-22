'use strict';
/**
 * Quanta Craft Launcher PC · 服务端（一键开服）
 *
 * ★ 定位：安卓 1.6.6 的「一键开服」只有「选版本 → 下载 → 起进程 → 看控制台」，
 *   配置项只有 15 个（motd/port/gamemode/difficulty/pvp/max-players/view-distance/
 *   online-mode/white-list/enable-command-block/level-name/enable-rcon），
 *   没有备份、定时任务、白名单管理、RCON 命令、崩溃诊断、多实例并存。
 *   PC 版在这里做完整：
 *
 *   ① 服务端核心多源：原版（Mojang）/ Paper / Purpur / Fabric 服务端
 *   ② 端口预检 + 冲突检测（安卓那边只在启动失败后才报，这里开服前就拦）
 *   ③ Java 版本自动匹配（MC 版本 → Java 主版本，复用 core/java.js）
 *   ④ RCON 客户端：任意命令、在线玩家列表、广播、白名单热加载
 *   ⑤ 世界备份：手动 + 定时、保留份数、一键恢复、导出 zip
 *   ⑥ 崩溃诊断：退出码 + 日志尾部 → 中文结论
 *   ⑦ 优雅停止：`stop` 命令 → 等待 → 强制 kill（照安卓 ServerStopSignal 的思路）
 *   ⑧ 进程树管理：Windows 下 kill 整棵树，避免 java 孙子进程残留
 *
 * 目录布局（照 HMCL/MultiMC 的服务端惯例，与实例分开）：
 *   <home>/servers/<id>/server.json      服务端元数据
 *   <home>/servers/<id>/server/          服务端工作目录（jar / eula / properties / world）
 *   <home>/servers/<id>/backups/         备份
 *   <home>/servers/<id>/logs/            运行日志
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const paths = require('./paths');
const jsonstore = require('./jsonstore');

/* ============================================================
 * 常量
 * ============================================================ */

/** 支持的服务端核心类型 */
const SERVER_KINDS = ['vanilla', 'paper', 'purpur', 'fabric', 'forge', 'neoforge'];

/** 各类型的中文名 */
const KIND_LABELS = {
  vanilla: '原版（Mojang 官方）',
  paper: 'Paper（性能优化，插件服）',
  purpur: 'Purpur（Paper 增强分支）',
  fabric: 'Fabric 服务端（模组服）',
  forge: 'Forge（老牌模组服）',
  neoforge: 'NeoForge（Forge 现代分支）',
};

/** MC 版本 → 建议 Java 主版本（与启动器主逻辑保持一致） */
function javaMajorFor(mcVersion) {
  const v = String(mcVersion || '').trim();
  // 26.x 及以后走 Java 25
  if (/^2\d\./.test(v)) return 25;
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return 8; // 远古版本
  const minor = Number(m[1]);
  const patch = Number(m[2] || 0);
  if (minor >= 21) return 21;
  if (minor === 20 && patch >= 5) return 21;
  if (minor >= 17) return 17;
  return 8;
}

/** 状态机 */
const STATES = ['idle', 'preparing', 'downloading', 'installing', 'starting', 'running', 'stopping', 'stopped', 'crashed'];

/* ============================================================
 * 路径
 * ============================================================ */

function serversRoot(home) {
  return path.join(paths.homeOf(home), 'servers');
}
function serverDir(home, id) {
  return path.join(serversRoot(home), safeId(id));
}
function workDir(home, id) {
  return path.join(serverDir(home, id), 'server');
}
function backupsDir(home, id) {
  return path.join(serverDir(home, id), 'backups');
}
function logsDir(home, id) {
  return path.join(serverDir(home, id), 'logs');
}
function metaFile(home, id) {
  return path.join(serverDir(home, id), 'server.json');
}

function safeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error('服务端 ID 非法');
  return s;
}

/* ============================================================
 * 元数据 CRUD
 * ============================================================ */

function defaultMeta(id, opts = {}) {
  return {
    id,
    name: opts.name || `服务端 ${id.slice(-4)}`,
    kind: SERVER_KINDS.includes(opts.kind) ? opts.kind : 'vanilla',
    mcVersion: String(opts.mcVersion || ''),
    /** 服务端 jar 文件名（相对 workDir） */
    jar: '',
    /** 分配的 Java 主版本（实际用哪个 exe 由 java.js 探测结果决定） */
    javaMajor: Number(opts.javaMajor) || 0,
    /** java 可执行文件绝对路径（玩家可手动指定） */
    javaPath: opts.javaPath || '',
    /** 最大堆内存 MB */
    maxHeapMb: Number(opts.maxHeapMb) || 0,
    /** 额外 JVM 参数 / 额外程序参数 */
    extraJvmArgs: '',
    extraArgs: '',
    /** 端口（从 server.properties 读，这里缓存一份便于列表展示） */
    port: Number(opts.port) || 25565,
    /** 是否已同意 EULA */
    eulaAccepted: false,
    /** 自动备份配置 */
    autoBackup: {
      enabled: !!opts.autoBackupEnabled,
      /** 间隔分钟 */
      intervalMin: Number(opts.autoBackupIntervalMin) || 30,
      /** 保留份数 */
      keep: Number(opts.autoBackupKeep) || 10,
      /** 是否包含世界以外的（mods/config 等） */
      full: false,
    },
    /** 自动重启（崩溃后） */
    autoRestart: false,
    autoRestartMax: 3,
    /** 启动完成判定正则（默认 Done (x.xxxs)!） */
    readyPattern: '',
    created: Number(opts.created) || Date.now(),
    lastStarted: null,
    lastExited: null,
    lastExitCode: null,
    totalRunMs: 0,
  };
}

function readMeta(home, id) {
  const m = jsonstore.readJson(metaFile(home, id), null);
  if (!m || typeof m !== 'object') return null;
  return Object.assign(defaultMeta(safeId(id)), m, { id: safeId(id) });
}

function writeMeta(home, id, meta) {
  const dir = serverDir(home, id);
  fs.mkdirSync(dir, { recursive: true });
  jsonstore.writeJson(metaFile(home, id), meta);
  return meta;
}

/** 列出全部服务端（按创建时间倒序） */
function list(home) {
  const root = serversRoot(home);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const m = readMeta(home, name);
    if (!m) continue;
    const rt = getRuntime(name);
    out.push({
      ...m,
      dir: serverDir(home, name),
      workDir: workDir(home, name),
      running: !!(rt && rt.child && !rt.stopped),
      state: rt ? rt.state : 'idle',
    });
  }
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out;
}

/** 新建服务端（只建目录与元数据，jar 由 download 步骤装） */
/**
 * 自动挑一个没被本项目其它服务端占用的端口。
 *
 * ★★★ 2026-11-22 修（用户提问：「新建第二个服务端，端口会不会从 25565 改成 25566？」）：
 *   原来 defaultMeta 里的 `port: Number(opts.port) || 25565` 是**写死 25565** 的，
 *   于是第二个服务端也是 25565 → 两个服同时开就撞端口，第二个起不来。
 *   （虽然开服前的端口预检会拦住并报错，但那属于「先让你犯错再告诉你」，体验很差。）
 *
 * 现在的规则：
 *   ① 玩家显式传了 port → 就用它（不覆盖玩家的选择）
 *   ② 没传 → 从 25565 开始往上找，跳过已被**本项目其它服务端**占用的端口
 *   ③ 顺带跳过系统层已被占用的端口（用 checkPort 真绑一次）
 *
 * @returns {Promise<number>}
 */
async function pickPort(home, excludeId = '') {
  const used = new Set();
  let list = [];
  try {
    list = module.exports.list(home) || [];
  } catch {
    list = [];
  }
  for (const s of list) {
    if (!s || s.id === excludeId) continue;
    const p = Number(s.port);
    if (p > 0) used.add(p);
  }
  for (let p = 25565; p <= 25665; p += 1) {
    if (used.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkPort(p);
    if (ok.free) return p;
  }
  // 极端情况：这一段全满，交给系统分配
  return 0;
}

function create(home, opts = {}) {
  const id = opts.id ? safeId(opts.id) : `srv${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  if (fs.existsSync(metaFile(home, id))) throw new Error(`服务端已存在：${id}`);
  const meta = defaultMeta(id, opts);
  fs.mkdirSync(workDir(home, id), { recursive: true });
  fs.mkdirSync(backupsDir(home, id), { recursive: true });
  fs.mkdirSync(logsDir(home, id), { recursive: true });
  writeMeta(home, id, meta);
  return readMeta(home, id);
}

/**
 * 异步创建：会自动分配一个不冲突的端口。
 * 界面走这个（同步的 create 只给测试/内部用）。
 */
async function createAuto(home, opts = {}) {
  const port = Number(opts.port) > 0 ? Number(opts.port) : await pickPort(home);
  return create(home, { ...opts, port });
}

/** 更新元数据（浅合并，autoBackup 单独深合并） */
function update(home, id, patch = {}) {
  const cur = readMeta(home, id);
  if (!cur) throw new Error(`服务端不存在：${id}`);
  const next = Object.assign({}, cur, patch);
  if (patch.autoBackup && typeof patch.autoBackup === 'object') {
    next.autoBackup = Object.assign({}, cur.autoBackup, patch.autoBackup);
  }
  next.id = cur.id;
  writeMeta(home, id, next);
  return next;
}

/** 删除服务端（移到回收站由上层决定；这里只删目录） */
function remove(home, id) {
  const rt = getRuntime(id);
  if (rt && rt.child && !rt.stopped) throw new Error('服务端正在运行，请先停止再删除');
  const dir = serverDir(home, id);
  if (!fs.existsSync(dir)) return { removed: false };
  fs.rmSync(dir, { recursive: true, force: true });
  runtimes.delete(id);
  return { removed: true };
}

/* ============================================================
 * 端口预检
 * ============================================================ */

/**
 * 检查端口是否可用。
 * ★ 安卓 1.6.6 是「启动失败后才告诉你端口被占用」，这里开服前就拦。
 * @returns {Promise<{free:boolean, error?:string}>}
 */
function checkPort(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      resolve({ free: false, error: `端口号不合法：${port}` });
      return;
    }
    const srv = net.createServer();
    const done = (free, error) => {
      try {
        srv.close();
      } catch {
        /* ignore */
      }
      resolve({ free, error });
    };
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') done(false, `端口 ${p} 已被其他程序占用`);
      else if (err.code === 'EACCES') done(false, `端口 ${p} 需要管理员权限（1024 以下）`);
      else done(false, `端口 ${p} 不可用：${err.message}`);
    });
    srv.once('listening', () => done(true));
    try {
      srv.listen(p, host);
    } catch (err) {
      done(false, `端口 ${p} 检测失败：${err.message}`);
    }
  });
}

/** 在一个区间里找第一个可用端口（给「自动选端口」用） */
async function findFreePort(start = 25565, end = 25665) {
  for (let p = start; p <= end; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await checkPort(p);
    if (r.free) return p;
  }
  return null;
}

/* ============================================================
 * 下载服务端 jar
 * ============================================================ */

/**
 * 取服务端 jar（原版）：**先 Mojang，拿不到再回落 Betacraft 归档**。
 *
 * ★★★ 2026-11-22（用户纠正了我的事实错误，这是关键修复）。
 *
 * 我一开始以为「Beta / Alpha 没有服务端、1.0 也没有」——**错了**。
 * Mojang 当年**发过**这些服务端，只是后来很多 jar 从下载清单里被删掉了
 * （1.0 正式版、Beta 全系、Alpha 全系、Classic、以及大量周快照）。
 * Betacraft 社区把它们全量保存下来，它自己就是靠这个开服的。
 *
 * 所以现在的顺序是：
 *   ① Mojang 官方 version json 的 downloads.server（有就用，最快最正）
 *   ② 没有 → 去 Betacraft server-archive 找（覆盖官方已丢失的那些）
 *   ③ 两边都没有 → 给出明确原因
 *
 * @param {string} mcVersion
 * @param {{home:string, source?:string, timeoutMs?:number, allowArchive?:boolean}} options
 * @returns {Promise<{url, sha1, size, fileName, fromArchive?:boolean, archiveInfo?:object}>}
 */
async function vanillaServerInfo(mcVersion, options = {}) {
  const mojang = require('./mojang');

  let mojangErr = null;
  try {
    const vj = await mojang.versionJson({
      id: mcVersion,
      cacheDir: paths.metaDir(options.home),
      source: options.source,
      timeoutMs: options.timeoutMs || 25000,
    });
    const srv = vj && vj.downloads && vj.downloads.server;
    if (srv && srv.url) {
      return { url: srv.url, sha1: srv.sha1 || '', size: Number(srv.size) || 0 };
    }
    mojangErr = 'Mojang 清单里没有它的服务端';
  } catch (err) {
    mojangErr = err && err.message ? err.message : String(err);
  }

  // ② 回落 Betacraft 归档
  if (options.allowArchive !== false) {
    try {
      const sa = require('./serverarchive');
      const hit = await sa.findServer(mcVersion, { home: options.home });
      if (hit.ok && hit.item) {
        return {
          url: hit.item.url,
          sha1: '',
          size: 0,
          fromArchive: true,
          archiveInfo: hit.item,
        };
      }
    } catch (err) {
      /* 归档也失败，继续往下 */
    }
  }

  // ③ 回落内置远古服务端（Infdev / Beta 插件化服务端，Mojang 与归档都没有）
  if (options.allowBuiltin !== false) {
    try {
      const ancient = require('./ancientServer');
      const b = ancient.findFor(mcVersion);
      if (b && b.exists) {
        return {
          builtin: true,
          builtinInfo: b,
          url: `file://${b.path}`,
          sha1: '',
          size: b.size,
        };
      }
    } catch {
      /* ignore */
    }
  }

  // ③ 两边都没有
  const isLegacy = /^(rd-|pc-|c0\.|in-|inf|a\d|b\d|1\.0\.0-rc|2\.0_|1[123]w)/i.test(String(mcVersion));
  const extra = isLegacy
    ? '\nMojang 早年发过远古版本的服务端，但后来从下载清单里删了；Betacraft 归档里也没找到这个版本。'
    : '\n可以试试 Paper / Purpur（支持到 1.8.8+），或用 Betacraft 归档里有的版本。';
  throw new Error(`${mcVersion} 的服务端拿不到：${mojangErr || 'Mojang 与 Betacraft 归档都没有'}。${extra}`);
}

/**
 * Paper 最新构建。
 *
 * ★★★ 2026-11-22 修：旧的 `api.papermc.io/v2` **全线返回 HTTP 410**（官方已下线），
 *   所以之前 Point 到 Paper 的人一个都下不了。官方迁到了 **fill.papermc.io/v3**：
 *     GET /v3/projects/paper                     → { versions: { "1.21": ["1.21.11", …], … } }
 *     GET /v3/projects/paper/versions/<v>/builds → [ { id, channel, downloads: { "server:default": {url,size,checksums.sha256} } } ]
 *   注意下载键从旧版的 `application` 变成了 **`server:default`**。
 */
async function paperServerInfo(mcVersion, options = {}) {
  const http = require('./http');
  const base = String(options.paperApi || 'https://fill.papermc.io/v3').replace(/\/+$/, '');
  const headers = { 'User-Agent': 'QCL-Launcher/1.0 (Minecraft server manager)' };

  // ① 该项目支持哪些版本（v3 是「主版本 → 具体版本数组」的映射）
  const proj = await http.fetchJson(`${base}/projects/paper`, { timeoutMs: 20000, headers });
  const buckets = (proj && proj.versions) || {};
  const all = [];
  for (const arr of Object.values(buckets)) {
    if (Array.isArray(arr)) all.push(...arr);
  }
  if (!all.includes(mcVersion)) {
    throw new Error(
      `Paper 没有 ${mcVersion} 的构建（它支持 ${all.length} 个版本，从 1.7.10 到最新）。` +
        '想要这个版本的优化服务端，可以试试 Purpur 或原版。'
    );
  }

  // ② 该版本的构建列表
  const builds = await http.fetchJson(`${base}/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`, {
    timeoutMs: 25000,
    headers,
  });
  const list = Array.isArray(builds) ? builds : [];
  const usable = list.filter((b) => b && b.downloads && b.downloads['server:default']);
  if (!usable.length) throw new Error(`Paper ${mcVersion} 没有可用的服务端构建`);

  // 优先 STABLE 渠道，其次按 id 最大
  const stable = usable.filter((b) => String(b.channel || '').toUpperCase() === 'STABLE');
  const pool = stable.length ? stable : usable;
  const pick = pool.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  const dl = pick.downloads['server:default'];

  return {
    url: dl.url,
    sha1: '', // v3 给的是 sha256，下载器只校验 sha1，这里不传避免误判
    sha256: (dl.checksums && dl.checksums.sha256) || '',
    size: Number(dl.size) || 0,
    build: pick.id,
    channel: String(pick.channel || ''),
    fileName: dl.name || `paper-${mcVersion}-${pick.id}.jar`,
  };
}

/** Purpur 最新构建 */
async function purpurServerInfo(mcVersion) {
  const http = require('./http');
  const v = await http.fetchJson('https://api.purpurmc.org/v2/purpur', { timeoutMs: 20000 });
  const versions = (v && v.versions) || [];
  if (!versions.includes(mcVersion)) throw new Error(`Purpur 没有 ${mcVersion} 的构建`);
  const b = await http.fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}`, { timeoutMs: 20000 });
  const latest = b && b.builds && b.builds.latest;
  if (!latest) throw new Error(`Purpur ${mcVersion} 没有可用构建`);
  return {
    url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}/${latest}/download`,
    sha1: '',
    size: 0,
    build: latest,
    fileName: `purpur-${mcVersion}-${latest}.jar`,
  };
}

/** Fabric 服务端 launcher jar（官方 installer 生成的那种，直接可跑） */
async function fabricServerInfo(mcVersion, loaderVersion) {
  const http = require('./http');
  // 取一个 loader 版本
  let lv = String(loaderVersion || '').trim();
  if (!lv) {
    const arr = await http.fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, { timeoutMs: 20000 });
    const first = Array.isArray(arr) ? arr.find((x) => x && x.loader && x.loader.stable) || (arr || [])[0] : null;
    if (!first || !first.loader) throw new Error(`Fabric 没有 ${mcVersion} 的 loader`);
    lv = first.loader.version;
  }
  // installer 版本
  const inst = await http.fetchJson('https://meta.fabricmc.net/v2/versions/installer', { timeoutMs: 20000 });
  const iv = Array.isArray(inst) && inst.length ? (inst.find((x) => x.stable) || inst[0]).version : '';
  if (!iv) throw new Error('取不到 Fabric installer 版本');
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(lv)}/${encodeURIComponent(iv)}/server/jar`,
    sha1: '',
    size: 0,
    loaderVersion: lv,
    installerVersion: iv,
    fileName: `fabric-server-mc.${mcVersion}-loader.${lv}-launcher.${iv}.jar`,
  };
}

/**
 * Forge 服务端。
 *
 * ★ Forge 与 Paper/原版不同：**没有现成的服务端 jar 可下**。
 *   官方发布的是一个 installer（`forge-<mc>-<ver>-installer.jar`），
 *   必须跑它 `--installServer <目录>` 才会生成 `libraries/` + `run.sh/run.bat` + 一个
 *   `forge-<mc>-<ver>.jar`（1.17+ 是 `bootstraplauncher` 那套，启动方式不同）。
 *
 * 本函数只负责**下载 installer**；真正执行安装由 installForgeServer() 做。
 */
async function forgeServerInfo(mcVersion, options = {}) {
  const http = require('./http');
  // promotions_slim.json 里有每个 MC 版本推荐的 forge 版本
  const promo = await http.fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
    timeoutMs: 25000,
  });
  const promos = (promo && promo.promos) || {};
  const recommended = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];
  if (!recommended) {
    throw new Error(
      `Forge 没有 ${mcVersion} 的服务端（它只支持官方发布过的那些版本）。` +
        '想开这个版本的模组服，可以试 NeoForge（1.20.2+）或 Fabric。'
    );
  }
  const full = `${mcVersion}-${recommended}`;
  const fileName = `forge-${full}-installer.jar`;
  // 官方 maven 直链（比 files.minecraftforge.net 的广告页稳）
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/${fileName}`;
  return {
    url,
    sha1: '',
    size: 0,
    fileName,
    /** 标记这是 installer，不是可直接跑的 server jar */
    installer: true,
    forgeVersion: recommended,
    full,
  };
}

/**
 * NeoForge 服务端。
 *
 * ★★ 两个坑（2026-11-22 实测踩到）：
 *
 *   ① **版本号规则不是简单的「MC 小版本.patch」**：
 *      实际是 `<mcMajor>.<mcMinor>.<mcPatch>.<build>`，例如
 *        MC 1.21.1  →  21.1.72       （三段）
 *        MC 26.3    →  26.3.0.115    （四段！patch 位补 0）
 *      所以匹配要按「前缀 + 段数」分别处理，不能只拼 `minor.patch.`。
 *
 *   ② **官方 maven `maven.neoforged.net` 在本机直连拿不到**（请求失败），
 *      但 BMCLAPI 镜像 `bmclapi2.bangbang93.com/maven/...` 可以，
 *      而且一次给全 1877 个版本。所以清单走 BMCLAPI，
 *      安装器 jar 也优先用镜像地址（官方地址作为回退）。
 */
async function neoforgeServerInfo(mcVersion, options = {}) {
  const http = require('./http');

  // ① 版本清单：官方失败就回落 BMCLAPI 镜像
  const listUrls = [
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml',
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  ];
  let meta = '';
  let lastErr = null;
  for (const u of listUrls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await http.fetchText(u, { timeoutMs: 25000 });
      if (meta && meta.includes('<version>')) break;
    } catch (err) {
      lastErr = err;
      meta = '';
    }
  }
  if (!meta) {
    throw new Error(`拿不到 NeoForge 版本清单：${lastErr ? lastErr.message : '所有源都不可用'}`);
  }

  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(meta))) versions.push(m[1]);
  if (!versions.length) throw new Error('NeoForge 版本清单是空的');

  /**
   * ② 按 MC 版本算前缀。
   *    MC 1.21.1 → 目标前缀 "21.1."   （三段版本 21.1.72）
   *    MC 26.3   → 目标前缀 "26.3.0." （四段版本 26.3.0.115）
   *    通用规则：取 MC 的 (minor, patch)，NeoForge 用 minor.patch 或 minor.patch.0
   */
  const mm = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mcVersion));
  if (!mm) {
    throw new Error(`NeoForge 不支持 ${mcVersion}（它从 1.20.2 开始，版本号形如 1.21.1）`);
  }
  const major = mm[1];
  const minorRaw = mm[2];
  const patchRaw = mm[3];

  // NeoForge 的 major 段：MC 1.x → x；MC 26.x → 26
  const nfMajor = major === '1' ? minorRaw : major;
  const nfMinor = major === '1' ? (patchRaw || '0') : minorRaw;
  const nfPatch = major === '1' ? null : (patchRaw || '0');

  const prefixes = [];
  if (nfPatch === null) {
    // MC 1.x → 三段版本号 21.1.72
    prefixes.push(`${nfMajor}.${nfMinor}.`);
  } else {
    // MC 26.x → 四段版本号 26.3.0.115
    prefixes.push(`${nfMajor}.${nfMinor}.${nfPatch}.`);
    prefixes.push(`${nfMajor}.${nfMinor}.`);
  }

  const pickBuild = (v) => {
    const parts = String(v).split('.');
    return Number(parts[parts.length - 1]) || 0;
  };

  let matched = [];
  for (const p of prefixes) {
    matched = versions.filter((v) => v.startsWith(p));
    if (matched.length) break;
  }
  if (!matched.length) {
    // 给一个更有用的错误：列出附近可用的版本
    const near = versions
      .filter((v) => v.startsWith(`${nfMajor}.`))
      .slice(-6)
      .join(', ');
    throw new Error(
      `NeoForge 没有 ${mcVersion} 的构建。` +
        (near ? `它附近可用的版本有：${near}。` : '') +
        '可以改用 Forge 或 Fabric。'
    );
  }

  matched.sort((a, b) => pickBuild(b) - pickBuild(a));
  const ver = matched[0];
  const fileName = `neoforge-${ver}-installer.jar`;

  return {
    /** 优先走 BMCLAPI 镜像（官方在本机不通），下载器失败会自动回退 */
    url: `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${ver}/${fileName}`,
    fallbackUrls: [`https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/${fileName}`],
    sha1: '',
    size: 0,
    fileName,
    installer: true,
    neoforgeVersion: ver,
  };
}

/**
 * 按 kind 取服务端下载信息。
 *
 * ★ `preferBuiltin`：远古版本让玩家自己选「原版服务端」还是「内置社区服务端」。
 *   · b1.7.3 这种：归档有**原版** b1.7.3 服务端（不带插件），
 *     内置还有**插件化**版本（PEMod，能装插件）。两者用途不同，不能替玩家决定。
 *   · Infdev 这种：归档和 Mojang 都没有，只能用内置。
 *
 * @returns {Promise<{url, sha1, size, fileName, extra}>}
 */
async function resolveServerJar(kind, mcVersion, options = {}) {
  const k = SERVER_KINDS.includes(kind) ? kind : 'vanilla';

  // 玩家点名要内置社区服务端
  if (options.preferBuiltin) {
    const ancient = require('./ancientServer');
    const b = ancient.findFor(mcVersion);
    if (b && b.exists) {
      return {
        builtin: true,
        builtinInfo: b,
        url: `file://${b.path}`,
        sha1: '',
        size: b.size,
        fileName: path.basename(b.file),
        extra: { builtin: b.id },
      };
    }
    throw new Error(`内置社区服务端里没有能开 ${mcVersion} 的（只有 Infdev 与 Beta 1.7.3 插件版）`);
  }

  if (k === 'vanilla') {
    const r = await vanillaServerInfo(mcVersion, options);
    return { ...r, fileName: r.fileName || `server-${mcVersion}.jar`, extra: {} };
  }
  if (k === 'paper') return paperServerInfo(mcVersion, options);
  if (k === 'purpur') return purpurServerInfo(mcVersion);
  if (k === 'fabric') return fabricServerInfo(mcVersion, options.loaderVersion);
  if (k === 'forge') return forgeServerInfo(mcVersion, options);
  if (k === 'neoforge') return neoforgeServerInfo(mcVersion, options);
  throw new Error(`未知的服务端类型：${kind}`);
}

/**
 * Forge / NeoForge：跑官方 installer 生成服务端。
 *
 * ★ 这两个核心没有「下载即用」的 jar：installer 跑完会在目标目录生成
 *   ``` 
 *   libraries/  （几百 MB 依赖）
 *   run.bat / run.sh（1.16 及以前）
 *   或 @user_jvm_args.txt + win_args.txt（1.17+）
 *   ```
 *   所以我们下载完 installer 后必须**真的执行它**。
 *
 * ★ 常见坑（已在安卓版踩过）：installer 需要 `launcher_profiles.json` 存在，
 *   否则报 "There is no Minecraft launcher profile"。这里先写一份最小的。
 *
 * @returns {Promise<{ok:boolean, jar?:string, launchArgs?:string[], error?:string}>}
 */
async function installForgeLike(home, id, installerPath, options = {}) {
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  const dir = workDir(home, id);
  const meta = readMeta(home, id);
  const jre = options.javaPath || (await resolveJava(home, meta)).path;

  // ① installer 要求目录里有个 launcher_profiles.json
  const lp = path.join(dir, 'launcher_profiles.json');
  if (!fs.existsSync(lp)) {
    fs.writeFileSync(
      lp,
      JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2),
      'utf8'
    );
  }

  log(`开始运行安装器：${path.basename(installerPath)} --installServer`);
  const { spawnSync } = require('node:child_process');
  const args = [
    '-Xmx1024M',
    '-Djava.awt.headless=true',
    '-Dfile.encoding=UTF-8',
    '-jar',
    installerPath,
    '--installServer',
    dir,
  ];
  log(`命令：${path.basename(jre)} ${args.join(' ')}`);

  const r = spawnSync(jre, args, {
    cwd: dir,
    windowsHide: true,
    timeout: 20 * 60 * 1000,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  // 把安装器输出投给界面（截断，避免刷屏）
  for (const line of out.split(/\r?\n/).slice(-120)) {
    if (line.trim()) log(line.trim());
  }
  if (r.error) {
    return { ok: false, error: `安装器启动失败：${r.error.message}` };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      error: `安装器退出码 ${r.status}。常见原因：Java 版本不对（Forge 1.17+ 要 Java 17）、网络拉不到 maven 依赖。`,
    };
  }

  // ② 找出安装后该怎么启动
  const found = detectForgeLaunch(dir, meta);
  if (!found.ok) return found;
  log(`安装完成，启动方式：${found.jar}${found.launchArgs && found.launchArgs.length ? '（带参数）' : ''}`);
  return found;
}

/**
 * 探测 Forge/NeoForge 装好后的启动方式。
 *
 * 三种形态：
 *   A. 1.16 及以前：目录下有 `forge-<mc>-<ver>.jar`，直接 `-jar` 起
 *   B. 1.17~1.20.x：有 `libraries/net/minecraftforge/forge/<full>/win_args.txt`，
 *      启动类 `cpw.mods.bootstraplauncher.BootstrapLauncher`，参数 `@libraries/.../win_args.txt`
 *   C. NeoForge 1.20.2+：同上，但路径在 `libraries/net/neoforged/neoforge/<ver>/`
 */
function detectForgeLaunch(dir, meta) {
  // A：直接可跑的 jar
  const jars = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^forge-.*\.jar$/i.test(f) && !/installer/i.test(f)) jars.push(f);
      if (/^neoforge-.*\.jar$/i.test(f) && !/installer/i.test(f)) jars.push(f);
    }
  } catch {
    /* ignore */
  }
  if (jars.length) {
    // 优先 forge-<mc>-<ver>.jar 这种完整名
    const pick = jars.sort((a, b) => b.length - a.length)[0];
    return { ok: true, jar: pick, launchArgs: [] };
  }

  // B/C：找 win_args.txt / unix_args.txt
  const candidates = [];
  const libDir = path.join(dir, 'libraries');
  const stack = [libDir];
  let guard = 0;
  while (stack.length && guard < 3000) {
    const cur = stack.pop();
    guard += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /^(win|unix)_args\.txt$/i.test(e.name)) candidates.push(full);
    }
  }
  if (candidates.length) {
    const want = process.platform === 'win32' ? /win_args\.txt$/i : /unix_args\.txt$/i;
    const argsFile = candidates.find((p) => want.test(p)) || candidates[0];
    const rel = path.relative(dir, argsFile).split(path.sep).join('/');
    return {
      ok: true,
      /** 这种形态没有单一 jar，用 @args 文件启动 */
      jar: '',
      launchArgs: [`@${rel}`],
      argsFile,
      /** BootstrapLauncher 的 main class（1.17+） */
      mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    };
  }

  return {
    ok: false,
    error:
      '安装器跑完了，但没找到可启动的东西（既没有 forge-*.jar，也没有 win_args.txt）。' +
      '请把服务端目录下的日志发来排查。',
  };
}

/**
 * 下载服务端 jar 到 workDir。
 * @param {{onProgress?:Function, onLog?:Function, signal?:AbortSignal}} options
 */
async function downloadServerJar(home, id, options = {}) {
  const meta = readMeta(home, id);
  if (!meta) throw new Error(`服务端不存在：${id}`);
  const dir = workDir(home, id);
  fs.mkdirSync(dir, { recursive: true });

  const info = await resolveServerJar(meta.kind, meta.mcVersion, {
    home,
    source: options.source,
    loaderVersion: options.loaderVersion,
    mirror: options.mirror,
    /** 玩家在界面上勾了「用内置社区服务端」就传 true */
    preferBuiltin: !!options.preferBuiltin,
  });

  const jarName = safeJarName(info.fileName || `server-${meta.mcVersion}.jar`);
  const dest = path.join(dir, jarName);

  /**
   * ★ 内置远古服务端（Infdev / Beta 插件化）：直接从本地资源安装，
   *   不走网络下载器（url 是 file:// 也不行，下载器是给 http 用的）。
   */
  if (info.builtin) {
    const ancient = require('./ancientServer');
    const r = await ancient.installTo(meta.mcVersion, dir);
    if (!r.ok) throw new Error(r.error || '内置服务端安装失败');
    update(home, id, { jar: r.jar });
    if (typeof options.onLog === 'function') {
      options.onLog(`已安装内置远古服务端：${r.builtin.name}（${r.jar}）`);
      options.onLog(`说明：${r.builtin.desc}`);
    }
    return {
      jar: r.jar,
      path: path.join(dir, r.jar),
      bytes: fs.existsSync(path.join(dir, r.jar)) ? fs.statSync(path.join(dir, r.jar)).size : 0,
      info: { builtin: true, name: r.builtin.name, label: r.builtin.label },
    };
  }

  const downloader = require('./downloader');

  // Forge / NeoForge：先下 installer，再跑它
  if (info.installer) {
    if (typeof options.onLog === 'function') {
      options.onLog(`下载安装器：${info.fileName}`);
    }
    const res0 = await downloader.downloadAll(
      [{
        url: info.url,
        /** Forge/NeoForge 的镜像回退（官方 maven 在部分网络不通） */
        fallbackUrls: Array.isArray(info.fallbackUrls) ? info.fallbackUrls : [],
        dest,
        name: info.fileName,
      }],
      { source: options.source, signal: options.signal, timeoutMs: 300000, onProgress: options.onProgress }
    );
    if (res0.failed && res0.failed.length) {
      throw new Error(`安装器下载失败：${res0.failed[0].error || '未知错误'}`);
    }
    const inst = await installForgeLike(home, id, dest, { onLog: options.onLog, javaPath: options.javaPath });
    if (!inst.ok) throw new Error(inst.error || 'Forge 服务端安装失败');
    // 记录启动方式（jar 可能为空，改用 @args）
    update(home, id, {
      jar: inst.jar || '',
      /** 1.17+ 的 @args 启动参数 */
      launchArgs: inst.launchArgs || [],
      mainClass: inst.mainClass || '',
    });
    return {
      jar: inst.jar || '(args 启动)',
      path: dir,
      bytes: info.size || 0,
      info: { kind: meta.kind, installer: true, launchArgs: inst.launchArgs || [] },
    };
  }

  const tasks = [
    {
      url: info.url,
      dest,
      sha1: info.sha1 || undefined,
      size: info.size || undefined,
      name: jarName,
    },
  ];
  const res = await downloader.downloadAll(tasks, {
    source: options.source,
    signal: options.signal,
    timeoutMs: 120000,
    onProgress: options.onProgress,
  });
  if (res.failed && res.failed.length) {
    throw new Error(`服务端 jar 下载失败：${res.failed[0].error || '未知错误'}`);
  }
  // Fabric 那个 launcher jar 需要能从同目录找到 libraries —— 它自带下载逻辑，直接跑即可

  update(home, id, { jar: jarName });
  if (typeof options.onLog === 'function') {
    options.onLog(`服务端 jar 已就绪：${jarName}（${info.channel || info.kind || meta.kind}）`);
  }
  return { jar: jarName, path: dest, bytes: fs.existsSync(dest) ? fs.statSync(dest).size : 0, info };
}

/** jar 文件名清洗（去掉路径与奇怪字符） */
function safeJarName(name) {
  const base = path.basename(String(name || 'server.jar')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return base.toLowerCase().endsWith('.jar') ? base : `${base}.jar`;
}

/* ============================================================
 * EULA
 * ============================================================ */

/** 写 eula.txt（同意 Mojang EULA） */
function acceptEula(home, id) {
  const dir = workDir(home, id);
  fs.mkdirSync(dir, { recursive: true });
  const txt = [
    '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).',
    `#${new Date().toUTCString()}`,
    'eula=true',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'eula.txt'), txt, 'utf8');
  update(home, id, { eulaAccepted: true });
  return { ok: true };
}

function hasEula(home, id) {
  const p = path.join(workDir(home, id), 'eula.txt');
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(p, 'utf8'));
  } catch {
    return false;
  }
}

/* ============================================================
 * 运行时（进程管理）
 * ============================================================ */

/** id → runtime（单进程单例，和安卓 ServerRuntime 同思路） */
const runtimes = new Map();

function getRuntime(id) {
  return runtimes.get(safeId(id)) || null;
}

/** 解析 java 可执行文件：优先玩家指定，其次按主版本从已探测列表里找 */
async function resolveJava(home, meta) {
  const java = require('./java');
  if (meta.javaPath && fs.existsSync(meta.javaPath)) {
    return { path: meta.javaPath, major: meta.javaMajor || 0, source: '手动指定' };
  }
  const major = meta.javaMajor || javaMajorFor(meta.mcVersion);
  const list = await java.detectCached({ home }).catch(() => []);
  const arr = Array.isArray(list) ? list : (list && list.items) || [];
  const want = Number(major) || 0;
  const exact = arr.find((j) => Number(j.major) === want);
  if (exact) return { path: exact.path, major: exact.major, source: '自动匹配' };
  // 找不到精确的就找 >= want 里最小的
  const higher = arr
    .filter((j) => Number(j.major) >= want)
    .sort((a, b) => Number(a.major) - Number(b.major))[0];
  if (higher) return { path: higher.path, major: higher.major, source: `降级匹配（需要 ${want}）` };
  const any = arr[0];
  if (any) return { path: any.path, major: any.major, source: `兜底（需要 ${want}）` };
  throw new Error(`没有可用的 Java（需要 Java ${want}）。请到「设置 → Java」装一个，或手动指定。`);
}

/** 启动前检查，返回问题清单而不是直接抛 */
async function preflight(home, id) {
  const meta = readMeta(home, id);
  const issues = [];
  if (!meta) return { ok: false, issues: [{ level: 'error', text: `服务端不存在：${id}` }] };

  const dir = workDir(home, id);
  if (!fs.existsSync(dir)) issues.push({ level: 'error', text: '工作目录不存在' });

  /**
   * ★ Forge/NeoForge 1.17+ 没有单一 jar，用的是 @args 文件。
   *   这两种形态要分开判定，否则会误报「还没下载服务端 jar」。
   */
  const hasArgsLaunch = Array.isArray(meta.launchArgs) && meta.launchArgs.length > 0;
  /** 供返回值用（args 形态下没有 jar，给 null） */
  let jarPath = null;
  if (hasArgsLaunch) {
    const argsRel = String(meta.launchArgs[0] || '').replace(/^@/, '');
    const argsPath = path.join(dir, argsRel);
    if (!fs.existsSync(argsPath)) {
      issues.push({ level: 'error', text: `启动参数文件不存在：${argsRel}（建议重新下载服务端）` });
    }
  } else if (!meta.jar) {
    issues.push({ level: 'error', text: '还没下载服务端 jar（先点「下载服务端」）' });
  } else {
    jarPath = path.join(dir, meta.jar);
    if (!fs.existsSync(jarPath)) issues.push({ level: 'error', text: `服务端 jar 不存在：${meta.jar}` });
  }

  if (!hasEula(home, id)) issues.push({ level: 'warn', text: '还没同意 EULA（Mojang 要求首次启动前同意，点「同意 EULA」即可）' });

  const port = Number(meta.port) || 25565;
  const pr = await checkPort(port);
  if (!pr.free) issues.push({ level: 'error', text: pr.error });

  let javaInfo = null;
  try {
    javaInfo = await resolveJava(home, meta);
  } catch (err) {
    issues.push({ level: 'error', text: err.message });
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    java: javaInfo,
    jarPath,
    workDir: dir,
    port,
  };
}

/** 读 server.properties 里的端口（元数据里的 port 可能过期） */
function syncPortFromProps(home, id) {
  try {
    const p = path.join(workDir(home, id), 'server.properties');
    const txt = fs.readFileSync(p, 'utf8');
    const m = /^\s*server-port\s*=\s*(\d+)\s*$/im.exec(txt);
    if (m) {
      const port = Number(m[1]);
      update(home, id, { port });
      return port;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 启动服务端。
 * @param {{onLog?:Function, onState?:Function}} options
 * @returns {Promise<{ok:boolean, error?:string, issues?:Array}>}
 */
async function start(home, id, options = {}) {
  const sid = safeId(id);
  const existing = runtimes.get(sid);
  if (existing && existing.child && !existing.stopped) {
    return { ok: false, error: '服务端已在运行中' };
  }

  const pre = await preflight(home, sid);
  if (!pre.ok) {
    return { ok: false, error: pre.issues.find((i) => i.level === 'error')?.text || '启动前检查未通过', issues: pre.issues };
  }

  const meta = readMeta(home, sid);
  const jre = pre.java;
  const dir = pre.workDir;
  const maxHeap = Number(meta.maxHeapMb) || 2048;

  // 构造命令行：-Xms 与 -Xmx 同值（服务端惯例），加玩家自定义 JVM 参数
  const jvmArgs = [`-Xms${Math.min(512, maxHeap)}M`, `-Xmx${maxHeap}M`];
  for (const a of String(meta.extraJvmArgs || '').split(/\s+/).filter(Boolean)) jvmArgs.push(a);
  /**
   * ★★★ 2026-11-22 修（实测踩到：服务端日志里的中文全是乱码）。
   *
   * Windows 上 Java 往**管道**写 stdout/stderr 时默认用系统代码页（GBK/936），
   * 而 Node 这边 setEncoding('utf8') 解码 → 「收到命令」显示成「鏀跺埌鍛戒护」。
   * 只加 -Dfile.encoding=UTF-8 不够（那只管文件读写），必须把**标准流**的编码也钉住：
   *   · Java 18+ 认 -Dstdout.encoding / -Dstderr.encoding
   *   · Java 8~17 认 -Dsun.stdout.encoding / -Dsun.stderr.encoding
   * 两套都加上，覆盖所有版本（不认的那个会被忽略，不会报错）。
   */
  const ENC_ARGS = [
    '-Dfile.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
  ];
  for (const a of ENC_ARGS) {
    const key = a.split('=')[0];
    if (!jvmArgs.some((x) => x.startsWith(`${key}=`))) jvmArgs.push(a);
  }
  if (!jvmArgs.some((a) => /-Djava\.awt\.headless/i.test(a))) jvmArgs.push('-Djava.awt.headless=true');

  const progArgs = [];
  /**
   * ★ Forge / NeoForge 1.17+ 不是「-jar 一个文件」：
   *   它们用 `@libraries/.../win_args.txt`（里面写了 -cp 和 main class），
   *   所以这里要区分两种启动形态：
   *     ① 普通 jar：`-jar server.jar`
   *     ② args 文件：`@相对路径`（JVM 会把它展开成完整参数）
   */
  if (Array.isArray(meta.launchArgs) && meta.launchArgs.length) {
    for (const a of meta.launchArgs) progArgs.push(a);
  } else {
    if (!meta.jar) {
      throw new Error('这个服务端还没装好（没有可启动的 jar），请先点「下载服务端」');
    }
    progArgs.push('-jar', meta.jar);
  }
  for (const a of String(meta.extraArgs || '').split(/\s+/).filter(Boolean)) progArgs.push(a);
  // 新版服务端支持 --nogui；老版本不认会报错，所以只在 1.14+ 加
  // ★ Forge/NeoForge 的 args 文件已经带了启动参数，不再追加 --nogui
  if (!(Array.isArray(meta.launchArgs) && meta.launchArgs.length)) {
    if (javaMajorSupportsNogui(meta.mcVersion) && !progArgs.includes('--nogui')) progArgs.push('--nogui');
  }

  const args = jvmArgs.concat(progArgs);

  const rt = {
    id: sid,
    child: null,
    state: 'starting',
    startedAt: Date.now(),
    stopped: false,
    exitCode: null,
    lastError: '',
    lines: [],
    logStream: null,
    readyAt: null,
    stopping: false,
    autoBackupTimer: null,
    restartCount: 0,
    commandLine: [jre.path, ...args],
  };

  // 日志文件
  try {
    fs.mkdirSync(logsDir(home, sid), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    rt.logStream = fs.createWriteStream(path.join(logsDir(home, sid), `run-${stamp}.log`), { flags: 'a' });
    // ★ 必须挂 error 监听：WriteStream 的写入失败是异步 'error' 事件，
    //   try/catch 拦不到，不挂就会变成未捕获异常打崩主进程（踩过）
    rt.logStream.on('error', () => {
      try {
        rt.logStream = null;
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* 写不了日志不影响运行 */
  }

  const emit = (line) => {
    const text = String(line);
    rt.lines.push(text);
    if (rt.lines.length > 3000) rt.lines.splice(0, rt.lines.length - 3000);
    /**
     * ★★★ 2026-11-22 修（实测踩到 ERR_STREAM_WRITE_AFTER_END）。
     *
     * 进程退出时的事件顺序是：child.on('exit') 里先 logStream.end()，
     * 然后 emit() 还要补一行「服务端已退出」的日志 —— 此时流已经 end，
     * write() 会**抛未捕获的 error 事件直接把整个主进程打崩**。
     * try/catch 拦不住 WriteStream 的异步 'error' 事件，必须：
     *   ① 用 writableEnded / destroyed 判断流还活着没
     *   ② 给流挂 'error' 监听，防止任何写失败变成未捕获异常
     */
    try {
      const s = rt.logStream;
      if (s && !s.writableEnded && !s.destroyed && s.writable) {
        s.write(text + '\n');
      }
    } catch {
      /* 写日志失败绝不能影响服务端 */
    }
    if (typeof options.onLog === 'function') {
      try {
        options.onLog(text);
      } catch {
        /* 界面回调异常不影响服务端 */
      }
    }
    // 就绪判定：Done (12.345s)! For help, type "help"
    if (!rt.readyAt && /Done\s*\([\d.]+s\)!/.test(text)) {
      rt.readyAt = Date.now();
      rt.state = 'running';
      if (typeof options.onState === 'function') options.onState('running', '服务端已就绪');
    }
    // 端口/绑定失败等常见错误提前识别，便于给中文诊断
    if (/FAILED TO BIND TO PORT|Perhaps a server is already running/i.test(text)) {
      rt.lastError = '端口被占用';
    } else if (/You need to agree to the EULA/i.test(text)) {
      rt.lastError = '还没同意 EULA';
    } else if (/UnsupportedClassVersionError/i.test(text)) {
      rt.lastError = 'Java 版本过低';
    }
  };

  if (typeof options.onState === 'function') options.onState('starting', '正在启动');

  let child;
  try {
    child = spawn(jre.path, args, {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    rt.state = 'crashed';
    rt.lastError = `无法启动 Java：${err.message}`;
    return { ok: false, error: rt.lastError };
  }
  rt.child = child;
  runtimes.set(sid, rt);

  update(home, sid, { lastStarted: Date.now() });

  // 逐行读 stdout/stderr
  /**
   * ★ 解码策略（2026-11-22）：
   *   上面已经给 Java 加了 UTF-8 输出参数，但**老的 Java（8/11/17 在某些环境下）
   *   仍然会按 GBK 往管道写**。所以这里再做一层兜底：
   *   先按 UTF-8 解；如果解出来的字符串里出现大量「非 ASCII 又不是中文」的替换字符
   *   （U+FFFD）或典型 GBK 乱码特征，就改用 GBK 重新解码这一段。
   *   这样不管玩家的 Java 是什么版本，控制台里的中文都能正常显示。
   */
  const decodeChunk = (buf) => {
    const utf8 = buf.toString('utf8');
    // UTF-8 解码失败会产生 U+FFFD；数量明显就说明不是 UTF-8
    const bad = (utf8.match(/\uFFFD/g) || []).length;
    if (bad > 0 && bad * 4 >= utf8.length) {
      try {
        const gbk = new TextDecoder('gbk').decode(buf);
        if (!gbk.includes('\uFFFD')) return gbk;
      } catch {
        /* 该 Node 版本没有 GBK 解码器就放弃 */
      }
    }
    return utf8;
  };

  const pipe = (stream, tag) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += decodeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let idx = buf.search(/\r?\n/);
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' && buf[idx + 1] === '\n' ? 2 : 1));
        if (line.trim()) emit(tag === 'err' ? `[错误] ${line}` : line);
        idx = buf.search(/\r?\n/);
      }
    });
    stream.on('end', () => {
      if (buf.trim()) emit(tag === 'err' ? `[错误] ${buf}` : buf);
    });
  };
  pipe(child.stdout, 'out');
  pipe(child.stderr, 'err');

  child.on('error', (err) => {
    rt.lastError = `进程错误：${err.message}`;
    emit(`[错误] ${rt.lastError}`);
  });

  child.on('exit', (code, signal) => {
    rt.stopped = true;
    rt.exitCode = code;
    const runMs = Date.now() - rt.startedAt;
    const wasStop = rt.stopping;
    rt.state = wasStop ? 'stopped' : code === 0 ? 'stopped' : 'crashed';
    if (!wasStop && code !== 0) {
      rt.lastError = rt.lastError || `进程异常退出（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）`;
    }
    if (rt.autoBackupTimer) {
      clearInterval(rt.autoBackupTimer);
      rt.autoBackupTimer = null;
    }
    const cur = readMeta(home, sid);
    if (cur) {
      update(home, sid, {
        lastExited: Date.now(),
        lastExitCode: code,
        totalRunMs: (Number(cur.totalRunMs) || 0) + runMs,
      });
    }
    /**
     * ★ 顺序很重要：**先 emit 退出那一行，再 end 流**。
     *   以前反过来了 —— end 之后 emit 还要写日志，触发
     *   ERR_STREAM_WRITE_AFTER_END 把主进程打崩（实测踩到）。
     */
    emit(`--- 服务端已退出（退出码 ${code}${wasStop ? '，主动停止' : ''}，运行 ${Math.round(runMs / 1000)} 秒）---`);
    if (typeof options.onState === 'function') options.onState(rt.state, rt.lastError || '已停止');

    // 自动重启
    const fresh = readMeta(home, sid);
    if (!wasStop && fresh && fresh.autoRestart) {
      const max = Number(fresh.autoRestartMax) || 3;
      if (rt.restartCount < max) {
        rt.restartCount += 1;
        emit(`--- 自动重启（第 ${rt.restartCount}/${max} 次）---`);
        setTimeout(() => {
          runtimes.delete(sid);
          start(home, sid, options).catch(() => {});
        }, 3000);
      } else {
        emit(`--- 已达到自动重启上限（${max} 次），不再重启 ---`);
      }
    }

    // ★ 所有 emit 都走完后才关闭日志流（顺序反过来会 write-after-end）
    try {
      const s = rt.logStream;
      if (s && !s.writableEnded && !s.destroyed) s.end();
    } catch {
      /* ignore */
    }
  });

  // 自动备份定时器
  if (meta.autoBackup && meta.autoBackup.enabled) {
    const intervalMs = Math.max(1, Number(meta.autoBackup.intervalMin) || 30) * 60000;
    rt.autoBackupTimer = setInterval(() => {
      try {
        const backup = require('./serverbackup');
        backup
          .create(home, sid, { reason: 'auto', full: !!meta.autoBackup.full })
          .then((r) => {
            emit(`--- 已自动备份：${r.name}（${formatBytes(r.bytes)}）---`);
            backup.prune(home, sid, Number(meta.autoBackup.keep) || 10);
          })
          .catch((err) => emit(`[错误] 自动备份失败：${err.message}`));
      } catch {
        /* ignore */
      }
    }, intervalMs);
    if (rt.autoBackupTimer.unref) rt.autoBackupTimer.unref();
  }

  return { ok: true, java: jre, args, workDir: dir, pid: child.pid };
}

/** 1.14+ 才支持 --nogui 参数（更老的版本会把它当非法参数） */
function javaMajorSupportsNogui(mcVersion) {
  const v = String(mcVersion || '');
  if (/^2\d\./.test(v)) return true;
  const m = /^1\.(\d+)/.exec(v);
  if (!m) return false;
  return Number(m[1]) >= 14;
}

/**
 * 优雅停止：先发 `stop`，等 ready 超时，再强杀。
 * 照安卓 ServerStopSignal 的思路：绝不直接 kill，先让服务端自己保存世界。
 */
async function stop(home, id, options = {}) {
  const sid = safeId(id);
  const rt = runtimes.get(sid);
  if (!rt || !rt.child || rt.stopped) return { ok: true, already: true };

  rt.stopping = true;
  rt.state = 'stopping';
  if (typeof options.onState === 'function') options.onState('stopping', '正在停止（保存世界）');

  const waitMs = Number(options.waitMs) || 30000;
  try {
    rt.child.stdin.write('stop\n');
  } catch {
    /* 管道可能已断，直接进入强杀分支 */
  }

  const exited = await waitFor(() => rt.stopped, waitMs);
  if (exited) {
    return { ok: true, graceful: true, exitCode: rt.exitCode };
  }

  // 超时：强杀整棵树（Windows 上 java 可能还有子进程）
  forceKill(rt.child);
  await waitFor(() => rt.stopped, 8000);
  return { ok: true, graceful: false, exitCode: rt.exitCode, note: '等待超时，已强制结束（世界可能未完整保存）' };
}

/** 向运行中的服务端发一条命令（等价于在控制台输入） */
function sendCommand(home, id, cmd) {
  const sid = safeId(id);
  const rt = runtimes.get(sid);
  if (!rt || !rt.child || rt.stopped) return { ok: false, error: '服务端未运行' };
  const text = String(cmd || '').trim();
  if (!text) return { ok: false, error: '命令为空' };
  try {
    rt.child.stdin.write(text + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }
}

/**
 * 强制结束进程树。
 * ★ Windows 上 javaw/java 可能再起子进程，只 kill 主进程会留下孤儿占着端口。
 */
function forceKill(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      // taskkill /T 杀整棵树
      const { execFileSync } = require('node:child_process');
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/** 等条件成立（轮询），返回是否成立 */
function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = !!fn();
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** 运行时状态快照（给界面轮询） */
function status(home, id) {
  const sid = safeId(id);
  const rt = runtimes.get(sid);
  const meta = readMeta(home, sid);
  if (!rt) {
    return {
      id: sid,
      state: 'idle',
      running: false,
      meta,
      lines: [],
    };
  }
  return {
    id: sid,
    state: rt.state,
    running: !rt.stopped,
    startedAt: rt.startedAt,
    uptimeMs: rt.stopped ? 0 : Date.now() - rt.startedAt,
    readyAt: rt.readyAt,
    exitCode: rt.exitCode,
    lastError: rt.lastError,
    stopping: rt.stopping,
    commandLine: rt.commandLine,
    lines: rt.lines.slice(-400),
    meta,
  };
}

/** 取运行日志尾部（进程已退出时从最近一个 run-*.log 读） */
function tailLog(home, id, lines = 200) {
  const rt = runtimes.get(safeId(id));
  if (rt && rt.lines.length) return rt.lines.slice(-lines);
  const dir = logsDir(home, id);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^run-.*\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.f);
  } catch {
    return [];
  }
  if (!files.length) return [];
  try {
    const txt = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const all = txt.split(/\r?\n/).filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/* ============================================================
 * 崩溃诊断（退出码 + 日志 → 中文结论）
 * ============================================================ */

const EXIT_HINTS = {
  0: '正常退出。',
  1: '服务端报错退出。常见原因：端口被占用、EULA 未同意、server.properties 写错、模组不兼容。',
  137: '进程被系统强制结束（通常是内存不足被 OOM Killer 干掉，或手动 kill）。',
  '-1073741819': 'Java 访问违例（0xC0000005），多半是 JDK 与系统不匹配，或某个模组/插件 native 崩溃。',
  '-1073741515': '缺少运行库（0xC0000135）。装一下 Microsoft Visual C++ 运行库。',
};

/** 根据日志内容猜具体原因（比只看退出码准） */
const LOG_PATTERNS = [
  { re: /FAILED TO BIND TO PORT|Perhaps a server is already running/i, text: '端口被占用：改 server-port，或先关掉占着这个端口的程序。' },
  { re: /You need to agree to the EULA/i, text: '还没同意 EULA：点「同意 EULA」再启动。' },
  { re: /UnsupportedClassVersionError|class file version (\d+)/i, text: 'Java 版本过低：服务端需要的 Java 比你当前的更新，换个更高的 Java。' },
  { re: /OutOfMemoryError/i, text: '内存不足：把「最大内存」调大，或减少模组/插件。' },
  { re: /UnknownHostException|Connection refused.*auth|Failed to verify username/i, text: '连不上 Mojang 验证服务器：检查网络；只想局域网玩可以把 online-mode 关掉。' },
  { re: /java\.lang\.NoSuchMethodError|java\.lang\.NoClassDefFoundError/i, text: '模组/插件与当前服务端版本不匹配：常见于 Paper/Forge 混装，检查 plugin 是否支持这个版本。' },
  { re: /at net\.minecraft\.server\..*Exception|Exception in thread "Server thread"/i, text: '服务端主线程异常：往下看第一段 at ... 里的类名，通常是某个模组/插件。' },
  { re: /Invalid or corrupt jarfile/i, text: 'jar 文件损坏：重新下载服务端 jar。' },
  { re: /world.*corrupt|corrupt.*chunk/i, text: '世界文件损坏：用「备份 → 恢复」回滚到上一个备份。' },
];

/**
 * 诊断一次启动失败。
 * @returns {{exitCode:number|null, summary:string, hints:string[], tail:string[]}}
 */
function diagnose(home, id) {
  const sid = safeId(id);
  const rt = runtimes.get(sid);
  const lines = tailLog(home, sid, 400);
  const exitCode = rt ? rt.exitCode : (readMeta(home, sid) || {}).lastExitCode ?? null;

  const hints = [];
  for (const p of LOG_PATTERNS) {
    if (lines.some((l) => p.re.test(l))) hints.push(p.text);
  }
  let summary = '';
  if (rt && rt.lastError) summary = rt.lastError;
  if (!summary && exitCode !== null && EXIT_HINTS[String(exitCode)]) summary = EXIT_HINTS[String(exitCode)];
  if (!summary) summary = exitCode === null ? '没有拿到退出码（可能还没运行过）' : `进程退出（退出码 ${exitCode}）`;
  if (!hints.length && exitCode === 0) hints.push('这次是正常退出。');

  // 抓最后一段 "Caused by" / "at ..." 便于玩家复制
  const tail = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 25; i -= 1) {
    if (/Exception|Error|Caused by|at [a-z]/.test(lines[i])) tail.unshift(lines[i]);
    if (tail.length && /^---/.test(lines[i])) break;
  }

  return { exitCode, summary, hints, tail };
}

/* ============================================================
 * 工具
 * ============================================================ */

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 可选的 MC 版本列表（供界面下拉） */
async function availableVersions(home, options = {}) {
  const mojang = require('./mojang');
  const m = await mojang.manifest({
    cacheDir: paths.metaDir(home),
    source: options.source,
    timeoutMs: 20000,
  });
  const list = ((m && m.versions) || []).filter((v) => v.type === 'release');
  return list.map((v) => v.id);
}

/**
 * 离线模式玩家的 UUID。
 *
 * 服务端在 `online-mode=false` 时按 `UUIDv3(name, "OfflinePlayer")` 生成玩家 UUID。
 * 白名单里如果填了别的值，服务端会认为「这个人不在白名单里」，导致加了也进不去。
 * 所以离线服加白名单必须按这个规则算。
 *
 * 实现：MD5(name + "OfflinePlayer") → 按 UUID 格式输出，并把 version/variant 位设成 3。
 */
function offlineUuid(name) {
  const crypto = require('node:crypto');
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${String(name || '')}`, 'utf8').digest();
  // 设置 version = 3（name-based MD5）
  md5[6] = (md5[6] & 0x0f) | 0x30;
  // 设置 variant = RFC 4122
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

module.exports = {
  SERVER_KINDS,
  KIND_LABELS,
  STATES,
  javaMajorFor,
  // 路径
  serversRoot,
  serverDir,
  workDir,
  backupsDir,
  logsDir,
  // CRUD
  list,
  create,
  createAuto,
  pickPort,
  update,
  remove,
  readMeta,
  writeMeta,
  // 端口
  checkPort,
  findFreePort,
  // 下载
  resolveServerJar,
  downloadServerJar,
  vanillaServerInfo,
  paperServerInfo,
  purpurServerInfo,
  fabricServerInfo,
  forgeServerInfo,
  neoforgeServerInfo,
  installForgeLike,
  detectForgeLaunch,
  safeJarName,
  // EULA
  acceptEula,
  hasEula,
  // 运行时
  preflight,
  resolveJava,
  start,
  stop,
  sendCommand,
  status,
  tailLog,
  getRuntime,
  forceKill,
  syncPortFromProps,
  // 诊断
  diagnose,
  EXIT_HINTS,
  LOG_PATTERNS,
  // 杂
  formatBytes,
  availableVersions,
  offlineUuid,
};
