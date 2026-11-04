/**
 * QCL 电脑版 · 主题引擎
 *
 * 职责：把 `Settings` 映射成 CSS 变量 + 壁纸，管昼夜（auto 跟随系统）。
 *
 * 昼夜铁律（契约 §6）：
 *   · 浅色态 = 近白半透明面板 + 深色文字
 *   · 夜间态 = 深色半透明面板 + 白色文字
 *   · 绝不允许「深底黑字 / 白底白字」
 * 做法：文字色与面板底色都在 base.css 里成对定义，这里只负责切 data-mode。
 */

import { DEFAULT_SETTINGS } from './mock.js';

/**
 * 内置壁纸清单（全部来自安卓版 res/drawable*，照搬不重画）。
 *
 * ★ 路径必须相对 **index.html**（`./assets/...`）：这些字符串会被直接塞进
 *   `<img src>` 与 CSS `url()`，浏览器一律按**文档基址**解析，不是按 js/ 目录。
 *   （踩过的坑：写成 `../assets/...` 会让设置页的壁纸缩略图全部变碎图。）
 */
export const WALLPAPERS = [
  { id: 'builtin:pale', label: '苍白花园', file: './assets/wallpaper/ic_background.jpg' },
  { id: 'builtin:day', label: '花园日间', file: './assets/wallpaper/qcl_bg_day.jpg' },
  { id: 'builtin:classic', label: '经典主界面', file: './assets/wallpaper/ic_background_classic.jpg' },
  { id: 'builtin:night', label: '苍白花园 · 夜', file: './assets/wallpaper/qcl_bg_4.jpg' },
  { id: 'builtin:1', label: '壁纸 1', file: './assets/wallpaper/qcl_bg_1.jpg' },
  { id: 'builtin:2', label: '壁纸 2', file: './assets/wallpaper/qcl_bg_2.jpg' },
  { id: 'builtin:3', label: '壁纸 3', file: './assets/wallpaper/qcl_bg_3.jpg' },
  { id: 'builtin:4', label: '壁纸 4', file: './assets/wallpaper/qcl_bg_4.jpg' },
  { id: 'builtin:5', label: '壁纸 5', file: './assets/wallpaper/qcl_bg_5.jpg' },
  { id: 'builtin:6', label: '壁纸 6', file: './assets/wallpaper/qcl_bg_6.jpg' },
];

/** 主题色预设（默认 #865D58 排第一） */
export const ACCENT_PRESETS = [
  '#865D58',
  '#6D4C9F',
  '#2F6F8F',
  '#2F7D4A',
  '#8F6A2F',
  '#A8452F',
  '#3A3F4A',
  '#B04A7A',
];

const root = document.documentElement;
let mediaQuery = null;

/* ------------------------------ 颜色工具 ------------------------------ */

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 134, g: 93, b: 88 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const p = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

export function mix(hex, target, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

/** 相对亮度（WCAG），用来判断在主题色上该用浅字还是深字 */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* ------------------------------ 壁纸 ------------------------------ */

export function wallpaperCss(id) {
  const v = String(id || '');
  if (v.startsWith('file:')) {
    const p = v.slice(5).replace(/\\/g, '/');
    const withSlash = /^[a-zA-Z]:/.test(p) ? `/${p}` : p;
    return `url("file://${withSlash}")`;
  }
  const found = WALLPAPERS.find((w) => w.id === v);
  const file = found ? found.file : WALLPAPERS[0].file;
  return `url("${file}")`;
}

export function wallpaperLabel(id) {
  const v = String(id || '');
  if (v.startsWith('file:')) return '自定义图片';
  const found = WALLPAPERS.find((w) => w.id === v);
  return found ? found.label : '苍白花园';
}

/**
 * 真正把壁纸贴到元素上。
 *
 * ★★★ 为什么不用 CSS 变量：`background-image: var(--wallpaper)` 里若变量值是 `url(...)`，
 * 这条声明会被判为**无效值直接丢弃**（var() 的替换发生在属性值层面，而 `url()` 属特殊语法，
 * 替换后不再重新解析）。症状是「整屏没有壁纸、只剩面板灰」—— 之前截图正是如此。
 * ⇒ 直接写内联 `element.style.backgroundImage`。
 */
export function applyWallpaper(id) {
  const el = document.querySelector('.wallpaper');
  if (!el) return;
  const v = String(id || '');
  if (v.startsWith('file:')) {
    const p = v.slice(5).replace(/\\/g, '/');
    const withSlash = /^[a-zA-Z]:/.test(p) ? `/${p}` : p;
    el.style.backgroundImage = `url("file://${withSlash}")`;
    return;
  }
  const found = WALLPAPERS.find((w) => w.id === v) || WALLPAPERS[0];
  // 用 CSS 侧的绝对基址，避免依赖文档基址
  el.style.backgroundImage = `url("${found.file}")`;
}

/* ------------------------------ 应用主题 ------------------------------ */

export function resolveMode(mode) {
  if (mode === 'light' || mode === 'night') return mode;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'light';
  } catch (err) {
    return 'light';
  }
}

export function applyTheme(settings) {
  const s = settings || DEFAULT_SETTINGS;
  const theme = Object.assign({}, DEFAULT_SETTINGS.theme, s.theme);

  // 主题色
  const accent = /^#[0-9a-f]{6}$/i.test(String(theme.accent || '')) ? theme.accent : DEFAULT_SETTINGS.theme.accent;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-strong', mix(accent, '#000000', 0.22));
  root.style.setProperty('--accent-soft', mix(accent, '#ffffff', 0.55));
  // 按钮文字：默认 #F2F6FA（深底浅字）。只有主题色亮到一定程度才改用深字，
  // 这是为了不违反「绝不允许白底白字」这条硬规则。
  const onAccent = luminance(accent) > 0.62 ? '#141414' : '#F2F6FA';
  root.style.setProperty('--on-accent', onAccent);
  root.style.setProperty('--on-accent-dim', onAccent === '#F2F6FA' ? 'rgba(242,246,250,.72)' : 'rgba(20,20,20,.6)');

  // 面板透明度（0.3 ~ 1.0）
  const alphaRaw = Number(theme.panelAlpha);
  const alpha = Number.isFinite(alphaRaw) ? Math.max(0.3, Math.min(1, alphaRaw)) : 0.7;
  root.style.setProperty('--panel-a', String(alpha));

  // 面板底色（照安卓版 1.5.2：可自定义，留空则跟随昼夜）
  //
  // ★ CSS 侧的面板色是 `--panel: rgba(var(--panel-rgb), var(--panel-a))`，
  //   所以自定义面板色只要改写 `--panel-rgb` 这个三通道值即可，透明度照常生效。
  const mode = resolveMode(theme.mode);
  const customPanel = String(theme.panelColor || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(customPanel)) {
    const pr = hexToRgb(customPanel);
    root.style.setProperty('--panel-rgb', `${pr.r}, ${pr.g}, ${pr.b}`);
    root.dataset.panelCustom = '1';
  } else {
    // 恢复「跟随昼夜」：把内联覆盖移除，让 base.css 里浅色/夜间两套值重新接管
    root.style.removeProperty('--panel-rgb');
    delete root.dataset.panelCustom;
  }

  // 壁纸：直接设到元素上（不要走 CSS 变量，见 applyWallpaper 注释）
  const app = document.getElementById('app');
  if (app) app.dataset.wallpaper = String(theme.wallpaperId || 'builtin:pale');
  applyWallpaper(theme.wallpaperId);

  // 昼夜（用上面已经算好的 mode，别重复调用 resolveMode —— 否则面板色判断与实际模式可能不一致）
  root.dataset.mode = mode;

  // 壁纸自动轮换
  startWallpaperRotation(Boolean(theme.wallpaperRotate), theme.wallpaperId);

  return { accent, onAccent, alpha, mode };
}

/* --------------------------- 壁纸自动轮换 --------------------------- */

/**
 * 壁纸自动轮换（对应安卓版 1.3.4 的「动态背景 / 自动切换」）。
 *
 * 每隔一段时间换成清单里的下一张。用 setTimeout 递归而不是 setInterval，
 * 这样切换壁纸/关闭轮换时能立刻干净地停掉，不会留下野定时器。
 */
let rotateTimer = null;
let rotateIndex = 0;

export function startWallpaperRotation(enabled, currentId) {
  stopWallpaperRotation();
  if (!enabled) return;
  if (typeof WALLPAPERS === 'undefined' || WALLPAPERS.length < 2) return;

  const idx = WALLPAPERS.findIndex((w) => w.id === currentId);
  rotateIndex = idx >= 0 ? idx : 0;

  const ROTATE_MS = 60 * 1000; // 每分钟换一张，不打扰用户
  const tick = () => {
    rotateIndex = (rotateIndex + 1) % WALLPAPERS.length;
    const next = WALLPAPERS[rotateIndex];
    // 只改画面，不写设置（避免每次轮换都落盘）
    const el = document.querySelector('.wallpaper');
    if (el && next) {
      // 交叉淡入：先加个 transition，换图后再移除，避免生硬跳变
      el.style.transition = 'opacity .6s ease';
      el.style.opacity = '0';
      setTimeout(() => {
        el.style.backgroundImage = `url("${next.file}")`;
        el.style.opacity = '1';
      }, 320);
    }
    rotateTimer = setTimeout(tick, ROTATE_MS);
  };
  rotateTimer = setTimeout(tick, ROTATE_MS);
}

export function stopWallpaperRotation() {
  if (rotateTimer) {
    clearTimeout(rotateTimer);
    rotateTimer = null;
  }
}

/** 监听系统深浅色变化（只在 theme.mode === 'auto' 时起作用） */
export function watchSystemTheme(getMode, onChange) {
  if (mediaQuery) return;
  try {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (err) {
    return;
  }
  const handler = () => {
    if (getMode() === 'auto') onChange(resolveMode('auto'));
  };
  if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', handler);
  else if (typeof mediaQuery.addListener === 'function') mediaQuery.addListener(handler);
}

/** 窗口阴影边距：主进程 win:state 事件里给，最大化时是 0 */
export function applyInset(inset) {
  const n = Number(inset);
  root.style.setProperty('--inset', `${Number.isFinite(n) ? Math.max(0, n) : 18}px`);
}
