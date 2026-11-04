'use strict';
/**
 * Quanta Craft Launcher PC · 皮肤管理
 *
 * ## 为什么需要它
 * 用户反馈：「用那些皮肤之后，主界面的史蒂夫没有改变成我微软账号里的皮肤，
 *            或者自定义皮肤文件里面的皮肤」
 *
 * 查证结果：**之前根本没有「自定义皮肤」这个功能** ——
 *   界面里没有任何入口，后端也没有对应字段，主界面永远只显示内置 steve.png。
 *   微软账号那条路虽然会去取皮肤 URL，但失败后静默回落，用户看不到任何提示。
 *
 * ## 现在做三件事
 *   1. 账号可以绑定一个**本地皮肤文件**（.png），优先级高于账号自带皮肤
 *   2. 提供 `accounts:setSkin` 让界面能选文件 / 清除
 *   3. 主界面人物与右栏头像都按「本地皮肤 > 账号皮肤 > 内置默认」的顺序取
 *
 * ## 皮肤图校验
 *   只接受 64×64 或 64×32 的 PNG（Minecraft 皮肤规范）。
 *   尺寸不对直接拒绝并给出中文说明，而不是让游戏里显示成破图。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 读 PNG 的 IHDR 拿宽高（不解码整张图，省内存） */
function readPngSize(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    const n = fs.readSync(fd, head, 0, 24, 0);
    if (n < 24) return null;
    // PNG 签名 89 50 4E 47
    if (head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    return { width, height };
  } catch {
    return null;
  } finally {
    if (fd) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 校验一个皮肤文件。
 * @returns {{ok:boolean, width?:number, height?:number, slim?:boolean, error?:string}}
 */
function validateSkinFile(file) {
  const p = String(file || '');
  if (!p) return { ok: false, error: '路径为空' };
  if (!fs.existsSync(p)) return { ok: false, error: `文件不存在：${p}` };
  if (!/\.png$/i.test(p)) {
    return { ok: false, error: '皮肤必须是 PNG 文件（Minecraft 只认 PNG）' };
  }

  const size = readPngSize(p);
  if (!size) return { ok: false, error: '这个文件不是有效的 PNG 图片' };

  const { width, height } = size;
  if (width !== 64 || (height !== 64 && height !== 32)) {
    return {
      ok: false,
      error:
        `皮肤尺寸不对：当前 ${width}×${height}，必须是 64×64（现代）或 64×32（老式）。` +
        `请用 Minecraft 标准的皮肤文件。`
    };
  }

  return { ok: true, width, height, slim: false };
}

/**
 * 把用户选的皮肤复制到 QCL 主目录统一存放，避免原文件被移动/删除后失效。
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
function importSkin(home, file, accountUuid) {
  const check = validateSkinFile(file);
  if (!check.ok) return check;

  try {
    const dir = path.join(String(home || ''), 'skins');
    fs.mkdirSync(dir, { recursive: true });
    const safeUuid = String(accountUuid || 'default').replace(/[^A-Za-z0-9-]/g, '');
    const dest = path.join(dir, `${safeUuid}.png`);
    fs.copyFileSync(file, dest);
    return { ok: true, path: dest, ...check };
  } catch (err) {
    return { ok: false, error: `复制皮肤文件失败：${err?.message || err}` };
  }
}

/** 读一个皮肤文件的原始字节，转 data URL（给渲染层直接当贴图用，绕过跨域） */
function skinDataUrl(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

module.exports = { validateSkinFile, importSkin, skinDataUrl, readPngSize };
