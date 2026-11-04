'use strict';
/**
 * 诊断：26.x 为什么「明明启动了却报退出码 1」
 *
 * 假设：Minecraft 26.x 的启动器进程会 spawn 一个子 Java 进程（或自己重启），
 *       父进程很快退出（code 1），但游戏其实还在跑。
 *       launch.js 监听的是父进程的 'exit'，于是立刻报「退出码 1」。
 *
 * 验证方式：启动后每 3 秒统计系统里 java.exe 的数量，看父进程退出后游戏是否仍在。
 */

const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const launch = require(path.join(__dirname, '..', 'src', 'main', 'core', 'launch.js'));
const instances = require(path.join(__dirname, '..', 'src', 'main', 'core', 'instances.js'));

function javaProcessCount() {
  try {
    // tasklist 用 CSV 输出，统计 java.exe 行数
    const out = execSync('tasklist /FI "IMAGENAME eq java.exe" /FO CSV /NH', {
      encoding: 'utf8',
      windowsHide: true
    });
    return (out.match(/java\.exe/gi) || []).length;
  } catch {
    return -1;
  }
}

async function main() {
  const target = process.argv[2] || '26.3';
  const list = await instances.list(HOME);
  const inst = list.find((x) => x.mcVersion === target);
  if (!inst) {
    console.log(`没找到版本 ${target}，已装的有：${list.map((x) => x.mcVersion).join(', ')}`);
    process.exit(1);
  }

  console.log(`测试版本：${target}`);
  console.log(`空闲时 java 进程数：${javaProcessCount()}\n`);

  let exitInfo = null;
  let exitAt = null;
  const t0 = Date.now();

  const handle = await launch.launch({
    home: HOME,
    instance: inst,
    account: { uuid: '00000000000000000000000000000000', name: 'Player', type: 'offline' },
    settings: {
      javaPath: null,
      memory: { mode: 'manual', mb: 2048 },
      launch: { width: 854, height: 480, fullscreen: false, extraJvmArgs: '', extraGameArgs: '' }
    },
    onLog: () => {},
    onExit: (c) => {
      exitInfo = c;
      exitAt = Math.round((Date.now() - t0) / 1000);
      console.log(`\n★ onExit 触发于 ${exitAt}s：${JSON.stringify(c)}`);
    }
  });

  console.log(`已启动父进程 pid=${handle.pid}\n`);

  for (let i = 0; i < 14; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    const sec = Math.round((Date.now() - t0) / 1000);
    const jc = javaProcessCount();
    console.log(
      `  [${String(sec).padStart(2)}s] onExit=${exitInfo ? `有(code=${JSON.stringify(exitInfo.code)})` : '无'}` +
        `  系统 java 进程=${jc}`
    );
    // 如果父进程已退出且系统里也没 java 了，才算真结束
    if (exitInfo && jc === 0) {
      console.log('\n结论：父进程退出，系统里也没有 java 进程 → 游戏确实结束了');
      break;
    }
    if (exitInfo && jc > 0) {
      console.log('\n★★ 结论：父进程已退出，但系统里仍有 java 进程 → 游戏还在跑！');
      console.log('   ⇒ 「退出码 1」是父进程（启动包装器）的退出码，不是游戏崩溃');
      // 再多观察两轮确认
      if (i >= 6) break;
    }
  }

  try {
    handle.kill();
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`\n收尾后 java 进程数：${javaProcessCount()}`);
  console.log(`最终 exitInfo：${JSON.stringify(exitInfo)}`);
}

main().catch((e) => {
  console.error('诊断失败：', e.message);
  process.exit(1);
});
