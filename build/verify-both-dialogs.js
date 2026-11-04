'use strict';
/**
 * 验证两个弹窗（用真实点击路径）：
 *   ① 点「游戏」分类的安装 → 弹「选择加载器」
 *   ② 点「模组」分类的 REI 安装 → 选版本 → 弹「前置依赖」
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_dlg2-inner.js');

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
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2 && !/WebGL|GL Driver|GroupMarker/.test(String(msg))) console.log('[R] ' + String(msg).slice(0, 160));
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 14000));

  // ---- 进下载页 ----
  await win.webContents.executeJavaScript("(document.querySelector('[data-nav=\\"download\\"]')||{}).click()");
  await new Promise((r) => setTimeout(r, 3000));

  // ---- ① 游戏分类：点安装，看是否弹加载器窗 ----
  const loaderDlg = await win.webContents.executeJavaScript(\`
    (async () => {
      const gameCat = document.querySelector('.dlcat[data-cat="game"]');
      if (gameCat) { gameCat.click(); await new Promise(r => setTimeout(r, 2500)); }
      const installBtns = document.querySelectorAll('[data-act="install"]');
      if (!installBtns.length) return { ok: false, note: '游戏分类没有安装按钮' };
      installBtns[0].click();
      await new Promise(r => setTimeout(r, 2500));
      const m = document.querySelector('.modal--loader');
      if (!m) return { ok: false, note: '没弹出加载器选择窗' };
      return {
        ok: true,
        title: (m.querySelector('.modal__title') || {}).textContent,
        items: Array.from(m.querySelectorAll('.loader-item')).map(x => ({
          label: (x.querySelector('.loader-item__title') || {}).textContent.trim().replace(/\\s+/g,' '),
          type: x.getAttribute('data-loader'),
          rec: x.classList.contains('is-rec'),
        })),
        warn: (m.querySelector('.loader-intro__warn') || {}).textContent.trim(),
      };
    })()
  \`);
  console.log('LOADER_DIALOG ' + JSON.stringify(loaderDlg, null, 2));

  const shot1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_dlg-loader.png'), shot1.toPNG());
  console.log('SHOT docs/_dlg-loader.png');

  // 关掉加载器弹窗
  await win.webContents.executeJavaScript(\`
    (() => { const b = document.querySelector('.modal--loader [data-act="cancel"]'); if (b) b.click(); return true; })()
  \`);
  await new Promise((r) => setTimeout(r, 600));

  // ---- ② 模组分类：搜 REI → 安装 → 选版本 → 看是否弹前置依赖窗 ----
  const depDlg = await win.webContents.executeJavaScript(\`
    (async () => {
      const modCat = document.querySelector('.dlcat[data-cat="mod"]');
      if (modCat) { modCat.click(); await new Promise(r => setTimeout(r, 2500)); }
      const input = document.querySelector('#dl-search');
      if (input) {
        input.value = 'roughly enough items';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 5000));
      }
      // 找标题含 Roughly 的卡片
      const cards = Array.from(document.querySelectorAll('[data-id]'));
      const rei = cards.find(c => /roughly enough items/i.test(c.textContent || '')) || cards[0];
      if (!rei) return { ok: false, note: '搜不到卡片', cardCount: cards.length };
      const reiTitle = (rei.querySelector('.dlcard__title') || {}).textContent || '';
      const btn = rei.querySelector('[data-act="install"]');
      if (!btn) return { ok: false, note: '卡片没有安装按钮', reiTitle };
      btn.click();
      await new Promise(r => setTimeout(r, 7000));
      const vbtn = document.querySelector('[data-vidx]');
      if (!vbtn) return { ok: false, note: '版本列表没出来', reiTitle };
      // 记录版本列表里第一个的依赖声明
      // 不传 source，让后端走 mixed 自动判断（卡片 id 可能是 CF 数字 id）
      let depInfo = null;
      try { depInfo = await window.qcl.invoke('content:versions', { id: rei.getAttribute('data-id') }); } catch (e) { depInfo = null; }
      const vers = (depInfo && (depInfo.versions || depInfo)) || [];
      const first = Array.isArray(vers) ? vers[0] : null;
      vbtn.click();
      await new Promise(r => setTimeout(r, 9000));
      const m = document.querySelector('.modal--deps');
      if (!m) return { ok: false, note: '没弹出前置依赖窗', reiTitle, firstVersionDeps: first ? (first.dependencies || []).length : null };
      return {
        ok: true,
        reiTitle,
        title: (m.querySelector('.modal__title') || {}).textContent,
        groups: Array.from(m.querySelectorAll('.dep-group__title')).map(x => x.textContent.trim()),
        rows: Array.from(m.querySelectorAll('.dep-row')).map(x => ({
          t: (x.querySelector('.dep-row__title') || {}).textContent.trim().replace(/\\s+/g,' ').slice(0,40),
          checked: (x.querySelector('input') || {}).checked,
        })),
        buttons: Array.from(m.querySelectorAll('.modal__foot button')).map(b => b.textContent.trim()),
      };
    })()
  \`);
  console.log('DEP_DIALOG ' + JSON.stringify(depDlg, null, 2));

  const shot2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_dlg-deps.png'), shot2.toPNG());
  console.log('SHOT docs/_dlg-deps.png');

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-dlg2');
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
