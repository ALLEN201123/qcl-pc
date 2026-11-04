'strict';
/** 诊断实验室页：是否超出屏幕、能否滚动 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_lab-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};

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
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 12000));

  // 找 lab 页入口（左栏或工具页里）
  const navItems = await win.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-nav]')).map(b => b.getAttribute('data-nav'))"
  );
  console.log('NAV ' + JSON.stringify(navItems));

  // 直接看 lab 是否注册为页面，用 router 跳过去
  await win.webContents.executeJavaScript(\`
    (async () => {
      // 通过内容区找一个能进 lab 的按钮
      const btns = Array.from(document.querySelectorAll('button, a'));
      const hit = btns.find(x => /实验室|lab/i.test(x.textContent || '') || /lab/i.test(x.getAttribute('data-nav') || ''));
      if (hit) { hit.click(); return 'clicked:' + (hit.textContent||'').trim().slice(0,20); }
      return 'not-found';
    })()
  \`).then((r) => console.log('ENTER ' + r));

  await new Promise((r) => setTimeout(r, 2000));

  const info = await win.webContents.executeJavaScript(\`
    (() => {
      const body = document.querySelector('.page__body');
      const panel = document.querySelector('.page--panel');
      const content = document.getElementById('content');
      const scrollArea = document.querySelector('.main__content, #content');
      const vh = window.innerHeight;
      return {
        当前页: document.querySelector('.page__title') ? document.querySelector('.page__title').textContent : null,
        视口高: vh,
        面板高: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        面板底部: panel ? Math.round(panel.getBoundingClientRect().bottom) : null,
        内容区高: content ? Math.round(content.getBoundingClientRect().height) : null,
        内容区底部: content ? Math.round(content.getBoundingClientRect().bottom) : null,
        body可滚: body ? (body.scrollHeight > body.clientHeight) : null,
        body_scrollHeight: body ? body.scrollHeight : null,
        body_clientHeight: body ? body.clientHeight : null,
        body_overflow: body ? getComputedStyle(body).overflow : null,
        面板overflow: panel ? getComputedStyle(panel).overflow : null,
        是否超出屏幕: panel ? (panel.getBoundingClientRect().bottom > vh) : null,
      };
    })()
  \`);
  console.log('LAB_INFO ' + JSON.stringify(info, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_lab-diag.png'), img.toPNG());
  console.log('SHOT docs/_lab-diag.png');

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-lab');
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
