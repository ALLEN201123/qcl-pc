'use strict';
/**
 * 端到端验证：账号皮肤能否真的同步到「主界面人物」和「右栏头像」
 *
 * 这个脚本不靠"代码看起来对"，而是：
 *   1. 造一个离线账号
 *   2. 用 skin:applyPlayerSkin 把某个正版玩家的真实皮肤下载并绑定到账号
 *   3. 启动真实 Electron 窗口，读取主界面人物的**运行时状态**：
 *        · SkinViewer.ready 是否 true
 *        · 模型的材质里 uTexture 是否已加载
 *        · canvas 上是否真的画出了人（读像素）
 *   4. 再截图，人工也能看
 *
 * 用法：node build\verify-skin-sync.js [玩家名]
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const PLAYER = process.argv[2] || 'Notch';
const HOME = path.join(ROOT, '.skin-test-home');

function load(n) {
  return require(path.join(ROOT, 'src', 'main', 'core', `${n}.js`));
}

async function prepareAccount() {
  const accounts = load('accounts');
  const lookup = load('skinlookup');
  const skinMod = load('skin');

  // 清空旧数据，保证干净
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  const acc = await accounts.addOffline(HOME, 'SkinTester');
  console.log(`① 建账号：${acc.name} (${acc.uuid})`);

  console.log(`② 查询正版玩家「${PLAYER}」的皮肤…`);
  const info = await lookup.lookupPlayerSkin({ name: PLAYER });
  if (!info.ok) throw new Error(`查询失败：${info.error}`);
  console.log(`   找到：${info.name}  slim=${info.slim}`);
  console.log(`   皮肤地址：${info.skinUrl}`);

  console.log('③ 下载皮肤…');
  const dl = await lookup.downloadSkinAsDataUrl({ url: info.skinUrl });
  if (!dl.ok) throw new Error(`下载失败：${dl.error}`);
  console.log(`   下载完成：${(dl.bytes / 1024).toFixed(1)} KB`);

  // 存盘
  const dir = path.join(HOME, 'skins');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${acc.uuid}.png`);
  fs.writeFileSync(dest, Buffer.from(dl.dataUrl.split(',')[1], 'base64'));

  const check = skinMod.validateSkinFile(dest);
  if (!check.ok) throw new Error(`皮肤尺寸不合法：${check.error}`);
  console.log(`   尺寸校验通过：${check.width}×${check.height}`);

  await accounts.updateAccount(HOME, acc.uuid, {
    skinFile: dest,
    skinModel: info.slim ? 'slim' : 'classic',
    skinSourceName: info.name
  });
  console.log(`④ 已绑定到账号，skinFile=${dest}`);

  return { account: acc, dest, slim: info.slim };
}

function runElectron() {
  const inner = path.join(__dirname, '_skin-sync-inner.js');
  fs.writeFileSync(
    inner,
    `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const SHOT = ${JSON.stringify(path.join(ROOT, 'docs', '_skin-sync.png'))};

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404', { status: 404 }); }
  });

  // 真实 IPC，但 home 指向测试目录
  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: ROOT, homeOverride: HOME });
  settings.load();
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);

  const loaded = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('加载超时')), 25000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 16000));   // 等 glTF + 皮肤加载

  const state = await win.webContents.executeJavaScript(\`
    (() => {
      const v = window.__qclSkinViewer;
      const canvas = document.querySelector('#skin-canvas');
      const nameEl = document.querySelector('#skin-name');
      if (!v) return { 错误: '没有 viewer' };
      const g = v.models && v.models.get(v.style);
      let meshCount = 0, withTexture = 0;
      if (g) g.scene.traverse((m) => {
        if (m.isMesh && m.visible) {
          meshCount++;
          if (m.material && m.material.uniforms && m.material.uniforms.uTexture && m.material.uniforms.uTexture.value) withTexture++;
        }
      });
      // 读画布中心像素，确认真的画出了人
      let nonEmpty = 0, total = 0;
      try {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (gl) {
          const w = canvas.width, h = canvas.height;
          const px = new Uint8Array(4 * 200);
          gl.readPixels(Math.floor(w/2)-10, Math.floor(h/2)-5, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
          total = 200;
          for (let i = 0; i < px.length; i += 4) if (px[i+3] > 16) nonEmpty++;
        }
      } catch (e) {}
      return {
        ready: v.ready,
        style: v.style,
        modelHeight: v._modelHeight,
        可见网格: meshCount,
        有贴图网格: withTexture,
        画布中心非透明像素: nonEmpty + '/' + total,
        名字栏文案: nameEl ? nameEl.textContent : null,
        当前皮肤源: v.skinUrl || '(本地/默认)',
      };
    })()
  \`).catch((e) => ({ 执行失败: String(e && e.message) }));

  console.log('SKIN_STATE ' + JSON.stringify(state, null, 2));

  // 截图
  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('SKIN_SHOT ' + SHOT);

  app.exit(0);
}).catch((e) => { console.log('SKIN_FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
    'utf8'
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = path.join(ROOT, '.cache', 'userdata-skin');
  fs.mkdirSync(userData, { recursive: true });

  const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], {
    env,
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    try {
      fs.unlinkSync(inner);
    } catch {
      /* ignore */
    }
    process.exitCode = code ?? 0;
  });
}

async function main() {
  console.log(`════════ 皮肤同步端到端验证（玩家：${PLAYER}）════════\n`);
  await prepareAccount();
  console.log('\n⑤ 启动 Electron 检查主界面人物…\n');
  runElectron();
}

main().catch((e) => {
  console.error('\n❌ 失败：', e.message);
  process.exitCode = 1;
});
