'use strict';
/**
 * 服务端内网穿透 · frpc 引擎管理
 *
 * ★★★ 为什么用 frp（2026-11-22，用户纠正）：
 *
 * 我一开始想把 Terracotta 套到服务端上 —— **错了**。
 * Terracotta 是「MC 客户端开房间联机」用的：它扫本机游戏世界开的那个端口，
 * 把客户端之间打通。独立服务端（持久进程、固定端口、要 24 小时在线）不是它的场景。
 *
 * 服务端穿透的通行做法就是 **frp**（Fast Reverse Proxy）：
 *   · 大众所知、开源（fatedier/frp）、文档齐全
 *   · 服务端（frps）跑在有公网 IP 的机器上，客户端（frpc）跑在玩家这边
 *   · 配置就一份 TOML：把本机 127.0.0.1:25565 映射到服务器上的某个远程端口
 *
 * 参考实现取自隔壁「一键开服」开源项目的做法（Minexa / mineserve 的
 * FrpcBackend + FrpcProcessManager）：**写配置 → 起进程 → 读日志推进状态**。
 * Android 那边因为不能 execve 才需要 c-shared 版 libfrpc.so；
 * PC 上直接跑官方 frpc.exe 即可，更简单。
 *
 * 支持两种用法：
 *   ① **樱花frp（SakuraFrp）**：填 token，隧道在平台上建好，配置由官方 API 下发
 *      （见 core/sakurafrp.js）—— 玩家不用自己买服务器
 *   ② **自建 frp**：玩家有自己的 frps，填 serverAddr / serverPort / token / remotePort
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const paths = require('./paths');
const jsonstore = require('./jsonstore');

/** 官方 frp 版本（与樱花平台声明的版本对齐，避免字段集不匹配） */
const FRP_VERSION = '0.71.0';

/** 引擎安装目录 */
function engineDir(home) {
  return path.join(paths.homeOf(home), 'dependencies', 'frpc');
}
function exePath(home) {
  return path.join(engineDir(home), process.platform === 'win32' ? 'frpc.exe' : 'frpc');
}
function isInstalled(home) {
  try {
    return fs.statSync(exePath(home)).isFile();
  } catch {
    return false;
  }
}

/** 官方发布包的下载地址（带多个镜像回退） */
function downloadUrls() {
  const v = FRP_VERSION;
  const file = `frp_${v}_windows_amd64.zip`;
  const gh = `https://github.com/fatedier/frp/releases/download/v${v}/${file}`;
  return [
    gh,
    // 国内镜像回退（GitHub 直连在部分网络会静默超时）
    `https://ghfast.top/${gh}`,
    `https://gh-proxy.com/${gh}`,
    `https://ghproxy.net/${gh}`,
  ];
}

/**
 * 安装 frpc 引擎（下载官方 zip 并解出 frpc.exe）。
 * @param {{onLog?:Function, onProgress?:Function, signal?:AbortSignal}} options
 */
async function ensureInstalled(home, options = {}) {
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  if (isInstalled(home)) return { ok: true, path: exePath(home), cached: true };

  const dir = engineDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const http = require('./http');

  const urls = downloadUrls();
  let buf = null;
  let lastErr = null;
  for (const url of urls) {
    try {
      log(`正在下载 frpc 引擎：${url}`);
      // eslint-disable-next-line no-await-in-loop
      buf = await http.fetchBuffer(url, { timeoutMs: 180000, retries: 0 });
      if (buf && buf.length > 100000) break;
      buf = null;
    } catch (err) {
      lastErr = err;
      log(`这个源不行，换下一个（${err.message.slice(0, 60)}）`);
    }
  }
  if (!buf) {
    throw new Error(`frpc 引擎下载失败：${lastErr ? lastErr.message : '所有源都不可用'}`);
  }

  const zipPath = path.join(dir, `frp_${FRP_VERSION}_windows_amd64.zip`);
  fs.writeFileSync(zipPath, buf);
  log(`已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB，正在解压…`);

  const ExtractZip = require('extract-zip');
  const tmpDir = path.join(dir, '_unzip');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await ExtractZip(zipPath, { dir: tmpDir });

  // 官方 zip 里是 frp_x.y.z_windows_amd64/frpc.exe
  let found = null;
  const stack = [tmpDir];
  let guard = 0;
  while (stack.length && guard < 500 && !found) {
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
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /^frpc(\.exe)?$/i.test(e.name)) {
        found = full;
        break;
      }
    }
  }
  if (!found) throw new Error('下载的 frp 包里没找到 frpc 可执行文件');

  fs.copyFileSync(found, exePath(home));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }
  log(`frpc 引擎已就绪：${exePath(home)}`);
  return { ok: true, path: exePath(home), cached: false };
}

/* ============================================================
 * 配置生成（自建 frp）
 * ============================================================ */

/**
 * 生成 frpc TOML 配置（自建 frps 用）。
 *
 * frp 0.52+ 用 TOML；老版本用 ini。这里统一用 TOML（0.71 已不支持 ini 新写法）。
 *
 * @param {{serverAddr, serverPort, authToken, proxyName, localIp, localPort, remotePort, useTls}} cfg
 */
function buildToml(cfg) {
  const c = cfg || {};
  const addr = String(c.serverAddr || '').trim();
  if (!addr) throw new Error('没填 frp 服务器地址');
  const serverPort = Number(c.serverPort) || 7000;
  const localPort = Number(c.localPort) || 25565;
  const remotePort = Number(c.remotePort) || 0;
  const name = String(c.proxyName || 'qcl-mc-server').replace(/[^A-Za-z0-9_-]/g, '_');

  const lines = [
    '# 由 QCL 电脑版生成 —— 服务端内网穿透',
    `serverAddr = "${addr}"`,
    `serverPort = ${serverPort}`,
  ];
  const token = String(c.authToken || '').trim();
  if (token) lines.push(`auth.token = "${token}"`);
  if (c.useTls) lines.push('transport.tls.enable = true');
  lines.push(
    '',
    '[[proxies]]',
    `name = "${name}"`,
    'type = "tcp"',
    `localIP = "${String(c.localIp || '127.0.0.1')}"`,
    `localPort = ${localPort}`,
    `remotePort = ${remotePort || localPort}`,
    ''
  );
  return lines.join('\n');
}

/* ============================================================
 * 进程管理
 * ============================================================ */

/** 单例运行时 */
let running = null;

function status() {
  if (!running) return { running: false };
  return {
    running: !running.stopped,
    pid: running.child ? running.child.pid : null,
    startedAt: running.startedAt,
    uptimeMs: running.stopped ? 0 : Date.now() - running.startedAt,
    configPath: running.configPath,
    autoRemote: running.autoRemote || null,
    lines: (running.lines || []).slice(-200),
    exitCode: running.exitCode,
    error: running.lastError,
  };
}

/**
 * 启动隧道。
 * @param {{home, configText, onLog?:Function, onState?:Function}} options
 */
async function start(options = {}) {
  const home = options.home;
  if (running && !running.stopped) {
    throw new Error('穿透已经在运行，先停止当前隧道');
  }
  if (!isInstalled(home)) {
    throw new Error('frpc 引擎还没装，先点「准备穿透组件」');
  }

  const dir = path.join(engineDir(home), 'tunnels');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const configPath = path.join(dir, `frpc-${stamp}.toml`);
  fs.writeFileSync(configPath, String(options.configText || ''), 'utf8');

  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  const onState = typeof options.onState === 'function' ? options.onState : () => {};

  const rt = {
    startedAt: Date.now(),
    stopped: false,
    exitCode: null,
    lastError: '',
    lines: [],
    configPath,
    child: null,
    autoRemote: null,
  };

  log(`启动 frpc：${exePath(home)} -c ${path.basename(configPath)}`);
  const child = spawn(exePath(home), ['-c', configPath], {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rt.child = child;
  running = rt;

  const emit = (line) => {
    const text = String(line);
    rt.lines.push(text);
    if (rt.lines.length > 1500) rt.lines.splice(0, rt.lines.length - 1500);
    try {
      log(text);
    } catch {
      /* ignore */
    }
    /**
     * ★ 从日志里捞公网地址。
     * frpc 成功时打的是：
     *   [mc-server] start proxy success
     *   [mc-server] tcp://xxx.natfrp.cloud:12345
     * 或自建时：start error / login to server success 等。
     */
    const okLine = /start (?:proxy|tunnel) success/i.test(text);
    if (okLine) onState('running', '隧道已建立');
    // 带 host:port 的行
    const m = /([a-z0-9.-]+\.(?:natfrp\.cloud|com|net|cn|top|xyz|site|frp[a-z0-9.]*)|[\d.]+):(\d{2,5})/i.exec(text);
    if (m && /tcp:|start proxy success|start tunnel success/i.test(text)) {
      rt.autoRemote = `${m[1]}:${m[2]}`;
      onState('running', `公网地址：${rt.autoRemote}`);
    }
    if (/login to server failed|authentication failed|token/i.test(text) && /fail|error/i.test(text)) {
      rt.lastError = '认证失败：token 不对，或服务端不接受这个 token';
    } else if (/connect(?:ion)? refused|i\/o timeout|dial tcp/i.test(text)) {
      rt.lastError = '连不上 frp 服务器：检查 serverAddr / serverPort，或服务器没开';
    } else if (/port already (?:in )?use|bind/i.test(text)) {
      rt.lastError = '远程端口已被占用：换一个 remotePort';
    }
  };

  const pipe = (stream, tag) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx = buf.search(/\r?\n/);
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' && buf[idx + 1] === '\n' ? 2 : 1));
        if (line.trim()) emit(tag === 'err' ? `[错误] ${line}` : line);
        idx = buf.search(/\r?\n/);
      }
    });
    stream.on('end', () => {
      if (buf.trim()) emit(tag === 'err' ? `[错误] ${buf}` : buf);
    });
  };
  pipe(child.stdout, 'out');
  pipe(child.stderr, 'err');

  child.on('error', (err) => {
    rt.lastError = `进程错误：${err.message}`;
  });
  child.on('exit', (code) => {
    rt.stopped = true;
    rt.exitCode = code;
    if (!rt.lastError && code !== 0) rt.lastError = `frpc 退出（退出码 ${code}）`;
    onState('stopped', rt.lastError || '已停止');
  });

  onState('starting', '正在连接 frp 服务器…');
  return { ok: true, pid: child.pid, configPath };
}

/** 停止隧道 */
async function stop() {
  if (!running || running.stopped) return { ok: true, already: true };
  const rt = running;
  try {
    if (process.platform === 'win32' && rt.child && rt.child.pid) {
      execFileSync('taskkill', ['/PID', String(rt.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    } else if (rt.child) {
      rt.child.kill('SIGTERM');
    }
  } catch {
    try {
      rt.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  const start = Date.now();
  while (!rt.stopped && Date.now() - start < 6000) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: true, stopped: rt.stopped };
}

/** 诊断（把 frpc 的英文报错翻成能照做的建议） */
function diagnose() {
  const rt = running;
  if (!rt) return { ok: false, summary: '还没启动过穿透' };
  const out = (rt.lines || []).join('\n');
  const hints = [];
  if (/login to server failed|authentication failed/i.test(out)) hints.push('token 不对：去 frp 服务器或樱花平台核对 token');
  if (/connect(?:ion)? refused|i\/o timeout|dial tcp/i.test(out)) hints.push('连不上服务器：检查地址/端口，确认 frps 在运行、防火墙放行');
  if (/port already (?:in )?use/i.test(out)) hints.push('远程端口被占用：换一个 remotePort');
  if (/no such host/i.test(out)) hints.push('域名解析失败：地址写错了');
  if (!hints.length && rt.exitCode === 0) hints.push('frpc 正常退出');
  return {
    ok: true,
    exitCode: rt.exitCode,
    autoRemote: rt.autoRemote,
    summary: rt.lastError || (rt.stopped ? '已停止' : '运行中'),
    hints,
    tail: (rt.lines || []).slice(-25),
  };
}

module.exports = {
  FRP_VERSION,
  engineDir,
  exePath,
  isInstalled,
  downloadUrls,
  ensureInstalled,
  buildToml,
  start,
  stop,
  status,
  diagnose,
};
