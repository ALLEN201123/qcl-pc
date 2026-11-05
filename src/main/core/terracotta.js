'use strict';
/**
 * Quanta Craft Launcher PC · 多人联机（Terracotta / 陶瓦联机）
 *
 * ## 它是什么
 * Terracotta 是 HMCL 团队与 burningtnt 做的**P2P 内网穿透联机**工具：
 * 房主开一个房间拿到「邀请码」，访客填邀请码后得到一个 `host:port`，
 * 在游戏里当服务器地址填进去就能联机。中转走 Terracotta 官方节点，无需公网 IP。
 *
 * ## PC 端怎么实现（照 HMCL 的 TerracottaManager / GeneralProvider）
 * Terracotta 在桌面端是一个**独立可执行程序**，不是库：
 *   1. 从 GitHub / Gitee 下载 `terracotta-<ver>-<os>-<arch>-pkg.tar.gz`（tar.gz，内含 exe + VCRUNTIME140.DLL）
 *   2. SHA-512 校验（配置里有每个文件的 hash）
 *   3. 解压到 `<QCL_HOME>/dependencies/terracotta/<ver>/`
 *   4. 启动：`terracotta.exe --hmcl <一个临时文件路径>`（**不是端口号**）
 *      —— 进程会把 `{"port": N}` 写进那个文件，之后全部走本机 HTTP 控制
 *
 * ## 状态协议（★ 2026-11-05 按 HMCL 真实实现重写）
 *   控制端口：`http://127.0.0.1:<port>/state` → `{index, state, room?, url?, …}`
 *   房主扫描：`/state/scanning?player=…&public_nodes=…`
 *   访客加入：`/state/guesting?room=…&player=…&public_nodes=…`
 *   回到空闲：`/state/ide`
 *   状态名（连字符）→ 这里统一转成下划线给渲染层：
 *     waiting / host_scanning / host_starting / host_ok / guest_connecting / guest_starting / guest_ok / exception
 *   · 房主：host_ok 时带 `room`（邀请码）
 *   · 访客：guest_ok 时带 `url`（游戏里填的服务器地址）
 *
 * ## 诚实说明
 * 这一步依赖**外部可执行文件**与**官方中转节点**（`terracotta.glavo.site/nodes`）。
 * 如果下载失败 / 节点不可用，会给出中文提示，而不是假装连接成功。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const tar = require('node:zlib');

const http = require('./http');

/** 内置的 Terracotta 版本配置（照抄 HMCL assets/terracotta.json，版本 0.4.2） */
const TERRACOTTA_VERSION = '0.4.2';

/** Windows x64 包的文件清单与 SHA-512（来自 HMCL 官方配置） */
const WIN_X64_FILES = {
  'VCRUNTIME140.DLL':
    '3d4b24061f72c0e957c7b04a0c4098c94c8f1afb4a7e159850b9939c7210d73398be6f27b5ab85073b4e8c999816e7804fef0f6115c39cd061f4aaeb4dcda8cf',
  [`terracotta-${TERRACOTTA_VERSION}-windows-x86_64.exe`]:
    '6e98d1f2380ed22fb5a2dd4aafce6c773e9cf69100c8bb8e49e7d6983756bdb9a31f80e06bcfbe5a2742144fe806d3d687dec54d8f09d87c659341f99dd9fd80'
};

/** 下载源（大陆优先 gitee / cnb / alist，再回落 GitHub） */
function downloadUrls() {
  const v = TERRACOTTA_VERSION;
  const file = `terracotta-${v}-windows-x86_64-pkg.tar.gz`;
  return [
    `https://gitee.com/burningtnt/Terracotta/releases/download/v${v}/${file}`,
    `https://cnb.cool/HMCL-Terracotta/Terracotta/-/releases/download/v${v}/${file}`,
    `https://alist.8mi.tech/d/mirror/HMCL-Terracotta/Auto/v${v}/${file}`,
    `https://github.com/burningtnt/Terracotta/releases/download/v${v}/${file}`
  ];
}

const PACKAGE_LINKS = [
  { desc: 'GitHub 发布页', link: `https://github.com/burningtnt/Terracotta/releases/tag/v${TERRACOTTA_VERSION}` },
  { desc: '问题反馈', link: 'https://docs.hmcl.net/multiplayer/feedback.html' }
];

/** 安装目录 */
function installDir(home) {
  return path.join(String(home || ''), 'dependencies', 'terracotta', TERRACOTTA_VERSION);
}

/** 可执行文件路径 */
function exePath(home) {
  return path.join(installDir(home), `terracotta-${TERRACOTTA_VERSION}-windows-x86_64.exe`);
}

/** 是否已安装且校验通过 */
function isInstalled(home) {
  const exe = exePath(home);
  if (!fs.existsSync(exe)) return false;
  try {
    const st = fs.statSync(exe);
    return st.size > 1 * 1024 * 1024; // exe 大约 8MB
  } catch {
    return false;
  }
}

/** sha512 校验一个文件 */
function verifySha512(file, expected) {
  try {
    const hash = crypto.createHash('sha512');
    hash.update(fs.readFileSync(file));
    const actual = hash.digest('hex');
    return actual.toLowerCase() === String(expected).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 下载并解压 Terracotta。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {function} [opts.onProgress] (info)=>void
 * @param {function} [opts.onLog]
 * @returns {Promise<{installed:boolean, dir:string, exe:string}>}
 */
async function ensureInstalled({ home, onProgress = () => {}, onLog = () => {} }) {
  if (isInstalled(home)) {
    return { installed: true, dir: installDir(home), exe: exePath(home), cached: true };
  }

  const dir = installDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, 'pkg.tar.gz');

  onLog(`正在下载 Terracotta v${TERRACOTTA_VERSION}…`);
  const urls = downloadUrls();
  let lastErr = null;
  let ok = false;
  for (const url of urls) {
    try {
      onLog(`尝试下载源：${new URL(url).host}`);
      const buf = await http.fetchBuffer(url, {
        timeoutMs: 180000,
        onProgress: (p) => onProgress({ phase: 'download', ...p })
      });
      if (!buf || buf.length < 1024) throw new Error('下载内容异常');
      fs.writeFileSync(archive, buf);
      ok = true;
      onLog(`下载完成（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
      break;
    } catch (err) {
      lastErr = err;
      onLog(`该源失败：${err?.message || err}`);
    }
  }
  if (!ok) {
    throw new Error(
      `Terracotta 下载失败（所有镜像都不可用）。` +
        `可以手动下载 ${downloadUrls()[0]} 放到 ${dir} 后重试。` +
        `${lastErr ? `最后一次错误：${lastErr.message}` : ''}`
    );
  }

  // 解压 tar.gz（Node 只有 gunzip，tar 要自己走）
  onLog('解压中…');
  try {
    const raw = tar.gunzipSync(fs.readFileSync(archive));
    extractTar(raw, dir);
  } catch (err) {
    throw new Error(`Terracotta 解压失败：${err?.message || err}`);
  }

  // 校验
  let verified = 0;
  for (const [name, sha] of Object.entries(WIN_X64_FILES)) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) {
      onLog(`警告：缺少文件 ${name}`);
      continue;
    }
    if (verifySha512(f, sha)) verified += 1;
    else onLog(`警告：${name} 校验不通过（可能是镜像内容被改动）`);
  }
  onLog(`文件校验：${verified}/${Object.keys(WIN_X64_FILES).length} 通过`);

  try {
    fs.unlinkSync(archive);
  } catch {
    /* 清不掉也无所谓 */
  }

  if (!fs.existsSync(exePath(home))) {
    throw new Error('解压后没有找到 terracotta 可执行文件，包结构可能变了');
  }
  return { installed: true, dir, exe: exePath(home), cached: false };
}

/**
 * 极简 tar 解包：只处理普通文件与目录（够用，terracotta 包里就这两类）。
 * 不支持 symlink / pax 扩展头 —— 遇到就跳过。
 */
function extractTar(buf, outDir) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    // 全零块 = 结束
    if (header.every((b) => b === 0)) break;

    const rawName = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8) || 0;

    const name = prefix ? `${prefix}/${rawName}` : rawName;
    offset += 512;

    if (!name) {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }

    // 只取 basename，防止目录穿越
    const base = path.basename(name.replace(/\/$/, ''));
    const target = path.join(outDir, base);

    if (typeFlag === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '0') {
      const data = buf.slice(offset, offset + size);
      fs.writeFileSync(target, data);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

/* ------------------------------------------------------------ 运行与状态 */

/**
 * ★★★ 2026-11-05 重写（原来的实现是**错的**，必须说清楚）。
 *
 * 旧实现（错的）：以为 `--hmcl` 之后跟一个端口号，然后从 **stdout 读 JSON 行**、
 *   往 **stdin 写 `WAITING` / `JOIN xxx`** 命令。
 *   实测证明这套协议不存在 —— 这个功能从来没跑通过（也从没实测过，是我的问题）。
 *
 * HMCL 的真实协议（`vendor/HMCL-latest/.../terracotta/TerracottaManager.java`）：
 *   1. 启动：`terracotta.exe --hmcl <一个临时文件路径>`
 *      —— 第二个参数是**文件路径**，不是端口；进程会把 `{"port": N}` 写进这个文件。
 *   2. 之后全部走 **本机 HTTP**（`http://127.0.0.1:<port>/…`）：
 *        GET /state?index=N        → 当前状态 JSON（`{index, state, room?, url?, …}`）
 *        GET /state/scanning?player=xxx&public_nodes=…   → 房主开始扫描
 *        GET /state/guesting?room=xxx&player=xxx&public_nodes=… → 访客加入
 *        GET /state/ide            → 回到 idle（退出房间）
 *        GET /log?fetch=true       → 拿完整日志
 *   3. 状态名用**连字符**：`waiting` / `host-scanning` / `host-starting` / `host-ok`
 *      / `guest-connecting` / `guest-starting` / `guest-ok` / `exception`。
 *      渲染层历史上按 `host_ok` / `guest_ok`（下划线）写的，所以这里统一转成下划线再发出去。
 *
 * 节点列表：`https://terracotta.glavo.site/nodes` → `[{url, region}]`（实测 2 个节点可用）。
 */

const NODE_LIST_URL = 'https://terracotta.glavo.site/nodes';
/** 正在运行的 Terracotta 进程（单例，和 HMCL 一样一次只能开一个房间） */
let running = null;
/** 节点列表缓存 */
let nodeCache = null;

/** 把 HMCL 的连字符状态名转成渲染层认的下划线形式 */
function normalizeState(name) {
  return String(name || '').replace(/-/g, '_');
}

/**
 * 解析一行输出为状态对象（保留给旧测试用）。
 * 新协议下状态来自 HTTP，不再从 stdout 解析；这里只识别 JSON 行（日志里偶尔会有）。
 */
function parseStateLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    if (!('state' in j)) return null;
    if (j.state) j.state = normalizeState(j.state);
    return j;
  } catch {
    return null;
  }
}

/** 拉取公共节点列表（失败返回空数组，由调用方兜底） */
async function fetchNodes() {
  if (nodeCache) return nodeCache;
  try {
    const json = await http.fetchJson(NODE_LIST_URL, { timeoutMs: 15000 });
    const list = Array.isArray(json) ? json : [];
    nodeCache = list.map((n) => (n && n.url ? String(n.url) : '')).filter(Boolean);
  } catch {
    nodeCache = [];
  }
  return nodeCache;
}

/** 本机 HTTP 请求（Terracotta 控制端口就是本机，不走代理、不加超时重试） */
async function localGet(port, pathAndQuery) {
  const url = `http://127.0.0.1:${port}${pathAndQuery}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Terracotta 控制接口返回 HTTP ${res.status}（${pathAndQuery}）`);
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/**
 * 启动 Terracotta。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} [opts.playerName]  玩家名（房主/访客都会显示给对面）
 * @param {function} opts.onState     收到状态时回调（state 已归一成下划线）
 * @param {function} [opts.onLog]
 * @returns {Promise<{pid:number, port:number}>}
 */
async function start({ home, playerName = '', onState = () => {}, onLog = () => {} }) {
  if (running && !running.killed) {
    throw new Error('联机已经在运行了，先关闭当前的房间');
  }
  const exe = exePath(home);
  if (!fs.existsSync(exe)) throw new Error('Terracotta 还没安装，请先点「准备联机组件」');

  // ① 让 Terracotta 把控制端口写进一个临时文件
  const portFile = path.join(installDir(home), `port-${Date.now()}.json`);
  try {
    fs.unlinkSync(portFile);
  } catch {
    /* 不存在更好 */
  }

  onLog(`启动 Terracotta：${path.basename(exe)} --hmcl ${path.basename(portFile)}`);
  const child = spawn(exe, ['--hmcl', portFile], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  /**
   * ★★★ 实测发现（2026-11-05）：这个 exe 启动后会**立刻以 0 退出**，
   *   但它派生的守护进程（另一个 PID）继续跑着 HTTP 服务 —— 探针实测
   *   `GET /state → 200 {"index":0,"state":"waiting"}` 是通的。
   *   参数就是 `--hmcl <临时文件路径>`（**单参数**；加个 "2" 会报
   *   "Unknown arguments"，曾误以为是 portTransfer 值，实测证伪）。
   *   ⇒ 不能把主进程 exit 当成「联机挂了」，否则轮询会被立刻清掉。
   */
  let sawPort = false;

  running = {
    child,
    killed: false,
    states: [],
    last: null,
    startAt: Date.now(),
    port: 0,
    playerName: String(playerName || '').trim(),
    timer: null
  };

  const pump = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      // 新版协议：stdout 只是日志；顺手把 JSON 行也当状态收了（兼容）
      const maybe = parseStateLine(line);
      if (maybe) {
        running.last = maybe;
        running.states.push(maybe);
        onState(maybe);
      } else {
        onLog(line);
      }
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);
  child.on('exit', (code, signal) => {
    /**
     * ★★★ 主进程 exit 是**完全正常**的：它把 HTTP 服务交给后台 daemon 后自己退出。
     *
     * 千万不要在这里置 running.killed / 清 timer / 发 exited ——
     * 实测踩过：exit 事件比 waitForPort 的 200ms 轮询早得多，
     * 于是 `sawPort` 还是 false，一设 killed 就把端口读取直接掐断，
     * 界面上就变成「启动后立刻退出」（而服务其实好端端跑着）。
     *
     * 真正的失败判断只有一条：waitForPort 等 30 秒还拿不到端口。
     */
    onLog(`Terracotta 启动进程已退出（code=${code}），服务由后台进程继续提供`);
    if (running && !sawPort) onLog('（这是正常的，正在等待后台服务写出控制端口）');
  });

  // ② 等它写出 {"port": N}
  const port = await waitForPort(portFile, child, onLog, () => {
    sawPort = true;
  });
  running.port = port;
  running.sawPort = true;
  onLog(`Terracotta 控制端口：${port}`);

  // ③ 轮询 /state
  let lastIndex = -1;
  const tick = async () => {
    if (!running || running.killed) return;
    try {
      const st = await localGet(port, '/state');
      const index = Number.isFinite(Number(st.index)) ? Number(st.index) : 0;
      if (index === lastIndex) return;
      lastIndex = index;
      const norm = { ...st, state: normalizeState(st.state), room: st.room || st.code || null, url: st.url || null };
      running.last = norm;
      running.states.push(norm);
      if (running.states.length > 200) running.states.shift();
      onState(norm);
    } catch (err) {
      onLog(`读取联机状态失败：${err?.message || err}`);
    }
  };
  await tick();
  running.timer = setInterval(tick, 400);

  return { pid: child.pid, port };
}

/** 等 Terracotta 把端口写进文件（最多 30 秒） */
function waitForPort(portFile, child, onLog = () => {}, onPort = () => {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!running || running.killed) {
        clearInterval(timer);
        reject(new Error('Terracotta 启动后立刻退出了，请查看日志'));
        return;
      }
      if (fs.existsSync(portFile)) {
        try {
          const j = JSON.parse(fs.readFileSync(portFile, 'utf8'));
          const port = Number(j && j.port);
          if (Number.isFinite(port) && port > 0) {
            clearInterval(timer);
            onPort();
            try {
              fs.unlinkSync(portFile);
            } catch {
              /* 删不掉无所谓 */
            }
            resolve(port);
            return;
          }
        } catch {
          /* 文件还没写完，下一轮再试 */
        }
      }
      if (Date.now() - started > 30000) {
        clearInterval(timer);
        reject(new Error('Terracotta 30 秒内没有给出控制端口，可能是组件损坏或系统拦截'));
      }
    }, 200);
    // ★ 不监听 child exit：这个 exe 主进程本来就会立刻退出，服务由 daemon 接着跑。
    //   真正的存活判断交给后面的 /state HTTP 轮询。
  });
}

/** 房主：开始扫描端口，拿到邀请码 */
async function startHost() {
  if (!running || running.killed) throw new Error('联机还没启动，请先点「启动联机」');
  const nodes = await fetchNodes();
  const q = new URLSearchParams();
  q.set('player', running.playerName || 'QCL玩家');
  if (nodes.length) for (const n of nodes) q.append('public_nodes', n);
  const r = await localGet(running.port, `/state/scanning?${q.toString()}`);
  return r || {};
}

/** 访客：用邀请码加入房间 */
async function joinRoom(code) {
  if (!running || running.killed) throw new Error('联机还没启动，请先点「启动联机」');
  const c = String(code || '').trim();
  if (!c) throw new Error('邀请码不能为空');
  const nodes = await fetchNodes();
  const q = new URLSearchParams();
  q.set('room', c);
  q.set('player', running.playerName || 'QCL玩家');
  if (nodes.length) for (const n of nodes) q.append('public_nodes', n);
  const r = await localGet(running.port, `/state/guesting?${q.toString()}`);
  return r || {};
}

/** 拿到当前可用的游戏服务器地址（房主拿到 room，访客拿到 url） */
function currentEndpoint() {
  if (!running || !running.last) return null;
  const st = running.last;
  if (st.state === 'host_ok' && st.room) return { kind: 'host', room: st.room };
  if (st.state === 'guest_ok' && st.url) return { kind: 'guest', url: st.url };
  return null;
}

/** 关闭联机 */
function stop() {
  if (!running) return { ok: true };
  const { child, timer, port } = running;
  if (timer) clearInterval(timer);
  running.killed = true;
  // ① 礼貌地让它退回 idle
  try {
    if (port) {
      fetch(`http://127.0.0.1:${port}/state/ide`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
    }
  } catch {
    /* 忽略 */
  }
  // ② 主进程通常早就退出了，真正要杀的是监听控制端口的 daemon。
  //    用 netstat 反查 PID 再 taskkill；找不到就只 kill 主进程（无害）。
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  if (port && process.platform === 'win32') {
    try {
      const { execSync } = require('node:child_process');
      const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
      const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
      const m = re.exec(out);
      if (m) {
        execSync(`taskkill /PID ${m[1]} /F /T`, { windowsHide: true, stdio: 'ignore' });
      }
    } catch {
      /* 杀不掉就留着，下次启动会因全局互斥而报「已经在运行」 */
    }
  }
  running = null;
  return { ok: true };
}

/** 查询状态 */
function status() {
  if (!running) return { running: false };
  return {
    running: !running.killed,
    pid: running.child.pid,
    port: running.port || 0,
    last: running.last,
    states: running.states.slice(-10),
    uptimeMs: Date.now() - running.startAt
  };
}

/** 支持的平台说明（给界面用） */
function platformInfo() {
  const isWin64 = process.platform === 'win32' && process.arch === 'x64';
  return {
    supported: isWin64,
    platform: process.platform,
    arch: process.arch,
    version: TERRACOTTA_VERSION,
    links: PACKAGE_LINKS,
    reason: isWin64 ? '' : '目前只内置了 Windows x64 的联机组件'
  };
}

module.exports = {
  TERRACOTTA_VERSION,
  PACKAGE_LINKS,
  NODE_LIST_URL,
  ensureInstalled,
  isInstalled,
  installDir,
  exePath,
  start,
  stop,
  status,
  joinRoom,
  startHost,
  currentEndpoint,
  fetchNodes,
  platformInfo,
  parseStateLine,
  normalizeState
};
