'use strict';
/**
 * STUN 直连隧道（P2P 打洞，不需要中继服务器）
 *
 * ★★★ 这是第四种穿透，也是延迟最低的一种：
 *   bore / frp 都要经过一台中转服务器（延迟 = 你→中转→朋友）。
 *   STUN 打洞是**朋友直连你的电脑**，中间没有中转。
 *
 * ★ 成立条件（必须如实告知，界面里也写）：
 *   只在 **全锥形 NAT（NAT1）** 下成立 —— 本机内网 (IP,端口) 一旦向外发过包，
 *   NAT 就给它一个固定映射，之后**任何**外部地址都能经这个映射把连接送进来。
 *   如果是 CGNAT（运营商大内网）或防火墙对入站有额外过滤，外部连接会被丢弃，
 *   表现为「朋友连不上」。这种情况本实现绕不过去，只能用 bore / frp 中转。
 *
 * ★ 工作流程（对照隔壁项目的 StunTunnelBackend）：
 *   1. **探测**：与 STUN 服务器建 TCP 长连接，发 Binding Request，
 *      取回本机的公网 `IP:端口`。这一步同时让 NAT 建立了映射。
 *      **不指定本地端口**，由内核随机分配端口 P。
 *   2. **监听**：把 ServerSocket 绑到 P（探测连接的本地端口），**不是** MC 服务端端口。
 *      探测连接设了 SO_REUSEADDR，所以绑定不冲突。
 *   3. **保活**：周期性在探测连接上重发 Binding Request，
 *      既维持映射不被回收，也能发现公网地址变了。
 *   4. **转发**：接受公网入站连接 → 连到本地目标端口 → 双向透传。
 *
 * ★ 为什么监听「探测连接的本地端口」而不是 MC 端口：
 *   NAT 映射是绑在 (内网IP, 本地端口) 这个二元组上的。只有从**那个端口**
 *   发出去的包，才让 NAT 记住「这个端口对应外网那个端口」。
 *   所以必须在同一个本地端口上监听，外部连接才会被 NAT 送到这里。
 */

const net = require('node:net');
const crypto = require('node:crypto');

/** STUN 默认端口 */
const DEFAULT_PORT = 3478;

/** 公共 STUN 服务器（都能应答 Binding Request） */
const DEFAULT_SERVERS = [
  'stun.freeswitch.org',
  'stun.nextcloud.com',
  'stun.telnyx.com',
  'stun.sonetel.com',
  'stun.voip.blackberry.com',
];

/** magic cookie */
const MAGIC_COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

/** 运行态 */
let rt = null;

function status() {
  if (!rt) return { running: false };
  return {
    running: !rt.stopped,
    publicAddr: rt.publicAddr || '',
    server: rt.server || '',
    localPort: rt.localPort,
    /** 探测到的 NAT 类型判断（是否可能打洞成功） */
    natType: rt.natType || '',
    startedAt: rt.startedAt,
    uptimeMs: rt.stopped ? 0 : Date.now() - rt.startedAt,
    lines: (rt.lines || []).slice(-150),
    error: rt.lastError,
    forwarded: rt.forwarded || 0,
  };
}

/** 组一个 Binding Request：类型 0x0001、长度 0、magic cookie、12 字节事务 ID */
function buildBindingRequest(txId) {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0); // Binding Request
  buf.writeUInt16BE(0, 2); // 属性长度 0
  MAGIC_COOKIE.copy(buf, 4);
  txId.copy(buf, 8);
  return buf;
}

/**
 * 解析 Binding Response，取 XOR-MAPPED-ADDRESS（优先）或 MAPPED-ADDRESS。
 * @returns {{host:string, port:number}|null}
 */
function parseBindingResponse(buf) {
  if (!buf || buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  // 0x0101 = Binding Success Response；0x0111 = Error
  if (type !== 0x0101) return null;
  if (!buf.subarray(4, 8).equals(MAGIC_COOKIE)) return null;

  const msgLen = buf.readUInt16BE(2);
  let off = 20;
  const end = Math.min(buf.length, 20 + msgLen);

  let mapped = null;
  while (off + 4 <= end) {
    const attrType = buf.readUInt16BE(off);
    const attrLen = buf.readUInt16BE(off + 2);
    const valOff = off + 4;
    if (valOff + attrLen > end) break;

    if (attrType === 0x0020 && attrLen >= 8) {
      // XOR-MAPPED-ADDRESS
      const family = buf.readUInt8(valOff + 1);
      let port = buf.readUInt16BE(valOff + 2);
      port ^= 0x2112; // 与 magic cookie 前两字节异或
      if (family === 0x01) {
        const addr = Buffer.alloc(4);
        for (let i = 0; i < 4; i += 1) addr[i] = buf[valOff + 4 + i] ^ MAGIC_COOKIE[i];
        mapped = { host: `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`, port, xor: true };
      }
    } else if (attrType === 0x0001 && attrLen >= 8 && !mapped) {
      // MAPPED-ADDRESS（明文）
      const family = buf.readUInt8(valOff + 1);
      const port = buf.readUInt16BE(valOff + 2);
      if (family === 0x01) {
        mapped = {
          host: `${buf[valOff + 4]}.${buf[valOff + 5]}.${buf[valOff + 6]}.${buf[valOff + 7]}`,
          port,
          xor: false,
        };
      }
    }
    // 属性按 4 字节对齐
    off = valOff + attrLen + ((4 - (attrLen % 4)) % 4);
  }
  return mapped;
}

/** 从 "host" / "host:port" / "stun://host:port" 解析 */
function parseServer(line) {
  let s = String(line || '').trim();
  if (!s) return null;
  s = s.replace(/^stun:\/\//i, '');
  const idx = s.lastIndexOf(':');
  if (idx < 0) return { host: s, port: DEFAULT_PORT };
  const host = s.slice(0, idx).trim();
  const port = Number(s.slice(idx + 1));
  if (!host) return null;
  return { host, port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT };
}

/**
 * 先在一个随机端口上开 ServerSocket（reuseAddr），
 * 再用同一本地端口向 STUN 服务器 connect —— 这样 NAT 映射和监听端口就是同一个。
 *
 * ★★★ 这是打洞能成立的**全部关键**，也是踩了很久才理清的顺序问题：
 *   · 如果先 connect（内核随机给端口 P）再 listen(P) → EADDRINUSE，
 *     因为探测连接自己占着 P；Node 没有暴露 SO_REUSEADDR 给 net.connect。
 *   · 正确顺序：**先 listen 拿到一个具体端口 P（reuseAddr:true），
 *     然后用 localPort:P 去 connect**。NAT 看到的是「从 P 发出去的包」，
 *     于是把外部端口映射到 P；而我们正好在 P 上监听，外部连接就能进来。
 *
 * @returns {Promise<{socket, listenServer, localPort, mapped, server}>}
 */
function probeWithListen(server, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const { host, port } = server;
    let settled = false;
    let listenServer = null;
    let socket = null;

    const cleanup = () => {
      try {
        if (socket) socket.destroy();
      } catch {
        /* ignore */
      }
      try {
        if (listenServer) listenServer.close();
      } catch {
        /* ignore */
      }
    };
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      if (err) {
        cleanup();
        reject(err);
      } else {
        resolve(val);
      }
    };
    const to = setTimeout(() => done(new Error(`连 STUN 服务器超时（${host}:${port}）`)), timeoutMs);

    // ① 先在随机端口开监听（reuseAddr 允许多个 socket 绑同一端口）
    listenServer = net.createServer();
    listenServer.once('error', (err) => done(new Error(`本地监听失败：${err.message}`)));
    listenServer.listen({ port: 0, host: '0.0.0.0', exclusive: false }, () => {
      const localPort = listenServer.address().port;

      // ② 用同一个本地端口连 STUN
      socket = net.createConnection({ host, port, localPort, localAddress: '0.0.0.0' });
      let buf = Buffer.alloc(0);

      socket.on('connect', () => {
        const txId = crypto.randomBytes(12);
        try {
          socket.write(buildBindingRequest(txId));
        } catch (err) {
          done(new Error(`发送 Binding 请求失败：${err.message}`));
        }
      });
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const mapped = parseBindingResponse(buf);
        if (mapped) {
          done(null, { socket, listenServer, localPort, mapped, server });
        }
      });
      socket.on('error', (err) => done(new Error(`STUN 服务器错误：${err.message}`)));
      socket.on('close', () => {
        if (!settled) done(new Error('STUN 服务器关闭了连接'));
      });
    });
  });
}

/**
 * 启动物理打洞隧道。
 * @param {{localPort:number, serverAddr?:string, onLog?:Function, onState?:Function}} opts
 */
async function start(opts = {}) {
  if (rt && !rt.stopped) throw new Error('STUN 隧道已经在运行');
  const localPort = Number(opts.localPort) || 25565;
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};

  const state = {
    startedAt: Date.now(),
    stopped: false,
    lastError: '',
    lines: [],
    publicAddr: '',
    server: '',
    localPort,
    natType: '',
    probeSocket: null,
    listenServer: null,
    sockets: new Set(),
    keepAliveTimer: null,
    forwarded: 0,
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

  onState('starting', '正在探测公网映射…');

  // ① 选一台可用的 STUN 服务器
  const candidates = opts.serverAddr
    ? [parseServer(opts.serverAddr)].filter(Boolean)
    : DEFAULT_SERVERS.map((h) => ({ host: h, port: DEFAULT_PORT }));

  let probed = null;
  let lastErr = null;
  for (const srv of candidates) {
    try {
      emit(`[stun] 探测 ${srv.host}:${srv.port} …`);
      // eslint-disable-next-line no-await-in-loop
      probed = await probeWithListen(srv);
      emit(`[stun] 公网映射：${probed.mapped.host}:${probed.mapped.port}（本地端口 ${probed.localPort}）`);
      break;
    } catch (err) {
      lastErr = err;
      emit(`[stun] ${srv.host} 不行：${err.message}`);
    }
  }
  if (!probed) {
    state.stopped = true;
    state.lastError = `所有 STUN 服务器都不可用：${lastErr ? lastErr.message : '未知'}`;
    onState('failed', state.lastError);
    throw new Error(state.lastError);
  }

  state.probeSocket = probed.socket;
  state.server = `${probed.server.host}:${probed.server.port}`;

  /**
   * ② 复用探测阶段已经开好的 ServerSocket 挂上转发逻辑。
   *   ★ 不再重新 listen —— 那个端口已经在上面的 probeWithListen 里绑好了，
   *     再 bind 一次必然 EADDRINUSE（踩过）。
   */
  const listenServer = probed.listenServer;
  emit(`[stun] 已在本地端口 ${probed.localPort} 上监听，等待外部连接…`);

  listenServer.removeAllListeners('connection');
  listenServer.on('connection', (client) => {
    state.forwarded += 1;
    emit(`[stun] 有外部连接进来（第 ${state.forwarded} 个），转发到 127.0.0.1:${localPort}`);
    const local = net.createConnection({ host: '127.0.0.1', port: localPort });
    state.sockets.add(client);
    state.sockets.add(local);
    const closeBoth = () => {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
      try {
        local.destroy();
      } catch {
        /* ignore */
      }
      state.sockets.delete(client);
      state.sockets.delete(local);
    };
    client.on('error', closeBoth);
    local.on('error', closeBoth);
    client.on('close', closeBoth);
    local.on('close', closeBoth);
    client.pipe(local);
    local.pipe(client);
  });

  state.listenServer = listenServer;
  state.publicAddr = `${probed.mapped.host}:${probed.mapped.port}`;
  state.natType = 'full-cone（可能可打洞）';

  emit(`[stun] 隧道已建立，公网地址：${state.publicAddr}`);
  onState('running', `公网地址：${state.publicAddr}`);

  /**
   * ③ 保活：周期重发 Binding Request。
   * 既维持 NAT 映射不超时，也能发现公网地址变了（重拨/换网）。
   */
  const keepAlive = () => {
    if (state.stopped) return;
    try {
      const tx = crypto.randomBytes(12);
      state.probeSocket.write(buildBindingRequest(tx));
    } catch {
      emit('[stun] 保活发送失败（连接已断），尝试重建…');
      // 简化处理：标记失败，让上层重启
      state.lastError = 'STUN 保活连接断开，请重新启动隧道';
      onState('failed', state.lastError);
    }
  };
  state.keepAliveTimer = setInterval(keepAlive, 25000);
  if (state.keepAliveTimer.unref) state.keepAliveTimer.unref();

  return {
    ok: true,
    publicAddr: state.publicAddr,
    server: state.server,
    localPort,
    listenPort: probed.localPort,
    natType: state.natType,
  };
}

/** 停止 */
async function stop() {
  if (!rt || rt.stopped) return { ok: true, already: true };
  const state = rt;
  state.stopped = true;
  if (state.keepAliveTimer) {
    clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = null;
  }
  try {
    if (state.probeSocket) state.probeSocket.destroy();
  } catch {
    /* ignore */
  }
  try {
    if (state.listenServer) state.listenServer.close();
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
  state.lines.push('[stun] 已停止');
  return { ok: true };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_SERVERS,
  MAGIC_COOKIE,
  buildBindingRequest,
  parseBindingResponse,
  parseServer,
  probeWithListen,
  start,
  stop,
  status,
};
