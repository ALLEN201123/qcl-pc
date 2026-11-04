'use strict';
/*
 * contentapi.js —— 内容 API（搜索 / 项目详情 / 版本列表 / 真实下载 / 收藏）。
 *
 * 支持三种**下载源**（source 维度，默认 mixed）：
 *   · 'modrinth'   —— Modrinth 官方 API（https://api.modrinth.com/v2，免费无需 key）
 *   · 'curseforge' —— CurseForge（官方 API 无 key 会 403，这里走**镜像** mod.mcimirror.top，无需 key）
 *   · 'mixed'      —— 两边都查，按标题去重合并（同名的保留下载量高的），每个结果带 source 字段
 *
 * ★ 硬性要求：**每个请求都必须带 User-Agent**（Modrinth 的用规明确要求能识别调用方），
 *   不带的请求会被 CDN 直接拒掉（403）。
 *
 * ★★★ 实测的真实字段名（2026-11-05 用真实请求核对过，别照文档猜）：
 *
 *   ── Modrinth ──────────────────────────────────────────────
 *   搜索 GET /v2/search
 *     顶层：{ hits, offset, limit, **total_hits** }   ← 注意是 total_hits，**没有** total 字段
 *     hit：project_id / project_type / slug / author / title / description /
 *          categories / versions（**游戏版本号**数组，如 ["1.20.1","1.21"]）/
 *          downloads / follows / icon_url / latest_version（**版本 id**，如 "FLkaba1E"）
 *   项目 GET /v2/project/{idOrSlug}
 *     { id, slug, project_type, title, description, downloads,
 *       **followers**（详情里叫 followers，搜索结果里叫 follows）,
 *       icon_url, categories, game_versions, loaders,
 *       versions（**版本 id 数组**，与搜索里的 versions 含义不同！）,
 *       body, license:{id,name,url}, source_url, issues_url, wiki_url, published, updated }
 *     ★ 项目详情**没有 author 字段**（作者在 team 里），只有搜索结果的 hit 才带 author。
 *   版本 GET /v2/project/{idOrSlug}/version?game_versions=["1.20.1"]&loaders=["fabric"]
 *     [{ id, name, version_number, game_versions, loaders, date_published,
 *        version_type, files: [{ id, url, filename, size, primary, hashes:{sha1,sha512} }] }]
 *
 *   ── CurseForge（镜像 https://mod.mcimirror.top/curseforge）─────────────
 *   搜索 GET /v1/mods/search?gameId=432&classId=<见 CF_CLASS_IDS>&index=<offset>
 *          &pageSize=<limit ≤ 50>&sortField=2&sortOrder=desc[&searchFilter=..][&gameVersion=..][&modLoaderType=..]
 *     顶层：{ data:[...], pagination:{ index, pageSize, resultCount, totalCount } }
 *     ★ totalCount 最多到 10000（分页上限），不是真实总数。
 *     ★ **pageSize 上限 50**：传 100 镜像直接 500。
 *     mod：{ id, gameId, name, slug, links:{websiteUrl,wikiUrl,issuesUrl,sourceUrl},
 *            summary, downloadCount, favoriteCount, classId, authors:[{id,name,url,avatarUrl}],
 *            logo:{thumbnailUrl,url}, categories:[{id,name,slug}],
 *            latestFiles:[...], latestFilesIndexes:[{gameVersion,fileId,filename,releaseType,modLoader}] }
 *       —— 字段名与 Modrinth 完全不同：name→title、summary→description、
 *          downloadCount→downloads、logo.thumbnailUrl→iconUrl、favoriteCount→follows（近似）
 *   项目 GET /v1/mods/{id}                      → { data: 同上单个 mod }
 *   文件列表 GET /v1/mods/{id}/files?pageSize=50[&gameVersion=..][&modLoaderType=..]
 *     → { data:[{ id, modId, displayName, fileName, releaseType(1发布/2测试/3内测),
 *                fileDate, fileLength, downloadCount, downloadUrl, gameVersions:["1.21.1","NeoForge","Client"],
 *                hashes:[{value,algo}] }], pagination:{...} }
 *       ★ hashes 里 **algo=1 是 sha1**（40 位十六进制），algo=2 是 md5（32 位）。
 *       ★ 文件对象没有 version_number 字段，只能从 displayName / fileName 里提取。
 *   单个文件 GET /v1/mods/{modId}/files/{fileId} → { data: 同上单个文件 }（实测可用）
 *   ★ 部分文件 downloadUrl 为 null（作者在 CurseForge 后台关了第三方分发），
 *     这时只能给中文提示让用户去网页手动下，不能静默失败。
 *   ★ CurseForge 的 classId（实测 /v1/categories?gameId=432 的 isClass 列表）：
 *       6=Mods、4471=Modpacks、12=Resource Packs、6552=Shaders、17=Worlds、6945=Data Packs
 *     （另有 4546=Customization、4559=Addons、5=Bukkit Plugins，本启动器用不到）
 *   ★ modLoaderType（搜索 / 文件过滤都支持）：1=Forge、3=LiteLoader、4=Fabric、5=Quilt、6=NeoForge
 *
 * ★ 错误信息一律中文，并且严格区分两类（界面要能分别提示）：
 *   · E_NETWORK / E_TIMEOUT —— **网络不通**（连不上服务 / DNS / 超时）
 *   · E_CONTENT_API（带 status）—— **服务返回了错误**（404 找不到 / 400 参数不对 / 429 限流 / 5xx）
 */

const fs = require('node:fs');
const path = require('node:path');

const http = require('./http');
const jsonstore = require('./jsonstore');
const downloader = require('./downloader');
const paths = require('./paths');

const API_BASE = 'https://api.modrinth.com/v2';
/** CurseForge 镜像（官方 api.curseforge.com 无 key 会 403；镜像无需 key）。 */
const CF_BASE = 'https://mod.mcimirror.top/curseforge';
const CF_GAME_ID = 432; // Minecraft
/** CurseForge classId（实测自 /v1/categories?gameId=432 的 isClass 列表）。 */
const CF_CLASS_IDS = {
  mod: 6,
  modpack: 4471,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
  world: 17,
};
/** CurseForge 分页上限：pageSize > 50 镜像返回 500，必须夹住。 */
const CF_MAX_LIMIT = 50;
/** CurseForge 的 modLoaderType 枚举。 */
const CF_LOADER_IDS = {
  forge: 1,
  liteloader: 3,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};
/** gameVersions 里混着的加载器名（要挑出来当 loaders，不能当游戏版本）。 */
const LOADER_NAMES = ['forge', 'fabric', 'quilt', 'neoforge', 'liteloader', 'client', 'server'];

/** Modrinth 要求的 User-Agent（含项目地址，方便对方定位滥用来源）。 */
const USER_AGENT = 'QCL-PC/1.0.0 (github.com/QuantaCraftLauncher)';

const DEFAULT_TIMEOUT_MS = 20000;
/** 内容文件可能很大（整合包几百 MB），给足 30 分钟，别用默认 30 秒把长下载掐断。 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
/** 收藏上限，防止 favorites.json 无限长大。 */
const MAX_FAVORITES = 500;
const FAVORITES_VERSION = 1;

const SOURCES = ['mixed', 'modrinth', 'curseforge'];

/** 给界面渲染「下载源切换器」用的清单（content:sources 直接返回它）。 */
const SOURCE_LIST = [
  { id: 'mixed', name: '混合（推荐）', desc: '同时搜索 Modrinth 与 CurseForge，按热度合并去重' },
  { id: 'modrinth', name: 'Modrinth', desc: '开源社区，免费、无需登录' },
  { id: 'curseforge', name: 'CurseForge', desc: '内容最全（走镜像 mod.mcimirror.top，无需 API Key）' },
];

/** Modrinth 真实存在的 project_type。 */
const PROJECT_TYPES = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'];

/**
 * 类型别名 → 真实 project_type（Modrinth 口径）。
 *
 * ★ `world`（世界/地图）在 Modrinth 的 project_type 里**不存在** ——
 *   官方只有 mod / modpack / resourcepack / shader / datapack 五种，所以映射到 datapack。
 *   CurseForge 那边有真正的 Worlds 分类（classId=17），见 curseForgeClassId()。
 */
const PROJECT_TYPE_ALIASES = {
  mods: 'mod',
  modpack: 'modpack',
  modpacks: 'modpack',
  mod_pack: 'modpack',
  resourcepack: 'resourcepack',
  resourcepacks: 'resourcepack',
  resource_pack: 'resourcepack',
  resource_packs: 'resourcepack',
  texturepack: 'resourcepack',
  texturepacks: 'resourcepack',
  shader: 'shader',
  shaders: 'shader',
  shaderpack: 'shader',
  shaderpacks: 'shader',
  shader_pack: 'shader',
  datapack: 'datapack',
  datapacks: 'datapack',
  data_pack: 'datapack',
  world: 'datapack',
  worlds: 'datapack',
  save: 'datapack',
  saves: 'datapack',
  map: 'datapack',
  maps: 'datapack',
};

/* ------------------------------------------------------------------ 基础工具 */

/** 归一下载源；不认识的抛中文错误。空值用 fallback。 */
function normalizeSource(value, fallback) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw || raw === 'auto') return fallback || 'mixed';
  if (SOURCES.includes(raw)) return raw;
  throw new http.LauncherError(`不支持的下载源：${raw}（只支持 ${SOURCES.join(' / ')}）`, {
    code: 'E_CONTENT_SOURCE',
  });
}

/** 把 projectType 归一成 Modrinth 的 project_type；不认识的抛中文错误（不静默乱查）。 */
function normalizeProjectType(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  if (PROJECT_TYPES.includes(raw)) return raw;
  const alias = PROJECT_TYPE_ALIASES[raw];
  if (alias) return alias;
  throw new http.LauncherError(
    `不支持的内容类型：${raw}（支持 ${PROJECT_TYPES.join(' / ')}；世界类请用 world 或 datapack）`,
    { code: 'E_CONTENT_TYPE' }
  );
}

/**
 * projectType → CurseForge classId。
 * ★ 这里**不能**先走 normalizeProjectType：world 在 Modrinth 会被映射成 datapack，
 *   但 CurseForge 有真正的 Worlds（17），所以要先把 world 系列单独接住。
 */
function curseForgeClassId(projectType) {
  const raw = String(projectType == null ? '' : projectType).trim().toLowerCase();
  if (!raw) return null;
  if (['world', 'worlds', 'save', 'saves', 'map', 'maps'].includes(raw)) return CF_CLASS_IDS.world;
  if (['data_pack', 'data_packs'].includes(raw)) return CF_CLASS_IDS.datapack;
  const type = normalizeProjectType(raw); // 会抛中文错误
  return CF_CLASS_IDS[type] || null;
}

/** classId 反查 projectType（搜索 CurseForge 时若调用方没给类型，用它标 source 分类）。 */
function projectTypeOfClassId(classId) {
  const n = Number(classId);
  for (const [type, id] of Object.entries(CF_CLASS_IDS)) {
    if (id === n) return type;
  }
  return '';
}

/** 加载器名 → CurseForge modLoaderType（不认识/不需要过滤时返回 0）。 */
function curseForgeLoaderId(loader) {
  const raw = String(loader == null ? '' : loader).trim().toLowerCase();
  return CF_LOADER_IDS[raw] || 0;
}

/** 校验并返回 project 的 id / slug。 */
function requireProjectKey(idOrSlug, what) {
  const key = String(idOrSlug == null ? '' : idOrSlug).trim();
  if (!key) {
    throw new http.LauncherError(`${what || '操作'}失败：没有给出项目 id 或 slug`, { code: 'E_CONTENT_NO_ID' });
  }
  return key;
}

function requireCurseForgeId(id, what) {
  const key = String(id == null ? '' : id).trim();
  if (!/^\d+$/.test(key)) {
    throw new http.LauncherError(
      `${what || '操作'}失败：CurseForge 的项目 id 必须是纯数字（收到「${key || '空'}」）`,
      { code: 'E_CONTENT_NO_ID' }
    );
  }
  return key;
}

/** 是不是「像 Minecraft 版本号」的字符串（1.20.1 / 26.3 / 25w46a）。 */
function isMcVersionString(value) {
  const s = String(value == null ? '' : value).trim();
  return /^\d+\.\d+/.test(s) || /^\d{2}w\d{2}[a-z]?$/i.test(s);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** 拼 URL（query 里的对象/数组按 Modrinth 要求 JSON.stringify 后 encode；镜像同样吃这套）。 */
function buildUrl(base, endpoint, query) {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const root = `${String(base || API_BASE).replace(/\/+$/, '')}${suffix}`;
  if (!query || typeof query !== 'object') return root;
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length ? `${root}?${parts.join('&')}` : root;
}

/**
 * 把底层异常翻译成中文，并区分「网络不通」与「API 返回错误」。
 * @param {*} err 底层异常（http.js 的 LauncherError）
 * @param {string} what 正在做什么（拼进提示）
 * @param {string} [service] 服务显示名（默认 Modrinth；CurseForge 走 'CurseForge 镜像'）
 */
function translateError(err, what, service) {
  const name = service || 'Modrinth';
  const subject = `${what || `访问 ${name}`}失败`;
  const code = err && err.code;

  // ① 网络不通：http.js 已经归到 E_NETWORK / E_TIMEOUT
  if (code === 'E_TIMEOUT') {
    return new http.LauncherError(`${subject}：连接 ${name} 超时，请检查网络后重试`, {
      code: 'E_TIMEOUT',
      cause: err,
    });
  }
  if (code === 'E_NETWORK') {
    return new http.LauncherError(
      `${subject}：连不上 ${name}（网络不通、DNS 被拦截或对方服务器不可达），请检查网络后重试`,
      { code: 'E_NETWORK', cause: err }
    );
  }
  if (code === 'E_CANCELLED') {
    return new http.LauncherError(`${subject}：已取消`, { code: 'E_CANCELLED', cause: err });
  }

  // ② API 返回错误：http.js 把非 2xx 归到 E_HTTP 并带上 status
  const status = err && (err.status || err.statusCode);
  if (status) {
    let hint;
    if (status === 400) hint = `${name} 不接受这组参数（格式不对或 id 非法）`;
    else if (status === 404) hint = `${name}上找不到该内容（可能已被作者删除、改名或 id 写错）`;
    else if (status === 403) hint = `${name}拒绝了这次请求（可能是请求头或网络中间设备问题）`;
    else if (status === 429) hint = `请求太频繁，被 ${name} 限流了，请等几十秒再试`;
    else if (status >= 500) hint = `${name}服务器出错（HTTP ${status}），请稍后再试`;
    else hint = `${name}返回了 HTTP ${status}`;
    const e = new http.LauncherError(`${subject}：${hint}`, { code: 'E_CONTENT_API', cause: err });
    e.status = status;
    return e;
  }

  // ③ 其它（JSON 解析失败 / 未知）
  if (code === 'E_JSON') {
    return new http.LauncherError(`${subject}：${name}返回的内容不是合法 JSON（可能被网络中间设备改写了）`, {
      code: 'E_JSON',
      cause: err,
    });
  }
  return new http.LauncherError(`${subject}：${(err && err.message) || String(err)}`, {
    code: 'E_CONTENT_API',
    cause: err,
  });
}

/**
 * 发起一次 API 请求并返回 JSON。
 * 所有请求都带 User-Agent，并统一把错误翻成中文。
 * @param {string} endpoint
 * @param {{query?:object, what?:string, signal?:AbortSignal, base?:string,
 *          service?:string, timeoutMs?:number, retries?:number}} [options]
 */
async function requestJson(endpoint, options) {
  const opts = options || {};
  const url = buildUrl(opts.base || API_BASE, endpoint, opts.query);
  let data;
  try {
    // http.js 自带超时 + 重试（429 / 5xx 会重试，4xx 不重试）
    data = await http.fetchJson(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      retries: Number.isFinite(opts.retries) ? opts.retries : 2,
    });
  } catch (err) {
    throw translateError(err, opts.what, opts.service);
  }
  return data;
}

/* ------------------------------------------------------------------ 数据整形 */

/** Modrinth 搜索结果 hit → 界面统一结构。 */
function shapeHit(hit) {
  const h = hit || {};
  return {
    id: String(h.project_id || h.id || ''),
    slug: String(h.slug || ''),
    title: String(h.title || ''),
    description: String(h.description || ''),
    author: String(h.author || ''),
    downloads: toNumber(h.downloads),
    follows: toNumber(h.follows),
    iconUrl: String(h.icon_url || ''),
    categories: toStringArray(h.categories),
    // 搜索里的 versions 是**游戏版本号**（1.20.1 / 26.3 …）
    versions: toStringArray(h.versions),
    projectType: String(h.project_type || ''),
    // latest_version 是**版本 id**（如 FLkaba1E），点「安装」时可直接拿它去查版本
    latestVersion: h.latest_version ? String(h.latest_version) : null,
    source: 'modrinth',
  };
}

/** Modrinth 项目详情 → 与 hit 尽量同构（方便界面复用同一套卡片）。 */
function shapeProject(project) {
  const p = project || {};
  const license = p.license && (p.license.id || p.license.name) ? String(p.license.id || p.license.name) : '';
  return {
    id: String(p.id || ''),
    slug: String(p.slug || ''),
    title: String(p.title || ''),
    description: String(p.description || ''),
    // ★ 详情接口没有 author（作者挂在 team 里，要另查 /v2/team/{id}/members），只能留空
    author: String(p.author || ''),
    downloads: toNumber(p.downloads),
    // ★ 详情里叫 followers（搜索结果里叫 follows）
    follows: toNumber(p.followers === undefined ? p.follows : p.followers),
    iconUrl: String(p.icon_url || ''),
    categories: toStringArray(p.categories),
    // 与 hit 对齐：versions = 游戏版本号列表
    versions: toStringArray(p.game_versions),
    projectType: String(p.project_type || ''),
    // 以下是详情才有的字段
    gameVersions: toStringArray(p.game_versions),
    loaders: toStringArray(p.loaders),
    versionIds: toStringArray(p.versions), // 详情里的 versions 是版本 id 数组
    body: typeof p.body === 'string' ? p.body : '',
    license,
    sourceUrl: p.source_url ? String(p.source_url) : '',
    issuesUrl: p.issues_url ? String(p.issues_url) : '',
    wikiUrl: p.wiki_url ? String(p.wiki_url) : '',
    published: p.published || null,
    updated: p.updated || null,
    source: 'modrinth',
  };
}

/** Modrinth 版本 → 界面结构；files 只留下载需要的字段（url / filename / size / sha1）。 */
function shapeVersion(version) {
  const v = version || {};
  const files = Array.isArray(v.files) ? v.files : [];

  /**
   * ★★★ 前置依赖（2026-11-05 新增，用户要求）。
   *
   * Modrinth 的 version 对象里带 `dependencies`，每项形如：
   *   {
   *     version_id:   'xxxx' | null,   // 指定的前置版本（null = 任意版本）
   *     project_id:   'yyyy',          // 前置项目的 id（用来查名字/图标）
   *     file_name:    'xxx.jar' | null,
   *     dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded'
   *   }
   *
   * 四种类型含义：
   *   · required     —— **必须装**，不装大概率崩 → 要强烈提醒
   *   · optional     —— 可选，装了功能更全 → 提一句就行
   *   · incompatible —— 互斥，装了会冲突
   *   · embedded     —— 该前置已经打包进这个模组里了，**不需要额外装**
   *
   * ⇒ 这里全部保留原样（含 project_id / version_id），由 `resolveDependencies()`
   *   去查真实的项目名和下载版本，界面再据此弹窗。
   */
  const deps = Array.isArray(v.dependencies) ? v.dependencies : [];

  return {
    id: String(v.id || ''),
    name: String(v.name || ''),
    versionNumber: String(v.version_number || ''),
    gameVersions: toStringArray(v.game_versions),
    loaders: toStringArray(v.loaders),
    files: files.map((f) => {
      const file = f || {};
      const hashes = file.hashes || {};
      return {
        url: String(file.url || ''),
        filename: String(file.filename || ''),
        size: toNumber(file.size),
        sha1: hashes.sha1 ? String(hashes.sha1) : null,
        // primary 用来挑主文件（整合包 / 模组一般只有一个文件，多文件时优先 primary）
        primary: !!file.primary,
      };
    }),
    dependencies: deps.map((d) => {
      const dep = d || {};
      const type = String(dep.dependency_type || '').toLowerCase();
      return {
        projectId: dep.project_id ? String(dep.project_id) : null,
        versionId: dep.version_id ? String(dep.version_id) : null,
        fileName: dep.file_name ? String(dep.file_name) : null,
        // required / optional / incompatible / embedded
        type: type || 'required',
      };
    }),
    datePublished: v.date_published || null,
    versionType: String(v.version_type || ''),
    downloads: toNumber(v.downloads),
    source: 'modrinth',
  };
}

/** CurseForge 文件 hashes → sha1（algo=1 是 sha1，algo=2 是 md5）。 */
function curseForgeSha1(hashes) {
  const list = Array.isArray(hashes) ? hashes : [];
  const sha1 = list.find((h) => h && (Number(h.algo) === 1 || String(h.algo) === '1'));
  if (sha1 && sha1.value) return String(sha1.value).toLowerCase();
  // 兜底：有些镜像可能不带 algo，用 40 位十六进制自行识别
  const guess = list.find((h) => h && /^[0-9a-f]{40}$/i.test(String(h.value || '')));
  return guess ? String(guess.value).toLowerCase() : null;
}

/** CurseForge 文件 gameVersions（混着 "1.21.1" / "NeoForge" / "Client"）拆成游戏版本与加载器。 */
function splitCurseForgeGameVersions(gameVersions) {
  const list = toStringArray(gameVersions);
  const versions = list.filter((v) => isMcVersionString(v));
  const loaders = list
    .map((v) => v.toLowerCase())
    .filter((v) => LOADER_NAMES.includes(v) && v !== 'client' && v !== 'server');
  return { versions: Array.from(new Set(versions)), loaders: Array.from(new Set(loaders)) };
}

/** 直接从文件名/显示名里尽力提取一个版本号（CurseForge 没有 version_number 字段）。 */
function guessVersionNumber(text) {
  const s = String(text || '');
  const m = /(\d+(?:\.\d+)+)/.exec(s);
  return m ? m[1] : '';
}

/** CurseForge 搜索结果 mod → 与 Modrinth hit 同构（字段名完全不同，逐个映射）。 */
function shapeCurseForgeHit(mod, projectType) {
  const m = mod || {};
  const links = m.links || {};
  const authors = Array.isArray(m.authors) ? m.authors.map((a) => String((a && a.name) || '')).filter(Boolean) : [];
  const indexed = Array.isArray(m.latestFilesIndexes) ? m.latestFilesIndexes : [];
  const versions = [];
  for (const item of indexed) {
    const v = String((item && item.gameVersion) || '');
    if (isMcVersionString(v) && !versions.includes(v)) versions.push(v);
  }
  const latestFiles = Array.isArray(m.latestFiles) ? m.latestFiles : [];
  return {
    id: String(m.id == null ? '' : m.id),
    slug: String(m.slug || ''),
    title: String(m.name || ''),
    description: String(m.summary || ''),
    author: authors.join(', '),
    downloads: toNumber(m.downloadCount),
    // CurseForge 没有 follows，用收藏数 favoriteCount 近似
    follows: toNumber(m.favoriteCount),
    iconUrl: String((m.logo && (m.logo.thumbnailUrl || m.logo.url)) || ''),
    categories: Array.isArray(m.categories)
      ? m.categories.map((c) => String((c && (c.name || c.slug)) || '')).filter(Boolean)
      : [],
    versions,
    projectType: projectType || projectTypeOfClassId(m.classId),
    // 最新文件的 id 就是「版本 id」，点安装可直接拿去查文件
    latestVersion: latestFiles.length && latestFiles[0] && latestFiles[0].id != null ? String(latestFiles[0].id) : null,
    websiteUrl: String(links.websiteUrl || ''),
    updated: m.dateModified || null,
    source: 'curseforge',
  };
}

/** CurseForge 项目详情 → 与 hit 同构 + 链接字段。 */
function shapeCurseForgeProject(mod) {
  const m = mod || {};
  const links = m.links || {};
  const hit = shapeCurseForgeHit(m, projectTypeOfClassId(m.classId));
  return {
    ...hit,
    gameVersions: hit.versions,
    loaders: Array.from(
      new Set(
        (Array.isArray(m.latestFilesIndexes) ? m.latestFilesIndexes : [])
          .map((it) => String((it && it.gameVersion) || '').toLowerCase())
          .filter((v) => LOADER_NAMES.includes(v) && v !== 'client' && v !== 'server')
      )
    ),
    body: '', // CurseForge 的正文要另查 /v1/mods/{id}/description，这里不拉
    license: '',
    sourceUrl: String(links.sourceUrl || ''),
    issuesUrl: String(links.issuesUrl || ''),
    wikiUrl: String(links.wikiUrl || ''),
    published: m.dateCreated || null,
    updated: m.dateModified || null,
    source: 'curseforge',
  };
}

/** CurseForge 文件 → 与 Modrinth version 同构。 */
function shapeCurseForgeFile(file) {
  const f = file || {};
  const split = splitCurseForgeGameVersions(f.gameVersions);
  const sha1 = curseForgeSha1(f.hashes);
  const releaseType = Number(f.releaseType);
  const versionNumber = guessVersionNumber(f.displayName) || guessVersionNumber(f.fileName);
  return {
    id: String(f.id == null ? '' : f.id),
    name: String(f.displayName || f.fileName || ''),
    versionNumber: versionNumber || String(f.displayName || f.fileName || ''),
    gameVersions: split.versions,
    loaders: split.loaders,
    files: [
      {
        url: String(f.downloadUrl || ''),
        filename: String(f.fileName || ''),
        size: toNumber(f.fileLength),
        sha1,
        primary: true,
      },
    ],
    datePublished: f.fileDate || null,
    // CurseForge：1=Release、2=Beta、3=Alpha
    versionType: releaseType === 1 ? 'release' : releaseType === 2 ? 'beta' : releaseType === 3 ? 'alpha' : '',
    downloads: toNumber(f.downloadCount),
    source: 'curseforge',
  };
}

/* ------------------------------------------------------------- Modrinth 搜索 */

/**
 * 只查 Modrinth（内部函数；对外统一走 search()）。
 * @returns {Promise<{hits:Array, total:number, offset:number, limit:number}>}
 */
async function searchModrinth(options) {
  const opts = options || {};

  // facets 必须是「数组的数组」，并且整体 encodeURIComponent（buildUrl 负责）
  const facets = [];
  const projectType = normalizeProjectType(opts.projectType);
  if (projectType) facets.push([`project_type:${projectType}`]);
  const mcVersion = String(opts.mcVersion || '').trim();
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  // ★ 加载器（fabric / forge / quilt / neoforge）在 Modrinth 里就是 categories 的一个值
  const loader = String(opts.loader || '').trim().toLowerCase();
  if (loader) facets.push([`categories:${loader}`]);

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));

  const query = {
    query: String(opts.query || '').trim(),
    limit: String(limit),
    offset: String(offset),
  };
  if (facets.length) query.facets = JSON.stringify(facets);

  const what = `搜索 Modrinth ${projectType || '内容'}${opts.query ? `「${opts.query}」` : ''}`;
  const data = await requestJson('/search', {
    query,
    what,
    signal: opts.signal,
    base: opts.modrinthBase,
    service: 'Modrinth',
  });
  if (!data || !Array.isArray(data.hits)) {
    throw new http.LauncherError(`${what}失败：Modrinth 返回的搜索结果格式不正确（缺少 hits 数组）`, {
      code: 'E_CONTENT_SHAPE',
    });
  }

  const hits = data.hits.map(shapeHit);
  return {
    hits,
    // ★ 真实字段是 total_hits（不是 total）
    total: toNumber(data.total_hits),
    // 回显请求值（Modrinth 一定回 offset，缺了才用入参兜底）
    offset: data.offset === undefined ? offset : toNumber(data.offset),
    limit: toNumber(data.limit) || limit,
    hitsCount: hits.length,
  };
}

/* ---------------------------------------------------------- CurseForge 搜索 */

/**
 * 只查 CurseForge（走镜像，无需 API Key）。
 * @param {{projectType?:string, query?:string, mcVersion?:string, loader?:string,
 *          limit?:number, offset?:number, signal?:AbortSignal, curseforgeBase?:string}} [options]
 * @returns {Promise<{hits:Array, total:number, offset:number, limit:number}>}
 */
async function searchCurseForge(options) {
  const opts = options || {};
  const classId = curseForgeClassId(opts.projectType);
  const limit = Math.min(CF_MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));

  const query = {
    gameId: String(CF_GAME_ID),
    index: String(offset),
    // ★ pageSize 上限 50（传 100 镜像直接 500）
    pageSize: String(limit),
    sortField: '2', // 2 = popularity
    sortOrder: 'desc',
  };
  if (classId) query.classId = String(classId);
  const text = String(opts.query || '').trim();
  if (text) query.searchFilter = text;
  const mcVersion = String(opts.mcVersion || '').trim();
  if (mcVersion) query.gameVersion = mcVersion;
  const loaderId = curseForgeLoaderId(opts.loader);
  if (loaderId) query.modLoaderType = String(loaderId);

  const what = `搜索 CurseForge ${projectTypeOfClassId(classId) || '内容'}${text ? `「${text}」` : ''}`;
  const data = await requestJson('/v1/mods/search', {
    query,
    what,
    signal: opts.signal,
    base: opts.curseforgeBase || CF_BASE,
    service: 'CurseForge 镜像',
  });
  if (!data || !Array.isArray(data.data)) {
    throw new http.LauncherError(`${what}失败：CurseForge 镜像返回的搜索结果格式不正确（缺少 data 数组）`, {
      code: 'E_CONTENT_SHAPE',
    });
  }

  const hits = data.data.map((mod) => shapeCurseForgeHit(mod));
  const pagination = data.pagination || {};
  return {
    hits,
    // ★ 注意 totalCount 上限 10000（分页上限），不是真实总数
    total: toNumber(pagination.totalCount),
    offset: pagination.index === undefined ? offset : toNumber(pagination.index),
    limit: toNumber(pagination.pageSize) || limit,
    hitsCount: hits.length,
    totalCapped: toNumber(pagination.totalCount) >= 10000,
  };
}

/* --------------------------------------------------------------- 混合搜索 */

/** 标题归一化（用于跨源去重）：小写、去商标符号、压空格。 */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 合并两个源的结果：
 *   · 按 title 归一化去重，同名的**保留下载量高的那个**；
 *   · 按 downloads 降序。
 * @returns {{hits:Array, deduped:number}}
 */
function mergeHits(modrinthHits, curseforgeHits) {
  const merged = [];
  const byTitle = new Map();
  for (const hit of [...(modrinthHits || []), ...(curseforgeHits || [])]) {
    if (!hit || !hit.title) continue;
    const key = normalizeTitle(hit.title);
    // ★ 不能写 `if (!existing)` —— 第一条的索引正好是 0，会被当成「不存在」而漏去重。
    if (!byTitle.has(key)) {
      byTitle.set(key, merged.length);
      merged.push(hit);
      continue;
    }
    // 同名：留下下载量更高的（相等时保留先来的 Modrinth）
    const index = byTitle.get(key);
    if (hit.downloads > merged[index].downloads) merged[index] = hit;
  }
  const deduped = (modrinthHits || []).length + (curseforgeHits || []).length - merged.length;
  merged.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  return { hits: merged, deduped };
}

/**
 * 搜索内容（对外入口）。
 *
 * @param {{source?:'mixed'|'modrinth'|'curseforge', projectType?:string, query?:string,
 *          mcVersion?:string, loader?:string, limit?:number, offset?:number,
 *          signal?:AbortSignal, curseforgeBase?:string, modrinthBase?:string}} [options]
 * @returns {Promise<{hits:Array, total:number, offset:number, limit:number, source:string,
 *                    breakdown?:object, deduped?:number, warning?:string}>}
 */
async function search(options) {
  const opts = options || {};
  const source = normalizeSource(opts.source, 'mixed');

  if (source === 'modrinth') {
    return { ...(await searchModrinth(opts)), source: 'modrinth' };
  }
  if (source === 'curseforge') {
    return { ...(await searchCurseForge(opts)), source: 'curseforge' };
  }

  // mixed：两边并发，单边失败不拖垮整个搜索
  const [mr, cf] = await Promise.allSettled([searchModrinth(opts), searchCurseForge(opts)]);
  const mrOK = mr.status === 'fulfilled';
  const cfOK = cf.status === 'fulfilled';
  if (!mrOK && !cfOK) {
    // 两边都挂了：把更「有用」的那个错误抛出去（网络错误优先，便于界面提示检查网络）
    const errors = [mr.reason, cf.reason];
    throw errors.find((e) => e && (e.code === 'E_NETWORK' || e.code === 'E_TIMEOUT')) || errors[0];
  }

  const mrHits = mrOK ? mr.value.hits : [];
  const cfHits = cfOK ? cf.value.hits : [];
  const { hits, deduped } = mergeHits(mrHits, cfHits);

  const breakdown = {
    modrinth: mrOK
      ? { ok: true, total: mr.value.total, hits: mr.value.hits.length }
      : { ok: false, error: (mr.reason && mr.reason.message) || String(mr.reason), code: (mr.reason && mr.reason.code) || 'E_CONTENT_API' },
    curseforge: cfOK
      ? { ok: true, total: cf.value.total, hits: cf.value.hits.length, totalCapped: !!cf.value.totalCapped }
      : { ok: false, error: (cf.reason && cf.reason.message) || String(cf.reason), code: (cf.reason && cf.reason.code) || 'E_CONTENT_API' },
  };

  const limit = Math.max(1, Math.floor(Number(opts.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const result = {
    hits,
    // 混合模式没有统一的「总数」概念，这里给两边 totalCount 之和（近似值，界面别拿它算页数）
    total: (mrOK ? mr.value.total : 0) + (cfOK ? cf.value.total : 0),
    offset,
    limit,
    hitsCount: hits.length,
    source: 'mixed',
    breakdown,
    deduped,
  };
  if (!cfOK) result.warning = `CurseForge 镜像暂时不可用，已只显示 Modrinth 的结果：${breakdown.curseforge.error}`;
  if (!mrOK) result.warning = `Modrinth 暂时不可用，已只显示 CurseForge 的结果：${breakdown.modrinth.error}`;
  return result;
}

/* ------------------------------------------------------------- 项目详情 */

/**
 * CurseForge 项目详情（镜像 /v1/mods/{id}）。
 * @param {string|number} modId CurseForge 的数字 id
 */
async function getCurseForgeProject(modId, options) {
  const opts = options || {};
  const id = requireCurseForgeId(modId, '获取 CurseForge 项目详情');
  const data = await requestJson(`/v1/mods/${encodeURIComponent(id)}`, {
    what: `获取 CurseForge 项目「${id}」的详情`,
    signal: opts.signal,
    base: opts.curseforgeBase || CF_BASE,
    service: 'CurseForge 镜像',
  });
  const mod = data && data.data;
  if (!mod || mod.id == null) {
    throw new http.LauncherError(`获取 CurseForge 项目「${id}」的详情失败：返回内容里没有 id`, {
      code: 'E_CONTENT_SHAPE',
    });
  }
  return shapeCurseForgeProject(mod);
}

/**
 * 取项目详情（按 source 分流）。
 *
 * source 默认 auto：纯数字 id 当成 CurseForge 先试，其它当 Modrinth slug 先试；
 * 'mixed' 时先试 Modrinth，404 再试 CurseForge。
 */
async function getProject(idOrSlug, options) {
  const opts = options || {};
  const key = requireProjectKey(idOrSlug, '获取项目详情');
  const explicit = String(opts.source || '').trim().toLowerCase();
  const source = explicit && explicit !== 'auto' ? normalizeSource(explicit, 'mixed') : 'auto';

  if (source === 'curseforge') return getCurseForgeProject(key, opts);
  if (source === 'modrinth') return getModrinthProject(key, opts);

  // auto / mixed
  const cfFirst = source === 'auto' && /^\d+$/.test(key);
  if (cfFirst) {
    try {
      return await getCurseForgeProject(key, opts);
    } catch (err) {
      if (err && err.code === 'E_CONTENT_API' && err.status === 404) return getModrinthProject(key, opts);
      throw err;
    }
  }
  try {
    return await getModrinthProject(key, opts);
  } catch (err) {
    const notFound = err && (err.code === 'E_CONTENT_NO_VERSION' || (err.code === 'E_CONTENT_API' && err.status === 404));
    if (notFound && /^\d+$/.test(key)) return getCurseForgeProject(key, opts);
    throw err;
  }
}

/** Modrinth 项目详情（内部）。 */
async function getModrinthProject(key, options) {
  const opts = options || {};
  const data = await requestJson(`/project/${encodeURIComponent(key)}`, {
    what: `获取项目「${key}」的详情`,
    signal: opts.signal,
    base: opts.modrinthBase,
    service: 'Modrinth',
  });
  if (!data || !data.id) {
    throw new http.LauncherError(`获取项目「${key}」的详情失败：Modrinth 返回的内容里没有 id`, {
      code: 'E_CONTENT_SHAPE',
    });
  }
  return shapeProject(data);
}

/* ------------------------------------------------------------- 版本列表 */

/** Modrinth 版本列表（内部）。 */
async function getModrinthVersions(idOrSlug, options) {
  const opts = options || {};
  const key = requireProjectKey(idOrSlug, '获取版本列表');
  const query = {};
  const mcVersion = String(opts.mcVersion || '').trim();
  if (mcVersion) query.game_versions = JSON.stringify([mcVersion]);
  const loader = String(opts.loader || '').trim().toLowerCase();
  if (loader) query.loaders = JSON.stringify([loader]);

  const data = await requestJson(`/project/${encodeURIComponent(key)}/version`, {
    query,
    what: `获取项目「${key}」的版本列表`,
    signal: opts.signal,
    base: opts.modrinthBase,
    service: 'Modrinth',
  });
  if (!Array.isArray(data)) {
    throw new http.LauncherError(`获取项目「${key}」的版本列表失败：Modrinth 返回的不是数组`, {
      code: 'E_CONTENT_SHAPE',
    });
  }
  return data.map(shapeVersion);
}

/**
 * 取 CurseForge 项目的文件列表（归一化成与 Modrinth version 相同结构）。
 *
 * ★ 接口一次最多取 50 条（pageSize 上限），默认按发布时间新→旧，所以列表就是「最近 50 个文件」。
 * @param {string|number} modId CurseForge 数字 id
 * @param {{mcVersion?:string, loader?:string, limit?:number, signal?:AbortSignal, curseforgeBase?:string}} [options]
 * @returns {Promise<Array>} 版本数组
 */
async function getCurseForgeFiles(modId, options) {
  const opts = options || {};
  const id = requireCurseForgeId(modId, '获取 CurseForge 文件列表');
  const limit = Math.min(CF_MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || CF_MAX_LIMIT)));
  const query = { pageSize: String(limit), index: '0' };
  const mcVersion = String(opts.mcVersion || '').trim();
  if (mcVersion) query.gameVersion = mcVersion;
  const loaderId = curseForgeLoaderId(opts.loader);
  if (loaderId) query.modLoaderType = String(loaderId);

  const data = await requestJson(`/v1/mods/${encodeURIComponent(id)}/files`, {
    query,
    what: `获取 CurseForge 项目「${id}」的文件列表`,
    signal: opts.signal,
    base: opts.curseforgeBase || CF_BASE,
    service: 'CurseForge 镜像',
  });
  if (!data || !Array.isArray(data.data)) {
    throw new http.LauncherError(`获取 CurseForge 项目「${id}」的文件列表失败：返回内容里没有 data 数组`, {
      code: 'E_CONTENT_SHAPE',
    });
  }
  return data.data.map(shapeCurseForgeFile);
}

/**
 * 取版本列表（按 source 分流）。
 * @param {string} idOrSlug
 * @param {{source?:'modrinth'|'curseforge'|'mixed', mcVersion?:string, loader?:string,
 *          signal?:AbortSignal, curseforgeBase?:string}} [options]
 */
async function getVersions(idOrSlug, options) {
  const opts = options || {};
  const key = requireProjectKey(idOrSlug, '获取版本列表');
  const explicit = String(opts.source || '').trim().toLowerCase();
  const source = explicit && explicit !== 'auto' ? normalizeSource(explicit, 'mixed') : 'auto';

  if (source === 'curseforge') return getCurseForgeFiles(key, opts);
  if (source === 'modrinth') return getModrinthVersions(key, opts);

  // auto：数字 id 视为 CurseForge，否则 Modrinth；mixed：Modrinth 404 再试 CurseForge
  const cfFirst = source === 'auto' && /^\d+$/.test(key);
  if (cfFirst) {
    try {
      return await getCurseForgeFiles(key, opts);
    } catch (err) {
      if (err && err.code === 'E_CONTENT_API' && err.status === 404) return getModrinthVersions(key, opts);
      throw err;
    }
  }
  try {
    return await getModrinthVersions(key, opts);
  } catch (err) {
    const notFound = err && err.code === 'E_CONTENT_API' && err.status === 404;
    if ((source === 'mixed' || notFound) && /^\d+$/.test(key)) return getCurseForgeFiles(key, opts);
    throw err;
  }
}

/* ------------------------------------------------------- 前置依赖解析 */

/**
 * ★★★ 解析一个版本的前置依赖（2026-11-05 新增，用户要求）。
 *
 * 用户原话：
 *   「如果检测到这个模组有可安装前置和必须安装前置，都要提醒一下。
 *     如果是必须安装前置，提醒是否一起安装。
 *     如果玩家点不一起安装，然后会弹出你确定吗？
 *     这个模组缺少这个依赖可能会导致游戏无法正常运行或崩溃」
 *
 * 做法：
 *   ① 从 version.dependencies 里取出 project_id 列表（required / optional 都要）
 *   ② 用 Modrinth 的批量接口 `GET /v2/projects?ids=["a","b"]` 一次查回项目名/图标
 *   ③ 对有 version_id 的，直接用那个版本；没有的按当前 MC 版本 + 加载器挑最新兼容版本
 *   ④ 返回每条依赖的：项目名 / 图标 / 类型 / 可下载版本（含 url）
 *
 * @param {object} opts
 * @param {Array}  opts.dependencies   shapeVersion() 里的 dependencies
 * @param {string} [opts.mcVersion]    目标 MC 版本（用于挑兼容版本）
 * @param {string} [opts.loader]       加载器（fabric/forge/neoforge/quilt）
 * @returns {Promise<{required:Array, optional:Array, incompatible:Array, embedded:number}>}
 */
async function resolveDependencies(opts = {}) {
  const deps = Array.isArray(opts.dependencies) ? opts.dependencies : [];
  const mcVersion = opts.mcVersion ? String(opts.mcVersion) : '';
  const loader = opts.loader ? String(opts.loader) : '';

  const out = { required: [], optional: [], incompatible: [], embedded: 0 };
  if (!deps.length) return out;

  // 按类型分流；embedded 不需要额外装，只统计数量
  const need = [];
  for (const d of deps) {
    if (!d) continue;
    if (d.type === 'embedded') {
      out.embedded += 1;
      continue;
    }
    if (d.type === 'incompatible') {
      out.incompatible.push({ projectId: d.projectId, type: 'incompatible' });
      continue;
    }
    need.push(d);
  }
  if (!need.length) return out;

  // ① 批量查项目基本信息（图标、标题、slug）
  const projectIds = [...new Set(need.map((d) => d.projectId).filter(Boolean))];
  const projectMap = new Map();
  if (projectIds.length) {
    try {
      const url = `${API_BASE}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`;
      const list = await http.fetchJson(url, {
        timeoutMs: opts.timeoutMs || 20000,
        retries: 1,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
      });
      const arr = Array.isArray(list) ? list : [];
      for (const p of arr) {
        if (p && p.id) {
          projectMap.set(String(p.id), {
            id: String(p.id),
            slug: String(p.slug || ''),
            title: String(p.title || ''),
            description: String(p.description || '').slice(0, 200),
            iconUrl: p.icon_url ? String(p.icon_url) : '',
            projectType: String(p.project_type || '')
          });
        }
      }
    } catch {
      /* 查不到项目信息不影响主流程，下游会给「未知前置」 */
    }
  }

  // ② 逐条挑可下载版本
  for (const d of need) {
    const info = d.projectId ? projectMap.get(String(d.projectId)) : null;
    const entry = {
      projectId: d.projectId,
      versionId: d.versionId,
      title: info ? info.title : d.fileName || (d.projectId ? `前置项目 ${d.projectId}` : '未知前置'),
      slug: info ? info.slug : '',
      description: info ? info.description : '',
      iconUrl: info ? info.iconUrl : '',
      type: d.type,
      // 下面在成功挑到版本时填
      version: null,
      error: null
    };

    try {
      if (d.versionId) {
        // 指定了版本：直接查这个版本（Modrinth 有 /version/{id} 接口）
        const v = await http.fetchJson(`${API_BASE}/version/${encodeURIComponent(d.versionId)}`, {
          timeoutMs: opts.timeoutMs || 20000,
          retries: 1,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
        });
        entry.version = shapeVersion(v);
      } else if (d.projectId) {
        // 没指定版本：按 MC 版本 + 加载器挑最新的
        const qs = [];
        if (mcVersion) qs.push(`game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`);
        if (loader) qs.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
        const url = `${API_BASE}/project/${encodeURIComponent(d.projectId)}/version${qs.length ? '?' + qs.join('&') : ''}`;
        const list = await http.fetchJson(url, {
          timeoutMs: opts.timeoutMs || 20000,
          retries: 1,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
        });
        const arr = Array.isArray(list) ? list : [];
        // 优先取 release 版；没有就取第一个
        const pick = arr.find((x) => x && String(x.version_type || '') === 'release') || arr[0] || null;
        if (pick) entry.version = shapeVersion(pick);
        else entry.error = `没有兼容 ${mcVersion || '当前版本'} 的版本`;
      } else {
        entry.error = '前置没有可识别的 id';
      }
    } catch (err) {
      entry.error = `查询前置版本失败：${err?.message || err}`;
    }

    if (d.type === 'optional') out.optional.push(entry);
    else out.required.push(entry);
  }

  return out;
}

/** 文件名清洗：去掉路径分隔符与控制字符，防止写出 <destDir> 之外。 */
function safeFilename(name, fallback) {
  const base = path.basename(String(name || ''));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned) return cleaned;
  // eslint-disable-next-line no-control-regex
  const fallbackName = String(fallback || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return fallbackName || `content-${Date.now()}.bin`;
}

/** 从版本里挑主文件：优先 primary，其次第一个有 url 的。 */
function pickFile(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.url);
  if (!list.length) return null;
  return list.find((f) => f.primary) || list[0];
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

/** 统一成「待下载文件」结构。 */
function toDownloadTarget(file, meta) {
  if (!file || !file.url) {
    throw new http.LauncherError(
      `下载失败：版本「${(meta && meta.versionNumber) || (meta && meta.versionId) || '未知'}」没有可下载的文件` +
        '（CurseForge 上作者可能关闭了第三方分发，请到网页手动下载）',
      { code: 'E_CONTENT_NO_FILE' }
    );
  }
  return {
    url: String(file.url),
    filename: String(file.filename || ''),
    size: toNumber(file.size),
    sha1: file.sha1 ? String(file.sha1).toLowerCase() : null,
    versionId: String((meta && meta.versionId) || ''),
    versionNumber: String((meta && meta.versionNumber) || ''),
    source: (meta && meta.source) || 'modrinth',
    /**
     * ★ 2026-11-05 新增：这个文件属于哪个「项目」。
     * 用来在换版本时删掉同一项目的旧 jar（否则 mods 目录会堆 rei-1.jar + rei-2.jar，
     * 游戏会同时加载两份导致冲突）。格式 `modrinth:<slug>` / `curseforge:<id>`。
     */
    projectKey: String((meta && meta.projectKey) || ''),
  };
}

/** Modrinth：定位版本 → 待下载文件。 */
async function resolveModrinthTarget(key, versionId, opts) {
  let version = null;
  if (versionId) {
    const raw = await requestJson(`/version/${encodeURIComponent(String(versionId))}`, {
      what: `获取 Modrinth 版本「${versionId}」`,
      signal: opts.signal,
      base: opts.modrinthBase,
      service: 'Modrinth',
    });
    if (!raw || !raw.id) {
      throw new http.LauncherError(`下载失败：Modrinth 上没有版本「${versionId}」`, { code: 'E_CONTENT_NO_VERSION' });
    }
    version = shapeVersion(raw);
  } else {
    const list = await getModrinthVersions(key, { signal: opts.signal, modrinthBase: opts.modrinthBase });
    version = list[0] || null;
    if (!version) {
      throw new http.LauncherError(`下载失败：项目「${key}」还没有任何已发布版本`, { code: 'E_CONTENT_NO_VERSION' });
    }
  }
  const file = pickFile(version.files);
  return toDownloadTarget(file, {
    versionId: version.id,
    versionNumber: version.versionNumber || version.name,
    source: 'modrinth',
    projectKey: 'modrinth:' + String(key),
  });
}

/** CurseForge：定位文件（单文件接口优先）→ 待下载文件。 */
async function resolveCurseForgeTarget(modId, fileId, opts) {
  const id = requireCurseForgeId(modId, '从 CurseForge 下载');
  let shaped = null;
  if (fileId) {
    const data = await requestJson(`/v1/mods/${encodeURIComponent(id)}/files/${encodeURIComponent(String(fileId))}`, {
      what: `获取 CurseForge 文件「${fileId}」`,
      signal: opts.signal,
      base: opts.curseforgeBase || CF_BASE,
      service: 'CurseForge 镜像',
    });
    const raw = data && data.data;
    if (!raw || raw.id == null) {
      throw new http.LauncherError(`下载失败：CurseForge 上没有文件「${fileId}」`, { code: 'E_CONTENT_NO_VERSION' });
    }
    shaped = shapeCurseForgeFile(raw);
  } else {
    const list = await getCurseForgeFiles(id, {
      signal: opts.signal,
      curseforgeBase: opts.curseforgeBase,
      mcVersion: opts.mcVersion,
      loader: opts.loader,
    });
    shaped = list[0] || null;
    if (!shaped) {
      throw new http.LauncherError(`下载失败：CurseForge 项目「${id}」还没有任何文件`, { code: 'E_CONTENT_NO_VERSION' });
    }
  }
  if (!shaped.files.length || !shaped.files[0].url) {
    throw new http.LauncherError(
      `下载失败：CurseForge 文件「${shaped.files[0] ? shaped.files[0].filename : shaped.id}」没有下载地址`,
      { code: 'E_CONTENT_NO_FILE' }
    );
  }
  return toDownloadTarget(shaped.files[0], {
    versionId: shaped.id,
    versionNumber: shaped.versionNumber,
    source: 'curseforge',
    projectKey: 'curseforge:' + String(id),
  });
}

/** 「这个源上没有这个内容」类错误（可以安全地换另一个源再试）。 */
function isNotFoundContentError(err) {
  return !!err && (err.code === 'E_CONTENT_NO_VERSION' || err.code === 'E_CONTENT_NO_FILE' || (err.code === 'E_CONTENT_API' && err.status === 404));
}

/**
 * 按来源解析下载目标。
 *   · modrinth / curseforge → 只走对应源；
 *   · mixed → 纯数字 id 先试 CurseForge（Modrinth 的 id 不是纯数字），
 *             其它先试 Modrinth；命中「找不到」再换另一个源。
 */
async function resolveDownloadTarget(key, versionId, source, opts) {
  if (source === 'modrinth') return resolveModrinthTarget(key, versionId, opts);
  if (source === 'curseforge') return resolveCurseForgeTarget(key, versionId, opts);

  if (/^\d+$/.test(key)) {
    try {
      return await resolveCurseForgeTarget(key, versionId, opts);
    } catch (err) {
      if (isNotFoundContentError(err)) return resolveModrinthTarget(key, versionId, opts);
      throw err;
    }
  }
  try {
    return await resolveModrinthTarget(key, versionId, opts);
  } catch (err) {
    if (isNotFoundContentError(err)) return resolveCurseForgeTarget(key, versionId, opts);
    throw err;
  }
}

/** 真正的落盘 + 校验（Modrinth / CurseForge 共用同一套）。 */
/**
 * ★★★ 已安装内容清单（2026-11-05 新增，用户要求「重复下载默认覆盖」）。
 *
 * ## 解决什么问题
 * 玩家先装 `rei-12.1.785.jar`，后来换成 `rei-12.1.800.jar` ——
 * **文件名不同**，两个 jar 会同时躺在 mods/ 里，游戏同时加载两份导致冲突/崩溃。
 * 光靠「同名覆盖」治不了这个，必须知道「这个文件属于哪个项目」。
 *
 * ## 做法
 * 在目标目录（mods/ resourcepacks/ …）放一个隐藏清单 `.qcl-content.json`：
 *   { "version": 1, "entries": { "modrinth:rei": { filename, versionId, sha1, at } } }
 * 下载新版本时：查清单 → 删掉同项目旧文件 → 写新文件 → 更新清单。
 * 游戏不会读这个文件名，安全。
 */
const CONTENT_MANIFEST = '.qcl-content.json';

function contentManifestPath(dir) {
  return path.join(dir, CONTENT_MANIFEST);
}

function readContentManifest(dir) {
  try {
    const file = contentManifestPath(dir);
    if (!fs.existsSync(file)) return { version: 1, entries: {} };
    const data = jsonstore.readJson(file, null);
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: data.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeContentManifest(dir, manifest) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    jsonstore.writeJson(contentManifestPath(dir), manifest);
  } catch {
    /* 清单写不进去不影响下载本身，只是下次可能留旧文件 */
  }
}

/**
 * 落盘一个下载好的文件，并按覆盖策略处理「同一项目的旧版本」。
 *
 * @param {object} target
 * @param {string} dir
 * @param {function} [onProgress]
 * @param {AbortSignal} [signal]
 * @param {object} [options]
 * @param {'replace'|'skip'|'keep'} [options.overwrite='replace']
 *   · replace（默认）：同项目旧文件删掉，换成新文件（避免 mods 里堆两个版本）
 *   · skip：目标文件已存在就跳过，什么都不改
 *   · keep：新旧都留着（高级用户才用，可能冲突）
 * @returns {Promise<object>}
 */
async function saveTarget(target, dir, onProgress, signal, options) {
  const opts = options || {};
  const mode = ['replace', 'skip', 'keep'].includes(opts.overwrite) ? opts.overwrite : 'replace';
  const filename = safeFilename(target.filename, `${target.source}-${target.versionId || Date.now()}.bin`);
  const dest = path.join(dir, filename);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = readContentManifest(dir);
  const projectKey = target.projectKey || '';
  const prev = projectKey ? manifest.entries[projectKey] : null;

  /** 同一项目、文件名不同 ⇒ 这是「换版本」，旧文件要处理 */
  const staleFile = prev && prev.filename && prev.filename !== filename ? path.join(dir, prev.filename) : null;
  const staleExists = staleFile && fs.existsSync(staleFile);

  // ── 策略 skip：同名文件已存在 → 直接返回，不动任何文件 ──
  if (mode === 'skip' && fs.existsSync(dest)) {
    const bytes = fileSize(dest);
    if (onProgress) {
      try {
        onProgress({ current: 1, total: 1, file: filename, bytes, bytesTotal: bytes, speed: 0, done: true, skipped: true, percent: 100 });
      } catch (_) {
        /* 忽略 */
      }
    }
    return {
      ok: true,
      path: dest,
      filename,
      bytes,
      sha1: target.sha1,
      versionId: target.versionId,
      versionNumber: target.versionNumber,
      source: target.source,
      skipped: true,
      reason: '已存在同文件，按「跳过」策略不覆盖',
    };
  }

  // 已存在且 sha1 相符 → 直接复用（避免二次下载，这是用户明确要的）
  if (target.sha1 && fs.existsSync(dest)) {
    const actual = await downloader.sha1OfFile(dest);
    if (actual && actual.toLowerCase() === target.sha1) {
      // replace 模式下顺手清掉同项目的其他旧文件
      let removedOld = null;
      if (mode === 'replace' && staleExists) {
        try {
          fs.unlinkSync(staleFile);
          removedOld = prev.filename;
        } catch (_) {
          /* 删不掉就留着 */
        }
      }
      // 补登记清单（老文件可能是还没记录时下的）
      if (projectKey) {
        manifest.entries[projectKey] = {
          filename,
          versionId: target.versionId || '',
          sha1: target.sha1,
          at: Date.now(),
        };
        writeContentManifest(dir, manifest);
      }
      const bytes = fileSize(dest);
      if (onProgress) {
        try {
          onProgress({ current: 1, total: 1, file: filename, bytes, bytesTotal: bytes, speed: 0, done: true, skipped: true, percent: 100 });
        } catch (_) {
          /* 进度回调异常不影响下载结果 */
        }
      }
      return {
        ok: true,
        path: dest,
        filename,
        bytes,
        sha1: target.sha1,
        versionId: target.versionId,
        versionNumber: target.versionNumber,
        source: target.source,
        skipped: true,
        replacedOld: removedOld,
      };
    }
  }

  // ── replace：先删同项目旧文件再下，避免下到一半失败时两个都在 ──
  let removedOld = null;
  if (mode === 'replace' && staleExists) {
    try {
      fs.unlinkSync(staleFile);
      removedOld = prev.filename;
    } catch (_) {
      /* 删不掉不拦着下载 */
    }
  }

  const result = await downloader.downloadAll(
    [
      {
        url: target.url,
        dest,
        sha1: target.sha1 || undefined,
        size: target.size > 0 ? target.size : undefined,
        name: filename,
      },
    ],
    {
      threads: 1,
      // 大文件（整合包）不能用默认 30 秒超时，否则下到一半被 AbortSignal 掐断
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      signal,
      onProgress: (p) => {
        if (!onProgress) return;
        const total = toNumber(p && p.bytesTotal);
        const bytes = toNumber(p && p.bytes);
        try {
          onProgress({
            current: toNumber(p && p.current),
            total: toNumber(p && p.total) || 1,
            file: (p && p.file) || filename,
            bytes,
            bytesTotal: total,
            speed: toNumber(p && p.speed),
            percent: total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0,
            done: !!(p && (p.done || p.skipped)),
            skipped: !!(p && p.skipped),
          });
        } catch (_) {
          /* 忽略进度回调异常 */
        }
      },
    }
  );

  if (result.failed.length) {
    const first = result.failed[0];
    throw new http.LauncherError(`下载「${filename}」失败：${first.error}`, {
      code: 'E_CONTENT_DOWNLOAD',
      detail: first.task && first.task.url,
    });
  }

  // 二次校验 sha1 —— downloader 内部已校验一次，这里按接口要求再独立核对一遍，
  // 防止以后有人改坏 downloader 时静默放过坏文件。
  if (target.sha1) {
    const actual = await downloader.sha1OfFile(dest);
    if (!actual) {
      throw new http.LauncherError(`下载「${filename}」后校验失败：读不到已保存的文件`, { code: 'E_CONTENT_SHA1' });
    }
    if (actual.toLowerCase() !== target.sha1) {
      try {
        fs.rmSync(dest, { force: true });
      } catch (_) {
        /* 删坏文件失败不影响报错 */
      }
      throw new http.LauncherError(
        `下载「${filename}」校验失败（sha1 不符，期望 ${target.sha1}，实际 ${actual}），文件可能损坏，已删除，请重试`,
        { code: 'E_CONTENT_SHA1' }
      );
    }
  }

  const bytes = fileSize(dest);
  if (target.size > 0 && bytes !== target.size) {
    throw new http.LauncherError(
      `下载「${filename}」大小不符（实际 ${bytes} 字节，应为 ${target.size} 字节），请重试`,
      { code: 'E_CONTENT_SIZE' }
    );
  }
  if (onProgress) {
    try {
      onProgress({ current: 1, total: 1, file: filename, bytes, bytesTotal: bytes, speed: 0, done: true, skipped: false, percent: 100 });
    } catch (_) {
      /* 忽略 */
    }
  }

  /**
   * 登记到清单：下次同一个项目再下载新版本时，就能按清单找到并清掉这个旧文件。
   * 只在真的有 projectKey 时才记（不知道属于哪个项目的，不瞎记）。
   */
  if (projectKey) {
    manifest.entries[projectKey] = {
      filename,
      versionId: target.versionId || '',
      sha1: target.sha1 || null,
      at: Date.now(),
    };
    writeContentManifest(dir, manifest);
  }

  return {
    ok: true,
    path: dest,
    filename,
    replacedOld: removedOld,
    overwrite: mode,
    bytes,
    sha1: target.sha1 || null,
    versionId: target.versionId,
    versionNumber: target.versionNumber,
    source: target.source,
  };
}

/**
 * **真实下载**某个版本的文件到 destDir，并做 sha1 校验（Modrinth / CurseForge 都支持）。
 *
 * @param {string} idOrSlug Modrinth id/slug，或 CurseForge 的数字 modId
 * @param {string|null} versionId Modrinth 版本 id / CurseForge 文件 id（传空取最新）
 * @param {string} destDir 保存目录（不存在会自动创建）
 * @param {{onProgress?:Function, signal?:AbortSignal, source?:string,
 *          curseforgeBase?:string, modrinthBase?:string, mcVersion?:string, loader?:string}} [options]
 * @returns {Promise<{ok:boolean, path:string, filename:string, bytes:number, source:string}>}
 */
async function downloadTo(idOrSlug, versionId, destDir, options) {
  const opts = options || {};
  const key = requireProjectKey(idOrSlug, '下载内容');
  const dirRaw = String(destDir == null ? '' : destDir).trim();
  if (!dirRaw) {
    throw new http.LauncherError('下载失败：没有给出保存目录', { code: 'E_CONTENT_NO_DIR' });
  }
  const dir = path.resolve(dirRaw);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const source = normalizeSource(opts.source, 'mixed');

  const target = await resolveDownloadTarget(key, versionId, source, opts);
  return saveTarget(target, dir, onProgress, opts.signal, { overwrite: opts.overwrite });
}

/* -------------------------------------------------------------------- 收藏 */

/** <home>/favorites.json */
function favoritesFile(home) {
  return path.join(paths.homeOf(home), 'favorites.json');
}

/** 读原始结构（永远是 { version:1, items:[] } 形状）。 */
function readFavorites(home) {
  const data = jsonstore.readJson(favoritesFile(home), null);
  if (!data || !Array.isArray(data.items)) return { version: FAVORITES_VERSION, items: [] };
  const items = data.items.filter((it) => it && typeof it === 'object' && (it.id || it.slug));
  return { version: FAVORITES_VERSION, items };
}

/** 收藏项的持久化结构（字段与搜索结果 hit 对齐，界面可直接复用卡片）。 */
function normalizeFavorite(item) {
  const raw = item || {};
  const id = String(raw.id || raw.projectId || raw.project_id || raw.slug || '').trim();
  if (!id) {
    throw new http.LauncherError('收藏失败：这条内容没有 id，无法保存', { code: 'E_FAVORITE_NO_ID' });
  }
  return {
    id,
    slug: String(raw.slug || ''),
    title: String(raw.title || raw.name || id),
    description: String(raw.description || ''),
    author: String(raw.author || ''),
    projectType: String(raw.projectType || raw.project_type || ''),
    iconUrl: String(raw.iconUrl || raw.icon_url || ''),
    downloads: toNumber(raw.downloads),
    follows: toNumber(raw.follows === undefined ? raw.followers : raw.follows),
    categories: toStringArray(raw.categories),
    versions: toStringArray(raw.versions),
    // ★ 收藏要记住来源，否则从收藏点进去不知道是 Modrinth 还是 CurseForge
    source: normalizeSource(raw.source, 'modrinth'),
    addedAt: Number.isFinite(Number(raw.addedAt)) && Number(raw.addedAt) > 0 ? Number(raw.addedAt) : Date.now(),
  };
}

function sameFavorite(item, id) {
  if (!item) return false;
  const key = String(id).trim();
  if (!key) return false;
  return String(item.id || '') === key || String(item.slug || '') === key;
}

/** 写回 favorites.json（jsonstore 是原子写）。 */
function writeFavorites(home, items) {
  const payload = { version: FAVORITES_VERSION, items: (items || []).slice(0, MAX_FAVORITES) };
  try {
    jsonstore.writeJson(favoritesFile(home), payload);
  } catch (err) {
    throw new http.LauncherError(`保存收藏失败：写不进 ${favoritesFile(home)}（${err && err.message ? err.message : err}）`, {
      code: 'E_FAVORITE_WRITE',
      cause: err,
    });
  }
  return payload;
}

/**
 * 列出收藏（返回 items 数组，新收藏在最前）。
 * 文件不存在 / 内容损坏 → 返回空数组，不抛错（收藏是辅助功能，坏了不该拦界面）。
 * @param {string} [home]
 * @returns {Promise<Array>}
 */
async function listFavorites(home) {
  return readFavorites(home).items;
}

/**
 * 加收藏（按 id 去重；已存在则原地更新，不会重复）。
 * @param {string} home
 * @param {object} item 搜索结果 hit 或项目详情（只挑用得上的字段）
 * @returns {Promise<{ok:boolean, added:boolean, item:object, items:Array}>}
 */
async function addFavorite(home, item) {
  const normalized = normalizeFavorite(item);
  const { items } = readFavorites(home);
  const index = items.findIndex((it) => sameFavorite(it, normalized.id));
  let added = true;
  if (index >= 0) {
    added = false;
    items[index] = { ...items[index], ...normalized };
  } else {
    items.unshift(normalized);
  }
  const payload = writeFavorites(home, items);
  return { ok: true, added, item: normalized, items: payload.items };
}

/**
 * 移除收藏（按 id 或 slug 都能删）。
 * @returns {Promise<{ok:boolean, removed:boolean, items:Array}>}
 */
async function removeFavorite(home, itemId) {
  const key = String(itemId == null ? '' : itemId).trim();
  if (!key) {
    throw new http.LauncherError('取消收藏失败：没有给出要删除的项目 id', { code: 'E_FAVORITE_NO_ID' });
  }
  const { items } = readFavorites(home);
  const next = items.filter((it) => !sameFavorite(it, key));
  const removed = next.length !== items.length;
  const payload = writeFavorites(home, next);
  return { ok: true, removed, items: payload.items };
}

/* ---------------------------------------------------------------- 下载源清单 */

/** 给界面渲染「下载源切换器」用（content:sources 通道直接返回）。 */
function listSources() {
  return SOURCE_LIST.map((item) => ({ ...item }));
}

module.exports = {
  API_BASE,
  CF_BASE,
  CF_CLASS_IDS,
  CF_MAX_LIMIT,
  USER_AGENT,
  PROJECT_TYPES,
  SOURCES,
  SOURCE_LIST,
  FAVORITES_VERSION,
  MAX_FAVORITES,
  normalizeProjectType,
  normalizeSource,
  curseForgeClassId,
  search,
  searchCurseForge,
  resolveDependencies,
  getProject,
  getCurseForgeProject,
  getVersions,
  getCurseForgeFiles,
  downloadTo,
  listSources,
  listFavorites,
  addFavorite,
  removeFavorite,
  favoritesFile,
  // 下面几个是给测试脚本与 IPC 层复用的整形工具
  shapeHit,
  shapeProject,
  shapeVersion,
  shapeCurseForgeHit,
  shapeCurseForgeProject,
  shapeCurseForgeFile,
  // 错误翻译单独导出，供测试脚本验证「网络不通 / API 错误」两类提示确实不同
  translateError,
};
