'use strict';
/**
 * 用**用户真实数据目录**验证头像与主界面人物（只读，不修改任何东西）
 *
 * 目的：确认「HaoGE201123 的正版皮肤」能正确显示成
 *   ① 右栏头像（从皮肤裁出的脸 + 帽子层）
 *   ② 主界面 3D 人物（套上这张皮肤）
 *
 * 用法：node build\verify-real-account.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT = path.join(ROOT, 'docs', '_real-account.png');
const inner = path.join(__dirname, '_real-acc-inner.js');

if (!fs.existsSync(REAL_HOME)) {
  console.error(`找不到真实数据目录：${REAL_HOME}`);
  process.exit(1);
}

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(REAL_HOME)};
const SHOT = ${JSON.stringify(SHOT)};

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404', { status: 404 }); }
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
  await new Promise((r) => setTimeout(r, 20000));

  const info = await win.webContents.executeJavaScript(\`
    (async () => {
      const out = {};
      // 账号
      const accounts = window.qcl ? await window.qcl.invoke('accounts:list', {}) : null;
      out.账号 = accounts ? accounts.map(a => ({ name: a.name, type: a.type, selected: a.selected, 有皮肤: !!a.avatar })) : null;

      // 右栏头像：看 img.src 是 data: 还是默认图
      const av = document.querySelector('#account-avatar');
      out.头像 = av ? {
        src前缀: String(av.src).slice(0, 40),
        是裁出的脸: String(av.src).startsWith('data:image/png'),
        尺寸: av.naturalWidth + 'x' + av.naturalHeight,
        名字栏: (document.querySelector('#account-name')||{}).textContent,
      } : null;

      // 主界面人物
      const v = window.__qclSkinViewer;
      out.人物 = v ? {
        ready: v.ready,
        style: v.style,
        有贴图: !!v.texture,
        皮肤来源栏: (document.querySelector('#skin-name')||{}).textContent,
      } : null;
      return out;
    })()
  \`).catch(e => ({ 执行失败: String(e && e.message) }));

  console.log('REAL ' + JSON.stringify(info, null, 2));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('SHOT ' + SHOT);
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-realacc');
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
