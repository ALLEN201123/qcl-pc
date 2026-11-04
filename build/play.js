'use strict';
/**
 * QCL 电脑版 · 手动启动一个已装版本（给你自己看的那种）
 *
 * 和 e2e.js 不同的是：**它不会自动杀掉游戏进程**，游戏窗口会一直留着，
 * 你自己玩、自己关。用来确认「启动器真的能把游戏跑起来」。
 *
 * 用法：
 *   node build\play.js pc-132011     # 玩远古 pre-classic（RubyDung）
 *   node build\play.js c0.0.13a      # 玩远古 classic
 *   node build\play.js b1.7.3        # 玩 beta
 *   node build\play.js               # 列出已装版本
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = process.env.QCL_PLAY_HOME || path.join(ROOT, '.e2e-home');
const CORE = path.join(ROOT, 'src', 'main', 'core');

const load = (n) => require(path.join(CORE, `${n}.js`));

async function main() {
  const want = process.argv[2];
  const instances = load('instances');
  const list = await instances.list(HOME);

  if (!want) {
    console.log(`QCL 主目录：${HOME}`);
    console.log('已装实例：');
    for (const i of list) console.log(`   ${i.mcVersion.padEnd(16)} ${i.name}   ${i.dir}`);
    console.log('\n用法：node build\\play.js <版本号>');
    return;
  }

  const inst = list.find((i) => i.mcVersion === want || i.name === want);
  if (!inst) {
    console.log(`没找到版本 ${want}，已装的有：${list.map((i) => i.mcVersion).join(', ') || '(无)'}`);
    process.exitCode = 1;
    return;
  }

  const launch = load('launch');
  const java = load('java');
  const javaList = await java.detect();

  console.log(`启动 ${inst.mcVersion}（${inst.name}）`);
  console.log(`目录 ${inst.dir}`);
  console.log('提示：游戏窗口会一直留着，玩完自己关。Ctrl+C 也能结束。\n');

  const handle = await launch.launch({
    home: HOME,
    instance: inst,
    account: { uuid: 'a01e3843e5213998958af459800e4d11', name: 'Player', type: 'offline' },
    settings: {
      javaPath: null,
      memory: { mode: 'manual', mb: 2048 },
      launch: { width: 1280, height: 720, fullscreen: false, extraJvmArgs: '', extraGameArgs: '' }
    },
    onLog: (line, stream) => {
      const s = String(line);
      // 只显示有意义的行，避免刷屏
      if (/Exception|Error|错误|严重|Minecraft|RubyDung|LWJGL|OpenAL|Setting user|Loading/i.test(s)) {
        console.log(`[${stream === 'stderr' ? 'err' : 'out'}] ${s.slice(0, 200)}`);
      }
    },
    onExit: (code) => {
      console.log(`\n游戏已退出（code=${typeof code === 'object' ? JSON.stringify(code) : code}）`);
      process.exit(0);
    }
  });

  console.log(`已启动，PID = ${handle.pid}  Java = ${handle.javaVersion}  内存 = ${handle.memoryMb}MB`);
  console.log('（窗口应该马上就出来了；如果没有，看上面有没有报错）\n');
}

main().catch((e) => {
  console.error('启动失败：', e && e.message ? e.message : e);
  process.exitCode = 2;
});
