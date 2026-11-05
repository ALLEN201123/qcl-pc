'use strict';
/**
 * 验收：启动命令行（dryRun，不真起游戏）
 *
 * 用户提的三件事都要在这条命令里体现出来：
 *   ① `--versionType QCL 1.0.0` —— 游戏 F3 / 崩溃报告里能看到 QCL 标识
 *   ② 没有任何 `${xxx}` 字面量残留（`${clientid}` / `${auth_xuid}` 曾经原样传进游戏）
 *   ③ classpath 里有加载器的 jar（fabric-loader / forge / sponge-mixin …），「空壳」已修
 *
 * 用法：node build/verify-launch-args.js [实例id]
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const launch = require(path.join(CORE, 'launch.js'));
const instances = require(path.join(CORE, 'instances.js'));
const accounts = require(path.join(CORE, 'accounts.js'));

const checks = [];
const push = (name, pass, info) => checks.push({ name, pass, info });

(async () => {
  const wantId = process.argv[2] || '';
  const list = await instances.list(HOME);
  if (!list.length) {
    console.log('没有实例，无法验收');
    process.exit(1);
  }
  /**
   * ★ 默认挑「现代版本」实例（有 --versionType / --clientId / --xuid 这些新式参数）。
   *   远古实例（b1.7.3 等）用的是老式启动参数，本来就没有这些字段 ——
   *   取到它会误报 FAIL，不是产品回归。
   */
  const isModern = (i) => {
    const v = String((i && i.installedVersion) || (i && i.mcVersion) || '');
    // 老式：b1.7.3 / a1.x / c0.x / inf- / 11w / 1.0.0-rc / 1.0~1.12
    return /^(?:1\.(?:1[3-9]|[2-9]\d)|2\d\.)/.test(v) || /^fabric-loader|^forge-|^26\./.test(v);
  };
  const inst = wantId
    ? list.find((i) => i.id === wantId)
    : list.find(isModern) || list[0];
  if (!inst) {
    console.log('找不到实例:', wantId);
    process.exit(1);
  }
  const account = (await accounts.list(HOME)).find((a) => a.selected) || null;

  console.log(`实例：${inst.name}（${inst.id}）  installedVersion=${inst.installedVersion}  loader=${JSON.stringify(inst.loader)}`);
  console.log(`账号：${account ? `${account.name}（${account.type}，xuid=${account.xuid || '无'}）` : '无'}`);
  console.log('');

  const settings = {
    downloader: { source: 'official', threads: 4 },
    javaPath: null,
    game: { resolution: { width: 854, height: 480 }, minMemoryMb: 512, debugLog: false, keepLauncherOpen: true },
    javaExtraDirs: [],
  };

  let result;
  try {
    result = await launch.launch({
      home: HOME,
      instance: inst,
      account,
      settings,
      dryRun: true,
    });
  } catch (e) {
    console.log('启动（干跑）失败：', e && e.message);
    process.exit(1);
  }

  const args = result.args || [];
  const line = args.join(' ');

  push('① 命令行里有 --versionType QCL x.y.z', /--versionType\s+QCL\s+\d+\.\d+\.\d+/.test(line), (line.match(/--versionType\s+\S+(?:\s+\S+)?/) || [])[0]);
  const leftovers = [...new Set((line.match(/\$\{[a-zA-Z_]+\}/g) || []))];
  push('② 没有未替换的 ${xxx} 占位符', leftovers.length === 0, leftovers);
  push('③ --clientId 是真实值', !!args.find((a, i) => args[i - 1] === '--clientId' && /^[0-9a-f]{8}/i.test(a)), args[args.indexOf('--clientId') + 1]);
  if (account && account.type === 'microsoft') {
    const xuidVal = args[args.indexOf('--xuid') + 1] || '';
    push('④ --xuid 是真实值（微软账号）', /^\d{6,}$/.test(xuidVal), xuidVal);
  } else {
    push('④ --xuid（离线账号可以为空）', true, args[args.indexOf('--xuid') + 1] || '(无该参数)');
  }

  const cpEntry = (() => {
    const idx = args.findIndex((a) => a === '-cp' || a === '-classpath');
    return idx >= 0 ? args[idx + 1] : '';
  })();
  const cpParts = cpEntry ? cpEntry.split(';') : [];
  const loaderJars = cpParts.filter((p) => /fabric-loader|quilt-loader|forge-|sponge-mixin|launchwrapper/i.test(p));
  push('⑤ classpath 里有加载器 jar（不再是空壳）', loaderJars.length > 0, {
    条目数: cpParts.length,
    加载器相关: loaderJars.map((p) => path.basename(p)).slice(0, 5),
  });
  push('⑥ classpath 里每个文件都真实存在', cpParts.length > 0 && cpParts.every((p) => fs.existsSync(p)), {
    缺失: cpParts.filter((p) => !fs.existsSync(p)).slice(0, 5),
  });
  push('⑦ -Dminecraft.launcher.brand=QCL', args.includes('-Dminecraft.launcher.brand=QCL'), args.find((a) => a.startsWith('-Dminecraft.launcher.brand')));
  // ★ 游戏内 QCL 签名（照 HMCL）：versionType / clientmodname / minecraft.client.jar / 环境变量
  push('⑧ versionType 是 QCL 版本串', /--versionType\s+QCL\s+\d+\.\d+\.\d+/.test(line), (line.match(/--versionType\s+\S+(?:\s+\S+)?/) || [])[0]);
  push('⑨ -Dnet.minecraft.clientmodname=QCL', args.includes('-Dnet.minecraft.clientmodname=QCL'), args.find((a) => a.startsWith('-Dnet.minecraft.clientmodname')));
  push('⑩ -Dminecraft.client.jar 指向真实 jar',
    args.some((a) => a.startsWith('-Dminecraft.client.jar=') && fs.existsSync(a.split('=').slice(1).join('='))),
    args.find((a) => a.startsWith('-Dminecraft.client.jar')));

  console.log('================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);
  console.log(`（日志：${result.logFile}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
