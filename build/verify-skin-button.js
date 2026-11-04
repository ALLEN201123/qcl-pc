'use strict';
/**
 * 实测「设置皮肤」按钮的完整链路：
 *   ① accounts:pickSkin 弹系统文件框（这里用直接构造路径模拟，跳过 GUI 选择）
 *   ② accounts:setSkin 保存
 *   ③ 主界面人物 + 右栏头像是否都跟着变
 *   ④ accounts:clearSkin 清除
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(ROOT, '.skin-btn-test');
const SHOT = path.join(ROOT, 'docs', '_skin-btn.png');
const inner = path.join(__dirname, '_skinbtn-inner.js');

// 准备一张真实皮肤（用 Notch 的，64×64）
async function prepareSkin() {
  const lookup = require(path.join(CORE, 'skinlookup.js'));
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const info = await lookup.lookupPlayerSkin({ name: 'Notch' });
  if (!info.ok) throw new Error(info.error);
  const dl = await lookup.downloadSkinAsDataUrl({ url: info.skinUrl });
  if (!dl.ok) throw new Error(dl.error);
  const skinPath = path.join(HOME, '_src-skin.png');
  fs.writeFileSync(skinPath, Buffer.from(dl.dataUrl.split(',')[1], 'base64'));
  return skinPath;
}

async function main() {
  const skinPath = await prepareSkin();
  console.log(`① 准备皮肤：${skinPath}`);

  fs.writeFileSync(
    inner,
    `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};
const SKIN = ${JSON.stringify(skinPath)};
const SHOT = ${JSON.stringify(SHOT)};

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

  // 建一个离线账号
  const accounts = require(path.join(ROOT, 'src', 'main', 'core', 'accounts.js'));
  const acc = await accounts.addOffline(HOME, 'SkinBtnTest');
  console.log('ACCOUNT ' + acc.uuid);
  console.log('SKINFILE_BEFORE ' + JSON.stringify((await accounts.list(HOME))[0].skinFile || null));

  // ② 直接走 setSkin（模拟 pickSkin 返回后的第二步）
  const skinMod = require(path.join(ROOT, 'src', 'main', 'core', 'skin.js'));
  const imported = skinMod.importSkin(HOME, SKIN, acc.uuid);
  console.log('IMPORT ' + JSON.stringify(imported.ok ? { ok: true, path: imported.path, size: imported.width + 'x' + imported.height } : imported));
  if (!imported.ok) { app.exit(1); return; }
  await accounts.updateAccount(HOME, acc.uuid, { skinFile: imported.path, skinModel: 'classic' });
  console.log('SKINFILE_AFTER ' + JSON.stringify((await accounts.list(HOME))[0].skinFile || null));

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 30000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 17000));

  const st = await win.webContents.executeJavaScript(\`
    (() => {
      const av = document.querySelector('#account-avatar');
      const v = window.__qclSkinViewer;
      return {
        头像是否裁出的脸: av ? String(av.src).startsWith('data:image/png') : null,
        名字栏: (document.querySelector('#account-name')||{}).textContent,
        人物皮肤来源: (document.querySelector('#skin-name')||{}).textContent,
        人物ready: v ? v.ready : null,
        人物style: v ? v.style : null,
      };
    })()
  \`);
  console.log('UI ' + JSON.stringify(st, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('SHOT ' + SHOT);

  // ④ 清除皮肤
  await accounts.updateAccount(HOME, acc.uuid, { skinFile: null });
  const after = (await accounts.list(HOME))[0];
  console.log('SKINFILE_CLEARED ' + JSON.stringify(after.skinFile || null));

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
    'utf8'
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = path.join(ROOT, '.cache', 'userdata-skinbtn');
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

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
