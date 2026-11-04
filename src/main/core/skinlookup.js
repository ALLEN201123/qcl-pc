'use strict';
/**
 * Quanta Craft Launcher PC · 玩家皮肤查询（照安卓版 SkinLibraryDialog 移植）
 *
 * ## 它解决什么问题
 * 用户反馈：「游戏账号那里的图标显示不会正确显示其他玩家的皮肤、头像、图标」。
 *
 * 真正的需求是：**输入任意正版玩家名，就能看到那个人的皮肤与头像**。
 * 安卓版用 `SkinLibraryDialog` 做这件事，走的是**公开且长期可用**的 Mojang 接口：
 *   ① `api.mojang.com/users/profiles/minecraft/<名字>` → 拿到 UUID
 *   ② `sessionserver.mojang.com/session/minecraft/profile/<UUID>` → 拿 textures
 *   ③ textures 是 base64 的 JSON，里面 `textures.SKIN.url` 就是皮肤 PNG 地址
 * 不需要任何密钥，也不碰玩家隐私。
 *
 * ## 额外支持
 *   · 离线名（Mojang 查不到）→ 明确告诉用户，不假装成功
 *   · 皮肤模型判定：slim（Alex，细手臂）还是 classic（Steve，粗手臂）——
 *     Mojang 在 textures 里会写 `"model":"slim"`，拿得到就照着用
 */

const http = require('./http');

const PROFILE_URL = (name) => `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`;
const SESSION_URL = (uuid) =>
  `https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(uuid)}`;

/** 把带连字符的 UUID 去掉连字符（Mojang 接口用无连字符形式） */
function stripUuid(uuid) {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

/** 把无连字符 UUID 还原成标准带连字符形式 */
function formatUuid(raw) {
  const s = stripUuid(raw);
  if (s.length !== 32) return s;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** 解码 textures 的 base64 JSON */
function decodeTextures(b64) {
  try {
    const json = Buffer.from(String(b64), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 查询一个正版玩家名的皮肤信息。
 *
 * @param {object} opts
 * @param {string} opts.name  正版玩家名（2~16 字符）
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{
 *   ok: boolean,
 *   name?: string,
 *   uuid?: string,
 *   skinUrl?: string,
 *   capeUrl?: string|null,
 *   slim?: boolean,
 *   error?: string
 * }>}
 */
async function lookupPlayerSkin({ name, timeoutMs = 15000 }) {
  const playerName = String(name || '').trim();
  if (!playerName) return { ok: false, error: '请输入玩家名' };
  if (playerName.length > 16) return { ok: false, error: '玩家名不能超过 16 个字符' };
  if (!/^[A-Za-z0-9_]+$/.test(playerName)) {
    return { ok: false, error: '玩家名只能包含字母、数字和下划线' };
  }

  // ① 名字 → UUID
  let profile = null;
  try {
    profile = await http.fetchJson(PROFILE_URL(playerName), { timeoutMs, retries: 1 });
  } catch (err) {
    return {
      ok: false,
      error:
        `查询不到正版玩家「${playerName}」。` +
        `可能原因：① 这个名字不存在（离线名查不到皮肤）；② 网络不通。` +
        `${err?.message ? `（${err.message}）` : ''}`
    };
  }
  if (!profile || !profile.id) {
    return { ok: false, error: `查询不到正版玩家「${playerName}」，这个名字可能不存在或是离线账号` };
  }

  const uuid = formatUuid(profile.id);
  const realName = profile.name || playerName;

  // ② UUID → profile（含 textures）
  let session = null;
  try {
    session = await http.fetchJson(SESSION_URL(profile.id), { timeoutMs, retries: 1 });
  } catch (err) {
    return {
      ok: false,
      name: realName,
      uuid,
      error: `找到玩家「${realName}」，但读取皮肤信息失败：${err?.message || '网络错误'}`
    };
  }

  const props = (session && session.properties) || [];
  const texProp = props.find((p) => p && p.name === 'textures');
  if (!texProp || !texProp.value) {
    return {
      ok: false,
      name: realName,
      uuid,
      error: `玩家「${realName}」没有公开的皮肤信息（可能用的是默认皮肤）`
    };
  }

  const textures = decodeTextures(texProp.value);
  const skinEntry = textures && textures.textures && textures.textures.SKIN;
  if (!skinEntry || !skinEntry.url) {
    return {
      ok: false,
      name: realName,
      uuid,
      error: `玩家「${realName}」没有自定义皮肤（使用默认 Steve）`
    };
  }

  const capeEntry = textures.textures.CAPE;

  return {
    ok: true,
    name: realName,
    uuid,
    skinUrl: skinEntry.url,
    capeUrl: capeEntry && capeEntry.url ? capeEntry.url : null,
    // Mojang 在 SKIN 里写 "model":"slim" 表示 Alex 细手臂
    slim: String(skinEntry.metadata && skinEntry.metadata.model || '').toLowerCase() === 'slim'
  };
}

/**
 * 下载一张皮肤并转 data URL（渲染层要用它当 three.js 贴图）。
 * @returns {Promise<{ok:boolean, dataUrl?:string, bytes?:number, error?:string}>}
 */
async function downloadSkinAsDataUrl({ url, timeoutMs = 20000 }) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '皮肤地址无效' };
  try {
    const buf = await http.fetchBuffer(url, { timeoutMs });
    if (!buf || buf.length < 100) return { ok: false, error: '皮肤下载失败（内容异常）' };
    // 校验 PNG 头
    if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
      return { ok: false, error: '下载到的不是 PNG 图片（可能是错误页面）' };
    }
    return { ok: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}`, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: `下载皮肤失败：${err?.message || err}` };
  }
}

module.exports = { lookupPlayerSkin, downloadSkinAsDataUrl, formatUuid, stripUuid };
