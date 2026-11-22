'use strict';
/**
 * 卸载器
 *
 * ★★★ 为什么要有这个（2026-11-22，用户指出）：
 *   之前的安装程序**只做安装**：
 *     · 注册表里虽然写了 `UninstallString = "QCL.exe" --uninstall`，
 *       但 QCL.exe **根本不处理 --uninstall 参数** —— 控制面板点「卸载」什么都不发生，
 *       是个死链接。
 *     · 也没有「要不要保留数据」的询问。
 *
 * 现在做成两段式：
 *   ① QCL.exe --uninstall  → 弹出真正的卸载界面（本模块）
 *   ② 用户勾选要保留什么 → 确认 → 删程序文件 + 清注册表与快捷方式 → 按选择处理数据
 *
 * ★ 数据分区（这点必须让用户看清楚，不能一把全删）：
 *   · **程序目录**    <安装位置>            ← 卸载时删
 *   · **游戏数据**    <文档>\QCL           ← 含 instances / accounts / servers / meta / java
 *   · **本地缓存**    %LOCALAPPDATA%\QCL   ← Chromium 缓存、日志
 *   · **快捷方式**    桌面 + 开始菜单
 *   · **注册表**      HKCU\...\Uninstall\QCL
 *
 *   默认策略：**默认保留游戏数据**（用户的存档、账号、服务端都在里面），
 *   只有用户主动勾「连游戏数据一起删」才会删，并且要二次确认 + 先移到隔离目录。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

/** 安装位置（QCL.exe 所在目录的上一级……实际上 exe 就在安装根） */
function installDir() {
  try {
    // 打包后 process.execPath = <安装目录>\QCL.exe
    return path.dirname(process.execPath);
  } catch {
    return '';
  }
}

/** 游戏数据目录（与 settings.js 的口径保持一致：<文档>\QCL） */
function dataDir() {
  try {
    return path.join(os.homedir(), 'Documents', 'QCL');
  } catch {
    return '';
  }
}

/** 本地缓存目录 */
function cacheDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'QCL');
}

/** 目录大小（递归，失败就当 0） */
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard < 200000) {
    const cur = stack.pop();
    guard += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch {
        /* 跳过读不到的文件 */
      }
    }
  }
  return total;
}

/** 人类可读大小 */
function human(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * 卸载前先把「要删的数据」全部算清楚，给界面展示。
 * @returns {{ok:boolean, items:Array<{key,label,dir,size,sizeText,exists,keepDefault,desc}>, installDir:string, totalText:string}}
 */
function survey() {
  const inst = installDir();
  const data = dataDir();
  const cache = cacheDir();

  const items = [
    {
      key: 'program',
      label: '程序文件',
      dir: inst,
      desc: '启动器本体（QCL.exe、resources 等），删掉后无法再启动',
      /** 程序文件永远删，不给保留选项 */
      keepDefault: false,
      locked: true,
    },
    {
      key: 'data',
      label: '游戏数据',
      dir: data,
      desc: '版本、实例、账号、服务端、世界存档、下载缓存都在这里。删掉后**无法恢复**',
      /** ★ 默认保留 —— 用户的存档与服务器价值远高于程序 */
      keepDefault: true,
      locked: false,
    },
    {
      key: 'cache',
      label: '本地缓存',
      dir: cache,
      desc: 'Chromium 缓存、运行日志；删掉不影响任何数据',
      keepDefault: false,
      locked: false,
    },
  ].map((it) => {
    let exists = false;
    let size = 0;
    try {
      exists = !!it.dir && fs.existsSync(it.dir);
      if (exists) size = dirSize(it.dir);
    } catch {
      exists = false;
    }
    return { ...it, exists, size, sizeText: human(size) };
  });

  const removeTotal = items.filter((i) => i.exists && !i.keepDefault).reduce((a, b) => a + b.size, 0);
  return {
    ok: true,
    items,
    installDir: inst,
    dataDir: data,
    cacheDir: cache,
    totalText: human(removeTotal),
  };
}

/** 删注册表卸载项 + 快捷方式 */
function cleanupShell() {
  const done = [];
  const failed = [];

  // ① 注册表
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QCL', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (r.status === 0) done.push('注册表卸载项');
    else failed.push('注册表卸载项（可能本来就不存在）');
  } catch (e) {
    failed.push(`注册表：${e.message}`);
  }

  // ② 快捷方式
  const shorts = [];
  try {
    shorts.push(path.join(os.homedir(), 'Desktop', 'Quanta Craft Launcher PC.lnk'));
  } catch {
    /* ignore */
  }
  try {
    shorts.push(path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', 'Quanta Craft Launcher PC.lnk'));
  } catch {
    /* ignore */
  }
  try {
    shorts.push(
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Quanta Craft Launcher PC', 'Quanta Craft Launcher PC.lnk')
    );
    shorts.push(
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Quanta Craft Launcher PC')
    );
  } catch {
    /* ignore */
  }
  // 桌面可能被重定向（本机是 D:\桌面）
  shorts.push('D:\\桌面\\Quanta Craft Launcher PC.lnk');

  for (const s of shorts) {
    if (!s) continue;
    try {
      if (fs.existsSync(s)) {
        const st = fs.statSync(s);
        if (st.isDirectory()) fs.rmSync(s, { recursive: true, force: true });
        else fs.unlinkSync(s);
        done.push(path.basename(s));
      }
    } catch (e) {
      failed.push(`${path.basename(s)}：${e.message}`);
    }
  }

  return { done, failed };
}

/**
 * 「把目录移到隔离位置」—— 比直接删安全。
 * 用法：先 rename 成 <dir>.qcl-removing-<时间戳>，成功后再删。
 * rename 成功 = 立刻对用户不可见；之后删失败也不影响。
 */
function quarantineAndRemove(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: true };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trash = `${dir}.qcl-removing-${stamp}`;
  try {
    fs.renameSync(dir, trash);
  } catch (e) {
    // rename 失败（跨卷/占用）→ 试试直接删
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, direct: true };
    } catch (e2) {
      return { ok: false, error: `无法移动也无法删除：${e2.message}` };
    }
  }
  // 已经不可见，慢慢删
  try {
    fs.rmSync(trash, { recursive: true, force: true });
    return { ok: true, moved: trash };
  } catch (e) {
    return { ok: true, moved: trash, warning: `已移到 ${trash}，但删除未完成（重启后可手动删）` };
  }
}

/**
 * 执行卸载。
 * @param {{removeProgram?:boolean, removeData?:boolean, removeCache?:boolean, onProgress?:Function}} opts
 */
async function perform(opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const report = { removed: [], kept: [], errors: [], shell: null, needManual: [] };

  const inst = installDir();
  const data = dataDir();
  const cache = cacheDir();

  // ① 先清 shell 层（注册表 / 快捷方式）
  onProgress('正在清理注册表与快捷方式…');
  report.shell = cleanupShell();

  // ② 缓存
  if (opts.removeCache && cache) {
    onProgress('正在删除本地缓存…');
    const r = quarantineAndRemove(cache);
    if (r.ok) report.removed.push(`本地缓存 ${cache}`);
    else report.errors.push(`本地缓存：${r.error}`);
  } else if (cache) {
    report.kept.push(`本地缓存 ${cache}`);
  }

  // ③ 游戏数据
  if (opts.removeData && data) {
    onProgress('正在删除游戏数据…');
    const r = quarantineAndRemove(data);
    if (r.ok) report.removed.push(`游戏数据 ${data}`);
    else report.errors.push(`游戏数据：${r.error}`);
  } else if (data) {
    report.kept.push(`游戏数据 ${data}`);
  }

  /**
   * ④ 程序文件放最后删。
   * ★ 正在运行的 exe 删不掉，所以这一步必须由**外部**来做：
   *   我们先写一个分离的 cmd 脚本，它等本进程退出后再删目录。
   */
  if (opts.removeProgram && inst) {
    onProgress('正在准备删除程序文件…');
    const self = process.execPath;
    const script = path.join(os.tmpdir(), `qcl-uninstall-${Date.now()}.cmd`);
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      // 等主进程退出（最多 30 秒）
      'set /a n=0',
      ':wait',
      'timeout /t 1 /nobreak >nul',
      `tasklist /fi "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
      'if not errorlevel 1 (',
      '  set /a n+=1',
      '  if %n% lss 30 goto wait',
      ')',
      `rmdir /s /q "${inst}" 2>nul`,
      `del /f /q "${script}" 2>nul`,
      'exit',
    ];
    try {
      fs.writeFileSync(script, lines.join('\r\n'), 'utf8');
      execFile('cmd.exe', ['/c', 'start', '/min', '', script], { windowsHide: true });
      report.needManual.push(inst);
    } catch (e) {
      report.errors.push(`程序文件删除脚本创建失败：${e.message}`);
    }
  } else if (inst) {
    report.kept.push(`程序文件 ${inst}`);
  }

  return report;
}

module.exports = {
  installDir,
  dataDir,
  cacheDir,
  dirSize,
  human,
  survey,
  cleanupShell,
  quarantineAndRemove,
  perform,
};
