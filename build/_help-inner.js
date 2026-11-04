'use strict';
/**
 * 验收内层进程：说明页（中文补丁 / 远古版本·Betacraft / 加载器 / 目录 / FAQ）
 * 真实起 Electron + 真实 qcl:// 协议 + 真实主进程 IPC（含新加的 app:help）。
 */
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const OUT = path.join(ROOT, '.cache', 'help-page-result.json');
const SHOT = path.join(ROOT, 'docs', '_help-page.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
  { scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try {
      return await net.fetch(pathToFileURL(t).toString());
    } catch {
      return new Response('404');
    }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: path.dirname(HOME), homeOverride: HOME });
  settings.load();
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('页面加载超时')), 60000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t);
      res();
    });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await sleep(14000);

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const result = { ok: false, checks: [] };
  const push = (name, pass, info) => result.checks.push({ name, pass, info });

  try {
    /* ① 左栏有「使用说明」入口 */
    const navInfo = await js(
      `Array.from(document.querySelectorAll('#leftnav [data-nav]')).map(function(b){return {id:b.dataset.nav,tip:b.getAttribute('data-tip')};})`
    );
    const navHelp = (navInfo || []).find((x) => x.id === 'help');
    push('① 左栏有「使用说明」按钮', !!navHelp, navHelp || navInfo);

    /* ② 点进去 */
    await js(`(document.querySelector('#leftnav [data-nav="help"]')||{click(){}}).click();`);
    await sleep(2500);
    const title = await js(`(function(){var t=document.querySelector('.page__title');return t?t.textContent.trim():'';})()`);
    push('② 页面标题是「使用说明」', title === '使用说明', title);

    /* ③ 五个分页都在 */
    const tabs = await js(
      `Array.from(document.querySelectorAll('.doc__tab')).map(function(b){return {id:b.getAttribute('data-doc-tab'),label:b.textContent.trim(),active:b.classList.contains('is-active')};})`
    );
    const ids = (tabs || []).map((t) => t.id);
    push('③ 五个分页都在（中文补丁/远古/加载器/目录/FAQ）', ids.length === 5, ids);
    push('③.2 默认停在「中文补丁」', !!(tabs || []).find((t) => t.id === 'chinese' && t.active), tabs && tabs[0]);

    /* ④ 每个分页都能点、都有内容、都不是白屏 */
    const labels = ['chinese', 'legacy', 'loaders', 'layout', 'faq'];
    for (let i = 0; i < labels.length; i++) {
      const id = labels[i];
      await js(`(document.querySelector('.doc__tab[data-doc-tab="${id}"]')||{click(){}}).click();`);
      await sleep(700);
      const info = await js(
        `(function(){var c=document.querySelector('.doc__content'); if(!c) return {len:0,cards:0,tables:0};
          return {len:(c.textContent||'').trim().length, cards:c.querySelectorAll('.card').length,
                  tables:c.querySelectorAll('.doc__table').length, steps:c.querySelectorAll('.doc__steps').length,
                  active:(document.querySelector('.doc__tab.is-active')||{}).getAttribute?document.querySelector('.doc__tab.is-active').getAttribute('data-doc-tab'):''};})()`
      );
      push(`④ 分页「${id}」有内容且高亮正确`, !!(info && info.len > 300 && info.cards > 0 && info.active === id), info);
      if (id === 'chinese') {
        result.chineseTab = info;
        const txt = await js(`(document.querySelector('.doc__content')||{}).textContent||''`);
        push('④.1 中文补丁页写了 77 组规则（app:help 实时值）', /77\s*组规则/.test(txt), (txt.match(/\d+\s*组规则/) || [])[0] || txt.slice(0, 120));
        push('④.2 中文补丁页写了 71 个可用补丁包', /71\s*个可用补丁包/.test(txt), (txt.match(/\d+\s*个可用补丁包/) || [])[0]);
        await win.webContents
          .capturePage()
          .then((img) => fs.writeFileSync(path.join(ROOT, 'docs', '_help-chinese.png'), img.toPNG()));
      }
    }

    /* ⑤ 远古版本页讲了 Betacraft 与 258 条归档 */
    await js(`(document.querySelector('.doc__tab[data-doc-tab="legacy"]')||{click(){}}).click();`);
    await sleep(700);
    const legacyTxt = await js(`(document.querySelector('.doc__content')||{}).textContent||''`);
    push('⑤ 写了「中国版 Betacraft」', /中国版\s*Betacraft/.test(legacyTxt), (legacyTxt.match(/中国版\s*Betacraft/) || [])[0]);
    push('⑤.2 写了 258 条归档', /258/.test(legacyTxt), (legacyTxt.match(/\d+\s*条/) || [])[0]);
    push('⑤.3 写了 betacraft.uk 代理参数', /betacraft\.uk/.test(legacyTxt), true);
    push('⑤.4 老实列了还没搬过来的能力', /还没从 Betacraft 搬过来/.test(legacyTxt), true);
    await win.webContents.capturePage().then((img) => fs.writeFileSync(SHOT, img.toPNG()));

    /* ⑥ 加载器页的推荐分档 */
    await js(`(document.querySelector('.doc__tab[data-doc-tab="loaders"]')||{click(){}}).click();`);
    await sleep(700);
    const loadTxt = await js(`(document.querySelector('.doc__content')||{}).textContent||''`);
    push('⑥ 加载器页写了 1.14 分档与 ModLoader/Babric', /1\.14/.test(loadTxt) && /ModLoader/.test(loadTxt) && /Babric/.test(loadTxt), true);

    /* ⑦ 设置 → 关于 的入口（设置页分页是 #st-tabs .vset__tab[data-tab]） */
    await js(`(document.querySelector('#leftnav [data-nav="setting"]')||{click(){}}).click();`);
    await sleep(1800);
    const aboutTabBtn = await js(
      `(function(){var b=document.querySelector('#st-tabs .vset__tab[data-tab="about"]'); if(b){b.click(); return true;} return false;})()`
    );
    push('⑦ 设置里有「关于」分页', !!aboutTabBtn, aboutTabBtn);
    await sleep(1200);
    const hasHelpBtn = await js(`!!document.querySelector('#st-openhelp')`);
    push('⑦.2 设置→关于 有「使用说明」按钮', hasHelpBtn, hasHelpBtn);
    if (hasHelpBtn) {
      await js(`document.querySelector('#st-openhelp').click()`);
      await sleep(2000);
      const t2 = await js(`(function(){var t=document.querySelector('.page__title');return t?t.textContent.trim():'';})()`);
      push('⑦.3 点它能跳到说明页', t2 === '使用说明', t2);
    }

    /* ⑧ 关于页也有入口 */
    await js(`window.dispatchEvent(new CustomEvent('qcl:test-noop'))`);
    const aboutPageBtn = await js(
      `(function(){ var b=document.querySelector('[data-nav="help"]'); return !!b; })()`
    );
    result.hasBack = aboutPageBtn;

    result.ok = result.checks.every((c) => c.pass);
  } catch (e) {
    result.error = (e && e.stack) || String(e);
  }

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  console.log('RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks, error: result.error || null }, null, 2));
  app.exit(0);
}).catch((e) => {
  console.log('FATAL ' + ((e && e.stack) || e));
  app.exit(1);
});
