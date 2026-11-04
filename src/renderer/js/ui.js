/**
 * QCL 电脑版 · 界面工具层
 *
 * 提供：安全模板字符串、DOM 帮手、Toast、顶部提示条、模态框、空状态、格式化。
 * 所有插值默认转义（XSS 安全）——账号名、日志行、文件名都来自外部数据。
 */

import { icon, MASK } from './icons.js';

/**
 * 空状态用的 PNG 蒙版样式。
 * ★ 必须把 `mask-image` 直接写进内联样式：`mask-image: var(--mask)` 里若变量是 `url(...)`，
 *   Chromium 会判定为无效值整条丢弃（和 wallpaper 那个坑同源），结果只剩一块纯色方块。
 */
function maskStyle(key) {
  const url = MASK[key] || '';
  if (!url) return '';
  return `-webkit-mask-image:url('${url}');mask-image:url('${url}');-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;background-color:currentColor;`;
}

const RAW = Symbol('qcl-raw');

/**
 * promptDialog 的哨兵值：表示「用户点了确认，请把输入框里现在的内容读出来」。
 * 用 Symbol 而不是字符串 '__ok__'，避免用户真的输入 '__ok__' 时被误判。
 */
const INPUT_VALUE = Symbol('qcl-input-value');

/**
 * 一段已经拼好的安全 HTML。
 * 关键：`html` 返回的就是这个类型（而不是普通字符串），这样**嵌套** html`` 与 `.map()`
 * 得到的数组不会被二次转义 —— 否则 `<div>` 会原样显示成文本。
 */
export class Html {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
}

/** 标记一段「原样输出」的 HTML（用于外部拼好的可信片段或第三方 SVG 字符串） */
export function raw(str) {
  return new Html(str);
}

function renderValue(v) {
  if (v == null || v === false) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(v);
}

/** 安全模板字符串：${...} 自动转义，除非它是 raw()/html`` 产生的 Html */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return new Html(out);
}

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------ DOM ------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function frag(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup);
  return t.content;
}

/** 用 HTML 替换容器内容（接受 html`` / raw() / 普通字符串） */
export function setHTML(node, markup) {
  if (!node) return;
  /**
   * ★ 防止「过期页面覆盖新页面」。
   *
   * 场景（用户实测）：Java 设置页还没加载完就切走，它的 render 里
   * `await call('java:list')` 完成后会继续 setHTML —— 如果这个 node 是被复用的
   * contentEl，就会把新页面直接冲掉。
   *
   * 判断依据：node 已经脱离文档（isConnected === false）⇒ 它属于一个已经不在屏幕上的页面，
   * 直接丢弃这次写入，不做任何事。仍然在文档里的正常页面不受影响。
   */
  if (node.nodeType === 1 && node.isConnected === false) {
    return;
  }
  node.innerHTML = String(markup == null ? '' : markup);
}

export function on(node, evt, handler, opts) {
  if (!node) return () => {};
  node.addEventListener(evt, handler, opts);
  return () => node.removeEventListener(evt, handler, opts);
}

/** 事件委托：在容器上监听，按 selector 命中才触发 */
export function delegate(root, evt, selector, handler) {
  return on(root, evt, (e) => {
    const target = e.target instanceof Element ? e.target.closest(selector) : null;
    if (target && root.contains(target)) handler(e, target);
  });
}

export function clear(node) {
  if (node) node.textContent = '';
}

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------ 格式化 ------------------------------ */

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtSpeed(bytesPerSec) {
  const n = Number(bytesPerSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${fmtBytes(n)}/秒`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtClock(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtRelative(ts) {
  if (!ts) return '从未启动';
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(ts);
}

export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = Math.floor(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

/** 加载器中文名 */
export const LOADER_NAME = {
  vanilla: '原版',
  forge: 'Forge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  neoforge: 'NeoForge',
  optifine: 'OptiFine',
  liteloader: 'LiteLoader',
};

export function loaderLabel(loader) {
  if (!loader || !loader.type || loader.type === 'vanilla') return '原版';
  const name = LOADER_NAME[loader.type] || loader.type;
  return loader.version ? `${name} ${loader.version}` : name;
}

export function versionTypeLabel(type) {
  switch (type) {
    case 'release':
      return '正式版';
    case 'snapshot':
      return '快照';
    case 'old_beta':
      return '远古 · Beta';
    case 'old_alpha':
      return '远古 · Alpha';
    case 'ancient':
      return '远古版本';
    default:
      return type || '未知';
  }
}

/* ------------------------------ Toast ------------------------------ */

let toastRoot = null;

/**
 * 右下角提示。
 *
 * ★★★ 2026-11-05 修（用户原话：「右下角的那个提示框是空的，直接给我弹出来一堆空气」）。
 *
 * `.toast` 有 `min-width: 200px`，所以 message 为空/undefined 时**不会消失**，
 * 而是弹出一个 200px 宽、只有圆点的空盒子。调用方散落在 20 多个文件里，
 * `toast(r.error || '')` 这种写法一旦真拿到空串就会漏出来。
 *
 * ⇒ 在这里集中拦一道（所有调用点都受益，以后新写的也拦得住）：
 *    空串 / 纯空白 / undefined / null / "undefined" / "null" / "[object Object]" 一律不弹。
 *    type 也做归一化，避免出现 `.toast--undefined` 这种没有颜色的空壳。
 */
const TOAST_TYPES = new Set(['info', 'ok', 'warn', 'error']);

export function toast(message, type = 'info', ms = 3600) {
  const text = message == null ? '' : String(message).trim();
  if (!text || text === 'undefined' || text === 'null' || text === '[object Object]') {
    return () => {};
  }
  if (!toastRoot) toastRoot = document.getElementById('toast-root');
  if (!toastRoot) return () => {};
  const level = TOAST_TYPES.has(type) ? type : 'info';
  const node = document.createElement('div');
  node.className = `toast toast--${level}`;
  /**
   * ★★★ 顺序不能反：**先 appendChild，再 setHTML**。
   *
   * `setHTML()` 有一条「过期页面覆盖新页面」的保护：
   *     if (node.nodeType === 1 && node.isConnected === false) return;
   * 而 toast 节点是 `createElement` 出来的、当时**还没进 DOM** ⇒ isConnected === false
   * ⇒ 内容被静默丢弃，只剩一个 200px 宽的空盒子（`.toast { min-width: 200px }`）。
   * 这正是用户说的「右下角的提示框是空的，直接给我弹出来一堆空气」
   * —— 不是某个调用传了空字符串，而是**每一条** toast 都没写进内容。
   */
  toastRoot.appendChild(node);
  setHTML(node, html`<span class="toast__dot"></span><span class="toast__body">${text}</span>`);
  const timer = setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  }, ms);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });
  return () => {
    clearTimeout(timer);
    node.remove();
  };
}

/* ------------------------------ 顶部提示条 ------------------------------ */

const banners = new Map();

export function banner(message, type = 'warn', { id = 'default', timeout = 0, closable = true } = {}) {
  const root = document.getElementById('banner-root');
  if (!root) return () => {};
  closeBanner(id);
  const node = document.createElement('div');
  node.className = `banner banner--${type}`;
  node.dataset.bannerId = id;
  // ★ 同 toast：必须先入 DOM 再 setHTML，否则会被 setHTML 的「未连接节点」保护丢掉内容
  root.appendChild(node);
  setHTML(
    node,
    html`<span class="banner__text" title="${message}">${message}</span>${raw(
      closable ? '<button class="banner__close" type="button" aria-label="关闭提示">✕</button>' : ''
    )}`
  );
  const close = () => {
    node.remove();
    banners.delete(id);
  };
  if (closable) {
    const btn = node.querySelector('.banner__close');
    if (btn) btn.addEventListener('click', close);
  }
  banners.set(id, close);
  if (timeout > 0) setTimeout(close, timeout);
  return close;
}

export function closeBanner(id) {
  const close = banners.get(id);
  if (close) close();
}

/* ------------------------------ 模态框 ------------------------------ */

let modalOpen = false;

/**
 * 打开模态框。buttons: [{ text, value, kind:'primary'|'ghost'|'danger', autofocus }]
 * 返回被点按钮的 value；点遮罩/按 Esc 返回 null。
 */
export function openModal({ title, body = '', buttons = [], wide = false, onMount = null }) {
  const root = document.getElementById('modal-root');
  if (!root) return Promise.resolve(null);
  if (modalOpen) closeModal(null);

  return new Promise((resolve) => {
    modalOpen = true;
    root.hidden = false;
    clear(root);

    const btns = buttons
      .map(
        (b, i) =>
          raw(
            `<button class="btn ${b.kind === 'ghost' ? 'btn--ghost' : b.kind === 'danger' ? 'btn--danger' : ''}" data-idx="${i}" type="button">${esc(
              b.text
            )}</button>`
          )
      );
    const foot =
      buttons.length > 0 ? html`<div class="modal__foot">${btns}</div>` : raw('');

    setHTML(
      root,
      html`<div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal__head">
          <div class="modal__title">${title}</div>
          ${raw('<button class="winbtn" data-close type="button" title="关闭">' + icon('close', 14) + '</button>')}
        </div>
        <div class="modal__body">${raw(body)}</div>
        ${foot}
      </div>`
    );

    const finish = (value) => {
      /**
       * ★★★ 顺序极其重要：必须在 clear(root) **之前**把 DOM 里的值取出来。
       *
       * 曾经的写法是 `clear(root)` → `resolve(value)`，于是 promptDialog 的
       * `.then()` 里再 `document.getElementById('qcl-prompt-input')` 必然拿到 null
       * ⇒ 永远返回空字符串 ⇒ 「添加离线账号」按钮点了没反应（后端报"请填写玩家名"）。
       * 整合包导入、版本重命名这些用 promptDialog 的地方全部中招。
       *
       * ⇒ 现在改成先 snapshot（把输入框的值塞进 value 一起 resolve），再清 DOM。
       */
      let out = value;
      if (out === INPUT_VALUE) {
        const input = root.querySelector('#qcl-prompt-input');
        out = input ? String(input.value || '').trim() : '';
      }
      modalOpen = false;
      root.hidden = true;
      clear(root);
      document.removeEventListener('keydown', onKey, true);
      resolve(out);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener('keydown', onKey, true);

    root.addEventListener('mousedown', (e) => {
      if (e.target === root) finish(null);
    });
    const closeBtn = root.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', () => finish(null));
    root.querySelectorAll('[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = buttons[Number(btn.dataset.idx)];
        finish(b ? b.value : null);
      });
    });

    if (typeof onMount === 'function') onMount(root, finish);
    const focusTarget =
      (buttons.find((b) => b.autofocus) &&
        root.querySelectorAll('[data-idx]')[[...buttons].findIndex((b) => b.autofocus)]) ||
      root.querySelector('.modal__body .input') ||
      root.querySelector('[data-idx]');
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  });
}

export function closeModal(value = null) {
  const root = document.getElementById('modal-root');
  if (!root || root.hidden) return;
  // 让 openModal 的 promise 收尾：模拟一次取消
  const closeBtn = root.querySelector('[data-close]');
  if (closeBtn) closeBtn.click();
  else {
    root.hidden = true;
    clear(root);
    modalOpen = false;
  }
}

export function confirmDialog({
  title = '请确认',
  message = '',
  okText = '确定',
  cancelText = '取消',
  danger = false,
} = {}) {
  return openModal({
    title,
    body: html`<div style="font-size:13px;line-height:1.7">${raw(String(message))}</div>`,
    buttons: [
      { text: cancelText, value: false, kind: 'ghost' },
      { text: okText, value: true, kind: danger ? 'danger' : 'primary', autofocus: true },
    ],
  }).then((v) => v === true);
}

export function promptDialog({
  title = '请输入',
  label = '',
  value = '',
  placeholder = '',
  hint = '',
  okText = '确定',
  // 兼容旧调用（有些页面传的是 confirmText / message）
  message = '',
  confirmText = ''
} = {}) {
  const finalOk = okText !== '确定' ? okText : (confirmText || '确定');
  const finalLabel = label || message || '';
  const body = html`<div class="field">
    <label class="field__label" for="qcl-prompt-input">${finalLabel}</label>
    <input class="input" id="qcl-prompt-input" value="${value}" placeholder="${placeholder}" autocomplete="off" />
    ${hint ? raw(`<div class="field__hint">${esc(hint)}</div>`) : raw('')}
  </div>`;
  return openModal({
    title,
    body,
    // ★ value 用哨兵 INPUT_VALUE，由 finish() 在清 DOM 前读出真实输入
    buttons: [
      { text: '取消', value: null, kind: 'ghost' },
      { text: finalOk, value: INPUT_VALUE, kind: 'primary' },
    ],
    onMount: (root, finish) => {
      const input = root.querySelector('#qcl-prompt-input');
      if (input) {
        input.focus();
        input.select();
        // 回车 = 确认（走同一个 finish，值仍由 finish 在清 DOM 前读取）
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (typeof finish === 'function') finish(INPUT_VALUE);
          }
        });
      }
    },
  });
}

/* ------------------------------ 空状态 / 骨架 ------------------------------ */

export function emptyState({ iconName = 'pack', maskKey = '', title = '暂无内容', desc = '', actionHTML = '' } = {}) {
  const glyph = maskKey
    ? html`<span class="empty__icon" data-mask style="width:44px;height:44px;${maskStyle(maskKey)}"></span>`
    : html`<span class="empty__icon">${raw(icon(iconName, 44))}</span>`;
  return html`<div class="empty">
    ${glyph}
    <div class="empty__title">${title}</div>
    ${desc ? html`<div class="empty__desc">${desc}</div>` : raw('')}
    ${actionHTML ? html`<div style="margin-top:6px">${raw(actionHTML)}</div>` : raw('')}
  </div>`;
}

function maskUrl(key) {
  // 同样必须相对 index.html（内联 --mask 按文档基址解析）
  const map = {
    lab: './assets/icon/ic_qcl_lab_white.png',
    versionsetting: './assets/icon/ic_qcl_version_setting_white.png',
    grass: './assets/icon/ic_grass.png',
  };
  return map[key] || map.grass;
}

export function skeletonRows(count = 4, row = false) {
  return html`${Array.from({ length: count }, () =>
    raw(`<div class="skeleton ${row ? 'skeleton--row' : ''}"></div>`)
  )}`;
}

export function busyBlock(text = '正在加载…') {
  return html`<div class="empty"><span class="spinner-inline"></span><div class="empty__desc">${text}</div></div>`;
}

/* ------------------------------ 剪贴板 ------------------------------ */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast('已复制到剪贴板', 'ok', 1800);
    return true;
  } catch (err) {
    toast('复制失败：' + (err && err.message ? err.message : '浏览器拒绝访问剪贴板'), 'error');
    return false;
  }
}

/** 把外部（相对 index.html）路径变成能在 src/href 里用的相对路径 */
export function assetUrl(rel) {
  return `./assets/${rel}`;
}
