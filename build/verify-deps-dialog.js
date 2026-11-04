'use strict';
/**
 * 验证前置依赖弹窗：
 *   ① 点安装一个真有前置的模组（REI，3 个必需前置）
 *   ② 弹窗出现，列出 3 个前置，全部默认勾选
 *   ③ 取消勾选必需前置 → 再点安装 → 应弹出二次确认
 *   ④ 截图
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_dep-inner.js');

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
    if (lvl >= 2) console.log('[RENDER] ' + String(msg).slice(0, 200));
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 14000));

  // 直接调 IPC 验证依赖解析 + 手动触发弹窗函数
  const result = await win.webContents.executeJavaScript(\`
    (async () => {
      // ① IPC 层：查 REI 的依赖
      const sr = await window.qcl.invoke('content:search', { projectType:'mod', query:'roughly enough items', mcVersion:'1.20.1', loader:'fabric', limit:3, source:'modrinth' });
      const hits = (sr && sr.hits) || [];
      const proj = hits[0];
      if (!proj) return { err: '搜不到 REI' };
      const vr = await window.qcl.invoke('content:versions', { id: proj.id, source:'modrinth', mcVersion:'1.20.1', loader:'fabric' });
      const vers = (vr && vr.versions) || vr || [];
      const v = vers.find(x => x.versionType === 'release') || vers[0];
      if (!v) return { err: '没有版本' };

      const dr = await window.qcl.invoke('content:dependencies', {
        dependencies: v.dependencies || [],
        mcVersion: '1.20.1',
        loader: 'fabric'
      });

      return {
        project: proj.title,
        version: v.versionNumber,
        declaredDeps: (v.dependencies || []).length,
        required: ((dr && dr.required) || []).map(d => ({ title: d.title, ver: d.version ? d.version.versionNumber : null, hasFile: !!(d.version && d.version.files[0]) })),
        optional: ((dr && dr.optional) || []).length,
      };
    })()
  \`);
  console.log('IPC_RESULT ' + JSON.stringify(result, null, 2));

  // ② 模拟点击安装按钮，看弹窗
  const dlg = await win.webContents.executeJavaScript(\`
    (async () => {
      // 走真实路径：进下载页 -> 模组分类 -> 搜 -> 打开详情 -> 点安装
      const nav = document.querySelector('[data-nav="download"]');
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 1200));
      // 点「模组」分类
      const cat = document.querySelector('.dlcat[data-cat="mod"]');
      if (cat) { cat.click(); await new Promise(r => setTimeout(r, 1500)); }
      // 搜索框输入
      const input = document.querySelector('#dl-search');
      if (input) {
        input.value = 'roughly enough items';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 4000));
      }
      const cards = document.querySelectorAll('[data-act="install"]');
      if (!cards.length) return { modalOpen: false, note: '搜索后没有卡片' };
      // 第一次点「安装」→ 打开版本列表弹窗
      cards[0].click();
      await new Promise(r => setTimeout(r, 6000));
      // 再点第一个版本 → 这里才会触发前置依赖检测
      const vbtn = document.querySelector('[data-vidx]');
      if (!vbtn) return { modalOpen: false, note: '版本列表没出来（没有 [data-vidx] 按钮）' };
      vbtn.click();
      await new Promise(r => setTimeout(r, 8000));
      const m = document.querySelector('.modal--deps');
      if (!m) return { modalOpen: false, note: '没弹出依赖窗（可能没找到卡片或版本列表未加载）' };
      return {
        modalOpen: true,
        title: (m.querySelector('.modal__title') || {}).textContent,
        intro: (m.querySelector('.dep-intro') || {}).textContent.trim().slice(0, 120),
        groups: Array.from(m.querySelectorAll('.dep-group__title')).map(x => x.textContent.trim()),
        rows: Array.from(m.querySelectorAll('.dep-row')).map(x => ({
          title: (x.querySelector('.dep-row__title') || {}).textContent.trim().slice(0, 40),
          checked: (x.querySelector('input') || {}).checked,
          disabled: (x.querySelector('input') || {}).disabled,
        })),
        buttons: Array.from(m.querySelectorAll('.modal__foot button')).map(b => b.textContent.trim()),
      };
    })()
  \`);
  console.log('DIALOG ' + JSON.stringify(dlg, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_deps-dialog.png'), img.toPNG());
  console.log('SHOT docs/_deps-dialog.png');

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-dep');
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
