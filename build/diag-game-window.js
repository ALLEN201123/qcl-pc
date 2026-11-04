'use strict';
/**
 * 干净测试：启动 26.3，全程观察 java 进程与游戏窗口
 * 目的：确认「游戏窗口到底有没有出现」以及为什么 code=-2
 */

const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const launch = require(path.join(CORE, 'launch.js'));
const instances = require(path.join(CORE, 'instances.js'));

function javaCount() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq java.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
    return (out.match(/java\.exe/gi) || []).length;
  } catch {
    return -1;
  }
}

/** 用 PowerShell 查有没有 Java 窗口 */
function javaWindowTitles() {
  try {
    const psi = `Get-Process javaw,java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty MainWindowTitle`;
    const out = execSync(`powershell -NoProfile -Command "${psi.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    return out.trim() || '(无窗口标题)';
  } catch {
    return '(查询失败)';
  }
}

async function main() {
  console.log(`初始 java 进程数: ${javaCount()}\n`);

  const list = await instances.list(HOME);
  const inst = list.find((x) => x.mcVersion === '26.3') || list[0];
  console.log(`实例: ${inst.name}（${inst.mcVersion}）`);

  const timeline = [];
  let exitInfo = null;
  const t0 = Date.now();
  const rec = (ev, d) => {
    timeline.push({ t: Date.now() - t0, ev, d });
    console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${ev}${d ? '  ' + d : ''}`);
  };

  let readyAt = null;
  const handle = await launch.launch({
    home: HOME,
    instance: inst,
    account: null,
    settings: {
      javaPath: null,
      memory: { mode: 'manual', mb: 2048 },
      launch: { width: 1280, height: 720, fullscreen: false, extraJvmArgs: '', extraGameArgs: '' },
      game: { minMemoryMb: 512 }
    },
    onLog: (line) => {
      const s = String(line);
      if (/Sound engine started|Backend library|LWJGL|OpenAL|Stopping|Exception|Error/i.test(s)) {
        rec('LOG', s.slice(0, 100));
      }
    },
    onStage: (st) => rec('STAGE', `${st.key} ${st.label}`),
    onGameReady: (info) => {
      readyAt = Date.now();
      rec('GAME_READY', JSON.stringify(info));
    },
    onExit: (c) => {
      exitInfo = c;
      rec('EXIT', JSON.stringify(c));
    }
  });
  rec('SPAWNED', `pid=${handle.pid}`);

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const sec = Math.round((Date.now() - t0) / 1000);
    if (exitInfo) break;
    const jc = javaCount();
    rec(`POLL`, `sec=${sec} java进程=${jc} ready=${readyAt ? 'YES' : 'no'}`);
    if (i === 5) {
      rec('WINDOW_CHECK', javaWindowTitles());
    }
  }

  console.log('\n═══ 结果 ═══');
  console.log(`游戏就绪: ${readyAt ? '是（' + ((readyAt - t0) / 1000).toFixed(1) + ' 秒）' : '否'}`);
  console.log(`退出: ${exitInfo ? JSON.stringify(exitInfo) : '仍在运行'}`);
  if (readyAt && exitInfo) {
    const life = (Date.now() - readyAt) / 1000;
    console.log(`就绪后存活: ${life.toFixed(1)} 秒`);
  }

  try {
    handle.kill();
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`收尾后 java 进程数: ${javaCount()}`);
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
