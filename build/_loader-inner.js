'use strict';
/**
 * 验收内层进程：真实起 Electron，跑真实主进程 IPC + 真实渲染器。
 * 覆盖 install:start / instances:create / content:download* 三个会写盘下载的通道，
 * 只把 payload 记下来 —— 其余（含 loader:versions / content:search / content:versions）全走真的。
 */
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const OUT = path.join(ROOT, '.cache', 'loader-picker-result.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[inner]', ...a);

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

  /* ---------- 只记录不执行的三条写盘通道 ---------- */
  const rec = { installStart: null, create: null, downloads: [] };
  const stub = (ch, fn) => {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* ignore */
    }
    ipcMain.handle(ch, async (e, payload) => fn(payload));
  };
  stub('install:start', (p) => {
    rec.installStart = p;
    return { taskId: 'test-task-1' };
  });
  stub('instances:create', (p) => {
    rec.create = p;
    return { id: 'test-inst', name: (p && p.name) || '测试实例' };
  });
  stub('content:download', (p) => {
    rec.downloads.push({ channel: 'content:download', p });
    return { taskId: 'test-task-2' };
  });
  stub('content:downloadMany', (p) => {
    rec.downloads.push({ channel: 'content:downloadMany', p });
    return { taskId: 'test-task-3' };
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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

  const result = { ok: false, checks: [], payloads: rec };
  const push = (name, pass, info) => result.checks.push({ name, pass, info });

  /** 打开某个版本号的加载器弹窗（游戏分类 + 可选二级分页 + 搜索版本号） */
  async function openModal(versionId, tab) {
    await js(`(document.querySelector('.dlcat[data-cat="game"]')||{click(){}}).click();`);
    await sleep(1200);
    if (tab) {
      await js(
        `(function(){var b=document.querySelector('#dl-game-tabs [data-t="${tab}"]'); if(b)b.click();})()`
      );
      await sleep(3500);
    }
    await js(
      `(function(){var el=document.getElementById('dl-search'); if(!el) return; el.value='${versionId}'; el.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await sleep(200);
    await js(`(document.getElementById('dl-do-search')||{click(){}}).click();`);
    await sleep(3500);
    let has = await js(`!!document.querySelector('.dlcard--version[data-id="${versionId}"]')`);
    if (!has) {
      // 列表太长时首屏可能没渲染到，直接按 id 再点一次「搜索」
      await sleep(2500);
      has = await js(`!!document.querySelector('.dlcard--version[data-id="${versionId}"]')`);
    }
    if (!has) {
      const sample = await js(
        `Array.from(document.querySelectorAll('.dlcard--version')).slice(0,6).map(e=>e.getAttribute('data-id'))`
      );
      return { error: '卡片没出现', sample };
    }
    await js(
      `(function(){var b=document.querySelector('.dlcard--version[data-id="${versionId}"] [data-act="install"]'); if(b) b.click();})()`
    );
    await sleep(900);
    return { ok: true };
  }

  async function readRec() {
    return js(`(function(){
      var tag=document.querySelector('.modal--loader [data-rectag]:not([hidden])');
      var rows={}; var loading=0;
      document.querySelectorAll('.modal--loader .loader-item').forEach(function(r){
        var t=r.getAttribute('data-loader');
        var ve=r.querySelector('.loader-item__ver');
        var txt=((ve||{}).textContent||'').trim();
        if(/查询版本中/.test(txt)) loading++;
        rows[t]={off:r.classList.contains('loader-item--off'), rec:r.classList.contains('is-rec'), ver:txt};
      });
      return { rec: tag?tag.getAttribute('data-rectag'):null, rows:rows, loading: loading,
               why:((document.querySelector('.modal--loader [data-rec-why]')||{}).textContent||'').trim() };
    })()`);
  }

  async function waitRec(ms) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      last = await readRec();
      if (last && last.rec && last.loading === 0) return last;
      await sleep(500);
    }
    return last;
  }

  async function closeModal() {
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await sleep(400);
    await js(`(function(){var r=document.getElementById('modal-root'); if(r){r.hidden=true;r.innerHTML='';}})()`);
    await sleep(200);
  }

  try {
    /* ---------------- 进下载页 ---------------- */
    await js(`(document.querySelector('[data-nav="download"]')||{click(){}}).click();`);
    await sleep(2500);

    /* ============ A. 1.20.1：应推荐 Fabric，且带版本号 ============ */
    await openModal('1.20.1');
    const a = await waitRec(30000);
    push('A1 1.20.1 弹窗出现', !!(a && a.rows), a && a.rec);
    push('A2 1.20.1 推荐 Fabric', !!(a && a.rec === 'fabric'), a && a.rec);
    push('A3 Fabric 显示「最新 x.y.z」', !!(a && /^最新 \d/.test(a.rows.fabric.ver)), a && a.rows.fabric);
    push('A4 NeoForge 对 1.20.1 显示没有', !!(a && /没有/.test(a.rows.neoforge.ver)), a && a.rows.neoforge);
    push('A5 Forge 显示最新版本', !!(a && /^最新 \d/.test(a.rows.forge.ver)), a && a.rows.forge);
    push('A6 原版不显示版本标签', !!(a && a.rows.vanilla.ver === ''), a && a.rows.vanilla);
    push('A7 1.20.1 不显示 ModLoader / Babric', !!(a && a.rows.modloader.off && a.rows.babric.off), {
      modloader: a && a.rows.modloader,
      babric: a && a.rows.babric,
    });
    result.a = a;

    // 选 Fabric → install:start 要收到 { loader:{type:'fabric',version:'0.20.1'} }
    await js(`(document.querySelector('.modal--loader [data-loader="fabric"]')||{click(){}}).click();`);
    await sleep(3000);
    const p1 = rec.installStart;
    push('A8 install:start 收到 loader 对象', !!(p1 && p1.loader && p1.loader.type === 'fabric'), p1 && p1.loader);
    push('A9 install:start 带具体加载器版本', !!(p1 && p1.loader && /^\d+\.\d+\.\d+/.test(String(p1.loader.version || ''))), p1 && p1.loader);
    push('A10 install:start 带 mcVersion', !!(p1 && p1.mcVersion === '1.20.1'), p1 && p1.mcVersion);

    /* ============ B. Esc 取消不安装 ============ */
    rec.installStart = null;
    await openModal('1.20.1');
    await closeModal();
    push('B1 Esc 关掉弹窗', !(await js(`!!document.querySelector('.modal--loader')`)));
    push('B2 取消后没发起安装', rec.installStart === null, rec.installStart);

    /* ============ C. 1.12.2：应推荐 Forge（用户明确要求） ============ */
    await openModal('1.12.2');
    const c = await waitRec(30000);
    push('C1 1.12.2 推荐 Forge（不是 Fabric）', !!(c && c.rec === 'forge'), c && { rec: c.rec, why: c.why });
    push('C2 1.12.2 提示文案说明原因', !!(c && /1\.14/.test(c.why || '')), c && c.why);
    result.c = c;
    await closeModal();

    /* ============ D. b1.7.3：应出现 ModLoader / Babric 并推荐其一 ============ */
    const dOpen = await openModal('b1.7.3', 'ancient');
    if (dOpen.error) result.dOpen = dOpen;
    const d = await waitRec(40000);
    push('D1 b1.7.3 出现 ModLoader 行', !!(d && d.rows.modloader && !d.rows.modloader.off), d && d.rows.modloader);
    push('D2 b1.7.3 出现 Babric 行', !!(d && d.rows.babric && !d.rows.babric.off), d && d.rows.babric);
    push('D3 b1.7.3 推荐 Babric 或 ModLoader', !!(d && (d.rec === 'babric' || d.rec === 'modloader')), {
      rec: d && d.rec,
      why: d && d.why,
      open: dOpen,
    });
    push('D4 b1.7.3 不推荐 Fabric', !!(d && d.rec !== 'fabric'), d && d.rec);
    result.d = d;
    await closeModal();

    /* ============ E. 依赖弹窗（模组） ============ */
    await js(`(document.querySelector('.dlcat[data-cat="mod"]')||{click(){}}).click();`);
    await sleep(1500);
    await js(
      `(function(){var el=document.getElementById('dl-mcver'); if(!el) return; el.value='1.20.1'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await sleep(300);
    await js(
      `(function(){var el=document.getElementById('dl-search'); if(el){el.value='Iris'; el.dispatchEvent(new Event('input',{bubbles:true}));}})()`
    );
    await js(`(document.getElementById('dl-do-search')||{click(){}}).click();`);
    await sleep(8000);

    const mods = await js(
      `(function(){var o=[];document.querySelectorAll('.dlcard--project').forEach(function(c){o.push({id:c.getAttribute('data-id'),t:(c.querySelector('.dlcard__title')||{}).textContent||''});});return o;})()`
    );
    // Iris Shaders 必需前置 Sodium，一定会触发依赖弹窗
    const rei = (mods || []).find((x) => /^iris\b|iris shaders/i.test((x.t || '').trim()));
    push('E1 搜到 Iris 卡片', !!rei, (mods || []).slice(0, 6));

    if (rei) {
      const clickInstall = `(function(){var cs=document.querySelectorAll('.dlcard--project');for(var i=0;i<cs.length;i++){if(cs[i].getAttribute('data-id')==='${rei.id}'){var b=cs[i].querySelector('[data-act="install"]'); if(b)b.click(); return true;}}return false;})()`;
      await js(clickInstall);
      await sleep(7000);
      const verCount = await js(`document.querySelectorAll('#modal-root [data-vidx]').length`);
      push('E2 打开版本选择弹窗', verCount > 0, `版本数=${verCount}`);

      let depInfo = null;
      for (let i = 0; i < Math.min(4, verCount || 0); i++) {
        if (i > 0) {
          await js(`(function(){var r=document.getElementById('modal-root'); if(r){r.hidden=true;r.innerHTML='';}})()`);
          await sleep(300);
          await js(clickInstall);
          await sleep(7000);
        }
        await js(`(function(){var b=document.querySelector('#modal-root [data-vidx="${i}"]'); if(b){b.click(); return true;} return false;})()`);
        await sleep(7000);
        const dd = await js(
          `(function(){var m=document.querySelector('.modal--deps'); if(!m) return null; return {rows:m.querySelectorAll('.dep-row, .dep-item, [data-dep]').length, text:(m.textContent||'').replace(/\\s+/g,' ').slice(0,240)};})()`
        );
        if (dd) {
          depInfo = dd;
          break;
        }
      }
      push('E3 前置依赖弹窗真的弹出', !!depInfo, depInfo);
    }

    result.ok = result.checks.every((x) => x.pass);
  } catch (e) {
    result.error = (e && e.stack) || String(e);
  }

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ ...result, payloads: rec }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }

  log('RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks, error: result.error || null }, null, 2));
  app.exit(0);
}).catch((e) => {
  log('FATAL ' + ((e && e.stack) || e));
  app.exit(1);
});
