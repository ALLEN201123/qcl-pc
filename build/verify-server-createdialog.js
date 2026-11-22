'use strict';
/**
 * Verify (hidden): 「新建服务端」按钮真的能点开对话框。
 *
 * 用户反馈两次「点新建服务端按钮还点不动」。根因是我手写了 .modal-overlay，
 * 而项目 CSS 里只有 .modal —— 那个 div 被塞进文档流末尾，看起来毫无反应。
 * 改用 openModal 后必须有这个验收，否则同一条 bug 可能第三次出现。
 *
 * 窗口 show:false。用法：node build/verify-server-createdialog.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'srv-createdlg-result.json');
const HOME = path.join(os.tmpdir(), '_qcl_dlg_home');

/* 外层准备隔离 HOME（Electron 测试进程写数据目录会 EPERM） */
const srv = require(path.join(ROOT, 'src', 'main', 'core', 'server.js'));
function prep() {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const d of ['', 'logs', 'meta', 'instances', 'servers']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
}
prep();

const inner = path.join(__dirname, '_dlg-inner.js');
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
  await sleep(13000);

  const js = (c) => win.webContents.executeJavaScript(c, true);
  const checks = [];
  const P = (n, p, i) => checks.push({ n, p, i });

  try {
    // 进服务端页
    await js('(function(){var b=document.querySelector("[data-nav=server]");if(b)b.click();})()');
    await sleep(5000);

    // 找到按钮
    const hasBtn = await js('!!document.getElementById("srv-new")');
    P('「新建服务端」按钮存在', hasBtn === true);

    // ★ 关键：点它，然后看 modal-root 里有没有对话框
    const before = await js('(function(){var r=document.getElementById("modal-root");return {hidden:r?r.hidden:null,html:r?r.innerHTML.length:0};})()');
    await js('(function(){var b=document.getElementById("srv-new");if(b)b.click();})()');
    await sleep(4000);
    const after = await js('(function(){var r=document.getElementById("modal-root");return {' +
      'hidden: r?r.hidden:null,' +
      'htmlLen: r?r.innerHTML.length:0,' +
      'hasModal: !!(r && r.querySelector(".modal")),' +
      'title: ((r && r.querySelector(".modal__title"))||{}).textContent||"",' +
      'hasNameInput: !!(r && r.querySelector("#sc-name")),' +
      'hasKindBtns: r?r.querySelectorAll("[data-kind]").length:0,' +
      'hasVersion: !!(r && (r.querySelector("#sc-version") || r.querySelector("#sc-version-manual"))),' +
      'hasCreateBtn: !!(r && Array.from(r.querySelectorAll("button")).some(function(b){return b.textContent.trim()==="创建";}))' +
      '};})()');

    P('点之前对话框是关的', before.hidden === true || before.html === 0, before);
    P('★ 点之后 modal-root 显示了', after.hidden === false, after.hidden);
    P('★ 有 .modal 元素（真的弹出来了）', after.hasModal === true, after.htmlLen);
    P('对话框标题是「新建服务端」', /新建服务端/.test(after.title), after.title);
    P('有名称输入框', after.hasNameInput === true);
    P('有核心类型按钮（4 个）', after.hasKindBtns === 4, after.hasKindBtns);
    P('有版本选择/输入', after.hasVersion === true);
    P('有「创建」按钮', after.hasCreateBtn === true);

    // 切换核心类型
    await js('(function(){var b=document.querySelector("#modal-root [data-kind=paper]");if(b)b.click();})()');
    await sleep(1200);
    const switched = await js('(function(){' +
      'var b=document.querySelector("#modal-root [data-kind=paper]");' +
      'var h=document.querySelector("#modal-root #sc-kind-hint");' +
      'return {active: b?b.classList.contains("is-active"):false, hint: h?h.textContent.trim():""};})()');
    P('能切换核心到 Paper', switched.active === true, switched);
    P('切换后提示文案会变', /Paper/.test(switched.hint), switched.hint.slice(0, 40));

    // 填名称并检查暂存
    await js('(function(){var e=document.getElementById("sc-name");if(e){e.value="测试服务器";e.dispatchEvent(new Event("input"));}})()');
    await sleep(600);
    const typed = await js('(function(){var e=document.getElementById("sc-name");return e?e.value:null;})()');
    P('名称能输入', typed === '测试服务器', typed);
  } catch (e) {
    P('过程异常', false, String((e && e.message) || e));
  }

  fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2), 'utf8');
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); app.exit(1); });
`;
fs.writeFileSync(inner, innerSrc, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const ud = path.join(ROOT, '.cache', 'ud-dlg');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(ud, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`], { env, stdio: 'ignore' });
child.on('exit', () => {
  try { fs.unlinkSync(inner); } catch { /* ignore */ }
  let res = null;
  try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* ignore */ }
  console.log('================ RESULT ================');
  if (!res) { console.log('no result'); process.exitCode = 1; return; }
  let fail = 0;
  for (const c of res.checks || []) {
    if (!c.p) fail += 1;
    console.log(`${c.p ? 'PASS' : 'FAIL'}  ${c.n}${c.i !== undefined ? '  -> ' + JSON.stringify(c.i) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`total ${(res.checks || []).length}, failed ${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
});
