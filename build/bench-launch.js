'use strict';
/**
 * 测「点击启动游戏 → Java 进程真正出现」的耗时分布。
 *
 * 用户反馈：「点击启动游戏，窗口不会同时出现」。
 * 需要量清楚：是 precheck 慢、是 launch.launch() 内部慢、还是 Java 启动本身慢。
 */

const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const instances = require(path.join(CORE, 'instances.js'));
const java = require(path.join(CORE, 'java.js'));
const launch = require(path.join(CORE, 'launch.js'));
const version = require(path.join(CORE, 'version.js'));
const libraries = require(path.join(CORE, 'libraries.js'));
const rules = require(path.join(CORE, 'rules.js'));

function javaCount() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq java.exe" /FO CSV /NH', {
      encoding: 'utf8',
      windowsHide: true
    });
    return (out.match(/java\.exe/gi) || []).length;
  } catch {
    return 0;
  }
}

const T = () => Date.now();

async function main() {
  const list = await instances.list(HOME);
  const inst = list.find((x) => x.mcVersion === '26.3');
  if (!inst) {
    console.log('没有 26.3');
    return;
  }

  console.log('基线 java 进程数：', javaCount());

  // ① Java 检测（带缓存）
  let t = T();
  const javaList = await java.detectCached({ home: HOME });
  console.log(`① java.detectCached    ${T() - t} ms  (${javaList.length} 个)`);

  // ② 版本解析 + classpath
  t = T();
  const mcDir = path.join(inst.dir, '.minecraft');
  const vdir = path.join(mcDir, 'versions', '26.3');
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(path.join(vdir, '26.3.json'), 'utf8'));
  const resolved = await version.resolve(raw, { fetchJson: async () => { throw new Error('no'); }, features: {} });
  console.log(`② version.resolve      ${T() - t} ms`);

  t = T();
  libraries.classpathList(resolved, {
    librariesDir: path.join(mcDir, 'libraries'),
    osInfo: rules.currentOs(),
    source: 'official'
  });
  console.log(`③ classpathList        ${T() - t} ms`);

  // ④ 完整 launch（真正 spawn）
  console.log('\n④ 开始 launch()（真正 spawn Java）…');
  const t0 = T();
  let exitInfo = null;
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
    }
  });
  const spawnMs = T() - t0;
  console.log(`   launch() 返回（已 spawn）  ${spawnMs} ms   pid=${handle.pid}`);

  // ⑤ 等 Java 进程真的在系统里出现
  let appearedAt = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const n = javaCount();
    if (n > 0 && appearedAt === null) {
      appearedAt = T() - t0;
      console.log(`   ★ 系统里出现 java 进程    ${appearedAt} ms  (${n} 个)`);
      break;
    }
  }
  if (appearedAt === null) console.log('   ❌ 60 秒内没检测到 java 进程');

  // ⑥ 等游戏窗口出现（进程存活即可）
  await new Promise((r) => setTimeout(r, 8000));
  console.log(`\n8 秒后：java 进程 ${javaCount()} 个，exitInfo=${JSON.stringify(exitInfo)}`);

  try {
    handle.kill();
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`收尾后 java 进程：${javaCount()}`);
}

main().catch((e) => console.error('失败：', e?.stack || e));
