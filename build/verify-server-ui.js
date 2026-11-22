'use strict';
/**
 * Verify (hidden window): 服务端页面能打开、能渲染、能切 tab。
 *
 * ★ 分工（踩过 EPERM）：
 *   Electron 测试进程写数据目录会报 EPERM（与之前 junction / instance.json 同源），
 *   所以**测试服由外层用纯 node 预先建好**，内层只读验证 DOM。
 *
 * 窗口 show:false，绝不打扰用户。
 * 用法：node build/verify-server-ui.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'server-ui-result.json');
const HOME = path.join(os.tmpdir(), '_qcl_srvui_home');

/* ---------- 外层：用纯 node 准备隔离 HOME 与一个测试服 ---------- */
const srv = require(path.join(ROOT, 'src', 'main', 'core', 'server.js'));

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const d of ['', 'logs', 'meta', 'instances', 'servers']) {
    fs.mkdirSync(path.join(HOME, d), { recursive: true });
  }
  // 一个测试服（不下载 jar，只为让列表里有东西可渲染）
  const meta = srv.create(HOME, { name: 'UI 验收服', kind: 'paper', mcVersion: '1.20.1', port: 25581 });
  const work = srv.workDir(HOME, meta.id);
  // 造个假世界，让备份 tab 有东西可算
  fs.mkdirSync(path.join(work, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(work, 'world', 'level.dat'), 'x'.repeat(256));
  // 生成一份 server.properties（配置 tab 才有内容）
  const props = require(path.join(ROOT, 'src', 'main', 'core', 'serverprops.js'));
  props.ensure(work, { motd: 'UI 验收服', 'server-port': 25581 });
  return meta.id;
}

let testServerId = '';
try {
  testServerId = prepareHome();
  console.log('已准备测试服:', testServerId);
} catch (e) {
  console.log('准备测试数据失败:', e.message);
}

/* ---------- 内层：只读验证 ---------- */
const inner = path.join(__dirname, '_srvui-inner.js');
const innerSrc = `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const OUT = ${JSON.stringify(OUT)};
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
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('load timeout')), 60000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await sleep(13000);

  const js = (c) => win.webContents.executeJavaScript(c, true);
  const checks = [];
  const push = (name, pass, info) => checks.push({ name, pass, info });
  const navSel = BL + 'data-nav=' + DQ + 'server' + DQ + BR;

  try {
    const hasNav = await js('!!document.querySelector(' + Q + navSel + Q + ')');
    push('左栏有「服务端」导航按钮', hasNav === true);
    push('导航提示文字是「服务端」', (await js('(function(){var b=document.querySelector(' + Q + navSel + Q + ');return b?b.getAttribute("data-tip"):null;})()')) === '服务端');

    const clickRes = await js('(function(){var b=document.querySelector(' + Q + navSel + Q + ');if(!b)return "no-button";b.click();return "clicked";})()');
    push('点击导航按钮', clickRes === 'clicked', clickRes);
    await sleep(6000);

    const dom = await js('(function(){return {' +
      'title: (document.querySelector(".page__title")||{}).textContent||"",' +
      'hasSide: !!document.getElementById("srv-side"),' +
      'hasMain: !!document.getElementById("srv-main"),' +
      'hasNewBtn: !!document.getElementById("srv-new"),' +
      'failed: /页面加载失败/.test(document.body.innerText||"")' +
      '};})()');
    push('页面没有「加载失败」', dom.failed === false);
    push('页面标题含「服务端」', /服务端/.test(dom.title), dom.title);
    push('侧栏容器存在', dom.hasSide === true);
    push('主区容器存在', dom.hasMain === true);
    push('有「新建服务端」按钮', dom.hasNewBtn === true);

    // 侧栏应列出外层建好的测试服
    const list = await js('(function(){return {' +
      'items: document.querySelectorAll("#srv-side [data-id]").length,' +
      'firstName: ((document.querySelector("#srv-side .srv-item__name")||{}).textContent||"").trim(),' +
      'tabs: document.querySelectorAll("#srv-tabs [data-tab]").length' +
      '};})()');
    push('侧栏列出服务端', list.items > 0, list.items);
    push('侧栏显示服务端名', list.firstName === 'UI 验收服', list.firstName);
    push('有 5 个 tab', list.tabs === 5, list.tabs);

    // 逐 tab 切
    const tabLen = {};
    for (const t of ['console', 'config', 'rcon', 'backup', 'diag']) {
      await js('(function(){var b=document.querySelector(' + Q + '#srv-tabs [data-tab=' + DQ + t + DQ + ']' + Q + ');if(b)b.click();})()');
      await sleep(t === 'config' ? 2800 : 2000);
      tabLen[t] = await js('(function(){var p=document.getElementById("srv-panel");return p?p.innerHTML.length:0;})()');
    }
    push('控制台 tab 有内容', tabLen.console > 200, tabLen.console);
    push('配置 tab 有内容', tabLen.config > 500, tabLen.config);
    push('RCON tab 有内容', tabLen.rcon > 200, tabLen.rcon);
    push('备份 tab 有内容', tabLen.backup > 200, tabLen.backup);
    push('诊断 tab 有内容', tabLen.diag > 150, tabLen.diag);

    // 配置字段
    await js('(function(){var b=document.querySelector(' + Q + '#srv-tabs [data-tab=' + DQ + 'config' + DQ + ']' + Q + ');if(b)b.click();})()');
    await sleep(2800);
    const cfg = await js('(function(){return {' +
      'fields: document.querySelectorAll("[data-key]").length,' +
      'groups: document.querySelectorAll(".srv-group").length,' +
      'presets: document.querySelectorAll("[data-preset]").length,' +
      'hasSave: !!document.getElementById("srv-props-save"),' +
      'motdVal: (function(){var e=document.querySelector("[data-key=motd]");return e?e.value:null;})()' +
      '};})()');
    push('配置渲染出全部字段', cfg.fields >= 46, cfg.fields);
    push('配置分成 5 组', cfg.groups === 5, cfg.groups);
    push('有 5 个预设按钮', cfg.presets === 5, cfg.presets);
    push('有保存按钮', cfg.hasSave === true);
    push('配置读到了实际 motd', cfg.motdVal === 'UI 验收服', cfg.motdVal);

    // 备份 tab 按钮
    await js('(function(){var b=document.querySelector(' + Q + '#srv-tabs [data-tab=' + DQ + 'backup' + DQ + ']' + Q + ');if(b)b.click();})()');
    await sleep(2200);
    const bk = await js('(function(){return {' +
      'hasBackupNow: !!document.getElementById("srv-bk-now"),' +
      'hasAutoSave: !!document.getElementById("srv-abk-save"),' +
      'hasFull: !!document.getElementById("srv-bk-full")' +
      '};})()');
    push('备份 tab 有「立即备份」', bk.hasBackupNow === true);
    push('备份 tab 有「全量备份」', bk.hasFull === true);
    push('有自动备份设置', bk.hasAutoSave === true);

    // RCON tab 的开关
    await js('(function(){var b=document.querySelector(' + Q + '#srv-tabs [data-tab=' + DQ + 'rcon' + DQ + ']' + Q + ');if(b)b.click();})()');
    await sleep(2400);
    const rc = await js('(function(){return {' +
      'hasEnable: !!document.getElementById("srv-rcon-enable"),' +
      'hasCmd: !!document.getElementById("srv-rcon-cmd"),' +
      'hasBroadcast: !!document.getElementById("srv-bc-text")' +
      '};})()');
    push('RCON 未开时有「一键开启」按钮', rc.hasEnable === true);
    push('RCON tab 有命令输入区', rc.hasCmd === true);
    push('RCON tab 有广播区', rc.hasBroadcast === true);
  } catch (e) {
    push('过程异常', false, String((e && e.message) || e));
  }

  fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2), 'utf8');
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); app.exit(1); });
`;
fs.writeFileSync(inner, innerSrc, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-srvui');
fs.rmSync(userData, { recursive: true, force: true });
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
  // 清理测试服
  try {
    if (testServerId) srv.remove(HOME, testServerId);
  } catch { /* ignore */ }
  process.exitCode = fail === 0 ? 0 : 1;
});
