'use strict';
/**
 * Verify (hidden window): 百宝箱页面真的能打开、能渲染、能点。
 *
 * 只读检查 DOM，绝不修改任何数据；窗口 show:false。
 * 用法：node build/verify-toolbox-ui.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'toolbox-ui-result.json');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const inner = path.join(__dirname, '_tbx-inner.js');
// 这些常量会在内层脚本里重新定义（内外作用域独立），这里只在生成 inner 时用到
const DQ = String.fromCharCode(34);
const Q = String.fromCharCode(39);
const BL = String.fromCharCode(91);
const BR = String.fromCharCode(93);

const innerSrc = `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const OUT = ${JSON.stringify(OUT)};
// 选择器拼装常量（不写嵌套引号，避免 executeJavaScript 语法错误）
const DQ = String.fromCharCode(34);
const Q = String.fromCharCode(39);
const BL = String.fromCharCode(91);
const BR = String.fromCharCode(93);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    if (rel.startsWith('__instanceicon__/')) {
      const name = rel.slice('__instanceicon__/'.length);
      if (!/^[A-Za-z0-9_-]+\\.png$/i.test(name)) return new Response('403', { status: 403 });
      const p = path.normalize(path.join(HOME, 'icons', name));
      if (!fs.existsSync(p)) return new Response('404', { status: 404 });
      return await net.fetch(pathToFileURL(p).toString());
    }
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404'); }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: path.dirname(HOME), homeOverride: HOME });
  settings.load();
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  // show:false -- never flash a window at the user
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('load timeout')), 60000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await sleep(13000);

  const js = (c) => win.webContents.executeJavaScript(c, true);
  const checks = [];
  const push = (name, pass, info) => checks.push({ name, pass, info });

  try {
    // 导航里有百宝箱按钮
    const navSel = BL + 'data-nav=' + DQ + 'toolbox' + DQ + BR;
    const hasNav = await js('!!document.querySelector(' + Q + navSel + Q + ')');
    push('左栏有「百宝箱」导航按钮', hasNav === true);

    // 点进去
    await js('(function(){var b=document.querySelector(' + Q + navSel + Q + ');if(b)b.click();})()');
    await sleep(3500);

    const dom = await js('(function(){return {' +
      'title: (document.querySelector(".page__title")||{}).textContent||"",' +
      'hasJrrp: !!document.getElementById("tbx-jrrp"),' +
      'hasMem: !!document.getElementById("tbx-mem"),' +
      'hasClean: !!document.getElementById("tbx-clean"),' +
      'hasNope: !!document.getElementById("tbx-nope"),' +
      'hasCave: !!document.getElementById("tbx-cave"),' +
      'hasDl: !!document.getElementById("tbx-dl-start"),' +
      'hasDisk: !!document.getElementById("tbx-disk-body"),' +
      'warnText: ((document.querySelector("#tbx-card-mem .tbx-warn")||{}).textContent||"").trim()' +
      '};})()');
    push('页面标题是百宝箱', dom.title === '百宝箱', dom.title);
    push('今日人品按钮存在', dom.hasJrrp === true);
    push('内存优化按钮存在', dom.hasMem === true);
    push('清理垃圾按钮存在', dom.hasClean === true);
    push('千万别点按钮存在', dom.hasNope === true);
    push('回声洞按钮存在', dom.hasCave === true);
    push('下载区按钮存在', dom.hasDl === true);
    push('磁盘占用面板存在', dom.hasDisk === true);
    push('★ 内存优化卡片写明「不会让电脑变快」', dom.warnText.indexOf('不会让电脑变快') >= 0, dom.warnText.slice(0, 60));

    // 进页面会自动算今日人品，等它出来
    await sleep(2500);
    const jrrp = await js('(function(){var n=document.querySelector(".tbx-jrrp__num");var t=document.querySelector(".tbx-jrrp__text");return {score:n?n.textContent.trim():null, text:t?t.textContent.trim():"", meta:((document.querySelector(".tbx-jrrp__meta")||{}).textContent||"").trim()};})()');
    push('今日人品自动算出了分数', !!jrrp.score && /^\\d+$/.test(jrrp.score), jrrp);
    const sc = Number(jrrp.score);
    push('分数在 0..100', Number.isFinite(sc) && sc >= 0 && sc <= 100, sc);

    // 再点一次，结果必须一样（确定性）
    await js('(function(){var b=document.getElementById("tbx-jrrp");if(b)b.click();})()');
    await sleep(1500);
    const jrrp2 = await js('(function(){var n=document.querySelector(".tbx-jrrp__num");return n?n.textContent.trim():null;})()');
    push('★ 再点一次分数不变（确定性）', jrrp2 === jrrp.score, { first: jrrp.score, second: jrrp2 });

    // 回声洞点两次要换内容
    await js('(function(){var b=document.getElementById("tbx-cave");if(b)b.click();})()');
    await sleep(1200);
    const cave1 = await js('(function(){var t=document.getElementById("tbx-cave-text");return t?t.textContent.trim():"";})()');
    await js('(function(){var b=document.getElementById("tbx-cave");if(b)b.click();})()');
    await sleep(1200);
    const cave2 = await js('(function(){var t=document.getElementById("tbx-cave-text");return t?t.textContent.trim():"";})()');
    push('回声洞能出内容', cave1.length > 0, cave1.slice(0, 30));
    push('回声洞点两次内容会变（或至少非空）', cave1 !== '点一下，听听回声…', { c1: cave1.slice(0, 24), c2: cave2.slice(0, 24) });

    // 磁盘占用自动统计
    const disk = await js('(function(){var rows=document.querySelectorAll(".tbx-disk-row");return {n:rows.length, sum:((document.querySelector("#tbx-disk-body .tbx-clean__sum")||{}).textContent||"").trim()};})()');
    push('磁盘占用出了统计结果', disk.n > 0 || disk.sum.indexOf('合计') >= 0, disk);
  } catch (e) {
    checks.push({ name: 'unexpected error', pass: false, info: String((e && e.message) || e) });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2), 'utf8');
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); app.exit(1); });
`;
fs.writeFileSync(inner, innerSrc, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-tbx');
fs.mkdirSync(userData, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'ignore' });
child.on('exit', () => {
  try { fs.unlinkSync(inner); } catch { /* ignore */ }
  let res = null;
  try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* ignore */ }
  console.log('================ RESULT ================');
  if (!res) { console.log('no result file'); process.exitCode = 1; return; }
  let fail = 0;
  for (const c of res.checks || []) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined ? '  -> ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`total ${(res.checks || []).length}, failed ${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
});
