'use strict';
/**
 * 验证本轮三个修复：
 *   ① 账号页头像 = 你的真实皮肤裁出的脸（不是史蒂夫）
 *   ② 主界面人物显示披风
 *   ③ 实验室页已移除
 *
 * 用真实用户数据（Documents\QCL）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const inner = path.join(__dirname, '_fix-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = ${JSON.stringify(ROOT)};
const HOME = ${JSON.stringify(HOME)};

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
  await new Promise((r) => setTimeout(r, 18000));

  // ① 账号数据（确认 capeUrl 在）
  const acct = await win.webContents.executeJavaScript(\`
    window.qcl.invoke('accounts:list', {}).then(list => (list||[]).map(a => ({
      name: a.name, type: a.type, selected: a.selected,
      有皮肤: !!a.avatar, 有披风: !!a.capeUrl, 模型: a.skinModel || null,
    })))
  \`);
  console.log('ACCOUNTS ' + JSON.stringify(acct, null, 2));

  // ② 主界面人物 + 披风状态
  const homeState = await win.webContents.executeJavaScript(\`
    (() => {
      const v = window.__qclSkinViewer;
      if (!v) return { err: 'no viewer' };
      const g = v.models.get(v.style);
      let capeMeshes = 0, capeVisible = 0, capeHasTex = 0;
      if (g) g.scene.traverse((m) => {
        if (m.isMesh && m.userData && m.userData.isCape) {
          capeMeshes++;
          if (m.visible) capeVisible++;
          if (m.material && m.material.uniforms && m.material.uniforms.uTexture && m.material.uniforms.uTexture.value) capeHasTex++;
        }
      });
      return {
        人物ready: v.ready,
        风格: v.style,
        有皮肤贴图: !!v.texture,
        披风网格数: capeMeshes,
        披风可见数: capeVisible,
        披风有贴图: capeHasTex,
        有披风纹理对象: !!v.capeTexture,
        名字栏: (document.querySelector('#skin-name')||{}).textContent,
      };
    })()
  \`);
  console.log('HOME ' + JSON.stringify(homeState, null, 2));

  const img1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_cape-home.png'), img1.toPNG());
  console.log('SHOT docs/_cape-home.png');

  // ③ 账号页头像
  await win.webContents.executeJavaScript("(document.querySelector('[data-nav=\\"tools\\"]')||{}).click()");
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript(\`
    (async () => {
      // accounts 页不在左栏，用工具页的入口或直接 router
      const btns = Array.from(document.querySelectorAll('button'));
      const hit = btns.find(x => /账号/.test(x.textContent||''));
      if (hit) hit.click();
      return !!hit;
    })()
  \`);
  await new Promise((r) => setTimeout(r, 4000));

  const avatarState = await win.webContents.executeJavaScript(\`
    (() => {
      const imgs = Array.from(document.querySelectorAll('[data-avatar-of]'));
      return {
        账号数: imgs.length,
        头像: imgs.map(x => ({
          src前缀: String(x.src).slice(0, 30),
          是裁出的脸: String(x.src).startsWith('data:image/png'),
          尺寸: x.naturalWidth + 'x' + x.naturalHeight,
        })),
        当前页: (document.querySelector('.page__title')||{}).textContent,
      };
    })()
  \`);
  console.log('AVATARS ' + JSON.stringify(avatarState, null, 2));

  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'docs', '_cape-accounts.png'), img2.toPNG());
  console.log('SHOT docs/_cape-accounts.png');

  // ④ 实验室页是否还能进（页面清单）
  const pages = await win.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-nav]')).map(b => b.getAttribute('data-nav'))"
  );
  console.log('NAV ' + JSON.stringify(pages));

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-fix');
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
