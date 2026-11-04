'use strict';
/**
 * QCL 电脑版 · 开发期启动器（node build/run.js）
 *
 * 为什么需要它：
 *   DSH 宿主本身是 Electron 应用，会给子进程设 `ELECTRON_RUN_AS_NODE=1`。
 *   被继承之后，我们启动的 electron.exe 会以**纯 Node 模式**运行 —— 不加载 Electron 运行时，
 *   于是 `require('electron').protocol` 是 undefined，主进程第一行就崩：
 *     TypeError: Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')
 *   或者表现为静默的 0xC0000005 访问违例。
 *   ⇒ 启动前必须把这个变量摘掉。
 *
 * 用法：
 *   node build/run.js                # 普通启动
 *   node build/run.js --dev          # 开发模式（开 DevTools）
 *   node build/run.js --shots        # 顺便跑截图脚本（如果存在）
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronBin = require('electron'); // 这个包导出的就是 electron.exe 的绝对路径

const args = process.argv.slice(2);

/** 去掉所有会让 Electron 降级成 Node 的变量 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.NODE_OPTIONS;

const passthrough = ['--no-sandbox', '--disable-gpu'];
// user-data-dir 单独放到工程内，避免默认 userData 在受限环境下起不来
const userData = path.join(ROOT, '.cache', 'userdata');
fs.mkdirSync(userData, { recursive: true });
passthrough.push(`--user-data-dir=${userData}`);

const child = spawn(electronBin, [ROOT, ...passthrough, ...args], {
  env,
  stdio: 'inherit',
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (signal) console.log(`[QCL] electron 被信号中断：${signal}`);
  else console.log(`[QCL] electron 退出，code=${code}`);
  process.exitCode = code ?? 0;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill());
}
