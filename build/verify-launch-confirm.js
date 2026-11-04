'use strict';
/**
 * 验证「启动前确认弹窗」能否正常显示并截图。
 *
 * 不真的启动游戏（那样会占用大量内存），只：
 *   1. 加载页面
 *   2. 点击「启动游戏」
 *   3. 等弹窗出现
 *   4. 读取弹窗里的文字与控件
 *   5. 截图
 *   6. 点「取消」，确认弹窗正常关闭
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT = path.join(ROOT, 'docs', '_launch-confirm.png');
const inner = path.join(__dirname, '_lc-inner.js');

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
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('[RENDER-ERR]', msg); });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 16000));

  // ① 先看 precheck 的数据
  const pre = await win.webContents.executeJavaScript(\`
    (async () => {
      const list = await window.qcl.invoke('instances:list', {});
      if (!list || !list.length) return { err: '没有实例' };
      const id = list[0].id;
      const r = await window.qcl.invoke('launch:precheck', { id });
      return r;
    })()
  \`);
  console.log('PRECHECK ' + JSON.stringify(pre, null, 2).slice(0, 2000));

  // ② 点启动按钮，等弹窗
  const clicked = await win.webContents.executeJavaScript(\`
    (async () => {
      const btn = document.querySelector('#launch-btn') || document.querySelector('.launch-btn') || document.querySelector('[data-act="launch"]');
      if (!btn) {
        // 兜底：找右栏按钮
        const all = Array.from(document.querySelectorAll('button'));
        const hit = all.find(b => (b.textContent||'').includes('启动游戏'));
        if (hit) { hit.click(); return 'clicked-by-text'; }
        return 'no-button';
      }
      btn.click();
      return 'clicked';
    })()
  \`);
  console.log('CLICK ' + clicked);

  // 诊断：点击后 state 是什么（注意这里在外层模板字符串里，美元符要转义）
  const st = await win.webContents.executeJavaScript(\`
    (() => {
      const s = window.__qclDebug && window.__qclDebug.state;
      return {
        instances: s ? s.instances.length : 'no-debug',
        accounts: s ? s.accounts.length : 'no-debug',
        currentInstanceId: s ? s.currentInstanceId : 'no-debug',
        toasts: Array.from(document.querySelectorAll('.toast, .toast__item')).map(x => (x.textContent || '').trim().slice(0, 60)),
        modalRootHidden: (document.getElementById('modal-root') || {}).hidden,
      };
    })()
  \`);
  console.log('STATE ' + JSON.stringify(st));

  await new Promise((r) => setTimeout(r, 3500));

  // ③ 读弹窗内容
  const dialog = await win.webContents.executeJavaScript(\`
    (() => {
      const m = document.querySelector('.modal--launch');
      if (!m) return { 出现: false, 所有modal: Array.from(document.querySelectorAll('.modal')).map(x=>x.className) };
      return {
        出现: true,
        标题: (m.querySelector('.modal__title')||{}).textContent,
        检查段: Array.from(m.querySelectorAll('.lc-section__title')).map(x=>x.textContent),
        问题项: Array.from(m.querySelectorAll('.lc-issue__title')).map(x=>x.textContent),
        行: Array.from(m.querySelectorAll('.lc-row')).map(r => ({
          标签: (r.querySelector('.lc-row__label')||{}).textContent,
          值: (r.querySelector('.lc-row__value')||{}).textContent ? (r.querySelector('.lc-row__value')||{}).textContent.trim().slice(0,60) : null,
        })),
        按钮: Array.from(m.querySelectorAll('.modal__foot button')).map(b=>b.textContent.trim()),
        记住勾选: (m.querySelector('#lc-remember')||{}).checked,
        内存滑块: (m.querySelector('#lc-mem')||{}).value,
      };
    })()
  \`);
  console.log('DIALOG ' + JSON.stringify(dialog, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('SHOT ' + SHOT);

  // ④ 点取消，确认关闭
  const closed = await win.webContents.executeJavaScript(\`
    (async () => {
      const m = document.querySelector('.modal--launch');
      if (!m) return 'no-modal';
      const cancel = m.querySelector('[data-act="cancel"]');
      if (cancel) cancel.click();
      await new Promise(r => setTimeout(r, 400));
      return document.querySelector('.modal--launch') ? 'still-open' : 'closed';
    })()
  \`);
  console.log('CANCEL ' + closed);

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-lc');
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
