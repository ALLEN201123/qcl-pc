'use strict';
/**
 * Verify (read-only): the three display points actually use inst.icon.
 *
 * Does NOT write any file inside the data directory -- the Electron test process
 * under --no-sandbox cannot write there (EPERM), so mutating state is done from
 * the plain-node side beforehand. This script only inspects the DOM.
 *
 * Pre-req: instance icon already set to 'diamond' (done by caller via node).
 * Usage: node build/verify-icon-dom.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'icon-dom-result.json');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const inner = path.join(__dirname, '_icondom-inner.js');
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
  // build selector strings without any quote nesting: avoid \' inside template literals
  const Q = String.fromCharCode(39);   // single quote
  const DQ = String.fromCharCode(34);  // double quote
  const BR_L = String.fromCharCode(91), BR_R = String.fromCharCode(93);
  const clickNav = async (page) => {
    // attribute selector uses double quotes inside, so wrap the querySelector argument in single quotes
    const sel = BR_L + 'data-nav=' + DQ + page + DQ + BR_R;
    await js('(document.querySelector(' + Q + sel + Q + ')||{click:function(){}}).click();');
    await sleep(2600);
  };

  try {
    const insts = await js('(async()=>{const m=await import("qcl://app/js/store.js"); return m.state.instances.map(function(i){return {id:i.id,icon:i.icon,iconUrl:i.iconUrl||null}});})()');
    const target = (insts || []).find((i) => i.icon === 'diamond') || (insts || [])[0];
    push('store 读到实例且 icon=diamond', !!target && target.icon === 'diamond', insts);

    if (target) {
      await clickNav('home');
      // find the card by data-inst attribute value instead of building a nested-quote selector
      const home = await js(
        '(function(){var cards=document.querySelectorAll(' + DQ + '#home-inst-grid [data-inst]' + DQ + ');' +
        'for(var i=0;i<cards.length;i++){if(cards[i].getAttribute(' + DQ + 'data-inst' + DQ + ')===' + DQ + target.id + DQ + '){' +
        'var im=cards[i].querySelector(' + DQ + 'img' + DQ + ');return im?im.getAttribute(' + DQ + 'src' + DQ + '):null;}}return null;})()'
      );
      push('主页实例卡显示 diamond', !!home && home.indexOf('diamond') >= 0, home);

      const right = await js('(function(){ var v=document.getElementById("version-icon"); return v?v.getAttribute("src"):null; })()');
      push('右栏版本行显示 diamond', !!right && right.indexOf('diamond') >= 0, right);

      await clickNav('versionlist');
      const row = await js(
        '(function(){var rows=document.querySelectorAll(' + DQ + '.row[data-id]' + DQ + ');' +
        'for(var i=0;i<rows.length;i++){if(rows[i].getAttribute(' + DQ + 'data-id' + DQ + ')===' + DQ + target.id + DQ + '){' +
        'var im=rows[i].querySelector(' + DQ + 'img.row__icon' + DQ + ');return im?im.getAttribute(' + DQ + 'src' + DQ + '):null;}}return null;})()'
      );
      push('版本列表行显示 diamond', !!row && row.indexOf('diamond') >= 0, row);

      await clickNav('versionsetting');
      // version settings opens on the "overview" tab; must click the 图标 tab first
      await js('(function(){var bs=document.querySelectorAll(' + DQ + '[data-tab]' + DQ + ');for(var i=0;i<bs.length;i++){if(bs[i].getAttribute(' + DQ + 'data-tab' + DQ + ')===' + DQ + 'icon' + DQ + '){bs[i].click();return true;}}return false;})()');
      await sleep(1800);
      const vs = await js('(function(){var c=document.querySelector(".icon-current__img");var a=document.querySelector(".icon-grid__item.is-active img");return { current: c?c.getAttribute("src"):null, active: a?a.getAttribute("src"):null, grid: document.querySelectorAll(".icon-grid__item").length };})()');
      push('版本设置「当前」大图显示 diamond', !!vs.current && vs.current.indexOf('diamond') >= 0, vs.current);
      push('版本设置网格高亮 diamond', !!vs.active && vs.active.indexOf('diamond') >= 0, vs.active);

      const gridCount = vs.grid;
      push('图标网格有 24 个可选项', gridCount === 24, gridCount);
    }
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
const userData = path.join(ROOT, '.cache', 'userdata-icondom');
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
