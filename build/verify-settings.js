'use strict';
/**
 * 验证设置页移植：
 *   ① 「版本设置」的 图标 / 游戏 两个新标签能渲染
 *   ② 图标选择器有 24 个图标、能点
 *   ③ 「全局设置」的 游戏 标签能渲染
 *   ④ 截图
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT_DIR = path.join(ROOT, 'docs');
const inner = path.join(__dirname, '_settings-inner.js');

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

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(${JSON.stringify(SHOT_DIR)}, name), img.toPNG());
    console.log('SHOT ' + name);
  };

  // ---------- ① 版本设置：图标标签 ----------
  // 用点击左栏导航的方式切页（动态 import 在 executeJavaScript 里解析不到 qcl:// 路径）
  await win.webContents.executeJavaScript(\`
    (() => { const b = document.querySelector('[data-nav="versionsetting"]'); if (b) b.click(); return !!b; })()
  \`);
  await new Promise((r) => setTimeout(r, 1400));

  const tabs = await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('#vs-tabs .vset__tab')).map(b => b.textContent.trim())");
  console.log('VS_TABS ' + JSON.stringify(tabs));

  // 点「图标」
  await win.webContents.executeJavaScript(\`
    (() => {
      const b = Array.from(document.querySelectorAll('#vs-tabs .vset__tab')).find(x => x.textContent.trim() === '图标');
      if (b) b.click();
      return !!b;
    })()
  \`);
  await new Promise((r) => setTimeout(r, 900));

  const iconInfo = await win.webContents.executeJavaScript(\`
    (() => {
      const grid = document.querySelectorAll('.icon-grid__item');
      return {
        图标数量: grid.length,
        当前图标: (document.querySelector('.icon-current__name')||{}).textContent,
        有激活态: !!document.querySelector('.icon-grid__item.is-active'),
        图片能加载: Array.from(grid).slice(0,3).map(x => {
          const img = x.querySelector('img');
          return { src: (img||{}).getAttribute('src'), 宽: (img||{}).naturalWidth };
        }),
        有自定义按钮: !!document.querySelector('#vs-icon-pick'),
      };
    })()
  \`);
  console.log('ICON_TAB ' + JSON.stringify(iconInfo, null, 2));
  await shot('_settings-icon.png');

  // ---------- ② 版本设置：游戏标签 ----------
  await win.webContents.executeJavaScript(\`
    (() => {
      const b = Array.from(document.querySelectorAll('#vs-tabs .vset__tab')).find(x => x.textContent.trim() === '游戏');
      if (b) b.click();
      return !!b;
    })()
  \`);
  await new Promise((r) => setTimeout(r, 900));

  const gameInfo = await win.webContents.executeJavaScript(\`
    (() => ({
      有分辨率: !!document.querySelector('#vs-res-w') && !!document.querySelector('#vs-res-h'),
      有服务器: !!document.querySelector('#vs-server'),
      有最低内存: !!document.querySelector('#vs-minmem'),
      有调试开关: !!document.querySelector('#vs-debug-log'),
      分辨率值: (document.querySelector('#vs-res-w')||{}).value + 'x' + (document.querySelector('#vs-res-h')||{}).value,
    }))()
  \`);
  console.log('VS_GAME ' + JSON.stringify(gameInfo));
  await shot('_settings-vs-game.png');

  // ---------- ③ 全局设置：游戏标签 ----------
  await win.webContents.executeJavaScript(\`
    (() => { const b = document.querySelector('[data-nav="setting"]'); if (b) b.click(); return !!b; })()
  \`);
  await new Promise((r) => setTimeout(r, 1400));

  const stTabs = await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('#st-tabs .vset__tab')).map(b => b.textContent.trim())");
  console.log('ST_TABS ' + JSON.stringify(stTabs));

  await win.webContents.executeJavaScript(\`
    (() => {
      const b = Array.from(document.querySelectorAll('#st-tabs .vset__tab')).find(x => x.textContent.trim() === '游戏');
      if (b) b.click();
      return !!b;
    })()
  \`);
  await new Promise((r) => setTimeout(r, 900));

  const stGame = await win.webContents.executeJavaScript(\`
    (() => ({
      有分辨率: !!document.querySelector('#st-res-w'),
      有服务器: !!document.querySelector('#st-server'),
      有最低内存: !!document.querySelector('#st-minmem'),
      有调试: !!document.querySelector('#st-debug-log'),
      有关闭文件校验: !!document.querySelector('#st-no-check-files'),
      开关文案: (() => { const l = document.querySelector('#st-no-check-files'); return l ? (l.closest('.vset-check')||{}).textContent.trim().slice(0,40) : null; })(),
    }))()
  \`);
  console.log('ST_GAME ' + JSON.stringify(stGame));
  await shot('_settings-global-game.png');

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-settings');
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
