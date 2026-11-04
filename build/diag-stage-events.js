'use strict';
/**
 * 精确诊断：launch:stage 事件到底有没有到达渲染层
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_stage-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(REAL_HOME)};

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

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
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (msg && (msg.indexOf('QCL') >= 0 || msg.indexOf('stage') >= 0 || msg.indexOf('阶段') >= 0)) {
      console.log('[R] ' + msg);
    }
  });

  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 16000));

  // ① 直接在页面里挂一个原始 IPC 监听（绕过 bridge），看事件有没有到
  await win.webContents.executeJavaScript(\`
    window.__rawStages = [];
    window.__busStages = [];
    // 原始通道（preload 暴露的 on）
    if (window.qcl && window.qcl.on) {
      window.qcl.on('launch:stage', (p) => window.__rawStages.push(p));
    }
  \`);
  console.log('HOOK 已挂');

  // ② 点启动
  await win.webContents.executeJavaScript("document.getElementById('launch-btn').click()");
  console.log('CLICKED');

  await new Promise((r) => setTimeout(r, 5000));

  const raw = await win.webContents.executeJavaScript('window.__rawStages || []');
  console.log('RAW_STAGE_EVENTS ' + JSON.stringify(raw));

  const domStages = await win.webContents.executeJavaScript(\`
    (() => {
      const m = document.querySelector('.modal--launching');
      if (!m) return { noModal: true };
      return Array.from(m.querySelectorAll('.lw__stage')).map(x => ({
        n: (x.querySelector('.lw__label')||{}).textContent,
        c: x.className,
      }));
    })()
  \`);
  console.log('DOM_STAGES ' + JSON.stringify(domStages));

  // 收尾
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
const userData = path.join(ROOT, '.cache', 'userdata-stage');
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
