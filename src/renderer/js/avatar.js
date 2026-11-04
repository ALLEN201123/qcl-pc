/**
 * Quanta Craft Launcher PC · 头像工具
 *
 * ★★★ 2026-11-05 重写：之前用「程序化画 8×8 像素画」生成 Steve 脸，
 *      用户原话「根本就是看起来就像 AI 乱 P 的东西」—— 那个方案废弃了。
 *
 *   现在只做一件事：**从真实的皮肤贴图里裁出脸**（和安卓版 Avatar.java 完全一致）：
 *     · 脸：皮肤图坐标 (8, 8) 起 8×8
 *     · 帽子层：64×64 皮肤坐标 (40, 8) 起 8×8，叠在脸上
 *   没有皮肤时**不再自己画**，而是回落到项目自带的 `ic_steve.png` / `ic_alex.png`
 *   （这两张是安卓版原图，真正的 Steve/Alex 头像素材）。
 */

/** 皮肤里「脸」的坐标（照 Android Avatar.java） */
const FACE = { x: 8, y: 8, w: 8, h: 8 };
/** 帽子层坐标（只在 64×64 皮肤上有） */
const HAT = { x: 40, y: 8, w: 8, h: 8 };

/**
 * 从皮肤图裁出头像，返回 data URL。
 * @param {HTMLImageElement|HTMLCanvasElement} source 皮肤图（64×64 或 64×32）
 * @param {number} size 输出像素尺寸
 * @returns {string|null}
 */
export function faceFromSkin(source, size = 64) {
  try {
    const img = source;
    if (!img || !img.width || !img.height) return null;
    const w = img.width;
    const h = img.height;
    // Minecraft 皮肤只有 64×64（现代，含第二层）和 64×32（老式，无第二层）
    if (w < 64 || (h !== 64 && h !== 32)) return null;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 像素风：关掉平滑
    ctx.imageSmoothingEnabled = false;

    // ① 脸
    ctx.drawImage(img, FACE.x, FACE.y, FACE.w, FACE.h, 0, 0, size, size);

    // ② 帽子层（64×64 才有），叠在脸上
    if (h === 64) {
      ctx.drawImage(img, HAT.x, HAT.y, HAT.w, HAT.h, 0, 0, size, size);
    }

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** 加载一张图片（失败返回 null，不抛错） */
export function loadImage(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    img.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    };
    img.crossOrigin = 'anonymous';
    img.src = url;
  });
}

/**
 * 默认头像（没有皮肤时用）。
 *
 * ★ 不再程序化画脸 —— 直接用项目自带的安卓版素材：
 *     ./assets/icon/ic_steve.png  （史蒂夫头像，安卓版原图）
 *   如果那张图也取不到，就返回一个中性的纯色方块（极少数情况）。
 */
export function defaultFace() {
  return './assets/icon/ic_steve.png';
}

/**
 * 给一个账号算出头像 URL。
 *
 * 优先级（与主界面人物一致）：
 *   ① 本地自定义皮肤（account.skinFile）→ 裁脸
 *   ② 账号自带皮肤（微软正版 account.avatar）→ 裁脸
 *   ③ 内置 ic_steve.png
 *
 * @param {object} account
 * @param {object} [deps]  { readSkin: (path)=>Promise<dataUrl> }  主进程读取本地皮肤
 * @returns {Promise<string>} 可直接给 <img src> 的地址
 */
export async function avatarForAccount(account, deps = {}) {
  if (!account) return defaultFace();

  // ① 本地皮肤
  if (account.skinFile) {
    try {
      const readSkin = deps.readSkin;
      const dataUrl = readSkin ? await readSkin(account.skinFile) : null;
      if (dataUrl) {
        const img = await loadImage(dataUrl);
        if (img) {
          const face = faceFromSkin(img);
          if (face) return face;
        }
      }
      // 直接当 URL 试一次（兼容 skinFile 是 http 地址的情况）
      const img2 = await loadImage(account.skinFile);
      if (img2) {
        const face2 = faceFromSkin(img2);
        if (face2) return face2;
      }
    } catch {
      /* 落到下一档 */
    }
  }

  // ② 账号自带皮肤（微软）
  if (account.avatar) {
    const img = await loadImage(account.avatar);
    if (img) {
      const face = faceFromSkin(img);
      if (face) return face;
    }
  }

  // ③ 内置头像
  return defaultFace();
}
