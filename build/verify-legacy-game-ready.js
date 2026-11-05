'use strict';
/**
 * 验收：老式 LWJGL 2 版本（b1.7.3 / 1.0~1.12）的启动窗口能正常关闭
 *
 * 用户实机日志（b1.7.3）：游戏窗口 18:50:01 就出来了，但启动窗口一直挂在
 * 「等待游戏窗口」—— 因为老判据只认 Sound engine started / LWJGL Version /
 * Starting Minecraft，而 b1.7.3 打的是 `OpenAL initialized.`。
 *
 * 用法：node build/verify-legacy-game-ready.js
 */
const launch = require('../src/main/core/launch');

const checks = [];
const check = (name, pass, info) => checks.push({ name, pass, info });

/** 用户提供的 b1.7.3 真实日志（去掉时间戳前缀） */
const B173_LOG = [
  'Using tweak class name net.minecraft.launchwrapper.VanillaTweaker',
  'Launching wrapped minecraft',
  '16 achievements',
  '151 recipes',
  'Turning of ImageIO disk-caching',
  'Loading current icons for window from: C:\\...\\resources\\icons\\icon_16x16.png and icon_32x32.png',
  'Setting gameDir to: C:\\...\\.minecraft',
  '警告: Found unknown Windows version: Windows 10',
  'Starting up SoundSystem...',
  'Initializing LWJGL OpenAL',
  '    (The LWJGL binding of OpenAL.  For more information, see http://www.lwjgl.org)',
  'OpenAL initialized.',
  'Stopping!',
  'SoundSystem shutting down...',
];

/** 现代 1.13+ 日志：OpenAL 行在 Sound engine started 之前，不能误报 */
const MODERN_LOG = [
  '[Render thread/INFO]: Backend library: LWJGL version 3.3.3+5',
  '[Render thread/INFO]: OpenAL initialized on device 扬声器 (Realtek(R) Audio)',
  '[Render thread/INFO]: Sound engine started',
];

console.log('===== ① 正则本身 =====');
check('b1.7.3 的 `OpenAL initialized.` 被认', launch.isLegacyGameReadyLine('OpenAL initialized.') === true);
check('b1.7.3 的 `Loading current icons for window` 被认',
  launch.isLegacyGameReadyLine('Loading current icons for window from: icon_16x16.png') === true);
check('现代 `OpenAL initialized on device ...` **不被**认',
  launch.isLegacyGameReadyLine('[Render thread/INFO]: OpenAL initialized on device 扬声器') === false);
check('`Stopping!` 不被认', launch.isLegacyGameReadyLine('Stopping!') === false);

console.log('');
console.log('===== ② 喂真实 b1.7.3 日志（模拟 spawn 后 3 秒）=====');
{
  const started = Date.now() - 3000; // 已经过了 2 秒门槛
  let calls = 0;
  let hitLine = '';
  const det = launch.createGameReadyDetector((line) => { calls += 1; hitLine = line; }, { startedAt: started });
  let fireAt = -1;
  B173_LOG.forEach((line, i) => {
    if (det.feed(line) && fireAt < 0) fireAt = i;
  });
  check('b1.7.3 日志能触发就绪', calls === 1, { calls, hitLine });
  check('触发点在 `Loading current icons` 或 `OpenAL initialized.`（窗口已建好）',
    fireAt === 5 || fireAt === 11, { fireAt, line: B173_LOG[fireAt] });
  check('喂完 `Stopping!` 不会二次触发', calls === 1, { calls });
  check('detector.matchedLine 有内容', det.matchedLine.length > 0, det.matchedLine);
}

console.log('');
console.log('===== ③ 现代 1.13+ 日志不能提前误报 =====');
{
  const started = Date.now() - 3000;
  let calls = 0;
  let hitLine = '';
  const det = launch.createGameReadyDetector((line) => { calls += 1; hitLine = line; }, { startedAt: started });
  MODERN_LOG.forEach((line) => det.feed(line));
  check('现代日志只触发一次（在 Sound engine started）', calls === 1, { calls, hitLine });
  check('不是被 `OpenAL initialized on device` 误触发', !/on device/i.test(hitLine), { hitLine });
}

console.log('');
console.log('===== ④ 延迟门槛：spawn 后立刻打 `OpenAL initialized.` 也不认 =====');
{
  let calls = 0;
  const det = launch.createGameReadyDetector(() => { calls += 1; }, { startedAt: Date.now() });
  det.feed('OpenAL initialized.');
  check('未满 2 秒不触发', calls === 0, { calls });
  // 门槛过后喂正常日志应能触发
  const det2 = launch.createGameReadyDetector(() => { calls += 1; }, { startedAt: Date.now() - 2500 });
  det2.feed('OpenAL initialized.');
  check('满 2 秒后触发', calls === 1, { calls });
}

console.log('');
console.log('===== ⑤ 1.x（1.0~1.12）同样写法也覆盖 =====');
{
  let calls = 0;
  const det = launch.createGameReadyDetector(() => { calls += 1; }, { startedAt: Date.now() - 3000 });
  const LOG_1X = [
    'Starting up SoundSystem...',
    'Initializing LWJGL OpenAL',
    'OpenAL initialized.',
    'Sound engine started', // 万一某些 1.x 变体也有
  ];
  LOG_1X.forEach((l) => det.feed(l));
  check('1.x 的 `OpenAL initialized.` 能触发（覆盖 1.0 以上）', calls === 1, { calls });
}

console.log('');
console.log('================ 验收结果 ================');
let fail = 0;
for (const c of checks) {
  if (!c.pass) fail += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined ? '  → ' + JSON.stringify(c.info) : ''}`);
}
console.log('--------------------------------------------------');
console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
