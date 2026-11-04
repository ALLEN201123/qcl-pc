'use strict';
/**
 * 启动 26.3 并抓取完整输出（不截断），定位退出码 -1 的原因。
 */

const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const launch = require(path.join(CORE, 'launch.js'));
const instances = require(path.join(CORE, 'instances.js'));

async function main() {
  const target = process.argv[2] || '26.3';
  const list = await instances.list(HOME);
  const inst = list.find((x) => x.mcVersion === target);
  if (!inst) {
    console.log(`没有 ${target}`);
    process.exit(1);
  }

  const lines = [];
  let exitInfo = null;
  const t0 = Date.now();

  const handle = await launch.launch({
    home: HOME,
    instance: inst,
    account: { uuid: '00000000000000000000000000000000', name: 'Player', type: 'offline' },
    settings: {
      javaPath: null,
      memory: { mode: 'manual', mb: 2048 },
      launch: { width: 1280, height: 720, fullscreen: false, extraJvmArgs: '', extraGameArgs: '' }
    },
    onLog: (l, s) => lines.push(`[${s || 'out'}] ${l}`),
    onExit: (c) => {
      exitInfo = c;
    }
  });

  console.log(`已启动 pid=${handle.pid}，等待…`);

  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exitInfo) break;
  }

  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(`\n结束于 ${sec}s，exit=${JSON.stringify(exitInfo)}`);
  console.log(`\n===== 完整日志（${lines.length} 行）=====\n`);
  for (const l of lines) console.log(l);

  if (!exitInfo) {
    try {
      handle.kill();
    } catch {
      /* 忽略 */
    }
  }
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
