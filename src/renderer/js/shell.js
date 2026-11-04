/**
 * QCL 电脑版 · 外壳（自绘标题栏 + 左常驻图标栏 + 右常驻栏）
 *
 * 照安卓版 1.5.x 新排版：
 *   · 左栏 64px、图标垂直等分（绝不出现滚动条）、选中态高亮块
 *   · 中央内容区可切换页面，左栏与右栏**常驻不消失**
 *   · 右栏账号区垂直居中；底部「版本行 + 启动游戏」同宽同高、圆角半透明
 */

import { call, on } from './bridge.js';
import { icon, maskIcon } from './icons.js';
import { state, currentInstance, currentAccount, setCurrentInstance, notify } from './store.js';
import * as router from './router.js';
import { html, raw, setHTML, toast } from './ui.js';
import { faceFromSkin, loadImage } from './avatar.js';

/* ------------------------------ 左栏定义 ------------------------------ */

/**
 * 左栏常驻导航。
 *
 * ★ 相对安卓版做了四处「PC 化」：
 *   1. **移除「JAR 启动」** —— 手机上它是「选一个 jar 用内置 Java 跑」，
 *      PC 上双击 jar / 用实例启动就够了，留着纯属重复且容易误导。
 *   2. **移除「上次启动日志」** —— 日志与崩溃分析已经并入「工具」页
 *      （工具 → 崩溃日志分析 / 打开日志目录），侧边栏不再需要单独入口。
 *   3. **「实验室」改名「工具」** —— 手机上的实验小工具（合成表查询等）
 *      PC 上有更好的外部方案；换成 PC 用户真正需要的：
 *      实例文件夹 / 崩溃日志分析 / 实例备份。
 *   4. 保留主页 / 当前版本设置 / 版本列表 / 下载 / 多人联机 / 设置 / 返回。
 */
const NAV_ITEMS = [
  { id: 'home', tip: '主页', kind: 'svg', glyph: 'home' },
  { id: 'versionsetting', tip: '当前版本设置', kind: 'mask', glyph: 'versionsetting' },
  { id: 'versionlist', tip: '版本列表', kind: 'svg', glyph: 'versionlist' },
  { id: 'download', tip: '下载', kind: 'svg', glyph: 'download' },
  { id: 'tools', tip: '工具', kind: 'mask', glyph: 'lab' },
  { id: 'mods', tip: '模组管理', kind: 'svg', glyph: 'pack' },
  { id: 'multiplayer', tip: '多人联机', kind: 'svg', glyph: 'multiplayer' },
  { id: 'setting', tip: '设置', kind: 'svg', glyph: 'setting' },
  { id: 'back', tip: '返回上一层', kind: 'svg', glyph: 'back', back: true },
];

let navEl = null;
let accountEl = null;
let versionEl = null;
let launchEl = null;
let titleStatusEl = null;
let maximizeBtn = null;
let launchBusy = false;
let winMaximized = false;

/* ------------------------------ 标题栏 ------------------------------ */

export function initTitlebar() {
  const min = document.getElementById('win-min');
  const max = document.getElementById('win-max');
  const close = document.getElementById('win-close');
  titleStatusEl = document.getElementById('titlebar-status');

  setHTML(min, icon('minimize', 14));
  setHTML(max, icon('maximize', 14));
  setHTML(close, icon('close', 14));
  maximizeBtn = max;

  min.addEventListener('click', () => call('win:minimize'));
  max.addEventListener('click', () => call('win:toggleMaximize'));
  close.addEventListener('click', () => call('win:close'));

  // 双击标题栏空白处 = 切换最大化（Windows 习惯）
  const drag = document.querySelector('.titlebar__drag');
  if (drag) {
    drag.addEventListener('dblclick', () => call('win:toggleMaximize'));
  }

  on('win:state', (payload) => {
    winMaximized = !!(payload && payload.maximized);
    setHTML(maximizeBtn, icon(winMaximized ? 'restore' : 'maximize', 14));
    maximizeBtn.title = winMaximized ? '向下还原' : '最大化';
  });

  updateTitleStatus();
}

export function updateTitleStatus() {
  if (!titleStatusEl) return;
  if (!state.connected && state.ready) {
    setHTML(titleStatusEl, html`未连接到主进程`);
    return;
  }
  const inst = currentInstance();
  const acct = currentAccount();
  const parts = [];
  if (acct) parts.push(acct.name);
  if (inst) parts.push(inst.name);
  setHTML(titleStatusEl, parts.join(' · ') || '');
}

/* ------------------------------ 左栏 ------------------------------ */

export function initLeftNav() {
  navEl = document.getElementById('leftnav');
  renderLeftNav(router.currentPageId());
  document.addEventListener('qcl:page', (e) => {
    const id = e.detail && e.detail.id;
    // 「版本设置」页面在左栏对应 versionsetting 这一格
    highlightNav(id);
  });
}

export function renderLeftNav(activeId) {
  if (!navEl) return;
  const markup = NAV_ITEMS.map((item) => {
    const glyph =
      item.kind === 'mask' ? maskIcon(item.glyph, 24, 'navbtn__mask') : `<span class="navbtn__icon">${icon(item.glyph, 24)}</span>`;
    return html`<button class="navbtn ${item.back ? 'navbtn--back' : ''}" type="button" data-nav="${item.id}" data-tip="${item.tip}" aria-label="${item.tip}">
      ${raw(glyph)}
    </button>`;
  }).join('');
  setHTML(navEl, markup);
  highlightNav(activeId);
}

export function highlightNav(activeId) {
  if (!navEl) return;
  const id = activeId === 'versionsetting' ? 'versionsetting' : activeId;
  navEl.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === id);
  });
  // 「返回」在没有上一层时置灰
  const backBtn = navEl.querySelector('[data-nav="back"]');
  if (backBtn) backBtn.classList.toggle('is-disabled', !router.canGoBack());
}

/** 左栏点击（事件委托，只绑一次） */
export function wireLeftNav() {
  navEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn || !navEl.contains(btn)) return;
    const id = btn.dataset.nav;
    if (id === 'back') {
      if (!router.canGoBack()) {
        router.goHome();
        return;
      }
      router.back();
      return;
    }
    if (id === 'versionsetting') {
      const inst = currentInstance();
      if (!inst) {
        toast('还没有任何实例，先去「下载」装一个版本', 'warn');
        router.navigate('download');
        return;
      }
      router.navigate('versionsetting', { instanceId: inst.id });
      return;
    }
    // 其余（home / versionlist / download / tools / log / multiplayer / setting）直接路由
    router.navigate(id);
  });
}

/* ------------------------------ 右常驻栏 ------------------------------ */

export function initRightPanel() {
  const el = document.getElementById('rightpanel');
  setHTML(
    el,
    html`<button class="account" id="account-btn" type="button" title="账号管理">
        <span class="account__avatar"><img id="account-avatar" alt="账号头像" src="./assets/icon/ic_steve.png" /></span>
        <span class="account__name" id="account-name">还没有账号</span>
        <span class="account__state" id="account-state">点击这里添加</span>
      </button>
      <div class="rightpanel__bottom">
        <div class="block" id="version-row" role="button" tabindex="0" title="点击进入版本列表">
          <img class="block__icon" id="version-icon" alt="" src="./assets/icon/ic_grass.png" />
          <span class="block__text" id="version-text">还没有实例</span>
        </div>
        <button class="block block--primary" id="launch-btn" type="button">启动游戏</button>
      </div>`
  );

  accountEl = document.getElementById('account-btn');
  versionEl = document.getElementById('version-row');
  launchEl = document.getElementById('launch-btn');
  titleStatusEl = document.getElementById('titlebar-status');

  accountEl.addEventListener('click', () => router.navigate('accounts'));
  versionEl.addEventListener('click', () => router.navigate('versionlist'));
  versionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      router.navigate('versionlist');
    }
  });
  launchEl.addEventListener('click', () => launchCurrent());

  on('launch:state', (payload) => {
    if (!payload) return;

    /**
     * ★★★ 2026-11-05 修（用户实测「点了启动就显示退出码 1，游戏其实起来了」）。
     *
     * `payload.code` 实际是 **`{ code, signal, state }` 对象**（主进程 child.on('exit') 的回调参数
     * 原样透传过来的），不是数字。
     * 以前写成 `payload.code == null ? '未知' : payload.code` ——
     * 对象永远不为 null，插值成 `[object Object]`；
     * `payload.code === 0` 也永远 false ⇒ 一律当成异常。
     * 用户看到的就是「提示一堆看不懂的东西 + 明明是正常退出也报错」。
     * ⇒ 现在先归一成数字，signal 为 null 且 code 为 0 才算正常退出。
     */
    if (payload.state === 'exited') {
      launchBusy = false;
      updateRightPanel();

      /**
       * ★ 游戏退出后把启动器窗口显示回来（配合 game-ready 时的 win:hide）。
       *   以前启动器一直开着，玩家关游戏后要自己切回来；
       *   现在收起过的话这里必须还原，否则玩家会以为启动器没了。
       */
      call('win:show').catch(() => {
        /* 没收起过也无害 */
      });

      const raw = payload.code;
      const codeNum =
        typeof raw === 'number'
          ? raw
          : raw && typeof raw === 'object' && typeof raw.code === 'number'
            ? raw.code
            : null;
      const wasKilled =
        (raw && typeof raw === 'object' && !!raw.signal) || (typeof raw === 'number' && raw < 0);

      if (codeNum === null) {
        toast('游戏进程已结束（未拿到退出码）', 'warn', 3200);
      } else if (codeNum === 0) {
        toast('游戏已正常退出', 'ok', 2400);
      } else {
        toast(
          wasKilled ? `游戏进程被结束（退出码 ${codeNum}）` : `游戏异常退出（退出码 ${codeNum}），可到「工具 → 崩溃日志分析」查看原因`,
          codeNum === 0 ? 'ok' : 'warn',
          5200
        );
      }
    }
  });

  updateRightPanel();
}

/**
 * 把「从皮肤裁出的脸」画到右栏头像上（照安卓版 Avatar.setAvatar 的思路）。
 * 永远有兜底：拿不到皮肤就用程序化 Steve 脸，绝不留空白。
 */
/**
 * 把「从皮肤裁出的脸」画到右栏头像上。
 *
 * ★★★ 关键修复（用户实测「头像显示不出来 / 看起来像 AI 乱 P 的」）：
 *   ① 必须把 deps.readSkin 传进去，否则本地皮肤文件读不到；
 *   ② 微软账号的 avatar 是 `http://textures.minecraft.net/...`，
 *      页面 CSP 的 img-src 只放了 https，http 会被拦 ⇒ 走 `skin:readRemote` 主进程代理下载，
 *      转成 data: URL 再裁脸。
 *   ③ 裁脸用的是真实皮肤（坐标 8,8 + 帽子层 40,8），不再程序化画像素。
 */
async function paintAvatar(imgEl, account) {
  if (!imgEl) return;

  /** 让主进程把本地文件 / 远程 http 图片都变成 data URL */
  const readSkin = async (filePath) => {
    try {
      const r = await call('accounts:readSkin', { path: filePath });
      return (r && r.data && r.data.dataUrl) || null;
    } catch {
      return null;
    }
  };
  const readRemote = async (url) => {
    try {
      const r = await call('skin:readRemote', { url });
      return (r && r.data && r.data.dataUrl) || null;
    } catch {
      return null;
    }
  };

  try {
    if (!account) {
      // 没有账号：内置 Steve 头像
      imgEl.src = './assets/icon/ic_steve.png';
      return;
    }

    let dataUrl = null;

    // ① 本地自定义皮肤
    if (account.skinFile) {
      const skinData = await readSkin(account.skinFile);
      if (skinData) {
        const img = await loadImage(skinData);
        if (img) dataUrl = faceFromSkin(img);
      }
    }

    // ② 微软账号皮肤（http → 主进程代理）
    if (!dataUrl && account.avatar) {
      const skinData = await readRemote(account.avatar);
      if (skinData) {
        const img = await loadImage(skinData);
        if (img) dataUrl = faceFromSkin(img);
      }
    }

    // ③ 兜底：内置 Steve 头像（安卓版原图，不是程序化画的）
    imgEl.src = dataUrl || './assets/icon/ic_steve.png';
    imgEl.onerror = () => {
      imgEl.onerror = null;
      imgEl.src = './assets/icon/ic_steve.png';
    };
  } catch {
    imgEl.src = './assets/icon/ic_steve.png';
  }
}

export function updateRightPanel() {
  const inst = currentInstance();
  const acct = currentAccount();

  const nameEl = document.getElementById('account-name');
  const stateEl = document.getElementById('account-state');
  const avatarEl = document.getElementById('account-avatar');
  if (nameEl && stateEl && avatarEl) {
    if (acct) {
      setHTML(nameEl, html`${acct.name}`);
      const typeLabel = acct.type === 'microsoft' ? '微软正版账号' : '离线账号';
      const expired = acct.expiresAt && acct.expiresAt < Date.now();
      setHTML(stateEl, html`${expired ? '登录已过期，点击重新登录' : typeLabel}`);
      /**
       * ★★★ 头像必须「从皮肤裁脸」，不能直接拿整张皮肤图当头像。
       *   之前写的是 `avatarEl.src = acct.avatar` —— acct.avatar 是一整张 64×64 皮肤，
       *   塞进 64px 圆框里就是一团看不出人脸的色块；离线账号该字段还是 null，
       *   直接回落成 ic_steve.png（一张图标，不是脸）。
       *   ⇒ 现在统一走 avatarForAccount()：裁 8×8 脸 + 帽子层放大，最差也是程序化 Steve 脸。
       */
      paintAvatar(avatarEl, acct);
    } else {
      setHTML(nameEl, '还没有账号');
      setHTML(stateEl, '点击这里添加');
      paintAvatar(avatarEl, null);
    }
  }

  const textEl = document.getElementById('version-text');
  const iconEl = document.getElementById('version-icon');
  if (textEl && iconEl) {
    if (inst) {
      const suffix = inst.loader && inst.loader.type !== 'vanilla' ? ` · ${inst.loader.type}` : '';
      setHTML(textEl, html`${inst.name}${suffix}`);
    } else {
      setHTML(textEl, '还没有实例');
    }
    iconEl.src = './assets/icon/ic_grass.png';
  }

  if (launchEl) {
    launchEl.disabled = launchBusy;
    launchEl.classList.toggle('is-busy', launchBusy);
    // ★ PC 版的按钮文案反映**真实进程状态**，不是手机那种「正在等待」：
    //   空闲 → 启动游戏；进程活着 → 运行中（再点可提示去任务管理器/或后续接 kill）
    setHTML(launchEl, launchBusy ? '游戏运行中' : '启动游戏');
  }
  updateTitleStatus();
}

/* ------------------------------ 启动游戏 ------------------------------ */

/**
 * 把「正在启动」窗口接到主进程事件上。
 *
 * ★ 抽成独立函数（而不是塞在 launchCurrent 里）有两个原因：
 *   ① 生产路径不变：launchCurrent 仍然调它，订阅逻辑只有这一份；
 *   ② 能被自测脚本直接调用 —— `build/verify-download-ui.js` 用它验证
 *      「running 不关窗 / game-ready 才关窗 / 90 秒超时只改文案」，不必真的启动一个游戏。
 *
 * @param {object} lw launchwindow 模块
 * @param {string} instanceId 当前实例 id（事件里 p.id 与它不符就忽略）
 * @param {{readyTimeoutMs?: number}} [options] 超时兜底毫秒数（默认 90 秒，自测可调小）
 * @returns {() => void} 退订函数
 */
export function wireLaunchWindowEvents(lw, instanceId, options = {}) {
  const readyTimeoutMs = Number(options.readyTimeoutMs) > 0 ? Number(options.readyTimeoutMs) : 90000;
  let offStage = null;
  let offState = null;
  let offLog = null;
  let offReady = null;
  /** 收尾：把这轮所有订阅退掉（否则每启动一次就多叠 4 个监听，日志会重复刷） */
  const cleanupSubs = () => {
    for (const fn of [offStage, offLog, offState, offReady]) {
      if (typeof fn === 'function') fn();
    }
    offStage = offLog = offState = offReady = null;
  };
  if (!lw) return cleanupSubs;

  offStage = on('launch:stage', (p) => {
    if (!p || p.id !== instanceId) return;
    lw.markStage(p.key, p.detail);
  });
  // 日志最后一行显示在窗口底部，让用户看到「真的在动」
  offLog = on('launch:log', (p) => {
    if (!p || p.id !== instanceId) return;
    lw.pushLogLine(p.line);
  });
  /**
   * ★★★ 2026-11-05 修（用户原话：「点击启动游戏后显示的等待小窗口，根本就没有真正地在等待
   * 游戏启动，游戏都还没启动出来，那个窗口就消失了」）。
   *
   * 以前这里收到 `launch:state === 'running'` 就 `finishLaunch(true)` ——
   * 但 running 只代表 **Java 进程刚 spawn 出来**，游戏主窗口/主菜单还在加载。
   * 于是窗口在游戏画面出来之前就消失了，用户当然觉得「它根本没等」。
   *
   * ⇒ 现在把两件事拆开：
   *   ① `running`      → 只把「等待游戏窗口」这一步点亮（进程已起，PID 告诉用户），**不关窗**；
   *   ② `launch:game-ready`（后端在游戏真正进入主界面/渲染出画面时推送）→ 才 finishLaunch(true)；
   *   ③ 中间如果进程提前退出（崩溃/被结束）→ 报失败，不让窗口傻等。
   */
  offState = on('launch:state', (p) => {
    if (!p || p.id !== instanceId) return;
    if (p.state === 'running') {
      lw.markStage('running', `游戏进程已启动（PID ${p.pid}），正在等待游戏画面…`);
      // ★ 只记阶段，绝不关窗
    } else if (p.state === 'error') {
      lw.clearLoadingWarning();
      lw.finishLaunch(false, p.message || '启动失败');
      cleanupSubs();
    } else if (p.state === 'exited') {
      // 还没等到 game-ready 进程就退了 ⇒ 是崩溃/失败，窗口不能继续等
      const rawCode = p.code;
      const codeNum =
        typeof rawCode === 'number'
          ? rawCode
          : rawCode && typeof rawCode === 'object' && typeof rawCode.code === 'number'
            ? rawCode.code
            : null;
      lw.clearLoadingWarning();
      lw.finishLaunch(false, `游戏进程在进入主界面前退出${codeNum === null ? '' : `（退出码 ${codeNum}）`}，可到「工具 → 崩溃日志分析」查看原因`);
      cleanupSubs();
    }
  });
  // ③ 游戏真正就绪：这才是关窗的唯一成功信号
  offReady = on('launch:game-ready', (p) => {
    if (!p || (p.id && p.id !== instanceId)) return;
    lw.clearLoadingWarning();
    if (typeof p.elapsedMs === 'number' && p.elapsedMs >= 0) {
      lw.pushLogLine(`游戏已就绪（用时 ${(p.elapsedMs / 1000).toFixed(1)} 秒）`);
    }
    lw.markStage('running', '游戏已就绪，画面正在显示');
    lw.finishLaunch(true);
    cleanupSubs();

    /**
     * ★★★ 2026-11-05 实现「启动后收起启动器」（用户需求）。
     *
     * 用户原话：「启动玩游戏之后，应该把启动器关了，不占用游戏资源」，
     *          但同时也抱怨「连游戏窗口都没出现就把启动器关了」。
     * ⇒ 时机必须卡在 **game-ready 之后**（游戏画面真的出来了），这一点已由上面的逻辑保证。
     *
     * 为什么用「收起窗口」而不是退出进程：
     *   游戏是启动器 spawn 的子进程，stdio 是管道；父进程一退出管道就断，
     *   Minecraft 写日志时可能抛 IOException 直接崩掉。
     *   收起窗口已经能停止渲染、释放 GPU/CPU，达到「不占用游戏资源」的目的，
     *   而且游戏退出后还能自动把窗口显示回来。
     *
     * 玩家可在「设置 → 游戏」里把「游戏启动后保持启动器在前台」勾上，就会跳过这一步。
     */
    const keepOpen = !!(state && state.settings && state.settings.game && state.settings.game.keepLauncherOpen);
    if (!keepOpen) {
      // 等启动窗口自己关掉（finishLaunch 有 1.2s 动画）再收起，避免用户看到"闪一下"
      setTimeout(() => {
        call('win:hide').catch(() => {
          /* 收起失败不影响游戏 */
        });
      }, 1400);
    }
  });
  // ④ 超时兜底：90 秒还没 ready 就把小字改成「仍在加载…（已等待 90 秒）」，但**绝不关窗**
  lw.armLoadingWarning(readyTimeoutMs);
  return cleanupSubs;
}

export async function launchCurrent(instanceId = null) {
  if (launchBusy) return;
  const inst = instanceId ? state.instances.find((x) => x.id === instanceId) : currentInstance();
  if (!inst) {
    toast('还没有任何实例，先去「下载」装一个版本', 'warn');
    router.navigate('download');
    return;
  }
  if (state.accounts.length === 0) {
    toast('还没有账号，请先添加一个账号再启动', 'warn');
    router.navigate('accounts');
    return;
  }
  if (instanceId) setCurrentInstance(instanceId);

  /* ------------------------------------------------------------------
   * 启动：一次点击 → 立刻弹出「正在启动」窗口 → 逐步显示阶段
   *
   * ★ 2026-11-05 改（用户反馈）：
   *   ① 「HMCL 都不需要连续点两次启动游戏」⇒ 去掉了启动前确认弹窗，点一次就启动；
   *   ② 「正在执行的启动窗口要跟它一起出现」⇒ 启动窗口在调用 IPC 之前就画出来；
   *   ③ 「步骤还很少」⇒ 后端推 6 个阶段，界面逐步打勾。
   *   `launch:start` 已改成不 await，IPC 立即返回，所以窗口是**真·立刻**出现。
   * ------------------------------------------------------------------ */
  launchBusy = true;
  updateRightPanel();

  // ① 先把「正在启动」窗口画出来（不等任何网络/IPC）
  let lw = null;
  try {
    lw = await import('./launchwindow.js');
    lw.openLaunchWindow({
      instance: inst,
      extra: [inst.mcVersion, inst.loader && inst.loader.type !== 'vanilla' ? inst.loader.type : ''].filter(Boolean).join(' · ')
    });
  } catch (err) {
    console.warn('[QCL] 启动窗口加载失败（不影响启动）：', err);
    lw = null;
  }

  // ② 订阅阶段进度 / 日志 / 进程状态 / 游戏就绪（在主进程推之前就挂好，避免丢事件）
  const cleanupSubs = wireLaunchWindowEvents(lw, inst.id);

  // ③ 启动（IPC 立刻返回 starting:true，真正的启动在后台跑）
  const r = await call('launch:start', { id: inst.id });
  if (!r.ok) {
    launchBusy = false;
    updateRightPanel();
    if (lw) {
      lw.clearLoadingWarning();
      lw.finishLaunch(false, r.error || '启动失败');
    }
    cleanupSubs();
    toast(r.error || '启动失败', 'error', 6000);
    return;
  }

  // ④ 允许在窗口里点「取消启动」
  if (lw && typeof lw.setCancelHandler === 'function') {
    lw.setCancelHandler(() => {
      call('launch:kill', { id: inst.id }).catch(() => {});
      toast('已请求取消启动', 'warn', 2200);
    });
  }

  // 后台检查只用于「有风险时提示」，不拦启动
  call('launch:precheck', { id: inst.id })
    .then((pre) => {
      if (!pre || !pre.ok || !pre.data) return;
      const issues = Array.isArray(pre.data.issues) ? pre.data.issues : [];
      const errors = issues.filter((i) => i.level === 'error');
      const warns = issues.filter((i) => i.level === 'warn');
      /**
       * ★ 空值保护（用户实测「右下角弹出空提示框」）：
       *   `i.title` 后端可能没填 ⇒ 插值出空串/undefined，就会弹出一个 200px 的空盒子。
       *   这里给每级都兜一句中文，绝不把空串交给 toast。
       */
      const firstMsg = (arr, fallback) => {
        const t = arr.length && arr[0] && arr[0].title ? String(arr[0].title).trim() : '';
        return t || fallback;
      };
      if (errors.length) {
        toast(`提示：${firstMsg(errors, '启动前检查发现问题')}`, 'warn', 8000);
      } else if (warns.length) {
        toast(firstMsg(warns, '启动前有需要注意的项，可到「工具」里查看'), 'warn', 6000);
      }
    })
    .catch(() => {
      /* 检查失败不影响启动 */
    });

  /**
   * ★ PC 版不做「正在等待」页面。
   *
   * 手机上点启动会全屏切到一个等待界面（Java 初始化慢、还要建 Surface），
   * PC 上窗口是独立进程，启动通常一两秒就出游戏窗口 —— 再弹全屏等待反而碍事。
   * ⇒ 这里只做两件事：
   *   1. 右栏按钮进入「已启动」状态（真实反映 launch:state 事件）；
   *   2. 一条短提示说明「游戏窗口马上出来」，**不跳转页面**，用户留在原处。
   */
  toast(`已启动「${inst.name}」，游戏窗口稍后出现`, 'ok', 2600);

  // 启动成功后按钮保持「运行中」状态，直到 launch:state 报 exited 才复位
  launchBusy = true;
  updateRightPanel();
}

/** 状态变化时刷新右栏 */
export function refreshShell() {
  updateRightPanel();
  notify('shell');
}
