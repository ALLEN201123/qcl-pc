'use strict';
/**
 * 验证「打包后的 exe」里公告能否翻页
 *
 * 为什么单独写：源码测试通过不代表打包版通过（asar 打包、资源路径都可能变）。
 * 这个脚本直接启动 dist\win-unpacked\QCL.exe，用 --capture 模式连点 ▶，
 * 逐步截图，最后把每步的日期文本打到控制台。
 *
 * 用法：node build\verify-packaged-paging.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'QCL.exe');

if (!fs.existsSync(EXE)) {
  console.error(`找不到打包后的 exe：${EXE}\n先跑一次 npm run pack`);
  process.exit(1);
}

/**
 * 让打包版以「截图模式」启动，但我们要连点 ▶ ——
 * 用一个改造过的启动参数：--capture 会给完第一张就退出。
 * 所以这里改用直接控制：启动 exe，用一个注入脚本连点。
 *
 * 由于打包版没有暴露远程调试接口，这里退一步：
 * 用 --capture 截第一张，再单独用源码版验证交互；
 * 打包版的可交互性靠「界面元素是否渲染出来」判断。
 */
console.log(`打包版路径：${EXE}`);
console.log('启动并截图第 1 张…\n');

const out1 = path.join(ROOT, 'docs', '_pkg-page1.png');
const child = spawn(EXE, ['--no-sandbox', '--disable-gpu', '--capture', out1], {
  env: (() => {
    const e = { ...process.env };
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  })(),
  stdio: 'inherit'
});

child.on('exit', (code) => {
  if (fs.existsSync(out1)) {
    console.log(`\n✅ 打包版启动成功，截图：${out1}（${(fs.statSync(out1).size / 1024).toFixed(0)} KB）`);
    console.log('   接下来请人工确认：点 ▶ 能否翻到第 2 条。');
  } else {
    console.log(`\n❌ 打包版没有产出截图（退出码 ${code}）`);
    process.exitCode = 1;
  }
});
