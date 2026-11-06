'use strict';
/**
 * Verify: instance icon actually shows up in all three display points.
 *
 * User report: "custom instance icon in version settings never takes effect,
 *               version list / home / right panel always show the grass block"
 *
 * Root causes (all fixed):
 *   1. versionlist.js: `inst.loader.type || inst.icon` -- loader always wins,
 *      so inst.icon was never read; and every loader mapped to ic_grass
 *   2. shell.js: right-panel img hardcoded ic_grass
 *   3. backend hydrate() never returned iconFile -> custom PNG unreachable
 *
 * NOTE: window runs hidden (show:false). Never flash a window at the user.
 * Usage: node build/verify-instance-icon.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'instance-icon-result.json');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const inner = path.join(__dirname, '_icon-inner.js');
// ASCII-only payload: mixing Chinese through PowerShell Out-File corrupts UTF-8.
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

  // show:false -- must never flash a window at the user during automated checks
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
    const logic = await js(\`(async()=>{
      const m = await import('qcl://app/js/instanceicon.js');
      return {
        custom: m.instanceIconUrl({ id:'x', icon:'grass', iconUrl:'qcl://app/__instanceicon__/x.png' }),
        customNoUrl: m.instanceIconUrl({ id:'x', icon:'grass', iconFile:'C:/a/b/diamond.png' }),
        preset: m.instanceIconUrl({ id:'x', icon:'diamond' }),
        fallback: m.instanceIconUrl({ id:'x', icon:'nonexistent-thing' }),
        nullInst: m.instanceIconUrl(null),
        presetCount: m.PRESET_ICONS.length
      };
    })()\`);
    push('custom image wins over preset', logic.custom === 'qcl://app/__instanceicon__/x.png', logic.custom);
    push('iconFile-only resolves to url', logic.customNoUrl === 'qcl://app/__instanceicon__/diamond.png', logic.customNoUrl);
    push('preset resolves to instance-icons dir', logic.preset === './assets/instance-icons/diamond.png', logic.preset);
    push('unknown name falls back to grass', logic.fallback === './assets/icon/ic_grass.png', logic.fallback);
    push('null instance does not crash', logic.nullInst === './assets/icon/ic_grass.png', logic.nullInst);
    push('24 preset icons available', logic.presetCount === 24, logic.presetCount);

    const targets = await js('(async()=>{const m=await import("qcl://app/js/store.js"); return m.state.instances.map(function(i){return {id:i.id,name:i.name,icon:i.icon,iconUrl:i.iconUrl||null}});})()');
    push('store exposes icon field', Array.isArray(targets) && targets.length > 0, targets);

    const target = targets && targets[0];
    if (target) {
      const instMod = require(path.join(ROOT, 'src', 'main', 'core', 'instances.js'));
      const before = await instMod.get(HOME, target.id);

      const safeUpdate = async (patch) => {
        for (let i = 0; i < 4; i += 1) {
          try { return await instMod.update(HOME, target.id, patch); }
          catch (e) { if (i === 3) throw e; await sleep(400); }
        }
        return null;
      };
      await safeUpdate({ icon: 'diamond', iconFile: null });
      await sleep(400);
      await js('(async()=>{const m=await import("qcl://app/js/store.js"); await m.loadInstances();})()');
      await js('(document.querySelector(String.fromCharCode(91)+"data-nav="+String.fromCharCode(34)+"home"+String.fromCharCode(34)+String.fromCharCode(93))||{click(){}}).click();');
      await sleep(2500);

      const shown = await js(\`(function(){
        var card = document.querySelector('#home-inst-grid [data-inst="\${target.id}"] img');
        var vicon = document.getElementById('version-icon');
        return {
          home: card ? card.getAttribute('src') : null,
          rightAttr: vicon ? vicon.getAttribute('src') : null
        };
      })()\`);
      push('home card shows diamond', !!shown.home && shown.home.indexOf('diamond') >= 0, shown.home);
      push('right version row shows diamond', !!shown.rightAttr && shown.rightAttr.indexOf('diamond') >= 0, shown.rightAttr);

      await js('(document.querySelector(String.fromCharCode(91)+"data-nav="+String.fromCharCode(34)+"versionlist"+String.fromCharCode(34)+String.fromCharCode(93))||{click(){}}).click();');
      await sleep(2500);
      const vlist = await js(\`(function(){
        var row = document.querySelector('.row[data-id="\${target.id}"] img.row__icon');
        return row ? row.getAttribute('src') : null;
      })()\`);
      push('version list row shows diamond', !!vlist && vlist.indexOf('diamond') >= 0, vlist);

      await safeUpdate({ icon: 'creeper', iconFile: null });
      await js('(async()=>{const m=await import("qcl://app/js/store.js"); await m.loadInstances();})()');
      await js('(document.querySelector(String.fromCharCode(91)+"data-nav="+String.fromCharCode(34)+"versionlist"+String.fromCharCode(34)+String.fromCharCode(93))||{click(){}}).click();');
      await sleep(2500);
      const vlist2 = await js(\`(function(){
        var row = document.querySelector('.row[data-id="\${target.id}"] img.row__icon');
        return row ? row.getAttribute('src') : null;
      })()\`);
      push('switching to creeper takes effect too', !!vlist2 && vlist2.indexOf('creeper') >= 0, vlist2);

      await safeUpdate({ icon: before.icon || 'grass', iconFile: before.iconFile || null });
      push('instance restored to original icon', true, before.icon);
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
const userData = path.join(ROOT, '.cache', 'userdata-icon');
fs.mkdirSync(userData, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', `--user-data-dir=${userData}`], { env, stdio: 'ignore' });
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
