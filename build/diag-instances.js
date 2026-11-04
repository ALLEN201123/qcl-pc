'use strict';
/**
 * 诊断：为什么「明明下载过版本，主页却显示没有」+「26.x 显示退出码 1」
 *
 * 用真实数据目录启动，检查：
 *   ① 主进程 instances:list 的真实返回
 *   ② 渲染层 state.instances / currentInstance 的真实值
 *   ③ 右栏版本行显示的文字
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT = path.join(ROOT, 'docs', '_diag-instances.png');
const inner = path.join(__dirname, '_diag-inst-inner.js');

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
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404', { status: 404 }); }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: path.dirname(HOME), homeOverride: HOME });
  settings.load();
  console.log('MAIN home() =', settings.value('home'));
  console.log('MAIN selectedInstance =', settings.value('selectedInstance'));

  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  const instMod = require(path.join(ROOT, 'src', 'main', 'core', 'instances.js'));
  const list = await instMod.list(settings.value('home'));
  console.log('MAIN instances.list() =', JSON.stringify(list.map(x => ({id:x.id,name:x.name,mc:x.mcVersion})), null, 0));

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 18000));

  const info = await win.webContents.executeJavaScript(\`
    (async () => {
      const out = {};
      // 直接问主进程
      out.IPC列表 = await window.qcl.invoke('instances:list', {}).then(r => (r||[]).map(x => ({name:x.name,mc:x.mcVersion,selected:x.selected}))).catch(e => 'ERR:'+e.message);
      // 渲染层的 store
      out.页面版本行 = (document.getElementById('version-text')||{}).textContent;
      out.页面版本图标 = (document.getElementById('version-icon')||{}).src;
      out.启动按钮 = (document.querySelector('.launch-btn, #launch-btn')||{}).textContent;
      // 版本列表页能列出几个
      try {
        out.当前页 = window.__qclDebug && window.__qclDebug.current ? window.__qclDebug.current() : '?';
      } catch(e) {}
      return out;
    })()
  \`).catch(e => ({ 执行失败: String(e && e.message) }));

  console.log('RENDER ' + JSON.stringify(info, null, 2));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(${JSON.stringify(SHOT)}, img.toPNG());
  console.log('SHOT ' + ${JSON.stringify(SHOT)});
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-diag-inst');
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
