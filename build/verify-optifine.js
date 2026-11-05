'use strict';
/*
 * 实测脚本：OptiFine（高清修复）真安装
 *
 * 运行：node build/verify-optifine.js
 *
 * ★ 只写临时 home（build/.verify-optifine），绝不写 C:\Users\123\Documents\QCL。
 * ★ **会真的跑 OptiFine Patcher**：为了做到这一点，脚本会先把
 *   真实的 1.12.2 官方客户端 jar（约 10MB，BMCLAPI 镜像）下到临时实例的 versions/1.12.2/ 下，
 *   因为 OptiFine 的 Patcher 必须拿原版 jar 当输入。本机原本没有 1.12.2 原版 jar。
 *   如果下载失败，脚本会**明确打印「Patcher 未实跑」**并算失败，不会伪造结果。
 *
 * 覆盖：
 *   ① BMCLAPI 列表：1.20.1 原始 14 条 / 过滤预览后 2 条；1.12.2 14 条正式
 *   ② loaderversions：optifine 的 versions/latest/mode/labels/items
 *   ③ 安装器下载：1.12.2 的 jar 是合法 zip 且含 optifine/Patcher.class
 *   ④ **真跑 Patcher**（≤1.12.2）：补丁 jar、版本 JSON、libraries、launchwrapper 全套断言
 *   ⑤ 版本 JSON 能被 version.resolve 正确继承（mainClass 覆盖、tweakClass 追加、父版参数保留）
 *   ⑥ 模式 B（≥1.13）：没装 Forge 时报中文错误 E_OPTIFINE_NEED_FORGE；装了 Forge 后真放进 mods/
 *   ⑦ 工具函数：stripJarEntries 真的只删 META-INF/mods.toml
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');

const optifine = require(path.join(CORE, 'optifine.js'));
const loaderversions = require(path.join(CORE, 'loaderversions.js'));
const instances = require(path.join(CORE, 'instances.js'));
const versionModule = require(path.join(CORE, 'version.js'));
const zip = require(path.join(CORE, 'zip.js'));
const { createZip } = require(path.join(CORE, 'zipwriter.js'));
const http = require(path.join(CORE, 'http.js'));
const paths = require(path.join(CORE, 'paths.js'));

const WORK = path.join(__dirname, '.verify-optifine');
const HOME = path.join(WORK, 'home');

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  /* ------------------------------------------------------- ① BMCLAPI 列表 */
  section('① BMCLAPI OptiFine 列表（真实请求）');
  const list1201 = await optifine.listAll('1.20.1');
  const stable1201 = await optifine.listStable('1.20.1');
  const preview1201 = list1201.filter((x) => x.preview);
  console.log(`  1.20.1：原始 ${list1201.length} 条（预览 ${preview1201.length} 条）→ 正式 ${stable1201.length} 条`);
  for (const e of stable1201) {
    console.log(`    · ${e.version.padEnd(10)} ${e.filename}  label=${e.label}  forge=${e.forge}`);
  }
  console.log(`  预览示例：${list1201.filter((x) => x.preview).slice(0, 2).map((x) => x.version).join(', ')}`);
  check(list1201.length >= 10, '1.20.1 原始列表 ≥10 条（实测 14）', `${list1201.length} 条`);
  check(preview1201.length > 0, '原始列表里确实有预览版（后面要过滤掉）', `${preview1201.length} 条`);
  check(stable1201.length === 2, '过滤预览后正式版 2 条（I5 / I6）', `${stable1201.length} 条`);
  check(stable1201.every((x) => !x.preview && !/^preview_/i.test(x.filename)), '正式版列表里没有 preview_ 文件名');
  check(stable1201[0].version === 'HD_U_I6', '最新正式版是 HD_U_I6（列表新→旧）', stable1201[0].version);
  check(stable1201[0].label === 'OptiFine HD U I6（1.20.1）', 'label 格式正确', stable1201[0].label);
  check(optifine.modeFor('1.20.1') === 'mod', '1.20.1 → mod 模式（Forge 模组）');
  check(optifine.modeFor('1.12.2') === 'patch', '1.12.2 → patch 模式（Patcher）');
  check(optifine.modeFor('1.13') === 'mod' && optifine.modeFor('1.7.10') === 'patch', '1.13 分界正确');

  const stable1122 = await optifine.listStable('1.12.2');
  console.log(`  1.12.2：正式版 ${stable1122.length} 条，最新 ${stable1122[0].version}（${stable1122[0].filename}）`);
  check(stable1122.length === 14, '1.12.2 正式版 14 条', `${stable1122.length} 条`);
  check(stable1122[0].version === 'HD_U_G5', '1.12.2 最新正式版是 HD_U_G5（G6 只有预览版，已过滤）', stable1122[0].version);

  /* ----------------------------------------------------- ② loaderversions */
  section('② loaderversions.js 的 optifine 分支');
  const lv1201 = await loaderversions.listLoaderVersions({ mcVersion: '1.20.1', loader: 'optifine' });
  console.log(`  1.20.1 → ${JSON.stringify(lv1201.optifine).slice(0, 320)}`);
  check(Object.keys(lv1201).length === 1 && !!lv1201.optifine, "loader:'optifine' 只返回 optifine 一类");
  check(Array.isArray(lv1201.optifine.versions) && lv1201.optifine.versions.length === 2, 'versions 2 条');
  check(lv1201.optifine.latest === 'HD_U_I6', 'latest=HD_U_I6', lv1201.optifine.latest);
  check(lv1201.optifine.mode === 'mod', "mode='mod'");
  check(lv1201.optifine.labels && lv1201.optifine.labels.HD_U_I6 === 'OptiFine HD U I6（1.20.1）', 'labels 映射正确');
  check(Array.isArray(lv1201.optifine.items) && lv1201.optifine.items[0].label, 'items 带 label 供界面显示');
  const lv1122 = await loaderversions.listLoaderVersions({ mcVersion: '1.12.2', loader: 'optifine' });
  console.log(`  1.12.2 → versions=${lv1122.optifine.versions.length} latest=${lv1122.optifine.latest} mode=${lv1122.optifine.mode}`);
  check(lv1122.optifine.versions.length === 14 && lv1122.optifine.mode === 'patch', '1.12.2：14 条 + patch 模式');
  const lvAll = await loaderversions.listLoaderVersions({ mcVersion: '1.20.1' });
  console.log(`  （不带 loader）返回的 key：${Object.keys(lvAll).join(', ')}`);
  check(Object.keys(lvAll).includes('optifine'), '不带 loader 时也包含 optifine');
  check(!!lvAll.fabric && !!lvAll.forge, '原有 fabric/forge 类别没被破坏');

  /* ----------------------------------------------------- ③ 安装器下载校验 */
  section('③ 下载 1.12.2 安装器并校验结构');
  const entry1122 = stable1122.find((x) => x.version === 'HD_U_G5') || stable1122[stable1122.length - 1];
  const cacheDir = optifine.cacheDirOf(HOME);
  const installerPath = path.join(cacheDir, entry1122.filename);
  const dl = await http.fetchBuffer(entry1122.downloadUrl, { timeoutMs: 180000 });
  fs.writeFileSync(installerPath, dl);
  const installerEntries = zip.list(installerPath);
  console.log(`  下载 ${entry1122.filename}：${dl.length} 字节，${installerEntries.length} 个条目`);
  console.log(`  含 optifine/Patcher.class? ${installerEntries.includes('optifine/Patcher.class')}｜launchwrapper 相关：${installerEntries.filter((n) => /launchwrapper/i.test(n)).join(', ')}`);
  check(dl.length > 1_000_000, '安装器大小合理（>1MB）', `${dl.length} 字节`);
  check(installerEntries.includes('optifine/Patcher.class'), '安装器里含 optifine/Patcher.class');
  check(installerEntries.includes('launchwrapper-of.txt'), '安装器带 launchwrapper-of.txt（1.12.2 的 launchwrapper 2.2）');

  /* ---------------------------------------- ④ 真跑 Patcher（≤1.12.2 模式 A） */
  section('④ 真跑 Patcher：临时实例 + 真实 1.12.2 官方客户端 jar');
  const inst = await instances.create(HOME, { name: 'OptiFine 1.12.2 测试', mcVersion: '1.12.2' });
  const versionsDir = paths.versionsDir(HOME, inst.id);
  const clientDir = path.join(versionsDir, '1.12.2');
  fs.mkdirSync(clientDir, { recursive: true });
  const clientJar = path.join(clientDir, '1.12.2.jar');
  const parentJson = {
    id: '1.12.2',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory}',
    assets: '1.12',
    assetIndex: { id: '1.12' },
    libraries: [],
    downloads: {},
  };
  let clientOk = false;
  try {
    console.log('  下载真实 1.12.2 官方客户端 jar（BMCLAPI 镜像，约 10MB）…');
    const clientBuf = await http.fetchBuffer('https://bmclapi2.bangbang93.com/version/1.12.2/client', {
      timeoutMs: 180000,
    });
    fs.writeFileSync(clientJar, clientBuf);
    fs.writeFileSync(path.join(clientDir, '1.12.2.json'), JSON.stringify(parentJson, null, 2));
    clientOk = clientBuf.length > 1_000_000 && clientBuf.slice(0, 2).toString('hex') === '504b';
    console.log(`  客户端 jar：${clientBuf.length} 字节，zip 魔术字节=${clientBuf.slice(0, 2).toString('hex')}`);
  } catch (err) {
    console.log(`  ⚠ 下载 1.12.2 客户端 jar 失败：${err && err.message ? err.message : err}`);
  }
  check(clientOk, '真实 1.12.2 客户端 jar 已就绪（Patcher 的前置条件）');
  if (!clientOk) {
    console.log('\n  ⚠ 本机没有可用的 1.12.2 原版 jar 且下载失败 ⇒ **Patcher 未实跑**，下面的模式 A 断言记为失败（不伪造结果）。');
  }

  const logs = [];
  let patchResult = null;
  let patchError = null;
  const t0 = Date.now();
  try {
    patchResult = await optifine.install({
      home: HOME,
      instanceId: inst.id,
      mcVersion: '1.12.2',
      version: entry1122.version,
      onLog: (line) => {
        logs.push(line);
        if (/Patcher|补丁|launchwrapper|版本 JSON|已就位/.test(line)) console.log(`    · ${line}`);
      },
      onProgress: () => {},
    });
  } catch (err) {
    patchError = err;
  }
  const cost = Date.now() - t0;
  console.log(`\n  install() 结果：${patchResult ? JSON.stringify({ mode: patchResult.mode, versionId: patchResult.versionId, version: patchResult.version, launchwrapper: patchResult.launchwrapper }) : `失败：${patchError && patchError.code}｜${patchError && patchError.message}`}`);
  console.log(`  耗时 ${cost} ms`);
  const patcherRan = logs.some((l) => /OptiFine Patcher 完成：退出码 0/.test(l));
  console.log(`  日志里是否有「OptiFine Patcher 完成：退出码 0」：${patcherRan}`);
  check(!!patchResult && patchResult.mode === 'patch', '安装成功且是 patch 模式');
  check(patcherRan, '**Patcher 真的跑过且退出码 0**（不是伪造的）');
  check(!!patchResult && fs.existsSync(patchResult.versionJson), '版本 JSON 已生成', patchResult && patchResult.versionJson);

  if (patchResult && patchResult.mode === 'patch') {
    const json = JSON.parse(fs.readFileSync(patchResult.versionJson, 'utf8'));
    console.log(`  版本 JSON：${JSON.stringify(json)}`);
    check(json.id === `1.12.2-OptiFINE_${entry1122.version}`.replace('OptiFINE', 'OptiFine'), 'id = 1.12.2-OptiFine_<ver>', json.id);
    check(json.inheritsFrom === '1.12.2', 'inheritsFrom = 1.12.2');
    check(json.mainClass === 'net.minecraft.launchwrapper.Launch', 'mainClass = launchwrapper.Launch', json.mainClass);
    check(
      Array.isArray(json.arguments && json.arguments.game) &&
        json.arguments.game.includes('--tweakClass') &&
        json.arguments.game.includes('optifine.OptiFineTweaker'),
      'arguments.game 追加了 --tweakClass optifine.OptiFineTweaker'
    );
    const libNames = (json.libraries || []).map((l) => l.name);
    console.log(`  libraries：${libNames.join(' , ')}`);
    check(libNames.includes(`optifine:OptiFine:1.12.2_${entry1122.version}`), 'libraries 含 optifine:OptiFine:<mc>_<ver>');
    check(libNames.some((n) => /^optifine:launchwrapper(-of)?:\d/.test(n)) || libNames.includes('net.minecraft:launchwrapper:1.12'), 'libraries 含 launchwrapper 库');
    check((json.libraries || []).every((l) => !l.url || /^https:\/\//.test(l.url)), '库地址都是 https');

    // 补丁 jar
    const ofJar = patchResult.optifineJar;
    console.log(`  补丁 jar：${ofJar}（${fs.existsSync(ofJar) ? fs.statSync(ofJar).size : '不存在'} 字节）`);
    check(fs.existsSync(ofJar) && fs.statSync(ofJar).size > 100_000, '补丁 jar 存在且大小合理');
    const ofEntries = zip.list(ofJar);
    check(ofEntries.includes('optifine/OptiFineTweaker.class'), '补丁 jar 里有 optifine/OptiFineTweaker.class');
    check(!ofEntries.some((n) => n.toLowerCase() === 'meta-inf/mods.toml'), '补丁 jar 已删掉 META-INF/mods.toml');
    check(ofEntries.some((n) => /^(net\/minecraft\/|net\/optifine\/)/.test(n)), '补丁 jar 里有游戏/优化类（说明真的打进去了）');

    // launchwrapper 被解出来
    if (patchResult.launchwrapper && patchResult.launchwrapper.file) {
      console.log(`  launchwrapper：${patchResult.launchwrapper.version} → ${patchResult.launchwrapper.file}（${fs.statSync(patchResult.launchwrapper.file).size} 字节）`);
      check(fs.existsSync(patchResult.launchwrapper.file), 'launchwrapper jar 已解出到 libraries/');
      check(patchResult.launchwrapper.version === '2.2', 'launchwrapper 版本 = 2.2（安装器自带）', patchResult.launchwrapper.version);
    } else {
      check(false, 'launchwrapper 应已解出（安装器里带 launchwrapper-of-2.2.jar）');
    }

    // 版本 JSON 的 jar 字段 + 补丁目录里的硬链接（供 gamecheck 的 jar 存在性检查）
    check(json.jar === '1.12.2', '版本 JSON 带 jar=1.12.2（classpath 用原版 jar，不复制 10MB）', json.jar);
    const linkJar = path.join(paths.versionsDir(HOME, inst.id), patchResult.versionId, `${patchResult.versionId}.jar`);
    const linkOk = fs.existsSync(linkJar);
    console.log(`  硬链接 <版本id>.jar：${linkOk ? `${fs.statSync(linkJar).size} 字节` : '不存在'}（${linkJar}）`);
    check(linkOk, '补丁版本目录里有 <版本id>.jar（硬链接到原版，gamecheck 不会误报缺 jar）');
    if (linkOk) check(fs.statSync(linkJar).size === fs.statSync(clientJar).size, '硬链接与原版 jar 大小一致');
  }

  /* ---------------------------------- ⑤ 版本 JSON 能被 version.resolve 继承 */
  if (patchResult && patchResult.mode === 'patch') {
    section('⑤ version.resolve 的继承结果（mainClass / tweakClass / 父版参数）');
    const child = JSON.parse(fs.readFileSync(patchResult.versionJson, 'utf8'));
    const resolved = await versionModule.resolve(child, {
      fetchJson: async (id) => {
        if (id === '1.12.2') return parentJson;
        throw new Error(`意外的父版本：${id}`);
      },
    });
    console.log(`  resolved.id=${resolved.id} mainClass=${resolved.mainClass}`);
    console.log(`  resolved.arguments.game=${JSON.stringify(resolved.arguments && resolved.arguments.game)}`);
    console.log(`  resolved.minecraftArguments=${JSON.stringify(resolved.minecraftArguments)}`);
    check(resolved.mainClass === 'net.minecraft.launchwrapper.Launch', '继承后 mainClass 仍是 launchwrapper');
    check(
      Array.isArray(resolved.arguments && resolved.arguments.game) && resolved.arguments.game.includes('optifine.OptiFineTweaker'),
      '继承后仍带 optifine.OptiFineTweaker'
    );
    check(
      typeof resolved.minecraftArguments === 'string' && resolved.minecraftArguments.includes('--username'),
      '父版老式 minecraftArguments 没丢（会被 launch.js 先铺开）'
    );
    check(resolved.id === child.id && resolved.inheritsFrom === null, '继承链已解析完毕（inheritsFrom 置空）');

    // gamecheck：补丁版本不能因为「没有自己的 jar」被判成缺文件
    const gamecheck = require(path.join(CORE, 'gamecheck.js'));
    const gc = await gamecheck.checkGameFiles({
      versionDir: path.join(paths.versionsDir(HOME, inst.id), patchResult.versionId),
      versionId: patchResult.versionId,
      minecraftDir: path.join(inst.dir, '.minecraft'),
      home: HOME,
      resolved,
      instance: { notCheckGameFiles: false },
      settings: { checkGameFiles: true },
    });
    console.log(`  gamecheck → ok=${gc.ok} skipContentCheck=${gc.skipContentCheck} missing=${gc.missing.length} corrupted=${gc.corrupted.length}`);
    check(gc.ok === true, 'gamecheck 不把补丁版本判成「缺文件」（ok=true）');
    check(
      !gc.missing.some((m) => m.kind === 'client-jar' && m.critical),
      '没有「缺客户端 jar」的 critical 报告（硬链接生效）'
    );
  }

  /* ------------------------------------------------ ⑥ 模式 B（≥1.13） */
  section('⑥ 模式 B（1.20.1，Forge 模组）：先报错、装 Forge 后真放进 mods/');
  const inst2 = await instances.create(HOME, { name: 'OptiFine 1.20.1 测试', mcVersion: '1.20.1' });
  let needForgeErr = null;
  try {
    await optifine.install({ home: HOME, instanceId: inst2.id, mcVersion: '1.20.1', version: 'HD_U_I6' });
  } catch (err) {
    needForgeErr = err;
  }
  console.log(`  没装 Forge 时：code=${needForgeErr && needForgeErr.code}｜${needForgeErr && needForgeErr.message}`);
  check(!!needForgeErr && needForgeErr.code === 'E_OPTIFINE_NEED_FORGE', '抛 E_OPTIFINE_NEED_FORGE');
  check(
    !!needForgeErr && /1\.13 以后的 OptiFine 需要先装 Forge/.test(needForgeErr.message) && /请先选 Forge/.test(needForgeErr.message),
    '错误文案就是要求里那句中文'
  );
  check(!!needForgeErr && /[\u4e00-\u9fa5]/.test(needForgeErr.message), '错误是中文');

  // 把实例标成 Forge（模拟玩家已经装过 Forge）
  await instances.update(HOME, inst2.id, { loader: { type: 'forge', version: '47.2.18' } });
  const modLogs = [];
  let modResult = null;
  let modError = null;
  try {
    modResult = await optifine.install({
      home: HOME,
      instanceId: inst2.id,
      mcVersion: '1.20.1',
      version: 'HD_U_I6',
      onLog: (line) => {
        modLogs.push(line);
        if (/放入 mods|下载/.test(line)) console.log(`    · ${line}`);
      },
      onProgress: () => {},
    });
  } catch (err) {
    modError = err;
  }
  console.log(`  装了 Forge 后：${modResult ? JSON.stringify({ mode: modResult.mode, file: modResult.file, version: modResult.version }) : `失败：${modError && modError.message}`}`);
  check(!!modResult && modResult.mode === 'mod', "安装成功且 mode='mod'");
  check(!!modResult && fs.existsSync(modResult.file), 'OptiFine jar 真的放进实例目录', modResult && modResult.file);
  check(!!modResult && /[\\/]\.minecraft[\\/]mods[\\/]/.test(modResult.file), '落点是 <实例>/.minecraft/mods/');
  if (modResult && fs.existsSync(modResult.file)) {
    const ent = zip.list(modResult.file);
    check(ent.includes('META-INF/mods.toml'), '1.13+ 的 jar 保留了 META-INF/mods.toml（Forge 需要，不能删）');
    check(ent.length > 1000, 'jar 内容完整（条目数 >1000）', String(ent.length));
  }

  /* ---------------------------------------------- ⑦ stripJarEntries 单测 */
  section('⑦ stripJarEntries：只删 META-INF/mods.toml');
  const fakeJar = path.join(WORK, 'fake.jar');
  createZip(fakeJar, [
    { name: 'a.txt', data: Buffer.from('keep-me') },
    { name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"') },
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\n') },
  ]);
  const stripped = optifine.stripJarEntries(fakeJar, ['META-INF/mods.toml']);
  const after = zip.list(fakeJar);
  console.log(`  删除结果=${stripped}，剩余条目：${after.join(', ')}`);
  check(stripped === true, '确实删掉了条目');
  check(!after.includes('META-INF/mods.toml'), 'mods.toml 已移除');
  check(after.includes('a.txt') && after.includes('META-INF/MANIFEST.MF'), '其它条目原样保留');
  check(optifine.stripJarEntries(fakeJar, ['META-INF/mods.toml']) === false, '再次调用没有可删的返回 false');

  /* ---------------------------------- ⑧ install.js 的接线（不用真装游戏） */
  section('⑧ install.js 接线：fetchLoaderProfile 返回 null + 三种实例元数据');
  const installMod = require(path.join(CORE, 'install.js'));
  const profOpti = await installMod.fetchLoaderProfile('1.12.2', { type: 'optifine' }, { timeoutMs: 15000 });
  console.log(`  fetchLoaderProfile(optifine) = ${JSON.stringify(profOpti)}`);
  check(profOpti === null, 'OptiFine 不生成 profile（返回 null，走 ⑤.8 单独安装）');

  const patchPatch = installMod.buildInstancePatch({
    loaderType: 'optifine',
    optifineResult: { mode: 'patch', version: 'HD_U_G5', versionId: '1.12.2-OptiFine_HD_U_G5' },
    targetId: '1.12.2',
    mcVersion: '1.12.2',
    instance: { installedVersion: '1.12.2', loader: { type: 'vanilla', version: '' } },
    optsLoader: { type: 'optifine', version: 'HD_U_G5' },
  });
  console.log(`  patch 模式 → ${JSON.stringify(patchPatch)}`);
  check(patchPatch.installedVersion === '1.12.2-OptiFine_HD_U_G5', 'patch 模式：installedVersion 指向 OptiFine 版本 JSON');
  check(patchPatch.loader.type === 'optifine' && patchPatch.loader.version === 'HD_U_G5', "patch 模式：loader={type:'optifine'}");

  const modPatch = installMod.buildInstancePatch({
    loaderType: 'optifine',
    optifineResult: { mode: 'mod', version: 'HD_U_I6' },
    targetId: '1.20.1',
    mcVersion: '1.20.1',
    instance: { installedVersion: '1.20.1-forge-47.2.18', loader: { type: 'forge', version: '47.2.18' }, notes: '旧备注' },
    optsLoader: { type: 'optifine', version: 'HD_U_I6' },
  });
  console.log(`  mod 模式 → ${JSON.stringify(modPatch)}`);
  check(modPatch.installedVersion === '1.20.1-forge-47.2.18', 'mod 模式：installedVersion 保持原来的 Forge 版本（不被覆盖成 1.20.1）');
  check(modPatch.loader.type === 'forge' && modPatch.loader.version === '47.2.18', 'mod 模式：loader 保持 forge');
  check(
    typeof modPatch.notes === 'string' && modPatch.notes.startsWith('旧备注') && /OptiFine HD_U_I6 已放入 mods/.test(modPatch.notes),
    'mod 模式：notes 追加了说明（旧备注保留）'
  );

  const mlPatch = installMod.buildInstancePatch({
    loaderType: 'modloader',
    mcVersion: 'b1.7.3',
    targetId: 'b1.7.3',
    instance: { installedVersion: '', loader: null },
    optsLoader: { type: 'modloader', version: '' },
  });
  check(mlPatch.loader.type === 'modloader' && mlPatch.loader.version === 'b1.7.3', 'ModLoader 的实例元数据没被这次改动破坏');
  check(mlPatch.notCheckGameFiles === true, 'ModLoader 仍然自动关掉文件校验');
  const fabricPatch = installMod.buildInstancePatch({
    loaderType: 'fabric',
    mcVersion: '1.20.1',
    targetId: 'fabric-loader-0.16.0-1.20.1',
    instance: { installedVersion: '', loader: null },
    optsLoader: { type: 'fabric', version: '0.16.0' },
  });
  check(fabricPatch.loader.type === 'fabric' && fabricPatch.installedVersion === 'fabric-loader-0.16.0-1.20.1', '普通加载器（Fabric）逻辑不变');

  /* ------------------------------------------------------------ 收尾 */
  section('结果');
  console.log(`  失败项：${failures}`);
  if (failures === 0) {
    console.log('\n  ✓ 全部检查项通过（Patcher 真实执行 / 版本 JSON 正确 / 模式 B 正确）');
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log('  已清理临时目录 build/.verify-optifine（用户 QCL home 全程未触碰）');
  } else {
    console.log(`\n  ✗ 有检查项失败（临时目录保留：${WORK}）`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n脚本本身出错：', err);
  process.exit(2);
});
