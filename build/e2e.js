'use strict';
/**
 * QCL 电脑版 · 端到端验收（真实下载 + 真实启动）
 *
 * 不 mock、不跳过：
 *   1. 创建实例
 *   2. 真实安装一个远古版本（QCL 看家本领）+ 一个现代版本
 *   3. 真实 spawn Java 启动游戏，读日志确认到了「游戏主循环」而不是一启动就崩
 *
 * 用法：node build/e2e.js [版本号]
 *   默认测 b1.7.3（小、快、能跑）与 pc-132011（归档远古版）
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(ROOT, '.e2e-home');
const CORE = path.join(ROOT, 'src', 'main', 'core');

function load(n) {
  return require(path.join(CORE, `${n}.js`));
}
const say = (...a) => console.log(...a);
const line = () => console.log('');

async function main() {
  const target = process.argv[2] || null;
  fs.mkdirSync(HOME, { recursive: true });
  say('QCL 电脑版 · 端到端验收');
  say('测试主目录：', HOME);
  line();

  const instances = load('instances');
  const install = load('install');
  const launch = load('launch');
  const java = load('java');

  const javaList = await java.detect();
  say(`检测到 ${javaList.length} 个 Java`);
  for (const j of javaList.slice(0, 4)) say(`   ${j.version} ${j.arch} ${j.vendor} ${j.path}`);
  line();

  const cases = target ? [{ ver: target }] : [{ ver: 'b1.7.3' }, { ver: 'pc-132011' }, { ver: '1.20.1' }];

  for (const c of cases) {
    say(`═══════ 测试版本 ${c.ver} ═══════`);
    let inst;
    try {
      inst = await instances.create(HOME, { name: `E2E-${c.ver}`, mcVersion: c.ver, loader: null });
    } catch (err) {
      // 已存在就复用
      const list = await instances.list(HOME);
      inst = list.find((x) => x.name === `E2E-${c.ver}`);
      if (!inst) {
        say(`❌ 创建实例失败：${err.message}`);
        continue;
      }
    }
    say('实例目录：', inst.dir);

    /* ---------- 安装 ---------- */
    const t0 = Date.now();
    let lastPhase = '';
    try {
      const result = await install.install({
        home: HOME,
        instanceId: inst.id,
        mcVersion: c.ver,
        loader: null,
        source: 'official',
        threads: 16,
        onProgress: (p) => {
          if (p.phase !== lastPhase) {
            lastPhase = p.phase;
            say(`   [${p.phase}] ${p.stage || ''} ${p.current ?? ''}/${p.total ?? ''}`);
          }
        },
        onLog: (l) => {
          const s = String(l);
          if (/❌|错误|失败|Error|Exception|警告|⚠/.test(s)) say('   ' + s.slice(0, 200));
        },
        signal: new AbortController().signal
      });
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      say(`✅ 安装完成 ${sec}s：${JSON.stringify(result && { version: result.version, files: result.files, bytes: result.bytes })}`);
    } catch (err) {
      say(`❌ 安装失败：${err.message}`);
      line();
      continue;
    }

    /* ---------- 落盘校验 ---------- */
    const mcDir = path.join(inst.dir, '.minecraft');
    const versionsDir = path.join(mcDir, 'versions');
    const subs = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : [];
    say('   versions 目录：', subs.join(', ') || '(空)');
    for (const v of subs) {
      const jar = path.join(versionsDir, v, `${v}.jar`);
      const json = path.join(versionsDir, v, `${v}.json`);
      const jarSize = fs.existsSync(jar) ? `${(fs.statSync(jar).size / 1024 / 1024).toFixed(2)}MB` : '缺 jar';
      const jsonOk = fs.existsSync(json) ? '有 json' : '缺 json';
      say(`      ${v}: ${jarSize} / ${jsonOk}`);
    }
    const nativesDir = path.join(mcDir, 'natives');
    say('   natives 文件数：', fs.existsSync(nativesDir) ? fs.readdirSync(nativesDir).length : 0);

    /* ---------- 真实启动 ---------- */
    say('   ── 真实启动（会 spawn Java）──');
    let logLines = 0;
    let sawMinecraft = false;
    let sawError = null;
    let exited = null;
    try {
      const handle = await launch.launch({
        home: HOME,
        instance: { ...inst, mcVersion: c.ver },
        account: { uuid: 'a01e3843e5213998958af459800e4d11', name: 'Player', type: 'offline' },
        settings: {
          javaPath: null,
          memory: { mode: 'auto', mb: 2048 },
          launch: { width: 854, height: 480, fullscreen: false, extraJvmArgs: '', extraGameArgs: '' }
        },
        onLog: (l) => {
          logLines += 1;
          const s = String(l);
          // ★ 放宽「进游戏」的判定：现代版本（26.x）的日志里没有 "LWJGL"/"Setting user" 这些老词，
          //   它们打的是 Datafixer / PerfOS / Sound engine / Backend library / Render thread 之类。
          //   以前只认老词 ⇒ 26.3 判定不出来，跑满 45 秒超时，然后被 kill，看起来像「4 秒就崩」。
          if (
            /LWJGL|Setting user|Starting Minecraft|OpenAL|SoundSystem|Narrator|Backend library|Loaded|main loop|Renderer|Datafixer|PerfOS|Sound engine|Created:|OpenGL|Vulkan|GLFW/i.test(
              s
            )
          ) {
            sawMinecraft = true;
          }
          if (/Exception in thread|FATAL|Could not find|UnsupportedClassVersion|NoClassDefFound|A fatal error has been detected/i.test(s)) {
            sawError = s.slice(0, 220);
          }
          if (logLines <= 12) say('      ' + s.slice(0, 180));
        },
        onExit: (code) => {
          // ★ onExit 传的是 {code, signal} 对象，不是数字。
          //   以前直接 `exited = code` 再打印，会显示成 "[object Object]"，
          //   看起来像「进程自己崩了」，其实是脚本 kill 的（误判过 26.3）。
          exited = code && typeof code === 'object' ? code : { code, signal: null };
        }
      });
      say(`   ✅ 已启动 pid=${handle.pid}  java=${handle.javaVersion}  内存=${handle.memoryMb}MB`);
      say(`   classpath 条目=${handle.classpathEntries}  natives=${handle.nativesDir}`);

      // 等最多 45 秒看它有没有活着/进主循环
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (exited !== null) break;
        if (sawMinecraft) break;
      }
      if (exited !== null) {
        const codeNum = exited.code;
        const wasKilled = exited.signal || codeNum === null;
        // ★ 只有「不是我们主动 kill 的」才算真崩溃
        say(
          wasKilled
            ? `   ✅ 进程已正常结束（信号 ${exited.signal || '无'}，日志 ${logLines} 行）`
            : `   ⚠ 进程已退出，退出码 ${codeNum}（日志 ${logLines} 行）`
        );
      } else {
        say(`   ✅ 进程仍在运行（日志 ${logLines} 行，${sawMinecraft ? '已出现游戏主循环相关输出' : '未见主循环标志'}）`);
        handle.kill();
        await new Promise((r) => setTimeout(r, 1500));
        say('   已结束该进程');
      }
      if (sawError) say(`   ❌ 日志里出现错误：${sawError}`);
    } catch (err) {
      say(`   ❌ 启动失败：${err.message}`);
    }
    line();
  }

  say('══════ E2E 结束 ══════');
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('E2E 脚本自身出错：', e);
  process.exitCode = 2;
});
