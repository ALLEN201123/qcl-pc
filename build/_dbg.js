const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const ROOT = process.argv[process.argv.length - 3];
const ERRF = process.argv[process.argv.length - 2];
const OUTF = process.argv[process.argv.length - 1];
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const log = (m) => { try { fs.appendFileSync(ERRF, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
process.on('uncaughtException', (e) => { log('UNCAUGHT ' + (e && e.stack || e)); try { app.exit(9); } catch {} });
process.on('unhandledRejection', (e) => { log('REJECT ' + (e && e.stack || e)); });
log('boot ROOT=' + ROOT);
protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
app.whenReady().then(async () => {
  log('ready');
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    if (rel.startsWith('__instanceicon__/')) {
      const name = rel.slice('__instanceicon__/'.length);
      if (!/^[A-Za-z0-9_-]+\.png$/i.test(name)) return new Response('403', { status: 403 });
      const p = path.normalize(path.join(HOME, 'icons', name));
      if (!fs.existsSync(p)) return new Response('404', { status: 404 });
      return await net.fetch(pathToFileURL(p).toString());
    }
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch (e) { log('404 ' + rel); return new Response('404'); }
  });
  log('protocol ok');
  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: path.dirname(HOME), homeOverride: HOME });
  settings.load();
  log('settings ok home=' + settings.value('home'));
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();
  log('ipc ok');
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, lvl, msg, line, src) => { if (lvl >= 2) log('CONSOLE[' + lvl + '] ' + msg + ' @' + src + ':' + line); });
  win.webContents.on('render-process-gone', (e, d) => log('RENDER GONE ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (e, p, err) => log('PRELOAD ERROR ' + p + ' ' + (err && err.stack || err)));
  win.webContents.on('did-fail-load', (e, c, d, u) => log('FAIL LOAD ' + c + ' ' + d + ' ' + u));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('load timeout')), 60000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
    win.loadURL('qcl://app/index.html');
    await loaded;
    log('page loaded');
    await sleep(13000);
    const js = (c) => win.webContents.executeJavaScript(c, true);
    const insts = await js('(async()=>{const m=await import("qcl://app/js/store.js"); return m.state.instances.map(function(i){return {id:i.id,name:i.name,icon:i.icon,iconUrl:i.iconUrl||null}});})()');
    log('instances=' + JSON.stringify(insts));
    const nav = async (p) => { await js('(document.querySelector(\'[data-nav="' + p + '"]\')||{click(){}}).click()'); await sleep(2600); };
    const target = (insts || []).find((i) => i.icon === 'diamond') || (insts || [])[0];
    const checks = [];
    const P = (n, p, i) => checks.push({ n, p, i });
    P('store has instance', !!target, insts);
    await nav('home');
    const homeSrc = await js('(function(){var c=document.querySelector(\'#home-inst-grid [data-inst="' + target.id + '"] img\');return c?c.getAttribute("src"):null;})()');
    P('home card icon', !!homeSrc && homeSrc.indexOf('diamond') >= 0, homeSrc);
    const rightSrc = await js('(function(){var v=document.getElementById("version-icon");return v?v.getAttribute("src"):null;})()');
    P('right row icon', !!rightSrc && rightSrc.indexOf('diamond') >= 0, rightSrc);
    await nav('versionlist');
    const rowSrc = await js('(function(){var r=document.querySelector(\'.row[data-id="' + target.id + '"] img.row__icon\');return r?r.getAttribute("src"):null;})()');
    P('version list row icon', !!rowSrc && rowSrc.indexOf('diamond') >= 0, rowSrc);
    await nav('versionsetting');
    const vs = await js('(function(){var c=document.querySelector(".icon-current__img");var a=document.querySelector(".icon-grid__item.is-active img");return {current:c?c.getAttribute("src"):null, active:a?a.getAttribute("src"):null, grid:document.querySelectorAll(".icon-grid__item").length};})()');
    P('settings current icon', !!vs.current && vs.current.indexOf('diamond') >= 0, vs.current);
    P('settings grid highlight', !!vs.active && vs.active.indexOf('diamond') >= 0, vs.active);
    P('grid has 24', vs.grid === 24, vs.grid);
    fs.writeFileSync(OUTF, JSON.stringify({ checks }, null, 2), 'utf8');
    log('done fail=' + checks.filter((c) => !c.p).length);
  } catch (e) {
    log('CAUGHT ' + (e && e.stack || e));
    fs.writeFileSync(OUTF, JSON.stringify({ checks: [{ n: 'exception', p: false, i: String(e && e.message || e) }] }, null, 2), 'utf8');
  }
  app.exit(0);
}).catch((e) => { log('BOOT FAIL ' + (e && e.stack || e)); app.exit(1); });