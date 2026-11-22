'use strict';
/**
 * 新建服务端对话框验收（1.0.8 三个问题的回归）
 *
 * 用户反馈三件事：
 *   ① 点开新建，服务端会卡成屎        → 必须「立刻弹窗」，不能被网络请求挡住
 *   ② 没有远古版本、快照版本的选项    → 必须有四组：正式版/快照/远古版本/手动填
 *   ③ 模组端没有 forge 和 neoforge    → 核心列表必须有这两个，且后端能真解析
 *
 * 窗口 show:false。用法：node build/verify-server-createdialog2.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'dlg2-result.json');
const HOME = path.join(os.tmpdir(), '_qcl_dlg2_home');

/* 外层准备隔离 HOME */
function prep() {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const d of ['', 'logs', 'meta', 'instances', 'servers']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
}
prep();

const inner = path.join(__dirname, '_dlg2-inner.js');
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
    await js('(function(){var b=document.querySelector("[data-nav=server]");if(b)b.click();})()');
    await sleep(5000);

    // ★ 关键：点按钮后**立刻**检查弹窗（不给它等网络的时间）
    const t0 = Date.now();
    await js('(function(){var b=document.getElementById("srv-new");if(b)b.click();})()');
    // 只等 700ms —— 如果还被 server:options 挡着，这时候弹窗一定还没出来
    await sleep(700);
    const quick = await js('(function(){var r=document.getElementById("modal-root");return {' +
      'shown: r && r.hidden===false,' +
      'hasModal: !!(r && r.querySelector(".modal")),' +
      'title: ((r && r.querySelector(".modal__title"))||{}).textContent||""' +
      '};})()');
    const elapsed = Date.now() - t0;
    P('★ 点按钮后 700ms 内就弹窗（不卡）', quick.hasModal === true, { 耗时ms: elapsed, shown: quick.shown });
    P('对话框标题正确', /新建服务端/.test(quick.title), quick.title);

    // 核心列表
    await sleep(1500);
    const kinds = await js('(function(){' +
      'var bs=document.querySelectorAll("#modal-root [data-kind]");' +
      'return {count:bs.length, list:Array.from(bs).map(function(b){return b.getAttribute("data-kind")})};})()');
    P('核心按钮 6 个', kinds.count === 6, kinds.list);
    P('★ 有 Forge', kinds.list.indexOf('forge') >= 0, kinds.list);
    P('★ 有 NeoForge', kinds.list.indexOf('neoforge') >= 0, kinds.list);
    P('有原版/Paper/Purpur/Fabric', ['vanilla','paper','purpur','fabric'].every(function(k){return kinds.list.indexOf(k)>=0}), kinds.list);

    // 版本分组
    const groups = await js('(function(){' +
      'var bs=document.querySelectorAll("#modal-root [data-group]");' +
      'return {count:bs.length, list:Array.from(bs).map(function(b){return b.getAttribute("data-group")})};})()');
    P('版本分组 4 个', groups.count === 4, groups.list);
    P('★ 有「快照」分组', groups.list.indexOf('snapshot') >= 0, groups.list);
    P('★ 有「远古版本」分组', groups.list.indexOf('ancient') >= 0, groups.list);
    P('有「正式版」「手动填」', groups.list.indexOf('release') >= 0 && groups.list.indexOf('manual') >= 0);

    // 切到远古版本分组，看下拉框有没有内容（等待归档加载）
    await js('(function(){var b=document.querySelector("#modal-root [data-group=ancient]");if(b)b.click();})()');
    await sleep(2500); // 兜底清单是同步的，很快就该有内容
    const anc = await js('(function(){' +
      'var sel=document.getElementById("sc-version");' +
      'var hint=document.getElementById("sc-version-hint");' +
      'var opts=sel?Array.from(sel.options).map(function(o){return o.value}).filter(Boolean):[];' +
      'return {count:opts.length, sample:opts.slice(0,8), all:opts, hint:(hint||{}).textContent||""};})()');
    P('★ 远古版本下拉有内容', anc.count > 0, { 数量: anc.count, 样例: anc.sample });
    P('远古版里有 Beta 类（b 开头）', anc.sample.some(function(v){return /^b/i.test(v)}), anc.sample);
    // ★ 断言要看全量而不是前 8 个：Beta 排在前（b1.9-pre6…），Alpha/Classic 在后面
    P(
      '远古版里有 Alpha 或 Classic',
      (anc.all || []).some(function (v) { return /^[ac]/i.test(v); }),
      (anc.all || []).filter(function (v) { return /^[ac]/i.test(v); }).slice(0, 5)
    );

    // 切到快照分组
    await js('(function(){var b=document.querySelector("#modal-root [data-group=snapshot]");if(b)b.click();})()');
    await sleep(2500);
    const snap = await js('(function(){' +
      'var sel=document.getElementById("sc-version");' +
      'var opts=sel?Array.from(sel.options).map(function(o){return o.value}).filter(Boolean):[];' +
      'return {count:opts.length, sample:opts.slice(0,6)};})()');
    P('★ 快照下拉有内容', snap.count > 0, { 数量: snap.count, 样例: snap.sample });

    // 切到正式版
    await js('(function(){var b=document.querySelector("#modal-root [data-group=release]");if(b)b.click();})()');
    await sleep(2000);
    const rel = await js('(function(){' +
      'var sel=document.getElementById("sc-version");' +
      'var opts=sel?Array.from(sel.options).map(function(o){return o.value}).filter(Boolean):[];' +
      'return {count:opts.length, sample:opts.slice(0,5)};})()');
    P('正式版下拉有内容', rel.count > 0, { 数量: rel.count, 样例: rel.sample });

    // 手动填分组
    await js('(function(){var b=document.querySelector("#modal-root [data-group=manual]");if(b)b.click();})()');
    await sleep(800);
    const man = await js('(function(){' +
      'var mf=document.getElementById("sc-manual-field");' +
      'var vf=document.getElementById("sc-version-field");' +
      'return {manualShown: mf && !mf.hidden, versionHidden: vf && vf.hidden};})()');
    P('手动填分组会显示输入框', man.manualShown === true, man);
    P('手动填时隐藏下拉框', man.versionHidden === true, man);
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
const ud = path.join(ROOT, '.cache', 'ud-dlg2');
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
