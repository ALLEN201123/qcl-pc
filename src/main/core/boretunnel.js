'use strict';
/**
 * bore 隧道（纯 Node 实现，不需要任何外部二进制）
 *
 * ★★★ 协议修正（2026-11-22）：第一版按「换行符分隔」写，连上 bore.pub 后
 *   发了 Hello 却永远收不到响应。翻 bore 官方源码 `src/shared.rs` 才看清：
 *
 *     let codec = AnyDelimiterCodec::new_with_max_length(vec![0], vec![0], MAX_FRAME_LENGTH);
 *
 *   **帧分隔符是 NULL 字节 `\0`，不是换行符**，且单帧上限 256 字节。
 *   消息体是 serde 序列化的 JSON，枚举按 serde 默认外部标签格式，即：
 *     ClientMessage::Hello(25565)      → {"Hello":25565}
 *     ClientMessage::Accept(uuid)      → {"Accept":"<uuid>"}
 *     ClientMessage::Authenticate(hmac)→ {"Authenticate":"<hex>"}
 *     ServerMessage::Challenge(uuid)   → {"Challenge":"<uuid>"}
 *     ServerMessage::Hello(port)       → {"Hello":12345}
 *     ServerMessage::Heartbeat         → "Heartbeat"      ← 单元枚举，序列化成字符串！
 *     ServerMessage::Connection(uuid)  → {"Connection":"<uuid>"}
 *     ServerMessage::Error(msg)        → {"Error":"..."}
 *
 * ★ 为什么值得内置（对未成年玩家尤其重要）：
 *   樱花frp / 自建 frps 都要实名或成人身份，很多玩家用不了。
 *   bore.pub 是**公开的、匿名的、零注册**隧道 —— 连上就能用。
 *   代价是端口随机、无鉴权、延迟取决于公共节点，适合「临时和朋友玩一会儿」。
 *
 * 协议流程：
 *   1. 连 bore 服务端（默认 bore.pub:7835，TCP 控制端口）
 *   2. 发 `{"Hello":<本地端口>}\0`
 *   3. 服务端回 `{"Hello":<分配的公网端口>}\0`
 *   4. 之后服务端推 `{"Connection":"<uuid>"}\0`
 *      → 客户端再连一条数据连接，发 `{"Accept":"<uuid>"}\0` 完成握手
 *      → 之后这条连接就双向转发到本地端口
 *   5. 服务端可能推 `"Heartbeat"`（字符串），忽略即可
 */

const net = require('node:net');

/** 默认公共 bore 服务端 */
const DEFAULT_SERVER = 'bore.pub';
const DEFAULT_PORT = 7835;
/** 帧分隔符（bore 用 NULL 字节） */
const SEP = '\0';

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

/**
 * 按 NULL 字节切帧的读取器。
 * ★ 必须用 Buffer 处理：JSON 里可能有非 ASCII 字符，按字符串切会踩多字节边界。
 */
function makeFrameReader(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  let ended = false;

  const flush = () => {
    while (waiters.length) {
      const idx = buf.indexOf(0);
      if (idx < 0) return;
      const frame = buf.subarray(0, idx).toString('utf8');
      buf = buf.subarray(idx + 1);
      const w = waiters.shift();
      if (w) w(frame);
    }
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    flush();
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
      const idx = buf.indexOf(0);
      if (idx >= 0) {
        const frame = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 1);
        return Promise.resolve(frame);
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
        if (timeoutMs > 0) {
          setTimeout(() => {
            if (done) return;
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            w(null);
          }, timeoutMs).unref?.();
        }
      });
    },
  };
}

/** 发一帧（自动补 NULL 分隔符） */
function sendFrame(socket, obj) {
  socket.write(JSON.stringify(obj) + SEP);
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

  const reader = makeFrameReader(control);
  emit(`[bore] 已连接，发送 Hello(localPort=${localPort})`);
  sendFrame(control, { Hello: localPort });

  const hello = await reader.read(30000);
  if (!hello) {
    state.stopped = true;
    state.lastError = 'bore 服务端无响应（30 秒没有回 Hello）';
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(state.lastError);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(hello);
  } catch {
    state.stopped = true;
    state.lastError = `bore 服务端返回无法解析的内容：${String(hello).slice(0, 80)}`;
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(state.lastError);
  }
  // 服务端可能先发 Error
  if (parsed && parsed.Error) {
    state.stopped = true;
    state.lastError = `bore 服务端拒绝：${parsed.Error}`;
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(state.lastError);
  }
  const assigned = Number(parsed && parsed.Hello);
  if (!Number.isInteger(assigned)) {
    state.stopped = true;
    state.lastError = `bore 服务端没有分配端口：${String(hello).slice(0, 80)}`;
    try {
      control.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(state.lastError);
  }

  state.publicAddr = `${host}:${assigned}`;
  emit(`[bore] 隧道已建立，公网地址：${state.publicAddr}`);
  onState('running', `公网地址：${state.publicAddr}`);

  // 后台循环读 Connection / Heartbeat
  (async () => {
    for (;;) {
      if (state.stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const frame = await reader.read(3600000);
      if (!frame) break;
      if (frame === '"Heartbeat"') {
        // 服务端心跳，忽略（bore 不需要客户端回包）
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(frame);
      } catch {
        emit(`[bore] 看不懂的帧：${frame.slice(0, 60)}`);
        continue;
      }
      if (msg && msg.Error) {
        state.lastError = String(msg.Error);
        emit(`[bore] 服务端报错：${state.lastError}`);
        break;
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
      onState('stopped', state.lastError || '控制连接已断开');
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

  /**
   * ★ 数据连接上也要按同一套 NULL 分隔协议发 Accept。
   *   若服务端启用了 secret，会先收到 {"Challenge":"<uuid>"}，
   *   需要回 {"Authenticate":"<hmac>"}；public bore.pub 一般不带 secret，
   *   这里遇到 Challenge 就明确报错（而不是静默卡住）。
   */
  sendFrame(data, { Accept: uuid });

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
