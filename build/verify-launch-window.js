'use strict';
/**
 * 验证「正在启动」窗口：
 *   ① 点击启动 → 窗口多久出现（应 < 300ms）
 *   ② 6 个阶段是否逐步点亮
 *   ③ 截图给人工看
 *
 * 注意：会真的启动一次游戏（占用内存），跑完自动杀进程。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT = path.join(ROOT, 'docs', '_launch-window.png');
const inner = path.join(__dirname, '_lw-inner.js');

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
  await new Promise((r) => setTimeout(r, 18000));   // 等预热

  // ① 点启动，量窗口出现时间
  const appear = await win.webContents.executeJavaScript(\`
    (async () => {
      const btn = document.getElementById('launch-btn');
      if (!btn) return { err: 'no-btn' };
      const t0 = performance.now();
      btn.click();
      // 每 16ms 检查一次窗口是否出现
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 16));
        if (document.querySelector('.modal--launching')) {
          return { ms: Math.round(performance.now() - t0) };
        }
      }
      return { ms: -1, timeout: true };
    })()
  \`);
  console.log('WINDOW_APPEAR_MS ' + JSON.stringify(appear));

  // ② 先截一张（此时窗口应该在，且步骤正在推进）
  await new Promise((r) => setTimeout(r, 900));
  const imgEarly = await win.webContents.capturePage();
  fs.writeFileSync(SHOT.replace('.png', '-early.png'), imgEarly.toPNG());
  console.log('SHOT_EARLY ' + SHOT.replace('.png', '-early.png'));

  // 采几次阶段状态
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const st = await win.webContents.executeJavaScript(\`
      (() => {
        const m = document.querySelector('.modal--launching');
        if (!m) return { closed: true };
        return {
          stages: Array.from(m.querySelectorAll('.lw__stage')).map(x => ({
            name: (x.querySelector('.lw__label')||{}).textContent,
            state: x.className.replace('lw__stage lw__stage--',''),
          })),
          meta: (m.querySelector('.lw__meta')||{}).textContent,
          log: (m.querySelector('.lw__log')||{}).textContent,
        };
      })()
    \`);
    if (st.closed) {
      console.log('  [' + ((i + 1) * 700) + 'ms] 窗口已关闭（启动完成）');
      break;
    }
    const doneCount = (st.stages || []).filter((x) => x.state === 'done').length;
    const active = (st.stages || []).find((x) => x.state === 'active');
    console.log('  [' + ((i + 1) * 700) + 'ms] 完成 ' + doneCount + '/6' + (active ? '  进行中: ' + active.name : '') + '  meta=' + JSON.stringify(st.meta));
  }

  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('SHOT ' + SHOT);

  // 收尾：杀掉游戏
  try {
    const list = await win.webContents.executeJavaScript("window.qcl.invoke('instances:list', {}).then(l => l[0].id)");
    await win.webContents.executeJavaScript("window.qcl.invoke('launch:kill', { id: '" + list + "' })");
  } catch (e) {}

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-lw');
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
