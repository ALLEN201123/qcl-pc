'use strict';
/**
 * 验收：启动窗口的「阶段耗时」
 *   ① 每个阶段都能推进（曾经因为 stageDoneAt 没声明，第二个 markStage 就抛 ReferenceError，
 *      界面永远停在「解析版本信息」—— 用户截图就是这个）
 *   ② 每个阶段显示的是**本阶段自己的耗时**，不是「从启动到现在的总耗时」（全是 5.6s 那个 bug）
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const OUT = path.join(ROOT, '.cache', 'launchwindow-result.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
  { scheme: 'qcl', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const RENDERER = path.join(ROOT, 'src', 'renderer');
  protocol.handle('qcl', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'index.html';
    const t = path.normalize(path.join(RENDERER, rel));
    try {
      return await net.fetch(pathToFileURL(t).toString());
    } catch {
      return new Response('404');
    }
  });

  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const settings = new Settings({ documentsDir: path.dirname(HOME), homeOverride: HOME });
  settings.load();
  const ipcMod = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
  ipcMod.initContext({ settings });
  ipcMod.registerIpc();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  const loaded = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('页面加载超时')), 60000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t);
      res();
    });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await sleep(13000);

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const result = { ok: false, checks: [] };
  const push = (name, pass, info) => result.checks.push({ name, pass, info });

  try {
    // 真调 launchwindow 模块：开窗 → 逐个推进 7 个阶段 → 收尾
    const rows = await js(`(async () => {
      const m = await import('qcl://app/js/launchwindow.js');
      m.openLaunchWindow({ instance: { name: '测试实例', mcVersion: '1.20.1' } });
      const seq = ['check', 'java', 'classpath', 'account', 'spawn', 'running'];
      const waits = [260, 420, 180, 320, 140, 200];
      for (let i = 0; i < seq.length; i++) {
        m.markStage(seq[i], '阶段 ' + seq[i]);
        await new Promise((r) => setTimeout(r, waits[i]));
      }
      const mid = Array.from(document.querySelectorAll('.lw__stage')).map((li) => ({
        label: (li.querySelector('.lw__label') || {}).textContent || '',
        state: (li.className.match(/lw__stage--(\\w+)/) || [])[1] || '',
        time: (li.querySelector('.lw__time') || {}).textContent || '',
      }));
      m.finishLaunch(true);
      const done = Array.from(document.querySelectorAll('.lw__stage')).map((li) => ({
        label: (li.querySelector('.lw__label') || {}).textContent || '',
        state: (li.className.match(/lw__stage--(\\w+)/) || [])[1] || '',
        time: (li.querySelector('.lw__time') || {}).textContent || '',
      }));
      return { mid, done };
    })()`);

    const mid = (rows && rows.mid) || [];
    const done = (rows && rows.done) || [];
    push('① 7 个阶段全部渲染出来', mid.length === 7, mid.map((r) => r.label));
    push(
      '② 阶段能一路推进（最后一个 running 是 active）',
      mid.length === 7 && mid[6].state === 'active' && mid.slice(0, 6).every((r) => r.state === 'done'),
      mid.map((r) => `${r.label}:${r.state}`)
    );
    const times = mid.slice(0, 6).map((r) => r.time).filter((t) => /s$/.test(t));
    push('③ 前 6 个阶段都显示了耗时', times.length === 6, times);
    const uniq = new Set(times);
    push('④ 各阶段耗时不再全一样（以前的 5.6s bug）', uniq.size >= 3, { times, 不同取值: uniq.size });
    push(
      '⑤ 收尾时 7 个阶段全 done',
      done.length === 7 && done.every((r) => r.state === 'done'),
      done.map((r) => `${r.label}:${r.state}`)
    );
    push('⑥ 收尾后每行也都有耗时', done.every((r) => /s$/.test(r.time)), done.map((r) => r.time));
    result.rows = { mid, done };
    result.ok = result.checks.every((c) => c.pass);
  } catch (e) {
    result.error = (e && e.stack) || String(e);
  }

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  console.log('RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks, error: result.error || null }, null, 2));
  app.exit(0);
}).catch((e) => {
  console.log('FATAL ' + ((e && e.stack) || e));
  app.exit(1);
});
