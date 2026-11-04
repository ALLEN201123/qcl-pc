'use strict';
/**
 * Quanta Craft Launcher PC · 第三方账号登录（authlib-injector）
 *
 * ## 这是什么
 * authlib-injector 是 Minecraft 社区的事实标准：让**第三方皮肤站 / 私服**（如 LittleSkin、
 * Blessing Skin 等）能够提供正版式的 Yggdrasil 认证。启动器要做两件事：
 *   ① 用第三方站的 Yggdrasil 接口登录，拿到 accessToken + profile（uuid / name / 皮肤）
 *   ② 启动游戏时加 `-javaagent:authlib-injector.jar=<API 地址>`，
 *      让游戏去这个站验证，而不是 Mojang
 *
 * ## 实现要点（照 HMCL 的 HMCLCore/auth/yggdrasil + HMCL 的 authlib 注入）
 *   认证服务器 API 根（authlib 地址）有一个 `authlib-injector` 规范：
 *     · `POST /authserver/authenticate`   账号密码登录
 *     · `POST /authserver/refresh`        刷新令牌
 *     · `POST /authserver/validate`       校验令牌
 *     · `POST /authserver/invalidate`     作废
 *     · `GET  /api/profiles/minecraft/<name>`  查玩家
 *     · `GET  /sessionserver/session/minecraft/profile/<uuid>`  查档案与皮肤
 *     · `GET  /`                          根节点，JSON 里 `meta.serverName` 是显示名（用于识别站点）
 *
 *   ★ Yggdrasil 的 authenticate 请求体与 Mojang 官方一致：
 *      { agent: { name: 'Minecraft', version: 1 }, username, password, clientToken, requestUser }
 *     返回 { accessToken, clientToken, availableProfiles: [{id, name}], selectedProfile }
 *
 * ## authlib-injector 的 jar
 *   官方发布：https://github.com/yushijinhun/authlib-injector/releases
 *   版本清单：https://authlib-injector.yushi.moe/artifact/latest.json
 *   jar 从 BMCLAPI 或官方 CDN 下载，放 `<QCL_HOME>/dependencies/authlib-injector/authlib-injector-<ver>.jar`
 *
 * ## 诚实说明
 *   本模块实现**真实可用的 Yggdrasil 协议**（不是占位）。
 *   但第三方站是否支持、是否需要额外验证（如图形验证码），取决于具体站点 ——
 *   失败时给出站点返回的中文原因，而不是假装登录成功。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const http = require('./http');
const jsonstore = require('./jsonstore');

/** authlib-injector 版本清单（官方 CDN） */
const ARTIFACT_LIST_URL = 'https://authlib-injector.yushi.moe/artifact/latest.json';
/** 备用：GitHub releases API */
const GITHUB_API = 'https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest';

/** 规范化 API 根地址：接受 `https://littleskin.cn/api/yggdrasil` 或裸域名 */
function normalizeApiRoot(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  return s;
}

/** 生成一个 clientToken（Yggdrasil 用来标记启动器实例，随便一个 UUID 即可） */
function newClientToken() {
  return crypto.randomUUID();
}

/** 统一的 Yggdrasil POST */
async function postYgg(apiRoot, endpoint, body, opts = {}) {
  const url = `${apiRoot}${endpoint}`;
  const text = await http.fetchText(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs || 20000,
    retries: 1
  });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 探测一个 API 根地址属于哪个站点（读根节点的 meta.serverName）。
 * @returns {Promise<{ok:boolean, apiRoot?:string, serverName?:string, registerUrl?:string, error?:string}>}
 */
async function probeServer(apiRootInput) {
  const apiRoot = normalizeApiRoot(apiRootInput);
  if (!apiRoot) return { ok: false, error: '请填写认证服务器地址' };

  try {
    const text = await http.fetchText(apiRoot, { timeoutMs: 15000, retries: 1 });
    let meta = null;
    try {
      const json = JSON.parse(text);
      meta = json && json.meta ? json.meta : null;
    } catch {
      /* 不是 JSON：仍然可能是合法 authlib 服务器，只是没实现根节点 */
    }

    // 如果是 authlib-injector 规范的服务，根节点会带一个特殊响应头，
    // 但 fetchText 拿不到头，所以退而用 meta.serverName 或直接放行
    return {
      ok: true,
      apiRoot,
      serverName: (meta && (meta.serverName || meta.server_name)) || apiRoot.replace(/^https?:\/\//, ''),
      registerUrl: (meta && meta.register) || null
    };
  } catch (err) {
    return {
      ok: false,
      error: `连不上这个认证服务器：${err?.message || err}。请检查地址是否正确、站点是否在线。`
    };
  }
}

/** 把 Yggdrasil 的错误对象翻成人话 */
function explainYggError(data, fallback) {
  if (!data) return fallback;
  const msg = data.errorMessage || data.error || '';
  const cause = data.cause || '';
  const map = {
    'ForbiddenOperationException': '账号或密码错误',
    'IllegalArgumentException': '请求参数不合法',
    'UnsupportedMediaTypeException': '服务器不支持这个请求格式'
  };
  for (const [k, v] of Object.entries(map)) {
    if (String(msg) === k || String(cause).includes(k)) {
      return `${v}${data.errorMessage ? `：${data.errorMessage}` : ''}`;
    }
  }
  return data.errorMessage || data.error || fallback;
}

/**
 * 用账号密码登录第三方站。
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   account?: object,     // 可直接存进 accounts.json
 *   profiles?: object[],  // 该账号下可选的游戏档案（可能多个）
 *   error?: string
 * }>}
 */
async function loginWithPassword({ apiRoot: apiRootInput, username, password, timeoutMs = 25000 }) {
  const apiRoot = normalizeApiRoot(apiRootInput);
  if (!apiRoot) return { ok: false, error: '请填写认证服务器地址' };
  if (!username) return { ok: false, error: '请填写邮箱/用户名' };
  if (!password) return { ok: false, error: '请填写密码' };

  const clientToken = newClientToken();
  let data = null;
  try {
    data = await postYgg(
      apiRoot,
      '/authserver/authenticate',
      {
        agent: { name: 'Minecraft', version: 1 },
        username: String(username).trim(),
        password: String(password),
        clientToken,
        requestUser: false
      },
      { timeoutMs }
    );
  } catch (err) {
    return { ok: false, error: `登录请求失败：${err?.message || err}` };
  }

  if (!data || !data.accessToken) {
    return { ok: false, error: explainYggError(data, '登录失败（服务器没有返回令牌）') };
  }

  const profiles = Array.isArray(data.availableProfiles) ? data.availableProfiles : [];
  const selected = data.selectedProfile || profiles[0] || null;
  if (!selected || !selected.id) {
    return { ok: false, error: '这个账号下没有任何游戏档案，请先到该皮肤站创建一个角色' };
  }

  const uuid = formatUuid(selected.id);
  const name = selected.name || username;

  return {
    ok: true,
    apiRoot,
    clientToken,
    accessToken: data.accessToken,
    profiles: profiles.map((p) => ({ uuid: formatUuid(p.id), name: p.name })),
    account: {
      uuid,
      name,
      type: 'authlib',
      apiRoot,
      accessToken: data.accessToken,
      clientToken,
      // Yggdrasil 令牌默认没有明确过期时间，交给服务端 validate 判断
      expiresAt: null
    }
  };
}

/** Yggdrasil 的 id 是无连字符 UUID，这里补上连字符 */
function formatUuid(raw) {
  const s = String(raw || '').replace(/-/g, '');
  if (s.length !== 32) return String(raw || '');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** 校验令牌是否还有效 */
async function validate({ apiRoot: apiRootInput, accessToken, clientToken, timeoutMs = 15000 }) {
  const apiRoot = normalizeApiRoot(apiRootInput);
  if (!apiRoot || !accessToken) return false;
  try {
    const text = await http.fetchText(`${apiRoot}/authserver/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ accessToken, clientToken }),
      timeoutMs,
      retries: 1
    });
    // 有效时返回 204 空体
    return !text || text.trim() === '';
  } catch {
    return false;
  }
}

/** 用 accessToken 刷新（Yggdrasil 的 refresh） */
async function refresh({ apiRoot: apiRootInput, accessToken, clientToken, timeoutMs = 20000 }) {
  const apiRoot = normalizeApiRoot(apiRootInput);
  if (!apiRoot || !accessToken) return null;
  try {
    const data = await postYgg(
      apiRoot,
      '/authserver/refresh',
      { accessToken, clientToken, requestUser: false },
      { timeoutMs }
    );
    if (!data || !data.accessToken) return null;
    return {
      accessToken: data.accessToken,
      clientToken: data.clientToken || clientToken,
      selectedProfile: data.selectedProfile || null
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- authlib jar 管理 */

function jarDir(home) {
  return path.join(String(home || ''), 'dependencies', 'authlib-injector');
}

/** 找一个已下载的 authlib-injector jar */
function findLocalJar(home) {
  const dir = jarDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^authlib-injector.*\.jar$/i.test(n));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const p = path.join(dir, names[0]);
  try {
    return fs.statSync(p).size > 100 * 1024 ? p : null;
  } catch {
    return null;
  }
}

/** 是否已安装 */
function isJarInstalled(home) {
  return !!findLocalJar(home);
}

/**
 * 下载 authlib-injector。
 * @returns {Promise<{ok:boolean, path?:string, version?:string, error?:string}>}
 */
async function ensureJar({ home, onLog = () => {}, timeoutMs = 180000 }) {
  const existing = findLocalJar(home);
  if (existing) return { ok: true, path: existing, version: '已安装' };

  const dir = jarDir(home);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `创建目录失败：${err?.message || err}` };
  }

  // ① 先问官方清单要最新版
  let downloadUrl = null;
  let version = null;
  try {
    const meta = await http.fetchJson(ARTIFACT_LIST_URL, { timeoutMs: 20000, retries: 1 });
    if (meta && meta.download_url) {
      downloadUrl = meta.download_url;
      version = meta.version || 'latest';
    }
  } catch (err) {
    onLog(`官方清单获取失败（${err?.message || err}），尝试 GitHub`);
  }

  // ② 回落 GitHub releases
  if (!downloadUrl) {
    try {
      const rel = await http.fetchJson(GITHUB_API, { timeoutMs: 20000, retries: 1 });
      const asset = (rel.assets || []).find((a) => /authlib-injector.*\.jar$/i.test(a.name || ''));
      if (asset) {
        downloadUrl = asset.browser_download_url;
        version = rel.tag_name || 'latest';
      }
    } catch (err) {
      onLog(`GitHub 也失败：${err?.message || err}`);
    }
  }

  if (!downloadUrl) {
    return {
      ok: false,
      error:
        '拿不到 authlib-injector 的下载地址（官方 CDN 与 GitHub 都不可用）。' +
        '可以手动下载后放到：' + dir
    };
  }

  onLog(`下载 authlib-injector：${downloadUrl}`);
  const dest = path.join(dir, `authlib-injector-${String(version).replace(/[^0-9A-Za-z._-]/g, '_')}.jar`);
  try {
    const buf = await http.fetchBuffer(downloadUrl, { timeoutMs });
    if (!buf || buf.length < 100 * 1024) throw new Error('下载内容过小，可能不是 jar');
    // 校验 zip 头
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('下载到的不是 jar（可能被重定向到错误页）');
    fs.writeFileSync(dest, buf);
    onLog(`已下载：${dest}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
    return { ok: true, path: dest, version };
  } catch (err) {
    return { ok: false, error: `下载失败：${err?.message || err}` };
  }
}

/**
 * 生成启动时用的 -javaagent 参数。
 *
 * authlib-injector 的标准用法：
 *   -javaagent:<jar路径>=<认证服务器地址>
 * 另外为了兼容旧皮肤站，通常配合：
 *   -Dauthlibinjector.side=client
 */
function buildJavaAgent(home, apiRoot) {
  const jar = findLocalJar(home);
  if (!jar) return null;
  const root = normalizeApiRoot(apiRoot);
  if (!root) return null;
  return `-javaagent:${jar}=${root}`;
}

module.exports = {
  normalizeApiRoot,
  probeServer,
  loginWithPassword,
  validate,
  refresh,
  ensureJar,
  isJarInstalled,
  findLocalJar,
  buildJavaAgent,
  jarDir,
  formatUuid
};
