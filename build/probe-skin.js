'use strict';
/**
 * QCL 电脑版 · 人物渲染运行时探针
 *
 * 直接用真实主进程窗口 + 真实 IPC，注入脚本检查 SkinViewer 的运行时状态：
 * 画布尺寸、pivot 子节点数、可见性、材质、贴图、渲染循环是否在跑。
 *
 * 用法：node build/probe-skin.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', '_probe-skin.txt');
const SHOT = path.join(ROOT, 'docs', '_probe-skin.png');

const inner = path.join(__dirname, '_probe-inner.js');
fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = ${JSON.stringify(ROOT)};
const OUT = ${JSON.stringify(OUT)};
const SHOT = ${JSON.stringify(SHOT)};
const lines = [];
const say = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const target = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(target).toString()); }
    catch { return new Response('404', { status: 404 }); }
  });

  const win = new BrowserWindow({
    width: 1600, height: 900, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) say('[渲染层]', msg); });

  // 真实 IPC（复制 ipc.js 的注册）
  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: ROOT, homeOverride: path.join(ROOT, '.probe-home') });
  settings.load();
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  const loaded = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('加载超时')), 20000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 12000));

  const diag = await win.webContents.executeJavaScript(\`
    (() => {
      const canvas = document.querySelector('#skin-canvas');
      if (!canvas) return { 找不到画布: true };
      const rect = canvas.getBoundingClientRect();
      const parent = canvas.parentElement;
      const prect = parent ? parent.getBoundingClientRect() : null;
      // 从画布反查 SkinViewer 实例（app 里挂在 window 上更方便，这里尽力找）
      const viewer = window.__skinViewer || window.__qclSkinViewer || null;
      let info = {
        画布CSS尺寸: { w: Math.round(rect.width), h: Math.round(rect.height) },
        画布像素尺寸: { w: canvas.width, h: canvas.height },
        父容器尺寸: prect ? { w: Math.round(prect.width), h: Math.round(prect.height) } : null,
        画布display: getComputedStyle(canvas).display,
        画布visibility: getComputedStyle(canvas).visibility,
        画布opacity: getComputedStyle(canvas).opacity,
        找到viewer: !!viewer,
      };
      if (viewer) {
        info.ready = viewer.ready;
        info.width = viewer.width;
        info.height = viewer.height;
        info._visible = viewer._visible;
        info.模型数 = viewer.models ? viewer.models.size : -1;
        info.模型键 = viewer.models ? [...viewer.models.keys()] : [];
        info.当前style = viewer.style;
        info.有贴图 = !!viewer.texture;
        info.pivot子节点 = viewer.pivot ? viewer.pivot.children.length : -1;
        if (viewer.pivot) {
          info.pivot子节点详情 = viewer.pivot.children.map((c) => ({
            名: c.name, 可见: c.visible, 子网格: c.children ? c.children.length : 0,
          }));
        }
        info.相机距离 = viewer.camera ? Math.round(viewer.camera.position.z) : -1;
        info.在渲染循环 = !!viewer.raf;
      }
      return info;
    })()
  \`).catch((e) => ({ 探针失败: String(e && e.message) }));

  say('===== 皮肤应用尝试 =====');
  const skinTry = await win.webContents.executeJavaScript(\`
    (async () => {
      const v = window.__qclSkinViewer;
      if (!v) return { 无viewer: true };
      const out = {};
      try {
        out.useDefaultSkin返回值 = await v.useDefaultSkin();
      } catch (e) {
        out.useDefaultSkin错误 = String(e && e.stack || e).slice(0, 1500);
      }
      out.ready_之后 = v.ready;
      out.有贴图_之后 = !!v.texture;
      out.有像素_之后 = !!v.pixels;
      const g = v.models && v.models.get(v.style);
      out.模型可见_之后 = g ? g.scene.visible : null;
      out.网格检查 = [];
      if (g) {
        g.scene.traverse((m) => {
          if (!m.isMesh) return;
          out.网格检查.push({
            名: m.name,
            可见: m.visible,
            有材质: !!m.material,
            材质类型: m.material ? m.material.type : null,
            uTexture有值: !!(m.material && m.material.uniforms && m.material.uniforms.uTexture && m.material.uniforms.uTexture.value),
          });
        });
      }
      // 再截一张纯 canvas 的像素统计，判断到底画出来没有
      const cv = document.querySelector('#skin-canvas');
      if (cv) {
        const gl = cv.getContext('webgl2') || cv.getContext('webgl');
        out.画布有GL上下文 = !!gl;
        if (gl) {
          const px = new Uint8Array(4 * 16);
          gl.readPixels(Math.floor(cv.width / 2) - 2, Math.floor(cv.height / 2) - 2, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let nonZero = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0) nonZero += 1;
          out.画布中心16像素中非全透明数 = nonZero;
        }
      }
      // 强推一次渲染，再看像素
      out.强制渲染诊断 = {};
      try {
        const cv2 = document.querySelector('#skin-canvas');
        const gl2 = cv2 && (cv2.getContext('webgl2') || cv2.getContext('webgl'));
        v.renderer.render(v.scene, v.camera);
        if (gl2) {
          const px2 = new Uint8Array(4 * 100);
          gl2.readPixels(Math.floor(cv2.width / 2) - 5, Math.floor(cv2.height / 2) - 5, 10, 10, gl2.RGBA, gl2.UNSIGNED_BYTE, px2);
          let nz = 0;
          for (let i = 0; i < px2.length; i += 4) if (px2[i + 3] > 8) nz += 1;
          out.强制渲染诊断.中心100像素非透明数 = nz;
          out.强制渲染诊断.样例像素 = Array.from(px2.slice(0, 8));
        }
      } catch (e) {
        out.强制渲染诊断.失败 = String(e && e.message);
      }
      out.相机 = {
        位置: v.camera.position.toArray().map((x) => Math.round(x * 100) / 100),
        fov: v.camera.fov,
        aspect: v.camera.aspect,
        near: v.camera.near,
        far: v.camera.far,
      };
      out.渲染器 = {
        缓冲区尺寸: [v.renderer.domElement.width, v.renderer.domElement.height],
        CSS尺寸: [v.renderer.domElement.style.width, v.renderer.domElement.style.height],
        pixelRatio: v.renderer.getPixelRatio(),
      };
      out.pivot旋转 = v.pivot ? [v.pivot.rotation.x, v.pivot.rotation.y] : null;
      out.scene子节点 = v.scene ? v.scene.children.map((c) => c.type + ':' + (c.name || '')) : null;
      out.帧计数 = v._frameCount || 0;
      out.距上次渲染毫秒 = v._lastFrameAt ? Date.now() - v._lastFrameAt : -1;
      out.visible值 = v._visible === undefined ? 'undefined' : v._visible;
      out.有无raf = !!v.raf;
      out.documentHidden = document.hidden;
      out.visibilityState = document.visibilityState;
      // 模型的世界包围盒（判断是不是被相机排除在视锥外）
      if (g && window.__THREE_BOX) { /* 略 */ }
      // 全画布采样：判断人物到底有没有出现在任何位置
      try {
        const cv3 = document.querySelector('#skin-canvas');
        const gl3 = cv3 && (cv3.getContext('webgl2') || cv3.getContext('webgl'));
        v.renderer.render(v.scene, v.camera);
        if (gl3) {
          const w = cv3.width, h = cv3.height;
          const px = new Uint8Array(4 * w * h);
          gl3.readPixels(0, 0, w, h, gl3.RGBA, gl3.UNSIGNED_BYTE, px);
          let nonZero = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              if (px[(y * w + x) * 4 + 3] > 16) {
                nonZero += 1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          out.全画布非透明像素数 = nonZero;
          out.全画布占比 = ((nonZero / (w * h)) * 100).toFixed(3) + '%';
          out.人物包围盒 = nonZero ? { 左: minX, 右: maxX, 下: minY, 上: maxY, 宽: maxX - minX, 高: maxY - minY } : null;
          out.画布实际尺寸 = { w, h };
        }
      } catch (e) {
        out.全画布采样失败 = String(e && e.message);
      }
      // 模型包围盒（判断有没有超出相机视锥）
      try {
        if (g) {
          const bb = new (v.scene.constructor.prototype.constructor === Object ? Object : window.Object)();
        }
      } catch (e) { /* 略 */ }

      /* ---- 覆盖物检测：画布中心点上到底压着谁 ---- */
      out.覆盖检测 = [];
      try {
        const cv4 = document.querySelector('#skin-canvas');
        const r4 = cv4.getBoundingClientRect();
        const pts = [
          ['中心', r4.x + r4.width / 2, r4.y + r4.height / 2],
          ['上部', r4.x + r4.width / 2, r4.y + r4.height * 0.25],
          ['下部', r4.x + r4.width / 2, r4.y + r4.height * 0.75],
        ];
        for (const [label, x, y] of pts) {
          const top = document.elementFromPoint(x, y);
          out.覆盖检测.push({
            点: label,
            命中元素: top ? (top.id || top.className || top.tagName) : null,
            是不是画布: top === cv4,
            命中透明度: top ? getComputedStyle(top).opacity : null,
            命中背景: top ? getComputedStyle(top).backgroundColor : null,
          });
        }
        out.画布层级 = {
          zIndex: getComputedStyle(cv4).zIndex,
          position: getComputedStyle(cv4).position,
          父元素类: cv4.parentElement ? cv4.parentElement.className : null,
          父元素过滤: cv4.parentElement ? getComputedStyle(cv4.parentElement).filter : null,
          父元素backdrop: cv4.parentElement ? getComputedStyle(cv4.parentElement).backdropFilter : null,
          父元素overflow: cv4.parentElement ? getComputedStyle(cv4.parentElement).overflow : null,
          父元素尺寸: cv4.parentElement
            ? ['w:' + Math.round(cv4.parentElement.getBoundingClientRect().width), 'h:' + Math.round(cv4.parentElement.getBoundingClientRect().height)]
            : null,
        };
        // 画布自身样式
        out.画布样式 = {
          宽高属性: [cv4.width, cv4.height],
          css宽高: [getComputedStyle(cv4).width, getComputedStyle(cv4).height],
          opacity: getComputedStyle(cv4).opacity,
          visibility: getComputedStyle(cv4).visibility,
          display: getComputedStyle(cv4).display,
          mixBlendMode: getComputedStyle(cv4).mixBlendMode,
          zIndex: getComputedStyle(cv4).zIndex,
        };
      } catch (e) {
        out.覆盖检测失败 = String(e && e.message);
      }
      return out;
    })()
  \`).catch((e) => ({ 调用失败: String(e && e.message) }));
  say(JSON.stringify(skinTry, null, 2));

  say('===== 人物渲染探针 =====');
  say(JSON.stringify(diag, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  say('[QCL] 截图 ' + SHOT);
  fs.writeFileSync(OUT, lines.join('\\n'), 'utf8');
  app.exit(0);
}).catch((e) => {
  say('FATAL', e && e.stack || e);
  fs.writeFileSync(OUT, lines.join('\\n'), 'utf8');
  app.exit(1);
});
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-probe');
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
