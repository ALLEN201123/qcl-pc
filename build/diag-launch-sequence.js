'use strict';
/**
 * 诊断：真实启动 26.3，记录 launch 事件时序
 * 目的：查清「步骤一次性全完成」「等待游戏窗口秒关」「启动器也关了」的真因
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_seq-inner.js');
const OUT = path.join(ROOT, 'docs', '_launch-seq.json');

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
  console.log('[TL] ' + String(Date.now() - t0).padStart(6) + 'ms  ' + ev + (data ? '  ' + JSON.stringify(data).slice(0, 120) : ''));
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

  // ★ 关键：主进程侧监听所有 launch 事件（这是真源头）
  const origSend = ipcMod.__sendForTest;
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 16000));

  // 在渲染层挂监听，记录事件到达时序
  await win.webContents.executeJavaScript(\`
    (() => {
      window.__seq = [];
      const t0r = performance.now();
      const hook = (name) => {
        window.qcl.on(name, (p) => {
          window.__seq.push({ t: Math.round(performance.now() - t0r), ev: name, data: p ? JSON.parse(JSON.stringify(p).slice(0, 0) || JSON.stringify(p)).slice(0, 0) || p : null });
        });
      };
      ['launch:state','launch:stage','launch:game-ready','launch:log'].forEach(hook);
      return true;
    })()
  \`);

  // 记录窗口是否被关闭
  let winClosed = false;
  win.on('closed', () => { winClosed = true; rec('WINDOW_CLOSED', {}); });

  // 记录 app 是否退出
  app.on('before-quit', () => rec('APP_BEFORE_QUIT', {}));
  app.on('window-all-closed', () => rec('APP_WINDOW_ALL_CLOSED', {}));

  // 真启动
  rec('CLICK_LAUNCH', {});
  const t1 = Date.now();
  const r = await win.webContents.executeJavaScript(\`
    (async () => {
      const list = await window.qcl.invoke('instances:list', {});
      const id = list[0].id;
      try {
        const res = await window.qcl.invoke('launch:start', { id });
        return { ok: true, r: JSON.parse(JSON.stringify(res)) };
      } catch (e) {
        return { ok: false, err: String(e && e.message) };
      }
    })()
  \`);
  rec('LAUNCH_START_RETURN', { ms: Date.now() - t1, ok: r.ok, r: r.r, err: r.err });

  // 等 30 秒，观察事件与窗口状态
  for (let i = 0; i < 15; i++) {
    await new Promise((rr) => setTimeout(rr, 2000));
    const st = await win.webContents.executeJavaScript(\`
      (() => {
        const m = document.querySelector('.modal--launching');
        return {
          modalOpen: !!m,
          stages: m ? Array.from(m.querySelectorAll('.lw__stage')).map(x => ({
            n: (x.querySelector('.lw__label')||{}).textContent,
            c: x.className.replace('lw__stage lw__stage--',''),
          })) : null,
          meta: m ? (m.querySelector('.lw__meta')||{}).textContent : null,
          seqLen: (window.__seq || []).length,
        };
      })()
    \`);
    rec('POLL_' + (i + 1), { modalOpen: st.modalOpen, meta: st.meta, seqLen: st.seqLen });
    if (!st.modalOpen && i > 0) {
      rec('MODAL_CLOSED_AT', { sec: (i + 1) * 2 });
      break;
    }
  }

  // 导出渲染层收到的事件序列
  const seq = await win.webContents.executeJavaScript('window.__seq || []');
  fs.writeFileSync(OUT, JSON.stringify({ timeline, rendererSeq: seq, winClosed }, null, 2));
  console.log('SEQ_WRITTEN ' + OUT);
  console.log('RENDERER_EVENTS ' + JSON.stringify(seq.map((s) => s.ev + '@' + s.t)));

  // 收尾：杀掉游戏
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
const userData = path.join(ROOT, '.cache', 'userdata-seq');
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
