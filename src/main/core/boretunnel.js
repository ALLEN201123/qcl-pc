'use strict';
/**
 * bore 隧道（纯 Node 实现，不需要任何外部二进制）
 *
 * ★ 为什么值得内置：
 *   frp 需要一份 frpc.exe（13 MB）和一台有公网 IP 的 frps。
 *   **bore 是一个极简的反向隧道协议**，服务端是公开的（bore.pub），
 *   协议简单到可以直接在 Node 里实现，不需要下载任何可执行文件。
 *
 * 协议（照隔壁开源项目 BoreBackend.kt 的实现，逐条对齐）：
 *   1. 连上 bore 服务端（默认 bore.pub:7835）
 *   2. 发一行 JSON：`{"Hello":<本地端口>}\n`
 *   3. 服务端回：`{"Hello":<分配的公网端口>}\n`
 *   4. 然后服务端会推 `{"Connection":"<uuid>"}\n`
 *      → 客户端再连一条数据连接，发 `{"Accept":"<uuid>"}` 完成握手
 *      → 之后这条连接就双向转发到本地端口
 *
 * 限制（必须跟玩家说清楚）：
 *   · 公共 bore.pub 的端口是**随机分配**的，每次都不一样
 *   · 没有鉴权，任何人都能连到分配给你的端口
 *   · 延迟取决于 bore.pub 的线路
 *   所以它适合「临时和朋友玩一会儿」，正式服还是用 frp + 自建 frps。
 */

const net = require('node:net');

/** 默认公共 bore 服务端 */
const DEFAULT_SERVER = 'bore.pub';
const DEFAULT_PORT = 7835;

/** 运行态 */
let rt = null;

function status() {
  if (!rt) return { running: false };
  return {
    running: !rt.stopped,
    publicAddr: rt.publicAddr || '',
    server: rt.server,
    localPort: rt.localPort,
    startedAt: rt.startedAt,
    uptimeMs: rt.stopped ? 0 : Date.now() - rt.startedAt,
    lines: (rt.lines || []).slice(-150),
    exitCode: rt.exitCode,
    error: rt.lastError,
  };
}

/** 从 "host:port" 解析（默认 7835） */
function parseAddr(addr) {
  const s = String(addr || '').trim();
  if (!s) return { host: DEFAULT_SERVER, port: DEFAULT_PORT };
  const idx = s.lastIndexOf(':');
  if (idx < 0) return { host: s, port: DEFAULT_PORT };
  const host = s.slice(0, idx).trim();
  const port = Number(s.slice(idx + 1));
  return { host: host || DEFAULT_SERVER, port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT };
}

/** 读一行（以 \n 结尾），带缓冲 */
function makeLineReader(socket) {
  let buf = '';
  const waiters = [];
  let ended = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(line);
      idx = buf.indexOf('\n');
    }
  });
  socket.on('end', () => {
    ended = true;
    while (waiters.length) {
      const w = waiters.shift();
      w(null);
    }
  });
  socket.on('error', () => {
    ended = true;
    while (waiters.length) {
      const w = waiters.shift();
      w(null);
    }
  });
  return {
    read(timeoutMs = 30000) {
      if (buf.indexOf('\n') >= 0) {
        const idx = buf.indexOf('\n');
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        return Promise.resolve(line);
      }
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        let done = false;
        const w = (v) => {
          if (done) return;
          done = true;
          resolve(v);
        };
        waiters.push(w);
        setTimeout(() => {
          if (!done) {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            w(null);
          }
        }, timeoutMs).unref?.();
      });
    },
  };
}

/**
 * 启动 bore 隧道。
 * @param {{home?:string, localPort:number, serverAddr?:string, onLog?:Function, onState?:Function}} opts
 */
async function start(opts = {}) {
  if (rt && !rt.stopped) throw new Error('bore 隧道已经在运行');
  const localPort = Number(opts.localPort) || 25565;
  const { host, port } = parseAddr(opts.serverAddr || DEFAULT_SERVER);
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};

  const state = {
    started: Date.now(),
    startedAt: Date.now(),
    stopped: false,
    exitCode: null,
    lastError: '',
    lines: [],
    server: `${host}:${port}`,
    localPort,
    publicAddr: '',
    control: null,
    sockets: new Set(),
  };
  rt = state;

  const emit = (line) => {
    const text = String(line);
    state.lines.push(text);
    if (state.lines.length > 800) state.lines.splice(0, state.lines.length - 800);
    try {
      log(text);
    } catch {
      /* ignore */
    }
  };

  onState('starting', `正在连接 bore 服务端 ${host}:${port}…`);
  emit(`[bore] 正在连接 ${host}:${port} …`);

  const control = net.createConnection({ host, port });
  state.control = control;

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`连接 bore 服务端超时（${host}:${port}）`)), 20000);
    control.once('connect', () => {
      clearTimeout(to);
      resolve();
    });
    control.once('error', (err) => {
      clearTimeout(to);
      reject(new Error(`连不上 bore 服务端：${err.message}`));
    });
  }).catch((err) => {
    state.stopped = true;
    state.lastError = err.message;
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw err;
  });

  const reader = makeLineReader(control);
  emit(`[bore] 已连接，发送 Hello(localPort=${localPort})`);
  control.write(`${JSON.stringify({ Hello: localPort })}\n`);

  const hello = await reader.read(30000);
  if (!hello) {
    state.stopped = true;
    state.lastError = 'bore 服务端无响应';
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(state.lastError);
  }
  let assigned;
  try {
    const j = JSON.parse(hello);
    assigned = Number(j.Hello);
  } catch {
    state.stopped = true;
    state.lastError = `bore 服务端返回异常：${String(hello).slice(0, 80)}`;
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(state.lastError);
  }
  if (!Number.isInteger(assigned)) {
    state.stopped = true;
    state.lastError = `bore 服务端没有分配端口：${String(hello).slice(0, 80)}`;
    throw new Error(state.lastError);
  }

  state.publicAddr = `${host}:${assigned}`;
  emit(`[bore] 隧道已建立，公网地址：${state.publicAddr}`);
  onState('running', `公网地址：${state.publicAddr}`);

  // 后台循环读 Connection
  (async () => {
    for (;;) {
      if (state.stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const line = await reader.read(3600000);
      if (!line) break;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        emit(`[bore] 看不懂的消息：${line.slice(0, 60)}`);
        continue;
      }
      if (!msg || !msg.Connection) continue;
      const uuid = String(msg.Connection);
      emit(`[bore] 有外部连接进来（${uuid.slice(0, 8)}…），建立数据通道`);
      // 新开一条数据连接完成握手并转发
      // eslint-disable-next-line no-use-before-define
      forwardOne({ host, port, uuid, localPort, state, emit }).catch((err) => {
        emit(`[bore] 转发失败：${err.message}`);
      });
    }
    if (!state.stopped) {
      state.stopped = true;
      state.exitCode = 0;
      onState('stopped', '控制连接已断开');
    }
  })();

  return { ok: true, publicAddr: state.publicAddr, server: state.server, localPort };
}

/** 处理一条外部连接：数据连接握手 + 双向转发 */
async function forwardOne({ host, port, uuid, localPort, state, emit }) {
  const data = net.createConnection({ host, port });
  state.sockets.add(data);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('数据连接超时')), 15000);
    data.once('connect', () => {
      clearTimeout(to);
      resolve();
    });
    data.once('error', (err) => {
      clearTimeout(to);
      reject(err);
    });
  });
  data.write(`${JSON.stringify({ Accept: uuid })}\n`);

  const local = net.createConnection({ host: '127.0.0.1', port: localPort });
  state.sockets.add(local);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('连本地服务端超时')), 10000);
    local.once('connect', () => {
      clearTimeout(to);
      resolve();
    });
    local.once('error', (err) => {
      clearTimeout(to);
      reject(err);
    });
  });

  const closeBoth = () => {
    try {
      data.destroy();
    } catch {
      /* ignore */
    }
    try {
      local.destroy();
    } catch {
      /* ignore */
    }
    state.sockets.delete(data);
    state.sockets.delete(local);
  };
  data.on('error', closeBoth);
  local.on('error', closeBoth);
  data.on('close', closeBoth);
  local.on('close', closeBoth);
  data.pipe(local);
  local.pipe(data);
  emit('[bore] 转发中');
}

/** 停止 */
async function stop() {
  if (!rt || rt.stopped) return { ok: true, already: true };
  const state = rt;
  state.stopped = true;
  try {
    if (state.control) state.control.destroy();
  } catch {
    /* ignore */
  }
  for (const s of state.sockets) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  state.sockets.clear();
  state.lines.push('[bore] 已停止');
  return { ok: true };
}

module.exports = {
  DEFAULT_SERVER,
  DEFAULT_PORT,
  parseAddr,
  start,
  stop,
  status,
};
