'use strict';
/**
 * 披风 A/B 实验（在运行时直接改贴图参数并截图对比，找出「只渲染一丁点 + 黑色」的真正原因）
 *
 * 实验顺序（每步都截图 + 局部放大）：
 *   ① 现状（当前代码）从正面/背面/侧面各拍一张
 *   ② 只把 capeTexture.flipY 改成 false 再拍
 *   ③ 再补上 premultiplyAlpha = true / colorSpace = 无 再拍
 *   ④ 把披风贴图整张 dump 出来（docs/_cape-texture.png），肉眼核对 UV 布局
 *   ⑤ 密集采样：每个三角形在 flipY true/false 两种情况下的**不透明覆盖率**（判断「一丁点」的成因）
 *
 * 用法：node build/diag-cape-ab.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT_DIR = path.join(ROOT, 'docs');
const inner = path.join(__dirname, '_cape-ab-inner.js');

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
  await new Promise((r) => setTimeout(r, 20000));

  // 人物画布附近的局部放大区域（1600x900 窗口里人物大致在 x 620~1080 / y 60~830）
  const RECT = { x: 600, y: 50, width: 520, height: 800 };
  const shot = async (name) => {
    const img = await win.webContents.capturePage(RECT);
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    console.log('SHOT docs/' + name);
  };
  const setView = async (yaw, waitMs = 500) => {
    await win.webContents.executeJavaScript(\`(() => { const v = window.__qclSkinViewer; v.rotationY = \${yaw}; v.rotationX = -6; v._needsRender = true; return v.rotationY; })()\`);
    await new Promise((r) => setTimeout(r, waitMs));
  };

  // ---------- ① 现状：正面 / 背面 / 侧面 ----------
  await setView(-20);
  await shot('_cape-ab-0-front.png');
  await setView(160);
  await shot('_cape-ab-1-back-current.png');
  await setView(90);
  await shot('_cape-ab-2-side-current.png');

  // ---------- ⑤ 密集采样：UV 覆盖率（先做，改贴图参数不影响） ----------
  const dense = await win.webContents.executeJavaScript(\`
    (async () => {
      const v = window.__qclSkinViewer;
      const gltf = v.models.get(v.style);
      let cape = null;
      gltf.scene.traverse((o) => { if (o.isMesh && o.userData.isCape && !cape) cape = o; });
      const acctList = await window.qcl.invoke('accounts:list', {});
      const acct = (acctList || []).find((a) => a.capeUrl);
      const rr = await window.qcl.invoke('skin:readRemote', { url: acct.capeUrl });
      const dataUrl = rr && rr.dataUrl;
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
      const px = cx.getImageData(0, 0, W, H).data;
      const A = (u, vv) => {
        let x = Math.floor(u * W), y = Math.floor(vv * H);
        x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
        return px[(y * W + x) * 4 + 3] / 255;
      };
      const g = cape.geometry, uv = g.getAttribute('uv'), idx = g.index;
      const triCount = (idx ? idx.count : uv.count) / 3;
      const N = 24;
      const perTri = [];
      let covFalse = 0, covTrue = 0;
      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        let f = 0, tr = 0, n = 0;
        for (let a = 0; a <= N; a++) for (let b = 0; b <= N - a; b++) {
          const wa = a / N, wb = b / N, wc = 1 - wa - wb;
          const u = uv.getX(i0) * wa + uv.getX(i1) * wb + uv.getX(i2) * wc;
          const vq = uv.getY(i0) * wa + uv.getY(i1) * wb + uv.getY(i2) * wc;
          if (A(u, vq) >= 0.1) f++;
          if (A(u, 1 - vq) >= 0.1) tr++;
          n++;
        }
        covFalse += f / n; covTrue += tr / n;
        perTri.push({ 三角形: t, 不翻转_不透明比例: Math.round((f / n) * 100) / 100, 翻转_不透明比例: Math.round((tr / n) * 100) / 100 });
      }
      // 逐行统计不透明像素分布（看贴图内容到底在哪几行）
      const rows = [];
      for (let y = 0; y < H; y++) {
        let c = 0;
        for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] >= 26) c++;
        rows.push(c);
      }
      return {
        图片尺寸: W + 'x' + H,
        三角形数: triCount,
        不翻转总覆盖率: Math.round(covFalse * 100) / 100 + '/' + triCount,
        翻转后总覆盖率: Math.round(covTrue * 100) / 100 + '/' + triCount,
        逐行不透明像素数: rows,
        逐三角形: perTri,
        dataUrl,
      };
    })()
  \`);
  console.log('DENSE ' + JSON.stringify({ ...dense, dataUrl: undefined }, null, 2));
  // 把披风贴图 dump 成文件，肉眼核对 UV 布局
  if (dense.dataUrl) {
    const b64 = String(dense.dataUrl).split(',')[1] || '';
    fs.writeFileSync(path.join(SHOT_DIR, '_cape-texture.png'), Buffer.from(b64, 'base64'));
    console.log('SHOT docs/_cape-texture.png');
  }

  // ---------- ② 只改 flipY = false ----------
  await win.webContents.executeJavaScript(\`
    (() => {
      const v = window.__qclSkinViewer;
      if (!v.capeTexture) return 'no cape texture';
      v.capeTexture.flipY = false;
      v.capeTexture.needsUpdate = true;
      v._needsRender = true;
      return { flipY: v.capeTexture.flipY };
    })()
  \`);
  await setView(160);
  await shot('_cape-ab-3-back-flipy-false.png');
  await setView(-20);
  await shot('_cape-ab-4-front-flipy-false.png');

  // ---------- ③ 再补 premultiplyAlpha + 去掉 sRGB ----------
  await win.webContents.executeJavaScript(\`
    (() => {
      const v = window.__qclSkinViewer;
      v.capeTexture.premultiplyAlpha = true;
      v.capeTexture.colorSpace = '';
      v.capeTexture.needsUpdate = true;
      v._needsRender = true;
      return { premultiplyAlpha: v.capeTexture.premultiplyAlpha, colorSpace: v.capeTexture.colorSpace };
    })()
  \`);
  await setView(160);
  await shot('_cape-ab-5-back-fullfix.png');
  await setView(-20);
  await shot('_cape-ab-6-front-fullfix.png');
  await setView(90);
  await shot('_cape-ab-7-side-fullfix.png');

  // 最终状态回读（确认实验生效）
  const after = await win.webContents.executeJavaScript(\`
    (() => {
      const v = window.__qclSkinViewer;
      let cape = null; v.models.get(v.style).scene.traverse((o) => { if (o.isMesh && o.userData.isCape && !cape) cape = o; });
      return { flipY: v.capeTexture.flipY, premultiplyAlpha: v.capeTexture.premultiplyAlpha, colorSpace: v.capeTexture.colorSpace, 可见: cape.visible, uLightMix: cape.material.uniforms.uLightMix.value };
    })()
  \`);
  console.log('AFTER ' + JSON.stringify(after));

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-capeab');
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
