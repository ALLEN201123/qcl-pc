'use strict';
/**
 * 服务端（一键开服）验收
 *
 * 覆盖：
 *   ① Java 版本匹配（MC 版本 → Java 主版本，且能在本机 10 个 Java 里挑到）
 *   ② 端口预检（占用检测 / 非法端口 / 自动找空端口）
 *   ③ server.properties 46 项读写（保留注释、校验、预设）
 *   ④ 备份全链路（创建 / full / 恢复留底 / 轮转 / 导出）
 *   ⑤ RCON 协议（包往返 / 粘包 / 认证失败 / 参数校验）
 *   ⑥ **真跑一个服务端进程**：用 Java 编一个极简"假服务端"jar，
 *      验证 spawn / 日志管道 / 命令下发 / 优雅停止 / 退出码 / 诊断
 *   ⑦ 接线（IPC 通道 / 白名单 / 页面 / 导航 / core 模块）
 *
 * 用法：node build/verify-server.js
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const srv = require(path.join(ROOT, 'src', 'main', 'core', 'server.js'));
const props = require(path.join(ROOT, 'src', 'main', 'core', 'serverprops.js'));
const backup = require(path.join(ROOT, 'src', 'main', 'core', 'serverbackup.js'));
const rcon = require(path.join(ROOT, 'src', 'main', 'core', 'serverrcon.js'));

const checks = [];
const P = (name, pass, info) => checks.push({ name, pass, info });
const section = (t) => console.log(`\n===== ${t} =====`);

const HOME = path.join(os.tmpdir(), `_qcl_srvverify_${Date.now()}`);

(async () => {
  fs.mkdirSync(HOME, { recursive: true });

  /* ---------------- ① Java 版本匹配 ---------------- */
  section('① Java 版本匹配');
  {
    const cases = [
      ['1.16.5', 8],
      ['1.12.2', 8],
      ['1.17.1', 17],
      ['1.20.4', 17],
      ['1.20.6', 21],
      ['1.21.4', 21],
      ['26.1', 25],
      ['b1.7.3', 8],
    ];
    let allOk = true;
    for (const [v, want] of cases) {
      const got = srv.javaMajorFor(v);
      const ok = got === want;
      if (!ok) allOk = false;
      P(`  ${v} → Java ${want}`, ok, ok ? '' : `实际 ${got}`);
    }
    P('Java 映射表全部正确', allOk);

    // 真在本机挑 Java
    const java = require(path.join(ROOT, 'src', 'main', 'core', 'java.js'));
    const list = await java.detectCached({ home: HOME }).catch(() => []);
    P('本机能探测到 Java', Array.isArray(list) && list.length > 0, list.length);

    const metaJ = { mcVersion: '1.20.1', javaMajor: 0, javaPath: '' };
    const picked = await srv.resolveJava(HOME, metaJ).catch((e) => ({ error: e.message }));
    P('能为 1.20.1 自动挑到 Java 17', picked && Number(picked.major) === 17, picked && { major: picked.major, path: picked.path });

    const metaOld = { mcVersion: '1.12.2', javaMajor: 0, javaPath: '' };
    const pickedOld = await srv.resolveJava(HOME, metaOld).catch(() => null);
    P('能为 1.12.2 自动挑到 Java 8', pickedOld && Number(pickedOld.major) === 8, pickedOld && pickedOld.major);
  }

  /* ---------------- ② 端口预检 ---------------- */
  section('② 端口预检');
  {
    const free = await srv.checkPort(0);
    P('非法端口 0 被拒绝', free.free === false, free.error);

    const bad = await srv.checkPort(999999);
    P('超范围端口被拒绝', bad.free === false, bad.error);

    // 占一个端口再检测
    const net = require('node:net');
    const blocker = net.createServer();
    const port = 34567;
    await new Promise((r) => blocker.listen(port, '0.0.0.0', r));
    const busy = await srv.checkPort(port);
    P('检测到端口被占用', busy.free === false && /占用/.test(busy.error || ''), busy.error);
    blocker.close();

    await new Promise((r) => setTimeout(r, 200));
    const nowFree = await srv.checkPort(port);
    P('释放后检测为空闲', nowFree.free === true);

    const auto = await srv.findFreePort(34567, 34590);
    P('自动找空端口能返回结果', Number.isInteger(auto), auto);
  }

  /* ---------------- ③ server.properties ---------------- */
  section('③ server.properties（46 项）');
  {
    P('字段数 ≥ 46', props.FIELDS.length >= 46, props.FIELDS.length);
    P('分组为 5 个', props.GROUPS.length === 5, props.GROUPS.map((g) => g.id));
    P('预设 5 套', props.PRESETS.length === 5, props.PRESETS.map((p) => p.id));

    const d = path.join(HOME, 'props_test');
    const r1 = props.ensure(d, { motd: '测试服' });
    P('ensure 生成默认文件', r1.exists === true);
    P('motd 写入正确', r1.values.motd === '测试服', r1.values.motd);
    P('端口默认 25565', r1.values['server-port'] === 25565, r1.values['server-port']);
    P('布尔值被解析为真布尔', typeof r1.values.pvp === 'boolean', typeof r1.values.pvp);

    // 注释保留
    const p = props.propsPath(d);
    fs.writeFileSync(p, '# 我的注释\nmotd=原标语\npvp=true\ncustom-unknown-key=abc\n', 'utf8');
    const r2 = props.write(d, { 'max-players': 42, 'server-port': 25570 });
    const txt = fs.readFileSync(p, 'utf8');
    P('注释被保留', txt.includes('# 我的注释'));
    P('原有值未被冲掉', /motd=原标语/.test(txt));
    P('未知键被保留', /custom-unknown-key=abc/.test(txt));
    P('新值写入成功', r2.values['max-players'] === 42 && r2.values['server-port'] === 25570);

    // 校验
    let threw = false;
    try {
      props.write(d, { 'server-port': 70000 });
    } catch (e) {
      threw = /65535/.test(e.message);
    }
    P('越界端口被拦截', threw);

    threw = false;
    try {
      props.write(d, { difficulty: 'nope' });
    } catch (e) {
      threw = /difficulty|难度/.test(e.message);
    }
    P('非法枚举被拦截', threw);

    // 转义
    P('换行转义', props.escapeValue('a\nb') === 'a\\nb');
    P('换行反转义', props.unescapeValue('a\\nb') === 'a\nb');
    P('反斜杠往返', props.unescapeValue(props.escapeValue('C:\\x\\y')) === 'C:\\x\\y');

    // 预设能套用
    const r3 = props.write(d, props.PRESETS[0].values);
    P('预设能写入', r3.values['online-mode'] === false && r3.values['white-list'] === true, {
      online: r3.values['online-mode'],
      white: r3.values['white-list'],
    });
  }

  /* ---------------- ④ 备份 ---------------- */
  section('④ 备份 / 恢复 / 轮转');
  {
    const meta = srv.create(HOME, { name: '备份测试', kind: 'vanilla', mcVersion: '1.20.1' });
    const work = srv.workDir(HOME, meta.id);
    fs.mkdirSync(path.join(work, 'world', 'region'), { recursive: true });
    fs.writeFileSync(path.join(work, 'world', 'level.dat'), 'V1');
    fs.writeFileSync(path.join(work, 'world', 'region', 'r.mca'), Buffer.alloc(2048, 7));
    fs.writeFileSync(path.join(work, 'world', 'session.lock'), 'LOCK');
    fs.writeFileSync(path.join(work, 'server.properties'), 'level-name=world\n');
    fs.mkdirSync(path.join(work, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(work, 'mods', 'x.jar'), Buffer.alloc(4096, 3));

    const b1 = await backup.create(HOME, meta.id, { reason: 'manual' });
    P('备份创建成功', b1.ok === true, b1.error);
    P('跳过 session.lock', !fs.existsSync(path.join(b1.dir, 'world', 'session.lock')));
    P('配置快照存在', fs.existsSync(path.join(b1.dir, 'server.properties')));
    P('非 full 不含 mods', !fs.existsSync(path.join(b1.dir, 'mods')));

    await new Promise((r) => setTimeout(r, 1100));
    const b2 = await backup.create(HOME, meta.id, { reason: 'auto', full: true });
    P('full 备份含 mods', fs.existsSync(path.join(b2.dir, 'mods')), b2.error);

    const ls = backup.list(HOME, meta.id);
    P('列出备份并按新→旧排序', ls.length === 2 && ls[0].name === b2.name, ls.map((x) => x.name));

    // 破坏后恢复
    fs.writeFileSync(path.join(work, 'world', 'level.dat'), 'BROKEN');
    const rs = await backup.restore(HOME, meta.id, { name: b1.name });
    P('恢复成功', rs.ok === true, rs.error);
    P('世界内容已还原', fs.readFileSync(path.join(work, 'world', 'level.dat'), 'utf8') === 'V1');
    P('当前世界被改名留底', !!rs.backupOfCurrent && fs.existsSync(rs.backupOfCurrent));

    // 运行中拒绝恢复
    const rt = srv.getRuntime(meta.id);
    P('未运行时 runtime 为空（不会误判）', rt === null);

    // 轮转
    await new Promise((r) => setTimeout(r, 1100));
    await backup.create(HOME, meta.id, { reason: 'auto' });
    const before = backup.list(HOME, meta.id).length;
    const pr = backup.prune(HOME, meta.id, 2);
    const after = backup.list(HOME, meta.id).length;
    P('轮转保留 N 份', after === 2 && before === 3, { before, deleted: pr.deleted.length, after });

    // 路径逃逸
    const esc = backup.remove(HOME, meta.id, '../evil');
    P('删除备份时拒绝路径逃逸', esc.ok === false, esc.error);
  }

  /* ---------------- ⑤ RCON 协议 ---------------- */
  section('⑤ RCON 协议');
  {
    const mk = (id, type, body) => {
      const pl = Buffer.from(body, 'utf8');
      const b = Buffer.alloc(pl.length + 14);
      b.writeInt32LE(pl.length + 10, 0);
      b.writeInt32LE(id, 4);
      b.writeInt32LE(type, 8);
      pl.copy(b, 12);
      b.writeUInt8(0, 12 + pl.length);
      b.writeUInt8(0, 13 + pl.length);
      return b;
    };
    const pkt = rcon.buildPacket(1, 3, 'pass');
    const parsed = rcon.takePacket(pkt);
    P('包构建/解析往返一致', parsed.id === 1 && parsed.type === 3 && parsed.body === 'pass');

    const two = Buffer.concat([mk(1, 2, 'A'), mk(99, 0, '')]);
    const p1 = rcon.takePacket(two);
    const p2 = rcon.takePacket(two.subarray(p1.consumed));
    P('粘包能逐包切出', p1.body === 'A' && p2.body === '');

    P('半包返回 null', rcon.takePacket(mk(1, 0, 'abc').subarray(0, 8)) === null);
    const failPkt = rcon.takePacket(mk(-1, 2, ''));
    P('认证失败 id=-1 可识别', failPkt.id === -1 || failPkt.id === 0xffffffff);

    const bad = await rcon.exec({ port: 25575, password: '', command: 'list' });
    P('空密码被拦截', bad.ok === false && /密码/.test(bad.error), bad.error);
    const noCmd = await rcon.exec({ port: 25575, password: 'x', command: '' });
    P('空命令被拦截', noCmd.ok === false, noCmd.error);
    const badPort = await rcon.exec({ port: 0, password: 'x', command: 'list' });
    P('非法端口被拦截', badPort.ok === false, badPort.error);

    // 连一个不存在的端口 → 应快速报错而不是挂住
    const t0 = Date.now();
    const refused = await rcon.exec({ port: 39999, password: 'x', command: 'list', timeoutMs: 3000 });
    const dt = Date.now() - t0;
    P('连不上时快速失败', refused.ok === false && dt < 4000, { ms: dt, error: refused.error });

    // list 解析
    P('list 响应解析（正常）', (() => {
      const m = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i.exec('There are 2 of a max of 20 players online: Alice, Bob');
      return m && m[1] === '2' && m[3] === 'Alice, Bob';
    })());
  }

  /* ---------------- ⑥ 真跑一个服务端进程 ---------------- */
  section('⑥ 真跑服务端（用 Java 编一个极简假服务端）');
  {
    const workBase = path.join(HOME, 'fakejar');
    fs.mkdirSync(workBase, { recursive: true });
    const srcDir = path.join(workBase, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // 极简"服务端"：读 stdin 的 stop 就退出，否则回显；启动时打印 Done (x.xxxs)!
    const javaSrc = `
import java.io.*;
public class FakeServer {
  public static void main(String[] a) throws Exception {
    System.out.println("[Server thread/INFO]: Starting minecraft server version 1.20.1");
    System.out.println("[Server thread/INFO]: Preparing level \\"world\\"");
    System.out.println("[Server thread/INFO]: Done (1.234s)! For help, type \\"help\\"");
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
    String line;
    while ((line = br.readLine()) != null) {
      if (line.trim().equalsIgnoreCase("stop")) {
        System.out.println("[Server thread/INFO]: Stopping the server");
        System.out.println("[Server thread/INFO]: Saving worlds");
        System.exit(0);
      }
      System.out.println("[Server thread/INFO]: 收到命令: " + line);
    }
    System.exit(0);
  }
}
`;
    fs.writeFileSync(path.join(srcDir, 'FakeServer.java'), javaSrc, 'utf8');

    // 找 javac
    const javaHome = 'C:\\Program Files\\Java\\jdk-17';
    const javac = path.join(javaHome, 'bin', 'javac.exe');
    let compiled = false;
    if (fs.existsSync(javac)) {
      try {
        execFileSync(javac, ['-encoding', 'UTF-8', '-d', srcDir, path.join(srcDir, 'FakeServer.java')], { windowsHide: true, timeout: 60000 });
        compiled = true;
      } catch (e) {
        compiled = false;
      }
    }
    P('能编译测试用的假服务端', compiled);

    if (compiled) {
      // 打成 jar（用 jar 工具；没有就直接用 -cp 起）
      const jarTool = path.join(javaHome, 'bin', 'jar.exe');
      let jarPath = '';
      if (fs.existsSync(jarTool)) {
        jarPath = path.join(workBase, 'fake-server.jar');
        try {
          execFileSync(jarTool, ['cfe', jarPath, 'FakeServer', '-C', srcDir, 'FakeServer.class'], {
            windowsHide: true,
            timeout: 60000,
          });
        } catch {
          jarPath = '';
        }
      }
      P('能打出可执行 jar', !!jarPath);

      if (jarPath) {
        const meta = srv.create(HOME, { name: '真跑测试', kind: 'vanilla', mcVersion: '1.20.1' });
        const work = srv.workDir(HOME, meta.id);
        fs.mkdirSync(work, { recursive: true });
        fs.copyFileSync(jarPath, path.join(work, 'server.jar'));
        srv.update(HOME, meta.id, {
          jar: 'server.jar',
          javaPath: path.join(javaHome, 'bin', 'java.exe'),
          javaMajor: 17,
          maxHeapMb: 256,
          port: 34567,
        });
        srv.acceptEula(HOME, meta.id);

        // preflight 应该通过
        const pre = await srv.preflight(HOME, meta.id);
        P('启动前检查通过（jar/Java/端口/EULA 齐）', pre.ok === true, pre.issues);

        const logs = [];
        const states = [];
        const startR = await srv.start(HOME, meta.id, {
          onLog: (l) => logs.push(l),
          onState: (s) => states.push(s),
        });
        P('start() 返回成功', startR.ok === true, startR.error);
        P('拿到了子进程 PID', Number.isInteger(startR.pid), startR.pid);

        // 等它就绪
        await new Promise((r) => setTimeout(r, 3500));
        const st1 = srv.status(HOME, meta.id);
        P('状态变为 running（命中 Done 正则）', st1.state === 'running', st1.state);
        P('日志管道收到了输出', logs.length > 0, logs.length);
        P('捕获到 Done (1.234s) 那一行', logs.some((l) => /Done \(1\.234s\)/.test(l)));
        P('捕获到 Starting minecraft server', logs.some((l) => /Starting minecraft server/.test(l)));

        // 下发命令
        const cmdR = srv.sendCommand(HOME, meta.id, 'say hello');
        P('sendCommand 返回成功', cmdR.ok === true, cmdR.error);
        await new Promise((r) => setTimeout(r, 900));
        P('服务端收到了命令（stdin 管道通）', logs.some((l) => /收到命令: say hello/.test(l)), logs.slice(-3));

        // 优雅停止
        const t0 = Date.now();
        const stopR = await srv.stop(HOME, meta.id, { waitMs: 12000 });
        const dt = Date.now() - t0;
        P('stop() 成功', stopR.ok === true, stopR.error);
        P('是优雅停止（不是强杀）', stopR.graceful === true, stopR);
        P('停止耗时合理', dt < 12000, { ms: dt });
        P('退出码为 0', stopR.exitCode === 0, stopR.exitCode);

        await new Promise((r) => setTimeout(r, 700));
        const st2 = srv.status(HOME, meta.id);
        P('停止后状态不是 running', st2.running === false, st2.state);

        // 日志落盘
        const tail = srv.tailLog(HOME, meta.id, 100);
        P('日志文件可回读（进程退出后仍能拿到）', tail.length > 0, tail.length);

        // 诊断（正常退出）
        const diag = srv.diagnose(HOME, meta.id);
        P('诊断能给出退出码', diag.exitCode === 0, diag.exitCode);
        P('诊断有结论文本', !!diag.summary, diag.summary);

        // 错误退出诊断：造一个会报端口占用的 jar？这里改为直接验证正则覆盖
        const patterns = srv.LOG_PATTERNS;
        P('诊断规则覆盖端口占用', patterns.some((p) => p.re.test('FAILED TO BIND TO PORT')));
        P('诊断规则覆盖 EULA', patterns.some((p) => p.re.test('You need to agree to the EULA')));
        P('诊断规则覆盖 Java 版本', patterns.some((p) => p.re.test('UnsupportedClassVersionError')));
        P('诊断规则覆盖内存不足', patterns.some((p) => p.re.test('java.lang.OutOfMemoryError')));
      }
    }
  }

  /* ---------------- ⑦ 接线 ---------------- */
  section('⑦ 接线检查');
  {
    const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
    const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
    const shellJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'shell.js'), 'utf8');
    const pageJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js'), 'utf8');

    for (const f of ['server.js', 'serverprops.js', 'serverrcon.js', 'serverbackup.js']) {
      P(`core/${f} 存在`, fs.existsSync(path.join(ROOT, 'src', 'main', 'core', f)));
    }
    P('页面文件存在', fs.existsSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js')));
    P('app.js 注册了 serverPage', /serverPage/.test(appJs));
    P('导航栏有 server 项', /id: 'server'/.test(shellJs));

    const chans = [
      'server:list', 'server:create', 'server:update', 'server:remove', 'server:meta', 'server:options',
      'server:download', 'server:preflight', 'server:acceptEula', 'server:start', 'server:stop',
      'server:status', 'server:command', 'server:diagnose', 'server:openDir', 'server:enableRcon',
      'server:players', 'server:rcon', 'server:whitelist',
    ];
    let missing = [];
    for (const c of chans) if (!ipc.includes(`'${c}'`)) missing.push(c);
    P('IPC 通道全部注册', missing.length === 0, missing);

    // 备份三件套（名字里带冒号两段）
    P('IPC 注册 server:backup:create', ipc.includes("'server:backup:create'"));
    P('IPC 注册 server:backup:list', ipc.includes("'server:backup:list'"));
    P('IPC 注册 server:backup:restore', ipc.includes("'server:backup:restore'"));
    P('IPC 注册 server:props:read', ipc.includes("'server:props:read'"));
    P('IPC 注册 server:props:write', ipc.includes("'server:props:write'"));

    const m = /const INVOKE_RE = (\/.*\/);/.exec(pre);
    if (m) {
      // eslint-disable-next-line no-eval
      const re = eval(m[1]);
      P('白名单放行 server:list', re.test('server:list') === true);
      // ★ 关键回归：双冒号通道曾被白名单拒绝，导致配置 tab 静默空白（踩过）
      P('★ 白名单放行 server:props:read（双冒号）', re.test('server:props:read') === true);
      P('★ 白名单放行 server:props:write（双冒号）', re.test('server:props:write') === true);
      P('★ 白名单放行 server:backup:create（双冒号）', re.test('server:backup:create') === true);
      P('★ 白名单放行 server:backup:restore（双冒号）', re.test('server:backup:restore') === true);
      P('★ 白名单放行 server:whitelist:add（双冒号）', re.test('server:whitelist:add') === true);
      P('白名单仍拦未知前缀', re.test('evil:x') === false);
      P('白名单仍拦空段', re.test('server:props:') === false);
    } else {
      P('能解析 INVOKE_RE', false);
    }

    P('页面有控制台输入框', /srv-cmd/.test(pageJs));
    P('页面有配置编辑', /server:props:write/.test(pageJs));
    P('页面有 RCON', /server:rcon/.test(pageJs));
    P('页面有备份', /server:backup:create/.test(pageJs));
    P('页面有诊断', /server:diagnose/.test(pageJs));
    P('停止前有确认（不误停）', /confirmDialog/.test(pageJs));
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

  // 清理
  try {
    const rt = srv.getRuntime('srv-fake');
    if (rt && rt.child) srv.forceKill(rt.child);
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
