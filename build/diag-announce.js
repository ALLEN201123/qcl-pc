'use strict';
/**
 * 公告翻页诊断：渲染首页 → 读当前公告 → 点 ◀ → 再读 → 判断是否真的换了
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const inner = path.join(__dirname, '_ann-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = ${JSON.stringify(ROOT)};
protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404', { status: 404 }); }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: ROOT, homeOverride: path.join(ROOT, '.probe-home') });
  settings.load();
  require(path.join(ROOT, 'src', 'main', 'ipc.js')).initContext({ settings });
  require(path.join(ROOT, 'src', 'main', 'ipc.js')).registerIpc();

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('[渲染层错误]', msg); });
  win.webContents.on('did-fail-load', (_e, c, d, u) => console.log('[加载失败]', c, d, u));
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 20000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 14000));

  const read = async () => {
    return await win.webContents.executeJavaScript(\`
      (() => {
        const slot = document.querySelector('#announce-slot');\n        const dateEl = document.querySelector('#announce-date');
        const mountEl = document.querySelector('#content');
        const homeEl = document.querySelector('.home');
        const titleEl = document.querySelector('.announce__head-title');
        const prev = document.querySelector('#announce-prev');
        const next = document.querySelector('#announce-next');
        return {\n          槽存在: !!slot,
          有home: !!homeEl,
          content子节点: mountEl ? mountEl.childElementCount : -1,\n          槽HTML长度: slot ? slot.innerHTML.length : 0,\n          槽HTML前200: slot ? slot.innerHTML.slice(0,200) : null,
          日期文本: dateEl ? dateEl.textContent : null,
          标题: titleEl ? titleEl.textContent : null,
          prev禁用: prev ? prev.disabled : null,
          next禁用: next ? next.disabled : null,
        };
      })()
    \`);
  };

  console.log('初始:', JSON.stringify(await read(), null, 0));

  // 点 ◀（下一条？）
  await win.webContents.executeJavaScript("document.querySelector('#announce-prev')?.click()");
  await new Promise((r) => setTimeout(r, 800));
  console.log('点◀后:', JSON.stringify(await read(), null, 0));

  await win.webContents.executeJavaScript("document.querySelector('#announce-prev')?.click()");
  await new Promise((r) => setTimeout(r, 800));
  console.log('再点◀后:', JSON.stringify(await read(), null, 0));

  await win.webContents.executeJavaScript("document.querySelector('#announce-next')?.click()");
  await new Promise((r) => setTimeout(r, 800));
  console.log('点▶后:', JSON.stringify(await read(), null, 0));

  app.exit(0);
}).catch((e) => { console.log('FATAL', e && e.stack || e); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-ann');
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
