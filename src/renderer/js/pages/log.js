/**
 * QCL 电脑版 · 启动日志
 *
 * · 「实时输出」：订阅 `launch:log` 事件逐行追加，自动滚底、可暂停、可清屏、可复制
 * · 「上次启动日志」：`log:recent` 读 <QCL_HOME>/logs/latest.log 的尾部
 */

import { call, on } from '../bridge.js';
import { state } from '../store.js';
import { html, raw, setHTML, toast, emptyState, copyText, fmtClock } from '../ui.js';
import { icon } from '../icons.js';

export const logPage = {
  id: 'log',
  title: '启动日志',
  async render(mount) {
    let tab = 'live';
    let paused = false;
    let autoScroll = true;
    const lines = [];
    const MAX_LINES = 5000;

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">启动日志</div>
          <div class="segmented" id="lg-tabs">
            <button class="segmented__item is-active" type="button" data-t="live">实时输出</button>
            <button class="segmented__item" type="button" data-t="last">上次启动日志</button>
          </div>
          <div class="page__spacer"></div>
          <button class="btn btn--ghost btn--sm" id="lg-pause" type="button">暂停</button>
          <button class="btn btn--ghost btn--sm" id="lg-clear" type="button">清屏</button>
          <button class="btn btn--ghost btn--sm" id="lg-copy" type="button">复制全部</button>
          <button class="btn btn--ghost btn--sm" id="lg-reload" type="button">${raw(icon('refresh', 14))}重新读取</button>
        </div>
        <div class="page__body" style="display:flex;flex-direction:column;gap:10px">
          <div class="hstack">
            <span class="badge" id="lg-status">等待启动…</span>
            <div class="switch is-on" id="lg-autoscroll" role="switch" tabindex="0" title="自动滚到底部"></div>
            <span class="page__sub">自动滚底</span>
            <div class="grow"></div>
            <span class="page__sub" id="lg-count">0 行</span>
          </div>
          <div class="logview" id="lg-view"></div>
        </div>
      </div>`
    );

    const view = mount.querySelector('#lg-view');
    const countEl = mount.querySelector('#lg-count');
    const statusEl = mount.querySelector('#lg-status');

    function renderLines() {
      if (lines.length === 0) {
        setHTML(
          view,
          tab === 'live'
            ? emptyState({
                iconName: 'clock',
                title: '还没有启动输出',
                desc: '回到主页点「启动游戏」，这里会实时显示 Java 进程的 stdout / stderr。',
              })
            : emptyState({
                iconName: 'lastlog',
                title: '还没有上次启动日志',
                desc: '日志文件位置：<span class="mono">&lt;QCL 主目录&gt;/logs/latest.log</span>。启动过一次游戏之后就会有内容。',
              })
        );
        countEl.textContent = '0 行';
        return;
      }
      setHTML(
        view,
        lines
          .map((l) => {
            const cls = l.err ? 'logline logline--err' : l.head ? 'logline logline--head' : 'logline';
            return `<span class="${cls}"><span class="logline__time">${l.time}</span>${escapeLine(l.text)}</span>`;
          })
          .join('')
      );
      countEl.textContent = `${lines.length} 行`;
      if (autoScroll && !paused) view.scrollTop = view.scrollHeight;
    }

    function escapeLine(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function push(text, stream) {
      if (paused) return;
      lines.push({ time: fmtClock(), text, err: stream === 'stderr' });
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      // 逐行渲染在量大时太慢：攒到一定量再整体重绘
      if (lines.length % 12 === 0 || lines.length < 40) renderLines();
      else {
        countEl.textContent = `${lines.length} 行`;
        const span = document.createElement('span');
        span.className = `logline${stream === 'stderr' ? ' logline--err' : ''}`;
        const t = document.createElement('span');
        t.className = 'logline__time';
        t.textContent = fmtClock();
        span.appendChild(t);
        span.appendChild(document.createTextNode(String(text)));
        if (view.querySelector('.empty')) renderLines();
        else {
          view.appendChild(span);
          if (autoScroll && !paused) view.scrollTop = view.scrollHeight;
        }
      }
    }

    /* ---------------- 实时输出 ---------------- */

    const offLog = on('launch:log', (p) => {
      if (!p || p.line == null) return;
      push(p.line, p.stream);
    });
    const offState = on('launch:state', (p) => {
      if (!p) return;
      const map = { starting: '正在启动…', running: '游戏运行中', exited: `已退出（退出码 ${p.code == null ? '未知' : p.code}）` };
      statusEl.textContent = map[p.state] || p.state;
      statusEl.className = `badge ${p.state === 'running' ? 'badge--ok' : p.state === 'exited' ? 'badge--warn' : 'badge--accent'}`;
      lines.push({ time: fmtClock(), text: `—— ${map[p.state] || p.state} ——`, head: true });
      renderLines();
    });

    /* ---------------- 上次日志 ---------------- */

    async function loadRecent() {
      const r = await call('log:recent', { limit: 800 });
      const arr = Array.isArray(r.data) ? r.data : [];
      lines.length = 0;
      if (arr.length === 0) {
        if (!r.ok) toast(r.error || '读取上次日志失败', 'warn', 5000);
        renderLines();
        return;
      }
      for (const line of arr) lines.push({ time: '', text: line, err: /stderr|error|exception/i.test(line) });
      renderLines();
      statusEl.textContent = `已读取 ${arr.length} 行`;
      statusEl.className = 'badge';
    }

    /* ---------------- 交互 ---------------- */

    mount.querySelector('#lg-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-t]');
      if (!btn) return;
      tab = btn.dataset.t;
      mount.querySelectorAll('#lg-tabs .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      if (tab === 'last') loadRecent();
      else {
        lines.length = 0;
        renderLines();
        statusEl.textContent = '等待启动…';
        statusEl.className = 'badge';
      }
    });

    const pauseBtn = mount.querySelector('#lg-pause');
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '继续' : '暂停';
      pauseBtn.classList.toggle('btn--busy', paused);
      if (!paused) renderLines();
      toast(paused ? '已暂停刷新，新日志仍在后台累积' : '已继续', 'info', 1800);
    });

    mount.querySelector('#lg-clear').addEventListener('click', () => {
      lines.length = 0;
      renderLines();
    });

    mount.querySelector('#lg-copy').addEventListener('click', () => {
      if (lines.length === 0) {
        toast('没有可复制的内容', 'warn');
        return;
      }
      copyText(lines.map((l) => (l.time ? `[${l.time}] ${l.text}` : l.text)).join('\n'));
    });

    mount.querySelector('#lg-reload').addEventListener('click', () => {
      if (tab === 'last') loadRecent();
      else toast('实时输出会随游戏启动自动刷新', 'info', 2200);
    });

    const autoEl = mount.querySelector('#lg-autoscroll');
    autoEl.addEventListener('click', () => {
      autoScroll = !autoScroll;
      autoEl.classList.toggle('is-on', autoScroll);
      if (autoScroll) view.scrollTop = view.scrollHeight;
    });

    // 页面一打开就先尝试读一次上次日志，方便排查
    const recent = await call('log:recent', { limit: 1 });
    if (recent.ok && Array.isArray(recent.data) && recent.data.length > 0) {
      statusEl.textContent = '上次运行有日志（切到「上次启动日志」查看）';
    }
    renderLines();
    void state;

    return {
      destroy() {
        offLog();
        offState();
      },
    };
  },
};

export default logPage;
