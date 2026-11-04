'use strict';
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const ROOT = "D:\\HMCL-PE重构QCL计划\\qcl-pc";

protocol.registerSchemesAsPrivileged([{ scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try { return await net.fetch(pathToFileURL(t).toString()); } catch { return new Response('404', { status: 404 }); }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: ROOT, homeOverride: path.join(ROOT, '.skin-test-home') });
  settings.load();
  require(path.join(ROOT, 'src', 'main', 'ipc.js')).initContext({ settings });
  require(path.join(ROOT, 'src', 'main', 'ipc.js')).registerIpc();

  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('超时')), 25000); win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await new Promise((r) => setTimeout(r, 15000));

  const info = await win.webContents.executeJavaScript(`
    (() => {
      const v = window.__qclSkinViewer;
      if (!v) return { err: 'no viewer' };
      const THREE = v.scene.constructor;
      const g = v.models.get(v.style);
      const out = {
        camera: { pos: v.camera.position.toArray().map(n=>+n.toFixed(2)), fov: v.camera.fov, aspect: +v.camera.aspect.toFixed(2) },
        pivotRot: [+(v.pivot.rotation.x*57.3).toFixed(1), +(v.pivot.rotation.y*57.3).toFixed(1)],
        rotationX: v.rotationX, rotationY: v.rotationY,
        modelHeight: v._modelHeight,
        rootPos: g ? g.scene.position.toArray().map(n=>+n.toFixed(3)) : null,
        meshes: [],
      };
      if (g) {
        g.scene.traverse((m) => {
          if (m.isMesh) out.meshes.push({
            name: m.name,
            visible: m.visible,
            side: m.material && m.material.side,
            pos: m.position.toArray().map(n=>+n.toFixed(2)),
          });
        });
      }
      // 头部网格的世界坐标包围盒
      const head = g ? g.scene.getObjectByName('Head_2') : null;
      if (head) {
        const b = new (window.__THREE_BOX3 || function(){ })();
        out.headPos = head.position.toArray().map(n=>+n.toFixed(3));
        out.headWorld = (() => {
          const p = head.getWorldPosition(new (head.position.constructor)());
          return p.toArray().map(n=>+n.toFixed(3));
        })();
      }
      return out;
    })()
  `);

  console.log('PROBE ' + JSON.stringify(info, null, 2));
  app.exit(0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); });
