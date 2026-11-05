/**
 * Quanta Craft Launcher PC · 「正在启动」窗口
 *
 * ## 用户的诉求（原话）
 *   「点击启动游戏，那个正在执行启动的窗口要跟它一起出现，显示正在启动的步骤之类的。
 *     而且我们的步骤还很少，没有 HMCL 这么多。
 *     而且点完之后那个窗口半天才响应。」
 *
 * ## 对应做法
 *   ① **点一下立刻出现**：`launch:start` 已改成不 await（IPC 立即返回），
 *      窗口在调用它的**同时**就渲染出来，不再等整个启动流程。
 *   ② **步骤更多、更细**：后端 launch.js 现在会推 6 个阶段：
 *        解析版本信息 → 检查游戏文件 → 检测 Java 运行时 →
 *        组装 classpath → 启动 Java 进程 → 等待游戏窗口
 *      窗口按顺序打勾，当前步骤转圈。
 *   ③ **不打断用户**：窗口是卡片式浮层，可以「隐藏到后台」继续玩别的，
 *      也可以「取消启动」（会杀掉还没起来的进程）。
 *
 * ## 与 HMCL 的差异（不照抄）
 *   HMCL 用的是 JavaFX 的 TaskExecutorDialogPane：上方一串任务行、底部一个取消按钮。
 *   我们做成：左侧转圈大图标 + 右侧步骤清单（每步有耗时）+ 底部实时日志最后一行。
 *   额外多一个「本次启动参数」小字（Java 版本 / 内存 / 窗口大小），
 *   让用户在等待时就知道自己用的是什么配置。
 */

import { html, raw, setHTML } from './ui.js';
import { icon } from './icons.js';

/** 与后端 launch.js 的 stage key 一一对应；顺序即显示顺序 */
const STAGES = [
  { key: 'resolve', label: '解析版本信息', hint: '读取版本 JSON 与继承链' },
  { key: 'check', label: '检查游戏文件', hint: '客户端 jar / 依赖库 / 资源索引' },
  { key: 'java', label: '检测 Java 运行时', hint: '挑选与版本匹配的 Java' },
  { key: 'classpath', label: '组装 classpath', hint: '依赖库路径与资源目录' },
  { key: 'account', label: '校验账号与令牌', hint: '微软正版会在这里自动刷新登录' },
  { key: 'spawn', label: '启动 Java 进程', hint: '传入 JVM 与游戏参数' },
  { key: 'running', label: '等待游戏窗口', hint: '进程已启动，正在加载游戏' }
];

let panelEl = null;
let stateMap = new Map(); // key -> 'pending' | 'active' | 'done'
let startedAt = 0;
let stageAt = new Map();
/** 每个阶段的完成时刻（用来算「本阶段耗时」，而不是从启动到现在的总耗时） */
let stageDoneAt = new Map();
let lastLogLine = '';
let hideTimer = null;
/** 「还在加载」提醒的定时器（开窗后 90 秒还没等到 game-ready 就提示，但**绝不关窗**） */
let warnTimer = null;
/** 累计等待时长（毫秒），用于提醒文案；多次提醒会累加 */
let waitedMs = 0;

/** 打开「正在启动」窗口（立刻显示，不等任何 await） */
export function openLaunchWindow({ instance, extra }) {
  closeLaunchWindow();

  startedAt = Date.now();
  stateMap = new Map(STAGES.map((s) => [s.key, 'pending']));
  stageAt = new Map();
  stageDoneAt = new Map();
  lastLogLine = '';
  waitedMs = 0;
  if (warnTimer) {
    clearTimeout(warnTimer);
    warnTimer = null;
  }

  const root = document.getElementById('modal-root');
  if (!root) return null;

  root.hidden = false;
  root.innerHTML = '';

  panelEl = document.createElement('div');
  panelEl.className = 'modal modal--launching';
  panelEl.setAttribute('role', 'dialog');
  panelEl.innerHTML = `
    <div class="modal__head">
      <div class="modal__title">正在启动 ${escapeHtml(instance && instance.name ? instance.name : '')}</div>
    </div>
    <div class="modal__body">
      <div class="lw">
        <div class="lw__spinner" aria-hidden="true">
          <div class="lw__ring"></div>
        </div>
        <div class="lw__main">
          <ul class="lw__stages" id="lw-stages"></ul>
          <div class="lw__meta" id="lw-meta">${extra ? escapeHtml(extra) : ''}</div>
          <div class="lw__log" id="lw-log"></div>
        </div>
      </div>
    </div>
    <div class="modal__foot">
      <button class="btn btn--ghost" data-act="hide" type="button">隐藏到后台</button>
      <button class="btn btn--ghost" data-act="cancel" type="button">取消启动</button>
    </div>`;

  root.appendChild(panelEl);
  renderStages();

  panelEl.querySelector('[data-act="hide"]').addEventListener('click', () => {
    // 隐藏：只把窗口收起来，启动继续跑（回到右栏看按钮状态）
    closeLaunchWindow();
  });
  panelEl.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    if (typeof panelEl._onCancel === 'function') panelEl._onCancel();
    closeLaunchWindow();
  });

  return panelEl;
}

/** 标记某阶段开始（后面的自动置回 pending） */
export function markStage(key, detail) {
  if (!panelEl || !stateMap.has(key)) return;
  const now = Date.now();
  let reached = false;
  for (const s of STAGES) {
    if (s.key === key) {
      stateMap.set(s.key, 'active');
      stageAt.set(s.key, now);
      reached = true;
    } else if (!reached && stateMap.get(s.key) !== 'done') {
      // ★ 阶段是顺序推进的：上一个阶段在这一刻「完成」，记下来才能算它自己的耗时
      stateMap.set(s.key, 'done');
      if (!stageDoneAt.has(s.key)) stageDoneAt.set(s.key, now);
    } else if (reached && stateMap.get(s.key) === 'active') {
      stateMap.set(s.key, 'pending');
    }
  }
  if (detail) setMeta(detail);
  renderStages();
}

/** 全部完成（游戏窗口出来了） */
export function finishLaunch(ok, message) {
  if (!panelEl) return;
  clearLoadingWarning();
  const finNow = Date.now();
  for (const s of STAGES) {
    if (ok) {
      if (stateMap.get(s.key) !== 'done' && !stageDoneAt.has(s.key)) {
        if (!stageAt.has(s.key)) stageAt.set(s.key, finNow);
        stageDoneAt.set(s.key, finNow);
      }
      stateMap.set(s.key, 'done');
    }
  }
  renderStages();
  if (!ok) setMeta(message || '启动失败', true);
  // 成功后 1.2 秒自动关掉，不挡着用户看游戏
  if (ok) {
    hideTimer = setTimeout(() => closeLaunchWindow(), 1200);
  }
}

/** 更新底部最后一行日志 */
export function pushLogLine(line) {
  lastLogLine = String(line || '').slice(0, 200);
  const el = document.getElementById('lw-log');
  if (el) el.textContent = lastLogLine;
}

/**
 * 启动「还在加载」提醒：开窗后 `ms` 毫秒内没收到 game-ready，就把 meta 文案改成
 * 「仍在加载…（已等待 N 秒）」，**但不关窗**（用户明确要求：窗口要真的等到游戏出来）。
 *
 * ★ 为什么提醒要多次循环：游戏首次启动可能因为校验资源、解压 natives 而超过 90 秒，
 *   一次提醒之后如果又卡了 90 秒，用户会以为界面死了。所以每 90 秒刷新一次已等待秒数。
 */
export function armLoadingWarning(ms = 90000) {
  clearLoadingWarning();
  waitedMs = 0;
  const tick = () => {
    if (!panelEl) return;
    waitedMs += ms;
    const secs = Math.round(waitedMs / 1000);
    setMeta(`仍在加载…（已等待 ${secs} 秒）`);
    warnTimer = setTimeout(tick, ms);
  };
  warnTimer = setTimeout(tick, ms);
}

/** 收到 game-ready / 失败 / 关窗时清掉提醒定时器 */
export function clearLoadingWarning() {
  if (warnTimer) {
    clearTimeout(warnTimer);
    warnTimer = null;
  }
}

/** 设置小字（本次启动参数 / 错误信息 / 等待提醒）—— 对外导出，供 shell.js 与自测脚本使用 */
export function setMeta(text, isError) {
  const el = document.getElementById('lw-meta');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!isError);
}

/** 重画步骤列表 */
function renderStages() {
  const el = document.getElementById('lw-stages');
  if (!el) return;
  const now = Date.now();
  el.innerHTML = STAGES.map((s) => {
    const st = stateMap.get(s.key) || 'pending';
    // 第一个阶段（解析版本信息）可能没有显式 markStage，用 startedAt 兜底，否则那一行耗时永远空着
    const t = stageAt.get(s.key) || (st === 'done' ? startedAt : 0);
    /**
     * ★ 2026-11-05 修（用户截图：所有步骤都显示 5.6s）。
     *
     * 以前这里算的是 `Date.now() - startedAt` —— 也就是**从启动那一刻到现在的总耗时**，
     * 于是最后重画时每一行拿到的是同一个数字，看起来像每一阶段都花了 5.6 秒。
     *
     * 现在改成**每个阶段自己的耗时**：
     *   · done：完成时刻（下一个阶段开始的时刻，或最后一次 flush） − 本阶段开始时刻
     *   · active：从本阶段开始到现在（实时跳）
     * 没有开始时刻的（一开始就是 done、被跳过）显示空。
     */
    let ms = '';
    if (t) {
      if (st === 'done') {
        const doneAt = stageDoneAt.get(s.key) || now;
        ms = `${(Math.max(0, doneAt - t) / 1000).toFixed(1)}s`;
      } else if (st === 'active') {
        ms = `${(Math.max(0, now - t) / 1000).toFixed(1)}s`;
      }
    }
    const iconHtml =
      st === 'done'
        ? '<span class="lw__tick">✓</span>'
        : st === 'active'
          ? '<span class="lw__dot"></span>'
          : '<span class="lw__hollow"></span>';
    return `<li class="lw__stage lw__stage--${st}">
      ${iconHtml}
      <span class="lw__label">${escapeHtml(s.label)}</span>
      <span class="lw__hint">${escapeHtml(s.hint)}</span>
      <span class="lw__time">${ms}</span>
    </li>`;
  }).join('');
}

/** 关闭窗口（不动启动流程） */
export function closeLaunchWindow() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  clearLoadingWarning();
  waitedMs = 0;
  panelEl = null;
  stateMap = new Map();
  const root = document.getElementById('modal-root');
  if (root && root.querySelector('.modal--launching')) {
    root.hidden = true;
    root.innerHTML = '';
  }
}

/** 窗口是否开着 */
export function isLaunchWindowOpen() {
  return !!panelEl;
}

/** 设置「取消启动」的处理函数 */
export function setCancelHandler(fn) {
  if (panelEl) panelEl._onCancel = fn;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
