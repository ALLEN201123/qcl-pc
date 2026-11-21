'use strict';
/**
 * Quanta Craft Launcher PC · 百宝箱（Toolbox）
 *
 * 功能清单、方法签名、触发方式**照 PCL 官方开源仓库
 * （Meloong-Git/PCL，`PageOtherTest.xaml.vb` + `Modules/ModEvent.vb` L262-315）**：
 *
 *   StartCustomDownload(Url, FileName, Optional Folder)   下载自定义文件
 *   Jrrp()                                               今日人品
 *   RubbishClear()                                       清理游戏垃圾
 *   MemoryOptimize(ShowHint) / MemoryOptimizeInternal()   内存优化
 *   GetRandomCave() / GetRandomHint()                     回声洞 / 随机提示
 *
 * ★ 诚实申明（必须跟玩家讲清楚，也写在这里备查）：
 *   ① PCL 开源版把百宝箱**挖空了** —— 所有方法体只剩一句
 *      `Hint("为便于维护，开源内容中不包含百宝箱功能……")`。
 *      所以「有哪些功能、收什么参数、怎么触发」是抄来的（可信）；
 *      **实现细节是推定的**，本文档注释里逐条标注。
 *   ② 内存优化**不会让电脑变快**。它只是把进程的工作集页刷到页面文件，
 *      让系统显示的可用内存变大；代价是这些页下次访问要从磁盘读回来，
 *      刚切回的程序可能短暂卡一下。UI 上绝不能写成「加速」。
 *   ③ 清理垃圾**只碰日志/崩溃报告/下载残骸**，绝不动
 *      saves / mods / config / resourcepacks；而且走回收站，不直接删除。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const paths = require('./paths');

/* ============================================================
 * ① 今日人品 Jrrp()
 * ============================================================
 * ★ 必须是**确定性**的：同一天 + 同一用户名 → 永远同一个结果。
 *   否则玩家刷新几次发现分数变了，会立刻觉得这是假的。
 *   （PCL 的实现不在开源代码里，这里按确定性哈希推定。）
 */

/** jenkins 一次性哈希，分散度比简单取模好，且无需依赖 crypto 的字节序 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 再混一轮，避免相邻日期只差一位时结果太接近
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** 分档评语（分数越高越好玩，不带任何真实含义） */
const JRRP_TEXTS = [
  { max: 10, text: '今天适合掛机，别碰生存模式。' },
  { max: 25, text: '运气有点背，挖矿记得带够火把。' },
  { max: 45, text: '平平淡淡，适合整理箱子。' },
  { max: 60, text: '还行，能打，但别硬冲。' },
  { max: 75, text: '不错，今天下矿应该能出货。' },
  { max: 90, text: '状态在线，去打末影龙吧。' },
  { max: 99, text: '欧气满满，附魔必出好东西。' },
  { max: 100, text: '今天你就是天选之子，快去开箱。' },
];

/**
 * 算今日人品。
 * @param {string} userName 玩家名（空则用 'QCL' 兜底，保证不崩）
 * @param {Date}   [now]    测试时注入固定时间
 * @returns {{score:number, text:string, date:string, user:string}}
 */
function jrrp(userName, now) {
  const d = now instanceof Date ? now : new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const user = String(userName || '').trim() || 'QCL';
  const score = hash32(`${user}|${dateStr}`) % 101;
  const bucket = JRRP_TEXTS.find((t) => score <= t.max) || JRRP_TEXTS[JRRP_TEXTS.length - 1];
  return { score, text: bucket.text, date: dateStr, user };
}

/* ============================================================
 * ② 内存优化 MemoryOptimize()
 * ============================================================
 * Windows：psapi!EmptyWorkingSet 把进程工作集页刷出去。
 *   · 需要打开进程句柄（PROCESS_SET_QUOTA|PROCESS_QUERY_INFORMATION）
 *   · 普通权限下对自己的进程一定成功；对同用户的其他进程多数也能成功，
 *     系统进程/受保护进程会失败 —— **失败是正常的，不要报错给玩家看**
 * 这里用 PowerShell + Add-Type 调 Win32，避免引入原生模块
 * （工程里没有 node-gyp 工具链，走 FFI 会让安装包多一堆依赖）。
 *
 * ★ 为什么不像 PCL 那样只做「内部版」：Electron 里跑这段要几百毫秒到几秒，
 *   必须放后台，否则界面会卡住；所以这里只提供异步接口。
 */

const MEM_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$freeBefore = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
$sigPsapi = '[DllImport("psapi.dll", SetLastError=true)] public static extern bool EmptyWorkingSet(IntPtr hProcess);'
$sigKernel = '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);'
$sigClose = '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);'
try { $psapi = Add-Type -MemberDefinition $sigPsapi -Name 'PsapiW' -PassThru -ErrorAction Stop } catch { $psapi = $null }
try { $kernel = Add-Type -MemberDefinition $sigKernel -Name 'KernelW' -PassThru -ErrorAction Stop } catch { $kernel = $null }
try { $closer = Add-Type -MemberDefinition $sigClose -Name 'CloseW' -PassThru -ErrorAction Stop } catch { $closer = $null }
$okCount = 0
$failCount = 0
if ($psapi -and $kernel) {
  foreach ($p in (Get-Process)) {
    try {
      $h = $kernel::OpenProcess(0x0100 -bor 0x0400, $false, $p.Id)
      if ($h -ne [IntPtr]::Zero) {
        if ($psapi::EmptyWorkingSet($h)) { $okCount++ } else { $failCount++ }
        if ($closer) { $closer::CloseHandle($h) | Out-Null }
      } else { $failCount++ }
    } catch { $failCount++ }
  }
}
Start-Sleep -Milliseconds 250
$freeAfter = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
Write-Output ("$freeBefore|$freeAfter|$okCount|$failCount")
`;

/** 跑 PowerShell 取一段文本（超时/失败返回 null，绝不抛给上层） */
function runPowerShell(script, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (done) return;
        done = true;
        if (err && !stdout) {
          resolve({ ok: false, error: err.message, stdout: '' });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || '') });
      }
    );
    child.on('error', (err) => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: err.message, stdout: '' });
    });
  });
}

/**
 * 执行内存优化。
 * @returns {Promise<{ok:boolean, supported:boolean, freedMb:number,
 *                    processes:number, failed:number, note:string, error?:string}>}
 */
async function memoryOptimize() {
  const note =
    '本条只把内存页刷到页面文件里，系统显示的「可用内存」会变大。' +
    '它不会让程序变快，反而可能让刚切回的程序短暂卡顿。真正的内存不足请关掉不用的程序。';

  if (process.platform !== 'win32') {
    return {
      ok: false,
      supported: false,
      freedMb: 0,
      processes: 0,
      failed: 0,
      note,
      error: '当前系统不是 Windows，没有 EmptyWorkingSet 等价能力，本功能不可用。',
    };
  }

  const r = await runPowerShell(MEM_SCRIPT);
  if (!r.ok) {
    return { ok: false, supported: true, freedMb: 0, processes: 0, failed: 0, note, error: r.error };
  }
  // 期望输出：before|after|ok|fail（单位 KB）
  const line = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const parts = line.split('|').map((x) => Number(x.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return { ok: false, supported: true, freedMb: 0, processes: 0, failed: 0, note, error: `无法解析系统返回：${line.slice(0, 120)}` };
  }
  const beforeKb = parts[0];
  const afterKb = parts[1];
  const freedKb = Math.max(0, afterKb - beforeKb);
  return {
    ok: true,
    supported: true,
    freedMb: Math.round((freedKb / 1024) * 10) / 10,
    processes: Number.isFinite(parts[2]) ? parts[2] : 0,
    failed: Number.isFinite(parts[3]) ? parts[3] : 0,
    note,
  };
}

/* ============================================================
 * ③ 清理游戏垃圾 RubbishClear()
 * ============================================================
 * ★ 三条安全底线（写死在代码里，不靠调用方自觉）：
 *   ① 只删白名单里的东西（日志 / 崩溃报告 / 下载残骸）
 *   ② 绝不触碰 saves / mods / config / resourcepacks / shaderpacks
 *   ③ 每个待删文件都要校验「真实路径在 .minecraft 之内」（防符号链接逃逸）
 * 删除动作交给上层用 shell.trashItem 走回收站，这里只做扫描与判定。
 */

/** 受保护的目录名（出现在路径里任何一个位置都拒绝删除） */
const PROTECTED_DIRS = ['saves', 'mods', 'config', 'resourcepacks', 'shaderpacks', 'screenshots', 'schematics'];

/** 清理规则：pattern 相对游戏根目录，keepDays=0 表示全删 */
const CLEAN_RULES = [
  { dir: 'logs', exts: ['.log', '.log.gz', '.gz'], keepDays: 3, label: '游戏日志' },
  { dir: 'crash-reports', exts: ['.txt', '.log'], keepDays: 7, label: '崩溃报告' },
  { dir: 'versions', exts: ['.log'], keepDays: 3, label: '版本日志', deep: true },
  { dir: path.join('..', 'logs'), exts: ['.log', '.log.gz'], keepDays: 7, label: '启动器日志', optional: true },
];

/** 下载残骸：全删（无论多久） */
const JUNK_EXTS = ['.part', '.tmp', '.download', '.bak'];

/** 把路径规范化后判断是否在 root 之内（防 ../ 与符号链接逃逸） */
function isInside(root, target) {
  try {
    const r = fs.realpathSync(root);
    const t = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
    const rel = path.relative(r, t);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** 路径里是否出现受保护目录名 */
function hitsProtected(p) {
  const segs = String(p).split(/[\\/]+/).map((s) => s.toLowerCase());
  return segs.some((s) => PROTECTED_DIRS.includes(s));
}

/** 递归收集文件（带深度限制，避免在超大目录里卡死） */
function walk(dir, opts = {}, out = [], depth = 0) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 6;
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        if (PROTECTED_DIRS.includes(e.name.toLowerCase())) continue;
        walk(full, opts, out, depth + 1);
      } else if (e.isFile()) {
        out.push(full);
      }
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return out;
}

/**
 * 扫描可清理的游戏垃圾（不删除任何东西）。
 * @param {string} gameRoot 游戏根目录（<instance>/.minecraft）
 * @param {{keepDaysOverride?:object}} [opts]
 * @returns {{ok:boolean, items:Array, totalBytes:number, totalCount:number, root:string, error?:string}}
 */
function scanRubbish(gameRoot, opts = {}) {
  const root = String(gameRoot || '');
  if (!root || !fs.existsSync(root)) {
    return { ok: false, items: [], totalBytes: 0, totalCount: 0, root, error: '游戏目录不存在' };
  }
  const now = Date.now();
  const items = [];
  const seen = new Set();

  const push = (file, keepDays, label) => {
    if (seen.has(file)) return;
    if (hitsProtected(file)) return;           // ② 保护目录
    if (!isInside(root, file)) return;         // ③ 必须在游戏目录内
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (keepDays > 0) {
      const ageDays = (now - st.mtimeMs) / 86400000;
      if (ageDays < keepDays) return;          // 太新，保留
    }
    seen.add(file);
    items.push({
      path: file,
      rel: path.relative(root, file).split(path.sep).join('/'),
      size: st.size,
      mtime: st.mtimeMs,
      label,
      keepDays,
    });
  };

  // 按规则扫描
  for (const rule of CLEAN_RULES) {
    const base = path.normalize(path.join(root, rule.dir));
    if (!fs.existsSync(base)) continue;
    if (rule.deep) {
      // versions/*/xxx.log —— 只下钻一层
      let subs = [];
      try {
        subs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      for (const sub of subs) {
        const sd = path.join(base, sub.name);
        let files = [];
        try {
          files = fs.readdirSync(sd, { withFileTypes: true }).filter((e) => e.isFile());
        } catch {
          continue;
        }
        for (const f of files) {
          if (rule.exts.some((x) => f.name.toLowerCase().endsWith(x))) push(path.join(sd, f.name), rule.keepDays, rule.label);
        }
      }
    } else {
      let files = [];
      try {
        files = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile());
      } catch {
        continue;
      }
      for (const f of files) {
        if (rule.exts.some((x) => f.name.toLowerCase().endsWith(x))) push(path.join(base, f.name), rule.keepDays, rule.label);
      }
    }
  }

  // 下载残骸：递归找（有深度限制），命中即删（keepDays=0）
  for (const file of walk(root, { maxDepth: 5 })) {
    const lower = file.toLowerCase();
    if (JUNK_EXTS.some((x) => lower.endsWith(x))) {
      // .bak 只在 libraries 下算垃圾（别的地方可能是玩家备份）
      if (lower.endsWith('.bak') && !/[\\/]libraries[\\/]/.test(lower)) continue;
      push(file, 0, '下载残骸');
    }
  }

  items.sort((a, b) => b.size - a.size);
  const totalBytes = items.reduce((s, x) => s + x.size, 0);
  return { ok: true, items, totalBytes, totalCount: items.length, root };
}

/**
 * 真正删除（由 IPC 层用 shell.trashItem 逐个移到回收站）。
 * 这里只做**最后一次**安全检查，返回允许删除的列表。
 * @param {string} gameRoot
 * @param {string[]} files
 */
function filterDeletable(gameRoot, files) {
  const root = String(gameRoot || '');
  const allow = [];
  const blocked = [];
  for (const f of Array.isArray(files) ? files : []) {
    const p = String(f || '');
    if (!p) continue;
    if (hitsProtected(p) || !isInside(root, p)) {
      blocked.push(p);
      continue;
    }
    allow.push(p);
  }
  return { allow, blocked };
}

/* ============================================================
 * ④ 磁盘占用统计
 * ============================================================
 * 按 .minecraft 一级子目录统计体积，降序 —— 让玩家自己看清谁占地方。
 * ★ 只统计、不删除（PCL 也是让玩家自己决定）。
 */

const USAGE_DIRS = [
  'versions', 'libraries', 'assets', 'mods', 'saves', 'resourcepacks',
  'shaderpacks', 'logs', 'crash-reports', 'screenshots', 'config', 'defaultconfigs',
];

/**
 * @param {string} gameRoot
 * @returns {{ok:boolean, root:string, total:{size:number,files:number},
 *            dirs:Array<{name:string,size:number,files:number}>, error?:string}}
 */
function diskUsage(gameRoot) {
  const root = String(gameRoot || '');
  if (!root || !fs.existsSync(root)) {
    return { ok: false, root, total: { size: 0, files: 0 }, dirs: [], error: '游戏目录不存在' };
  }

  const measure = (dir) => {
    let size = 0;
    let files = 0;
    const stack = [dir];
    let guard = 0;
    while (stack.length && guard < 200000) {
      const cur = stack.pop();
      guard += 1;
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        try {
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile()) {
            const st = fs.statSync(full);
            size += st.size;
            files += 1;
          }
        } catch {
          /* 单文件读不到就跳过 */
        }
      }
    }
    return { size, files };
  };

  const dirs = [];
  let totalSize = 0;
  let totalFiles = 0;
  for (const name of USAGE_DIRS) {
    const full = path.join(root, name);
    if (!fs.existsSync(full)) continue;
    const m = measure(full);
    totalSize += m.size;
    totalFiles += m.files;
    dirs.push({ name, size: m.size, files: m.files, path: full });
  }
  dirs.sort((a, b) => b.size - a.size);
  return { ok: true, root, total: { size: totalSize, files: totalFiles }, dirs };
}

/* ============================================================
 * ⑤ 回声洞 / 随机提示
 * ============================================================
 * PCL 是随机显示作者与网友留言。这里内置一批短句，**离线可用**；
 * 玩家反复点就不断换一条（这就是「反复点击这里」的含义）。
 * 不联网、不上报 —— 避免为了彩蛋引入网络依赖与隐私问题。
 */

const CAVES = [
  '这个洞很安静，只有你在回声。',
  '有人在洞里留了一句：先备份存档再装模组。',
  '岩壁上有刻痕：「1.7.10 才是永远的家」。',
  '洞里飘出一张纸：你的整合包又崩了，对吧。',
  '回声说：把 Java 参数调小一点，别贪。',
  '有人在这里丢了一把钻石镐，没人认领。',
  '洞顶滴下的水，正好落在一个空桶里。',
  '墙上有句话被划掉了，只剩「别挖脚下」。',
  '回声说：其实你不需要 200 个模组。',
  '一张泛黄的便签：这个种子出村庄。',
  '洞里堆着 64 个圆石，看起来是有人故意放的。',
  '有人用火把摆了个箭头，指向更深的地方。',
  '回声说：这次真的不崩了。',
  '岩缝里塞着一张纸条：「附魔台记得摆书架」。',
  '洞壁上画着一只苦力怕，画得挺像。',
  '有人留了个告示牌：此路不通，但风景不错。',
  '回声说：先把启动器更新到最新版。',
  '洞里有个箱子，空的，但上锁了。',
  '一句话被反复刻了三遍：「记得存档」。',
  '回声说：你其实可以不用红石。',
  '洞深处传来音乐，像是某张唱片。',
  '有人在这里睡了一觉，床还在。',
  '告示牌上写：如果你看到这句，说明你在摸鱼。',
  '回声说：那个 BUG 不是你的错。',
  '洞里有一滩水，映出你的脸。',
  '有人留了半组面包，应该是给下一个人的。',
  '回声说：存档文件其实还在，别慌。',
  '岩壁上有一行小字：「我也曾卡在加载界面」。',
  '洞里很冷，但比外面安全。',
  '回声说：模组冲突九成是前置没装。',
];

const HINTS = [
  '装模组前先看它要哪个加载器，Fabric 的模组扔进 Forge 是不会加载的。',
  '1.16.5 用 Java 8，1.20 用 Java 17，Java 版本不对会直接起不来。',
  '远古版本（alpha/beta）进不去世界，多半是缺了兼容参数，QCL 会自动加。',
  '存档在 saves/ 里，换启动器前先复制一份，最省心。',
  '游戏崩了先看 crash-reports/ 里最新那份，第一行通常就写着原因。',
  '内存不是越大越好，给 Java 分太多反而会让 GC 变慢。',
  '整合包导入后如果提示缺前置，用「模组管理」里的依赖检测一键补。',
  '显卡驱动太旧会让高版本游戏黑屏，先更新驱动再排查别的。',
  '问「为什么这么卡」之前，先看 F3 里的内存占用和区块加载数。',
  '备份实例比备份存档更彻底，配置和模组一起带走。',
];

/** 随机取一条（每次调用都可能不同） */
function randomFrom(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '';
  return arr[crypto.randomInt(0, arr.length)];
}

function getRandomCave() {
  return randomFrom(CAVES);
}

function getRandomHint() {
  return randomFrom(HINTS);
}

/* ============================================================
 * ⑥ 下载自定义文件 StartCustomDownload(url, fileName, folder)
 * ============================================================
 * PCL 主打「高速多线程引擎」。qcl-pc 已有 core/downloader.js（分块并发），
 * 但它是给游戏资源用的（带 sha1 校验、BMCLAPI 镜像改写）。
 * 自定义下载只需要「下到一个指定路径 + 报进度」，所以这里用 http.openStream
 * 单独写一个小引擎：单流 + 进度回调，避免把镜像改写逻辑套到任意 URL 上
 * （那会把玩家自己的下载地址改坏）。
 */

/**
 * 从 URL 推断文件名（等价 PCL 的 PathUtils.GetLastPart）。
 * 处理了 query / hash / 百分号编码；实在推断不出就用 download.bin。
 */
function fileNameFromUrl(url) {
  try {
    const u = new URL(String(url));
    let last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    last = last.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    if (!last || last === '.' || last === '..') return 'download.bin';
    // 去掉过长的扩展名乱码，保留原样但限长
    return last.slice(0, 180);
  } catch {
    return 'download.bin';
  }
}

/** 清理文件名里的非法字符 */
function safeFileName(name) {
  const s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return s.slice(0, 180) || 'download.bin';
}

/** 默认保存目录：<home>/MyDownload（对应 PCL 的 PCL/MyDownload） */
function defaultDownloadDir(home) {
  return path.join(paths.homeOf(home), 'MyDownload');
}

module.exports = {
  // ① 今日人品
  jrrp,
  hash32,
  // ② 内存优化
  memoryOptimize,
  // ③ 清理垃圾
  scanRubbish,
  filterDeletable,
  isInside,
  hitsProtected,
  PROTECTED_DIRS,
  CLEAN_RULES,
  // ④ 磁盘占用
  diskUsage,
  USAGE_DIRS,
  // ⑤ 回声洞
  getRandomCave,
  getRandomHint,
  CAVES,
  HINTS,
  // ⑥ 自定义下载
  fileNameFromUrl,
  safeFileName,
  defaultDownloadDir,
};
