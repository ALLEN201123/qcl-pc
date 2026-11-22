'use strict';
/**
 * 服务端内网穿透（frp）验收
 *
 * 覆盖：
 *   ① frpc 引擎：下载源、安装、--version 可执行
 *   ② TOML 配置生成（自建 frps 的三种形态）
 *   ③ 进程生命周期：起 → 读日志 → 停；连不上时给中文诊断
 *   ④ 樱花frp API：token 校验、隧道列表、节点列表、配置拉取的错误处理
 *   ⑤ 接线：IPC 通道 / 白名单 / 事件转发 / 页面 tab
 *
 * ★ 真实隧道需要账号 token 与可达的 frps，无法在这里造；
 *   所以这里验证「引擎能跑 + 错误能诊断 + 接线完整」，
 *   并明确标注哪一步需要玩家自己的 token。
 *
 * 用法：node build/verify-server-tunnel.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.tmpdir(), `_qcl_tunnel_${Date.now()}`);

const checks = [];
const P = (name, pass, info) => checks.push({ name, pass, info });
const section = (t) => console.log(`\n===== ${t} =====`);

(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  const tun = require(path.join(ROOT, 'src', 'main', 'core', 'servertunnel.js'));
  const sak = require(path.join(ROOT, 'src', 'main', 'core', 'sakurafrp.js'));

  /* ---------------- ① 引擎 ---------------- */
  section('① frpc 引擎');
  {
    P('版本号是 0.71.0', tun.FRP_VERSION === '0.71.0', tun.FRP_VERSION);
    const urls = tun.downloadUrls();
    P('下载源有 4 个回退', urls.length === 4, urls.length);
    P('首个源是官方 GitHub', /github\.com\/fatedier\/frp/.test(urls[0]));
    P('带国内镜像回退', urls.some((u) => /ghfast\.top|gh-proxy/.test(u)));
    P('未安装时 isInstalled=false', tun.isInstalled(HOME) === false);
    P('exePath 指向 frpc.exe', /frpc\.exe$/i.test(tun.exepath ? tun.exepath(HOME) : tun.exePath(HOME)));
  }

  /* ---------------- ② TOML ---------------- */
  section('② TOML 配置生成（自建 frps）');
  {
    const toml = tun.buildToml({
      serverAddr: 'frp.example.com',
      serverPort: 7000,
      authToken: 'secret-token',
      localPort: 25565,
      remotePort: 25566,
      proxyName: 'my-server',
    });
    P('含 serverAddr', /serverAddr = "frp\.example\.com"/.test(toml));
    P('含 serverPort', /serverPort = 7000/.test(toml));
    P('含 auth.token', /auth\.token = "secret-token"/.test(toml));
    P('含 [[proxies]] 段', /\[\[proxies\]\]/.test(toml));
    P('type 是 tcp', /type = "tcp"/.test(toml));
    P('含 localIP 127.0.0.1', /localIP = "127\.0\.0\.1"/.test(toml));
    P('含 localPort 25565', /localPort = 25565/.test(toml));
    P('含 remotePort 25566', /remotePort = 25566/.test(toml));
    P('代理名被清洗', /name = "my-server"/.test(toml));

    // 无 token 时不写 auth 行
    const toml2 = tun.buildToml({ serverAddr: 'a.com', localPort: 25565 });
    P('无 token 时不写 auth.token', !/auth\.token/.test(toml2));
    P('remotePort 缺省时回落到 localPort', /remotePort = 25565/.test(toml2));

    // 空地址必须拦
    let threw = false;
    try {
      tun.buildToml({});
    } catch (e) {
      threw = /服务器地址/.test(e.message);
    }
    P('空 serverAddr 被拦', threw);

    // 非法代理名被清洗
    const toml3 = tun.buildToml({ serverAddr: 'a.com', proxyName: '中文 空格/斜杠' });
    P('非法代理名被清洗成合法字符', /name = "[A-Za-z0-9_-]+"/.test(toml3), (toml3.match(/name = "([^"]+)"/) || [])[1]);
  }

  /* ---------------- ③ 进程生命周期 ---------------- */
  section('③ 进程生命周期（真跑 frpc）');
  {
    // 安装引擎（可能较慢；已装则秒过）
    let installed = false;
    try {
      const r = await tun.ensureInstalled(HOME, { onLog: () => {} });
      installed = !!r.ok;
    } catch (e) {
      installed = false;
      P('引擎安装', false, e.message.slice(0, 100));
    }
    if (installed) {
      P('引擎安装成功', true, tun.exePath(HOME));
      P('isInstalled 现在为 true', tun.isInstalled(HOME) === true);

      // 真跑 --version
      try {
        const out = execFileSync(tun.exePath(HOME), ['--version'], { timeout: 15000, windowsHide: true }).toString();
        P('frpc --version 可执行', /0\.71\.0/.test(out), out.trim());
      } catch (e) {
        P('frpc --version 可执行', false, e.message.slice(0, 80));
      }

      // 起一个连不上的隧道，验证日志与诊断
      const badToml = tun.buildToml({ serverAddr: '127.0.0.1', serverPort: 1, localPort: 25565, remotePort: 25565 });
      const logs = [];
      const states = [];
      const startR = await tun.start({
        home: HOME,
        configText: badToml,
        onLog: (l) => logs.push(l),
        onState: (s, m) => states.push(`${s}:${m}`),
      });
      P('start() 返回成功并拿到 PID', startR.ok === true && Number.isInteger(startR.pid), startR.pid);
      P('配置文件已写到磁盘', fs.existsSync(startR.configPath), path.basename(startR.configPath));

      await new Promise((r) => setTimeout(r, 6000));
      P('读到了 frpc 的日志', logs.length >= 3, logs.length);
      P('日志里有连接尝试', logs.some((l) => /try to connect|connect to server/i.test(l)), logs.slice(0, 2));

      const st = tun.status();
      P('status() 能报退出码', st.exitCode !== null && st.exitCode !== undefined, st.exitCode);

      const diag = tun.diagnose();
      P('诊断识别出「连不上服务器」', (diag.hints || []).some((h) => /连不上服务器|检查地址/.test(h)), diag.hints);
      P('诊断有 summary', !!diag.summary, diag.summary);

      const stopR = await tun.stop();
      P('stop() 成功', stopR.ok === true);
    } else {
      P('引擎安装成功', false, '网络不可用，后续跳过');
    }
  }

  /* ---------------- ④ 樱花frp API ---------------- */
  section('④ 樱花frp API（v4）');
  {
    P('BASE 是 api.natfrp.com/v4', sak.BASE === 'https://api.natfrp.com/v4', sak.BASE);
    P('声明的 frpc 版本与引擎一致', sak.FRPC_VERSION === tun.FRP_VERSION, `${sak.FRPC_VERSION} vs ${tun.FRP_VERSION}`);

    // 空 token 必须拦
    let threw = false;
    try {
      await sak.userInfo('');
    } catch (e) {
      threw = /token/.test(e.message);
    }
    P('空 token 被拦', threw);

    // 假 token：应拿到「认证失败」而不是崩
    try {
      await sak.userInfo('this-is-not-a-real-token');
      P('假 token 得到明确错误', false, '竟然成功了？');
    } catch (e) {
      const msg = e.message || '';
      P('假 token 得到明确错误', msg.length > 0 && !/undefined/.test(msg), msg.slice(0, 80));
    }

    // 空 query 必须拦
    threw = false;
    try {
      await sak.tunnelConfig('fake-token', '');
    } catch (e) {
      threw = /隧道/.test(e.message);
    }
    P('空隧道 id 被拦', threw);
  }

  /* ---------------- ⑤ 接线 ---------------- */
  section('⑤ 接线');
  {
    const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
    const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
    const bridge = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'bridge.js'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js'), 'utf8');

    P('core/servertunnel.js 存在', fs.existsSync(path.join(ROOT, 'src', 'main', 'core', 'servertunnel.js')));
    P('core/sakurafrp.js 存在', fs.existsSync(path.join(ROOT, 'src', 'main', 'core', 'sakurafrp.js')));

    const chans = [
      'server:tunnel:status', 'server:tunnel:prepare', 'server:tunnel:sakuraUser',
      'server:tunnel:sakuraTunnels', 'server:tunnel:sakuraNodes', 'server:tunnel:sakuraCreate',
      'server:tunnel:start', 'server:tunnel:stop', 'server:tunnel:diagnose',
    ];
    const missing = chans.filter((c) => !ipc.includes(`'${c}'`));
    P('IPC 通道全部注册', missing.length === 0, missing);

    const m = /const INVOKE_RE = (\/.*\/);/.exec(pre);
    if (m) {
      // eslint-disable-next-line no-eval
      const re = eval(m[1]);
      P('白名单放行 server:tunnel:start', re.test('server:tunnel:start') === true);
      P('白名单放行 server:tunnel（两段）', re.test('server:tunnel') === true);
    } else {
      P('能解析 INVOKE_RE', false);
    }

    // 事件三处
    const evtRe = /const EVENT_RE = (\/.*\/);/.exec(pre);
    if (evtRe) {
      // eslint-disable-next-line no-eval
      const re = eval(evtRe[1]);
      P('EVENT_RE 放行 server:tunnel:log', re.test('server:tunnel:log') === true);
      P('EVENT_RE 放行 server:tunnel:state', re.test('server:tunnel:state') === true);
      P('EVENT_RE 放行 server:log', re.test('server:log') === true);
    }
    P('bridge 转发了穿透日志', /server:tunnel:log/.test(bridge));
    P('bridge 转发了穿透状态', /server:tunnel:state/.test(bridge));

    P('页面有「内网穿透」tab', /data-tab="tunnel"/.test(page));
    P('页面有樱花frp 表单', /sk-token/.test(page));
    P('页面有自建 frps 表单', /cs-addr/.test(page));
    P('页面有引擎安装按钮', /srv-tunnel-prepare/.test(page));
    P('页面写明了「frp」', /frp/.test(page));
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined && c.info !== '' ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);

  try {
    await tun.stop();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.log('\nFATAL ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
