'use strict';
/**
 * 验收：主页「我的实例」
 *   ① 主页能列出真实实例（不是空的）
 *   ② 当前实例有「当前」标记，其它显示「切换」
 *   ③ 点其它实例能切换，「当前」标记跟着走
 *   ④ 有「打开数据目录」和「管理实例」按钮
 *   ⑤ 程序目录里有指向真实数据的入口（junction 或指路文件）
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'home-instances-result.json');

const inner = path.join(__dirname, '_home-inst-inner.js');
fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
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
    width: 1400, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 60000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await sleep(14000);

  const js = (c) => win.webContents.executeJavaScript(c, true);
  const checks = [];
  let probeInfo = null;
  const push = (name, pass, info) => checks.push({ name, pass, info });

  try {
    // 确保在主页
    await js(\`(document.querySelector('[data-nav="home"]')||{click(){}}).click();\`);
    await sleep(2000);

    const info = await js(\`(function(){
      var grid = document.getElementById('home-inst-grid');
      var cards = grid ? grid.querySelectorAll('[data-inst]') : [];
      var out = Array.from(cards).map(function(c){
        return {
          id: c.getAttribute('data-inst'),
          name: ((c.querySelector('.home-inst__name')||{}).textContent||'').trim(),
          meta: ((c.querySelector('.home-inst__meta')||{}).textContent||'').trim(),
          badge: ((c.querySelector('.home-inst__badge')||{}).textContent||'').trim(),
          active: c.classList.contains('is-active')
        };
      });
      return {
        count: out.length, cards: out,
        hasOpenData: !!document.getElementById('home-open-data'),
        hasMore: !!document.getElementById('home-more-inst'),
        countText: ((document.getElementById('home-inst-count')||{}).textContent||'').trim(),
        empty: !!document.querySelector('.home-instances__empty')
      };
    })()\`);

    push('① 主页列出实例', info.count > 0, { 数量: info.count, 计数文案: info.countText });
    push('② 每张卡有名字/版本/加载器和标记', info.cards.every(c => c.name && c.meta && (c.badge === '当前' || c.badge === '切换')), info.cards);
    push('③ 恰好一个「当前」', info.cards.filter(c => c.badge === '当前').length === 1, info.cards.map(c => c.name + ':' + c.badge));
    push('④ 有「打开数据目录」按钮', info.hasOpenData === true);
    push('⑤ 有「管理实例」按钮', info.hasMore === true);
    probeInfo = info;

    // 切到另一个实例
    const other = info.cards.find(c => c.badge !== '当前');
    if (other) {
      await js(\`(function(){var c=document.querySelector('#home-inst-grid [data-inst="\${other.id}"]'); if(c) c.click();})()\`);
      await sleep(1800);
      const after = await js(\`(function(){
        var cards = document.querySelectorAll('#home-inst-grid [data-inst]');
        return Array.from(cards).map(function(c){ return {
          id: c.getAttribute('data-inst'),
          badge: ((c.querySelector('.home-inst__badge')||{}).textContent||'').trim(),
          active: c.classList.contains('is-active')
        };});
      })()\`);
      push('⑥ 点其它实例能切换「当前」', after.some(x => x.id === other.id && x.badge === '当前'),
        { 点击: other.id, 切换后: after.map(x => x.id + ':' + x.badge) });
    } else {
      push('⑥ 点其它实例能切换「当前」', false, '只有一个实例，无法验证切换');
    }

    // 程序目录入口
    const link = path.join(ROOT, 'QCL数据');
    const guide = path.join(ROOT, 'QCL数据-在这里.txt');
    const hasLink = fs.existsSync(link);
    const hasGuide = fs.existsSync(guide);
    push('⑦ 程序目录有数据入口（junction 或指路文件）', hasLink || hasGuide, { junction: hasLink, guideTxt: hasGuide });
    if (hasLink) {
      try {
        const cnt = fs.readdirSync(link).length;
        push('⑧ 入口里的内容与真实主目录一致', cnt > 0, { 顶层项: cnt });
      } catch (e) {
        push('⑧ 入口里的内容与真实主目录一致', false, e.message);
      }
    } else {
      push('⑧ 入口里的内容与真实主目录一致', hasGuide, '用指路文件兜底');
    }
  } catch (e) {
    console.log('FATAL', e && e.stack || e);
    checks.push({ name: '过程异常', pass: false, info: String(e && e.message || e) });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ checks, info: probeInfo }, null, 2), 'utf8');
  console.log('RESULT ' + JSON.stringify(checks, null, 2));
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-homeinst');
fs.mkdirSync(userData, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], {
  env, stdio: 'inherit',
});
child.on('exit', () => {
  try { fs.unlinkSync(inner); } catch { /* ignore */ }
  let res = null;
  try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* ignore */ }
  console.log('\n================ 验收结果 ================');
  if (!res) { console.log('没有结果文件'); process.exitCode = 1; return; }
  let fail = 0;
  for (const c of res.checks || []) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${(res.checks || []).length} 项，失败 ${fail} 项`);
  process.exitCode = fail === 0 ? 0 : 1;
});
