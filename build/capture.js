'use strict';
/**
 * QCL 电脑版 · 自动截图验证（Lead 用）
 *
 * 用途：起一个真实的 Electron 窗口 → 加载 qcl://app/index.html → 截图 → 退出。
 * 全程自动，不会留下后台实例（内存紧张时很重要）。
 *
 * 用法：
 *   node build/capture.js                      # 截主界面
 *   node build/capture.js home setting log     # 截多个页面（按左侧导航 id）
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const pages = process.argv.slice(2);
if (pages.length === 0) pages.push('home');

const captureScript = path.join(__dirname, '_capture-inner.js');
fs.writeFileSync(
  captureScript,
  `'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = ${JSON.stringify(ROOT)};
const PAGES = ${JSON.stringify(pages)};
const OUT_DIR = ${JSON.stringify(OUT_DIR)};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
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

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    errors.push('加载失败 ' + code + ' ' + desc + ' ' + url);
  });

  // ★ 必须先挂监听再 loadURL：loadURL 之后才挂会错过 did-finish-load，
  //   整个脚本就永远卡在 await 上（之前正是这么挂住的）。
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('页面加载超时（15 秒内没有 did-finish-load）')), 15000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  win.loadURL('qcl://app/index.html');
  await loaded;
  await wait(3000);

  for (const page of PAGES) {
    if (page !== 'home') {
      try {
        await win.webContents.executeJavaScript(
          "window.__qclTest && window.__qclTest.go ? window.__qclTest.go(" + JSON.stringify(page) + ") : " +
          "(document.querySelector('[data-route=\\"" + page + "\\"]') || document.querySelector('#nav-" + page + "') || {click(){}}).click()"
        );
        await wait(1800);
      } catch (err) {
        errors.push('切页失败 ' + page + '：' + err.message);
      }
    }
    const img = await win.webContents.capturePage();
    const out = path.join(OUT_DIR, '_lead-' + page + '.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('CAPTURED ' + page + ' -> ' + out + ' ' + JSON.stringify(img.getSize()));
  }

  if (errors.length) {
    console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 20), null, 2));
  } else {
    console.log('CONSOLE_ERRORS 无');
  }
  app.quit();
}).catch((err) => {
  console.log('CAPTURE_FATAL ' + (err && err.stack ? err.stack : err));
  app.exit(1);
});
`,
  'utf8'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const electronBin = require('electron');
const userData = path.join(ROOT, '.cache', 'userdata-capture');
fs.mkdirSync(userData, { recursive: true });

const child = spawn(electronBin, [captureScript, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], {
  env,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  try {
    fs.unlinkSync(captureScript);
  } catch {
    /* 清理失败无所谓 */
  }
  process.exitCode = code ?? 0;
});
