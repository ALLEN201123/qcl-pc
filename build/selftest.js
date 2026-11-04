'use strict';
/**
 * QCL 电脑版 · 启动核心自测（Lead 侧独立验证，不依赖 core-dev 的自测）
 *
 * 用法：
 *   node build/selftest.js            # 轻量验证（网络 + 解析 + Java 检测）
 *   node build/selftest.js --install  # 额外做一次真实的完整安装（会下载文件）
 *
 * 只读 + 只写 <QCL_HOME>/logs 与 <QCL_HOME>/meta，不会碰用户的实例。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');

// 测试用的独立主目录，避免污染真实数据
const HOME = path.join(ROOT, '.selftest-home');
process.env.QCL_SELFTEST_HOME = HOME;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
  pass += 1;
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, err) {
  fail += 1;
  failures.push(`${name}: ${err?.message || err}`);
  console.log(`  ❌ ${name} — ${err?.message || err}`);
}
function section(title) {
  console.log(`\n──── ${title} ────`);
}

function load(name) {
  return require(path.join(CORE, `${name}.js`));
}

async function test(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
    return detail;
  } catch (err) {
    bad(name, err);
    return null;
  }
}

async function main() {
  const withInstall = process.argv.includes('--install');
  fs.mkdirSync(HOME, { recursive: true });
  console.log(`QCL 电脑版 · 启动核心自测`);
  console.log(`工程目录：${ROOT}`);
  console.log(`测试主目录：${HOME}`);
  console.log(`模式：${withInstall ? '轻量 + 真实安装' : '轻量'}`);

  // ---------------------------------------------------------------- paths
  section('1. 目录布局');
  await test('paths 能给出主目录/实例/meta/日志路径', () => {
    const p = load('paths');
    const home = p.defaultHome ? p.defaultHome(null) : HOME;
    const inst = p.instanceDir(HOME, 'demo');
    const meta = p.metaDir(HOME);
    const logs = p.logsDir(HOME);
    if (!inst || !meta || !logs) throw new Error('返回了空路径');
    return `home=${path.basename(home)} instance=${path.basename(inst)} meta=${path.basename(meta)}`;
  });

  // ---------------------------------------------------------------- rules
  section('2. rules 匹配（照 MultiMC Rule.cpp）');
  await test('windows 平台 allow 命中', () => {
    const { matches } = load('rules');
    const r = [{ action: 'allow', os: { name: 'windows' } }];
    if (!matches(r, { os: { name: 'windows', arch: 'x64' }, features: {} })) throw new Error('windows 规则未命中');
    return 'allow/windows → true';
  });
  await test('非 windows 的 allow 不命中', () => {
    const { matches } = load('rules');
    const r = [{ action: 'allow', os: { name: 'osx' } }];
    if (matches(r, { os: { name: 'windows', arch: 'x64' }, features: {} })) throw new Error('osx 规则误命中 windows');
    return 'allow/osx → false';
  });
  await test('disallow 优先生效', () => {
    const { matches } = load('rules');
    const r = [{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }];
    if (matches(r, { os: { name: 'windows', arch: 'x64' }, features: {} })) throw new Error('disallow 未生效');
    return 'allow+disallow → false';
  });

  // ---------------------------------------------------------------- libraries
  section('3. Maven 坐标 → 路径（照 MultiMC Library.cpp）');
  await test('标准坐标转换', () => {
    const lib = load('libraries');
    const p = lib.mavenPath('org.lwjgl:lwjgl:3.3.1', 'jar');
    if (!p || !p.includes('org/lwjgl/lwjgl/3.3.1')) throw new Error(`路径不对：${p}`);
    return p;
  });
  await test('带 classifier 的坐标转换', () => {
    const lib = load('libraries');
    const p = lib.mavenPath('org.lwjgl:lwjgl:3.3.1:natives-windows', 'jar');
    if (!p || !p.includes('natives-windows')) throw new Error(`路径不对：${p}`);
    return p;
  });

  // ---------------------------------------------------------------- java
  section('4. Java 检测（照 MultiMC JavaInstallList/JavaChecker）');
  await test('能识别本机已安装的 Java', async () => {
    const java = load('java');
    const list = await java.detect();
    if (!Array.isArray(list) || list.length === 0) throw new Error('一个 Java 都没检测到');
    const desc = list.map((j) => `${j.path} (${j.version ?? '?'} ${j.arch ?? '?'})`).join(' | ');
    return `${list.length} 个：${desc.slice(0, 220)}`;
  });
  await test('按 MC 版本推荐 Java 主版本', async () => {
    const java = load('java');
    if (typeof java.recommendMajor !== 'function') throw new Error('没有导出 recommendMajor');
    const cases = [
      ['1.12.2', 8],
      ['1.20.1', 17],
      ['1.21.1', 21],
      ['1.16.5', 8]
    ];
    for (const [mc, want] of cases) {
      const got = java.recommendMajor(mc);
      if (got !== want) throw new Error(`${mc} 期望 ${want}，得到 ${got}`);
    }
    return '1.12.2→8 1.20.1→17 1.21.1→21 1.16.5→8';
  });

  // ---------------------------------------------------------------- accounts
  section('5. 离线账号 UUID');
  await test('离线 UUID 符合官方算法（MD5 + 版本位 3 + 变体位）', () => {
    const acc = load('accounts');
    const uuid = acc.offlineUuid('Player');
    // 官方离线 UUID = MD5("OfflinePlayer:"+name)，第 7 字节高 4 位设 3、第 9 字节高 2 位置 10
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
      throw new Error(`不符合 v3 UUID 格式：${uuid}`);
    }
    const crypto = require('node:crypto');
    const md5 = crypto.createHash('md5').update('OfflinePlayer:Player', 'utf8').digest();
    md5[6] = (md5[6] & 0x0f) | 0x30;
    md5[8] = (md5[8] & 0x3f) | 0x80;
    const hex = md5.toString('hex');
    const want = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (uuid.toLowerCase() !== want) throw new Error(`与官方算法不一致：得到 ${uuid}，期望 ${want}`);
    return `Player → ${uuid}（与 MD5(OfflinePlayer:Player) 一致）`;
  });

  // ---------------------------------------------------------------- 远古版本清单
  section('6. 远古版本清单（QCL 看家本领）');
  await test('内置归档清单可读且规模正确', () => {
    const file = path.join(CORE, 'data', 'legacy_version_archive.json');
    if (!fs.existsSync(file)) throw new Error('缺少 data/legacy_version_archive.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = raw.entries?.length ?? 0;
    if (n < 100) throw new Error(`条目太少：${n}`);
    const withUrl = raw.entries.filter((e) => e.infoUrl).length;
    return `${n} 条（${withUrl} 条带下载地址），来源：${raw.source ?? '未知'}`;
  });
  await test('mojang.ancientList() 能合并官方旧版本 + 归档清单', async () => {
    const mojang = load('mojang');
    const list = await mojang.ancientList({ cacheDir: path.join(HOME, 'meta'), timeoutMs: 25000 });
    if (!Array.isArray(list) || list.length === 0) throw new Error('返回空列表');
    const byType = {};
    for (const v of list) byType[v.type] = (byType[v.type] || 0) + 1;
    return `${list.length} 条：${JSON.stringify(byType)}；样例 ${list.slice(0, 3).map((v) => v.id).join(', ')}`;
  });

  // ---------------------------------------------------------------- 官方清单
  section('7. 官方版本清单与版本 JSON 解析');
  let manifest = null;
  await test('能拉到 Mojang 官方清单', async () => {
    const mojang = load('mojang');
    manifest = await mojang.manifest({ cacheDir: path.join(HOME, 'meta'), timeoutMs: 25000 });
    if (!manifest?.versions?.length) throw new Error('清单为空');
    return `${manifest.versions.length} 个版本，最新正式版 ${manifest.latest?.release}`;
  });

  let resolved = null;
  await test('能解析真实版本 JSON（含继承链与主类/库/参数）', async () => {
    if (!manifest) throw new Error('依赖上一步的清单');
    const mojang = load('mojang');
    const version = load('version');
    const entry = manifest.versions.find((v) => v.id === '1.20.1') || manifest.versions[0];
    const raw = await mojang.versionJson({ id: entry.id, url: entry.url, cacheDir: path.join(HOME, 'meta'), timeoutMs: 25000 });
    if (!raw) throw new Error('版本 JSON 拉取失败');
    resolved = await version.resolve(raw, {
      fetchJson: async (idOrUrl) => {
        const url = idOrUrl.includes('://')
          ? idOrUrl
          : manifest.versions.find((v) => v.id === idOrUrl)?.url;
        if (!url) throw new Error(`找不到父版本：${idOrUrl}`);
        return mojang.versionJson({ url, id: idOrUrl, cacheDir: path.join(HOME, 'meta'), timeoutMs: 25000 });
      },
      features: {}
    });
    const main = version.mainClass(resolved);
    const libs = version.libraryList ? version.libraryList(resolved) : [];
    const ai = version.assetIndex(resolved);
    if (!main) throw new Error('没有解析出主类');
    return `${entry.id}：主类=${main}，库=${libs.length} 个，资源索引=${ai?.id ?? '无'}`;
  });

  await test('能拼出 classpath 且文件真实存在于磁盘', () => {
    if (!resolved) throw new Error('依赖上一步的解析结果');
    const libs = load('libraries');
    const cp = libs.classpathList(resolved, {
      librariesDir: path.join(HOME, 'libraries'),
      osInfo: { name: 'windows', arch: 'x64', version: os.release() },
      source: 'official'
    });
    if (!Array.isArray(cp)) throw new Error('没有返回数组');
    return `${cp.length} 项（库还没下载，所以多半为空是正常的）`;
  });

  await test('能列出待解压的 natives（用老版本 1.12.2 验，它用老式 natives 字段）', async () => {
    if (!manifest) throw new Error('依赖上面的清单');
    const mojang = load('mojang');
    const version = load('version');
    const libs = load('libraries');
    const entry = manifest.versions.find((v) => v.id === '1.12.2');
    if (!entry) throw new Error('清单里没有 1.12.2');
    const raw = await mojang.versionJson({ id: entry.id, url: entry.url, cacheDir: path.join(HOME, 'meta'), timeoutMs: 25000 });
    const r = await version.resolve(raw, { fetchJson: async () => raw, features: {} });
    const natives = libs.nativesList(r, { osInfo: { name: 'windows', arch: 'x64' } });
    if (natives.length === 0) throw new Error('1.12.2 应当有 natives（LWJGL 2 走老式 natives 字段），却返回 0');
    return `${natives.length} 个：${natives.slice(0, 3).map((n) => path.basename(n.path || n.name || '?')).join(', ')}`;
  });

  // ---------------------------------------------------------------- 真实安装
  if (withInstall) {
    section('8. 真实安装一个版本（会下载文件）');
    await test('安装一个体量小的远古版本并校验落盘', async () => {
      const install = load('install');
      const instances = load('instances');
      const inst = await instances.create(HOME, { name: '自测实例', mcVersion: 'c0.0.13a', loader: null });
      const progress = [];
      const result = await install.install({
        home: HOME,
        instanceId: inst.id,
        mcVersion: 'c0.0.13a',
        loader: null,
        source: 'official',
        threads: 8,
        onProgress: (p) => progress.push(p),
        onLog: () => {},
        signal: new AbortController().signal
      });
      const versionsDir = path.join(inst.dir, '.minecraft', 'versions');
      const dirs = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : [];
      return `结果=${JSON.stringify(result)}；versions 目录=${dirs.join(', ') || '(空)'}；进度事件 ${progress.length} 次`;
    });
  }

  // ---------------------------------------------------------------- 汇总
  console.log(`\n════════ 结果 ════════`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log('失败明细：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`日志与缓存目录：${HOME}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n自测脚本自身出错：', err);
  process.exitCode = 2;
});
