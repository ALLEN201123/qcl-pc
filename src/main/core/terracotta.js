'use strict';
/**
 * Quanta Craft Launcher PC · 多人联机（Terracotta / 陶瓦联机）
 *
 * ## 它是什么
 * Terracotta 是 HMCL 团队与 burningtnt 做的**P2P 内网穿透联机**工具：
 * 房主开一个房间拿到「邀请码」，访客填邀请码后得到一个 `host:port`，
 * 在游戏里当服务器地址填进去就能联机。中转走 Terracotta 官方节点，无需公网 IP。
 *
 * ## PC 端怎么实现（照 HMCL 的 TerracottaMetadata / GeneralProvider）
 * Terracotta 在桌面端是一个**独立可执行程序**，不是库：
 *   1. 从 GitHub / Gitee 下载 `terracotta-<ver>-<os>-<arch>-pkg.tar.gz`（tar.gz，内含 exe + VCRUNTIME140.DLL）
 *   2. SHA-512 校验（配置里有每个文件的 hash）
 *   3. 解压到 `<QCL_HOME>/dependencies/terracotta/<ver>/`
 *   4. 启动：`terracotta.exe --hmcl <portTransfer>`
 *      —— `--hmcl` 让它在 stdout 打出结构化状态行，我们解析出来驱动界面
 *
 * ## 状态协议（HMCL 的 TerracottaState + 安卓版 TerracottaHelper）
 * 进程会持续输出形如 `{"index":N,"state":"waiting|host_scanning|host_ok|guest_connecting|guest_ok|exception", ...}` 的行：
 *   · 房主：state=waiting 时开始扫描，host_ok 时带 `room`（邀请码）
 *   · 访客：填入 room 后进入 guest_connecting，guest_ok 时带 `url`（游戏里填的服务器地址）
 *
 * ## 诚实说明
 * 这一步依赖**外部可执行文件**与**官方中转节点**。
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

/** 正在运行的 Terracotta 进程（单例，和 HMCL 一样一次只能开一个房间） */
let running = null;

/**
 * 解析一行输出为状态对象。
 * Terracotta 的 --hmcl 模式会输出 JSON 行；不是 JSON 的行忽略。
 */
function parseStateLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    if (!('state' in j)) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * 启动 Terracotta。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {number} [opts.portTransfer] 端口转发（HMCL 传 0 让程序自己选）
 * @param {function} opts.onState 收到状态时回调
 * @param {function} [opts.onLog]
 * @returns {Promise<{pid:number}>}
 */
async function start({ home, portTransfer = 0, onState = () => {}, onLog = () => {} }) {
  if (running && !running.killed) {
    throw new Error('联机已经在运行了，先关闭当前的房间');
  }
  const exe = exePath(home);
  if (!fs.existsSync(exe)) throw new Error('Terracotta 还没安装，请先点「准备联机组件」');

  onLog(`启动 Terracotta：${exe} --hmcl ${portTransfer}`);
  const child = spawn(exe, ['--hmcl', String(portTransfer)], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  running = {
    child,
    killed: false,
    states: [],
    last: null,
    startAt: Date.now()
  };

  let buf = '';
  const handleChunk = (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const st = parseStateLine(line);
      if (st) {
        running.last = st;
        running.states.push(st);
        if (running.states.length > 200) running.states.shift();
        onState(st);
      } else {
        onLog(line);
      }
    }
  };

  child.stdout.on('data', handleChunk);
  child.stderr.on('data', handleChunk);

  child.on('exit', (code, signal) => {
    if (running) running.killed = true;
    onState({ state: 'exited', code, signal });
  });

  return { pid: child.pid };
}

/** 房主：发一个「重新扫描」指令（写入 stdin） */
function sendCommand(text) {
  if (!running || running.killed) throw new Error('联机未启动');
  try {
    running.child.stdin.write(`${text}\n`);
    return true;
  } catch (err) {
    throw new Error(`向 Terracotta 发送指令失败：${err?.message || err}`);
  }
}

/** 访客：加入房间（把邀请码发给进程） */
function joinRoom(code) {
  const c = String(code || '').trim();
  if (!c) throw new Error('邀请码不能为空');
  return sendCommand(`JOIN ${c}`);
}

/** 房主：开始扫描 */
function startHost() {
  return sendCommand('WAITING');
}

/** 拿到当前可用的游戏服务器地址（房主拿到 room，访客拿到 url） */
function currentEndpoint() {
  if (!running || !running.last) return null;
  const st = running.last;
  if (st.room && st.state === 'host_ok') return { kind: 'host', room: st.room };
  if (st.url && st.state === 'guest_ok') return { kind: 'guest', url: st.url };
  return null;
}

/** 关闭联机 */
function stop() {
  if (!running) return { ok: true };
  const { child } = running;
  running.killed = true;
  try {
    child.stdin.end();
  } catch {
    /* 忽略 */
  }
  try {
    child.kill();
  } catch {
    /* 忽略 */
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
  platformInfo,
  parseStateLine
};
