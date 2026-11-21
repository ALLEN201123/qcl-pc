'use strict';
/**
 * Verify: 百宝箱专属图标（toolbox 宝箱造型）在真实 app 里真的渲染出来。
 *
 * 检查三处：icons.icon() 的产出、左栏导航按钮里的 svg、页面标题里的 svg。
 * 判据：有 <path>、不是兜底 <rect>、用 currentColor 上色。
 * 窗口 show:false，绝不打扰用户。
 *
 * 用法：node build/verify-toolbox-icon.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'toolbox-icon-result.json');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const inner = path.join(__dirname, '_tbxicon-inner.js');
const innerSrc = `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const OUT = ${JSON.stringify(OUT)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('load timeout')), 60000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await sleep(12000);

  const js = (c) => win.webContents.executeJavaScript(c, true);
  const analyse = (s) => {
    if (!s) return { exists: false };
    const pathCount = (s.match(/<path/g) || []).length;
    return {
      exists: true,
      pathCount,
      isFallbackRect: /<rect/.test(s) && pathCount === 0,
      usesCurrentColor: /currentColor/.test(s),
      head: s.slice(0, 140),
    };
  };

  const out = {};
  try {
    out.iconFn = analyse(await js('(async()=>{const m=await import("qcl://app/js/icons.js");return m.icon("toolbox",24);})()'));
    out.navButton = analyse(await js('(function(){var b=document.querySelector("[data-nav=toolbox]");if(!b)return null;var s=b.querySelector("svg");return s?s.outerHTML:null;})()'));
    // 进页面看标题图标
    await js('(function(){var b=document.querySelector("[data-nav=toolbox]");if(b)b.click();})()');
    await sleep(3000);
    out.pageTitle = analyse(await js('(function(){var s=document.querySelector(".tbx-title-icon svg");return s?s.outerHTML:null;})()'));
    // 导航按钮的提示用 data-tip（不是 title，也不是原生 tooltip）
    out.navTip = await js('(function(){var b=document.querySelector("[data-nav=toolbox]");return b?(b.getAttribute("data-tip")||b.getAttribute("aria-label")):null;})()');
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); app.exit(1); });
`;
fs.writeFileSync(inner, innerSrc, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-tbxicon');
fs.mkdirSync(userData, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'ignore' });
child.on('exit', () => {
  try { fs.unlinkSync(inner); } catch { /* ignore */ }
  let res = null;
  try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* ignore */ }
  console.log('================ RESULT ================');
  if (!res) { console.log('no result file'); process.exitCode = 1; return; }
  if (res.error) { console.log('ERROR: ' + res.error); process.exitCode = 1; return; }
  const checks = [];
  const P = (n, p, i) => checks.push({ n, p, i });

  P('icon() 产出存在', res.iconFn.exists === true);
  P('icon() 有 5 条 path', res.iconFn.pathCount === 5, res.iconFn.pathCount);
  P('icon() 不是兜底方块', res.iconFn.isFallbackRect === false);
  P('icon() 用 currentColor 上色', res.iconFn.usesCurrentColor === true);

  P('左栏导航按钮里有 toolbox svg', res.navButton.exists === true);
  P('导航 svg 有 5 条 path', res.navButton.pathCount === 5, res.navButton.pathCount);
  P('导航 svg 不是兜底方块', res.navButton.isFallbackRect === false);

  P('页面标题图标 svg 存在', res.pageTitle.exists === true);
  P('标题 svg 有 5 条 path', res.pageTitle.pathCount === 5, res.pageTitle.pathCount);

  P('导航按钮 title 是「百宝箱」', res.navTip === '百宝箱', res.navTip);

  let fail = 0;
  for (const c of checks) {
    if (!c.p) fail += 1;
    console.log(`${c.p ? 'PASS' : 'FAIL'}  ${c.n}${c.i !== undefined ? '  -> ' + JSON.stringify(c.i) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`total ${checks.length}, failed ${fail}`);
  if (res.navButton && res.navButton.head) console.log('\nnav svg 片段:\n' + res.navButton.head);
  process.exitCode = fail === 0 ? 0 : 1;
});
