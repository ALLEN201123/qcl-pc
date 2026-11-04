'use strict';
/**
 * QCL 人物渲染 · 终极取证
 *
 * 目的：把「画布里的像素」和「窗口上看到的像素」分开取证，定位人物到底丢在哪一步。
 *   1. 用 canvas.toDataURL() 直接导出画布内容（不经过窗口合成）→ docs/_canvas-raw.png
 *   2. 用 capturePage 截窗口 → docs/_window.png
 *   3. 再用 capturePage 精确截画布所在矩形 → docs/_canvas-region.png
 *   三者对比即可判断：是 WebGL 没画出来 / 是合成丢了 / 是 CSS 挡住了。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const inner = path.join(__dirname, '_forensic-inner.js');

fs.writeFileSync(
  inner,
  `'use strict';
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = ${JSON.stringify(ROOT)};
const DOCS = ${JSON.stringify(DOCS)};
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
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404', { status: 404 }); }
  });

  // 真实 IPC
  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: ROOT, homeOverride: path.join(ROOT, '.probe-home') });
  settings.load();
  require(path.join(ROOT, 'src', 'main', 'ipc.js')).initContext({ settings });
  require(path.join(ROOT, 'src', 'main', 'ipc.js')).registerIpc();

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(60);

  const loaded = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('加载超时')), 20000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 15000));

  /* ---- 1. 画布原始内容（toDataURL，绕过合成）---- */
  const raw = await win.webContents.executeJavaScript(\`
    (() => {
      const v = window.__qclSkinViewer;
      if (!v) return { 错误: '没有 viewer' };
      v.pivot.rotation.x = (v.rotationX * Math.PI) / 180;
      v.pivot.rotation.y = (v.rotationY * Math.PI) / 180;
      v.renderer.render(v.scene, v.camera);
      const c = document.querySelector('#skin-canvas');
      const url = c.toDataURL('image/png');
      return {
        dataUrl长度: url.length,
        dataUrl前40: url.slice(0, 40),
        画布尺寸: [c.width, c.height],
        css尺寸: [c.clientWidth, c.clientHeight],
        viewer就绪: v.ready,
        帧计数: v._frameCount,
      };
    })()
  \`).catch((e) => ({ 执行失败: String(e && e.message) }));
  say('画布原始: ' + JSON.stringify(raw));

  if (raw && raw.dataUrl前40 && raw.dataUrl前40.startsWith('data:image/png')) {
    const full = await win.webContents.executeJavaScript(
      "document.querySelector('#skin-canvas').toDataURL('image/png')"
    );
    const b64 = String(full).split(',')[1];
    fs.writeFileSync(path.join(DOCS, '_canvas-raw.png'), Buffer.from(b64, 'base64'));
    say('[QCL] 画布原始内容 -> docs/_canvas-raw.png');
  }

  /* ---- 2. 窗口截图 ---- */
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(DOCS, '_window.png'), shot.toPNG());
  say('[QCL] 窗口截图 -> docs/_window.png');

  /* ---- 3. 只截画布区域 ---- */
  const rect = await win.webContents.executeJavaScript(\`
    (() => {
      const c = document.querySelector('#skin-canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    })()
  \`);
  say('画布区域: ' + JSON.stringify(rect));
  if (rect && rect.width > 20 && rect.height > 20) {
    const region = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(DOCS, '_canvas-region.png'), region.toPNG());
    say('[QCL] 画布区域截图 -> docs/_canvas-region.png');
  }

  /* ---- 4. 画布祖父链的合成状态 ---- */
  const chain = await win.webContents.executeJavaScript(\`
    (() => {
      const c = document.querySelector('#skin-canvas');
      const out = [];
      let el = c;
      for (let i = 0; i < 6 && el; i += 1) {
        const s = getComputedStyle(el);
        out.push({
          层级: i, 标签: el.tagName, id: el.id || '', 类: el.className || '',
          opacity: s.opacity, transform: s.transform, filter: s.filter,
          overflow: s.overflow, position: s.position, zIndex: s.zIndex,
          尺寸: [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)],
        });
        el = el.parentElement;
      }
      return out;
    })()
  \`);
  say('DOM 链: ' + JSON.stringify(chain, null, 2));

  fs.writeFileSync(path.join(DOCS, '_forensic.txt'), lines.join('\\n'), 'utf8');
  app.exit(0);
}).catch((e) => {
  say('FATAL', e && e.stack || e);
  fs.writeFileSync(path.join(DOCS, '_forensic.txt'), lines.join('\\n'), 'utf8');
  app.exit(1);
});
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-forensic');
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
