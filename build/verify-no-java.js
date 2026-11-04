'use strict';
/**
 * 验证「没装 Java」场景的完整引导：
 *   ① java:sources 返回免登录下载源 + 推荐版本
 *   ② 设置页 Java 标签在没有 Java 时显示引导卡片
 *   ③ 一键下载按钮存在且带正确的 major
 *   ④ 截图
 *
 * 用**空 home**（没有任何 Java 目录）模拟新玩家。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(ROOT, '.nojava-test');
const SHOT = path.join(ROOT, 'docs', '_no-java.png');
const inner = path.join(__dirname, '_nojava-inner.js');

// 先测纯后端
async function testBackend() {
  const CORE = path.join(ROOT, 'src', 'main', 'core');
  const jd = require(path.join(CORE, 'javadownload.js'));
  console.log('═══ 后端：免登录下载源 ═══');
  for (const v of ['1.7.10', '1.12.2', '1.20.1', '26.3']) {
    const r = jd.sourcesFor(v);
    console.log(`  ${v.padEnd(10)} → 推荐 Java ${String(r.recommendMajor).padEnd(3)} | 下载源 ${r.sources.length} 个`);
  }
  console.log('\n  来源清单：');
  for (const s of jd.NO_LOGIN_SOURCES) {
    console.log(`    ${s.recommended ? '★' : ' '} ${s.name.padEnd(26)} ${s.url}`);
  }
  console.log('\n  主动告知不推荐：');
  console.log(`    ${jd.DISCOURAGED.oracle.name} —— ${jd.DISCOURAGED.oracle.reason.slice(0, 50)}…`);

  console.log('\n═══ 后端：真正下载（会花时间，只测小版本 Java 8 的元数据可达性）═══');
  // 只验证直链 HEAD 级可达，不整包下（省流量）
  const http = require(path.join(CORE, 'http.js'));
  try {
    const url = jd.adoptiumUrl(21);
    const buf = await http.fetchBuffer(url, { timeoutMs: 120000 });
    const ok = buf[0] === 0x50 && buf[1] === 0x4b;
    console.log(`  Java 21 直链 → ${(buf.length / 1024 / 1024).toFixed(1)} MB, zip=${ok ? '✅' : '❌'}`);
  } catch (e) {
    console.log('  ❌ ' + e.message);
  }
}

function testUI() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  fs.writeFileSync(
    inner,
    `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const SHOT = ${JSON.stringify(SHOT)};

// ★ 模拟「新玩家机器上一个 Java 都没有」：
//   清掉 JAVA_HOME/JDK_HOME，把 java.js 的常见扫描目录全部指向不存在的路径。
//   这样 java:list 会返回空数组，才真的走到「没 Java」分支。
process.env.JAVA_HOME = '';
process.env.JDK_HOME = '';
const javaCandidatesFile = path.join(ROOT, 'src', 'main', 'core', 'java.js');
const javaSrc = fs.readFileSync(javaCandidatesFile, 'utf8');
const javaMod = require(javaCandidatesFile);
if (Array.isArray(javaMod.WINDOWS_JAVA_ROOTS)) javaMod.WINDOWS_JAVA_ROOTS.length = 0;
if (Array.isArray(javaMod.REGISTRY_ROOTS)) javaMod.REGISTRY_ROOTS.length = 0;

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
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 12000));

  // 先确认这个 home 真的没有 Java
  const javaList = await win.webContents.executeJavaScript("window.qcl.invoke('java:list', {}).then(r => (r||[]).map(j => j.path))");
  console.log('JAVA_FOUND ' + JSON.stringify(javaList));

  // 进设置页 → Java 标签
  await win.webContents.executeJavaScript("(document.querySelector('[data-nav=\\"setting\\"]')||{}).click()");
  await new Promise((r) => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(\`
    (() => { const b = Array.from(document.querySelectorAll('#st-tabs .vset__tab')).find(x => x.textContent.trim() === 'Java'); if (b) b.click(); return !!b; })()
  \`);
  await new Promise((r) => setTimeout(r, 3000));

  const ui = await win.webContents.executeJavaScript(\`
    (() => {
      const box = document.querySelector('#st-java-none');
      const btn = document.querySelector('#st-java-download');
      const src = document.querySelectorAll('#st-java-sources .srcrow');
      return {
        引导卡片存在: !!box,
        卡片可见: box ? !box.hidden : null,
        一键下载按钮: btn ? btn.textContent.trim() : null,
        按钮major: btn ? btn.dataset.major : null,
        免登录来源数量: src.length,
        来源名称: Array.from(src).map(x => (x.querySelector('.srcrow__name')||{}).textContent.trim().replace(/推荐$/,'')),
        有跳转链接: Array.from(src).every(x => !!x.querySelector('a[href]')),
      };
    })()
  \`);
  console.log('UI ' + JSON.stringify(ui, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('SHOT ' + SHOT);
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
    'utf8'
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = path.join(ROOT, '.cache', 'userdata-nojava');
  fs.mkdirSync(userData, { recursive: true });
  const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    try {
      fs.unlinkSync(inner);
    } catch {
      /* ignore */
    }
    process.exitCode = code ?? 0;
  });
}

(async () => {
  await testBackend();
  console.log('\n═══ 界面：空 home（模拟新玩家）═══');
  testUI();
})();
