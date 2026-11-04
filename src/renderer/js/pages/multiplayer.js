/**
 * Quanta Craft Launcher PC · 多人联机（Terracotta / 陶瓦联机）
 *
 * 真实实现，不是占位页：
 *   · 「准备联机组件」→ 下载 Terracotta 可执行文件（SHA-512 校验）
 *   · 「创建房间」→ 启动 terracotta.exe，房主拿到邀请码
 *   · 「加入房间」→ 把邀请码发给进程，访客拿到游戏里要填的服务器地址
 *   · 状态通过 terracotta:state 事件实时刷新
 *
 * ★ 手机版为什么难做对：它需要 VpnService（安卓）把流量劫持到本地端口；
 *   PC 上 Terracotta 本身就是个可执行程序，直接 spawn 就行，比手机简单得多。
 *
 * 另外保留「服务器地址簿」：常用服务器存下来，一键复制地址。
 */

import { html, setHTML, raw, toast, emptyState } from '../ui.js';
import { call, on } from '../bridge.js';
import { icon } from '../icons.js';

/** 状态文案映射（照 HMCL 的 TerracottaState） */
const STATE_TEXT = {
  waiting: { text: '等待中', kind: 'idle' },
  host_scanning: { text: '正在扫描端口…', kind: 'busy' },
  host_ok: { text: '房间已创建', kind: 'ok' },
  guest_connecting: { text: '正在连接房间…', kind: 'busy' },
  guest_ok: { text: '已连接', kind: 'ok' },
  exception: { text: '出错了', kind: 'error' },
  exited: { text: '已结束', kind: 'idle' }
};

const LS_KEY = 'qcl.serverBook';
let unsubscribe = null;
let activeTab = 'terracotta';

function readBook() {
  try {
    const list = JSON.parse(window.localStorage.getItem(LS_KEY) || '[]');
    if (Array.isArray(list)) return list;
  } catch {
    /* 坏数据从空开始 */
  }
  return [];
}
function writeBook(list) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* 忽略 */
  }
}

export const multiplayerPage = {
  id: 'multiplayer',
  title: '多人联机',
  render(mount) {
    setHTML(
      mount,
      html`<div class="page page--mp">
        <div class="page__head">
          <div class="page__title">多人联机</div>
          <div class="page__sub">Terracotta 陶瓦联机 · 无需公网 IP，填邀请码即可</div>
        </div>

        <div class="mods-bar">
          <div class="mods-tabs" id="mp-tabs" style="margin-left:0">
            <button class="segmented__item ${activeTab === 'terracotta' ? 'is-active' : ''}" type="button" data-tab="terracotta">陶瓦联机</button>
            <button class="segmented__item ${activeTab === 'book' ? 'is-active' : ''}" type="button" data-tab="book">服务器地址簿</button>
          </div>
        </div>

        <div id="mp-content"></div>
      </div>`
    );

    mount.querySelector('#mp-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      activeTab = btn.dataset.tab;
      mount.querySelectorAll('#mp-tabs .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      if (activeTab === 'book') renderBook(mount);
      else renderTerracotta(mount);
    });

    if (activeTab === 'book') renderBook(mount);
    else renderTerracotta(mount);
  }
};

/* ------------------------------ 陶瓦联机 ------------------------------ */

function renderTerracotta(mount) {
  const box = mount.querySelector('#mp-content');
  setHTML(
    box,
    html`<div class="mp-status card" id="mp-status-card">
        <div class="mp-status__row">
          <span class="mp-dot" id="mp-dot" data-kind="idle"></span>
          <span class="mp-status__text" id="mp-status-text">正在检测联机组件…</span>
        </div>
        <div class="mp-status__hint" id="mp-status-hint"></div>
      </div>

      <section class="card mp-card">
        <div class="tool-card__head">
          <span class="tool-card__icon">${raw(icon('download', 18))}</span>
          <div>
            <div class="tool-card__title">联机组件</div>
            <div class="tool-card__desc">首次使用需下载 Terracotta（约 9MB，带 SHA-512 校验）</div>
          </div>
        </div>
        <div class="tool-actions">
          <button class="btn btn--sm" id="mp-prepare" type="button">准备联机组件</button>
          <button class="btn btn--ghost btn--sm" id="mp-links" type="button">官方发布页</button>
        </div>
        <div class="tool-result" id="mp-prepare-result"></div>
      </section>

      <div class="mp-grid">
        <section class="card mp-card">
          <div class="tool-card__head">
            <span class="tool-card__icon">${raw(icon('multiplayer', 18))}</span>
            <div>
              <div class="tool-card__title">创建房间（我是房主）</div>
              <div class="tool-card__desc">开好后把邀请码发给朋友</div>
            </div>
          </div>
          <div class="tool-actions">
            <button class="btn btn--sm" id="mp-host" type="button">创建房间</button>
          </div>
          <div class="mp-result" id="mp-host-result"></div>
        </section>

        <section class="card mp-card">
          <div class="tool-card__head">
            <span class="tool-card__icon">${raw(icon('earth', 18))}</span>
            <div>
              <div class="tool-card__title">加入房间（我是访客）</div>
              <div class="tool-card__desc">填入房主给你的邀请码</div>
            </div>
          </div>
          <div class="field__row">
            <input class="input" id="mp-code" placeholder="粘贴邀请码，例如 AB12CD" />
            <button class="btn btn--sm" id="mp-join" type="button">加入</button>
          </div>
          <div class="mp-result" id="mp-join-result"></div>
        </section>
      </div>

      <section class="card mp-card">
        <div class="tool-card__head">
          <span class="tool-card__icon">${raw(icon('info', 18))}</span>
          <div><div class="tool-card__title">怎么用</div></div>
        </div>
        <ol class="tool-hints">
          <li>房主点「创建房间」拿到<b>邀请码</b>；同时进游戏开一个<b>对局域网开放</b>的世界。</li>
          <li>访客点「加入房间」填邀请码，拿到 <span class="mono">host:port</span>。</li>
          <li>访客在游戏里「多人游戏 → 直接连接」填那个地址，就能进房主的世界。</li>
          <li>联机开着时不要关启动器；关闭房间点「结束联机」。</li>
        </ol>
        <div class="tool-actions">
          <button class="btn btn--ghost btn--sm" id="mp-stop" type="button">结束联机</button>
        </div>
      </section>`
  );
  bindTerracotta(mount);
}

async function bindTerracotta(mount) {
  const statusText = mount.querySelector('#mp-status-text');
  const statusHint = mount.querySelector('#mp-status-hint');
  const dot = mount.querySelector('#mp-dot');

  const setStatus = (state, detail) => {
    const info = STATE_TEXT[state] || { text: state || '未知', kind: 'idle' };
    if (statusText) statusText.textContent = info.text;
    if (statusHint) statusHint.textContent = detail || '';
    if (dot) dot.dataset.kind = info.kind;
  };

  // ★ bridge.call 返回 { ok, source, data, error } 包装对象，真实数据在 .data 里
  const infoRes = await call('terracotta:info');
  const info = infoRes && infoRes.data;
  if (!info) {
    setStatus('exception', (infoRes && infoRes.error) || '无法获取联机组件信息');
  } else if (!info.supported) {
    setStatus('exception', info.reason || '当前平台不支持');
  } else if (info.installed) {
    setStatus('waiting', `组件已就绪（v${info.version}）`);
  } else {
    setStatus('waiting', '组件未安装 —— 点下面「准备联机组件」');
  }

  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* 忽略 */
    }
  }
  unsubscribe = on('terracotta:state', (st) => {
    if (!st) return;
    const detail =
      st.state === 'host_ok' && st.room
        ? `邀请码 ${st.room}`
        : st.state === 'guest_ok' && st.url
          ? st.url
          : st.state === 'exception' && st.message
            ? st.message
            : '';
    setStatus(st.state, detail);

    if (st.state === 'host_ok' && st.room) {
      const box = mount.querySelector('#mp-host-result');
      if (box) {
        setHTML(
          box,
          html`<div class="mp-code-box">
            <div class="mp-code-box__label">把下面这串邀请码发给朋友</div>
            <div class="mp-code-box__value">${st.room}</div>
            <button class="btn btn--ghost btn--sm" type="button" id="mp-copy-room">复制邀请码</button>
          </div>`
        );
        const btn = box.querySelector('#mp-copy-room');
        if (btn) {
          btn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(st.room);
              toast('邀请码已复制', 'ok', 1800);
            } catch {
              toast('复制失败，请手动选中', 'warn');
            }
          });
        }
      }
    }

    if (st.state === 'guest_ok' && st.url) {
      const box = mount.querySelector('#mp-join-result');
      if (box) {
        setHTML(
          box,
          html`<div class="mp-code-box">
            <div class="mp-code-box__label">游戏里「多人游戏 → 直接连接」填这个地址</div>
            <div class="mp-code-box__value">${st.url}</div>
            <button class="btn btn--ghost btn--sm" type="button" id="mp-copy-url">复制地址</button>
          </div>`
        );
        const btn = box.querySelector('#mp-copy-url');
        if (btn) {
          btn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(st.url);
              toast('地址已复制', 'ok', 1800);
            } catch {
              toast('复制失败，请手动选中', 'warn');
            }
          });
        }
      }
    }
  });

  mount.querySelector('#mp-prepare')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = mount.querySelector('#mp-prepare-result');
    btn.disabled = true;
    setHTML(box, html`<div class="skeleton skeleton--row"></div>`);
    setStatus('host_scanning', '正在下载组件');
    const r = await call('terracotta:prepare');
    btn.disabled = false;
    if (!r || !r.ok) {
      setHTML(box, html`<div class="tool-warn">${(r && r.error) || '下载失败'}</div>`);
      setStatus('exception', '组件准备失败');
      return;
    }
    const data = r.data || {};
    setHTML(box, html`<div class="tool-ok">组件已就绪：<span class="mono">${data.exe || ''}</span></div>`);
    setStatus('waiting', '组件已就绪');
  });

  mount.querySelector('#mp-links')?.addEventListener('click', async () => {
    const r = await call('shell:openExternal', { url: 'https://github.com/burningtnt/Terracotta/releases' });
    if (!r.ok) toast(r.error || '打不开', 'warn');
  });

  mount.querySelector('#mp-host')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = mount.querySelector('#mp-host-result');
    btn.disabled = true;
    setHTML(box, html`<div class="skeleton skeleton--row"></div>`);
    const stRes = await call('terracotta:status');
    const st = (stRes && stRes.data) || {};
    if (!st.running) {
      const started = await call('terracotta:start', { portTransfer: 0 });
      if (!started || !started.ok) {
        btn.disabled = false;
        setHTML(box, html`<div class="tool-warn">${(started && started.error) || '启动失败'}</div>`);
        return;
      }
    }
    const r = await call('terracotta:host');
    btn.disabled = false;
    if (!r || !r.ok) {
      setHTML(box, html`<div class="tool-warn">${(r && r.error) || '创建房间失败'}</div>`);
      return;
    }
    setHTML(box, html`<div class="tool-hint">已请求创建房间，等待邀请码…</div>`);
  });

  mount.querySelector('#mp-join')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const input = mount.querySelector('#mp-code');
    const code = input ? String(input.value || '').trim() : '';
    const box = mount.querySelector('#mp-join-result');
    if (!code) {
      toast('请先填写邀请码', 'warn');
      return;
    }
    btn.disabled = true;
    setHTML(box, html`<div class="skeleton skeleton--row"></div>`);
    const stRes = await call('terracotta:status');
    const st = (stRes && stRes.data) || {};
    if (!st.running) {
      const started = await call('terracotta:start', { portTransfer: 0 });
      if (!started || !started.ok) {
        btn.disabled = false;
        setHTML(box, html`<div class="tool-warn">${(started && started.error) || '启动失败'}</div>`);
        return;
      }
    }
    const r = await call('terracotta:join', { code });
    btn.disabled = false;
    if (!r || !r.ok) {
      setHTML(box, html`<div class="tool-warn">${(r && r.error) || '加入失败'}</div>`);
      return;
    }
    setHTML(box, html`<div class="tool-hint">已发送加入请求，等待连接…</div>`);
  });

  mount.querySelector('#mp-stop')?.addEventListener('click', async () => {
    const r = await call('terracotta:stop');
    if (r && r.ok) {
      toast('已结束联机', 'ok', 1800);
      setStatus('exited', '');
      const hr = mount.querySelector('#mp-host-result');
      const jr = mount.querySelector('#mp-join-result');
      if (hr) setHTML(hr, '');
      if (jr) setHTML(jr, '');
    }
  });
}

/* ------------------------------ 地址簿 ------------------------------ */

function renderBook(mount) {
  const box = mount.querySelector('#mp-content');
  const list = readBook();

  setHTML(
    box,
    html`<section class="card">
      <div class="tool-card__head">
        <span class="tool-card__icon">${raw(icon('earth', 18))}</span>
        <div>
          <div class="tool-card__title">服务器地址簿</div>
          <div class="tool-card__desc">${list.length ? `共 ${list.length} 个，点「复制」拿地址` : '把常玩的服务器存下来，一键复制地址'}</div>
        </div>
      </div>
      <div class="field__row" style="margin:12px 0">
        <input class="input" id="book-name" placeholder="名称，例如「朋友的生存服」" />
        <input class="input" id="book-addr" placeholder="地址 host:port" />
        <button class="btn btn--sm" id="book-add" type="button">添加</button>
      </div>
      ${list.length
        ? html`<div class="mods-list">
            ${list.map(
              (s, i) => html`<div class="mod-row">
                <div class="mod-row__icon">${raw(icon('earth', 20))}</div>
                <div class="mod-row__main">
                  <div class="mod-row__name">${s.name}</div>
                  <div class="mod-row__meta"><span class="mono">${s.address}</span></div>
                </div>
                <div class="mod-row__actions">
                  <button class="btn btn--ghost btn--sm" type="button" data-copy="${s.address}">复制</button>
                  <button class="btn btn--ghost btn--sm" type="button" data-del="${i}">删除</button>
                </div>
              </div>`
            )}
          </div>`
        : emptyState({ iconName: 'earth', title: '还没有保存的服务器', desc: '填上面的名称与地址就能加进来。' })}
    </section>`
  );

  box.querySelector('#book-add')?.addEventListener('click', () => {
    const name = String(box.querySelector('#book-name')?.value || '').trim();
    const addr = String(box.querySelector('#book-addr')?.value || '').trim();
    if (!name || !addr) {
      toast('名称和地址都要填', 'warn');
      return;
    }
    const next = readBook();
    next.unshift({ name, address: addr, addedAt: Date.now() });
    writeBook(next);
    toast('已添加', 'ok', 1600);
    renderBook(mount);
  });

  box.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.copy);
        toast('地址已复制', 'ok', 1600);
      } catch {
        toast('复制失败', 'warn');
      }
      return;
    }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      const next = readBook();
      next.splice(Number(delBtn.dataset.del), 1);
      writeBook(next);
      toast('已删除', 'ok', 1600);
      renderBook(mount);
    }
  });
}
