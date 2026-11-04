'use strict';
/*
 * 实测脚本：「游戏真就绪」检测（src/main/core/launch.js + ipc.js + preload）
 *
 * 运行：node build/verify-game-ready.js
 *
 * 验证点：
 *   ① 打印真实正则、90 秒兜底、以及**每一处触发点所在的行号**（launch.js / ipc.js / preload / bridge / shell）；
 *   ② 用现代版本（1.13+）与老版本（1.6~1.12）的**真实日志样例行**喂检测器，必须命中；
 *   ③ 普通日志行不许命中（防误报）；
 *   ④ 只触发一次：重复出现 Sound engine started / 后续标志行都不能再回调；
 *   ⑤ 回调抛异常不能炸掉检测器；
 *   ⑥ 整条事件链静态核对：ipc.js send → preload EVENT_RE 放行 → bridge 转发 → shell 订阅。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const launch = require(path.join(ROOT, 'src', 'main', 'core', 'launch.js'));

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
/** 在文件里找出匹配的行（跳过注释行），返回 [{ line, text }]。 */
function findLines(rel, pattern) {
  const lines = read(rel).split(/\r?\n/);
  const out = [];
  lines.forEach((text, i) => {
    const t = text.trim();
    // 注释行里也会出现 stage('running') / opts.onGameReady() 这类字样，不能算触发点
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    if (pattern.test(text)) out.push({ line: i + 1, text: t });
  });
  return out;
}
function printHits(title, hits) {
  console.log(`  ${title}`);
  for (const h of hits) console.log(`    L${h.line}: ${h.text.length > 130 ? `${h.text.slice(0, 130)}…` : h.text}`);
  if (!hits.length) console.log('    （没找到！）');
}

const LAUNCH = 'src/main/core/launch.js';
const IPC = 'src/main/ipc.js';
const PRELOAD = 'src/preload/index.js';
const BRIDGE = 'src/renderer/js/bridge.js';
const SHELL = 'src/renderer/js/shell.js';

async function main() {
  section('① 正则与兜底参数（来自 launch.js 的导出）');
  console.log(`  GAME_READY_RE       = ${launch.GAME_READY_RE}`);
  console.log(`  GAME_READY_RE.source= ${launch.GAME_READY_RE.source}`);
  console.log(`  GAME_READY_TIMEOUT_MS = ${launch.GAME_READY_TIMEOUT_MS}（毫秒，即 ${launch.GAME_READY_TIMEOUT_MS / 1000} 秒）`);
  check(launch.GAME_READY_TIMEOUT_MS === 90000, '兜底是 90 秒');
  check(launch.isGameReadyLine('Sound engine started') === true, 'isGameReadyLine 已导出且可用');

  section('② 触发点在源码里的真实行号');
  const reDef = findLines(LAUNCH, /^const GAME_READY_RE =/);
  const stageRunning = findLines(LAUNCH, /stage\('running'/);
  const detectorDef = findLines(LAUNCH, /const readyDetector = createGameReadyDetector/);
  const feedLine = findLines(LAUNCH, /readyDetector\.feed\(line\)/);
  const feedTail = findLines(LAUNCH, /readyDetector\.feed\(buffer\)/);
  const pumpDef = findLines(LAUNCH, /^ {2}const pump = \(stream, tag\) =>/);
  const timerDef = findLines(LAUNCH, /^ {2}readyTimer = setTimeout\(/);
  const readyCall = findLines(LAUNCH, /opts\.onGameReady\(/);
  printHits('launch.js：正则定义', reDef);
  printHits('launch.js：stage(\'running\') —— 只表示「进程已启动、正在加载」，不再代表就绪', stageRunning);
  printHits('launch.js：创建一次性检测器', detectorDef);
  printHits('launch.js：pump 定义', pumpDef);
  printHits('launch.js：每读到一行日志就喂检测器（stdout 与 stderr 共用 pump）', feedLine);
  printHits('launch.js：流结束时剩余缓冲也喂一次', feedTail);
  printHits('launch.js：90 秒兜底计时器（不报错、不发事件）', timerDef);
  printHits('launch.js：真正回调上层 onGameReady 的地方（只有这一处）', readyCall);
  printHits('ipc.js：把 onGameReady 转成事件', findLines(IPC, /onGameReady: \(info\)/));
  printHits('ipc.js：send()', findLines(IPC, /send\('launch:game-ready'/));
  printHits('preload/index.js：EVENT_RE 白名单', findLines(PRELOAD, /^const EVENT_RE =/));
  printHits('bridge.js：initBridge 转发列表', findLines(BRIDGE, /'launch:game-ready'/));
  printHits('shell.js：界面订阅（收到才关启动窗口）', findLines(SHELL, /on\('launch:game-ready'/));

  check(reDef.length === 1, '正则只有一处定义');
  check(stageRunning.length === 1, "stage('running') 保留且只有一处");
  check(detectorDef.length === 1, '创建了且只创建了一个检测器');
  check(pumpDef.length === 1 && feedLine.length === 1, 'pump 里每行都喂了检测器');
  check(feedTail.length === 1, '流末尾的残行也喂了');
  check(timerDef.length === 1, '90 秒兜底只有一个计时器');
  check(readyCall.length === 1, 'onGameReady 只在检测器回调里调一次');
  // 顺序：pump 定义在 feed 之前 → feed 在 pump 内部
  const lineOf = (hits) => (hits.length ? hits[0].line : -1);
  check(lineOf(pumpDef) > 0 && lineOf(pumpDef) < lineOf(feedLine), "readyDetector.feed 在 pump 函数体内（pump 定义在它之前）");
  check(lineOf(feedLine) < lineOf(timerDef), '先开始监听日志，再挂 90 秒兜底');

  section('③ 真实日志样例行：现代版本（1.13+，Render thread）');
  const MODERN = [
    '[22:15:01] [Render thread/INFO]: Backend library: LWJGL version 3.3.3+5',
    '[22:15:02] [Render thread/INFO]: OpenAL initialized on device 扬声器 (Realtek(R) Audio)',
    '[22:15:02] [Render thread/INFO]: Sound engine started',
    '[22:15:03] [Render thread/INFO]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png',
  ];
  for (const line of MODERN) {
    const ok = launch.isGameReadyLine(line);
    check(ok, `命中：${line.replace(/^\[[^\]]+\]\s*/, '')}`);
  }

  section('④ 真实日志样例行：老版本（1.6~1.12，Client thread）');
  const OLD = [
    '[22:15:01] [Client thread/INFO]: LWJGL Version: 2.9.4',
    '[22:15:01] [Client thread/INFO]: Setting user: Steve',
    '[22:15:02] [Client thread/INFO]: Starting Minecraft: 1.8.9',
  ];
  for (const line of OLD) {
    check(launch.isGameReadyLine(line), `命中：${line.replace(/^\[[^\]]+\]\s*/, '')}`);
  }

  section('⑤ 普通日志行不许命中（防误报）');
  const NOT_READY = [
    '[22:14:50] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.14.23',
    '[22:14:51] [main/INFO]: Loading 45 mods:',
    '[22:14:52] [main/WARN]: Could not find sound engine library',
    '[22:14:55] [Render thread/INFO]: Reloading ResourceManager: Default',
    '[22:15:10] [Render thread/INFO]: Loaded 1234 recipes',
    'Done (12.345s)! For help, type "help"',
    '[22:15:20] [Render thread/INFO]: Stopping!',
    '正在启动 Java 进程',
  ];
  for (const line of NOT_READY) {
    const ok = launch.isGameReadyLine(line) === false;
    check(ok, `不命中：${line.length > 60 ? `${line.slice(0, 60)}…` : line}`);
  }

  section('⑥ 只触发一次（重复标志 / 后续标志都不再回调）');
  let calls = 0;
  const seen = [];
  const det = launch.createGameReadyDetector((line) => {
    calls += 1;
    seen.push(line);
  });
  const first = det.feed(MODERN[0]);
  console.log(`  第 1 行（Backend library）feed → ${first}，累计回调 ${calls} 次`);
  console.log(`  第 2 行（OpenAL initialized）feed → ${det.feed(MODERN[1])}，累计回调 ${calls} 次`);
  console.log(`  第 3 行（Sound engine started）feed → ${det.feed(MODERN[2])}，累计回调 ${calls} 次`);
  console.log(`  再喂一次 Sound engine started → ${det.feed(MODERN[2])}，累计回调 ${calls} 次`);
  console.log(`  再喂老版本标志 LWJGL Version → ${det.feed(OLD[0])}，累计回调 ${calls} 次`);
  console.log(`  det.fired=${det.fired}  matchedLine=${det.matchedLine}`);
  check(first === true, '第一次命中返回 true');
  check(calls === 1, '整个生命周期只回调一次', `实际 ${calls} 次`);
  check(det.fired === true, 'fired 变为 true');
  check(det.matchedLine === MODERN[0], 'matchedLine 记录的是第一次命中的那一行');

  section('⑦ 真实启动顺序模拟（50 行普通日志 + 主循环标志）');
  const log = [];
  for (let i = 0; i < 20; i += 1) log.push(`[22:14:${String(40 + i).padStart(2, '0')}] [main/INFO]: 加载第 ${i} 项`);
  log.push(...OLD.slice(0, 2)); // 老版本会先打 Setting user / LWJGL Version
  for (let i = 0; i < 20; i += 1) log.push(`[22:15:${String(i).padStart(2, '0')}] [Render thread/INFO]: 准备资源 ${i}`);
  log.push(...MODERN, '[22:15:04] [Render thread/INFO]: Sound engine started'); // 末尾重复一次
  let simCalls = 0;
  let firstAt = -1;
  const sim = launch.createGameReadyDetector(() => {
    simCalls += 1;
    if (firstAt < 0) firstAt = simLinesFed;
  });
  let simLinesFed = 0;
  for (const line of log) {
    simLinesFed += 1;
    sim.feed(line);
  }
  console.log(`  共喂 ${simLinesFed} 行，回调 ${simCalls} 次，首次命中在第 ${firstAt} 行：`);
  console.log(`    ${log[firstAt - 1]}`);
  check(simCalls === 1, '整段启动日志只触发一次');
  check(firstAt === log.indexOf(OLD[0]) + 1, '命中点是老版本的第一条标志行（LWJGL Version）');

  section('⑧ 回调抛异常不会炸掉检测器');
  let afterThrow = 0;
  const det2 = launch.createGameReadyDetector(() => {
    throw new Error('界面回调故意抛错');
  });
  const r2 = det2.feed('Sound engine started');
  det2.feed('Sound engine started');
  afterThrow += 1;
  console.log(`  feed 返回 ${r2}，det2.fired=${det2.fired}（异常被吞掉，游戏不受影响）`);
  check(r2 === true && det2.fired === true, '回调抛错时 feed 仍然返回 true 且标记已触发');
  check(afterThrow === 1, '脚本继续执行（没有被异常打断）');

  section('⑨ 事件链静态核对（三处 + 界面）');
  // preload 的 EVENT_RE 是否真的放行 launch:game-ready（把源码里的正则抠出来重新构造）
  const preloadSrc = read(PRELOAD);
  const m = preloadSrc.match(/const EVENT_RE = \/\^\(([^)]+)\)\$\/;/);
  check(!!m, '能解析 preload 的 EVENT_RE 源码');
  if (m) {
    const eventRe = new RegExp(`^(${m[1]})$`);
    console.log(`  EVENT_RE 解析结果：${eventRe}`);
    check(eventRe.test('launch:game-ready') === true, 'EVENT_RE 放行 launch:game-ready');
    check(eventRe.test('launch:log') === true && eventRe.test('launch:stage') === true, '原有事件没被破坏');
    check(eventRe.test('launch:bad-event') === false, '其它未知事件仍被拦（白名单没放宽）');
  }
  const ipcSrc = read(IPC);
  check(/send\('launch:game-ready', elapsedMs === undefined \? \{ id \} : \{ id, elapsedMs \}\)/.test(ipcSrc), 'ipc.js 发的 payload 是 { id }（有耗时时补 elapsedMs）');
  check(read(BRIDGE).includes("'launch:game-ready'"), 'bridge.js 转发列表已包含 launch:game-ready（frontend-dev 已加）');
  check(read(SHELL).includes("on('launch:game-ready'"), 'shell.js 收到它才 finishLaunch(true)');

  section('结果');
  console.log(`  失败项：${failures}`);
  if (failures) {
    console.log('\n  ✗ 有检查项失败');
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ 全部检查项通过');
  }
}

main().catch((err) => {
  console.error('脚本本身出错：', err);
  process.exit(2);
});
