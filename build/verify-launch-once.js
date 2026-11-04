'use strict';
/**
 * 验证「点一次启动游戏」的响应速度与行为。
 *
 * 检查：
 *   ① 点击到 launch:start 被调用之间隔多久（应 < 500ms）
 *   ② 是否还有「第二次确认弹窗」（不应有）
 *   ③ 预热后 precheck 多久返回
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT = path.join(ROOT, 'docs', '_launch-once.png');
const inner = path.join(__dirname, '_lo-inner.js');

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
  await new Promise((r) => setTimeout(r, 18000));   // 等预热完成

  // ① 预热后 precheck 耗时（在渲染层里量）
  const preTime = await win.webContents.executeJavaScript(\`
    (async () => {
      const list = await window.qcl.invoke('instances:list', {});
      const t0 = performance.now();
      await window.qcl.invoke('launch:precheck', { id: list[0].id });
      return Math.round(performance.now() - t0);
    })()
  \`);
  console.log('PRECHECK_MS ' + preTime);

  // ② 拦截 launch:start，量「点击 → 真正启动」的间隔
  await win.webContents.executeJavaScript(\`
    window.__launchTimeline = [];
    const orig = window.qcl.invoke;
    window.qcl.invoke = function (ch, payload) {
      if (ch === 'launch:start') window.__launchTimeline.push({ ev: 'start', at: Math.round(performance.now()) });
      if (ch === 'launch:precheck') window.__launchTimeline.push({ ev: 'precheck', at: Math.round(performance.now()) });
      return orig.apply(this, arguments);
    };
    window.__clickAt = 0;
  \`);

  // ③ 点按钮，记录点击时刻
  await win.webContents.executeJavaScript(\`
    (() => {
      window.__clickAt = Math.round(performance.now());
      const btn = document.getElementById('launch-btn');
      if (btn) btn.click();
      return !!btn;
    })()
  \`);

  await new Promise((r) => setTimeout(r, 2500));

  const timeline = await win.webContents.executeJavaScript('window.__launchTimeline || []');
  const clickAt = await win.webContents.executeJavaScript('window.__clickAt || 0');
  console.log('CLICK_AT ' + clickAt);
  console.log('TIMELINE ' + JSON.stringify(timeline));

  const toStart = timeline.find((x) => x.ev === 'start');
  if (toStart) console.log('CLICK_TO_START_MS ' + (toStart.at - clickAt));
  else console.log('CLICK_TO_START_MS 未触发');

  // ④ 是否出现了确认弹窗（不应该有）
  const modal = await win.webContents.executeJavaScript(\`
    ({
      modalHidden: (document.getElementById('modal-root') || {}).hidden,
      hasLaunchModal: !!document.querySelector('.modal--launch'),
    })
  \`);
  console.log('MODAL ' + JSON.stringify(modal));

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
const userData = path.join(ROOT, '.cache', 'userdata-lo');
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
