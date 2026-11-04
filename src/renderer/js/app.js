/**
 * QCL 电脑版 · 渲染层入口
 *
 * 启动顺序：
 *   1. 初始化与主进程的桥（window.qcl 不存在时自动降级为内置示例数据）
 *   2. 初始化外壳（自绘标题栏 / 左常驻栏 / 右常驻栏）
 *   3. 拉取设置与数据 → 应用主题 → 渲染首页
 *   4. 订阅主进程事件（设置变更、实例变更、账号变更、窗口状态）
 */

import { initBridge, setDegradedHandler, on, call, isConnected, hasMain, emitLocal } from './bridge.js';
import { setMockEmitter } from './mock.js';
import { bootstrap, subscribe, wireStoreEvents, setConnected, state } from './store.js';
import { applyInset } from './theme.js';
import {
  initTitlebar,
  initLeftNav,
  wireLeftNav,
  initRightPanel,
  updateRightPanel,
  updateTitleStatus,
  highlightNav,
} from './shell.js';
import * as router from './router.js';
import { banner, closeBanner, toast, html, setHTML } from './ui.js';
import { homePage } from './pages/home.js';
import { versionListPage } from './pages/versionlist.js';
import { downloadPage } from './pages/download.js';
import { versionSettingPage } from './pages/versionsetting.js';
import { accountsPage } from './pages/accounts.js';
import { settingPage } from './pages/setting.js';
import { logPage } from './pages/log.js';
import { aboutPage } from './pages/about.js';
// ★ 说明页：中文补丁（安卓版移植）与「中国版 Betacraft」那套远古版本支持，全在 src/pages/help.js
import { helpPage } from './pages/help.js';
// ★ 「实验室」与「JAR 启动」是手机功能，PC 上不适用：
//   实验室 → 换成「工具」（实例文件夹 / 崩溃分析 / 实例备份）
//   JAR 启动 → 直接移除（PC 上双击 jar 或走实例启动即可）
import { toolsPage } from './pages/tools.js';
import { modsPage } from './pages/mods.js';
import { multiplayerPage } from './pages/multiplayer.js';

/* ------------------------------ 页面注册 ------------------------------ */

/** 尚未实现的页面：给一个明确的占位，绝不白屏 */
function pendingPage(id, title) {
  return {
    id,
    title,
    render(mount) {
      setHTML(
        mount,
        html`<div class="page page--panel">
          <div class="page__head"><div class="page__title">${title}</div></div>
          <div class="page__body">
            <div class="empty">
              <div class="empty__title">${title} 正在接入</div>
              <div class="empty__desc">这个页面的数据通道已经就绪，界面实现正在收尾。</div>
            </div>
          </div>
        </div>`
      );
    },
  };
}

const PAGES = [
  homePage,
  versionListPage,
  downloadPage,
  versionSettingPage,
  accountsPage,
  settingPage,
  logPage,
  aboutPage,
  helpPage,
  toolsPage,
  modsPage,
  multiplayerPage,
];

function registerPages() {
  for (const page of PAGES) {
    if (typeof page.render === 'function') router.register(page.id, page);
    else router.register(page.id, pendingPage(page.id, page.title));
  }
}

/* ------------------------------ 降级提示 ------------------------------ */

let degradedShown = false;

function showDegraded(reason) {
  degradedShown = true;
  setConnected(false, reason);
  const text =
    reason === '未连接到主进程' ? '未连接到主进程 · 界面正在显示内置示例数据' : `主进程暂不可用：${reason}`;
  banner(text, 'warn', { id: 'degraded', timeout: 0 });
}

/**
 * ★★★ 2026-11-05 修（验证脚本截图里发现：正常连上主进程时标题栏也写着「未连接到主进程」）。
 *
 * 根因：`clearDegraded()` 以前第一行就是 `if (!degradedShown) return;`
 *   —— 启动顺利、根本没降级过时，它直接返回，**永远执行不到 `setConnected(true)`**。
 *   而 `state.connected` 的初值是 false ⇒ 标题栏与「示例模式」徽标一直显示成未连接。
 *   （`clearDegraded` 唯一的调用点是「已连接」分支，所以无条件置 true 是安全的。）
 */
function clearDegraded() {
  degradedShown = false;
  closeBanner('degraded'); // 没有这条 banner 时是空操作
  setConnected(true);
}

/* ------------------------------ 启动 ------------------------------ */

async function main() {
  setMockEmitter(emitLocal);
  const bridged = initBridge();

  setDegradedHandler((reason) => {
    showDegraded(reason);
  });

  registerPages();
  initTitlebar();
  initLeftNav();
  initRightPanel();
  wireLeftNav();

  // 左栏高亮跟随页面切换
  document.addEventListener('qcl:page', (e) => {
    const id = e.detail && e.detail.id;
    if (id) highlightNav(id);
  });

  // 窗口阴影边距（最大化时主进程会推 inset = 0）
  on('win:state', (payload) => {
    if (payload && payload.inset != null) applyInset(payload.inset);
  });
  const winState = await call('win:state');
  if (winState.data && winState.data.inset != null) applyInset(winState.data.inset);

  // 数据 + 主题
  await bootstrap();
  wireStoreEvents();

  /**
   * ★ Java 检测预热（2026-11-05）。
   *
   * java.detect() 要扫注册表 + 逐个跑 `java -version`，实测约 5 秒。
   * 如果等用户点「启动游戏」时才跑，用户会感觉「点完半天没反应」。
   * ⇒ 界面加载完成后在后台先跑一次，结果缓存 5 分钟，之后点启动就是瞬时。
   *   故意不 await：绝不能让预热拖慢界面显示。
   */
  call('java:list').catch(() => {
    /* 预热失败不影响功能 */
  });

  /**
   * ★★★ 关键：initRightPanel() 在第 118 行就执行了，而 bootstrap() 在 135 行。
   *   ⇒ 右栏第一次渲染时 state.accounts 还是空数组，于是显示「还没有账号」+ 默认头像。
   *   ⇒ bootstrap() 里的 notify('bootstrap') 发生在 subscribe() **之前**，这次通知没人接。
   *   结果：账号数据明明已经加载好了，右栏却永远停在「还没有账号」，
   *        头像也永远显示内置 ic_steve.png（用户实测：「头像显示不出来」的直接原因）。
   *   ⇒ 这里在数据就绪后强制刷新一次。
   */
  updateRightPanel();

  subscribe(() => {
    updateRightPanel();
    updateTitleStatus();
  });

  // 主进程可用性 → 顶部提示
  if (bridged && isConnected()) clearDegraded();
  else if (!hasMain()) showDegraded('未连接到主进程');

  // 首页
  const content = document.getElementById('content');
  await router.start(content, 'home');

  // 调试钩子：自测脚本用它切页面、看状态（只在渲染层可见，不暴露任何主进程能力）
  window.__qclDebug = {
    navigate: (id, params) => router.navigate(id, params || {}),
    back: () => router.back(),
    goHome: () => router.goHome(),
    current: () => router.currentPageId(),
    state,
  };

  // 隐藏启动闪屏
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('is-hidden');
    setTimeout(() => splash.remove(), 320);
  }

  // 延迟复查一次连接状态（core 有可能稍后就绪）
  if (!isConnected()) {
    setTimeout(async () => {
      const r = await call('app:info');
      if (r.ok) clearDegraded();
    }, 3000);
  }
}

/* ------------------------------ 兜底 ------------------------------ */

window.addEventListener('error', (e) => {
  console.error('[QCL] 未捕获异常：', e.error || e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[QCL] 未处理的 Promise 异常：', e.reason);
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  if (/主进程|未就绪|IPC|invoke/i.test(msg)) toast(msg, 'error', 6000);
});

main().catch((err) => {
  console.error('[QCL] 启动失败：', err);
  const splash = document.getElementById('splash');
  if (splash) {
    setHTML(splash, html`<div class="splash__text">界面启动失败：${err && err.message ? err.message : String(err)}</div>`);
  }
});
