/**
 * Quanta Craft Launcher PC · 启动前确认弹窗
 *
 * ## 为什么是这个样子
 * 用户要求：「HMCL 点击启动游戏之后第一个出现什么？你翻它代码看那些文字提示，
 *            我们也做一个类似的，但别和他窗口显示一模一样。」
 *
 * ## HMCL 的做法（读 LauncherHelper.java 得到）
 *   点启动 → 弹「启动中」进度窗（launchingStepsPane，TaskExecutorDialogPane）
 *          → 检查中发现问题时再插一个确认框，文字是 launch.advice.*：
 *            · launch.advice.multi：「检测到以下问题：…仍要继续启动吗？」
 *            · launch.advice.java.auto：「当前 Java 不兼容，点『是』自动挑最合适的」
 *            · launch.advice.not_enough_space：「分配内存超过物理内存」
 *            · launch.advice.too_large_memory_for_32bit：「32 位 Java 内存上限」
 *            · launch.advice.different_platform：「建议用 64 位 Java」
 *   缺点是「进度窗 + 建议框」会闪两下，而且用户不能在这里改内存。
 *
 * ## 我们的做法（不同点）
 *   **一个弹窗搞定**：
 *     ┌──────────────────────────────────────┐
 *     │ 启动 26.3                            │
 *     ├──────────────────────────────────────┤
 *     │ ⚠ 检测到 2 个问题                     │  ← 有问题才显示
 *     │   · 可用内存偏少（455 MB / 要 2048）  │
 *     │   · Java 版本过旧                     │
 *     │                                      │
 *     │ 本次启动参数（可直接改）              │
 *     │   Java   [Java 25 (x64) ▾]           │
 *     │   内存   [====●────] 2048 MB         │
 *     │   窗口   [854] × [480]               │
 *     │   账号   HaoGE201123（正版）          │
 *     │                                      │
 *     │ ☑ 记住这次的选择                      │
 *     ├──────────────────────────────────────┤
 *     │            [取消]      [启动游戏]     │
 *     └──────────────────────────────────────┘
 *   一次确认，顺带把「启动设置」也做了 —— 不用像 HMCL 那样再进设置页改内存。
 */

import { html, raw, toast } from './ui.js';
import { icon } from './icons.js';

/**
 * 弹出启动确认框。
 *
 * @param {object} info  launch:precheck 返回的 data
 * @param {object} opts  { onStart: (choices)=>void }
 * @returns {Promise<{started:boolean, choices?:object}>}
 */
export function showLaunchConfirm(info, opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve({ started: false });
      return;
    }

    const issues = Array.isArray(info.issues) ? info.issues : [];
    const errors = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warn');
    const infos = issues.filter((i) => i.level === 'info');

    const java = info.java;
    const memMb = Number(info.memoryMb) || 2048;
    const width = Number(info.launch && info.launch.width) || 854;
    const height = Number(info.launch && info.launch.height) || 480;

    const issueRow = (it) => {
      const iconChar = it.level === 'error' ? '✕' : it.level === 'warn' ? '⚠' : 'ℹ';
      return html`<li class="lc-issue lc-issue--${it.level}">
        <span class="lc-issue__mark">${iconChar}</span>
        <div class="lc-issue__body">
          <div class="lc-issue__title">${it.title}</div>
          ${it.detail ? html`<div class="lc-issue__detail">${it.detail}</div>` : raw('')}
          ${it.fix ? html`<div class="lc-issue__fix">建议：${it.fix}</div>` : raw('')}
        </div>
      </li>`;
    };

    const body = html`<div class="launch-confirm">
      <!-- 检查结论 -->
      ${issues.length
        ? html`<div class="lc-section">
            <div class="lc-section__title">
              ${errors.length
                ? html`检测到 ${errors.length} 个会导致启动失败的问题`
                : warns.length
                  ? html`检测到 ${warns.length} 个需要注意的问题`
                  : html`启动前提示`}
            </div>
            <ul class="lc-issues">
              ${errors.map(issueRow)}${warns.map(issueRow)}${infos.map(issueRow)}
            </ul>
          </div>`
        : html`<div class="lc-ok">
            ${raw(icon('done', 16))}
            <span>检查通过：Java 版本、内存、游戏文件都没问题。</span>
          </div>`}

      <!-- 本次启动参数 -->
      <div class="lc-section">
        <div class="lc-section__title">本次启动参数（可以直接改）</div>

        <div class="lc-row">
          <span class="lc-row__label">版本</span>
          <span class="lc-row__value">${info.instance.mcVersion}${info.instance.loader ? ` · ${info.instance.loader.type}` : ''}</span>
        </div>

        <div class="lc-row">
          <span class="lc-row__label">Java</span>
          <span class="lc-row__value">
            ${java
              ? html`Java ${java.version}（${java.arch}，${java.vendor || '未知'}）
                  ${java.major < (info.recommendJavaMajor || 0)
                    ? html`<span class="lc-badge lc-badge--warn">低于推荐 ${info.recommendJavaMajor}</span>`
                    : raw('')}`
              : html`<span class="lc-badge lc-badge--warn">没有可用的 Java</span>`}
          </span>
        </div>

        <div class="lc-row">
          <span class="lc-row__label">内存</span>
          <span class="lc-row__value lc-row__value--slider">
            <input type="range" id="lc-mem" min="512" max="16384" step="512" value="${memMb}" />
            <span class="mono" id="lc-mem-value">${memMb} MB</span>
          </span>
        </div>

        <div class="lc-row">
          <span class="lc-row__label">窗口</span>
          <span class="lc-row__value">
            <input class="input input--sm" id="lc-w" type="number" value="${width}" min="320" max="7680" /> ×
            <input class="input input--sm" id="lc-h" type="number" value="${height}" min="240" max="4320" />
          </span>
        </div>

        <div class="lc-row">
          <span class="lc-row__label">账号</span>
          <span class="lc-row__value">
            ${info.account
              ? html`${info.account.name}（${info.account.type === 'microsoft' ? '微软正版' : '离线'}）`
              : html`<span class="lc-badge lc-badge--warn">还没有账号</span>`}
          </span>
        </div>
      </div>

      <label class="lc-remember">
        <input type="checkbox" id="lc-remember" checked />
        <span>记住这次的选择（内存 / 窗口大小）</span>
      </label>
    </div>`;

    // 直接用 openModal 的风格手写，避免和 promptDialog 的输入逻辑耦合
    root.hidden = false;
    root.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'modal modal--launch';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `
      <div class="modal__head">
        <div class="modal__title">启动 ${escapeHtml(info.instance.name || info.instance.mcVersion)}</div>
        <button class="winbtn" data-close type="button" title="关闭">${icon('close', 14)}</button>
      </div>
      <div class="modal__body">${body.toString()}</div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-act="cancel" type="button">取消</button>
        <button class="btn btn--primary" data-act="start" type="button">
          ${errors.length ? '仍要启动' : '启动游戏'}
        </button>
      </div>`;
    root.appendChild(modal);

    const memInput = modal.querySelector('#lc-mem');
    const memLabel = modal.querySelector('#lc-mem-value');
    if (memInput && memLabel) {
      memInput.addEventListener('input', () => {
        memLabel.textContent = `${memInput.value} MB`;
      });
    }

    const cleanup = () => {
      root.hidden = true;
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
    };

    const finish = (started) => {
      if (!started) {
        cleanup();
        resolve({ started: false });
        return;
      }
      const choices = {
        memoryMb: Number(memInput ? memInput.value : memMb),
        width: Number(modal.querySelector('#lc-w') ? modal.querySelector('#lc-w').value : width),
        height: Number(modal.querySelector('#lc-h') ? modal.querySelector('#lc-h').value : height),
        remember: !!(modal.querySelector('#lc-remember') && modal.querySelector('#lc-remember').checked)
      };
      cleanup();
      resolve({ started: true, choices });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // 回车直接启动（除非焦点在输入框里做别的）
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag !== 'INPUT' || document.activeElement.type === 'range') {
          e.preventDefault();
          finish(true);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);

    modal.querySelector('[data-close]').addEventListener('click', () => finish(false));
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    modal.querySelector('[data-act="start"]').addEventListener('click', () => finish(true));
    modal.addEventListener('mousedown', (e) => {
      if (e.target === root) finish(false);
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
