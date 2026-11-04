'use strict';
/** 最小化验证：launch:start 返回什么 + launch:stage 有没有到渲染层 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_min-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
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
    width: 1600, height: 900, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 12000));

  // 直接调 launch:start，看返回
  const ret = await win.webContents.executeJavaScript(\`
    (async () => {
      const list = await window.qcl.invoke('instances:list', {});
      const id = list[0].id;
      // 先挂事件监听
      window.__ev = [];
      window.qcl.on('launch:stage', (p) => window.__ev.push({ t: 'stage', p }));
      window.qcl.on('launch:state', (p) => window.__ev.push({ t: 'state', p }));
      try {
        const r = await window.qcl.invoke('launch:start', { id });
        return { ok: true, r: JSON.parse(JSON.stringify(r)) };
      } catch (e) {
        return { ok: false, err: String(e && e.message) };
      }
    })()
  \`);
  console.log('LAUNCH_START ' + JSON.stringify(ret));

  await new Promise((r) => setTimeout(r, 6000));

  const ev = await win.webContents.executeJavaScript('window.__ev || []');
  console.log('EVENTS_COUNT ' + ev.length);
  console.log('EVENTS ' + JSON.stringify(ev.slice(0, 12)));

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
const userData = path.join(ROOT, '.cache', 'userdata-min');
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
