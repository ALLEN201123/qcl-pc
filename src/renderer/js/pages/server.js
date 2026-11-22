/**
 * Quanta Craft Launcher PC · 服务端（一键开服）
 *
 * ★ 安卓 1.6.6 的「一键开服」只有：选版本 → 下载 → 起进程 → 看控制台，
 *   配置 15 项，没有备份、白名单、RCON、诊断。
 *   PC 版这一页把这些补齐，并且做成「不关也能管」：
 *
 *   ① 服务端列表（可同时存在多个）
 *   ② 创建向导：核心类型 + MC 版本 + 名称
 *   ③ 控制台：实时日志 + 输入框下发命令（走 stdin，不需要 RCON）
 *   ④ 配置：46 项 server.properties 分组编辑 + 5 套一键预设
 *   ⑤ RCON：任意命令、在线玩家、广播、踢人
 *   ⑥ 备份：手动/全量、恢复、导出 zip、定时设置
 *   ⑦ 诊断：退出码 + 日志 → 中文结论
 */

import { html, raw, setHTML, toast, fmtBytes, fmtRelative, confirmDialog, promptDialog, emptyState, openModal } from '../ui.js';
import { call, on } from '../bridge.js';
import { state } from '../store.js';
import { icon } from '../icons.js';

/** 页面内状态 */
const view = {
  /** 当前挂载的 DOM 根（render 时赋值，所有绘制函数都靠它） */
  mount: null,
  servers: [],
  currentId: '',
  activeTab: 'console',
  logLines: [],
  statusInfo: null,
  props: null,
  propsDirty: {},
  backups: [],
  players: [],
  /** 轮询定时器 */
  pollTimer: null,
  offLog: null,
  offState: null,
  offChanged: null,
  offTunnelLog: null,
  offTunnelState: null,
};

/** 状态中文 + 颜色 */
const STATE_TEXT = {
  idle: { text: '未启动', kind: 'idle' },
  preparing: { text: '准备中', kind: 'busy' },
  downloading: { text: '下载中', kind: 'busy' },
  installing: { text: '安装中', kind: 'busy' },
  starting: { text: '启动中', kind: 'busy' },
  running: { text: '运行中', kind: 'ok' },
  stopping: { text: '正在停止', kind: 'busy' },
  stopped: { text: '已停止', kind: 'idle' },
  crashed: { text: '已崩溃', kind: 'error' },
};

export const serverPage = {
  id: 'server',
  title: '服务端',

  async render(mount) {
    /**
     * ★★★ 2026-11-22 修（实测踩到：页面直接抛
     *   `Cannot read properties of undefined (reading 'querySelector')`，整页显示「页面加载失败」）。
     *
     * 原因：这个页面所有绘制函数都通过 `view.mount` 找 DOM，
     * 但 render() 里只建了个没用的局部 `page` 对象，**从没把 mount 存进 view**。
     * 必须先把 mount 挂到 view 上，后面 drawShell() 才有东西可画。
     */
    view.mount = mount;

    await loadServers();
    if (!view.currentId && view.servers.length) view.currentId = view.servers[0].id;

    drawShell();
    bindEvents();

    // 订阅
    view.offLog = on('server:log', (p) => {
      if (!p || p.id !== view.currentId) return;
      view.logLines.push(p.line);
      if (view.logLines.length > 2000) view.logLines.splice(0, view.logLines.length - 2000);
      appendLogLine(p.line);
    });
    view.offState = on('server:state', (p) => {
      if (!p || p.id !== view.currentId) return;
      refreshStatus();
      drawSidebar();
    });
    view.offChanged = on('server:changed', () => {
      loadServers().then(() => drawSidebar());
    });
    // 穿透日志与状态
    view.offTunnelLog = on('server:tunnel:log', (p) => {
      const pre = view.mount && view.mount.querySelector('#srv-tunnel-log');
      if (!pre || !p || !p.line) return;
      const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
      pre.textContent += (pre.textContent ? '\n' : '') + p.line;
      if (pre.textContent.length > 200000) pre.textContent = pre.textContent.slice(-150000);
      if (nearBottom) pre.scrollTop = pre.scrollHeight;
    });
    view.offTunnelState = on('server:tunnel:state', async (p) => {
      if (!p) return;
      const chip = view.mount && view.mount.querySelector('#srv-tunnel-chip');
      const addr = view.mount && view.mount.querySelector('#srv-tunnel-addr');
      if (chip) {
        chip.textContent = p.state === 'running' ? '穿透运行中' : p.state === 'stopped' ? '已停止' : p.state;
        chip.className = `srv-tunnel__state ${p.state === 'running' ? 'is-on' : 'is-off'}`;
      }
      if (addr && p.message) addr.textContent = p.message;
    });

    // 轮询状态（进程可能被外部杀掉，事件收不到）
    view.pollTimer = setInterval(() => {
      if (view.currentId) refreshStatus();
    }, 3000);
    if (view.pollTimer.unref) view.pollTimer.unref();

    if (view.currentId) {
      await selectServer(view.currentId, { silent: true });
    } else {
      drawEmpty();
    }

    return {
      destroy() {
        if (view.pollTimer) clearInterval(view.pollTimer);
        view.pollTimer = null;
        if (typeof view.offLog === 'function') view.offLog();
        if (typeof view.offState === 'function') view.offState();
        if (typeof view.offChanged === 'function') view.offChanged();
        if (typeof view.offTunnelLog === 'function') view.offTunnelLog();
        if (typeof view.offTunnelState === 'function') view.offTunnelState();
        view.offLog = view.offState = view.offChanged = null;
        view.offTunnelLog = view.offTunnelState = null;
        stopPolling();
      },
    };
  },
};

/* ============================================================
 * 数据加载
 * ============================================================ */

async function loadServers() {
  const r = await call('server:list', {}, { optional: true });
  const d = r && r.ok ? r.data : null;
  view.servers = (d && d.list) || [];
  return view.servers;
}

async function refreshStatus() {
  if (!view.currentId) return;
  const r = await call('server:status', { id: view.currentId }, { optional: true });
  const d = r && r.ok ? r.data : null;
  view.statusInfo = d;
  updateStatusChip(d);
  updateControlButtons(d);
}

/* ============================================================
 * 外壳
 * ============================================================ */

function drawShell() {
  const m = view.mount;
  setHTML(
    m,
    html`<div class="page page--srv">
      <div class="page__head">
        <div class="page__title"><span class="srv-title-icon">${raw(icon('server', 20))}</span>服务端</div>
        <div class="page__sub">一键开服 · 多核心 · RCON · 自动备份</div>
        <div class="page__spacer"></div>
        <button class="btn btn--sm" id="srv-new" type="button">${raw(icon('add', 14))}新建服务端</button>
      </div>

      <div class="srv-layout">
        <aside class="srv-side" id="srv-side"></aside>
        <main class="srv-main" id="srv-main"></main>
      </div>
    </div>`
  );
  drawSidebar();
}

function drawSidebar() {
  const el = view.mount.querySelector('#srv-side');
  if (!el) return;
  if (!view.servers.length) {
    setHTML(el, html`<div class="srv-side__empty">还没有服务端<br /><span>点右上角「新建服务端」</span></div>`);
    return;
  }
  const rows = view.servers
    .map((s) => {
      const st = STATE_TEXT[s.state || 'idle'] || STATE_TEXT.idle;
      const active = s.id === view.currentId;
      return `<button class="srv-item ${active ? 'is-active' : ''}" type="button" data-id="${esc(s.id)}">
        <span class="srv-item__dot srv-item__dot--${st.kind}"></span>
        <span class="srv-item__main">
          <span class="srv-item__name">${esc(s.name || s.id)}</span>
          <span class="srv-item__meta">${esc(s.mcVersion || '')} · ${esc(kindLabel(s.kind))} · ${esc(st.text)}</span>
        </span>
      </button>`;
    })
    .join('');
  setHTML(el, html`${raw(rows)}`);
  el.querySelectorAll('[data-id]').forEach((b) => {
    b.addEventListener('click', () => selectServer(b.getAttribute('data-id')));
  });
}

function kindLabel(kind) {
  return { vanilla: '原版', paper: 'Paper', purpur: 'Purpur', fabric: 'Fabric' }[kind] || kind || '原版';
}

/* ============================================================
 * 空状态 / 主区
 * ============================================================ */

function drawEmpty() {
  const el = view.mount.querySelector('#srv-main');
  if (!el) return;
  setHTML(
    el,
    html`<div class="srv-empty">
      ${raw(emptyState({
        iconName: 'server',
        title: '还没有服务端',
        desc: '点右上角「新建服务端」，选一个游戏版本和核心类型，剩下的 QCL 帮你办。',
      }))}
    </div>`
  );
}

/** 选中一个服务端 */
async function selectServer(id, opts = {}) {
  view.currentId = id;
  view.logLines = [];
  view.propsDirty = {};
  view.players = [];
  drawSidebar();
  drawMain();

  const st = await call('server:status', { id }, { optional: true });
  view.statusInfo = st && st.ok ? st.data : null;
  if (view.statusInfo && Array.isArray(view.statusInfo.lines)) {
    view.logLines = view.statusInfo.lines.slice();
    renderConsole(true);
  }
  updateStatusChip(view.statusInfo);
  updateControlButtons(view.statusInfo);

  if (!opts.silent) {
    // 切到控制台 tab
    switchTab('console');
  }
}

/* ============================================================
 * 主区（当前服务端）
 * ============================================================ */

function drawMain() {
  const el = view.mount.querySelector('#srv-main');
  if (!el) return;
  const s = view.servers.find((x) => x.id === view.currentId);
  if (!s) {
    drawEmpty();
    return;
  }
  setHTML(
    el,
    html`<div class="srv-detail">
      <div class="srv-head">
        <div class="srv-head__main">
          <div class="srv-head__name">${s.name || s.id}</div>
          <div class="srv-head__meta">
            <span class="badge">${s.mcVersion || '未选版本'}</span>
            <span class="badge">${kindLabel(s.kind)}</span>
            <span class="badge badge--accent" id="srv-state-chip">—</span>
          </div>
        </div>
        <div class="srv-head__actions">
          <button class="btn btn--sm" id="srv-start" type="button">${raw(icon('play', 14))}启动</button>
          <button class="btn btn--ghost btn--sm" id="srv-stop" type="button">停止</button>
          <button class="btn btn--ghost btn--sm" id="srv-download" type="button">${raw(icon('download', 14))}下载服务端</button>
          <button class="btn btn--ghost btn--sm" id="srv-open" type="button">${raw(icon('folder', 14))}打开目录</button>
          <button class="btn btn--ghost btn--sm" id="srv-del" type="button">删除</button>
        </div>
      </div>

      <div class="srv-tabs" id="srv-tabs">
        <button class="segmented__item" type="button" data-tab="console">控制台</button>
        <button class="segmented__item" type="button" data-tab="config">配置</button>
        <button class="segmented__item" type="button" data-tab="rcon">RCON / 玩家</button>
        <button class="segmented__item" type="button" data-tab="tunnel">内网穿透</button>
        <button class="segmented__item" type="button" data-tab="backup">备份</button>
        <button class="segmented__item" type="button" data-tab="diag">诊断</button>
      </div>

      <div class="srv-panel" id="srv-panel"></div>
    </div>`
  );
  bindDetailEvents();
  switchTab(view.activeTab || 'console');
}

function bindDetailEvents() {
  const m = view.mount;
  const q = (sel) => m.querySelector(sel);

  q('#srv-start')?.addEventListener('click', startServer);
  q('#srv-stop')?.addEventListener('click', stopServer);
  q('#srv-download')?.addEventListener('click', downloadJar);
  q('#srv-open')?.addEventListener('click', () => call('server:openDir', { id: view.currentId, what: 'work' }));
  q('#srv-del')?.addEventListener('click', deleteServer);

  m.querySelectorAll('#srv-tabs [data-tab]').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.getAttribute('data-tab')));
  });
}

function switchTab(tab) {
  view.activeTab = tab;
  const m = view.mount;
  m.querySelectorAll('#srv-tabs [data-tab]').forEach((b) => {
    b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
  });
  const panel = m.querySelector('#srv-panel');
  if (!panel) return;
  if (tab === 'console') drawConsole(panel);
  else if (tab === 'config') drawConfig(panel);
  else if (tab === 'rcon') drawRcon(panel);
  else if (tab === 'tunnel') drawTunnel(panel);
  else if (tab === 'backup') drawBackup(panel);
  else if (tab === 'diag') drawDiag(panel);
}

/* ============================================================
 * 内网穿透（frp）
 * ============================================================ */

/** 穿透页的本地状态 */
const tunnelView = {
  /** 默认给 bore：零注册、匿名，未成年玩家也能用 */
  mode: 'bore',
  token: '',
  account: null,
  tunnels: [],
  nodes: [],
  meToken: '',
  meAccount: null,
  meProxies: [],
  st: null,
};

async function drawTunnel(panel) {
  if (!panel) return;
  const stR = await call('server:tunnel:status', {}, { optional: true });
  const st = stR && stR.ok ? stR.data : null;
  tunnelView.st = st;
  const frpInstalled = !!(st && st.installed);
  const boreRunning = !!(st && st.bore && st.bore.running);
  const frpRunning = !!(st && st.frp && st.frp.running);
  const anyRunning = boreRunning || frpRunning;

  // 只有 frp 系需要引擎；bore 不需要
  const needEngine = tunnelView.mode !== 'bore';
  const installed = needEngine ? frpInstalled : true;

  setHTML(
    panel,
    html`<div class="srv-tunnel">
      <div class="srv-tunnel__head">
        <div>
          <div class="srv-tunnel__title">内网穿透</div>
          <div class="srv-tunnel__desc">
            把你电脑上的服务端映射到公网，朋友不用连你家网就能进。
            <strong>没有身份证 / 未满 18 也能用</strong> —— 选「bore 零注册」就行，不需要注册任何账号。
          </div>
        </div>
        <span class="grow"></span>
        <span class="srv-tunnel__state ${anyRunning ? 'is-on' : 'is-off'}" id="srv-tunnel-chip">
          ${anyRunning ? '穿透运行中' : '未启动'}
        </span>
      </div>

      <div class="srv-tunnel__modes">
        <button class="srv-tmode ${tunnelView.mode === 'bore' ? 'is-active' : ''}" type="button" data-tmode="bore">
          <span class="srv-tmode__name">bore 零注册</span>
          <span class="srv-tmode__tag">推荐 · 匿名</span>
          <span class="srv-tmode__desc">公共节点 bore.pub，不用注册、不用实名，连上就给个公网地址</span>
        </button>
        <button class="srv-tmode ${tunnelView.mode === 'sakura' ? 'is-active' : ''}" type="button" data-tmode="sakura">
          <span class="srv-tmode__name">樱花frp</span>
          <span class="srv-tmode__tag">需账号</span>
          <span class="srv-tmode__desc">免费公共节点，需实名注册拿 token</span>
        </button>
        <button class="srv-tmode ${tunnelView.mode === 'me' ? 'is-active' : ''}" type="button" data-tmode="me">
          <span class="srv-tmode__name">魅frp</span>
          <span class="srv-tmode__tag">需账号</span>
          <span class="srv-tmode__desc">另一家 frp 服务商，同样需注册拿 token</span>
        </button>
        <button class="srv-tmode ${tunnelView.mode === 'custom' ? 'is-active' : ''}" type="button" data-tmode="custom">
          <span class="srv-tmode__name">自建 frps</span>
          <span class="srv-tmode__tag">最自由</span>
          <span class="srv-tmode__desc">自己有公网服务器时用，速度和稳定性最好</span>
        </button>
      </div>

      ${needEngine && !frpInstalled
        ? html`<div class="srv-warn">
            frp 系穿透需要 frpc 引擎（约 13 MB，从官方 frp 发布页下载）。
            <div style="margin-top:8px">
              <button class="btn btn--sm" id="srv-tunnel-prepare" type="button">准备 frpc 组件</button>
            </div>
            <div class="srv-dim" style="margin-top:6px" id="srv-tunnel-prep-log"></div>
            <div class="srv-dim" style="margin-top:6px">不想装东西？切回「bore 零注册」—— 它完全不需要外部组件。</div>
          </div>`
        : raw('')}

      <div class="srv-tunnel__body" id="srv-tunnel-body"></div>

      <div class="srv-tunnel__logs">
        <div class="srv-hstack">
          <span class="srv-tunnel__subtitle">穿透日志</span>
          <span class="grow"></span>
          <span class="srv-dim" id="srv-tunnel-addr"></span>
        </div>
        <pre class="srv-log srv-log--short" id="srv-tunnel-log">${(st && st.bore && st.bore.lines ? st.bore.lines.slice(-80).join('\n') : st && st.lines ? st.lines.slice(-80).join('\n') : '')}</pre>
      </div>
    </div>`
  );

  panel.querySelector('#srv-tunnel-prepare')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const logEl = panel.querySelector('#srv-tunnel-prep-log');
    btn.disabled = true;
    btn.textContent = '正在下载…（约 13MB）';
    const off = on('server:tunnel:log', (p) => {
      if (logEl && p && p.line) logEl.textContent = String(p.line).slice(0, 160);
    });
    const r = await call('server:tunnel:prepare', {});
    if (typeof off === 'function') off();
    const d = r && r.ok ? r.data : null;
    if (!d || !d.ok) {
      toast(`准备失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 8000);
      btn.disabled = false;
      btn.textContent = '重试';
      return;
    }
    toast('frpc 引擎已就绪', 'ok', 4000);
    drawTunnel(panel);
  });

  panel.querySelectorAll('[data-tmode]').forEach((b) => {
    b.addEventListener('click', () => {
      tunnelView.mode = b.getAttribute('data-tmode');
      drawTunnel(panel);
    });
  });

  const body = panel.querySelector('#srv-tunnel-body');
  if (tunnelView.mode === 'bore') drawBore(body, panel);
  else if (tunnelView.mode === 'sakura') drawSakura(body, panel);
  else if (tunnelView.mode === 'me') drawMe(body, panel);
  else drawCustom(body, panel);
}

/** bore：零注册匿名 */
function drawBore(body, panel) {
  if (!body) return;
  setHTML(
    body,
    html`<div class="srv-tunnel__form">
      <div class="srv-tunnel__notice">
        <strong>不需要注册、不需要实名。</strong>
        服务端是公开的 bore.pub，连上就分配一个随机公网端口。
        <br />代价：每次地址都不一样（重启就变）、没有密码（谁拿到地址都能连）、延迟取决于公共节点。
        适合临时和朋友玩；长期公开服建议用自建 frps。
      </div>
      <div class="field">
        <div class="field__label">bore 服务端（留空用公共 bore.pub）</div>
        <input class="input" id="bo-addr" type="text" placeholder="bore.pub（默认）" autocomplete="off" />
        <div class="field__hint">也可以填你自己或别人搭的 bore 服务端地址，格式 host:port</div>
      </div>
      <div class="hstack">
        <button class="btn btn--sm" id="bo-start" type="button">启动穿透（零注册）</button>
        <button class="btn btn--ghost btn--sm" id="bo-stop" type="button">停止</button>
      </div>
      <div class="srv-dim" id="bo-addr-out"></div>
    </div>`
  );

  body.querySelector('#bo-start')?.addEventListener('click', async () => {
    const addr = (body.querySelector('#bo-addr')?.value || '').trim();
    toast('正在连接 bore 服务端…', 'info', 3000);
    const r = await call('server:tunnel:boreStart', {
      serverAddr: addr || undefined,
      serverId: view.currentId,
    });
    const d = r && r.ok ? r.data : null;
    if (!d || !d.ok) {
      toast(`启动失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 8000);
      return;
    }
    const out = body.querySelector('#bo-addr-out');
    if (out) {
      out.innerHTML = `公网地址：<strong style="color:#7ec699">${esc(d.publicAddr)}</strong> —— 把这个发给朋友，他们在游戏里「直接连接」填它就进来了。`;
    }
    toast(`隧道已建立：${d.publicAddr}`, 'ok', 8000);
    await sleepMs(1200);
    drawTunnel(panel);
  });

  body.querySelector('#bo-stop')?.addEventListener('click', async () => {
    await call('server:tunnel:boreStop', {});
    toast('已停止 bore 隧道', 'ok', 3000);
    drawTunnel(panel);
  });
}

/** 魅frp */
async function drawMe(body, panel) {
  if (!body) return;
  setHTML(
    body,
    html`<div class="srv-tunnel__form">
      <div class="srv-tunnel__notice">
        魅frp 需要注册账号并实名（和樱花frp 一样）。<strong>用不了实名认证的话，请选「bore 零注册」。</strong>
      </div>
      <div class="field">
        <div class="field__label">魅frp token</div>
        <div class="hstack">
          <input class="input" id="me-token" type="password" placeholder="在魅frp 控制台复制" value="${tunnelView.meToken || ''}" autocomplete="off" />
          <button class="btn btn--sm" id="me-verify" type="button">验证</button>
        </div>
        <div class="field__hint">${tunnelView.meAccount ? `已登录：${tunnelView.meAccount.name}` : '在 mefrp.com 注册后获取'}</div>
      </div>
      <div class="field" ${tunnelView.meProxies.length ? '' : 'hidden'}>
        <div class="field__label">选择隧道</div>
        <select class="input" id="me-proxy">
          ${tunnelView.meProxies
            .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.type)} · 本地 ${p.localPort}</option>`)
            .join('')}
        </select>
      </div>
      <div class="hstack">
        <button class="btn btn--sm" id="me-start" type="button" ${tunnelView.meProxies.length ? '' : 'disabled'}>启动穿透</button>
        <button class="btn btn--ghost btn--sm" id="me-stop" type="button">停止</button>
      </div>
    </div>`
  );

  body.querySelector('#me-verify')?.addEventListener('click', async () => {
    const token = (body.querySelector('#me-token')?.value || '').trim();
    if (!token) {
      toast('先填 token', 'error', 3000);
      return;
    }
    tunnelView.meToken = token;
    const ur = await call('server:tunnel:meUser', { token });
    const ud = ur && ur.ok ? ur.data : null;
    if (!ud || !ud.ok) {
      toast(`验证失败：${(ud && ud.error) || (ur && ur.error) || '未知错误'}`, 'error', 6000);
      return;
    }
    tunnelView.meAccount = ud.account;
    const pr = await call('server:tunnel:meProxies', { token });
    const pd = pr && pr.ok ? pr.data : null;
    tunnelView.meProxies = (pd && pd.list) || [];
    toast(`已登录 ${ud.account.name}，隧道 ${tunnelView.meProxies.length} 条`, 'ok', 5000);
    drawTunnel(panel);
  });

  body.querySelector('#me-start')?.addEventListener('click', async () => {
    const sel = body.querySelector('#me-proxy');
    const proxyId = sel ? sel.value : '';
    if (!proxyId) {
      toast('先选一条隧道', 'error', 3000);
      return;
    }
    const r = await call('server:tunnel:start', {
      mode: 'me',
      token: tunnelView.meToken,
      proxyId,
      serverId: view.currentId,
    });
    const d = r && r.ok ? r.data : null;
    if (!d || !d.ok) {
      toast(`启动失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 8000);
      return;
    }
    toast('穿透已启动，几秒后看日志里的公网地址', 'ok', 6000);
    await sleepMs(3000);
    drawTunnel(panel);
  });

  body.querySelector('#me-stop')?.addEventListener('click', async () => {
    await call('server:tunnel:stop', {});
    toast('已停止', 'ok', 3000);
    drawTunnel(panel);
  });
}

/** 樱花frp 表单 */
async function drawSakura(body, panel) {
  if (!body) return;
  setHTML(
    body,
    html`<div class="srv-tunnel__form">
      <div class="field">
        <div class="field__label">樱花frp 访问 token</div>
        <div class="hstack">
          <input class="input" id="sk-token" type="password" placeholder="在 樱花frp 控制台 → 用户信息 里复制" value="${tunnelView.token || ''}" autocomplete="off" />
          <button class="btn btn--sm" id="sk-verify" type="button">验证</button>
        </div>
        <div class="field__hint" id="sk-account">${tunnelView.account ? `已登录：${tunnelView.account.name}（${tunnelView.account.group} Lv.${tunnelView.account.level}）` : '没账号？去 natfrp.com 免费注册，创建一条 TCP 隧道指向 127.0.0.1:25565'}</div>
      </div>
      <div class="field" id="sk-tunnel-field" ${tunnelView.tunnels.length ? '' : 'hidden'}>
        <div class="field__label">选择隧道</div>
        <select class="input" id="sk-tunnel">
          ${tunnelView.tunnels
            .map((t) => `<option value="${esc(t.id)}">${esc(t.name)} · ${esc(t.type)} · 本地 ${t.localPort}${t.remoteAddress ? ' → ' + esc(t.remoteAddress) : ''}</option>`)
            .join('')}
        </select>
        <div class="field__hint">隧道在樱花frp 控制台建，这里只挑一条启动</div>
      </div>
      <div class="hstack">
        <button class="btn btn--sm" id="sk-start" type="button" ${tunnelView.tunnels.length ? '' : 'disabled'}>启动穿透</button>
        <button class="btn btn--ghost btn--sm" id="sk-stop" type="button">停止</button>
      </div>
    </div>`
  );

  body.querySelector('#sk-verify')?.addEventListener('click', async () => {
    const token = (body.querySelector('#sk-token')?.value || '').trim();
    if (!token) {
      toast('先填 token', 'error', 3000);
      return;
    }
    tunnelView.token = token;
    toast('正在验证…', 'info', 2000);
    const ur = await call('server:tunnel:sakuraUser', { token });
    const ud = ur && ur.ok ? ur.data : null;
    if (!ud || !ud.ok) {
      toast(`验证失败：${(ud && ud.error) || (ur && ur.error) || '未知错误'}`, 'error', 6000);
      return;
    }
    tunnelView.account = ud.account;
    const tr = await call('server:tunnel:sakuraTunnels', { token });
    const td = tr && tr.ok ? tr.data : null;
    tunnelView.tunnels = (td && td.list) || [];
    toast(
      tunnelView.tunnels.length
        ? `已登录 ${ud.account.name}，找到 ${tunnelView.tunnels.length} 条隧道`
        : `已登录 ${ud.account.name}，但还没有隧道（去樱花控制台建一条）`,
      tunnelView.tunnels.length ? 'ok' : 'warn',
      6000
    );
    drawTunnel(panel);
  });

  body.querySelector('#sk-start')?.addEventListener('click', async () => {
    const sel = body.querySelector('#sk-tunnel');
    const tunnelId = sel ? sel.value : '';
    if (!tunnelId) {
      toast('先选一条隧道', 'error', 3000);
      return;
    }
    toast('正在启动穿透…', 'info', 3000);
    const r = await call('server:tunnel:start', {
      mode: 'sakura',
      token: tunnelView.token,
      tunnelId,
      serverId: view.currentId,
    });
    const d = r && r.ok ? r.data : null;
    if (!d || !d.ok) {
      toast(`启动失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 8000);
      return;
    }
    toast(`穿透已启动（本地端口 ${d.localPort}），几秒后看日志里的公网地址`, 'ok', 6000);
    await sleepMs(3000);
    drawTunnel(panel);
  });

  body.querySelector('#sk-stop')?.addEventListener('click', async () => {
    await call('server:tunnel:stop', {});
    toast('已停止穿透', 'ok', 3000);
    drawTunnel(panel);
  });
}

/** 自建 frps 表单 */
function drawCustom(body, panel) {
  if (!body) return;
  setHTML(
    body,
    html`<div class="srv-tunnel__form">
      <div class="field">
        <div class="field__label">frps 服务器地址</div>
        <input class="input" id="cs-addr" type="text" placeholder="frp.example.com 或 1.2.3.4" autocomplete="off" />
      </div>
      <div class="hstack">
        <div class="field" style="flex:1">
          <div class="field__label">服务端口</div>
          <input class="input" id="cs-port" type="number" value="7000" />
        </div>
        <div class="field" style="flex:1">
          <div class="field__label">认证 token（可留空）</div>
          <input class="input" id="cs-token" type="password" placeholder="和 frps.ini 里的 auth.token 一致" autocomplete="off" />
        </div>
        <div class="field" style="flex:1">
          <div class="field__label">远程端口</div>
          <input class="input" id="cs-remote" type="number" placeholder="留空 = 与本地相同" />
        </div>
      </div>
      <div class="field__hint">本地端口自动取服务端配置里的 server-port；远程端口要在 frps 的 allow_ports 范围内</div>
      <div class="hstack">
        <button class="btn btn--sm" id="cs-start" type="button">启动穿透</button>
        <button class="btn btn--ghost btn--sm" id="cs-stop" type="button">停止</button>
      </div>
    </div>`
  );

  body.querySelector('#cs-start')?.addEventListener('click', async () => {
    const serverAddr = (body.querySelector('#cs-addr')?.value || '').trim();
    if (!serverAddr) {
      toast('先填 frps 服务器地址', 'error', 3000);
      return;
    }
    const r = await call('server:tunnel:start', {
      mode: 'custom',
      serverAddr,
      serverPort: Number(body.querySelector('#cs-port')?.value) || 7000,
      authToken: (body.querySelector('#cs-token')?.value || '').trim(),
      remotePort: Number(body.querySelector('#cs-remote')?.value) || 0,
      serverId: view.currentId,
    });
    const d = r && r.ok ? r.data : null;
    if (!d || !d.ok) {
      toast(`启动失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 8000);
      return;
    }
    toast(`穿透已启动（本地端口 ${d.localPort}）`, 'ok', 5000);
    await sleepMs(3000);
    drawTunnel(panel);
  });

  body.querySelector('#cs-stop')?.addEventListener('click', async () => {
    await call('server:tunnel:stop', {});
    toast('已停止穿透', 'ok', 3000);
    drawTunnel(panel);
  });
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ============================================================
 * 状态徽标与按钮
 * ============================================================ */

function updateStatusChip(st) {
  const chip = view.mount.querySelector('#srv-state-chip');
  if (!chip) return;
  const s = (st && st.state) || 'idle';
  const t = STATE_TEXT[s] || STATE_TEXT.idle;
  chip.textContent = t.text;
  chip.className = `badge srv-chip srv-chip--${t.kind}`;
  if (st && st.running && st.uptimeMs) {
    chip.textContent = `${t.text} · ${fmtUptime(st.uptimeMs)}`;
  }
}

function updateControlButtons(st) {
  const running = !!(st && st.running);
  const start = view.mount.querySelector('#srv-start');
  const stop = view.mount.querySelector('#srv-stop');
  if (start) start.disabled = running;
  if (stop) stop.disabled = !running;
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ============================================================
 * 启动 / 停止 / 下载 / 删除
 * ============================================================ */

async function startServer() {
  const id = view.currentId;
  if (!id) return;
  // 先做启动前检查，把问题提前说清楚
  const pf = await call('server:preflight', { id }, { optional: true });
  const d = pf && pf.ok ? pf.data : null;
  if (d && d.issues && d.issues.length) {
    const errs = d.issues.filter((i) => i.level === 'error');
    const warns = d.issues.filter((i) => i.level === 'warn');
    if (errs.length) {
      const needEula = d.issues.some((i) => /EULA/i.test(i.text));
      if (needEula) {
        const ok = await confirmDialog({
          title: '需要同意 EULA',
          message: 'Minecraft 服务端首次启动前必须同意 Mojang 的最终用户许可协议（EULA）。\n\n同意后会在服务端目录写入 eula=true。',
          okText: '同意并继续',
        });
        if (ok) {
          await call('server:acceptEula', { id });
          return startServer();
        }
        return;
      }
      toast(errs[0].text, 'error', 6000);
      return;
    }
    if (warns.length) toast(warns[0].text, 'warn', 5000);
  }

  toast('正在启动服务端…', 'info', 2500);
  const r = await call('server:start', { id });
  const rd = r && r.ok ? r.data : null;
  if (!rd || !rd.ok) {
    toast(`启动失败：${(rd && rd.error) || (r && r.error) || '未知错误'}`, 'error', 6000);
    drawDiag(view.mount.querySelector('#srv-panel'));
    return;
  }
  toast('服务端进程已启动，等它加载完世界', 'ok', 3500);
  refreshStatus();
}

async function stopServer() {
  const id = view.currentId;
  if (!id) return;
  const ok = await confirmDialog({
    title: '停止服务端',
    message: '会先发送 stop 命令让服务端保存世界并正常关闭；如果 30 秒没关掉才会强制结束。\n\n确定要停吗？',
    okText: '停止',
  });
  if (!ok) return;
  toast('正在停止（等待服务端保存世界）…', 'info', 4000);
  const r = await call('server:stop', { id, waitMs: 30000 });
  const d = r && r.ok ? r.data : null;
  if (!d || !d.ok) {
    toast(`停止失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 5000);
    return;
  }
  if (d.graceful) toast('服务端已正常停止（世界已保存）', 'ok', 4000);
  else toast(d.note || '已强制结束（世界可能未完整保存）', 'warn', 6000);
  refreshStatus();
}

async function downloadJar() {
  const id = view.currentId;
  if (!id) return;
  const s = view.servers.find((x) => x.id === id);
  toast(`正在下载 ${kindLabel(s && s.kind)} 服务端（${(s && s.mcVersion) || ''}）…`, 'info', 4000);
  const r = await call('server:download', { id });
  const d = r && r.ok ? r.data : null;
  if (!d || !d.ok) {
    toast(`下载失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 8000);
    return;
  }
  toast(`服务端已就绪：${d.jar}（${fmtBytes(d.bytes)}）`, 'ok', 5000);
  await loadServers();
  drawSidebar();
  const cur = view.servers.find((x) => x.id === id);
  if (cur) {
    // 刷新头部 badge
    drawMain();
  }
}

async function deleteServer() {
  const id = view.currentId;
  if (!id) return;
  const s = view.servers.find((x) => x.id === id);
  const ok = await confirmDialog({
    title: '删除服务端',
    message: `将删除「${(s && s.name) || id}」的整个目录（含世界、配置、备份）。\n\n这一步不能撤销，确定吗？`,
    okText: '删除',
  });
  if (!ok) return;
  const r = await call('server:remove', { id });
  if (!r.ok) {
    toast(r.error || '删除失败', 'error', 5000);
    return;
  }
  view.currentId = '';
  await loadServers();
  drawSidebar();
  if (view.servers.length) await selectServer(view.servers[0].id);
  else drawEmpty();
  toast('已删除', 'ok', 2500);
}

/* ============================================================
 * 控制台
 * ============================================================ */

function drawConsole(panel) {
  if (!panel) return;
  setHTML(
    panel,
    html`<div class="srv-console">
      <div class="srv-console__bar">
        <span class="srv-console__hint">日志实时刷新；下面可以直接发命令（等价于在服务端控制台输入）</span>
        <span class="grow"></span>
        <button class="btn btn--ghost btn--xs" id="srv-clear-log" type="button">清屏</button>
      </div>
      <pre class="srv-log" id="srv-log"></pre>
      <div class="srv-cmdbar">
        <input class="input" id="srv-cmd" type="text" placeholder="输入命令后回车，例如 list / say 大家好 / gamemode creative 玩家名" autocomplete="off" spellcheck="false" />
        <button class="btn btn--sm" id="srv-cmd-send" type="button">发送</button>
      </div>
      <div class="srv-quick">
        <span class="srv-quick__label">常用：</span>
        <button class="btn btn--ghost btn--xs" type="button" data-cmd="list">list</button>
        <button class="btn btn--ghost btn--xs" type="button" data-cmd="save-all flush">保存世界</button>
        <button class="btn btn--ghost btn--xs" type="button" data-cmd="whitelist reload">重载白名单</button>
        <button class="btn btn--ghost btn--xs" type="button" data-cmd="time set day">设为白天</button>
        <button class="btn btn--ghost btn--xs" type="button" data-cmd="weather clear">清除天气</button>
      </div>
    </div>`
  );
  renderConsole(true);

  const input = panel.querySelector('#srv-cmd');
  const send = async () => {
    const cmd = (input && input.value || '').trim();
    if (!cmd) return;
    const r = await call('server:command', { id: view.currentId, command: cmd });
    if (!r.ok) toast(r.error || '命令没发出去', 'error', 4000);
    else if (input) input.value = '';
  };
  panel.querySelector('#srv-cmd-send')?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });
  panel.querySelector('#srv-clear-log')?.addEventListener('click', () => {
    view.logLines = [];
    renderConsole(true);
  });
  panel.querySelectorAll('[data-cmd]').forEach((b) => {
    b.addEventListener('click', async () => {
      const cmd = b.getAttribute('data-cmd');
      const r = await call('server:command', { id: view.currentId, command: cmd });
      if (!r.ok) toast(r.error || '命令没发出去', 'error', 4000);
    });
  });
}

function renderConsole(full) {
  const pre = view.mount.querySelector('#srv-log');
  if (!pre) return;
  if (full) {
    pre.textContent = view.logLines.slice(-800).join('\n');
  }
  // 滚到底
  pre.scrollTop = pre.scrollHeight;
}

function appendLogLine(line) {
  const pre = view.mount.querySelector('#srv-log');
  if (!pre) return;
  // 只在接近底部时自动跟随，避免玩家往上翻日志时被拽回来
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
  pre.textContent += (pre.textContent ? '\n' : '') + line;
  if (pre.textContent.length > 400000) {
    pre.textContent = pre.textContent.slice(-300000);
  }
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
}

/* ============================================================
 * 配置（46 项 + 预设）
 * ============================================================ */

async function drawConfig(panel) {
  if (!panel) return;
  setHTML(panel, html`<div class="srv-loading">正在读取 server.properties…</div>`);
  const r = await call('server:props:read', { id: view.currentId }, { optional: true });
  const d = r && r.ok ? r.data : null;
  if (!d || !d.ok) {
    setHTML(panel, html`<div class="srv-warn">读不到配置：${(d && d.error) || (r && r.error) || '未知错误'}</div>`);
    return;
  }
  view.props = d;
  view.propsDirty = {};

  const fieldsByGroup = {};
  for (const f of d.fields) {
    (fieldsByGroup[f.group] = fieldsByGroup[f.group] || []).push(f);
  }

  const presetBtns = (d.presets || [])
    .map((p) => `<button class="btn btn--ghost btn--xs" type="button" data-preset="${esc(p.id)}" title="${esc(p.desc)}">${esc(p.label)}</button>`)
    .join('');

  const groupsHtml = (d.groups || [])
    .map((g) => {
      const fields = fieldsByGroup[g.id] || [];
      if (!fields.length) return '';
      const rows = fields.map((f) => renderField(f, d.values[f.key])).join('');
      return `<section class="srv-group">
        <div class="srv-group__head">
          <span class="srv-group__title">${esc(g.label)}</span>
          <span class="srv-group__desc">${esc(g.desc || '')}</span>
        </div>
        <div class="srv-fields">${rows}</div>
      </section>`;
    })
    .join('');

  setHTML(
    panel,
    html`<div class="srv-config">
      <div class="srv-config__bar">
        <span class="srv-config__hint">${d.exists ? '改完点「保存配置」生效；运行中的服务端部分项要重启才生效' : '这是默认配置（文件还没生成），保存后即可用'}</span>
        <span class="grow"></span>
        <span class="srv-config__presets">预设：${raw(presetBtns)}</span>
        <button class="btn btn--sm" id="srv-props-save" type="button">保存配置</button>
      </div>
      <div class="srv-config__body">${raw(groupsHtml)}</div>
    </div>`
  );

  // 输入变更记录
  panel.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.getAttribute('data-key');
    const handler = () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.tagName === 'SELECT') v = el.value;
      else if (el.type === 'number') v = Number(el.value);
      else v = el.value;
      view.propsDirty[key] = v;
      el.classList.add('is-dirty');
    };
    el.addEventListener('change', handler);
    if (el.type === 'text') el.addEventListener('input', handler);
  });

  // 保存
  panel.querySelector('#srv-props-save')?.addEventListener('click', async () => {
    const patch = { ...view.propsDirty };
    if (!Object.keys(patch).length) {
      toast('没有改动', 'info', 2000);
      return;
    }
    const rr = await call('server:props:write', { id: view.currentId, patch });
    const dd = rr && rr.ok ? rr.data : null;
    if (!dd || !dd.ok) {
      toast(`保存失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 6000);
      return;
    }
    toast(`已保存 ${Object.keys(patch).length} 项配置`, 'ok', 3000);
    drawConfig(panel);
  });

  // 预设
  panel.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', async () => {
      const pid = b.getAttribute('data-preset');
      const preset = (d.presets || []).find((p) => p.id === pid);
      const ok = await confirmDialog({
        title: `套用预设「${preset ? preset.label : pid}」`,
        message: `${preset ? preset.desc : ''}\n\n会覆盖这些项，其余配置保持不变。`,
        okText: '套用',
      });
      if (!ok) return;
      const rr = await call('server:props:applyPreset', { id: view.currentId, presetId: pid });
      const dd = rr && rr.ok ? rr.data : null;
      if (!dd || !dd.ok) {
        toast(`套用失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 5000);
        return;
      }
      toast(`已套用「${preset ? preset.label : pid}」`, 'ok', 3000);
      drawConfig(panel);
    });
  });
}

function renderField(f, value) {
  const key = esc(f.key);
  const id = `pf-${esc(f.key)}`;
  const label = `<label class="srv-field__label" for="${id}">${esc(f.label)}<span class="srv-field__key">${key}</span></label>`;
  const desc = `<div class="srv-field__desc">${esc(f.desc || '')}</div>`;
  let control = '';
  if (f.type === 'boolean') {
    control = `<label class="srv-switch"><input type="checkbox" id="${id}" data-key="${key}" ${value ? 'checked' : ''} /><span></span></label>`;
  } else if (f.type === 'enum') {
    const opts = (f.options || []).map((o) => `<option value="${esc(o)}" ${String(o) === String(value) ? 'selected' : ''}>${esc(o)}</option>`).join('');
    control = `<select class="input input--sm" id="${id}" data-key="${key}">${opts}</select>`;
  } else if (f.type === 'number') {
    const min = Number.isFinite(f.min) ? `min="${f.min}"` : '';
    const max = Number.isFinite(f.max) ? `max="${f.max}"` : '';
    control = `<input class="input input--sm" type="number" id="${id}" data-key="${key}" value="${esc(value)}" ${min} ${max} />`;
  } else {
    control = `<input class="input input--sm" type="text" id="${id}" data-key="${key}" value="${esc(value)}" />`;
  }
  return `<div class="srv-field">${label}<div class="srv-field__ctl">${control}</div>${desc}</div>`;
}

/* ============================================================
 * RCON / 玩家
 * ============================================================ */

async function drawRcon(panel) {
  if (!panel) return;
  setHTML(panel, html`<div class="srv-loading">正在连接 RCON…</div>`);

  const pr = await call('server:players', { id: view.currentId }, { optional: true });
  const pd = pr && pr.ok ? pr.data : null;
  const propsR = await call('server:props:read', { id: view.currentId }, { optional: true });
  const propsD = propsR && propsR.ok ? propsR.data : null;
  const rconOn = !!(propsD && propsD.values && propsD.values['enable-rcon']);
  const rconPort = propsD && propsD.values ? propsD.values['rcon.port'] : '—';

  const playerRows = (pd && pd.players && pd.players.length)
    ? pd.players
        .map(
          (n) => `<li class="srv-player">
            <span class="srv-player__name">${esc(n)}</span>
            <span class="grow"></span>
            <button class="btn btn--ghost btn--xs" type="button" data-op="${esc(n)}">设为 OP</button>
            <button class="btn btn--ghost btn--xs" type="button" data-kick="${esc(n)}">踢出</button>
          </li>`
        )
        .join('')
    : '';

  setHTML(
    panel,
    html`<div class="srv-rcon">
      ${!rconOn
        ? html`<div class="srv-warn">
            还没开 RCON。开 RCON 之后可以在这里查在线玩家、发命令、广播，不用一直盯着控制台。
            <div style="margin-top:8px"><button class="btn btn--sm" id="srv-rcon-enable" type="button">一键开启 RCON（自动生成密码）</button></div>
          </div>`
        : html`<div class="srv-rcon__status">
            <span class="srv-rcon__dot ${pd && pd.ok ? 'is-ok' : 'is-bad'}"></span>
            <span>RCON 端口 ${esc(rconPort)} ${pd && pd.ok ? '· 已连通' : `· ${esc((pd && pd.error) || '未连通')}`}</span>
          </div>`}

      <div class="srv-rcon__players">
        <div class="srv-rcon__title">在线玩家 ${pd && pd.ok ? `（${pd.online || 0} / ${pd.max || 0}）` : ''}</div>
        ${playerRows ? `<ul class="srv-players">${raw(playerRows)}</ul>` : html`<div class="srv-dim">${pd && pd.ok ? '当前没有玩家在线' : '拿不到玩家列表（需要服务端运行 + RCON 已开）'}</div>`}
      </div>

      <div class="srv-rcon__cmd">
        <div class="srv-rcon__title">远程命令</div>
        <div class="hstack">
          <input class="input" id="srv-rcon-cmd" type="text" placeholder="例如 list / op 玩家名 / gamerule keepInventory true" autocomplete="off" spellcheck="false" />
          <button class="btn btn--sm" id="srv-rcon-send" type="button">执行</button>
          <button class="btn btn--ghost btn--sm" id="srv-rcon-refresh" type="button">刷新</button>
        </div>
        <pre class="srv-rcon__out" id="srv-rcon-out"></pre>
      </div>

      <div class="srv-rcon__broadcast">
        <div class="srv-rcon__title">全服广播</div>
        <div class="hstack">
          <input class="input" id="srv-bc-text" type="text" placeholder="要说的话" autocomplete="off" />
          <button class="btn btn--ghost btn--sm" id="srv-bc-send" type="button">广播</button>
        </div>
      </div>
    </div>`
  );

  const out = () => panel.querySelector('#srv-rcon-out');
  const runRcon = async (cmd) => {
    if (!cmd) return;
    const o = out();
    if (o) o.textContent = '执行中…';
    const rr = await call('server:rcon', { id: view.currentId, command: cmd });
    const dd = rr && rr.ok ? rr.data : null;
    if (o) o.textContent = (dd && dd.ok && dd.body) || (dd && dd.error) || (rr && rr.error) || '（没有输出）';
  };

  panel.querySelector('#srv-rcon-enable')?.addEventListener('click', async () => {
    const rr = await call('server:enableRcon', { id: view.currentId });
    const dd = rr && rr.ok ? rr.data : null;
    if (!dd || !dd.ok) {
      toast(`开启失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 5000);
      return;
    }
    toast(`RCON 已开启（端口 ${dd.port}${dd.portChanged ? '，原端口被占用已换' : ''}）。重启服务端后生效。`, 'ok', 6000);
    drawRcon(panel);
  });

  panel.querySelector('#srv-rcon-send')?.addEventListener('click', () => {
    const el = panel.querySelector('#srv-rcon-cmd');
    runRcon(((el && el.value) || '').trim());
  });
  panel.querySelector('#srv-rcon-cmd')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const el = panel.querySelector('#srv-rcon-cmd');
      runRcon(((el && el.value) || '').trim());
    }
  });
  panel.querySelector('#srv-rcon-refresh')?.addEventListener('click', () => drawRcon(panel));
  panel.querySelector('#srv-bc-send')?.addEventListener('click', async () => {
    const el = panel.querySelector('#srv-bc-text');
    const text = ((el && el.value) || '').trim();
    if (!text) return;
    const rr = await call('server:rcon', { id: view.currentId, command: `say ${text}` });
    const dd = rr && rr.ok ? rr.data : null;
    if (dd && dd.ok) {
      toast('已广播', 'ok', 2500);
      if (el) el.value = '';
    } else {
      toast(`广播失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 5000);
    }
  });
  // 玩家行按钮
  panel.querySelectorAll('[data-op]').forEach((b) => {
    b.addEventListener('click', async () => {
      const n = b.getAttribute('data-op');
      const rr = await call('server:rcon', { id: view.currentId, command: `op ${n}` });
      const dd = rr && rr.ok ? rr.data : null;
      toast(dd && dd.ok ? `已把 ${n} 设为 OP` : `失败：${(dd && dd.error) || '未知错误'}`, dd && dd.ok ? 'ok' : 'error', 3500);
    });
  });
  panel.querySelectorAll('[data-kick]').forEach((b) => {
    b.addEventListener('click', async () => {
      const n = b.getAttribute('data-kick');
      const ok = await confirmDialog({ title: '踢出玩家', message: `把「${n}」踢出服务器？`, okText: '踢出' });
      if (!ok) return;
      const rr = await call('server:rcon', { id: view.currentId, command: `kick ${n}` });
      const dd = rr && rr.ok ? rr.data : null;
      toast(dd && dd.ok ? `已踢出 ${n}` : `失败：${(dd && dd.error) || '未知错误'}`, dd && dd.ok ? 'ok' : 'error', 3500);
      drawRcon(panel);
    });
  });
}

/* ============================================================
 * 备份
 * ============================================================ */

async function drawBackup(panel) {
  if (!panel) return;
  setHTML(panel, html`<div class="srv-loading">正在读取备份列表…</div>`);
  const r = await call('server:backup:list', { id: view.currentId }, { optional: true });
  const d = r && r.ok ? r.data : null;
  const list = (d && d.list) || [];
  view.backups = list;

  const cur = view.servers.find((x) => x.id === view.currentId);
  const ab = (cur && cur.autoBackup) || {};

  const rows = list.length
    ? list
        .map(
          (b) => `<li class="srv-backup">
            <span class="srv-backup__main">
              <span class="srv-backup__name">${esc(b.name)}</span>
              <span class="srv-backup__meta">${b.created ? fmtRelative(b.created) : ''} · ${fmtBytes(b.bytes || 0)} · ${b.files || 0} 个文件${b.full ? ' · 全量' : ''}${b.reason === 'auto' ? ' · 自动' : ''}</span>
            </span>
            <span class="grow"></span>
            <button class="btn btn--ghost btn--xs" type="button" data-restore="${esc(b.name)}">恢复</button>
            <button class="btn btn--ghost btn--xs" type="button" data-export="${esc(b.name)}">导出 zip</button>
            <button class="btn btn--ghost btn--xs" type="button" data-del="${esc(b.name)}">删除</button>
          </li>`
        )
        .join('')
    : '';

  setHTML(
    panel,
    html`<div class="srv-backup-wrap">
      <div class="srv-backup__bar">
        <button class="btn btn--sm" id="srv-bk-now" type="button">${raw(icon('download', 14))}立即备份世界</button>
        <button class="btn btn--ghost btn--sm" id="srv-bk-full" type="button">全量备份（含模组/配置）</button>
        <span class="grow"></span>
        <span class="srv-dim">共 ${list.length} 份</span>
      </div>

      <div class="srv-autobk">
        <label class="srv-switch"><input type="checkbox" id="srv-abk-on" ${ab.enabled ? 'checked' : ''} /><span></span></label>
        <span class="srv-autobk__label">自动备份</span>
        <span class="srv-dim">每</span>
        <input class="input input--xs" type="number" id="srv-abk-int" min="5" max="1440" value="${ab.intervalMin || 30}" style="width:74px" />
        <span class="srv-dim">分钟一次，保留</span>
        <input class="input input--xs" type="number" id="srv-abk-keep" min="1" max="100" value="${ab.keep || 10}" style="width:64px" />
        <span class="srv-dim">份</span>
        <label class="srv-autobk__full"><input type="checkbox" id="srv-abk-full" ${ab.full ? 'checked' : ''} /> 含模组配置</label>
        <button class="btn btn--ghost btn--xs" id="srv-abk-save" type="button">保存设置</button>
      </div>

      ${rows ? `<ul class="srv-backups">${raw(rows)}</ul>` : html`<div class="srv-dim" style="padding:14px 0">还没有备份。点上面「立即备份世界」创建第一份。</div>`}
    </div>`
  );

  const doBackup = async (full) => {
    toast(full ? '正在全量备份（可能要一会儿）…' : '正在备份世界…', 'info', 4000);
    const rr = await call('server:backup:create', { id: view.currentId, reason: 'manual', full });
    const dd = rr && rr.ok ? rr.data : null;
    if (!dd || !dd.ok) {
      toast(`备份失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 7000);
      return;
    }
    toast(`备份完成：${dd.name}（${fmtBytes(dd.bytes)}）`, 'ok', 4500);
    drawBackup(panel);
  };
  panel.querySelector('#srv-bk-now')?.addEventListener('click', () => doBackup(false));
  panel.querySelector('#srv-bk-full')?.addEventListener('click', () => doBackup(true));

  panel.querySelector('#srv-abk-save')?.addEventListener('click', async () => {
    const enabled = !!panel.querySelector('#srv-abk-on')?.checked;
    const intervalMin = Number(panel.querySelector('#srv-abk-int')?.value) || 30;
    const keep = Number(panel.querySelector('#srv-abk-keep')?.value) || 10;
    const full = !!panel.querySelector('#srv-abk-full')?.checked;
    const rr = await call('server:update', {
      id: view.currentId,
      patch: { autoBackup: { enabled, intervalMin, keep, full } },
    });
    if (!rr.ok) {
      toast(rr.error || '保存失败', 'error', 4000);
      return;
    }
    toast('自动备份设置已保存（下次启动服务端生效）', 'ok', 4000);
    await loadServers();
  });

  panel.querySelectorAll('[data-restore]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.getAttribute('data-restore');
      const ok = await confirmDialog({
        title: '恢复备份',
        message: `用备份「${name}」覆盖当前世界？\n\n当前世界会先改名留底（world.old-时间戳），不会直接删掉。\n恢复前要先停止服务端。`,
        okText: '恢复',
      });
      if (!ok) return;
      const rr = await call('server:backup:restore', { id: view.currentId, name });
      const dd = rr && rr.ok ? rr.data : null;
      if (!dd || !dd.ok) {
        toast(`恢复失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 7000);
        return;
      }
      toast('已恢复。可以启动服务端看看。', 'ok', 4500);
      drawBackup(panel);
    });
  });

  panel.querySelectorAll('[data-export]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.getAttribute('data-export');
      toast('正在打包…', 'info', 3000);
      const rr = await call('server:backup:export', { id: view.currentId, name });
      const dd = rr && rr.ok ? rr.data : null;
      if (!dd || !dd.ok) {
        toast(`打包失败：${(dd && dd.error) || (rr && rr.error) || '未知错误'}`, 'error', 6000);
        return;
      }
      toast(`已导出（${fmtBytes(dd.bytes)}），文件夹已打开`, 'ok', 4500);
    });
  });

  panel.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.getAttribute('data-del');
      const ok = await confirmDialog({ title: '删除备份', message: `删除备份「${name}」？`, okText: '删除' });
      if (!ok) return;
      const rr = await call('server:backup:remove', { id: view.currentId, name });
      if (!rr.ok) {
        toast(rr.error || '删除失败', 'error', 4000);
        return;
      }
      drawBackup(panel);
    });
  });
}

/* ============================================================
 * 诊断
 * ============================================================ */

async function drawDiag(panel) {
  if (!panel) return;
  setHTML(panel, html`<div class="srv-loading">正在分析日志…</div>`);
  const r = await call('server:diagnose', { id: view.currentId }, { optional: true });
  const d = r && r.ok ? r.data : null;
  if (!d || !d.ok) {
    setHTML(panel, html`<div class="srv-warn">拿不到诊断：${(d && d.error) || (r && r.error) || '未知错误'}</div>`);
    return;
  }
  const hints = (d.hints || []).map((h) => `<li>${esc(h)}</li>`).join('');
  const tail = (d.tail || []).join('\n');
  setHTML(
    panel,
    html`<div class="srv-diag">
      <div class="srv-diag__summary">
        <span class="srv-diag__label">结论</span>
        <span class="srv-diag__text">${esc(d.summary || '')}</span>
      </div>
      ${d.exitCode !== null && d.exitCode !== undefined
        ? html`<div class="srv-diag__code">退出码：<b>${esc(String(d.exitCode))}</b></div>`
        : raw('')}
      ${hints ? html`<div class="srv-diag__hints"><div class="srv-diag__label">可能的原因</div><ul>${raw(hints)}</ul></div>` : raw('')}
      ${tail ? html`<div class="srv-diag__label">日志里的关键行（可直接复制反馈）</div><pre class="srv-diag__tail">${raw(esc(tail))}</pre>` : html`<div class="srv-dim">日志里没有异常行</div>`}
      <div class="hstack" style="margin-top:10px">
        <button class="btn btn--ghost btn--sm" id="srv-diag-refresh" type="button">重新诊断</button>
        <button class="btn btn--ghost btn--sm" id="srv-diag-logs" type="button">打开日志目录</button>
      </div>
    </div>`
  );
  panel.querySelector('#srv-diag-refresh')?.addEventListener('click', () => drawDiag(panel));
  panel.querySelector('#srv-diag-logs')?.addEventListener('click', () => call('server:openDir', { id: view.currentId, what: 'logs' }));
}

/* ============================================================
 * 新建服务端
 * ============================================================ */

/**
 * 新建服务端对话框。
 *
 * ★★★ 2026-11-22 修（用户反馈「点新建服务端按钮还点不动」）。
 *   初版自己手写了一个 `.modal-overlay` + `.modal` 的浮层，但项目 CSS 里
 *   **只有 `.modal`、没有 `.modal-overlay`** —— 结果这个 div 被当成普通块元素
 *   塞进文档流末尾（页面滚到底才能看到），点了按钮看起来毫无反应。
 *   ⇒ 改用项目统一的 `openModal()`（走 #modal-root、带遮罩与关闭按钮）。
 */
async function openCreateDialog() {
  const optR = await call('server:options', {}, { optional: true });
  const opt = optR && optR.ok ? optR.data : null;
  const kinds = (opt && opt.kinds) || [
    { id: 'vanilla', label: '原版' },
    { id: 'paper', label: 'Paper' },
    { id: 'purpur', label: 'Purpur' },
    { id: 'fabric', label: 'Fabric' },
  ];
  const versions = (opt && opt.versions) || [];
  const builtin = (opt && opt.builtin) || [];

  const kindHint = {
    vanilla: '原版：Mojang 官方服务端。远古版本会自动找 Betacraft 归档里官方已下架的那些。',
    paper: 'Paper：性能好、支持插件。支持 1.7.10 到最新（含 26.x）。',
    purpur: 'Purpur：Paper 的增强分支，配置项更多。',
    fabric: 'Fabric：要开模组服就选它。',
  };

  const body = `
    <div class="field">
      <div class="field__label">名称</div>
      <input class="input" id="sc-name" type="text" placeholder="例如 和朋友玩的世界" autocomplete="off" />
    </div>
    <div class="field">
      <div class="field__label">服务端核心</div>
      <div class="srv-kinds" id="sc-kinds">
        ${kinds.map((k, i) => `<button class="srv-kind ${i === 0 ? 'is-active' : ''}" type="button" data-kind="${esc(k.id)}">${esc(k.label)}</button>`).join('')}
      </div>
      <div class="field__hint" id="sc-kind-hint">${esc(kindHint.vanilla)}</div>
    </div>
    <div class="field">
      <div class="field__label">游戏版本</div>
      ${
        versions.length
          ? `<select class="input" id="sc-version">${versions.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`
          : `<input class="input" id="sc-version" type="text" placeholder="例如 1.20.1（拿不到版本清单，手动填）" />`
      }
      <div class="field__hint">${versions.length ? `共 ${versions.length} 个正式版` : esc((opt && opt.versionsError) || '拿不到官方版本清单，手动填版本号即可')}</div>
    </div>
    <div class="field">
      <div class="field__label">手动指定版本号（可选）</div>
      <input class="input" id="sc-version-manual" type="text" placeholder="远古版/快照直接填，如 b1.7.3 / b1.9-pre1 / 1.0.0 / 13w16a" autocomplete="off" />
      <div class="field__hint">填了就用这里的版本，优先于上面的下拉框。官方已下架的版本会自动从 Betacraft 归档拿。</div>
    </div>
    ${
      builtin.length
        ? `<div class="field">
            <div class="field__label">内置社区服务端</div>
            <div class="field__hint">${
              builtin.map((b) => `· ${esc(b.label)}：${esc(b.covers && b.covers.length ? b.covers.length + ' 个版本' : '')}`).join('<br />')
            }<br />Infdev 官方从没发过服务端；Beta 1.7.3 想要插件支持也得用这个。下载时会自动优先用内置。</div>
          </div>`
        : ''
    }
  `;

  return new Promise((resolve) => {
    let kind = 'vanilla';
    openModal({
      title: '新建服务端',
      body,
      buttons: [
        { text: '取消', kind: 'ghost', value: 'cancel' },
        { text: '创建', value: 'ok' },
      ],
      onMount: (root) => {
        pendingCreateForm = { kind: 'vanilla', name: '', version: '', manual: '' };
        root.querySelectorAll('[data-kind]').forEach((b) => {
          b.addEventListener('click', () => {
            kind = b.getAttribute('data-kind');
            if (pendingCreateForm) pendingCreateForm.kind = kind;
            root.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('is-active', x === b));
            const h = root.querySelector('#sc-kind-hint');
            if (h) h.textContent = kindHint[kind] || '';
          });
        });
        // 每次输入都同步到暂存对象（modal 关闭时 DOM 会被清空）
        const bindInput = (sel, key) => {
          const el = root.querySelector(sel);
          if (!el) return;
          const sync = () => {
            if (pendingCreateForm) pendingCreateForm[key] = el.value;
          };
          el.addEventListener('input', sync);
          el.addEventListener('change', sync);
          sync();
        };
        bindInput('#sc-name', 'name');
        bindInput('#sc-version', 'version');
        bindInput('#sc-version-manual', 'manual');
      },
    }).then(async (val) => {
      if (val !== 'ok') {
        resolve(null);
        return;
      }
      // openModal 关闭后 DOM 已清，所以要在 onMount 里暂存取值
      const picked = pendingCreateForm || {};
      pendingCreateForm = null;
      const name = String(picked.name || '').trim();
      const mcVersion = String(picked.manual || picked.version || '').trim();
      if (!mcVersion) {
        toast('请填游戏版本', 'error', 3500);
        resolve(null);
        return;
      }
      const r = await call('server:create', { name: name || `服务端 ${mcVersion}`, kind: picked.kind || 'vanilla', mcVersion });
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok) {
        toast(`创建失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 6000);
        resolve(null);
        return;
      }
      await loadServers();
      drawSidebar();
      view.currentId = d.server.id;
      await selectServer(d.server.id);
      toast('已创建，接着点「下载服务端」把 jar 拉下来', 'ok', 6000);
      resolve(d.server.id);
    });
  });
}

/** 暂存新建对话框里填的值（modal 关闭会清 DOM，必须提前取） */
let pendingCreateForm = null;

/* ============================================================
 * 事件绑定（页面级）
 * ============================================================ */

function bindEvents() {
  view.mount.querySelector('#srv-new')?.addEventListener('click', openCreateDialog);
}

/* ============================================================
 * 小工具
 * ============================================================ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 清理轮询（页面卸载时兜底） */
function stopPolling() {
  if (view.pollTimer) {
    clearInterval(view.pollTimer);
    view.pollTimer = null;
  }
}
