'use strict';
/**
 * 验收脚本：下载页七大分类 + 愚人节分页 + 收藏页 + 披风完整渲染 + 启动窗口「真等待」
 *
 * 用真实 Electron 启动（`qcl://` 自定义协议 + 真实 QCL 主目录），
 * 逐项执行并截图，最后打印 CHECK 结论；有任何一项 FAIL 则以退出码 1 结束。
 *
 * 产出截图（docs/）：
 *   _dl-<分类>.png            七大分类各一张
 *   _dl-april.png             愚人节版本分页
 *   _dl-favorites.png         收藏页
 *   _cape-back-fixed.png      披风（背面，修复后）
 *   _cape-front-fixed.png     披风（正面，不能挡住身体）
 *   _launch-waiting.png       启动窗口「仍在加载…」状态
 *
 * 用法：node build/verify-download-ui.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT_DIR = path.join(ROOT, 'docs');
const inner = path.join(__dirname, '_verify-download-ui-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const SHOT_DIR = ${JSON.stringify(SHOT_DIR)};

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
  ipcMod.registerIpc();

  /**
   * ★ 测试桩：content:sources 后端正在接入，主进程还没有这个通道。
   *   为了能验证「下载源切换器」这一块 UI，这里在主进程侧补一个**只存在于本脚本**的桩，
   *   返回 backend-dev 约定的形状。生产代码一行都没动。
   *   如果后端已经把真通道加上了（ipcMain.handle 重复注册会抛），就自动跳过、用真的。
   */
  let sourcesStub = false;
  try {
    const { ipcMain } = require('electron');
    ipcMain.handle('content:sources', async () => ({
      ok: true,
      sources: [
        { id: 'mixed', name: '混合（推荐）', desc: '同时搜索 Modrinth 与 CurseForge' },
        { id: 'modrinth', name: 'Modrinth', desc: '开源社区，无需登录' },
        { id: 'curseforge', name: 'CurseForge', desc: '内容最全（走镜像，无需 API Key）' },
      ],
    }));
    sourcesStub = true;
  } catch (e) {
    sourcesStub = false;
  }
  console.log('SOURCES_STUB ' + sourcesStub);

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('PAGE! ' + message);
  });
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('加载超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shot = async (name, rect) => {
    const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    console.log('SHOT docs/' + name);
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  /**
   * 轮询等待条件成立。内容类分类要真的走 Modrinth 网络请求（可能十几秒），
   * 固定 sleep 会把「还在转圈」误判成「白屏」，所以统一改成等「卡片出现或中文空状态出现」。
   */
  async function waitFor(expr, timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let ok = false;
      try {
        ok = await js('(() => !!( ' + expr + ' ))()');
      } catch {
        ok = false;
      }
      if (ok) return Date.now() - t0;
      await sleep(400);
    }
    return -1;
  }

  // 等首屏 + 3D 人物 + 皮肤 + 披风全部就位
  await sleep(19000);
  check('首屏已渲染（splash 已消失）', await js("!document.getElementById('splash') || document.getElementById('splash').classList.contains('is-hidden')"));

  /* ============================ ① 下载页：七大分类 ============================ */
  await js("(() => { const b = document.querySelector('[data-nav=\\"download\\"]'); if (b) b.click(); return !!b; })()");
  await sleep(1200);
  const firstLoad = await waitFor("document.querySelectorAll('#dl-list .dlcard').length > 0 || document.querySelector('#dl-list .empty__title')", 30000);
  console.log('FIRST_LOAD_MS ' + firstLoad);
  check('下载页首屏加载完成（卡片或空状态）', firstLoad >= 0, firstLoad);

  const cats = await js("Array.from(document.querySelectorAll('#dl-cats [data-cat]')).map(b => ({ id: b.dataset.cat, label: b.querySelector('.dlcat__label') ? b.querySelector('.dlcat__label').textContent.trim() : '' }))");
  console.log('CATS ' + JSON.stringify(cats));
  const wantCats = ['游戏', '整合包', '模组', '资源包', '光影', '世界', '收藏'];
  check('七大分类存在且顺序正确', cats.length === 7 && cats.map((c) => c.label).join('/') === wantCats.join('/'), cats.map((c) => c.label));

  const perCat = [];
  for (const cat of cats) {
    const clicked = await js(\`(() => {
      const b = document.querySelector('#dl-cats [data-cat="\${cat.id}"]');
      if (!b) return false;
      b.click();
      return true;
    })()\`);
    check('分类可点击：' + cat.label, clicked);
    // 等「卡片出现」或「中文空状态出现」，避免把网络慢误判成白屏
    const waited = await waitFor(
      "document.querySelectorAll('#dl-list .dlcard').length > 0 || document.querySelector('#dl-list .empty__title')",
      25000
    );
    await sleep(300);
    const state = await js(\`(() => {
      const cards = document.querySelectorAll('#dl-list .dlcard').length;
      const emptyTitle = (document.querySelector('#dl-list .empty__title') || {}).textContent || '';
      const emptyDesc = (document.querySelector('#dl-list .empty__desc') || {}).textContent || '';
      const subtabs = Array.from(document.querySelectorAll('#dl-subtabs .segmented__item')).map(b => b.textContent.trim());
      const activeCat = (document.querySelector('#dl-cats .dlcat.is-active .dlcat__label') || {}).textContent || '';
      const count = (document.getElementById('dl-count') || {}).textContent || '';
      const bodyText = (document.getElementById('dl-list') || {}).innerText || '';
      const toolbar = Array.from(document.querySelectorAll('#dl-toolbar input, #dl-toolbar select, #dl-toolbar button')).map(x => x.id || x.tagName);
      return { cards, emptyTitle, emptyDesc: emptyDesc.slice(0, 40), subtabs, activeCat, count, toolbar, hasBody: bodyText.trim().length > 0 };
    })()\`);
    console.log('CAT ' + cat.id + ' ' + JSON.stringify(state));
    perCat.push({ cat: cat.id, label: cat.label, waitedMs: waited, ...state });
    check('分类「' + cat.label + '」有内容（卡片或中文空状态）', state.cards > 0 || state.emptyTitle.length > 0, { cards: state.cards, emptyTitle: state.emptyTitle, waitedMs: waited });
    check('分类「' + cat.label + '」没有白屏', state.hasBody, { textLen: state.hasBody });
    check('分类「' + cat.label + '」左侧 tab 高亮跟着切换', state.activeCat === cat.label, state.activeCat);
    await shot('_dl-' + cat.id + '.png');
  }

  /* ============================ ①b 下载源切换器（混合 / Modrinth / CurseForge） ============================ */
  await js("(() => { const b = document.querySelector('#dl-cats [data-cat=\\"mod\\"]'); if (b) b.click(); return true; })()");
  await waitFor("document.querySelectorAll('#dl-list .dlcard').length > 0 || document.querySelector('#dl-list .empty__title')", 25000);
  await sleep(300);

  const srcApi = await js("window.qcl.invoke('content:sources', {}).then(r => ({ ok: true, n: Array.isArray(r && r.sources) ? r.sources.length : null, ids: Array.isArray(r && r.sources) ? r.sources.map(s => s.id) : null })).catch(e => ({ ok: false, msg: String(e && e.message || e).slice(0, 120) }))");
  console.log('SOURCES_API ' + JSON.stringify(srcApi));

  // 顺带验证「optional 调用失败不会把整个启动器标成示例模式」（下载页所有 content:* 都走 optional）
  const optionalProbe = await js(\`(async () => {
    const bridge = await import('./js/bridge.js');
    const before = !!document.querySelector('.banner--warn');
    await bridge.call('tools:definitelyNotAChannel', {}, { optional: true });
    const after = !!document.querySelector('.banner--warn');
    return { before, after };
  })()\`);
  console.log('OPTIONAL_PROBE ' + JSON.stringify(optionalProbe));
  check('optional 通道失败不会弹全局「主进程暂不可用」横幅', optionalProbe.after === optionalProbe.before, optionalProbe);
  const srcUi = await js(\`(() => {
    const group = document.getElementById('dl-sources');
    const items = group ? Array.from(group.querySelectorAll('[data-src]')).map(b => ({ id: b.dataset.src, label: b.textContent.trim(), active: b.classList.contains('is-active') })) : [];
    const mod = document.querySelectorAll('#dl-list .badge--modrinth').length;
    const cf = document.querySelectorAll('#dl-list .badge--curseforge').length;
    const degradedBanner = !!document.querySelector('.banner--warn');
    return { hasGroup: !!group, items, badgeModrinth: mod, badgeCurseforge: cf, degradedBanner };
  })()\`);
  console.log('SOURCES_UI ' + JSON.stringify(srcUi));
  if (srcUi.hasGroup) {
    check('下载源切换器有 3 个选项', srcUi.items.length === 3, srcUi.items.map((x) => x.label));
    check('默认选中「混合」', srcUi.items.some((x) => x.id === 'mixed' && x.active), srcUi.items);
    check('来源徽章出现（Modrinth 蓝 / CurseForge 橙）', srcUi.badgeModrinth + srcUi.badgeCurseforge > 0, { modrinth: srcUi.badgeModrinth, curseforge: srcUi.badgeCurseforge });
    // 切到 CurseForge 应该重新搜索
    await js("(() => { const b = document.querySelector('#dl-sources [data-src=\\"curseforge\\"]'); if (b) b.click(); return !!b; })()");
    await waitFor("document.querySelectorAll('#dl-list .dlcard').length > 0 || document.querySelector('#dl-list .empty__title')", 25000);
    await sleep(400);
    const afterSwitch = await js(\`(() => {
      const active = (document.querySelector('#dl-sources .segmented__item.is-active') || {}).textContent || '';
      const cards = document.querySelectorAll('#dl-list .dlcard').length;
      const cfBadges = document.querySelectorAll('#dl-list .badge--curseforge').length;
      const emptyTitle = (document.querySelector('#dl-list .empty__title') || {}).textContent || '';
      return { active, cards, cfBadges, emptyTitle };
    })()\`);
    console.log('SOURCE_SWITCH ' + JSON.stringify(afterSwitch));
    check('切换下载源后选中态跟着变', afterSwitch.active === 'CurseForge', afterSwitch.active);
    check('切换下载源后列表重新渲染（不白屏）', afterSwitch.cards > 0 || afterSwitch.emptyTitle.length > 0, afterSwitch);
    await shot('_dl-source-curseforge.png');
    // 切回混合，别影响后续用例
    await js("(() => { const b = document.querySelector('#dl-sources [data-src=\\"mixed\\"]'); if (b) b.click(); return !!b; })()");
    await sleep(800);
  } else {
    // 后端还没接 content:sources ⇒ 按约定：默认「混合」+ 隐藏切换器，且不能触发全局降级横幅
    check('取不到下载源清单时按约定隐藏切换器（不报错）', srcApi.ok === false || (srcApi.n || 0) <= 1, srcApi);
    check('取不到下载源清单时没有触发全局「主进程暂不可用」横幅', srcUi.degradedBanner === false, srcUi.degradedBanner);
  }

  /* ============================ ①c 右下角空 toast（用户实测「弹出一堆空气」） ============================ */
  const toastProbe = await js(\`(async () => {
    const ui = await import('./js/ui.js');
    const root = document.getElementById('toast-root');
    const count = () => root.querySelectorAll('.toast').length;
    const before = count();
    // 这些都必须**不弹**
    ui.toast('');
    ui.toast(null);
    ui.toast(undefined);
    ui.toast('   ');
    ui.toast('[object Object]');
    await new Promise((r) => setTimeout(r, 80));
    const afterEmpty = count();
    // 正常消息仍然要弹，并且**必须真的有文字**（曾经的 bug 是每条 toast 都是空盒子）
    const close = ui.toast('正常提示');
    await new Promise((r) => setTimeout(r, 80));
    const afterReal = count();
    const bodyText = (root.querySelector('.toast__body') || {}).textContent || '';
    const allText = (root.textContent || '').trim();
    close();
    await new Promise((r) => setTimeout(r, 60));
    return { before, afterEmpty, afterReal, bodyText, allText };
  })()\`);
  console.log('TOAST_PROBE ' + JSON.stringify(toastProbe));
  check('空 / null / undefined / 纯空白 / [object Object] 的 toast 一律不弹（不再「弹一堆空气」）', toastProbe.afterEmpty === toastProbe.before, toastProbe);
  check(
    '正常 toast 仍然正常工作且**有文字**（曾经每条都是空盒子）',
    toastProbe.afterReal === toastProbe.before + 1 && (toastProbe.bodyText === '正常提示' || toastProbe.allText.indexOf('正常提示') >= 0),
    toastProbe
  );

  /* ============================ ② 愚人节分页 ============================ */
  const gameInfo = perCat.find((c) => c.cat === 'game');
  check('「游戏」下有四个二级分页', gameInfo && gameInfo.subtabs.join('/') === '正式版/快照/愚人节版本/远古版本', gameInfo && gameInfo.subtabs);
  check('愚人节版本分页存在', !!(gameInfo && gameInfo.subtabs.includes('愚人节版本')));

  await js("(() => { const b = document.querySelector('#dl-cats [data-cat=\\"game\\"]'); if (b) b.click(); return true; })()");
  await sleep(600);
  await js("(() => { const b = Array.from(document.querySelectorAll('#dl-subtabs .segmented__item')).find(x => x.textContent.trim() === '愚人节版本'); if (b) b.click(); return !!b; })()");
  // ★ 注意别等成「正在拉取愚人节版本…」——那也是含「愚人节」的文案。
  //   正确条件：加载中标记消失，且出现卡片或中文空状态。
  await waitFor(
    "((document.getElementById('dl-count')||{}).textContent||'').indexOf('正在拉取') < 0 && (document.querySelectorAll('#dl-list .dlcard').length > 0 || document.querySelector('#dl-list .empty__title'))",
    20000
  );
  await sleep(300);
  const aprilState = await js(\`(() => {
    const cards = document.querySelectorAll('#dl-list .dlcard').length;
    const emptyTitle = (document.querySelector('#dl-list .empty__title') || {}).textContent || '';
    const emptyDesc = (document.querySelector('#dl-list .empty__desc') || {}).textContent || '';
    const active = (document.querySelector('#dl-subtabs .segmented__item.is-active') || {}).textContent || '';
    const count = (document.getElementById('dl-count') || {}).textContent || '';
    const titles = Array.from(document.querySelectorAll('#dl-list .dlcard__title')).slice(0, 3).map(x => x.textContent.trim());
    const fools = Array.from(document.querySelectorAll('#dl-list .dlcard__author')).slice(0, 3).map(x => x.textContent.trim());
    // 愚人节来源标签：官方清单 / 内置归档
    const srcTags = { 官方: 0, 归档: 0 };
    document.querySelectorAll('#dl-list .dlcard').forEach((c) => {
      const badges = Array.from(c.querySelectorAll('.badge')).map((b) => b.textContent.trim());
      if (badges.includes('官方')) srcTags.官方++;
      if (badges.includes('归档')) srcTags.归档++;
    });
    return { cards, emptyTitle, emptyDesc, active, count, titles, fools, srcTags, textLen: ((document.getElementById('dl-list') || {}).innerText || '').trim().length };
  })()\`);
  console.log('APRIL ' + JSON.stringify(aprilState));
  check('愚人节分页可点击且已激活', aprilState.active === '愚人节版本', aprilState.active);
  check('愚人节分页有卡片或中文说明（不白屏）', aprilState.cards > 0 || (aprilState.emptyTitle.length > 0 && aprilState.textLen > 0), { cards: aprilState.cards, emptyTitle: aprilState.emptyTitle });
  // 后端把愚人节清单分成「官方清单」与「内置归档」两种来源，卡片上要能看出来
  check(
    '愚人节卡片带「官方 / 归档」来源标签',
    aprilState.cards === 0 || aprilState.srcTags.官方 + aprilState.srcTags.归档 === aprilState.cards,
    aprilState.srcTags
  );
  await shot('_dl-april.png');
  // 记录后端接口是否已经接上（只做信息输出，不算失败）
  const aprilApi = await js("window.qcl.invoke('versions:aprilFools', {}).then(r => ({ ok: true, kind: Array.isArray(r) ? 'array' : typeof r, n: Array.isArray(r) ? r.length : null })).catch(e => ({ ok: false, msg: String(e && e.message || e).slice(0, 120) }))");
  console.log('APRIL_API ' + JSON.stringify(aprilApi));

  /* ============================ ③ 收藏页 ============================ */
  await js("(() => { const b = document.querySelector('#dl-cats [data-cat=\\"favorites\\"]'); if (b) b.click(); return true; })()");
  await waitFor(
    "document.querySelector('#dl-list .empty__title') || document.querySelectorAll('#dl-list .dlcard').length > 0",
    15000
  );
  await sleep(300);
  const favState = await js(\`(() => {
    const cards = document.querySelectorAll('#dl-list .dlcard').length;
    const emptyTitle = (document.querySelector('#dl-list .empty__title') || {}).textContent || '';
    const emptyDesc = (document.querySelector('#dl-list .empty__desc') || {}).textContent || '';
    const activeCat = (document.querySelector('#dl-cats .dlcat.is-active .dlcat__label') || {}).textContent || '';
    const textLen = ((document.getElementById('dl-list') || {}).innerText || '').trim().length;
    return { cards, emptyTitle, emptyDesc, activeCat, textLen };
  })()\`);
  console.log('FAVORITES ' + JSON.stringify(favState));
  check('收藏页能渲染出内容或中文空状态', favState.cards > 0 || (favState.emptyTitle.length > 0 && favState.textLen > 0), { cards: favState.cards, emptyTitle: favState.emptyTitle });
  check('收藏页分类高亮正确', favState.activeCat === '收藏', favState.activeCat);
  await shot('_dl-favorites.png');

  /* ============================ ④ 披风完整显示 ============================ */
  await js("(() => { const b = document.querySelector('[data-nav=\\"home\\"]'); if (b) b.click(); return !!b; })()");
  await sleep(2500);

  const cape = await js(\`(async () => {
    const v = window.__qclSkinViewer;
    if (!v) return { err: '没有 SkinViewer' };
    const gltf = v.models.get(v.style);
    if (!gltf) return { err: '模型没加载' };
    let capeMesh = null;
    gltf.scene.traverse((o) => { if (o.isMesh && o.userData.isCape && !capeMesh) capeMesh = o; });
    if (!capeMesh) return { err: '没找到披风网格' };

    const out = {
      网格可见: capeMesh.visible,
      有披风贴图: !!v.capeTexture,
      flipY: v.capeTexture ? v.capeTexture.flipY : null,
      premultiplyAlpha: v.capeTexture ? v.capeTexture.premultiplyAlpha : null,
      colorSpace: v.capeTexture ? v.capeTexture.colorSpace : null,
      贴图尺寸: v.capeTexture && v.capeTexture.image ? v.capeTexture.image.width + 'x' + v.capeTexture.image.height : null,
    };

    // ---- 屏幕像素测量 ----
    // ★ 只留披风、把身体全部藏起来再数像素：这才是「披风到底渲染出来多少」的直接证据。
    //   （用「有披风 − 没披风」的轮廓差是不对的：披风本来就贴着后背，大部分会被身体轮廓盖住，
    //     差值只有边缘几百像素，会把正常渲染误判成「只渲染一丁点」。）
    v.stop();
    v.rotationX = -6;
    v.rotationY = 160;
    v._needsRender = true;
    const gl = v.renderer.getContext();
    const canvas = v.renderer.domElement;
    const W = canvas.width, H = canvas.height;
    const countOpaque = () => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++;
      return n;
    };
    const renderNow = () => v.renderer.render(v.scene, v.camera);

    const allMeshes = [];
    gltf.scene.traverse((o) => { if (o.isMesh) allMeshes.push(o); });
    const savedVis = allMeshes.map((m) => m.visible);

    // 校准：全部隐藏时应该是 0 个不透明像素（证明 readPixels 读的是当前这一帧）
    allMeshes.forEach((m) => { m.visible = false; });
    renderNow();
    const blank = countOpaque();

    // 只渲染披风
    allMeshes.forEach((m) => { m.visible = !!m.userData.isCape; });
    renderNow();
    const capeOnly = countOpaque();

    // 复现旧 bug：把披风贴图上下翻转（旧代码 flipY 默认 true）再看还剩多少
    const tex = v.capeTexture;
    let capeFlipped = null;
    if (tex) {
      tex.flipY = true;
      tex.needsUpdate = true;
      renderNow();
      capeFlipped = countOpaque();
      tex.flipY = false;
      tex.needsUpdate = true;
      renderNow();
    }

    // 还原可见性
    allMeshes.forEach((m, i) => { m.visible = savedVis[i]; });

    out.画布尺寸 = W + 'x' + H;
    out.全隐藏时像素 = blank;
    out.只渲染披风的像素 = capeOnly - blank;
    out.旧bug翻转后的披风像素 = capeFlipped === null ? null : capeFlipped - blank;
    out.像素比 = capeFlipped === null ? null : Math.round(((capeFlipped - blank) / Math.max(1, capeOnly - blank)) * 1000) / 10;

    // ---- UV 覆盖率：12 个三角形里有多少面积采到不透明像素（1 = 整件披风都在） ----
    const acctList = await window.qcl.invoke('accounts:list', {});
    const acct = (acctList || []).find((a) => a.capeUrl);
    if (acct && acct.capeUrl) {
      const rr = await window.qcl.invoke('skin:readRemote', { url: acct.capeUrl });
      const dataUrl = rr && rr.dataUrl;
      if (dataUrl) {
        const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
        const IW = img.naturalWidth, IH = img.naturalHeight;
        const cv = document.createElement('canvas'); cv.width = IW; cv.height = IH;
        const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
        const px = cx.getImageData(0, 0, IW, IH).data;
        const A = (u, vv) => {
          const x = Math.max(0, Math.min(IW - 1, Math.floor(u * IW)));
          const y = Math.max(0, Math.min(IH - 1, Math.floor(vv * IH)));
          return px[(y * IW + x) * 4 + 3] / 255;
        };
        const g = capeMesh.geometry, uv = g.getAttribute('uv'), idx = g.index;
        const tri = (idx ? idx.count : uv.count) / 3;
        const N = 20;
        let cov = 0, covFlipped = 0;
        for (let t = 0; t < tri; t++) {
          const i0 = idx ? idx.getX(t * 3) : t * 3;
          const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
          const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          let f = 0, fl = 0, n = 0;
          for (let a = 0; a <= N; a++) for (let b = 0; b <= N - a; b++) {
            const wa = a / N, wb = b / N, wc = 1 - wa - wb;
            const u = uv.getX(i0) * wa + uv.getX(i1) * wb + uv.getX(i2) * wc;
            const vq = uv.getY(i0) * wa + uv.getY(i1) * wb + uv.getY(i2) * wc;
            if (A(u, vq) >= 0.1) f++;
            if (A(u, 1 - vq) >= 0.1) fl++;
            n++;
          }
          cov += f / n;
          covFlipped += fl / n;
        }
        out.三角形数 = tri;
        out.不翻转覆盖率 = Math.round(cov * 100) / 100;
        out.翻转覆盖率 = Math.round(covFlipped * 100) / 100;
      }
    }
    renderNow();
    v.start();
    return out;
  })()\`);
  console.log('CAPE ' + JSON.stringify(cape, null, 2));

  // 背面 / 正面各拍一张（人物区域裁切放大）
  await js("(() => { const v = window.__qclSkinViewer; v.rotationX = -6; v.rotationY = 160; v._needsRender = true; return true; })()");
  await sleep(700);
  await shot('_cape-back-fixed.png', { x: 600, y: 50, width: 520, height: 800 });
  await js("(() => { const v = window.__qclSkinViewer; v.rotationX = 0; v.rotationY = -20; v._needsRender = true; return true; })()");
  await sleep(700);
  await shot('_cape-front-fixed.png', { x: 600, y: 50, width: 520, height: 800 });

  check('披风网格可见', cape.网格可见 === true, cape.网格可见);
  check('披风贴图 flipY = false（glTF UV 原点在左上）', cape.flipY === false, cape.flipY);
  check('披风贴图 premultiplyAlpha = true（与预乘混合匹配）', cape.premultiplyAlpha === true, cape.premultiplyAlpha);
  check('披风 UV 覆盖率 ≥ 90%（整件披风都采到不透明像素）', typeof cape.不翻转覆盖率 === 'number' && cape.不翻转覆盖率 >= 0.9 * (cape.三角形数 || 12), { 覆盖率: cape.不翻转覆盖率, 翻转覆盖率: cape.翻转覆盖率 });
  check('单独渲染披风时有足够大的可见面积（> 8000 像素）', cape.只渲染披风的像素 > 8000, { 像素: cape.只渲染披风的像素, 画布: cape.画布尺寸 });
  check('旧 bug（flipY=true）只剩不到一半，证明修复点正确', cape.旧bug翻转后的披风像素 !== null && cape.旧bug翻转后的披风像素 * 2 < cape.只渲染披风的像素, { 修复后: cape.只渲染披风的像素, 翻转后: cape.旧bug翻转后的披风像素, 比例: cape.像素比 + '%' });

  /* ============================ ⑤ 启动窗口「真等待」 ============================ */
  const launchTest = await js(\`(async () => {
    const lw = await import('./js/launchwindow.js');
    const bridge = await import('./js/bridge.js');
    const shell = await import('./js/shell.js');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const instId = 'verify-inst-1';
    const out = {};

    lw.openLaunchWindow({ instance: { name: '验收实例' }, extra: '26.3 · fabric' });
    await sleep(120);
    out.窗口出现 = !!document.querySelector('.modal--launching');
    // 超时兜底缩到 400ms 测「仍在加载…」文案（生产默认 90 秒）
    const cleanup = shell.wireLaunchWindowEvents(lw, instId, { readyTimeoutMs: 400 });
    await sleep(900);
    out.超时文案 = (document.getElementById('lw-meta') || {}).textContent || '';
    out.超时后仍未关窗 = !!document.querySelector('.modal--launching');

    // 阶段 + 日志 + 进程 running
    bridge.emitLocal('launch:stage', { id: instId, key: 'spawn', detail: '正在启动 Java 进程' });
    bridge.emitLocal('launch:log', { id: instId, line: 'LWJGL Version 3.3.3+5 (nightly)' });
    bridge.emitLocal('launch:state', { id: instId, state: 'running', pid: 43210 });
    await sleep(600);
    out.running后仍开窗 = !!document.querySelector('.modal--launching');
    out.日志末行 = (document.getElementById('lw-log') || {}).textContent || '';
    out.等待阶段文案 = (document.getElementById('lw-meta') || {}).textContent || '';
    out.running阶段高亮 = !!document.querySelector('.lw__stage--active .lw__label');

    // 关键：再等 2.5 秒，仍然不能关（旧代码这里早关了）
    await sleep(2500);
    out.等2_5秒后仍开窗 = !!document.querySelector('.modal--launching');

    // 游戏真正就绪 → 才允许关窗
    bridge.emitLocal('launch:game-ready', { id: instId, elapsedMs: 5200 });
    await sleep(1600);
    out.gameReady后关窗 = !document.querySelector('.modal--launching');
    out.就绪日志 = (document.getElementById('lw-log') || {}).textContent || '';
    cleanup();
    return out;
  })()\`);
  console.log('LAUNCH_WAIT ' + JSON.stringify(launchTest, null, 2));
  check('启动窗口能弹出', launchTest.窗口出现 === true);
  check('90 秒超时兜底只改文案：出现「仍在加载…」', /仍在加载/.test(launchTest.超时文案), launchTest.超时文案);
  check('超时后窗口仍开着（不关窗）', launchTest.超时后仍未关窗 === true);
  check('running 只更新阶段、不关窗', launchTest.running后仍开窗 === true);
  check('窗口显示实时日志最后一行', /LWJGL/.test(launchTest.日志末行), launchTest.日志末行);
  check('running 后等 2.5 秒仍不关窗（旧代码会关）', launchTest.等2_5秒后仍开窗 === true);
  check('收到 launch:game-ready 才关窗', launchTest.gameReady后关窗 === true);

  // 「仍在加载」那一屏截图（重开一次窗口，快速进入超时态）
  await js(\`(async () => {
    const lw = await import('./js/launchwindow.js');
    const shell = await import('./js/shell.js');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    lw.openLaunchWindow({ instance: { name: '26.3' }, extra: '26.3 · fabric' });
    shell.wireLaunchWindowEvents(lw, 'verify-inst-2', { readyTimeoutMs: 300 });
    await sleep(700);
    return true;
  })()\`);
  await sleep(500);
  await shot('_launch-waiting.png');

  /* ============================ 汇总 ============================ */
  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) }));
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// ★ 生成的内层脚本先自检语法：模板字符串里漏转义一个反引号，光看 --check 是发现不了的
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
const userData = path.join(ROOT, '.cache', 'userdata-dlui');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'inherit' });
child.on('exit', (code) => {
  try {
    fs.unlinkSync(inner);
  } catch {
    /* ignore */
  }
  process.exitCode = code ?? 0;
});
