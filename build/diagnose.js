'use strict';
/**
 * QCL 电脑版 · 渲染层诊断脚本（Lead 用）
 *
 * 用途：起真实主进程窗口（含 qcl:// 协议、真实 IPC），注入一段探针，
 *       把「为什么界面卡在启动画面」的真实错误抓出来。
 *
 * 用法：node build/diagnose.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', '_diagnose.txt');

const inner = `
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = ${JSON.stringify(OUT)};

app.whenReady().then(async () => {
  // 复用真实主进程的协议注册与窗口创建
  const main = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'index.js'))});
});
`;

// 直接复用主进程更可靠：用 --capture 的同一路径，但把日志写到文件
const scriptFile = path.join(__dirname, '_diag-inner.js');
fs.writeFileSync(
  scriptFile,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = ${JSON.stringify(ROOT)};
const OUT = ${JSON.stringify(OUT)};
const lines = [];
const say = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const target = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(target).toString()); }
    catch (e) { return new Response('404 ' + rel, { status: 404 }); }
  });

  const win = new BrowserWindow({
    width: 1600, height: 900, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  // 抓渲染层所有日志
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    say('[渲染层]', message, source ? '(' + source + ':' + line + ')' : '');
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => say('[加载失败]', code, desc, url));
  win.webContents.on('preload-error', (_e, p, err) => say('[预加载错误]', p, err && err.message));

  // 在页面脚本执行前挂错误钩子
  win.webContents.on('did-start-loading', () => {
    win.webContents.executeJavaScript(\`
      window.__qclErrors = [];
      window.addEventListener('error', (e) => window.__qclErrors.push('error: ' + (e.message || e.error)));
      window.addEventListener('unhandledrejection', (e) => window.__qclErrors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
    \`).catch(() => {});
  });

  const loaded = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('加载超时')), 20000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;

  await new Promise((r) => setTimeout(r, 7000));

  const diag = await win.webContents.executeJavaScript(\`
    (async () => {
      const splash = document.getElementById('splash');
      const out = {
        启动画面还在: !!splash && !splash.classList.contains('is-hidden'),
        启动画面文字: splash ? (splash.textContent || '').trim().slice(0, 200) : null,
        左栏按钮数: document.querySelectorAll('#leftnav button, #leftnav a').length,
        内容区子节点: (document.getElementById('content') || {}).childElementCount ?? -1,
        右栏子节点: (document.getElementById('rightpanel') || {}).childElementCount ?? -1,
        顶栏状态: (document.getElementById('titlebar-status') || {}).textContent ?? null,
        横幅数: document.querySelectorAll('.banner').length,
        qcl桥: typeof window.qcl,
        页面错误: window.__qclErrors || [],
      };
      // 主动试一次 IPC，看主进程通道是否真的在
      try { out.ipc测试 = JSON.stringify(await window.qcl.invoke('app:info', {})); }
      catch (e) { out.ipc测试 = '失败: ' + (e && e.message); }
      try { out.实例列表 = JSON.stringify(await window.qcl.invoke('instances:list', {})); }
      catch (e) { out.实例列表 = '失败: ' + (e && e.message); }
      return out;
    })()
  \`).catch((e) => ({ 诊断脚本失败: e.message }));

  say('===== 诊断结果 =====');
  say(JSON.stringify(diag, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_diag.png'), img.toPNG());
  say('[QCL] 截图 docs/_diag.png');

  fs.writeFileSync(OUT, lines.join('\\n'), 'utf8');
  app.exit(0);
}).catch((e) => {
  say('FATAL', e && e.stack || e);
  fs.writeFileSync(OUT, lines.join('\\n'), 'utf8');
  app.exit(1);
});
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
const userData = path.join(ROOT, '.cache', 'userdata-diag');
fs.mkdirSync(userData, { recursive: true });

const child = spawn(require('electron'), [scriptFile, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], {
  env,
  stdio: 'inherit'
});
child.on('exit', (code) => {
  try {
    fs.unlinkSync(scriptFile);
  } catch {
    /* ignore */
  }
  process.exitCode = code ?? 0;
});
