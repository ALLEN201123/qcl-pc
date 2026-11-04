'use strict';
/**
 * 披风渲染诊断（运行时真实数据，不猜）
 *
 * 量什么：
 *   ① Cape_2 网格的局部包围盒 / 世界包围盒，和身体（Body / Head 等）的世界包围盒对照
 *   ② _prepareModel 里的包围盒居中到底有没有把披风算进去（visibility 是否影响 Box3）
 *   ③ 披风贴图对象的 flipY / premultiplyAlpha / colorSpace / 尺寸
 *   ④ ★ 关键：按每个三角形的 UV 采样披风 PNG 的 alpha，
 *      分别在 flipY=false（正确）与 flipY=true（当前实现）两种情况下统计「会被 shader discard 的三角形比例」
 *      —— 这能直接证明「只显示一丁点」是不是贴图上下翻转导致整片被 discard
 *
 * 用法：node build/diag-cape-runtime.js
 * 输出：控制台 JSON + docs/_cape-diag.png
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const SHOT_DIR = path.join(ROOT, 'docs');
const inner = path.join(__dirname, '_cape-diag-inner.js');

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
  // 等 3D 人物 + 皮肤 + 披风全部就位（首帧 + 网络代理 + 贴图）
  await new Promise((r) => setTimeout(r, 20000));

  const report = await win.webContents.executeJavaScript(\`
    (async () => {
      const out = {};
      const v = window.__qclSkinViewer;
      if (!v) return { err: 'no viewer' };

      // ---------- 找披风网格与身体网格 ----------
      const gltf = v.models.get(v.style);
      if (!gltf) return { err: 'no model' };
      const root = gltf.scene;
      let capeMesh = null;
      const bodyMeshes = [];
      root.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData && o.userData.isCape) { if (!capeMesh) capeMesh = o; }
        else bodyMeshes.push(o);
      });
      out.层级 = [];
      (function walk(o, d) {
        if (d > 5) return;
        out.层级.push('  '.repeat(d) + o.name + (o.isMesh ? ' [mesh vis=' + o.visible + ']' : ' [node]'));
        for (const c of o.children) walk(c, d + 1);
      })(root, 0);

      // ---------- 手工算包围盒（不依赖 THREE 全局） ----------
      function geomWorldBox(mesh) {
        mesh.updateWorldMatrix(true, true);
        const pos = mesh.geometry.getAttribute('position');
        const e = mesh.matrixWorld.elements;
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.count; i += 1) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          if (wx < mn[0]) mn[0] = wx; if (wx > mx[0]) mx[0] = wx;
          if (wy < mn[1]) mn[1] = wy; if (wy > mx[1]) mx[1] = wy;
          if (wz < mn[2]) mn[2] = wz; if (wz > mx[2]) mx[2] = wz;
        }
        return { min: mn, max: mx, size: [mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]] };
      }
      const r3 = (a) => a.map((x) => Math.round(x * 10000) / 10000);

      if (capeMesh) {
        const g = capeMesh.geometry;
        g.computeBoundingBox();
        out.披风 = {
          网格名: capeMesh.name,
          可见: capeMesh.visible,
          父节点: capeMesh.parent && capeMesh.parent.name,
          局部包围盒: { min: r3([g.boundingBox.min.x, g.boundingBox.min.y, g.boundingBox.min.z]), max: r3([g.boundingBox.max.x, g.boundingBox.max.y, g.boundingBox.max.z]) },
          世界包围盒: (() => { const b = geomWorldBox(capeMesh); return { min: r3(b.min), max: r3(b.max), size: r3(b.size) }; })(),
          世界矩阵平移: r3([capeMesh.matrixWorld.elements[12], capeMesh.matrixWorld.elements[13], capeMesh.matrixWorld.elements[14]]),
          顶点数: g.getAttribute('position').count,
          有索引: !!g.index,
          材质uniform有贴图: !!(capeMesh.material && capeMesh.material.uniforms && capeMesh.material.uniforms.uTexture && capeMesh.material.uniforms.uTexture.value),
          渲染order: capeMesh.renderOrder,
          面朝向: capeMesh.material && capeMesh.material.side,
        };
        // UV 极值
        const uv = g.getAttribute('uv');
        let u0=Infinity,u1=-Infinity,v0=Infinity,v1=-Infinity;
        for (let i=0;i<uv.count;i++){ const a=uv.getX(i), b=uv.getY(i); if(a<u0)u0=a; if(a>u1)u1=a; if(b<v0)v0=b; if(b>v1)v1=b; }
        out.披风UV = { u: r3([u0, u1]), v: r3([v0, v1]) };
      }

      // 身体世界包围盒（不含披风）
      const boxAll = (meshes) => {
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const m of meshes) {
          const b = geomWorldBox(m);
          if (!isFinite(b.min[0])) continue;
          for (let k = 0; k < 3; k++) { if (b.min[k] < mn[k]) mn[k] = b.min[k]; if (b.max[k] > mx[k]) mx[k] = b.max[k]; }
        }
        return { min: mn, max: mx, size: [mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]] };
      };
      const bb = boxAll(bodyMeshes);
      out.身体世界包围盒 = { min: r3(bb.min), max: r3(bb.max), size: r3(bb.size) };

      // ---------- _prepareModel 的居中是否包含披风 ----------
      out.归零 = {
        root_position: r3([root.position.x, root.position.y, root.position.z]),
        gltf_userData_size: gltf.userData && gltf.userData.size ? r3([gltf.userData.size.x, gltf.userData.size.y, gltf.userData.size.z]) : null,
        modelHeight: v._modelHeight,
        身体中心: r3([(bb.min[0]+bb.max[0])/2, (bb.min[1]+bb.max[1])/2, (bb.min[2]+bb.max[2])/2]),
        含披风中心: (() => {
          const withCape = boxAll(bodyMeshes.concat(capeMesh ? [capeMesh] : []));
          return r3([(withCape.min[0]+withCape.max[0])/2, (withCape.min[1]+withCape.max[1])/2, (withCape.min[2]+withCape.max[2])/2]);
        })(),
      };

      // ---------- 披风贴图对象属性 ----------
      const tex = v.capeTexture;
      out.贴图 = tex ? {
        flipY: tex.flipY,
        premultiplyAlpha: tex.premultiplyAlpha,
        colorSpace: tex.colorSpace,
        图片尺寸: (tex.image ? (tex.image.width + 'x' + tex.image.height) : '?'),
        magFilter: tex.magFilter,
        minFilter: tex.minFilter,
        generateMipmaps: tex.generateMipmaps,
      } : null;
      const skinTex = v.texture;
      out.皮肤贴图对照 = skinTex ? {
        flipY: skinTex.flipY,
        premultiplyAlpha: skinTex.premultiplyAlpha,
        colorSpace: skinTex.colorSpace,
      } : null;

      // ---------- ★ 用真实 cape PNG 的 alpha 预测有多少三角形会被 discard ----------
      const acctList = await window.qcl.invoke('accounts:list', {});
      const acct = (acctList || []).find((a) => a.capeUrl) || null;
      out.披风地址 = acct && acct.capeUrl;
      if (acct && acct.capeUrl && capeMesh) {
        const rr = await window.qcl.invoke('skin:readRemote', { url: acct.capeUrl });
        const dataUrl = rr && rr.dataUrl;
        if (dataUrl) {
          const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
          const W = img.naturalWidth, H = img.naturalHeight;
          const cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          const cx = cv.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0);
          const px = cx.getImageData(0, 0, W, H).data;
          const alphaAt = (u, vv) => {
            let x = Math.floor(u * W), y = Math.floor(vv * H);
            if (x < 0) x = 0; if (y < 0) y = 0;
            if (x >= W) x = W - 1; if (y >= H) y = H - 1;
            return px[(y * W + x) * 4 + 3];
          };
          // 透明度分布（上下两半各多少不透明像素）
          let topOpaque = 0, botOpaque = 0, total = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const a = px[(y * W + x) * 4 + 3];
            if (a < 26) continue;
            total++;
            if (y < H / 2) topOpaque++; else botOpaque++;
          }

          // 逐三角形采样（与 shader 的 discard 阈值 0.1 对齐）
          const g = capeMesh.geometry;
          const uv = g.getAttribute('uv');
          const idx = g.index;
          const triCount = (idx ? idx.count : uv.count) / 3;
          let discardedFlipFalse = 0, discardedFlipTrue = 0;
          const sample = (i, flip) => {
            const u = uv.getX(i), vv = uv.getY(i);
            return alphaAt(u, flip ? 1 - vv : vv) / 255;
          };
          for (let t = 0; t < triCount; t++) {
            const i0 = idx ? idx.getX(t * 3) : t * 3;
            const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
            // shader 逐像素判定，一个三角形只要有一个像素不透明就会画出来；
            // 这里用「三顶点 + 5 个内部重心采样」近似覆盖率
            let anyF = false, anyT = false;
            const bary = [[1,0,0],[0,1,0],[0,0,1],[0.5,0.5,0],[0.5,0,0.5],[0,0.5,0.5],[1/3,1/3,1/3]];
            for (const [a,b,c] of bary) {
              const u = uv.getX(i0)*a + uv.getX(i1)*b + uv.getX(i2)*c;
              const vq = uv.getY(i0)*a + uv.getY(i1)*b + uv.getY(i2)*c;
              if (alphaAt(u, vq) >= 26) anyF = true;
              if (alphaAt(u, 1 - vq) >= 26) anyT = true;
            }
            if (!anyF) discardedFlipFalse++;
            if (!anyT) discardedFlipTrue++;
          }
          out.贴图alpha分析 = {
            图片尺寸: W + 'x' + H,
            不透明像素: total,
            上半不透明: topOpaque,
            下半不透明: botOpaque,
            三角形总数: triCount,
            正确不翻转会被丢弃的三角形: discardedFlipFalse,
            当前flipY_true会被丢弃的三角形: discardedFlipTrue,
            当前实际能画出的三角形比例: Math.round((1 - discardedFlipTrue / triCount) * 1000) / 10 + '%',
            修正后能画出的三角形比例: Math.round((1 - discardedFlipFalse / triCount) * 1000) / 10 + '%',
          };
          out.贴图示例 = 'data:image/png;base64,...(' + String(dataUrl.length) + ' 字节)';
        }
      }

      // ---------- 渲染帧状态 ----------
      out.渲染 = { 帧数: v._frameCount || 0, 最后帧时间: v._lastFrameAt || null, ready: v.ready, 相机距离: Math.round(v.camera.position.z * 100) / 100 };
      return out;
    })()
  \`);
  console.log('CAPE_DIAG ' + JSON.stringify(report, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOT_DIR, '_cape-diag.png'), img.toPNG());
  console.log('SHOT docs/_cape-diag.png');

  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-capediag');
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
