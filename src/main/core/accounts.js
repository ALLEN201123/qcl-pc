'use strict';
/*
 * accounts.js —— 离线账号 + 微软设备码登录。
 *
 * 离线 UUID：照 Java 的 UUID.nameUUIDFromBytes("OfflinePlayer:<名字>") ——
 *   MD5 → 设 version=3（第 7 字节高 4 位 = 0011）→ 设 variant（第 9 字节高 2 位 = 10）。
 *
 * 微软登录：**必须走老式 Live 通道**（这不是偷懒，是实测结论）。
 *   安卓版 MsaDeviceCode.java 的踩坑记录（已核对，两处都失败过）：
 *     新式 login.microsoftonline.com/consumers/oauth2/v2.0/devicecode + 00000000402b5328 → AADSTS700016
 *     新式同一端点 + 第三方公开 AAD 客户端 ID                                    → 同样 AADSTS700016
 *     老式 login.live.com/oauth20_connect.srf（设备码）+ 老式 oauth20_token.srf   → ✅ 可用
 *   两套通道不通用，所以这里照老通道的参数来：
 *     取码带 response_type=device_code；换令牌/刷新带 redirect_**url**（不是 redirect_uri）；
 *     scope 用 service::user.auth.xboxlive.com::MBI_SSL。
 *
 *   完整链路：设备码 → refresh_token → MSA access_token → XBL → XSTS → Minecraft 登录 → profile 取名/UUID。
 */

const crypto = require('node:crypto');

const jsonstore = require('./jsonstore');
const http = require('./http');
const paths = require('./paths');

const CLIENT_ID = '00000000402b5328';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const REDIRECT_URL = 'https://login.live.com/oauth20_desktop.srf';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

/** 带预填验证码的授权页（老通道支持 otc 自动填充，玩家不用手输）。 */
function buildPrefilledUrl(userCode) {
  if (!userCode) return 'https://www.microsoft.com/link';
  return `https://login.live.com/oauth20_remoteconnect.srf?otc=${encodeURIComponent(userCode)}`;
}

/**
 * 离线模式 UUID（等价 Java UUID.nameUUIDFromBytes）。
 * @param {string} name
 * @returns {string} 带连字符的小写 UUID
 */
function offlineUuid(name) {
  const raw = String(name == null ? '' : name);
  const digest = crypto.createHash('md5').update(`OfflinePlayer:${raw}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30; // version 3
  digest[8] = (digest[8] & 0x3f) | 0x80; // IETF variant
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* --------------------------------------------------------------- 账号存储 */

function readStore(home) {
  const data = jsonstore.readJson(paths.accountsFile(home), null);
  if (!data || typeof data !== 'object') return { version: 1, accounts: [], selected: null };
  return {
    version: 1,
    accounts: Array.isArray(data.accounts) ? data.accounts.filter((a) => a && a.uuid) : [],
    selected: data.selected || null,
  };
}

function writeStore(home, store) {
  jsonstore.writeJson(paths.accountsFile(home), store);
}

/** 账号列表（选中账号排在最前，界面直接取第一个即可）。 */
async function list(home) {
  const store = readStore(home);
  const selected = store.selected;
  const accounts = store.accounts.slice();

  /**
   * ★★★ 必须把 `selected` 字段明确标到账号上。
   *
   * 之前只做了「把选中的排到第一位」，而没有写 selected 字段。
   * 渲染层的 currentAccount() 是 `accounts.find(a => a.selected)` ——
   * 于是永远返回 undefined，右栏一直显示「还没有账号」，
   * 主界面人物也拿不到账号皮肤（这是用户报「头像/皮肤不显示」的直接原因之一）。
   */
  const withFlag = accounts.map((a) => ({ ...a, selected: a.uuid === selected }));

  withFlag.sort((a, b) => {
    if (a.selected) return -1;
    if (b.selected) return 1;
    return String(a.name).localeCompare(String(b.name));
  });

  // 没有显式选中时，把第一个当作默认选中（避免整个界面没账号可用）
  if (withFlag.length && !withFlag.some((a) => a.selected)) {
    withFlag[0].selected = true;
  }

  return withFlag;
}

/** 新增离线账号（同名则覆盖刷新）。 */
async function addOffline(home, name) {
  const playerName = String(name == null ? '' : name).trim();
  if (!playerName) throw new Error('请填写玩家名');
  if (playerName.length > 16) throw new Error('玩家名不能超过 16 个字符');
  if (!/^[A-Za-z0-9_]+$/.test(playerName)) throw new Error('玩家名只能包含字母、数字和下划线');

  const account = {
    uuid: offlineUuid(playerName),
    name: playerName,
    type: 'offline',
    accessToken: null,
  };
  const store = readStore(home);
  const index = store.accounts.findIndex((a) => a.uuid === account.uuid);
  if (index >= 0) store.accounts[index] = { ...store.accounts[index], ...account };
  else store.accounts.push(account);
  store.selected = account.uuid;
  writeStore(home, store);
  return account;
}

/** 删除账号。 */
async function remove(home, uuid) {
  const store = readStore(home);
  store.accounts = store.accounts.filter((a) => a.uuid !== uuid);
  if (store.selected === uuid) store.selected = store.accounts.length ? store.accounts[0].uuid : null;
  writeStore(home, store);
}

/** 设为选中账号。 */
async function select(home, uuid) {
  const store = readStore(home);
  if (store.accounts.some((a) => a.uuid === uuid)) {
    store.selected = uuid;
    writeStore(home, store);
  }
  return list(home);
}

/**
 * 更新某个账号的字段（目前用于设置/清除本地皮肤）。
 *
 * @param {string} home
 * @param {string} uuid
 * @param {object} patch  例如 { skinFile: 'D:\\...\\skin.png' } 或 { skinFile: null }
 * @returns {object|null} 更新后的账号
 */
async function updateAccount(home, uuid, patch) {
  const store = readStore(home);
  const idx = store.accounts.findIndex((a) => a.uuid === uuid);
  if (idx < 0) return null;
  store.accounts[idx] = { ...store.accounts[idx], ...(patch || {}) };
  writeStore(home, store);
  return store.accounts[idx];
}

/** 内部：写入 / 更新一个账号记录（微软登录用）。 */
function upsert(home, account) {
  const store = readStore(home);
  const index = store.accounts.findIndex((a) => a.uuid === account.uuid);
  if (index >= 0) store.accounts[index] = { ...store.accounts[index], ...account };
  else store.accounts.push(account);
  store.selected = account.uuid;
  writeStore(home, store);
  return account;
}

/* ------------------------------------------------------------- 微软登录 */

/** 进行中的设备码流程：flowId -> {deviceCode,userCode,verificationUri,intervalMs,expiresAt} */
const flows = new Map();
let flowSeq = 0;

function formEncode(data) {
  const parts = [];
  for (const key of Object.keys(data)) {
    if (data[key] === undefined || data[key] === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(data[key]))}`);
  }
  return parts.join('&');
}

/** POST 表单；把 authorization_pending / slow_down 当正常状态返回，不抛错。 */
async function postForm(url, form, options) {
  const opts = options || {};
  const body = formEncode(form);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 30000),
    });
  } catch (err) {
    throw new http.LauncherError(http.describeError(err, '连接微软登录服务器'), { code: 'E_NETWORK', cause: err });
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  if (response.ok) return { ok: true, json, text, status: response.status };

  // 微软用 400 + error 字段表示「还没确认」，这是正常流程
  const errCode = (json && (json.error || json.errorType)) || '';
  const errText = String(text || '');
  if (errCode === 'authorization_pending' || errText.includes('authorization_pending')) {
    return { ok: false, pending: true, slowDown: false, json, text, status: response.status };
  }
  if (errCode === 'slow_down' || errText.includes('slow_down')) {
    return { ok: false, pending: true, slowDown: true, json, text, status: response.status };
  }
  const status = response.status;
  let message;
  if (status === 503 || status === 502 || status === 504) message = '登录超时：微软服务器繁忙或网络不稳定，请稍后重试';
  else if (status === 401 || status === 403) message = '登录失败：授权被拒绝，请重新获取设备码';
  else if (status === 400) message = '设备码已失效，请重新获取';
  else message = `登录失败（错误码 ${status}），请稍后重试`;
  throw new http.LauncherError(message, { code: 'E_MSA', detail: errText.slice(0, 300) });
}

/** POST JSON。 */
async function postJson(url, payload, options) {
  const opts = options || {};
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 30000),
    });
  } catch (err) {
    throw new http.LauncherError(http.describeError(err, '连接 Xbox Live'), { code: 'E_NETWORK', cause: err });
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  if (!response.ok) {
    let message = `Xbox Live 拒绝了请求（HTTP ${response.status}）`;
    if (json && json.XErr) {
      const xerr = String(json.XErr);
      if (xerr === '2148916233') message = '该微软账号还没有 Xbox 档案，请先在 xbox.com 创建档案后重试';
      else if (xerr === '2148916235') message = '该账号所在地区不支持 Xbox Live';
      else if (xerr === '2148916238') message = '该账号是未成年账号，需要家长同意后才能登录';
      else message = `Xbox Live 拒绝了请求（XErr ${xerr}）`;
    }
    throw new http.LauncherError(message, { code: 'E_XBL', detail: text.slice(0, 300) });
  }
  return json;
}

/** 第一步：申请设备码。 */
async function startMicrosoft() {
  const result = await postForm(
    DEVICE_CODE_URL,
    { client_id: CLIENT_ID, scope: SCOPE, response_type: 'device_code' },
    { timeoutMs: 30000 },
  );
  if (!result.ok || !result.json) {
    throw new http.LauncherError('申请微软设备码失败：服务器没有返回设备码');
  }
  const json = result.json;
  if (!json.device_code || !json.user_code) {
    throw new http.LauncherError('申请微软设备码失败：返回内容缺少 device_code / user_code');
  }
  const intervalMs = json.interval ? Math.max(1000, Number(json.interval) * 1000) : 5000;
  const expiresIn = json.expires_in ? Number(json.expires_in) : 900;
  const flowId = `msa-${Date.now().toString(36)}-${(flowSeq += 1)}`;
  flows.set(flowId, {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri || json.verification_url || 'https://www.microsoft.com/link',
    intervalMs,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return {
    flowId,
    userCode: json.user_code,
    verificationUri: json.verification_uri || json.verification_url || 'https://www.microsoft.com/link',
    verificationUriComplete: buildPrefilledUrl(json.user_code),
    expiresIn,
    intervalMs,
    message: `请在浏览器打开 ${json.verification_uri || 'https://www.microsoft.com/link'} 并输入验证码 ${json.user_code}`,
  };
}

/** 轮询一次设备码。 */
async function pollMicrosoft(flowId, home) {
  const flow = flows.get(flowId);
  if (!flow) {
    return { status: 'error', message: '登录流程不存在或已结束，请重新点击「添加微软账号」' };
  }
  if (Date.now() > flow.expiresAt) {
    flows.delete(flowId);
    return { status: 'error', message: '设备码已过期，请重新获取' };
  }

  let result;
  try {
    result = await postForm(
      TOKEN_URL,
      {
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
        redirect_url: REDIRECT_URL,
      },
      { timeoutMs: 30000 },
    );
  } catch (err) {
    // 单次网络抖动不要终止整个流程，让界面继续轮询
    return { status: 'pending', message: err && err.message ? err.message : '网络不稳定，正在重试' };
  }

  if (result.pending) {
    if (result.slowDown) flow.intervalMs = Math.min(30000, flow.intervalMs + 5000);
    return { status: 'pending' };
  }
  if (!result.ok || !result.json || !result.json.refresh_token) {
    return { status: 'error', message: '登录失败：微软没有返回刷新令牌' };
  }

  try {
    const account = await completeMicrosoftLogin(result.json.refresh_token, home);
    flows.delete(flowId);
    if (home) upsert(home, account);
    return { status: 'done', account };
  } catch (err) {
    flows.delete(flowId);
    return { status: 'error', message: err && err.message ? err.message : '登录失败' };
  }
}

/** 用刷新令牌完成 XBL → XSTS → MC 登录 → profile。 */
async function completeMicrosoftLogin(refreshToken, home) {
  // ① 刷新令牌换 MSA access_token
  const tokenResp = await postForm(
    TOKEN_URL,
    {
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      redirect_url: REDIRECT_URL,
      scope: SCOPE,
    },
    { timeoutMs: 30000 },
  );
  if (!tokenResp.ok || !tokenResp.json || !tokenResp.json.access_token) {
    throw new http.LauncherError('刷新微软令牌失败，请重新登录');
  }
  const msaToken = tokenResp.json.access_token;
  const newRefresh = tokenResp.json.refresh_token || refreshToken;

  // ② XBL
  const xbl = await postJson(XBL_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!xbl || !xbl.Token) throw new http.LauncherError('Xbox Live 认证失败：没有返回令牌');

  // ③ XSTS
  const xsts = await postJson(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (!xsts || !xsts.Token) throw new http.LauncherError('XSTS 授权失败：没有返回令牌');
  const uhs = xsts.DisplayClaims
    && xsts.DisplayClaims.xui
    && xsts.DisplayClaims.xui[0]
    && xsts.DisplayClaims.xui[0].uhs;
  if (!uhs) throw new http.LauncherError('XSTS 授权失败：返回内容缺少用户哈希');
  /**
   * ★★★ 2026-11-05 修：把 XUID 存下来。
   *
   * 新版（1.16+）的游戏参数里有 `--xuid ${auth_xuid}` 和 `--clientId ${clientid}`，
   * 而我们的 tokenMap 里**从来没提供过这两个值** —— 实测命令行里就是原样传了
   * `${auth_xuid}` / `${clientid}` 两个字面量进去（玩家日志里能看到）。
   * 游戏自己不读它们也能进，但微软账号的联机 / Realms / 统计会因此缺少身份信息。
   *
   * ★ 实测发现：用 `rp://api.minecraftservices.com/` 换的 XSTS，
   *   `DisplayClaims.xui[0]` **只有 uhs，没有 xid**；
   *   换成 `RelyingParty: 'http://xboxlive.com'` 再要一次才会有 `xid`（就是 XUID）。
   *   所以这里额外多问一次，拿不到就算了（绝不阻断登录）。
   */
  let xuid = null;
  try {
    const xstsForXuid = await postJson(XSTS_URL, {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'http://xboxlive.com',
      TokenType: 'JWT',
    });
    xuid =
      (xstsForXuid &&
        xstsForXuid.DisplayClaims &&
        xstsForXuid.DisplayClaims.xui &&
        xstsForXuid.DisplayClaims.xui[0] &&
        xstsForXuid.DisplayClaims.xui[0].xid) ||
      null;
  } catch (_) {
    xuid = null;
  }

  // ④ 换 Minecraft access token
  const mc = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
  if (!mc || !mc.access_token) throw new http.LauncherError('获取 Minecraft 登录令牌失败');

  // ⑤ 拉 profile 拿名字与 UUID（同时验证是否拥有游戏）
  let profile;
  try {
    const response = await fetch(MC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${mc.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) {
      throw new http.LauncherError('这个微软账号还没有购买 Minecraft Java 版（或尚未迁移），无法用它在离线模式下启动');
    }
    if (!response.ok) {
      throw new http.LauncherError(`获取 Minecraft 账号资料失败（HTTP ${response.status}）`);
    }
    profile = await response.json();
  } catch (err) {
    if (err instanceof http.LauncherError) throw err;
    throw new http.LauncherError(http.describeError(err, '获取 Minecraft 账号资料'), { code: 'E_NETWORK', cause: err });
  }
  if (!profile || !profile.name) throw new http.LauncherError('Minecraft 账号资料不完整：没有玩家名');

  const rawId = String(profile.id || '').replace(/-/g, '');
  const uuid = rawId.length === 32
    ? `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`
    : rawId;

  /**
   * ★★★ 2026-11-05 修：同时保存**皮肤**和**披风**。
   *
   * 以前只取了 `skins.find(state==='ACTIVE').url` —— 那是**皮肤**，
   * 同一数组里的 **cape** 被直接丢掉，于是主界面永远画不出披风
   * （用户实测「主界面人物没有同步背后的披风」）。
   *
   * Mojang 的 profile.skins 形如：
   *   [{ id:'skin', state:'ACTIVE', url:'…' },
   *    { id:'cape', state:'ACTIVE', url:'…' }]
   * ⇒ 分别按 id 取，且都要求 state === 'ACTIVE'（卸下的披风不该显示）。
   */
  /**
   * ★★★ 2026-11-05 修（用户：「我的微软账号皮肤怎么又变回史蒂夫了」）。
   *
   * Mojang `/minecraft/profile` 现在返回的 `skins` 里，每项的 `id` 是**纹理哈希**，
   * 不是字面量 "skin"；而且**披风已经挪到独立的 `capes` 数组**：
   *
   *   {
   *     "skins": [{ "id":"<hash>", "state":"ACTIVE", "url":"http://textures…", "variant":"SLIM" }],
   *     "capes": [{ "id":"<hash>", "state":"ACTIVE", "url":"http://textures…", "alias":"Migrator" }]
   *   }
   *
   * 以前这里写的是 `skins.find(s => s.id === 'skin')` —— 旧格式才对得上，
   * 新格式永远匹配不到 ⇒ activeSkin=null ⇒ avatar 空、skinModel 回落 classic ⇒
   * **主界面人物、账号页头像全变成史蒂夫**（就是这个 bug）。
   *
   * 现在：
   *   · skins：取 state=ACTIVE 的第一项（有 variant/url 就算）
   *   · capes：优先看独立的 `capes` 数组，其次兼容老格式里 id 含 cape 的项
   */
  const skins = Array.isArray(profile.skins) ? profile.skins : [];
  const capes = Array.isArray(profile.capes) ? profile.capes : [];
  const activeSkin =
    skins.find((s) => s && s.state === 'ACTIVE' && (s.variant || s.url)) ||
    skins.find((s) => s && s.state === 'ACTIVE') ||
    null;
  const activeCape =
    capes.find((c) => c && c.state === 'ACTIVE' && c.url) ||
    skins.find((s) => s && s.state === 'ACTIVE' && /cape/i.test(String(s.id || ''))) ||
    null;
  const capUrl = (activeCape && activeCape.url) || null;
  const skinUrl = (activeSkin && activeSkin.url) || null;
  const variant = activeSkin && String(activeSkin.variant || '').toUpperCase() === 'SLIM' ? 'slim' : 'classic';

  return {
    uuid,
    name: profile.name,
    type: 'microsoft',
    accessToken: mc.access_token,
    refreshToken: newRefresh,
    /** Xbox 用户 ID（游戏参数 --xuid 用；联机/Realms 需要它） */
    xuid: xuid || null,
    // 微软令牌默认 24 小时有效，这里保守记 12 小时，过期前由界面提示重新登录
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    /** 头像/皮肤贴图地址（皮肤读取走主进程代理，绕过 CSP 的 http 限制） */
    avatar: skinUrl,
    skinUrl,
    /** 披风地址（没有披风时为 null） */
    capeUrl: capUrl,
    /** 皮肤模型：SLIM = Alex 细手臂，其它当 classic */
    skinModel: variant,
  };
}

/** 用已保存的刷新令牌续期（启动前调用；失败就返回原记录，由界面提示重新登录）。 */
async function refreshAccount(account, home) {
  if (!account || account.type !== 'microsoft' || !account.refreshToken) return account;
  /**
   * ★ 令牌还有效、但**关键资料缺失**时也强制刷新一次：
   *   · 皮肤丢了（历史 bug 把 avatar/capeUrl 写成空 → 主界面变史蒂夫）
   *   · XUID 没存（老版本登录时没采集，`--xuid` 传空会影响微软账号联机 / Realms）
   */
  const skinMissing = !account.avatar && !account.skinUrl;
  const xuidMissing = account.type === 'microsoft' && !account.xuid;
  if (!skinMissing && !xuidMissing && account.expiresAt && account.expiresAt - Date.now() > 10 * 60 * 1000) return account;
  try {
    const fresh = await completeMicrosoftLogin(account.refreshToken, home);
    const merged = {
      ...account,
      ...fresh,
      uuid: account.uuid,
      name: fresh.name || account.name,
      // ★ 新资料里没有皮肤时**保留旧的**，别用 null 把原来的覆盖掉
      avatar: fresh.avatar || account.avatar || null,
      skinUrl: fresh.skinUrl || account.skinUrl || fresh.avatar || account.avatar || null,
      capeUrl: fresh.capeUrl || account.capeUrl || null,
      skinModel: fresh.avatar || fresh.skinUrl ? fresh.skinModel : account.skinModel || 'classic',
      // ★ XUID 也是「有就更新、没有就保留」
      xuid: fresh.xuid || account.xuid || null,
    };
    if (home) upsert(home, merged);
    return merged;
  } catch (_) {
    return account;
  }
}

module.exports = {
  CLIENT_ID,
  DEVICE_CODE_URL,
  TOKEN_URL,
  // 契约冻结
  list,
  addOffline,
  remove,
  select,
  updateAccount,   // ★ 新增：设置/清除账号的本地皮肤
  upsert,          // ★ 新增：新增或更新账号（第三方 authlib 登录用）
  offlineUuid,
  startMicrosoft,
  pollMicrosoft,
  // 扩展
  refreshAccount,
  buildPrefilledUrl,
};
