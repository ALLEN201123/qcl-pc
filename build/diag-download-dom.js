'use strict';
/** 查下载页真实 DOM：分类 tab / 卡片 / 安装按钮的选择器 + 依赖弹窗能否触发 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_dom-inner.js');

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
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 14000));

  // 进下载页
  await win.webContents.executeJavaScript("(document.querySelector('[data-nav=\\"download\\"]')||{}).click()");
  await new Promise((r) => setTimeout(r, 2500));

  const dom = await win.webContents.executeJavaScript(\`
    (() => {
      const pick = (sel) => Array.from(document.querySelectorAll(sel)).map((x) => ({
        cls: x.className,
        txt: (x.textContent || '').trim().slice(0, 24),
        attr: x.getAttribute('data-cat') || x.getAttribute('data-t') || x.getAttribute('data-act') || x.getAttribute('data-nav') || '',
      }));
      return {
        分类候选_tab: pick('[data-cat]').slice(0, 12),
        分段按钮: pick('.segmented__item').slice(0, 8),
        所有带data的按钮: pick('button[data-act], button[data-cat], button[data-t]').slice(0, 12),
        侧栏元素: pick('.dl__side, .dl__side-tab, .dl__cat').slice(0, 8),
        安装按钮数: document.querySelectorAll('[data-act="install"]').length,
        卡片数: document.querySelectorAll('.dlcard').length,
        搜索框: document.querySelectorAll('#dl-search, .dl__search').length,
      };
    })()
  \`);
  console.log('DOM ' + JSON.stringify(dom, null, 2));

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-dom');
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
