'use strict';
/**
 * 检查 26.3 的完整启动命令：classpath 长度、是否超 Windows 命令行上限。
 *
 * 假设：26.3 有 75 个 classpath 条目、路径都很长，
 *       拼出来的命令行可能接近甚至超过 Windows 的 32767 字符上限，
 *       导致 Java 实际收到的 -cp 被截断 → 找不到 jar 里的类
 *       （表现为 NoClassDefFoundError: net/minecraft/util/Unit，
 *         而那个类明明就在 26.3.jar 里）。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const version = require(path.join(CORE, 'version.js'));
const libraries = require(path.join(CORE, 'libraries.js'));
const rules = require(path.join(CORE, 'rules.js'));

async function main() {
  const instDir = path.join(HOME, 'instances', 'mw2ee5w7-88c11ad3');
  const mcDir = path.join(instDir, '.minecraft');
  const vdir = path.join(mcDir, 'versions', '26.3');

  const raw = JSON.parse(fs.readFileSync(path.join(vdir, '26.3.json'), 'utf8'));
  const resolved = await version.resolve(raw, {
    fetchJson: async () => {
      throw new Error('no parent');
    },
    features: {}
  });
  const osInfo = rules.currentOs();
  const cp = libraries.classpathList(resolved, {
    librariesDir: path.join(mcDir, 'libraries'),
    osInfo,
    source: 'official'
  });

  // 客户端 jar 也要进 classpath
  const clientJar = path.join(vdir, '26.3.jar');
  if (!cp.some((p) => p.includes('26.3.jar'))) cp.push(clientJar);

  const cpString = cp.join(';');
  console.log(`classpath 条目数：${cp.length}`);
  console.log(`classpath 字符串长度：${cpString.length} 字符`);
  console.log(`Windows 命令行上限：32767 字符（CreateProcess 限制）`);
  console.log(`Java 的 -cp 实际还受 32768 的 Win32 argv 限制`);

  if (cpString.length > 30000) {
    console.log('\n❌ classpath 过长，极可能被截断');
  } else if (cpString.length > 24000) {
    console.log('\n⚠ classpath 偏长，接近上限');
  } else {
    console.log('\n✅ 长度正常');
  }

  // 估算完整命令行长度
  const jvmBase = [
    '-Xms512m',
    '-Xmx2048m',
    '-Dfile.encoding=UTF-8',
    '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
    '-XX:StackShadowPages=32',
    '--enable-native-access=ALL-UNNAMED',
    '-cp',
    cpString,
    'net.minecraft.client.main.Main',
    '--username',
    'Player',
    '--version',
    '26.3',
    '--gameDir',
    mcDir,
    '--assetsDir',
    path.join(mcDir, 'assets')
  ];
  const total = jvmBase.join(' ').length;
  console.log(`\n估算完整命令行长度：${total} 字符`);
  if (total > 32767) {
    console.log('❌ 超过 32767，**必须**改用 @argfile 方式启动');
  } else {
    console.log(`（距上限还有 ${32767 - total} 字符余量）`);
  }

  // 各条路径的平均长度（诊断用）
  const avg = cp.reduce((s, p) => s + p.length, 0) / cp.length;
  console.log(`\n平均每条 classpath 长度：${avg.toFixed(0)} 字符`);
  console.log(`最长的 3 条：`);
  cp
    .slice()
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .forEach((p) => console.log(`  ${p.length} 字符  ${p}`));
}

main().catch((e) => console.error('失败：', e));
