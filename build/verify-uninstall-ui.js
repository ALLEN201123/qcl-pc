'use strict';
/**
 * 卸载器真机验证：真的用 --uninstall 起一个 Electron 进程，
 * 检查窗口出现了、三项都在、游戏数据默认是「保留」。
 *
 * ★ 关键点：**绝不能真的点卸载**。
 *   这里只做「打开 + 读 DOM」，最后直接杀进程，
 *   否则会真删掉本机的程序目录与数据（本机 1.46 GB 游戏数据）。
 *
 * 窗口 show:false —— 不闪用户的脸。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'uninst-result.json');

const inner = path.join(__dirname, '_uninst-inner.js');
const innerSrc = `'use strict';
/**
 * 在 Electron 里跑「卸载器」的等价流程，但把 perform 换成空操作，
 * 这样既能验证界面与 IPC，又不会真删任何东西。
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = ${JSON.stringify(ROOT)};
const OUT = ${JSON.stringify(OUT)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 屏蔽真实删除与对话框
const un = require(path.join(ROOT, 'src', 'main', 'uninstall.js'));
const realPerform = un.perform;
un.perform = async () => ({
  removed: ['（测试中，未真实删除）'],
  kept: [],
  errors: [],
  shell: null,
  needManual: [],
});

app.whenReady().then(async () => {
  const checks = [];
  const P = (n, p, i) => checks.push({ n, p, i });

  const survey = un.survey();
  P('survey 有 3 项', survey.items.length === 3, survey.items.map((x) => x.key));
  const dataItem = survey.items.find((x) => x.key === 'data');
  P('游戏数据默认保留', !!dataItem && dataItem.keepDefault === true);

  // 复刻 index.js 里那段 HTML（取同一份源码里的模板，避免两边漂移）
  // ★ 这里不用正则字面量直接包反引号（会和本文件自己的模板字符串打架），
  //   改成按标记字符串与结尾反引号的位置切片。
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  const marker = 'const html = ' + String.fromCharCode(96);
  const startIdx = indexSrc.indexOf(marker);
  const endMarker = String.fromCharCode(96) + ';';
  const endIdx = startIdx >= 0 ? indexSrc.indexOf(endMarker, startIdx + marker.length) : -1;
  const tpl = startIdx >= 0 && endIdx > startIdx ? indexSrc.slice(startIdx + marker.length, endIdx) : '';
  if (!tpl) {
    P('能从 index.js 提取卸载界面模板', false);
    fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2), 'utf8');
    app.exit(1);
    return;
  }
  P('能从 index.js 提取卸载界面模板', true, tpl.length + ' 字节');

  const itemsJson = JSON.stringify(survey.items);
  const dirsJson = JSON.stringify({
    installDir: survey.installDir,
    dataDir: survey.dataDir,
    cacheDir: survey.cacheDir,
  });
  const html = tpl
    .split('$' + '{itemsJson}').join(itemsJson)
    .split('$' + '{dirsJson}').join(dirsJson);

  const win = new BrowserWindow({
    width: 660, height: 560, show: false, resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(ROOT, 'src', 'main', 'uninstall-preload.js'),
    },
  });

  const CH = 'qcl-uninstall';
  ipcMain.handle(CH + ':run', async () => {
    return { removed: [], kept: [], errors: [], shell: null, needManual: [] };
  });
  ipcMain.handle(CH + ':cancel', async () => true);

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await sleep(1200);

  const js = (c) => win.webContents.executeJavaScript(c, true);

  const title = await js('document.querySelector("h1").textContent');
  P('标题正确', /卸载/.test(title), title);

  const itemCount = await js('document.querySelectorAll(".item").length');
  P('列出 3 个可勾选项', itemCount === 3, itemCount);

  const names = await js('Array.from(document.querySelectorAll(".item .name")).map(function(e){return e.childNodes[0].textContent.trim()})');
  P('三项名称正确', names.join(',') === '程序文件,游戏数据,本地缓存', names);

  const boxes = await js('Array.from(document.querySelectorAll(".item input")).map(function(e){return {key:e.getAttribute("data-key"),checked:e.checked,disabled:e.disabled}})');
  const byKey = {};
  boxes.forEach((b) => { byKey[b.key] = b; });
  P('★ 程序文件默认勾选且不可取消', byKey.program && byKey.program.checked === true && byKey.program.disabled === true, byKey.program);
  P('★ 游戏数据默认【不】勾选（即保留）', byKey.data && byKey.data.checked === false, byKey.data);
  P('游戏数据可以被勾选', byKey.data && byKey.data.disabled === false, byKey.data);
  P('缓存默认勾选', byKey.cache && byKey.cache.checked === true, byKey.cache);

  const tags = await js('Array.from(document.querySelectorAll(".item .keep-tag,.item .must-tag")).map(function(e){return e.textContent.trim()})');
  P('有「默认保留」标签', tags.includes('默认保留'), tags);
  P('有「必删」标签', tags.includes('必删'), tags);

  const paths = await js('Array.from(document.querySelectorAll(".item .path")).map(function(e){return e.textContent})');
  P('三项都显示了完整路径', paths.length === 3 && paths.every((p) => p.length > 3), paths.map((p) => p.slice(0, 30)));

  // 勾上「游戏数据」→ 应出现警告
  await js('(function(){var el=document.querySelector("input[data-key=data]"); el.checked=true; el.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await sleep(500);
  const warnShown = await js('(function(){var w=document.getElementById("warn");return {display:getComputedStyle(w).display, text:w.textContent.slice(0,40)}})()');
  P('★ 勾选删数据后出现警告', warnShown.display !== 'none', warnShown);

  // 取消勾选 → 警告消失
  await js('(function(){var el=document.querySelector("input[data-key=data]"); el.checked=false; el.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await sleep(400);
  const warnHidden = await js('document.getElementById("warn").style.display');
  P('取消勾选后警告消失', warnHidden === 'none', warnHidden);

  const btns = await js('Array.from(document.querySelectorAll("button")).map(function(b){return b.textContent.trim()})');
  P('有取消与卸载按钮', btns.includes('取消') && btns.includes('卸载'), btns);

  const hasApi = await js('typeof window.qclUninstall === "object" && typeof window.qclUninstall.run === "function"');
  P('preload 暴露了 qclUninstall.run', hasApi === true);

  un.perform = realPerform;
  fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2), 'utf8');
  app.exit(0);
}).catch((e) => {
  console.log('FATAL ' + ((e && e.stack) || e));
  app.exit(1);
});
`;
fs.writeFileSync(inner, innerSrc, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const ud = path.join(ROOT, '.cache', 'ud-uninst');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(ud, { recursive: true });
const child = spawn(require('electron'), [inner, '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`], { env, stdio: 'ignore' });
child.on('exit', () => {
  try { fs.unlinkSync(inner); } catch { /* ignore */ }
  let res = null;
  try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* ignore */ }
  console.log('================ RESULT ================');
  if (!res) { console.log('no result'); process.exitCode = 1; return; }
  let fail = 0;
  for (const c of res.checks || []) {
    if (!c.p) fail += 1;
    console.log(`${c.p ? 'PASS' : 'FAIL'}  ${c.n}${c.i !== undefined ? '  -> ' + JSON.stringify(c.i) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`total ${(res.checks || []).length}, failed ${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
});
