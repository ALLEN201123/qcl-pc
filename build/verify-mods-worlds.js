'use strict';
/**
 * 验收：模组管理页 5 个 tab + 存档管理 + 模组更新检查 + 整合包导入/导出入口
 *
 * 两种跑法：
 *   ① 默认（真实 home，**只读**）：验证 5 个 tab、空状态、版本设置导出卡片、主页导入入口
 *   ② `node build/verify-mods-worlds.js --temp`：在 `.cache/home-modsworlds/` 造一个**临时 QCL 主目录**
 *      （一个实例 + 一个假存档 + 一个 jar），把「备份 / 备份列表 / 详情 / 导出 / 删除」整条流程点一遍。
 *      这样既能验证真实交互，又绝不写用户的 Documents\QCL。
 *
 * 无论哪种跑法都**不点**：导入整合包（会弹系统文件框）、打开文件夹（会弹资源管理器）。
 *
 * 产出截图（docs/）：_mods-tab-<n>.png / _mods-world-modal.png / _mods-world-detail.png
 *                    / _home-import.png / _vs-export.png
 *
 * 用法：node build/verify-mods-worlds.js [--temp]
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT_DIR = path.join(ROOT, 'docs');
const inner = path.join(__dirname, '_mods-worlds-inner.js');

/* ---------------------------------------------------------------- 临时 home 夹具 */

const TEMP = process.argv.includes('--temp');
const FIX = path.join(ROOT, '.cache', 'home-modsworlds');

/** 造一个能跑完整交互流程的最小 QCL 主目录（只在 --temp 时调用） */
function buildFixture() {
  // ★ 删目录前先确认绝对路径确实在 .cache 下，绝不对未知路径动 Remove-Item
  const cacheRoot = path.join(ROOT, '.cache') + path.sep;
  if (!path.resolve(FIX).startsWith(path.resolve(cacheRoot))) {
    throw new Error(`拒绝删除不在 .cache 下的路径：${FIX}`);
  }
  fs.rmSync(FIX, { recursive: true, force: true });

  const instId = 'verifyinst';
  const instDir = path.join(FIX, 'instances', instId);
  const mcDir = path.join(instDir, '.minecraft');
  fs.mkdirSync(path.join(mcDir, 'saves', '演示世界', 'region'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'resourcepacks'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'shaderpacks'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'datapacks'), { recursive: true });

  // 光影 / 数据包 / 资源包：各放一个正常包 + 一个已禁用包，验证「.zip ⇄ .zip.disabled」
  fs.writeFileSync(path.join(mcDir, 'shaderpacks', '测试光影.zip'), Buffer.alloc(1536, 1));
  fs.writeFileSync(path.join(mcDir, 'shaderpacks', '测试光影-已禁用.zip.disabled'), Buffer.alloc(2048, 2));
  fs.writeFileSync(path.join(mcDir, 'datapacks', '测试数据包.zip'), Buffer.alloc(512, 3));
  fs.writeFileSync(path.join(mcDir, 'resourcepacks', '测试资源包.zip'), Buffer.alloc(768, 4));

  fs.writeFileSync(path.join(FIX, 'instances.json'), JSON.stringify({ version: 1, instances: [instId] }, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(instDir, 'instance.json'),
    JSON.stringify(
      {
        id: instId,
        name: '验收实例',
        icon: 'grass',
        mcVersion: '1.20.1',
        installedVersion: '1.20.1',
        loader: { type: 'fabric', version: '0.15.0' },
        java: { path: null, memoryMb: null },
        created: Date.now() - 86400000,
        lastPlayed: Date.now() - 3600000,
        playTime: 600000,
        notes: '',
        group: '',
      },
      null,
      2
    ),
    'utf8'
  );

  // 假存档：level.dat 故意不是合法 NBT，正好验证「读不到就回落到文件夹名」
  fs.writeFileSync(path.join(mcDir, 'saves', '演示世界', 'level.dat'), Buffer.from([0x0a, 0x00, 0x00, 0x00]));
  fs.writeFileSync(path.join(mcDir, 'saves', '演示世界', 'region', 'r.0.0.mca'), Buffer.alloc(4096, 7));

  // 一个 jar（优先从真实主目录的 libraries 里挑一个最小的；读真实目录是只读操作）
  let copied = false;
  try {
    const libs = path.join(REAL_HOME, '.minecraft', 'libraries');
    const stack = [libs];
    const jars = [];
    while (stack.length && jars.length < 400) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith('.jar')) {
          try {
            jars.push({ p, size: fs.statSync(p).size });
          } catch {
            /* ignore */
          }
        }
      }
    }
    jars.sort((a, b) => a.size - b.size);
    if (jars.length) {
      fs.copyFileSync(jars[0].p, path.join(mcDir, 'mods', '验收示例模组.jar'));
      copied = true;
    }
  } catch {
    /* 读不到真实主目录也没关系 */
  }
  if (!copied) fs.writeFileSync(path.join(mcDir, 'mods', '验收示例模组.jar'), Buffer.alloc(256, 0));

  return { home: FIX, instId };
}

const fixture = TEMP ? buildFixture() : null;
const HOME = fixture ? fixture.home : REAL_HOME;
if (TEMP) console.log('TEMP_HOME ' + HOME + ' (instId=' + fixture.instId + ')');

const innerSrc = `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const SHOT_DIR = ${JSON.stringify(SHOT_DIR)};
const TEMP = ${JSON.stringify(TEMP)};

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // ★ 只读验证：把主进程日志改成空实现，保证整个过程**不往 Documents\\\\QCL 写任何东西**
  if (ipcMod.ctx) {
    ipcMod.ctx.log = { open() {}, write() {}, close() {}, tail: () => [], path: () => '' };
  }
  ipcMod.registerIpc();

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/GPU stall|GroupMarkerNotSet|Couldn't load texture|Automatic fallback to software WebGL/.test(String(message))) {
      console.log('PAGE! ' + message);
    }
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('加载超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name, rect) => {
    /**
     * ★ 透明窗口 + 软件渲染下，capturePage 有时会拿到**上一帧**（实测：弹窗刚打开就截图，
     *   拍出来的是没弹窗的旧画面）。多等 400ms 让合成器画一帧再截。
     */
    await sleep(400);
    const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    console.log('SHOT docs/' + name);
  };
  async function waitFor(expr, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let ok = false;
      try { ok = await js('(() => !!( ' + expr + ' ))()'); } catch { ok = false; }
      if (ok) return Date.now() - t0;
      await sleep(300);
    }
    return -1;
  }

  // 小工具：点弹窗里文字匹配的按钮 / 读当前所有 toast 文案 / 等某段 toast 出现
  const clickModalButton = (label) =>
    js("(() => { const bs = Array.from(document.querySelectorAll('#modal-root .btn, #modal-root button')); const b = bs.find(x => (x.textContent||'').trim() === " + JSON.stringify(label) + "); if (b) { b.click(); return true; } return false; })()");
  const toastText = () => js("((document.getElementById('toast-root')||{}).textContent || '').trim()");
  const waitToast = (needle, timeoutMs = 12000) =>
    waitFor("(((document.getElementById('toast-root')||{}).textContent)||'').indexOf(" + JSON.stringify(needle) + ") >= 0", timeoutMs);

  // 等首屏（主页要加载 3D 人物，给足时间）
  await sleep(14000);
  check('首屏已渲染', await js("!document.getElementById('splash') || document.getElementById('splash').classList.contains('is-hidden')"));

  /* ============================ ① 主页：导入整合包入口 ============================ */
  const homeImport = await js(\`(() => ({
    exists: !!document.getElementById('home-import-pack'),
    text: (document.getElementById('home-import-pack') || {}).textContent || '',
    toolsBar: !!document.querySelector('.home-tools'),
  }))()\`);
  console.log('HOME_IMPORT ' + JSON.stringify(homeImport));
  check('主页有「导入整合包」入口', homeImport.exists && /导入整合包/.test(homeImport.text), homeImport);
  check('主页快捷操作条已渲染', homeImport.toolsBar === true);
  await shot('_home-import.png');

  /* ============================ ② 模组页：五个 tab ============================ */
  await js("(() => { const b = document.querySelector('[data-nav=\\"mods\\"]'); if (b) b.click(); return !!b; })()");
  await sleep(1600);

  const tabs = await js("Array.from(document.querySelectorAll('#mods-tabs .segmented__item')).map(b => b.textContent.trim())");
  console.log('MODS_TABS ' + JSON.stringify(tabs));
  check('五个 tab 都在（模组/资源包/光影/数据包/世界）', tabs.join('/') === '模组/资源包/光影/数据包/世界', tabs);

  const perTab = [];
  for (const label of tabs) {
    const clicked = await js(\`(() => {
      const b = Array.from(document.querySelectorAll('#mods-tabs .segmented__item')).find(x => x.textContent.trim() === '\${label}');
      if (!b) return false;
      b.click();
      return true;
    })()\`);
    check('tab 可点击：' + label, clicked);
    // 等到「有内容」或「中文空状态」，避免把加载中误判成白屏
    await waitFor(
      "document.querySelector('#mods-content .empty__title') || document.querySelectorAll('#mods-content .mod-row, #mods-content .world-card').length > 0",
      12000
    );
    await sleep(400);
    const st = await js(\`(() => ({
      rows: document.querySelectorAll('#mods-content .mod-row').length,
      worldCards: document.querySelectorAll('#mods-content .world-card').length,
      emptyTitle: (document.querySelector('#mods-content .empty__title') || {}).textContent || '',
      textLen: ((document.getElementById('mods-content') || {}).innerText || '').trim().length,
      hasCheckUpdates: !!document.querySelector('[data-act="check-updates"]'),
    }))()\`);
    console.log('MODS_TAB ' + label + ' ' + JSON.stringify(st));
    perTab.push({ label, ...st });
    check('tab「' + label + '」不是白屏', st.rows + st.worldCards > 0 || (st.emptyTitle.length > 0 && st.textLen > 0), st);
    await shot('_mods-tab-' + perTab.length + '.png');
  }

  // 模组 tab 上要有「检查更新」
  const modsTab = perTab.find((t) => t.label === '模组');
  check('模组 tab 有「检查更新」按钮', !!(modsTab && modsTab.hasCheckUpdates), modsTab);

  /* ==================== ④' 光影 / 数据包 / 资源包：启用 ⇄ 禁用真改后缀 ==================== */
  if (TEMP) {
    for (const [label, expectRows] of [
      ['光影', 2],
      ['数据包', 1],
      ['资源包', 1],
    ]) {
      await js("(() => { const b = Array.from(document.querySelectorAll('#mods-tabs .segmented__item')).find(x => x.textContent.trim() === " + JSON.stringify(label) + "); if (b) b.click(); return !!b; })()");
      await waitFor("document.querySelector('#mods-content .empty__title') || document.querySelectorAll('#mods-content .mod-row').length > 0", 12000);
      await sleep(400);
      const info = await js(\`(() => ({
        rows: document.querySelectorAll('#mods-content .mod-row').length,
        toggles: document.querySelectorAll('#mods-content [data-act="toggle"]').length,
        removes: document.querySelectorAll('#mods-content [data-act="remove"]').length,
        disabledBadges: document.querySelectorAll('#mods-content .badge--warn').length,
        firstFile: (document.querySelector('#mods-content .mod-row__name') || {}).textContent || '',
        metaText: (document.querySelector('#mods-content .mod-row__meta') || {}).textContent || '',
      }))()\`);
      console.log('ADDON_TAB ' + label + ' ' + JSON.stringify(info));
      check(label + ' tab 列出了文件（后端 ' + 'mods:' + (label === '光影' ? 'shaderPacks' : label === '数据包' ? 'dataPacks' : 'resourcePacks') + ' 返回 ' + expectRows + ' 条）', info.rows === expectRows, info);
      check(label + ' 每条都有「启用/禁用」与「删除」按钮', info.toggles === expectRows && info.removes === expectRows, { toggles: info.toggles, removes: info.removes });
    }

    // 真的点一次「禁用」→ 文件名应变成 .disabled，列表刷新后按钮变「启用」
    await js("(() => { const b = Array.from(document.querySelectorAll('#mods-tabs .segmented__item')).find(x => x.textContent.trim() === '光影'); if (b) b.click(); return !!b; })()");
    await waitFor("document.querySelectorAll('#mods-content [data-act=\\"toggle\\"]').length > 0", 12000);
    await sleep(300);
    const before = await js("(() => { const rows = Array.from(document.querySelectorAll('#mods-content .mod-row')); const r = rows.find(x => !x.classList.contains('is-disabled')); return r ? (r.querySelector('.mod-row__name') || {}).textContent || '' : ''; })()");
    await js("(() => { const rows = Array.from(document.querySelectorAll('#mods-content .mod-row')); const r = rows.find(x => !x.classList.contains('is-disabled')); const b = r && r.querySelector('[data-act=toggle]'); if (b) { b.click(); return true; } return false; })()");
    const disabledToast = await waitToast('已禁用', 12000);
    await sleep(700);
    const after = await js(\`(() => {
      const names = Array.from(document.querySelectorAll('#mods-content .mod-row__name')).map(x => x.textContent);
      return { names, hasDisabled: names.some(n => /\\.disabled$/.test(n)), disabledRows: document.querySelectorAll('#mods-content .mod-row.is-disabled').length };
    })()\`);
    console.log('ADDON_TOGGLE ' + JSON.stringify({ before, toast: disabledToast >= 0, ...after }));
    check('点「禁用」后提示中文成功', disabledToast >= 0, after);
    check('禁用后文件名变成 .disabled（.zip ⇄ .zip.disabled 真的生效了）', after.hasDisabled, after.names);

    // 再启用回来，别把夹具搞成半残（虽然夹具最后会被删）
    await js("(() => { const r = Array.from(document.querySelectorAll('#mods-content .mod-row')).find(x => x.classList.contains('is-disabled')); const b = r && r.querySelector('[data-act=\\"toggle\\"]'); if (b) { b.click(); return true; } return false; })()");
    const enabledToast = await waitToast('已启用', 12000);
    await sleep(600);
    const restored = await js("Array.from(document.querySelectorAll('#mods-content .mod-row__name')).map(x => x.textContent)");
    console.log('ADDON_ENABLE ' + JSON.stringify({ toast: enabledToast >= 0, names: restored }));
    check('再点「启用」能恢复成 .zip', enabledToast >= 0 && restored.some((n) => /\\.zip$/.test(n)), restored);
  }

  /* ============================ ③ 存档管理 ============================ */
  await js("(() => { const b = Array.from(document.querySelectorAll('#mods-tabs .segmented__item')).find(x => x.textContent.trim() === '世界'); if (b) b.click(); return !!b; })()");
  await waitFor("document.querySelector('#mods-content .empty__title') || document.querySelectorAll('#mods-content .world-card').length > 0", 12000);
  await sleep(500);

  const worldInfo = await js(\`(() => {
    const cards = Array.from(document.querySelectorAll('#mods-content .world-card'));
    const first = cards[0];
    return {
      count: cards.length,
      actions: first ? Array.from(first.querySelectorAll('[data-act]')).map(b => b.dataset.act) : [],
      metaText: first ? (first.querySelector('.world-card__meta') || {}).textContent || '' : '',
      nameText: first ? (first.querySelector('.world-card__name') || {}).textContent || '' : '',
      emptyTitle: (document.querySelector('#mods-content .empty__title') || {}).textContent || '',
    };
  })()\`);
  console.log('WORLDS ' + JSON.stringify(worldInfo));
  check('世界 tab 能渲染存档卡或中文空状态', worldInfo.count > 0 || worldInfo.emptyTitle.length > 0, worldInfo);

  if (worldInfo.count > 0) {
    check(
      '存档卡有 6 个操作（详情/备份/备份列表/导出/打开/删除）',
      ['world-detail', 'world-backup', 'world-backups', 'world-export', 'world-open', 'world-delete'].every((a) => worldInfo.actions.includes(a)),
      worldInfo.actions
    );
    check('存档卡显示了大小 / 最后游玩时间', /大小|KB|MB|未知/.test(worldInfo.metaText) && /最后游玩/.test(worldInfo.metaText), worldInfo.metaText);
    const iconLoaded = await js("(() => { const im = document.querySelector('#mods-content .world-card__icon img'); return im ? (im.naturalWidth > 0 || !im.getAttribute('src')) : 'no-img'; })()");
    console.log('WORLD_ICON ' + JSON.stringify(iconLoaded));

    /* ---- 存档详情弹窗 ---- */
    await js("(() => { const b = document.querySelector('#mods-content [data-act=\\"world-detail\\"]'); if (b) b.click(); return !!b; })()");
    const detailUp = await waitFor("document.querySelector('#modal-root .modal')", 8000);
    const detailInfo = await js(\`(() => {
      const m = document.querySelector('#modal-root .modal');
      return {
        title: (document.querySelector('#modal-root .modal__title') || {}).textContent || '',
        text: m ? m.innerText : '',
      };
    })()\`);
    console.log('DETAIL_MODAL ' + JSON.stringify({ up: detailUp, title: detailInfo.title, textLen: (detailInfo.text || '').length }));
    check('「存档详情」弹窗能打开', detailUp >= 0, detailUp);
    check('详情里有种子 / 游戏模式 / 文件夹 / 大小', /种子/.test(detailInfo.text) && /游戏模式/.test(detailInfo.text) && /文件夹/.test(detailInfo.text) && /大小/.test(detailInfo.text), (detailInfo.text || '').slice(0, 120));
    await shot('_mods-world-detail.png');
    await clickModalButton('关闭');
    await sleep(400);

    /* ---- 备份 → 备份列表（TEMP 模式下才真的写盘） ---- */
    if (TEMP) {
      await js("(() => { const b = document.querySelector('#mods-content [data-act=\\"world-backup\\"]'); if (b) b.click(); return !!b; })()");
      const backupOk = await waitToast('已备份', 20000);
      const backupToast = await toastText();
      console.log('WORLD_BACKUP ' + JSON.stringify({ ok: backupOk >= 0, toast: backupToast }));
      check('「备份」成功后弹出中文提示（含文件名/大小）', backupOk >= 0, backupToast);

      await js("(() => { const b = document.querySelector('#mods-content [data-act=\\"world-backups\\"]'); if (b) b.click(); return !!b; })()");
      const listUp = await waitFor("document.querySelector('#modal-root .modal')", 8000);
      const backupList = await js(\`(() => {
        const rows = document.querySelectorAll('#modal-root .mod-row').length;
        const restore = document.querySelectorAll('#modal-root [data-restore]').length;
        const title = (document.querySelector('#modal-root .modal__title') || {}).textContent || '';
        const firstFile = (document.querySelector('#modal-root .mod-row .mono') || {}).textContent || '';
        return { rows, restore, title, firstFile };
      })()\`);
      console.log('BACKUP_LIST ' + JSON.stringify(backupList));
      check('「备份列表」弹窗打开且列出了刚生成的备份', listUp >= 0 && backupList.rows >= 1 && backupList.restore >= 1, backupList);
      check('备份项显示绝对路径（含 .zip）', /\.zip$/i.test(String(backupList.firstFile).trim()), backupList.firstFile);
      await shot('_mods-world-modal.png');

      /* ---- 恢复：确认后覆盖（temp home，安全） ---- */
      await js("(() => { const b = document.querySelector('#modal-root [data-restore]'); if (b) { b.click(); return true; } return false; })()");
      const confirmUp = await waitFor("document.querySelector('#modal-root .modal') && Array.from(document.querySelectorAll('#modal-root .btn')).some(x => /覆盖恢复/.test(x.textContent))", 8000);
      check('「恢复」先弹二次确认', confirmUp >= 0, confirmUp);
      await clickModalButton('覆盖恢复');
      const restoreOk = await waitToast('已恢复备份', 20000);
      const restoreToast = await toastText();
      console.log('WORLD_RESTORE ' + JSON.stringify({ ok: restoreOk >= 0, toast: restoreToast }));
      check('恢复成功后提示「已恢复备份」', restoreOk >= 0, restoreToast);
      await sleep(600);
      await clickModalButton('关闭');
      await sleep(300);

      /* ---- 导出 ---- */
      await js("(() => { const b = document.querySelector('#mods-content [data-act=\\"world-export\\"]'); if (b) b.click(); return !!b; })()");
      const exportOk = await waitToast('已导出', 20000);
      const exportToast = await toastText();
      console.log('WORLD_EXPORT ' + JSON.stringify({ ok: exportOk >= 0, toast: exportToast }));
      check('「导出」成功后提示文件绝对路径', exportOk >= 0 && /\.zip/i.test(exportToast), exportToast);
    }

    /* ---- 删除（TEMP 模式下真的移进回收目录；放最后做，删完就没数据了） ---- */
    if (TEMP) {
      await js("(() => { const b = document.querySelector('#mods-content [data-act=\\"world-delete\\"]'); if (b) b.click(); return !!b; })()");
      const delConfirm = await waitFor("Array.from(document.querySelectorAll('#modal-root .btn')).some(x => /删除存档/.test(x.textContent))", 8000);
      check('「删除」先弹二次确认（不会直接删）', delConfirm >= 0, delConfirm);
      await clickModalButton('删除存档');
      const delOk = await waitToast('已移到回收目录', 15000);
      const delToast = await toastText();
      console.log('WORLD_DELETE ' + JSON.stringify({ ok: delOk >= 0, toast: delToast }));
      check('确认删除后提示「已移到回收目录」', delOk >= 0, delToast);
      await waitFor("document.querySelector('#mods-content .empty__title')", 8000);
      const afterDelete = await js("document.querySelectorAll('#mods-content .world-card').length");
      check('删除后列表变空（存档已不在 saves 里）', afterDelete === 0, afterDelete);
    }

    // 清掉可能残留的弹窗
    await clickModalButton('关闭');
    await sleep(300);
  }

  /* ============================ ④ 检查更新（只点，不下载） ============================ */
  await js("(() => { const b = Array.from(document.querySelectorAll('#mods-tabs .segmented__item')).find(x => x.textContent.trim() === '模组'); if (b) b.click(); return !!b; })()");
  await waitFor("document.querySelector('[data-act=\\"check-updates\\"]') || document.querySelector('#mods-content .empty__title')", 12000);
  await sleep(400);

  const modsTabInfo = perTab.find((t) => t.label === '模组');
  const hasRows = !!(modsTabInfo && modsTabInfo.rows > 0);
  if (!hasRows) {
    // 空实例里「检查更新」按设计就不显示（它在非空的摘要行里），不算失败
    console.log('SKIP 检查更新：当前实例的模组 tab 为空，按钮按设计不显示');
  } else {
    check('模组 tab 有「检查更新」按钮', !!(modsTabInfo && modsTabInfo.hasCheckUpdates), modsTabInfo);
    // ★ 先把之前的 toast 全部等消失：否则「有 toast 出现」会立刻成立，误判成检查已完成
    await waitFor("document.querySelectorAll('#toast-root .toast').length === 0", 15000);
    await js("(() => { const b = document.querySelector('[data-act=\\"check-updates\\"]'); if (b) { b.click(); return true; } return false; })()");
    await sleep(300);
    const checking = await js("((document.querySelector('[data-act=\\"check-updates\\"]') || {}).textContent || '').trim()");
    console.log('UPDATE_CHECK_START ' + JSON.stringify(checking));
    // 真正的完成信号：按钮文案不再是「正在检查…」（成功/失败都会恢复）
    const finished = await waitFor(
      "((document.querySelector('[data-act=\\\"check-updates\\\"]')||{}).textContent||'').trim() !== '正在检查…'",
      60000
    );
    const after = await js(\`(() => ({
      btnText: (document.querySelector('[data-act="check-updates"]') || {}).textContent || '',
      modalTitle: (document.querySelector('#modal-root .modal__title') || {}).textContent || '',
      toastText: Array.from(document.querySelectorAll('#toast-root .toast__body')).map(x => x.textContent).join(' | '),
    }))()\`);
    console.log('UPDATE_CHECK ' + JSON.stringify({ finished, ...after }));
    check('点击「检查更新」后有结果，按钮不会一直转圈', finished >= 0 && after.btnText.trim() !== '正在检查…', after);
    check(
      '检查结果文案是中文（全部最新 / 发现 N 个可更新 / 中文错误）',
      /全部已是最新|发现 \\d+ 个可更新|检查|失败|网络/.test(after.toastText + ' ' + after.modalTitle),
      after
    );
    await shot('_mods-update-check.png');
    // 关掉可能出现的更新弹窗
    await js("(() => { const bs = Array.from(document.querySelectorAll('#modal-root .btn')); const b = bs.find(x => (x.textContent||'').trim() === '关闭'); if (b) { b.click(); return true; } return false; })()");
    await sleep(300);
  }

  /* ============================ ⑤ 版本设置：导出整合包 ============================ */
  await js("(() => { const b = document.querySelector('[data-nav=\\"versionsetting\\"]'); if (b) b.click(); return !!b; })()");
  await sleep(1400);
  const exportInfo = await js(\`(() => ({
    hasBtn: !!document.getElementById('vs-export'),
    btnText: (document.getElementById('vs-export') || {}).textContent || '',
    boxes: ['vs-exp-mods','vs-exp-config','vs-exp-packs','vs-exp-saves'].map(id => !!(document.getElementById(id) && document.getElementById(id).checked)),
    hint: (document.getElementById('vs-export-tip') || {}).textContent || '',
  }))()\`);
  console.log('VS_EXPORT ' + JSON.stringify(exportInfo));
  check('版本设置「概览」有导出整合包按钮', exportInfo.hasBtn && /导出整合包/.test(exportInfo.btnText), exportInfo);
  check('导出有 4 个勾选项且默认勾了模组/配置/资源包', exportInfo.boxes[0] && exportInfo.boxes[1] && exportInfo.boxes[2] && exportInfo.boxes[3] === false, exportInfo.boxes);
  await shot('_vs-export.png');

  /* ============================ 汇总 ============================ */
  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) }));
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`;

fs.writeFileSync(inner, innerSrc, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 生成的内层脚本先自检语法（模板字符串里漏转义反引号很难肉眼发现）
try {
  require('node:child_process').execFileSync(process.execPath, ['--check', inner], { stdio: 'pipe' });
} catch (e) {
  console.log('INNER_SYNTAX_ERROR\n' + String(e.stdout || '') + String(e.stderr || ''));
  try {
    fs.unlinkSync(inner);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

const userData = path.join(ROOT, '.cache', 'userdata-modsworlds');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'inherit' });
child.on('exit', (code) => {
  try {
    fs.unlinkSync(inner);
  } catch {
    /* ignore */
  }
  // 临时 home 用完就删（路径已在 buildFixture 里校验过在 .cache 下）
  if (TEMP) {
    try {
      const cacheRoot = path.join(ROOT, '.cache') + path.sep;
      if (path.resolve(FIX).startsWith(path.resolve(cacheRoot))) fs.rmSync(FIX, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exitCode = code ?? 0;
});
