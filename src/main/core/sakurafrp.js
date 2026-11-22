'use strict';
/**
 * 樱花frp（SakuraFrp）API 客户端 · v4
 *
 * ★ 为什么接樱花frp：
 *   frp 本身需要一台有公网 IP 的服务器（frps）。大部分玩家没有。
 *   樱花frp 提供免费的公共 frps 节点，玩家注册拿一个 token 就能开隧道 ——
 *   这是中文 MC 圈最通行的一键穿透方案。
 *
 * ★ 实现依据：隔壁「一键开服」开源项目（mineserve / Minexa）的
 *   `SakuraFrpApi.kt`，API 语义逐条对齐：
 *     · 认证：GET 用 `?token=`，POST 用 `Authorization: Bearer`
 *     · `/user/info`      → 账号信息（含等级，决定能用哪些节点）
 *     · `/tunnels`        → 隧道数组（无包络）
 *     · `/nodes`          → 节点对象（key = 节点 id，flag 位标记 UDP / 离线 / VIP）
 *     · POST `/tunnels`   → 建隧道，成功为 201
 *     · POST `/tunnel/config` → **返回生成好的 frpc TOML 文本**（text/plain，非 JSON）
 *
 * ★ `/tunnel/config` 要声明 frpc 版本。声明得比实际引擎旧，平台会下发老字段集，
 *   引擎不认识就 `unknown field` 直接退出。所以这里用 0.71.0，与 servertunnel 的
 *   引擎版本保持一致。
 */

const BASE = 'https://api.natfrp.com/v4';
const TIMEOUT_MS = 15000;
/** 与 servertunnel.FRP_VERSION 保持一致 */
const FRPC_VERSION = '0.71.0';

/** 底层请求：返回 { code, text } */
async function request(method, urlPath, token, bodyObj) {
  const url = `${BASE}${urlPath}`;
  const init = {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'User-Agent': 'QCL-Launcher/1.0 (Minecraft server manager)',
      Accept: 'application/json, text/plain, */*',
    },
  };
  if (bodyObj !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(bodyObj);
  }
  if (token && method !== 'GET') {
    init.headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const hint = err && err.name === 'TimeoutError' ? '请求超时（15 秒）' : err && err.message ? err.message : String(err);
    throw new Error(`连不上樱花frp：${hint}`);
  }
  const text = await res.text();
  return { code: res.status, text };
}

/** 解析响应；非 2xx 时优先取服务端的 msg */
function decodeJson({ code, text }) {
  if (code < 200 || code >= 300) {
    let msg = `HTTP ${code}`;
    try {
      const j = JSON.parse(text);
      if (j && j.msg) msg = String(j.msg);
    } catch {
      /* 不是 JSON 就用 HTTP 码 */
    }
    const err = new Error(msg);
    err.status = code;
    throw err;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`樱花frp 返回的不是合法 JSON（前 80 字：${text.slice(0, 80)}）`);
  }
}

/* ============================================================
 * API
 * ============================================================ */

/** 验证 token 并取账号信息 */
async function userInfo(token) {
  if (!String(token || '').trim()) throw new Error('没填樱花frp 的访问 token');
  const j = decodeJson(await request('GET', `/user/info?token=${encodeURIComponent(token)}`, null));
  if (!j) throw new Error('获取账号信息失败（返回为空）');
  const group = j.group || {};
  return {
    name: String(j.name || ''),
    group: String(group.name || ''),
    level: Number(group.level) || 0,
    maxTunnels: j.tunnels === undefined || j.tunnels === null ? null : Number(j.tunnels),
    email: String(j.email || ''),
  };
}

/** 我的隧道列表 */
async function tunnelList(token) {
  const j = decodeJson(await request('GET', `/tunnels?token=${encodeURIComponent(token)}`, null));
  const arr = Array.isArray(j) ? j : [];
  return arr.map((m) => {
    const remote = String(m.remote || '');
    return {
      id: String(m.id !== undefined ? m.id : ''),
      name: String(m.name || ''),
      nodeId: String(m.node !== undefined ? m.node : ''),
      type: String(m.type || 'tcp'),
      localIp: String(m.local_ip || '127.0.0.1'),
      localPort: Number(m.local_port) || 25565,
      remotePort: /^\d+$/.test(remote) ? Number(remote) : null,
      remoteAddress: remote.includes(':') ? remote : '',
      online: m.online === true || String(m.online) === '1' || String(m.online) === 'true',
    };
  });
}

/** 节点列表（含 vip/udp/在线标记） */
async function nodeList(token, userLevel = 0) {
  const j = decodeJson(await request('GET', `/nodes?token=${encodeURIComponent(token)}`, null));
  if (!j || typeof j !== 'object') return [];
  const FLAG_UDP = 1 << 5;
  const FLAG_OFFLINE = 1 << 9;
  const out = [];
  for (const [id, raw] of Object.entries(j)) {
    if (!raw || typeof raw !== 'object') continue;
    const vip = Number(raw.vip) || 0;
    if (vip > userLevel) continue; // 等级不够的节点不展示
    const flag = Number(raw.flag) || 0;
    out.push({
      id: String(id),
      name: String(raw.name || ''),
      hostname: String(raw.host || ''),
      description: String(raw.description || ''),
      online: (flag & FLAG_OFFLINE) === 0,
      udpSupport: (flag & FLAG_UDP) !== 0,
      vip,
    });
  }
  // 在线的排前面
  out.sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1));
  return out;
}

/** 创建隧道 */
async function createTunnel(token, opts = {}) {
  const body = {
    node: Number(opts.node) || 0,
    name: String(opts.name || 'QCL 服务端').slice(0, 40),
    type: String(opts.type || 'tcp'),
    note: 'Created by QCL Launcher',
    local_ip: String(opts.localIp || '127.0.0.1'),
    local_port: Number(opts.localPort) || 25565,
  };
  if (opts.remotePort) body.remote = String(opts.remotePort);
  const r = await request('POST', '/tunnels', token, body);
  if (r.code < 200 || r.code >= 300) {
    let msg = `HTTP ${r.code}`;
    try {
      const j = JSON.parse(r.text);
      if (j && j.msg) msg = String(j.msg);
    } catch {
      /* ignore */
    }
    throw new Error(`建隧道失败：${msg}`);
  }
  return { ok: true };
}

/**
 * 拉取某个隧道的 frpc 配置（**返回 TOML 文本**）。
 * @param {string} token
 * @param {string} query 隧道 id（如 "114514"）或节点 id 前缀 n（如 "n233"）
 * @returns {Promise<{ok:boolean, toml:string}>}
 */
async function tunnelConfig(token, query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('没指定隧道');
  const r = await request('POST', '/tunnel/config', token, { query: q, frpc: FRPC_VERSION });
  if (r.code < 200 || r.code >= 300) {
    let msg = `HTTP ${r.code}`;
    try {
      const j = JSON.parse(r.text);
      if (j && j.msg) msg = String(j.msg);
    } catch {
      /* ignore */
    }
    throw new Error(`获取隧道配置失败：${msg}`);
  }
  const toml = String(r.text || '').trim();
  if (!toml) throw new Error('樱花frp 返回的配置是空的');
  // 简单自检：必须是 TOML 且含 serverAddr
  if (!/serverAddr\s*=/i.test(toml)) {
    throw new Error(`樱花frp 返回的配置看起来不对（前 80 字：${toml.slice(0, 80)}）`);
  }
  return { ok: true, toml };
}

module.exports = {
  BASE,
  FRPC_VERSION,
  userInfo,
  tunnelList,
  nodeList,
  createTunnel,
  tunnelConfig,
};
