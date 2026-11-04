'use strict';
/**
 * 验证 PC 版皮肤库：
 *   ① 弹窗能打开、双栏布局生效
 *   ② 查询真实玩家能出 3D 预览
 *   ③ 披风能显示
 *   ④ 历史记录能写入
 *   ⑤ 截图
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_sl2-inner.js');

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
  await new Promise((r) => setTimeout(r, 16000));

  // 打开皮肤库
  const opened = await win.webContents.executeJavaScript(\`
    (async () => {
      const mod = await import('./js/skinlibrary.js');
      const accts = await window.qcl.invoke('accounts:list', {});
      const cur = (accts || []).find((a) => a.selected) || (accts || [])[0] || null;
      // 不 await（它会等到用户关闭）
      window.__sl2Promise = mod.openSkinLibrary({ account: cur });
      await new Promise((r) => setTimeout(r, 900));
      const m = document.querySelector('.modal--skinlib2');
      if (!m) return { open: false };
      return {
        open: true,
        title: (m.querySelector('.modal__title') || {}).textContent,
        hint: (m.querySelector('.sl2-headhint') || {}).textContent,
        hasSide: !!m.querySelector('.sl2-side'),
        hasMain: !!m.querySelector('.sl2-main'),
        hasCanvas: !!m.querySelector('#sl2-canvas'),
        hasHistory: !!m.querySelector('#sl2-history'),
        hasLocal: !!m.querySelector('#sl2-local'),
        emptyShown: !(m.querySelector('#sl2-empty') || {}).hidden,
        gridCols: getComputedStyle(m.querySelector('.sl2-body')).gridTemplateColumns,
        applyText: (m.querySelector('#sl2-apply') || {}).textContent.trim(),
      };
    })()
  \`);
  console.log('OPEN ' + JSON.stringify(opened, null, 2));

  const shot1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_sl2-empty.png'), shot1.toPNG());
  console.log('SHOT docs/_sl2-empty.png');

  // 查询一个真实玩家（用 HaoGE201123，有皮肤+披风）
  const query = await win.webContents.executeJavaScript(\`
    (async () => {
      const m = document.querySelector('.modal--skinlib2');
      if (!m) return { err: 'no modal' };
      const input = m.querySelector('#sl2-name');
      input.value = 'HaoGE201123';
      m.querySelector('#sl2-go').click();
      // 等查询 + 下载 + 3D 载入
      await new Promise((r) => setTimeout(r, 12000));
      const canvas = m.querySelector('#sl2-canvas');
      return {
        tip: (m.querySelector('#sl2-tip') || {}).textContent,
        status: (m.querySelector('#sl2-status') || {}).textContent,
        detailName: (m.querySelector('.sl2-detail__name') || {}).textContent,
        badges: Array.from(m.querySelectorAll('.sl2-badges .badge')).map((b) => b.textContent),
        emptyHidden: !!(m.querySelector('#sl2-empty') || {}).hidden,
        canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
        applyEnabled: !(m.querySelector('#sl2-apply') || {}).disabled,
        history: Array.from(m.querySelectorAll('.sl2-chip')).map((x) => x.textContent),
      };
    })()
  \`);
  console.log('QUERY ' + JSON.stringify(query, null, 2));

  const shot2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_sl2-preview.png'), shot2.toPNG());
  console.log('SHOT docs/_sl2-preview.png');

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-sl2');
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
