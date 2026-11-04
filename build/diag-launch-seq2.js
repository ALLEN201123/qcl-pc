'use strict';
/**
 * 诊断 v2：真正点击「启动游戏」按钮，记录：
 *   - 渲染层收到的 launch 事件时序
 *   - 启动窗口每个阶段的状态变化（是真的逐个点亮还是瞬间全绿）
 *   - 窗口何时关闭、启动器窗口是否还在
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_seq2-inner.js');
const OUT = path.join(ROOT, 'docs', '_launch-seq2.json');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const OUT = ${JSON.stringify(OUT)};

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const t0 = Date.now();
const timeline = [];
const rec = (ev, data) => {
  timeline.push({ t: Date.now() - t0, ev, data });
  console.log('[TL] ' + String(Date.now() - t0).padStart(6) + '  ' + ev + (data !== undefined ? '  ' + JSON.stringify(data).slice(0, 200) : ''));
};

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404'); }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: path.dirname(HOME), homeOverride: HOME });
  settings.load();
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);

  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 16000));

  // ★ 干净的事件 hook（只用 JSON.stringify，不嵌套 parse）
  await win.webContents.executeJavaScript(\`
    (() => {
      window.__seq = [];
      const t = performance.now();
      ['launch:state', 'launch:stage', 'launch:game-ready'].forEach((name) => {
        window.qcl.on(name, (p) => {
          let flat = null;
          try { flat = JSON.stringify(p).slice(0, 200); } catch (e) { flat = 'ERR'; }
          window.__seq.push({ t: Math.round(performance.now() - t), ev: name, flat });
        });
      });
      return window.__seq.length;
    })()
  \`);
  rec('HOOK_READY');

  let winClosed = false;
  win.on('closed', () => { winClosed = true; rec('WIN_CLOSED'); });
  app.on('before-quit', () => rec('BEFORE_QUIT'));
  app.on('window-all-closed', () => rec('WINDOW_ALL_CLOSED'));

  // ★ 真点击按钮
  const clicked = await win.webContents.executeJavaScript(\`
    (() => {
      const b = document.getElementById('launch-btn');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked:' + b.textContent.trim();
    })()
  \`);
  rec('CLICKED', clicked);

  // 每 400ms 采样窗口阶段状态，最长 40 秒
  let lastSig = '';
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const st = await win.webContents.executeJavaScript(\`
      (() => {
        const m = document.querySelector('.modal--launching');
        const seq = window.__seq || [];
        if (!m) return { open: false, seqLen: seq.length, seq: seq.slice(-6) };
        const stages = Array.from(m.querySelectorAll('.lw__stage')).map((x) => {
          const cls = x.className || '';
          const m2 = cls.match(/lw__stage--(\\w+)/);
          return ((x.querySelector('.lw__label') || {}).textContent || '') + '=' + (m2 ? m2[1] : '?');
        });
        return {
          open: true,
          title: (m.querySelector('.modal__title') || {}).textContent,
          stages,
          meta: (m.querySelector('.lw__meta') || {}).textContent,
          log: (m.querySelector('.lw__log') || {}).textContent,
          seqLen: seq.length,
        };
      })()
    \`);

    if (st.open) {
      const sig = (st.stages || []).join('|') + '#' + (st.meta || '');
      if (sig !== lastSig) {
        rec('STAGE_STATE', { sec: ((i + 1) * 0.4).toFixed(1), stages: st.stages, meta: st.meta, log: (st.log || '').slice(0, 60) });
        lastSig = sig;
      }
    } else if (lastSig !== 'CLOSED') {
      rec('MODAL_CLOSED', { sec: ((i + 1) * 0.4).toFixed(1), seqLen: st.seqLen, seq: st.seq });
      lastSig = 'CLOSED';
      // 关窗后继续观察 8 秒，看启动器窗口是否还在
      await new Promise((r) => setTimeout(r, 8000));
      rec('AFTER_CLOSE', { winClosed, winDestroyed: win.isDestroyed() });
      break;
    }
  }

  const seq = await win.webContents.executeJavaScript('window.__seq || []');
  rec('SEQ_COUNT', seq.length);
  seq.forEach((s) => rec('EV', s));

  fs.writeFileSync(OUT, JSON.stringify({ timeline, seq, winClosed }, null, 2));
  console.log('SEQ_WRITTEN ' + OUT);

  try {
    const id = await win.webContents.executeJavaScript("window.qcl.invoke('instances:list', {}).then(l => l[0].id)");
    await win.webContents.executeJavaScript("window.qcl.invoke('launch:kill', { id: '" + id + "' })");
  } catch (e) {}

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-seq2');
fs.mkdirSync(userData, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'inherit' });
child.on('exit', (code) => {
  try {
    fs.unlinkSync(inner);
  } catch {
    /* ignore */
  }
  process.exitCode = code ?? 0;
});
