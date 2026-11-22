'use strict';
/**
 * 内网穿透「多方案」验收
 *
 * ★ 背景（用户提出）：樱花frp / 自建 frps 都要实名或成人身份，
 *   未成年玩家用不了 → 必须提供零门槛方案。
 *
 * 本脚本验证四种方案：
 *   ① bore 零注册（bore.pub，匿名）—— **真起本地服务 + 真从公网地址连回来**
 *   ② 樱花frp（需 token）
 *   ③ 魅frp（需 token）
 *   ④ 自建 frps（需服务器）
 *
 * 用法：node build/verify-server-tunnel-multi.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const checks = [];
const P = (n, p, i) => checks.push({ n, p, i });
const section = (t) => console.log(`\n===== ${t} =====`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const bore = require(path.join(ROOT, 'src', 'main', 'core', 'boretunnel.js'));
  const me = require(path.join(ROOT, 'src', 'main', 'core', 'mefrp.js'));
  const sak = require(path.join(ROOT, 'src', 'main', 'core', 'sakurafrp.js'));
  const tun = require(path.join(ROOT, 'src', 'main', 'core', 'servertunnel.js'));

  /* ---------------- ① bore 零注册 ---------------- */
  section('① bore 零注册（匿名、无需实名）');
  {
    P('默认服务端是 bore.pub', bore.DEFAULT_SERVER === 'bore.pub', bore.DEFAULT_SERVER);
    P('控制端口 7835', bore.DEFAULT_PORT === 7835, bore.DEFAULT_PORT);

    // 起一个本地假服务端
    const local = net.createServer((s) => {
      s.write('QCL-MC-HELLO\n');
    });
    await new Promise((r) => local.listen(0, '127.0.0.1', r));
    const localPort = local.address().port;
    P('本地假服务端已启动', Number.isInteger(localPort) && localPort > 0, localPort);

    const logs = [];
    let startR = null;
    try {
      startR = await bore.start({
        localPort,
        onLog: (l) => logs.push(l),
        onState: () => {},
      });
    } catch (e) {
      startR = null;
      P('bore 隧道建立', false, e.message.slice(0, 90));
    }

    if (startR) {
      P('★ bore 隧道建立（无需任何账号）', !!startR.publicAddr, startR.publicAddr);
      P('拿到的是 host:port 形式', /^[\w.-]+:\d+$/.test(startR.publicAddr), startR.publicAddr);

      // ★ 关键：真从公网地址连回来
      const [host, portStr] = startR.publicAddr.split(':');
      const probe = net.createConnection({ host, port: Number(portStr) });
      const got = await new Promise((resolve) => {
        let buf = '';
        probe.on('data', (d) => {
          buf += d;
          if (buf.includes('QCL-MC-HELLO')) resolve(buf.trim());
        });
        probe.on('error', (e) => resolve(`ERR:${e.message}`));
        setTimeout(() => resolve('TIMEOUT'), 20000);
      });
      P('★ 从公网地址连回来能收到本地数据', got === 'QCL-MC-HELLO', got);
      try {
        probe.destroy();
      } catch {
        /* ignore */
      }

      P('日志记录了握手与转发', logs.some((l) => /隧道已建立/.test(l)) && logs.some((l) => /转发/.test(l)), logs.slice(-3));

      const st = bore.status();
      P('status() 报运行中', st.running === true && !!st.publicAddr, st.publicAddr);

      await bore.stop();
      await sleep(400);
      const st2 = bore.status();
      P('stop() 后不再运行', st2.running === false, st2.running);
    }
    local.close();
  }

  /* ---------------- ② 魅frp ---------------- */
  section('② 魅frp（需账号）');
  {
    P('BASE 是 api.mefrp.com/api', me.BASE === 'https://api.mefrp.com/api', me.BASE);

    let threw = false;
    try {
      await me.userInfo('');
    } catch (e) {
      threw = /token/.test(e.message);
    }
    P('空 token 被拦', threw);

    // 假 token：要有明确错误，不能崩
    try {
      await me.userInfo('not-a-real-token');
      P('假 token 得到明确错误', false, '竟然成功了');
    } catch (e) {
      P('假 token 得到明确错误', !!e.message && !/undefined/.test(e.message), String(e.message).slice(0, 70));
    }

    threw = false;
    try {
      await me.proxyConfig('fake', '');
    } catch (e) {
      threw = /隧道/.test(e.message);
    }
    P('空 proxyId 被拦', threw);
  }

  /* ---------------- ③ 樱花frp（回归） ---------------- */
  section('③ 樱花frp（需账号 · 回归）');
  {
    P('BASE 是 api.natfrp.com/v4', sak.BASE === 'https://api.natfrp.com/v4', sak.BASE);
    try {
      await sak.userInfo('not-a-real-token');
      P('假 token 得到明确错误', false, '竟然成功了');
    } catch (e) {
      P('假 token 得到明确错误', !!e.message, String(e.message).slice(0, 60));
    }
  }

  /* ---------------- ④ 自建 frps ---------------- */
  section('④ 自建 frps');
  {
    const toml = tun.buildToml({ serverAddr: 'my.frps.com', serverPort: 7000, localPort: 25565, remotePort: 25565 });
    P('TOML 能生成', /serverAddr = "my\.frps\.com"/.test(toml) && /remotePort = 25565/.test(toml));
    P('frpc 版本已知', tun.FRP_VERSION === '0.71.0', tun.FRP_VERSION);
  }

  /* ---------------- ⑤ UI 与接线 ---------------- */
  section('⑤ UI 与接线（四种方案都要在界面里）');
  {
    const page = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js'), 'utf8');
    const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');

    P('UI 有 bore 模式', /data-tmode="bore"/.test(page));
    P('UI 有樱花模式', /data-tmode="sakura"/.test(page));
    P('UI 有魅frp 模式', /data-tmode="me"/.test(page));
    P('UI 有自建模式', /data-tmode="custom"/.test(page));
    P('默认模式是 bore（零注册）', /mode: 'bore'/.test(page), (page.match(/mode: '(\w+)'/) || [])[1]);
    P('UI 写明了「不需要注册」', /不需要注册/.test(page));
    P('UI 写明了未成年也能用', /未满 18|未成年|不.*实名/.test(page));

    const chans = ['server:tunnel:boreStart', 'server:tunnel:boreStop', 'server:tunnel:meUser', 'server:tunnel:meProxies', 'server:tunnel:start', 'server:tunnel:stop', 'server:tunnel:status'];
    const missing = chans.filter((c) => !ipc.includes(`'${c}'`));
    P('IPC 通道齐全', missing.length === 0, missing);

    P('stop 会同时停 bore 与 frp', /boretunnel'\)\.stop|bore.*stop[\s\S]{0,200}servertunnel'\)\.stop/.test(ipc) || (/bore/.test(ipc) && /stop\(\)/.test(ipc)));
    P('mode=bore 走 bore 实现', /mode === 'bore'/.test(ipc));
    P('mode=me 走魅frp', /mode === 'me'/.test(ipc));
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.p) fail += 1;
    console.log(`${c.p ? 'PASS' : 'FAIL'}  ${c.n}${c.i !== undefined && c.i !== '' ? '  → ' + JSON.stringify(c.i) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);

  try {
    await bore.stop();
  } catch {
    /* ignore */
  }
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.log('\nFATAL ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
