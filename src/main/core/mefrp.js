'use strict';
/**
 * 魅frp（MeFrp）API 客户端
 *
 * ★ 依据隔壁「一键开服」开源项目（mineserve / Minexa）的 `MeFrpApi.kt`：
 *   BASE = https://api.mefrp.com/api
 *   · 响应统一有 `{ code, data }` 外壳（与樱花不同，樱花没有外壳）
 *   · 错误信息在 `msg` 里
 *   · 隧道配置：POST `/auth/proxy/config` {proxyId, format:'toml'} → data.config 是 TOML 文本
 *
 * 它和樱花一样**返回 TOML**，所以可以直接喂给同一个 frpc 引擎（core/servertunnel.js）。
 */

const BASE = 'https://api.mefrp.com/api';
const TIMEOUT_MS = 15000;

async function request(method, urlPath, token, bodyObj) {
  const init = {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'User-Agent': 'QCL-Launcher/1.0 (Minecraft server manager)',
      Accept: 'application/json',
    },
  };
  if (bodyObj !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(bodyObj);
  }
  if (token) init.headers.Authorization = token;

  let res;
  try {
    res = await fetch(`${BASE}${urlPath}`, init);
  } catch (err) {
    const hint = err && err.name === 'TimeoutError' ? '请求超时（15 秒）' : err && err.message ? err.message : String(err);
    throw new Error(`连不上魅frp：${hint}`);
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg = String(j.msg || j.message || msg);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`魅frp 返回的不是合法 JSON（前 80 字：${text.slice(0, 80)}）`);
  }
  // 业务码：非 200 视为失败
  if (j && j.code !== undefined && Number(j.code) !== 200) {
    throw new Error(String(j.msg || `魅frp 返回 code=${j.code}`));
  }
  return (j && j.data) || {};
}

/** 账号信息 */
async function userInfo(token) {
  if (!String(token || '').trim()) throw new Error('没填魅frp 的 token');
  const d = await request('GET', '/auth/info', token);
  return {
    name: String(d.username || d.name || ''),
    group: String((d.group && d.group.name) || d.group || ''),
    level: Number((d.group && d.group.level) || d.level) || 0,
    email: String(d.email || ''),
  };
}

/** 隧道（代理）列表 */
async function proxyList(token) {
  const d = await request('GET', '/user/proxy', token);
  const arr = Array.isArray(d) ? d : Array.isArray(d.list) ? d.list : Array.isArray(d.proxies) ? d.proxies : [];
  return arr.map((m) => ({
    id: String(m.id !== undefined ? m.id : m.proxyId || ''),
    name: String(m.name || m.proxyName || ''),
    type: String(m.type || 'tcp'),
    localIp: String(m.localIp || m.local_ip || '127.0.0.1'),
    localPort: Number(m.localPort || m.local_port) || 25565,
    remoteAddress: String(m.remote || m.remoteAddr || ''),
    online: m.online === true || String(m.online) === '1',
  }));
}

/** 节点列表 */
async function nodeList(token) {
  const d = await request('GET', '/user/node', token);
  const arr = Array.isArray(d) ? d : Array.isArray(d.list) ? d.list : [];
  return arr.map((m) => ({
    id: String(m.id !== undefined ? m.id : ''),
    name: String(m.name || ''),
    hostname: String(m.hostname || m.host || ''),
    description: String(m.description || ''),
    online: m.online === true || String(m.online) === '1',
  }));
}

/** 拉取隧道配置（TOML 文本） */
async function proxyConfig(token, proxyId) {
  const id = String(proxyId || '').trim();
  if (!id) throw new Error('没指定隧道');
  const asNumber = Number(id);
  const body = {
    proxyId: Number.isFinite(asNumber) && String(asNumber) === id ? asNumber : id,
    format: 'toml',
  };
  const d = await request('POST', '/auth/proxy/config', token, body);
  const toml = String((d && d.config) || '').trim();
  if (!toml) throw new Error('魅frp 返回的隧道配置是空的（检查隧道是否存在）');
  if (!/serverAddr\s*=/i.test(toml)) {
    throw new Error(`魅frp 返回的配置看起来不对（前 80 字：${toml.slice(0, 80)}）`);
  }
  return { ok: true, toml };
}

module.exports = { BASE, userInfo, proxyList, nodeList, proxyConfig };
