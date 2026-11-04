/**
 * QCL 电脑版 · 路由
 *
 * 左侧常驻栏 → 页面栈（层级式返回，照安卓版 MainActivity.backToLastUI 的语义）。
 *
 * ★★★ 渲染竞态（2026-11-05 修复，用户实测复现）：
 *   现象：「Java 界面还没加载完，立刻切到另一个界面，等它加载出来后把新界面覆盖掉了」。
 *   根因：navigate() 会 `await page.render(mount)`。页面 render 里往往有 `await call(...)`
 *        （读 Java 列表、读版本清单等，可能要几百毫秒到几秒）。如果用户在这期间切页：
 *          · 旧的 render 还在跑，它拿到数据后继续往 **已经脱离文档的旧 mount** 里写；
 *          · 更糟的是有些页面会 `setHTML(contentEl, ...)` —— 直接改掉了**新页面**的容器；
 *          · 于是新页面刚渲染完就被旧页面覆盖。
 *   修法：引入「渲染代次」（renderToken）。
 *        · 每次 navigate 递增代次，旧代次在 await 之后通过 `isStale()` 发现自己过期，
 *          就不再写 DOM，直接返回。
 *        · 同时旧 mount 已经被移除（contentEl.textContent = ''），即使它硬写也只影响自己。
 *        · 页面可以通过 `ctx.isStale()` 主动检查；router 在 render 返回后也会再查一次。
 */

const pages = new Map();
let contentEl = null;
let currentId = null;
let currentCleanup = null;
const stack = [];

/** 每次 navigate 递增；页面 render 里可以用 token 判断自己是否已过期 */
let renderToken = 0;

export function register(id, def) {
  pages.set(id, Object.assign({ id, title: id, render: () => {} }, def));
}

export function getPage(id) {
  return pages.get(id) || null;
}

export function currentPageId() {
  return currentId;
}

/** 当前代次（页面可用于自查） */
export function currentToken() {
  return renderToken;
}

export function canGoBack() {
  return stack.length > 1;
}

export function start(el, initialId = 'home') {
  contentEl = el;
  return navigate(initialId, {}, { push: true, replaceStack: true });
}

/**
 * 切页。
 * @param {string} id 页面 id
 * @param {object} params 页面参数（如 { instanceId }）
 */
export async function navigate(id, params = {}, { push = true, replaceStack = false } = {}) {
  const page = pages.get(id);
  if (!page || !contentEl) return false;

  // ★ 递增代次：本次之后所有旧 render 都被视为过期
  const myToken = ++renderToken;

  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (err) {
      console.error('[QCL] 页面清理异常：', err);
    }
  }
  currentCleanup = null;

  if (replaceStack) stack.length = 0;
  else if (push && currentId && currentId !== id) stack.push({ id: currentId, params: currentParams });
  if (replaceStack) stack.push({ id, params });
  if (currentId !== id || push) currentId = id;
  currentParams = params;

  contentEl.textContent = '';
  const mount = document.createElement('div');
  mount.className = 'page-mount';
  mount.style.display = 'contents';
  contentEl.appendChild(mount);

  document.dispatchEvent(new CustomEvent('qcl:page', { detail: { id, params } }));

  /** 这个代次是否已经过期（用户已经切到别的页面了） */
  const isStale = () => myToken !== renderToken || !mount.isConnected;

  try {
    // ★ 把 isStale 传给页面，让页面在 await 之后能自查
    const result = await page.render(mount, params, contentEl, { isStale, token: myToken });

    // ★ render 返回时如果已经过期，就不要登记 cleanup（那段清理属于新页面）
    if (isStale()) return false;

    if (result && typeof result.destroy === 'function') currentCleanup = () => result.destroy();
    else if (typeof result === 'function') currentCleanup = result;
  } catch (err) {
    // ★ 过期页面的异常不该弹到用户脸上（它自己已经不在屏幕上了）
    if (isStale()) return false;
    console.error('[QCL] 页面渲染失败：', id, err);
    contentEl.textContent = '';
    const box = document.createElement('div');
    box.className = 'page page--panel';
    box.innerHTML = `<div class="page__body"><div class="empty">
      <div class="empty__title">页面加载失败</div>
      <div class="empty__desc">${String((err && err.message) || err)}</div>
    </div></div>`;
    contentEl.appendChild(box);
  }

  return !isStale();
}

let currentParams = {};

/** 层级式返回一层 */
export function back() {
  if (stack.length <= 1) {
    if (currentId !== 'home') return navigate('home');
    return Promise.resolve(false);
  }
  stack.pop();
  const top = stack[stack.length - 1];
  return navigate(top.id, top.params, { push: false });
}

/** 一步回主页并清空页面栈（照安卓 start_ui_home_page） */
export function goHome() {
  stack.length = 0;
  return navigate('home', {}, { push: false, replaceStack: true });
}
