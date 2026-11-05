'use strict';
/**
 * 验收：版本设置页「自动安装 / 更换加载器」（task-10）
 *
 * 真 Electron 启动（qcl:// + **临时 home**），并在主进程侧把 `install:start` 换成**记录桩**，
 * 这样能断言真实 payload（这是看 payload 的唯一办法），同时不会真的下载/安装任何东西。
 *
 * 安全约束（lead 2026-11-05 指定）：
 *   · 独立 `--user-data-dir=.cache/userdata-vs`（不撞用户的单实例锁）
 *   · 临时 home：`.cache/home-autoinstall`，跑完删掉，**不写 C:\Users\123\Documents\QCL**
 *   · 只对自己 spawn 的 Electron 子进程 `child.kill()`，绝不碰用户正在用的 QCL
 *   · 主进程日志注入空实现，避免顺手写日志文件
 *
 * 断言：
 *   ① 概览里有「模组加载器」卡片，原版实例显示「原版（没有模组加载器）」
 *   ② 点按钮弹出 modal--loader：7 行（原版/Fabric/Forge/NeoForge/Quilt/ModLoader/Babric）+ OptiFine 勾选
 *   ③ 版本徽章不再是「查询版本中…」（loader:versions 真的返回了）
 *   ④ payload：选 Forge 且不勾 OptiFine → 没有 optifineVersion 键
 *   ⑤ payload：选原版 → loader === null
 *   ⑥ 进度：不匹配的 taskId 不改界面；匹配的推 25% → 进度行更新
 *   ⑦ 成功：done:true → 「装好了，可以回首页启动」+ 自动关窗
 *   ⑧ 失败：done:true 且带 error → 显示中文错误而不是「装好了」
 *   ⑨ OptiFine：MC 1.20.1 勾选且加载器是 Fabric → 自动切 Forge + toast；payload optifineVersion 是字符串
 *
 * 用法：node build/verify-autoinstall.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'docs');
const FIX = path.join(ROOT, '.cache', 'home-autoinstall');
const inner = path.join(__dirname, '_autoinstall-inner.js');

/* ---------------------------------------------------------------- 临时 home 夹具 */
function buildFixture() {
  const cacheRoot = path.join(ROOT, '.cache') + path.sep;
  if (!path.resolve(FIX).startsWith(path.resolve(cacheRoot))) {
    throw new Error(`拒绝删除不在 .cache 下的路径：${FIX}`);
  }
  fs.rmSync(FIX, { recursive: true, force: true });
  const instId = 'vsinst';
  const instDir = path.join(FIX, 'instances', instId);
  fs.mkdirSync(path.join(instDir, '.minecraft', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(FIX, 'instances.json'), JSON.stringify({ version: 1, instances: [instId] }, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(instDir, 'instance.json'),
    JSON.stringify(
      {
        id: instId,
        name: '验收原版实例',
        icon: 'grass',
        mcVersion: '1.20.1',
        installedVersion: '1.20.1',
        loader: null, // ★ 纯原版实例 —— 正是用户说的「装过的原版再加加载器」
        java: { path: null, memoryMb: null },
        created: Date.now() - 86400000,
        lastPlayed: Date.now() - 3600000,
        playTime: 120000,
        notes: '',
        group: '',
      },
      null,
      2
    ),
    'utf8'
  );
  return { home: FIX, instId };
}

const fixture = buildFixture();
console.log('TEMP_HOME ' + fixture.home + ' (instId=' + fixture.instId + ')');

const innerSrc = `'use strict';
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(FIX)};
const SHOT_DIR = ${JSON.stringify(SHOT_DIR)};

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 主进程侧记录的 install:start payload（记录桩） */
const captured = [];
let seq = 0;

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
  // 只读验证：日志注入空实现（不写任何文件）
  if (ipcMod.ctx) ipcMod.ctx.log = { open() {}, write() {}, close() {}, tail: () => [], path: () => '' };
  ipcMod.registerIpc();

  // ★ 关键：把真正的安装换成「记录桩」，只记 payload、不做任何下载/安装
  ipcMain.removeHandler('install:start');
  ipcMain.handle('install:start', async (_e, payload) => {
    seq += 1;
    const taskId = 'vs-task-' + seq;
    captured.push({ taskId, payload });
    console.log('PAYLOAD ' + JSON.stringify({ taskId, payload }));
    return { ok: true, taskId };
  });
  ipcMain.removeHandler('install:cancel');
  ipcMain.handle('install:cancel', async () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_e, level, message) => {
    const m = String(message);
    if (level >= 2 && !/GPU stall|GroupMarkerNotSet|Couldn't load texture|Automatic fallback|skinFile/.test(m)) console.log('PAGE! ' + m);
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('加载超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const js = (code) => win.webContents.executeJavaScript(code);
  const sendProgress = (payload) => { try { win.webContents.send('task:progress', payload); } catch (_) {} };
  const shot = async (name) => {
    /**
     * ★ 透明窗口 + 软件渲染下 capturePage 经常拿到上一帧（实测：OptiFine 已经自动切到 Forge，
     *   截出来还是切换前的画面）。这里强制 invalidate 触发重绘，并且**连拍两次取最后一张**。
     */
    try { win.webContents.invalidate(); } catch (_) {}
    await sleep(450);
    await win.webContents.capturePage();
    try { win.webContents.invalidate(); } catch (_) {}
    await sleep(220);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    console.log('SHOT docs/' + name);
  };
  async function waitFor(expr, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let ok = false;
      try { ok = await js('(() => !!( ' + expr + ' ))()'); } catch { ok = false; }
      if (ok) return Date.now() - t0;
      await sleep(250);
    }
    return -1;
  }
  async function waitCaptured(n, timeoutMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (captured.length >= n) return true;
      await sleep(100);
    }
    return false;
  }
  const click = (sel) => js("(() => { const b = document.querySelector('" + sel + "'); if (b) { b.click(); return true; } return false; })()");
  const textOf = (sel) => js("((document.querySelector('" + sel + "') || {}).textContent || '').trim()");

  // 首屏（主页有 3D 人物，给足时间）
  await sleep(12000);
  check('首屏已渲染', await js("!document.getElementById('splash') || document.getElementById('splash').classList.contains('is-hidden')"));

  /* ============================ ① 概览里的加载器卡片 ============================ */
  await click('[data-nav=versionsetting]');
  await sleep(1600);
  const card = await js(\`(() => ({
    hasCard: !!document.getElementById('vs-loader-open'),
    value: (document.getElementById('vs-loader-value') || {}).textContent || '',
    cardTitleCount: Array.from(document.querySelectorAll('.vset__pane .card__title')).map(x => x.textContent.trim()).slice(0, 4),
  }))()\`);
  console.log('LOADER_CARD ' + JSON.stringify(card));
  check('概览里有「模组加载器」卡片 + 「安装 / 更换加载器」按钮', card.hasCard, card);
  check('原版实例显示「原版（没有模组加载器）」', /原版/.test(card.value) && /没有模组加载器/.test(card.value), card.value);
  await shot('_autoinstall-card.png');

  /* ============================ ② 打开补装弹窗 ============================ */
  await click('#vs-loader-open');
  const modalUp = await waitFor("document.querySelector('#modal-root .modal--loader')", 8000);
  check('点按钮能弹出加载器弹窗', modalUp >= 0, modalUp);
  const modalInfo = await js(\`(() => ({
    rows: Array.from(document.querySelectorAll('#modal-root [data-loader]')).map(r => r.getAttribute('data-loader')),
    vanillaHasSelect: !!document.querySelector('#modal-root [data-selver=vanilla]'),
    hasOf: !!document.getElementById('vs-al-of'),
    hasGo: !!document.getElementById('vs-al-go'),
    intro: (document.querySelector('#modal-root .loader-intro') || {}).innerText || '',
  }))()\`);
  console.log('LOADER_MODAL ' + JSON.stringify(modalInfo));
  check(
    '弹窗里有 7 行加载器（原版/Fabric/Forge/NeoForge/Quilt/ModLoader/Babric）',
    modalInfo.rows.join(',') === 'vanilla,fabric,forge,neoforge,quilt,modloader,babric',
    modalInfo.rows
  );
  check('原版行没有版本下拉，其它行有', modalInfo.vanillaHasSelect === false);
  check('弹窗里有 OptiFine 勾选项和「开始安装」按钮', modalInfo.hasOf && modalInfo.hasGo);
  check('弹窗说明「不会重新下载游戏本体」', /不会重新下载游戏本体/.test(modalInfo.intro), modalInfo.intro.slice(0, 80));

  /* ============================ ③ 版本查询（loader:versions） ============================ */
  await waitFor(
    "Array.from(document.querySelectorAll('#modal-root [data-ver]')).some(el => !/查询版本中/.test(el.textContent))",
    30000
  );
  await sleep(1500);
  const verBadges = await js("Array.from(document.querySelectorAll('#modal-root [data-ver]')).map(el => el.getAttribute('data-ver') + '=' + el.textContent.trim())");
  const stillLoading = await js("document.querySelectorAll('#modal-root .loader-item__ver.is-loading').length");
  console.log('VER_BADGES ' + JSON.stringify(verBadges) + ' stillLoading=' + stillLoading);
  check('加载器版本查询有结果（不再全是「查询版本中…」）', stillLoading < 6, { verBadges, stillLoading });
  check(
    '「该版本没有 X」或「最新 x」都是中文文案',
    verBadges.some((b) => /最新|该版本没有|ModLoader|Babric/.test(b)),
    verBadges
  );
  await shot('_autoinstall-modal.png');

  /* ============================ ④ payload A：Forge，不勾 OptiFine ============================ */
  await click('[data-loader=forge]');
  await sleep(250);
  const pickedInfo = await js("(() => ({ picked: document.querySelectorAll('#modal-root .loader-item.is-picked').length, goDisabled: document.getElementById('vs-al-go').disabled }))()");
  check('点一行就选中（只有一个高亮，开始安装可点）', pickedInfo.picked === 1 && pickedInfo.goDisabled === false, pickedInfo);

  await click('#vs-al-go');
  const gotA = await waitCaptured(1);
  const a = captured[0];
  console.log('CASE_A ' + JSON.stringify(a));
  check('点「开始安装」真的调了 install:start', gotA && !!a, gotA);
  if (a) {
    check('payload A：id / mcVersion 正确', a.payload.id === 'vsinst' && a.payload.mcVersion === '1.20.1', a.payload);
    check('payload A：loader = { type: forge, version: 非空 }', a.payload.loader && a.payload.loader.type === 'forge' && !!a.payload.loader.version, a.payload.loader);
    check('payload A：**没有** optifineVersion 字段（没勾就不传）', !Object.prototype.hasOwnProperty.call(a.payload, 'optifineVersion'), Object.keys(a.payload));
  }

  /* ---------------- 进度：错 taskId 不改界面 ---------------- */
  await waitFor("!document.getElementById('vs-al-lp').hidden", 5000);
  const beforeBad = await textOf('#vs-al-lp-stage');
  sendProgress({ taskId: 'someone-else-task', stage: '不该出现的别人任务', percent: 88, done: false });
  await sleep(500);
  const afterBad = await textOf('#vs-al-lp-stage');
  const badPct = await textOf('#vs-al-lp-pct');
  console.log('BAD_TASKID ' + JSON.stringify({ beforeBad, afterBad, badPct }));
  check('taskId 对不上时界面不动（不会串到别人的任务）', afterBad === beforeBad && badPct !== '88%', { beforeBad, afterBad, badPct });

  /* ---------------- 进度：匹配 taskId 推 25% ---------------- */
  if (a) sendProgress({ taskId: a.taskId, stage: '下载 Forge 安装包', current: 1, total: 4, percent: 25, done: false });
  await sleep(500);
  const mid = await js("(() => ({ stage: (document.getElementById('vs-al-lp-stage') || {}).textContent || '', pct: (document.getElementById('vs-al-lp-pct') || {}).textContent || '', width: (document.getElementById('vs-al-lp-bar') || {}).style.width || '' }))()");
  console.log('PROGRESS_MID ' + JSON.stringify(mid));
  check('匹配的进度会更新进度行（25%）', /下载 Forge/.test(mid.stage) && mid.pct === '25%' && mid.width === '25%', mid);
  await shot('_autoinstall-progress.png');

  /* ---------------- 成功 ---------------- */
  if (a) sendProgress({ taskId: a.taskId, stage: '安装完成', percent: 100, done: true });
  const doneOk = await waitFor("/装好了/.test((document.getElementById('vs-al-lp-stage') || {}).textContent || '')", 6000);
  const doneInfo = await js("(() => ({ stage: (document.getElementById('vs-al-lp-stage') || {}).textContent || '', doneClass: !!document.querySelector('#vs-al-lp.is-done'), pct: (document.getElementById('vs-al-lp-pct') || {}).textContent || '' }))()");
  console.log('PROGRESS_DONE ' + JSON.stringify(doneInfo));
  check('done:true 显示「装好了，可以回首页启动」+ 100%', doneOk >= 0 && /装好了/.test(doneInfo.stage) && doneInfo.pct === '100%', doneInfo);
  check('成功态有 is-done 样式', doneInfo.doneClass === true);
  await shot('_autoinstall-done.png');
  const autoClosed = await waitFor("!document.querySelector('#modal-root .modal--loader')", 6000);
  check('成功后自动关窗', autoClosed >= 0, autoClosed);

  /* ============================ ⑤ payload B：原版 + 失败进度 ============================ */
  await sleep(600);
  await click('#vs-loader-open');
  await waitFor("document.querySelector('#modal-root .modal--loader')", 8000);
  await click('[data-loader=vanilla]');
  await sleep(250);
  await click('#vs-al-go');
  const gotB = await waitCaptured(2);
  const b = captured[1];
  console.log('CASE_B ' + JSON.stringify(b));
  check('payload B：选原版时 loader === null', gotB && b && b.payload.loader === null, b && b.payload);
  check('payload B：同样不带 optifineVersion', b && !Object.prototype.hasOwnProperty.call(b.payload, 'optifineVersion'), b && Object.keys(b.payload));

  if (b) {
    sendProgress({ taskId: b.taskId, stage: '安装失败', done: true, error: '模拟失败：Forge 安装器下载超时', percent: 0 });
  }
  await sleep(700);
  const failInfo = await js("(() => ({ stage: (document.getElementById('vs-al-lp-stage') || {}).textContent || '', errorClass: !!document.querySelector('#vs-al-lp.is-error'), doneClass: !!document.querySelector('#vs-al-lp.is-done'), goText: (document.getElementById('vs-al-go') || {}).textContent || '' }))()");
  console.log('PROGRESS_FAIL ' + JSON.stringify(failInfo));
  check('失败进度（done+error）显示中文错误而不是「装好了」', /模拟失败/.test(failInfo.stage) && !/装好了/.test(failInfo.stage), failInfo);
  check('失败态有 is-error 样式、按钮变成「重试」', failInfo.errorClass === true && /重试/.test(failInfo.goText), failInfo);
  await shot('_autoinstall-error.png');
  await click('#vs-al-cancel'); // 失败后这个按钮是「关闭」
  await sleep(400);

  /* ============================ ⑥ payload C：OptiFine 自动切 Forge ============================ */
  await click('#vs-loader-open');
  await waitFor("document.querySelector('#modal-root .modal--loader')", 8000);
  await waitFor("Array.from(document.querySelectorAll('#modal-root [data-ver]')).some(el => !/查询版本中/.test(el.textContent))", 30000);
  await sleep(1200);
  const ofReady = await js("!!document.getElementById('vs-al-of') && !document.getElementById('vs-al-of').disabled");
  console.log('OF_READY ' + JSON.stringify(ofReady));
  if (!ofReady) {
    // 这个 MC 版本查不到 OptiFine 版本（或网络拿不到）⇒ 界面应禁用勾选并给中文说明
    const ofDisabledInfo = await js(\`(() => ({
      disabled: document.getElementById('vs-al-of').disabled,
      hint: (document.getElementById('vs-al-of-hint') || {}).textContent || '',
    }))()\`);
    console.log('OF_DISABLED ' + JSON.stringify(ofDisabledInfo));
    check('查不到 OptiFine 时勾选框被禁用并给出中文说明', ofDisabledInfo.disabled === true && /OptiFine/.test(ofDisabledInfo.hint), ofDisabledInfo);
    console.log('SKIP OptiFine 自动切 Forge 的 payload 断言（这个 MC 版本查不到 OptiFine 版本，走的是降级分支）');
  } else {
    await click('[data-loader=fabric]');
    await sleep(250);
    await click('#vs-al-of');
    await sleep(500);
    const ofInfo = await js(\`(() => ({
      checked: document.getElementById('vs-al-of').checked,
      picked: Array.from(document.querySelectorAll('#modal-root .loader-item.is-picked')).map(r => r.getAttribute('data-loader')),
      toast: ((document.getElementById('toast-root') || {}).textContent || ''),
    }))()\`);
    console.log('OPTIFINE_SWITCH ' + JSON.stringify(ofInfo));
    check('勾 OptiFine 后加载器自动切到 Forge', ofInfo.checked === true && ofInfo.picked.includes('forge'), ofInfo);
    check('自动切换有中文 toast 说明', /OptiFine 需要 Forge/.test(ofInfo.toast), ofInfo.toast);
    await shot('_autoinstall-optifine.png');

    await click('#vs-al-go');
    const gotC = await waitCaptured(3);
    const c = captured[2];
    console.log('CASE_C ' + JSON.stringify(c));
    check('payload C：loader.type === forge（自动切换生效）', gotC && c && c.payload.loader && c.payload.loader.type === 'forge', c && c.payload.loader);
    check('payload C：optifineVersion 是字符串（勾了就带上）', c && typeof c.payload.optifineVersion === 'string', c && c.payload.optifineVersion);
    if (c) sendProgress({ taskId: c.taskId, stage: '安装完成', percent: 100, done: true });
    await sleep(2200);
  }

  /* ============================ 汇总 ============================ */
  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) }));
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`;

fs.writeFileSync(inner, innerSrc, 'utf8');

// 生成的内层脚本先自检语法（模板字符串里漏转义反引号光看 --check 发现不了）
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

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-vs');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

// ★ 只 spawn 自己这一棵进程树；退出时 child.kill()，绝不碰用户正在用的 QCL
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'inherit' });
child.on('exit', (code) => {
  try {
    fs.unlinkSync(inner);
  } catch {
    /* ignore */
  }
  try {
    const cacheRoot = path.join(ROOT, '.cache') + path.sep;
    if (path.resolve(FIX).startsWith(path.resolve(cacheRoot))) fs.rmSync(FIX, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = code ?? 0;
});
