'use strict';
/**
 * RCON 客户端（Source RCON 协议）
 *
 * ★ 安卓 1.6.6 只支持「启动 / 停止 / 看控制台」，要发命令得在控制台里打。
 *   PC 版加 RCON 之后能做：
 *     · 任意命令（op / gamemode / time / weather / gamerule …）
 *     · 在线玩家列表（`list` 命令解析成结构化数组）
 *     · 全服广播（`say`）
 *     · 白名单热加载（`whitelist reload`）
 *     · 踢人 / 封禁
 *   这样即使把启动器关了，只要服务端还在跑，也能单独连上去管。
 *
 * 协议要点（Source RCON）：
 *   包结构 = 长度(4, LE) + 请求ID(4, LE) + 类型(4, LE) + 负载 + 两个 0x00
 *   类型：3=SERVERDATA_AUTH, 2=SERVERDATA_AUTH_RESPONSE, 0=SERVERDATA_RESPONSE_VALUE, 2=EXECCOMMAND
 *   ★ 认证失败时服务端返回的 id 是 -1（0xFFFFFFFF）
 *   ★ 命令响应可能被拆成多个包，需要一个空的「哨兵包」来判断结束
 */

const net = require('node:net');

const TYPE = {
  RESPONSE_VALUE: 0,
  EXEC_COMMAND: 2,
  AUTH_RESPONSE: 2,
  AUTH: 3,
};

/** 组一个 RCON 包 */
function buildPacket(id, type, body) {
  const payload = Buffer.from(String(body || ''), 'utf8');
  const buf = Buffer.alloc(payload.length + 14);
  buf.writeInt32LE(payload.length + 10, 0); // 长度 = id + type + payload + 两个 null
  buf.writeInt32LE(id | 0, 4);
  buf.writeInt32LE(type | 0, 8);
  payload.copy(buf, 12);
  buf.writeUInt8(0, 12 + payload.length);
  buf.writeUInt8(0, 13 + payload.length);
  return buf;
}

/** 从缓冲区里切出一个完整包；不完整返回 null */
function takePacket(buf) {
  if (buf.length < 4) return null;
  const len = buf.readInt32LE(0);
  if (len < 10 || len > 1024 * 1024) {
    // 非法长度，说明流已错乱
    return { error: `包长度异常：${len}` };
  }
  const total = 4 + len;
  if (buf.length < total) return null;
  const id = buf.readInt32LE(4);
  const type = buf.readInt32LE(8);
  const body = buf.subarray(12, total - 2).toString('utf8');
  return { id, type, body, consumed: total };
}

/**
 * 连上 RCON 并发一条命令（短连接，用完即断）。
 * 短连接的好处：不需要维护长连接状态，不会因为服务端重启而挂住。
 *
 * @param {{host?:string, port:number, password:string, command:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, body?:string, error?:string}>}
 */
function exec(opts = {}) {
  const host = String(opts.host || '127.0.0.1');
  const port = Number(opts.port);
  const password = String(opts.password || '');
  const command = String(opts.command || '');
  const timeoutMs = Number(opts.timeoutMs) || 8000;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ ok: false, error: `RCON 端口不合法：${opts.port}` });
  }
  if (!password) {
    return Promise.resolve({ ok: false, error: 'RCON 密码为空（服务端 server.properties 里的 rcon.password）' });
  }
  if (!command.trim()) {
    return Promise.resolve({ ok: false, error: '命令为空' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    const responses = [];
    let sentAuth = false;
    let sentCmd = false;

    const timer = setTimeout(() => {
      done({ ok: false, error: `RCON 超时（${timeoutMs}ms）：服务端可能没开 RCON，或端口/密码不对` });
    }, timeoutMs);
    const clear = () => clearTimeout(timer);

    sock.on('connect', () => {
      try {
        sock.write(buildPacket(1, TYPE.AUTH, password));
        sentAuth = true;
      } catch (err) {
        clear();
        done({ ok: false, error: `发送认证失败：${err.message}` });
      }
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const pkt = takePacket(buf);
        if (!pkt) break;
        if (pkt.error) {
          clear();
          done({ ok: false, error: pkt.error });
          return;
        }
        buf = buf.subarray(pkt.consumed);

        // 认证响应
        if (!authed) {
          if (pkt.id === -1 || pkt.id === 0xffffffff) {
            clear();
            done({ ok: false, error: 'RCON 认证失败：密码不对' });
            return;
          }
          if (pkt.type === TYPE.AUTH_RESPONSE && pkt.id === 1) {
            authed = true;
            try {
              sock.write(buildPacket(2, TYPE.EXEC_COMMAND, command));
              sentCmd = true;
            } catch (err) {
              clear();
              done({ ok: false, error: `发送命令失败：${err.message}` });
            }
            continue;
          }
          continue;
        }

        // 命令响应：可能多包，用哨兵包（空命令）判定结束
        if (pkt.type === TYPE.RESPONSE_VALUE) {
          responses.push(pkt.body);
          // 发一个空请求当哨兵；服务端会回一个空 RESPONSE_VALUE
          if (!settled && responses.length < 200) {
            try {
              sock.write(buildPacket(99, TYPE.RESPONSE_VALUE, ''));
            } catch {
              /* ignore */
            }
          }
          continue;
        }
        // 有些实现直接用 EXEC_COMMAND 类型回响应
        if (pkt.type === TYPE.EXEC_COMMAND) {
          responses.push(pkt.body);
          clear();
          done({ ok: true, body: responses.join('') });
          return;
        }
        // 收到哨兵响应（id 99 或空 body）→ 认为结束
        if (pkt.id === 99 || pkt.body === '') {
          clear();
          done({ ok: true, body: responses.join('') });
          return;
        }
      }
    });

    sock.on('error', (err) => {
      clear();
      if (err.code === 'ECONNREFUSED') {
        done({ ok: false, error: `连不上 RCON（${host}:${port}）：服务端没开 RCON，或还没启动完成` });
      } else if (err.code === 'ETIMEDOUT') {
        done({ ok: false, error: `连 RCON 超时（${host}:${port}）` });
      } else {
        done({ ok: false, error: `RCON 连接错误：${err.message}` });
      }
    });

    sock.on('close', () => {
      clear();
      if (!settled) {
        if (responses.length) done({ ok: true, body: responses.join('') });
        else if (!authed) done({ ok: false, error: 'RCON 连接被关闭（认证未完成）' });
        else done({ ok: false, error: 'RCON 连接被关闭（没收到响应）' });
      }
    });
  });
}

/* ============================================================
 * 语义化命令（在 exec 之上，返回结构化结果）
 * ============================================================ */

/** 在线玩家列表 → { online, max, players:[names], raw } */
async function listPlayers(opts) {
  const r = await exec({ ...opts, command: 'list' });
  if (!r.ok) return { ok: false, error: r.error, players: [], online: 0, max: 0 };
  // 响应形如：There are 2 of a max of 20 players online: Alice, Bob
  const raw = r.body || '';
  const m = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i.exec(raw);
  if (!m) {
    return { ok: true, players: [], online: 0, max: 0, raw, unparsed: true };
  }
  const names = m[3]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: true, players: names, online: Number(m[1]) || names.length, max: Number(m[2]) || 0, raw };
}

/** 全服广播 */
async function say(opts, message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: '广播内容为空' };
  // say 命令里不能有换行（会被拆成多条）
  return exec({ ...opts, command: `say ${text.replace(/[\r\n]+/g, ' ')}` });
}

/** 踢人 */
async function kick(opts, player, reason) {
  const name = String(player || '').trim();
  if (!name) return { ok: false, error: '玩家名为空' };
  const why = String(reason || '').trim();
  return exec({ ...opts, command: `kick ${name}${why ? ` ${why}` : ''}` });
}

/** 白名单热加载（改了 whitelist.json 后必须 reload 才生效） */
async function whitelistReload(opts) {
  return exec({ ...opts, command: 'whitelist reload' });
}

/** op / deop */
async function setOp(opts, player, on = true) {
  const name = String(player || '').trim();
  if (!name) return { ok: false, error: '玩家名为空' };
  return exec({ ...opts, command: `${on ? 'op' : 'deop'} ${name}` });
}

/**
 * 探测 RCON 是否可用（用于界面上显示「RCON 已连通」）。
 * @returns {Promise<{ok:boolean, error?:string, players?:number}>}
 */
async function probe(opts) {
  const r = await exec({ ...opts, command: 'list', timeoutMs: Number(opts.timeoutMs) || 5000 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, raw: r.body || '' };
}

module.exports = {
  TYPE,
  buildPacket,
  takePacket,
  exec,
  listPlayers,
  say,
  kick,
  whitelistReload,
  setOp,
  probe,
};
