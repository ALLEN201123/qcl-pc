'use strict';
/** 精确 dump 启动窗口某个阶段的真实 outerHTML / className */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_dump-inner.js');

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

  // 用最小方式开窗口：直接 import 模块开窗（不启动游戏）
  const r = await win.webContents.executeJavaScript(\`
    (async () => {
      const mod = await import('./js/launchwindow.js');
      mod.openLaunchWindow({ instance: { name: 'TEST', mcVersion: '26.3' }, extra: '测试' });
      await new Promise((r) => setTimeout(r, 200));
      const items = Array.from(document.querySelectorAll('.lw__stage'));
      const first = items[0];
      // 手动触发一次 stage，看状态变化
      mod.markStage('resolve', 'x');
      await new Promise((r) => setTimeout(r, 100));
      const after = Array.from(document.querySelectorAll('.lw__stage')).map((x) => x.className);
      return {
        count: items.length,
        firstClass: first ? first.className : null,
        firstHTML: first ? first.outerHTML.slice(0, 300) : null,
        afterClasses: after,
        hasCss: (() => {
          let found = false;
          for (const ss of document.styleSheets) {
            try {
              for (const rule of ss.cssRules || []) {
                if (rule.selectorText && rule.selectorText.indexOf('lw__stage--') >= 0) { found = true; break; }
              }
            } catch (e) {}
          }
          return found;
        })(),
      };
    })()
  \`);
  console.log('DUMP ' + JSON.stringify(r, null, 2));

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-dump');
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
