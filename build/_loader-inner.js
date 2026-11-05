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
  /** 新流程：点行只是「选中」，要再点底部「开始安装」才提交 */
  const submitLoader = async () => {
    await js(`(document.getElementById('ld-go')||{click(){}}).click()`);
    await sleep(1500);
  };
  const push = (name, pass, info) => result.checks.push({ name, pass, info });

  /** 打开某个版本号的加载器弹窗（游戏分类 + 可选二级分页 + 搜索版本号） */
  async function openModal(versionId, tab, target) {
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
    // ★ 「安装到」下拉必须在点击安装**之前**设好（点分类会重画工具栏）
    if (target !== undefined) {
      await js(
        `(function(){var s=document.getElementById('dl-target'); if(!s) return 'no-select'; s.value=${JSON.stringify(target)}; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`
      );
      await sleep(300);
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
    await sleep(400);
    await submitLoader();
    await sleep(2400);
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
    /* ============ F/G/H. 安装对话框：实例名 / 加载器版本 / OptiFine 可叠加 ============ */

    /** 打开某个版本的安装对话框，可指定「安装到」 */
    const openFor = async (versionId, target) => {
      await closeModal();
      const opened = await openModal(versionId, 'release', target);
      await sleep(800);
      return opened;
    };

    /** 等某个 loader 的版本下拉被灌满（查询是异步的） */
    const waitSel = async (type, min) => {
      for (let i = 0; i < 40; i++) {
        const n = await js(
          `(function(){var s=document.querySelector('[data-selver="${type}"]'); return s?s.options.length:0;})()`
        );
        if (n >= (min || 1)) return n;
        await sleep(500);
      }
      return 0;
    };

    // 先自己进「游戏」分类 → 正式版，并清掉 E 段留下的「游戏版本」筛选
    await closeModal();
    await js(`(document.querySelector('.dlcat[data-cat="game"]')||{click(){}}).click();`);
    await sleep(1200);
    await js(
      `(function(){var el=document.getElementById('dl-mcver'); if(el){el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));}})()`
    );
    await sleep(400);
    await js(
      `(function(){var el=document.getElementById('dl-search'); if(el){el.value='1.20.1'; el.dispatchEvent(new Event('input',{bubbles:true}));}})()`
    );
    await sleep(500);

    // ---- F1：「安装到」下拉有「＋ 新建实例…」 ----
    const targetOpts = await js(
      `(function(){var s=document.getElementById('dl-target'); if(!s) return null;
        return Array.from(s.options).map(function(o){return {v:o.value,t:o.textContent.trim()};});})()`
    );
    push('F1「安装到」下拉有「＋ 新建实例…」', !!(targetOpts || []).find((x) => x.v === '__new__'), targetOpts);

    // ---- F2~F6：新建模式下的实例名 ----
    rec.create = null;
    const fOpen = await openFor('1.20.1', '__new__');
    const nameField = await js(
      `(function(){var i=document.getElementById('ld-name'); if(!i) return null;
        return {value:i.value, placeholder:i.placeholder, focused:(document.activeElement===i)};})()`
    );
    push('F2 弹窗里有「实例名称」输入框', !!(fOpen && fOpen.ok && nameField), { open: fOpen, name: nameField });
    push('F3 默认名是「1.20.1 Fabric」格式', !!(nameField && /^1\.20\.1\s+Fabric$/.test(nameField.value)), nameField && nameField.value);
    push('F4 输入框自动获得焦点', !!(nameField && nameField.focused), nameField && nameField.focused);
    result.nameDefault = nameField && nameField.value;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(ROOT, 'docs', '_dlg-loader-v3.png'), img.toPNG());
    } catch (e) {
      /* 截图失败不影响断言 */
    }

    // Fabric 的版本下拉 + 兼容前置
    await waitSel('fabric', 50);
    const fabSel = await js(
      `(function(){var s=document.querySelector('[data-selver="fabric"]');
        return {hidden:s?!!s.hidden:null, count:s?s.options.length:0, first:s&&s.options[0]?s.options[0].value:'',
                second:s&&s.options[1]?s.options[1].value:''};})()`
    );
    push('F5 Fabric 有版本下拉，第一项是最新', !!(fabSel && !fabSel.hidden && fabSel.count > 50 && fabSel.first === '0.20.1'), fabSel);
    const compatInfo = await js(
      `(function(){var c=document.getElementById('ld-compats');
        return {hidden:(!c)?null:!!c.hidden, items:Array.from(document.querySelectorAll('input[data-compat]')).map(function(x){return {slug:x.getAttribute('data-compat'),checked:x.checked};})};})()`
    );
    push('F6 Fabric 有「前置 API」且 Fabric API 默认勾上',
      !!(compatInfo && compatInfo.hidden === false && (compatInfo.items || []).some((i) => i.slug === 'fabric-api' && i.checked)),
      compatInfo);

    // ---- G：选旧版加载器 → 传给 install:start ----
    rec.installStart = null;
    if (fabSel && fabSel.second) {
      await js(
        `(function(){var s=document.querySelector('[data-selver="fabric"]'); s.value=${JSON.stringify(fabSel.second)};
          s.dispatchEvent(new Event('change',{bubbles:true}));})()`
      );
      await sleep(300);
      // 改名 + 提交
      await js(
        `(function(){var i=document.getElementById('ld-name'); i.value='我的测试实例'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`
      );
      await submitLoader();
      await sleep(2400);
      const p1 = rec.installStart;
      push('G1 instances:create 收到自定义实例名', !!(rec.create && rec.create.name === '我的测试实例'), rec.create);
      push('G2 install:start 收到玩家挑的旧加载器版本', !!(p1 && p1.loader && p1.loader.type === 'fabric' && p1.loader.version === fabSel.second), {
        expect: fabSel.second,
        got: p1 && p1.loader,
      });
      push('G3 没勾 OptiFine 时不带 optifineVersion', !!(p1 && p1.optifineVersion === undefined), p1 && p1.optifineVersion);
    } else {
      push('G1 instances:create 收到自定义实例名', false, '拿不到版本下拉');
      push('G2 install:start 收到玩家挑的旧加载器版本', false, '拿不到版本下拉');
      push('G3 没勾 OptiFine 时不带 optifineVersion', false, '拿不到版本下拉');
    }

    // ---- H：装到已有实例时改名 → 新建一个 ----
    const someId = await js(
      `(function(){var s=document.getElementById('dl-target');
        var o=Array.from(s.options).find(function(x){return x.value && x.value!=='__new__';});
        return o?o.value:null;})()`
    );
    if (someId) {
      await openFor('1.20.1', someId);
      const existState = await js(
        `(function(){var i=document.getElementById('ld-name');
          return {hasName:!!i, value:i?i.value:'',
                  hint:((document.querySelector('.loader-name__hint')||{}).textContent||'').trim()};})()`
      );
      push('H1 装到已有实例时名称框仍在，且填的是实例名', !!(existState.hasName && existState.value), existState);
      push('H2 提示说明「改名就新建实例」', /新建/.test(existState.hint), existState.hint.slice(0, 40));
      rec.create = null;
      await js(
        `(function(){var i=document.getElementById('ld-name'); i.value='另装的一份'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`
      );
      await submitLoader();
      await sleep(2200);
      push('H3 改名后真的新建了实例', !!(rec.create && rec.create.name === '另装的一份'), rec.create);
    } else {
      push('H1 装到已有实例时名称框仍在，且填的是实例名', false, '没有已有实例');
      push('H2 提示说明「改名就新建实例」', false, '没有已有实例');
      push('H3 改名后真的新建了实例', false, '没有已有实例');
    }

    // ---- I：OptiFine 可叠加（用户要求「forge 和高清修复能同时选」） ----
    rec.installStart = null;
    await openFor('1.20.1', '__new__');
    for (let i = 0; i < 40; i++) {
      const n = await js(`(function(){var s=document.getElementById('ld-of-ver'); return s?s.options.length:0;})()`);
      if (n > 0) break;
      await sleep(500);
    }
    const ofInfo = await js(
      `(function(){var s=document.getElementById('ld-of-ver'); var b=document.getElementById('ld-of');
        return {hasBox:!!b, disabled:b?b.disabled:null, count:s?s.options.length:0,
                first:s&&s.options[0]?s.options[0].value:'',
                hint:((document.getElementById('ld-of-hint')||{}).textContent||'').trim(),
                rowHidden:(function(){var r=document.querySelector('[data-loader="optifine"]'); return r?r.classList.contains('loader-item--off'):null;})()};})()`
    );
    push('I1 OptiFine 从加载器列表移出、变成勾选项并有版本下拉',
      !!(ofInfo.hasBox && ofInfo.disabled === false && ofInfo.count > 0 && ofInfo.rowHidden === true), ofInfo);

    // 勾上 OptiFine → 1.20.1 应自动切到 Forge
    await js(`(function(){var b=document.getElementById('ld-of'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(1500);
    const afterCheck = await js(
      `(function(){var p=document.querySelector('.modal--loader .loader-item.is-picked');
        return {picked:p?p.getAttribute('data-loader'):null,
                ofVersion:(document.getElementById('ld-of-ver')||{}).value||''};})()`
    );
    push('I2 1.20.1 勾 OptiFine 自动把加载器切成 Forge', afterCheck.picked === 'forge', afterCheck);

    await waitSel('forge', 1);
    await submitLoader();
    await sleep(2600);
    const pOf = rec.installStart;
    push('I3 install:start 同时带 forge 与 optifineVersion',
      !!(pOf && pOf.loader && pOf.loader.type === 'forge' && pOf.optifineVersion !== undefined), pOf);
    result.ofStart = pOf;
    await closeModal();

    // ---- J：1.12.2 勾 OptiFine 不该被切成 Forge（补丁模式） ----
    await openFor('1.12.2', '__new__');
    await waitSel('optifine', 1);
    const beforeOf = await js(
      `(function(){var p=document.querySelector('.modal--loader .loader-item.is-picked');
        return {picked:p?p.getAttribute('data-loader'):null};})()`
    );
    await js(`(function(){var b=document.getElementById('ld-of'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(1200);
    const oldOf = await js(
      `(function(){var p=document.querySelector('.modal--loader .loader-item.is-picked');
        var s=document.getElementById('ld-of-ver');
        return {picked:p?p.getAttribute('data-loader'):null, count:s?s.options.length:0,
                hint:((document.getElementById('ld-of-hint')||{}).textContent||'').trim()};})()`
    );
    // 1.12.2 的「推荐加载器」本来就是 Forge，所以这里只断言「勾 OptiFine 没强行改动选择」
    push('J1 1.12.2 勾 OptiFine 不改变已选加载器（走补丁模式）',
      !!(oldOf.picked && oldOf.picked === beforeOf.picked && /补丁/.test(oldOf.hint)), { before: beforeOf, after: oldOf });
    await closeModal();

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

  console.log('RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks, error: result.error || null }, null, 2));
  app.exit(0);
}).catch((e) => {
  console.log('FATAL ' + ((e && e.stack) || e));
  app.exit(1);
});
