/**
 * QCL 电脑版 · 图标库
 *
 * 全部图标来自安卓版 `res/drawable/*.xml`（Android VectorDrawable）与 `*.png`：
 *   · XML 矢量 → 照 `pathData` 原样转成内联 SVG（viewBox 24x24），一个都没丢。
 *   · PNG → 用 CSS mask 上色（`--mask: url(...)`），这样日间深色、夜间白色都清晰，
 *     绝不会出现「白图标糊在浅色板上」或空白图标。
 *
 * 注意：内联 SVG 用 `currentColor` 上色，颜色由外层 CSS 的 color 决定。
 */

/**
 * PNG 资源做 mask 时的映射。
 * ★ 路径必须相对 **index.html**（内联 `--mask:url()` 按文档基址解析，不是按 CSS 文件），
 *   所以这里是 `./assets/...`，而不是 `../assets/...`。
 */
export const MASK = {
  lab: './assets/icon/ic_qcl_lab_white.png',
  versionsetting: './assets/icon/ic_qcl_version_setting_white.png',
  grass: './assets/icon/ic_grass.png',
  steve: './assets/icon/ic_steve.png',
};

/**
 * 图标定义表。
 * paths 每项：{ d, mode: 'fill' | 'stroke', sw?: 线宽, even?: true 时 fill-rule=evenodd }
 */
const ICONS = {
  // ---------- 左常驻栏 9 个入口（+ 返回） ----------
  // ic_baseline_home_white.xml
  home: { paths: [{ d: 'M10,20v-6h4v6h5v-8h3L12,3 2,12h3v8z' }] },
  // ic_qcl_version_list_white.xml（三条横杠）
  versionlist: {
    paths: [{ d: 'M4,5 L20,5 L20,7 L4,7 Z' }, { d: 'M4,11 L20,11 L20,13 L4,13 Z' }, { d: 'M4,17 L20,17 L20,19 L4,19 Z' }],
  },
  // ic_qcl_download_white.xml（下箭头 + 底座）
  download: {
    paths: [
      { d: 'M11,3 L13,3 L13,12 L17,12 L12,18 L7,12 L11,12 Z' },
      { d: 'M4,19 L20,19 L20,21 L4,21 Z' },
    ],
  },
  // ic_qcl_jar_white.xml（Java 咖啡杯：三条蒸汽 + 杯身 + 把手）
  jar: {
    paths: [
      { d: 'M8.2,6.6 Q9.2,5.1 8.2,3.6', mode: 'stroke', sw: 1.6 },
      { d: 'M12,6 Q13,4.4 12,2.8', mode: 'stroke', sw: 1.6 },
      { d: 'M15.8,6.6 Q16.8,5.1 15.8,3.6', mode: 'stroke', sw: 1.6 },
      { d: 'M3.6,8.6 H15.9 V15.4 A4.1,4.1 0 0 1 11.8,19.5 H7.7 A4.1,4.1 0 0 1 3.6,15.4 Z' },
      { d: 'M16.4,10.6 H18 A2.9,2.9 0 0 1 18,16.4 H16.4', mode: 'stroke', sw: 1.7 },
    ],
  },
  // ic_qcl_last_log_white.xml（文档轮廓 + evenOdd 挖空的横线）
  lastlog: {
    paths: [
      {
        even: true,
        d:
          'M6.5,2h7.6L19,6.9V20c0,1.1 -0.9,2 -2,2H6.5c-1.1,0 -2,-0.9 -2,-2V4c0,-1.1 0.9,-2 2,-2z' +
          'M14.1,3.6L14.1,7.4L17.9,7.4L14.1,3.6zM8,10.5h7v1.4H8V10.5zM8,13.6h7v1.4H8V13.6zM8,16.7h4.6v1.4H8V16.7z',
      },
    ],
  },
  // ic_qcl_multiplayer_white.xml（分享节点）
  multiplayer: {
    paths: [
      {
        d:
          'M8.5,13.5 C9.6,13.5 10.7,13.8 11.6,14.3 L15.3,11.9 C15.1,11.4 15,10.7 15,10 C15,9.3 15.1,8.6 15.3,8.1 L11.6,5.7 C10.7,6.2 9.6,6.5 8.5,6.5 C5.5,6.5 3,9 3,12 C3,15 5.5,17.5 8.5,17.5 C9.6,17.5 10.7,17.2 11.6,16.7 L15.3,14.3 C15.1,13.8 15,13.3 15,12.7',
      },
      { d: 'M8.5,4.5 m-2.5,0 a2.5,2.5 0 1,0 5,0 a2.5,2.5 0 1,0 -5,0' },
      { d: 'M8.5,19.5 m-2.5,0 a2.5,2.5 0 1,0 5,0 a2.5,2.5 0 1,0 -5,0' },
      { d: 'M17.5,14.5 m-3,0 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0' },
    ],
  },
  // ic_qcl_setting_white.xml（三条滑轨 + 三个旋钮）
  setting: {
    paths: [
      { d: 'M4,5.5 L20,5.5 L20,7 L4,7 Z' },
      { d: 'M4,11.5 L20,11.5 L20,13 L4,13 Z' },
      { d: 'M4,17.5 L20,17.5 L20,19 L4,19 Z' },
      { d: 'M7,2.5 m-2.75,0 a2.75,2.75 0 1,0 5.5,0 a2.75,2.75 0 1,0 -5.5,0' },
      { d: 'M15,8.5 m-2.75,0 a2.75,2.75 0 1,0 5.5,0 a2.75,2.75 0 1,0 -5.5,0' },
      { d: 'M11,14.5 m-2.75,0 a2.75,2.75 0 1,0 5.5,0 a2.75,2.75 0 1,0 -5.5,0' },
    ],
  },
  // ic_baseline_arrow_white.xml（返回）
  back: { paths: [{ d: 'M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z' }] },
  arrow: { paths: [{ d: 'M12,4l-1.41,1.41L16.17,11H4v2h12.17l-5.58,5.59L12,20l8,-8z' }] },

  // ---------- 标题栏 ----------
  // ic_baseline_horizontal_black.xml（最小化）
  minimize: { paths: [{ d: 'M4,11h16v2h-16z' }] },
  // 最大化：空心方框（evenOdd）
  maximize: { paths: [{ even: true, d: 'M5,5h14v14h-14z M7,7v10h10v-7z' }] },
  // 还原：两个错位方框
  restore: { paths: [{ even: true, d: 'M4,8h12v12h-12z M6,10v8h8v-8z M9,4h11v11h-2v-9h-9z' }] },
  // ic_baseline_close_white.xml
  close: {
    paths: [
      { d: 'M19,6.41L17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12z' },
    ],
  },

  // ---------- 通用操作 ----------
  // ic_baseline_add_black.xml
  add: { paths: [{ d: 'M19,13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z' }] },
  // ic_baseline_delete_black.xml
  delete: {
    paths: [{ d: 'M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2V7H6v12zM19,4h-3.5l-1,-1h-5l-1,1H5v2h14V4z' }],
  },
  // ic_baseline_folder_black.xml
  folder: {
    paths: [
      {
        d:
          'M19,20H4C2.89,20 2,19.1 2,18V6C2,4.89 2.89,4 4,4H10L12,6H19A2,2 0 0,1 21,8H21L4,8V18L6.14,10H23.21L20.93,18.5C20.7,19.37 19.92,20 19,20Z',
      },
    ],
  },
  // ic_baseline_refresh_white.xml
  refresh: {
    paths: [
      {
        d:
          'M17.65,6.35C16.2,4.9 14.21,4 12,4c-4.42,0 -7.99,3.58 -7.99,8s3.57,8 7.99,8c3.73,0 6.84,-2.55 7.73,-6h-2.08c-0.82,2.33 -3.04,4 -5.65,4 -3.31,0 -6,-2.69 -6,-6s2.69,-6 6,-6c1.66,0 3.14,0.69 4.22,1.78L13,11h7V4l-2.35,2.35z',
      },
    ],
  },
  // ic_baseline_done_white（对勾）
  done: { paths: [{ d: 'M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41,-1.41z' }] },
  // ic_baseline_cancel_black.xml（禁止圆环）
  cancel: {
    paths: [
      {
        d:
          'M12 2C17.5 2 22 6.5 22 12S17.5 22 12 22 2 17.5 2 12 6.5 2 12 2M12 4C10.1 4 8.4 4.6 7.1 5.7L18.3 16.9C19.3 15.5 20 13.8 20 12C20 7.6 16.4 4 12 4M16.9 18.3L5.7 7.1C4.6 8.4 4 10.1 4 12C4 16.4 7.6 20 12 20C13.9 20 15.6 19.4 16.9 18.3Z',
      },
    ],
  },
  // ic_baseline_person_black.xml
  person: {
    paths: [
      {
        d:
          'M12,12c2.21,0 4,-1.79 4,-4s-1.79,-4 -4,-4 -4,1.79 -4,4 1.79,4 4,4zM12,14c-2.67,0 -8,1.34 -8,4v2h16v-2c0,-2.66 -5.33,-4 -8,-4z',
      },
    ],
  },
  // ic_baseline_microsoft_black.xml（四格）
  microsoft: {
    paths: [{ d: 'M2,3H11V12H2V3M11,22H2V13H11V22M21,3V12H12V3H21M21,22H12V13H21V22Z' }],
  },
  // ic_baseline_pack_white.xml（纸箱）
  pack: {
    paths: [
      {
        d:
          'M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L10.11,5.22L16,8.61L17.96,7.5L12,4.15M6.04,7.5L12,10.85L13.96,9.75L8.08,6.35L6.04,7.5M5,15.91L11,19.29V12.58L5,9.21V15.91M19,15.91V9.21L13,12.58V19.29L19,15.91Z',
      },
    ],
  },
  // ic_baseline_star_black.xml
  star: { paths: [{ d: 'M12,17.27L18.18,21l-1.64,-7.03L22,9.24l-7.19,-0.61L12,2 9.19,8.63 2,9.24l5.46,4.73L5.82,21z' }] },
  // ic_baseline_more_vert_black.xml
  more: {
    paths: [
      { d: 'M12,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2z' },
      { d: 'M12,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z' },
      { d: 'M12,16c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z' },
    ],
  },
  // 播放三角（启动）
  play: { paths: [{ d: 'M8,5.14V19l11,-6.99z' }] },
  // 放大镜
  search: {
    paths: [
      {
        d:
          'M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zm-6,0C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14z',
      },
    ],
  },
  // 地球（多人联机页用）
  earth: {
    paths: [
      { d: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z', mode: 'stroke', sw: 1.6 },
      { d: 'M2,12h20', mode: 'stroke', sw: 1.6 },
      { d: 'M12,2c2.5,2.7 3.9,6.2 3.9,10S14.5,19.3 12,22c-2.5,-2.7 -3.9,-6.2 -3.9,-10S9.5,4.7 12,2z', mode: 'stroke', sw: 1.6 },
    ],
  },
  // 游戏手柄
  gamepad: {
    paths: [
      {
        d: 'M7,8h10c3,0 5,2 5,4.6 0,2 -1.2,3.4 -3,3.4 -1.2,0 -2,-0.6 -2.8,-1.4H7.8C7,15.4 6.2,16 5,16c-1.8,0 -3,-1.4 -3,-3.4C2,10 4,8 7,8z',
      },
      { d: 'M7.4,11v3M5.9,12.5h3', mode: 'stroke', sw: 1.5 },
      { d: 'M15.4,11.4h0.01M17.6,13.4h0.01', mode: 'stroke', sw: 2.4 },
    ],
  },
  // 下载箭头（小，用于「安装」按钮）
  install: {
    paths: [
      { d: 'M11,3 L13,3 L13,12 L17,12 L12,18 L7,12 L11,12 Z' },
      { d: 'M5,19 L19,19 L19,21 L5,21 Z' },
    ],
  },
  // 服务器
  server: {
    paths: [
      { d: 'M4,3.5h16v6H4z', mode: 'stroke', sw: 1.6 },
      { d: 'M4,14.5h16v6H4z', mode: 'stroke', sw: 1.6 },
      { d: 'M7,6.5h0.01M7,17.5h0.01', mode: 'stroke', sw: 2.2 },
    ],
  },
  // 截图
  screenshot: {
    paths: [
      { d: 'M4,6.5h3l1.4,-2h7.2l1.4,2h3v12H4z', mode: 'stroke', sw: 1.6 },
      { d: 'M12,9.5 m-3,0 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0', mode: 'stroke', sw: 1.6 },
    ],
  },
  // 下拉箭头
  chevron: { paths: [{ d: 'M7,10 L12,15 L17,10 Z' }] },
  // 外链
  external: {
    paths: [
      { d: 'M14,4h6v6h-2V7.41l-6.3,6.3 -1.41,-1.41L16.59,6H14z' },
      { d: 'M5,5h5v2H7v10h10v-3h2v5H5z' },
    ],
  },
  // 时钟（用于日志/耗时）
  clock: {
    paths: [
      { d: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z', mode: 'stroke', sw: 1.6 },
      { d: 'M12,7v5.2l3.6,2.1', mode: 'stroke', sw: 1.6 },
    ],
  },
  // 内存条
  memory: {
    paths: [
      { d: 'M3,7h18v8h-2v2h-2v-2H7v2H5v-2H3z', mode: 'stroke', sw: 1.5 },
      { d: 'M7,10v3M11,10v3M15,10v3', mode: 'stroke', sw: 1.5 },
    ],
  },
  // 调色盘
  palette: {
    paths: [
      {
        d:
          'M12,3c-4.97,0 -9,3.58 -9,8 0,4.42 4.03,8 9,8 0.9,0 1.6,-0.7 1.6,-1.6 0,-0.4 -0.15,-0.78 -0.42,-1.06 -0.26,-0.28 -0.42,-0.65 -0.42,-1.06 0,-0.9 0.72,-1.6 1.6,-1.6H16c2.76,0 5,-2.24 5,-5 0,-3.9 -4.03,-6.68 -9,-6.68z',
      },
      { d: 'M7.5,12.5h0.01M10,9h0.01M14,9h0.01M16.5,12h0.01', mode: 'stroke', sw: 2.2 },
    ],
  },
  // 闪电（速度）
  bolt: { paths: [{ d: 'M11,21 L13,13 L8,13 L13,3 L11,11 L16,11 Z' }] },
  // 垃圾/日志清空复用 delete
  copy: {
    paths: [
      { d: 'M9,3h9v2H9z' },
      { d: 'M6,6h12v15H6z', mode: 'stroke', sw: 1.6 },
    ],
  },
  info: {
    paths: [
      { d: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z', mode: 'stroke', sw: 1.6 },
      { d: 'M12,11v6M12,7.6h0.01', mode: 'stroke', sw: 1.8 },
    ],
  },
  // 工具页「崩溃日志分析」用的警告三角
  warning: {
    paths: [
      { d: 'M12,3.2 21.4,20H2.6z', mode: 'stroke', sw: 1.6 },
      { d: 'M12,9.4v4.6M12,17.2h0.01', mode: 'stroke', sw: 1.8 },
    ],
  },
  // 工具页「启动日志」用的文档图标
  file: {
    paths: [
      { d: 'M6,2.6h7.6L19,8v13.4H6z', mode: 'stroke', sw: 1.6 },
      { d: 'M13.4,2.6V8H19', mode: 'stroke', sw: 1.6 },
      { d: 'M8.8,12.4h7.4M8.8,15.6h7.4M8.8,18.4h4.6', mode: 'stroke', sw: 1.4 },
    ],
  },
};

/** 生成一个内联 SVG 字符串 */
export function icon(name, size = 24) {
  const def = ICONS[name];
  if (!def) {
    // 兜底：不认识的名字也给一个可见的方块，绝不留空
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" opacity=".55"/></svg>`;
  }
  const body = def.paths
    .map((p) => {
      const common = `${p.even ? ' fill-rule="evenodd"' : ''}`;
      if (p.mode === 'stroke') {
        return `<path d="${p.d}" fill="none" stroke="currentColor" stroke-width="${p.sw || 1.6}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      return `<path d="${p.d}" fill="currentColor"${common}/>`;
    })
    .join('');
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * 生成一个用 PNG 做 mask 的元素 HTML（颜色继承 currentColor）。
 *
 * ★★★ 关键：mask 的 URL 必须**直接写进内联样式**，不能走 CSS 变量。
 *   `-webkit-mask-image: var(--mask)` 里如果 `--mask` 的值是 `url(...)`，
 *   这条声明会被 Chromium 判为**无效值直接丢弃**（和 `background-image: var(--wallpaper)`
 *   是同一个坑）。症状就是左栏那几个 PNG 图标（当前版本 / 实验室）显示成**空白方块**——
 *   元素有尺寸、有背景色，但没有 mask，于是整块被 background-color 涂满。
 *   ⇒ 直接把 `-webkit-mask-image`/`mask-image` 写成具体 url()。
 */
export function maskIcon(key, size = 24, className = '') {
  const url = MASK[key];
  if (!url) return icon('pack', size);
  const style = [
    `width:${size}px`,
    `height:${size}px`,
    `-webkit-mask-image:url('${url}')`,
    `mask-image:url('${url}')`,
    `-webkit-mask-size:contain`,
    `mask-size:contain`,
    `-webkit-mask-repeat:no-repeat`,
    `mask-repeat:no-repeat`,
    `-webkit-mask-position:center`,
    `mask-position:center`,
    `background-color:currentColor`
  ].join(';');
  return `<span class="${className}" data-mask style="${style}"></span>`;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}
