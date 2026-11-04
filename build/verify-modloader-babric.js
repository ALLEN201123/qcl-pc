'use strict';
/*
 * 实测脚本：ModLoader（覆盖式注入 jar）+ Babric（b1.7.3 的 Fabric 分支）
 *
 * 运行：node build/verify-modloader-babric.js
 *
 * ★ 安全约定（照任务书）：
 *   · 只用**临时 home**（build/.verify-modloader-babric/home），绝不碰
 *     C:\Users\123\Documents\QCL（用户正在玩，游戏进程还开着）；
 *   · 不装真实游戏：ModLoader 要注入的 minecraft.jar 是**合成 jar**（几个假 class +
 *     META-INF 签名文件），只测注入/备份/回滚逻辑，不下载 3MB 的客户端；
 *   · 真正联网下载的只有 ModLoader 包本身（74KB）和 Babric profile / 版本列表。
 *
 * 覆盖：
 *   ① 版本表：28 条、23 条当前可装、5 条（只有 rar / 镜像失效）标 available:false
 *   ② ModLoader 真实安装到临时 home：下载 → SHA-256 → 注入 → 标记 → 关校验
 *      （断言 jar 里真的多了 ModLoader 的 class、签名文件被删、MANIFEST.MF 保留、
 *        原 jar 能正常以 zip 打开、备份 .mlbak 已清理）
 *   ③ 失败回滚：喂一个没有 .class 的包 → 抛中文错误，原 jar 字节不变
 *   ④ gamecheck：`.modloader` / `.babric` 标记都会让内容校验跳过
 *   ⑤ Babric：拉 b1.7.3 的 profile（inheritsFrom / mainClass / 22 个库），
 *      并证明「强制 official 源」后没有一条库地址被改写成 bmclapi
 *   ⑥ loader:versions：b1.7.3 能同时返回 babric 与 modloader 两类
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');

const modloaderversions = require(path.join(CORE, 'modloaderversions.js'));
const modloader = require(path.join(CORE, 'modloader.js'));
const babric = require(path.join(CORE, 'babric.js'));
const loaderversions = require(path.join(CORE, 'loaderversions.js'));
const libraries = require(path.join(CORE, 'libraries.js'));
const rules = require(path.join(CORE, 'rules.js'));
const zip = require(path.join(CORE, 'zip.js'));
const zipwriter = require(path.join(CORE, 'zipwriter.js'));
const gamecheck = require(path.join(CORE, 'gamecheck.js'));
const install = require(path.join(CORE, 'install.js'));

const WORK = path.join(__dirname, '.verify-modloader-babric');
const HOME = path.join(WORK, 'home');
const INSTANCE_ID = 'mltest';
const VERSION_ID = 'b1.7.3';

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function versionDirOf() {
  return path.join(HOME, 'instances', INSTANCE_ID, '.minecraft', 'versions', VERSION_ID);
}

/** 造一个「像原版」的 jar：几个 class + MANIFEST + 4 种签名文件 + 普通资源。 */
function makeFakeMinecraftJar(jarPath) {
  const dir = path.dirname(jarPath);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { name: 'net/minecraft/client/Minecraft.class', data: Buffer.from('CAFEBABE-fake-minecraft-main-class') },
    { name: 'net/minecraft/src/Block.class', data: Buffer.from('CAFEBABE-fake-block-class') },
    { name: 'net/minecraft/src/Item.class', data: Buffer.from('CAFEBABE-fake-item-class') },
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\nCreated-By: QCL verify\r\n\r\n') },
    { name: 'META-INF/MOJANG_C.SF', data: Buffer.from('Signature-Version: 1.0\r\n') },
    { name: 'META-INF/MOJANG_C.RSA', data: Buffer.from('fake-rsa-signature') },
    { name: 'META-INF/MOJANG_C.DSA', data: Buffer.from('fake-dsa-signature') },
    { name: 'META-INF/MOJANG_C.EC', data: Buffer.from('fake-ec-signature') },
    { name: 'assets/minecraft/sounds/click.ogg', data: Buffer.from('fake-ogg') },
  ];
  const result = zipwriter.createZip(jarPath, entries);
  return { entries: entries.map((e) => e.name), bytes: result.bytes };
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  /* ------------------------------------------------------- ① 版本表静态检查 */
  section('① ModLoader 版本表（modloaderversions.js）');
  const all = modloaderversions.all();
  const installable = modloaderversions.installable();
  const unavailable = modloaderversions.unavailable();
  console.log(`  总条目 ${all.length} 条：可装 ${installable.length} 条、暂不可装 ${unavailable.length} 条`);
  console.log(`  暂不可装的：${unavailable.map((e) => e.mcVersion).join(', ')}`);
  check(all.length === 28, '版本表 28 条（与安卓版一致）', `${all.length} 条`);
  check(all.every((e) => /^[0-9a-f]{64}$/.test(String(e.sha256))), '每条都有 64 位 SHA-256');
  check(installable.length === 23, '当前可装 23 条（21 条 MCArchive + b1.7.3 + a1.2.3_04）', `${installable.length} 条`);
  check(unavailable.length === 5, '5 条（只有 .rar / 镜像失效）标为暂不可装', unavailable.map((e) => e.mcVersion).join(','));
  check(unavailable.every((e) => e.available === false && e.note && /rar|失效/.test(e.note)), '暂不可装的条目都有中文原因');

  // 边界匹配（安卓版 1.12.2 会误命中 1.1，这里必须不命中）
  check(modloaderversions.find('b1.7.3') && modloaderversions.find('b1.7.3').mcVersion === 'b1.7.3', '精确命中 b1.7.3');
  check(modloaderversions.find('b1.7.3-modded').mcVersion === 'b1.7.3', '宽松命中 b1.7.3-modded');
  check(modloaderversions.find('1.12.2') === null, '1.12.2 **不会**误命中 1.1（版本边界保护）');
  check(modloaderversions.find('1.6.2').mcVersion === '1.6.2', '精确命中 1.6.2');

  // 模块接线：instances 的 LOADER_TYPES 认这两种类型
  const instances = require(path.join(CORE, 'instances.js'));
  console.log(`  instances.LOADER_TYPES = ${instances.LOADER_TYPES.join(', ')}`);
  check(instances.LOADER_TYPES.includes('babric') && instances.LOADER_TYPES.includes('modloader'), 'LOADER_TYPES 含 babric / modloader');
  const norm = instances.normalizeLoader({ type: 'modloader', version: 'b1.7.3' });
  console.log(`  normalizeLoader({type:'modloader',version:'b1.7.3'}) = ${JSON.stringify(norm)}`);
  check(!!norm && norm.type === 'modloader', 'normalizeLoader 接受 modloader');

  // install.js 的分流：modloader 不生成 profile（先装原版再注入）
  const mlInfo = await install.fetchLoaderProfile('b1.7.3', { type: 'modloader' }, { timeoutMs: 20000 });
  check(mlInfo === null, 'fetchLoaderProfile(modloader) 返回 null（先装原版，再在 ⑤.7 注入）');
  check(install.librarySourceFor('modloader', 'bmclapi') === 'bmclapi', 'modloader 不需要强制官方源');

  // 下载地址
  const b173 = modloaderversions.find('b1.7.3');
  console.log(`  b1.7.3 地址：${modloaderversions.urlOf(b173)}`);
  console.log(`  1.6.2  地址：${modloaderversions.urlOf(modloaderversions.find('1.6.2'))}`);
  check(/^https:\/\/github\.com\/coffeenotfound\/ModloaderFix-b1\.7\.3\/releases\//.test(modloaderversions.urlOf(b173)), 'b1.7.3 用 GitHub Release 官方资产（Gitee 镜像已失效）');
  check(/^https:\/\/b2\.mcarchive\.net\/file\/mcarchive\/[0-9a-f]{64}\/ModLoader%20/.test(modloaderversions.urlOf(modloaderversions.find('1.6.2'))), 'MCArchive 地址 = BASE + sha256 + 文件名（含 %20）');

  /* ------------------------------------------ ② 真实安装 ModLoader（b1.7.3） */
  section('② 真实安装 ModLoader 到临时 home（b1.7.3，真下载 + 真 SHA-256）');
  const versionDir = versionDirOf();
  const jarPath = path.join(versionDir, `${VERSION_ID}.jar`);
  const instanceDir = path.join(HOME, 'instances', INSTANCE_ID);
  fs.mkdirSync(instanceDir, { recursive: true });
  // 实例元数据（modloader.install 会更新它的 notCheckGameFiles）
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    `${JSON.stringify({ version: 1, id: INSTANCE_ID, name: 'ModLoader 测试实例', mcVersion: VERSION_ID, notCheckGameFiles: false }, null, 2)}\n`,
    'utf8'
  );
  const fake = makeFakeMinecraftJar(jarPath);
  // 版本 JSON 也放一份（gamecheck 用）
  fs.writeFileSync(
    path.join(versionDir, `${VERSION_ID}.json`),
    `${JSON.stringify({ id: VERSION_ID, mainClass: 'net.minecraft.client.Minecraft', libraries: [], downloads: {} }, null, 2)}\n`,
    'utf8'
  );
  const entriesBefore = zip.list(jarPath);
  const classCountBefore = entriesBefore.filter((n) => /\.class$/i.test(n)).length;
  const jarShaBefore = sha256(fs.readFileSync(jarPath));
  console.log(`  合成 jar：${entriesBefore.length} 个条目（class ${classCountBefore} 个，含 4 个签名文件），sha256=${jarShaBefore.slice(0, 16)}…`);

  const logs = [];
  const t0 = Date.now();
  const result = await modloader.install({
    home: HOME,
    instanceId: INSTANCE_ID,
    mcVersion: VERSION_ID,
    versionId: VERSION_ID,
    onLog: (line) => {
      logs.push(line);
      if (/下载|校验|写入|标记|关闭/.test(line)) console.log(`    · ${line}`);
    },
    onProgress: () => {},
  });
  const cost = Date.now() - t0;
  console.log(`\n  install() 返回：injected=${result.injected} stripped=${result.stripped} sha256=${result.sha256}`);
  console.log(`  marker=${result.marker}`);
  console.log(`  耗时 ${cost} ms（含真实下载 ${result.fileName}）`);
  check(result.injected > 0, '注入了 ModLoader 的 class', `${result.injected} 个`);
  check(result.sha256 === b173.sha256, '下载的包 SHA-256 与版本表一致', result.sha256);
  check(cost > 0 && fs.existsSync(result.marker), '标记文件已生成');

  // jar 校验
  const entriesAfter = zip.list(jarPath);
  const classNamesAfter = entriesAfter.filter((n) => /\.class$/i.test(n));
  const classCountAfter = classNamesAfter.length;
  const beforeSet = new Set(entriesBefore);
  const addedClasses = classNamesAfter.filter((n) => !beforeSet.has(n));
  console.log(`\n  注入后 jar：${entriesAfter.length} 个条目，class ${classCountAfter} 个（新增 ${addedClasses.length} 个）`);
  console.log(`  新增 class 示例：${addedClasses.slice(0, 6).join(', ')}`);
  check(entriesAfter.length > 0, '原 jar 仍能正常以 ZIP 打开（读中央目录成功）');
  check(classCountAfter === classCountBefore + result.injected, 'class 数 = 原有 + 注入数', `${classCountBefore} + ${result.injected} = ${classCountAfter}`);
  check(addedClasses.length === result.injected, '新增的 class 条目数 = injected');
  check(addedClasses.includes('BaseMod.class'), 'jar 里确实出现了 ModLoader 的 BaseMod.class');
  const signatures = entriesAfter.filter((n) => /^META-INF\/[^/]+\.(sf|rsa|dsa|ec)$/i.test(n));
  check(signatures.length === 0, 'META-INF 签名文件（.SF/.RSA/.DSA/.EC）已全部移除', signatures.join(','));
  check(entriesAfter.includes('META-INF/MANIFEST.MF'), 'MANIFEST.MF 保留');
  check(entriesAfter.includes('assets/minecraft/sounds/click.ogg'), '非 class 的原条目原样保留');
  check(!fs.existsSync(`${jarPath}.mlbak`), '安装成功后备份 .mlbak 已删除');
  check(!fs.existsSync(`${jarPath}.mltmp`), '临时文件 .mltmp 没有残留');
  const jarShaAfter = sha256(fs.readFileSync(jarPath));
  check(jarShaAfter !== jarShaBefore, 'jar 内容确实变了（sha256 不再等于原版）');

  // 标记内容
  const marker = modloader.readMarker(versionDir);
  console.log(`\n  .modloader 内容：${JSON.stringify(marker)}`);
  check(marker && marker.mcVersion === VERSION_ID, '标记里 mcVersion=b1.7.3');
  check(marker && marker.sha256 === b173.sha256, '标记里 sha256 正确');
  check(marker && String(marker.injected) === String(result.injected), '标记里 injected 与返回一致');
  check(marker && !Number.isNaN(Date.parse(marker.time)), '标记里 time 是合法时间');

  // 实例元数据
  const instJson = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
  check(instJson.notCheckGameFiles === true, 'instance.json 已自动置 notCheckGameFiles=true');

  /* ---------------------------------------------- ③ 失败必须回滚/不动原 jar */
  section('③ 失败回滚：包不对时原 jar 必须一个字节都不变');
  const badPkg = path.join(WORK, 'bad-package.zip');
  zipwriter.createZip(badPkg, [{ name: 'readme.txt', data: Buffer.from('not a modloader zip') }]);
  const beforeBad = sha256(fs.readFileSync(jarPath));
  let injectErr = null;
  try {
    modloader.injectClasses(badPkg, jarPath);
  } catch (err) {
    injectErr = err;
  }
  console.log(`  抛出：code=${injectErr && injectErr.code}｜${injectErr && injectErr.message}`);
  check(!!injectErr && injectErr.code === 'E_MODLOADER_INJECT', '抛 E_MODLOADER_INJECT');
  check(!!injectErr && /没有 \.class/.test(injectErr.message), '错误信息说明「包里没有 .class」');
  check(sha256(fs.readFileSync(jarPath)) === beforeBad, '失败后原 jar 字节完全没变');
  check(!fs.existsSync(`${jarPath}.mltmp`) && !fs.existsSync(`${jarPath}.mlbak`), '失败后没有残留 tmp/bak');

  // 没有 jar 时给中文提示
  let noJarErr = null;
  try {
    await modloader.install({ home: HOME, instanceId: INSTANCE_ID, mcVersion: 'b1.7.3', versionId: 'no-such-version' });
  } catch (err) {
    noJarErr = err;
  }
  check(!!noJarErr && noJarErr.code === 'E_MODLOADER_NO_JAR' && /没有游戏本体/.test(noJarErr.message), '缺游戏本体时抛中文 E_MODLOADER_NO_JAR');

  /* ------------------------------------------------------ ④ gamecheck 跳过 */
  section('④ gamecheck：有 .modloader / .babric 标记时跳过内容校验');
  const markMl = gamecheck.detectLoaderModifiedJar(versionDir);
  console.log(`  detectLoaderModifiedJar(装了 ModLoader 的目录) = ${JSON.stringify(markMl)}`);
  check(markMl.modified === true && markMl.loader === 'modloader', '识别出 .modloader 标记');
  const babricDir = path.join(WORK, 'fake-babric-version');
  fs.mkdirSync(babricDir, { recursive: true });
  fs.writeFileSync(path.join(babricDir, babric.MARKER_NAME), 'loader=babric\n', 'utf8');
  const markBab = gamecheck.detectLoaderModifiedJar(babricDir);
  console.log(`  detectLoaderModifiedJar(有 .babric 的目录) = ${JSON.stringify(markBab)}`);
  check(markBab.modified === true && markBab.loader === 'babric', '识别出 .babric 标记');
  const gc = await gamecheck.checkGameFiles({
    versionDir,
    versionId: VERSION_ID,
    minecraftDir: path.join(instanceDir, '.minecraft'),
    home: HOME,
    resolved: { id: VERSION_ID, libraries: [], downloads: {} },
    instance: { notCheckGameFiles: false },
    settings: { checkGameFiles: true },
  });
  console.log(`  checkGameFiles → ok=${gc.ok} skipContentCheck=${gc.skipContentCheck} reason=${gc.reason}`);
  check(gc.skipContentCheck === true && /ModLoader/.test(gc.reason), '装了 ModLoader 的版本跳过内容校验（原因含 ModLoader）');

  /* ------------------------------------------------------- ⑤ Babric profile */
  section('⑤ Babric：拉 b1.7.3 的 profile（真请求 meta.babric.glass-launcher.net）');
  const profileLogs = [];
  const ctx = { timeoutMs: 20000, log: { log: (l) => profileLogs.push(l) } };
  const t1 = Date.now();
  const info = await install.fetchLoaderProfile(VERSION_ID, { type: 'babric', version: '0.20.1' }, ctx);
  const profile = info.profile;
  console.log(`  profile id=${profile.id}`);
  console.log(`  inheritsFrom=${profile.inheritsFrom}  mainClass=${profile.mainClass}`);
  console.log(`  libraries=${profile.libraries.length}  耗时 ${Date.now() - t1} ms`);
  check(info.source === 'babric', "source='babric'");
  check(profile.id === 'fabric-loader-0.20.1-b1.7.3', 'profile id = fabric-loader-0.20.1-b1.7.3');
  check(profile.inheritsFrom === 'b1.7.3', 'inheritsFrom = b1.7.3');
  check(profile.mainClass === 'net.fabricmc.loader.impl.launch.knot.KnotClient', 'mainClass = KnotClient');
  check(profile.libraries.length >= 20, 'libraries ≥ 20', `${profile.libraries.length} 个`);

  // 不带加载器版本（Babric 不支持那种端点，必须自动挑最新稳定版）
  const info2 = await install.fetchLoaderProfile(VERSION_ID, { type: 'babric' }, ctx);
  console.log(`  不指定加载器版本 → 自动选用 ${info2.profile.id}（profileLogs: ${profileLogs.find((l) => /自动选用/.test(l)) || '无'}）`);
  check(info2.profile.id === 'fabric-loader-0.20.1-b1.7.3', '自动挑到最新稳定版 0.20.1（绕开 404 的 /profile/json 端点）');

  // 版本列表：34 个 / b1.7.2 是 0
  const babVersions = await babric.listLoaderVersions('b1.7.3', { timeoutMs: 20000 });
  const babVersions172 = await babric.listLoaderVersions('b1.7.2', { timeoutMs: 20000 });
  console.log(`  Babric 版本列表：b1.7.3 → ${babVersions.length} 个（最新 ${babVersions[0] && babVersions[0].version}，stable=${babVersions[0] && babVersions[0].stable}）；b1.7.2 → ${babVersions172.length} 个`);
  check(babVersions.length === 34, 'b1.7.3 有 34 个 Babric 加载器版本', `${babVersions.length} 个`);
  check(babVersions[0].version === '0.20.1' && babVersions[0].stable === true, '最新是 0.20.1 且 stable=true');
  check(babVersions172.length === 0, 'b1.7.2 返回 0 个（Babric 只做 b1.7.3 系）');

  /* ----------------------------------- ⑤.2 库地址绝不能被改写成 bmclapi */
  section('⑤.2 Babric 的库地址不能被镜像改写');
  const osInfo = rules.currentOs();
  const officialSource = install.librarySourceFor('babric', 'bmclapi');
  const fabricSource = install.librarySourceFor('fabric', 'bmclapi');
  console.log(`  librarySourceFor('babric','bmclapi') = ${officialSource}｜librarySourceFor('fabric','bmclapi') = ${fabricSource}`);
  check(officialSource === 'official', 'Babric 强制 official 源');
  check(fabricSource === 'bmclapi', '其它加载器仍按用户选择的镜像源');

  const resolvedLibs = libraries.resolveLibraries(profile, { osInfo, source: officialSource });
  const mirroredLibs = libraries.resolveLibraries(profile, { osInfo, source: 'bmclapi' });
  const bmclCount = (list) => list.filter((e) => /bmclapi/i.test(String(e.artifactUrl || ''))).length;
  const glassCount = (list) => list.filter((e) => /^https:\/\/maven\.glass-launcher\.net\//.test(String(e.artifactUrl || ''))).length;
  console.log(`  解析出 ${resolvedLibs.length} 个库；glass-launcher 地址 ${glassCount(resolvedLibs)} 个，bmclapi 地址 ${bmclCount(resolvedLibs)} 个`);
  console.log(`  对照（如果错误地传 bmclapi）：bmclapi 地址会变成 ${bmclCount(mirroredLibs)} 个`);
  for (const e of resolvedLibs.filter((x) => /glass-launcher/.test(String(x.artifactUrl))).slice(0, 3)) {
    console.log(`    · ${e.name} → ${e.artifactUrl}`);
  }
  check(glassCount(resolvedLibs) >= 3, '解析结果里确实有 maven.glass-launcher.net 的库', `${glassCount(resolvedLibs)} 个`);
  check(bmclCount(resolvedLibs) === 0, 'Babric 的库地址没有一条被改写成 bmclapi', `${bmclCount(resolvedLibs)} 个`);
  check(bmclCount(mirroredLibs) > 0, '（对照）传 bmclapi 时确实会被改写 ⇒ 强制 official 是必要的', `${bmclCount(mirroredLibs)} 个`);
  check(resolvedLibs.every((e) => /^https:\/\//.test(String(e.artifactUrl))), '所有库地址都是 https');

  /* ---------------------------------------------- ⑥ loader:versions 两类 */
  section('⑥ loader:versions：b1.7.3 同时返回 babric 与 modloader');
  const t2 = Date.now();
  const lv = await loaderversions.listLoaderVersions({ mcVersion: VERSION_ID });
  console.log(`  listLoaderVersions({mcVersion:'b1.7.3'}) 返回 key：${Object.keys(lv).join(', ')}（耗时 ${Date.now() - t2} ms）`);
  for (const key of Object.keys(lv)) {
    const item = lv[key];
    console.log(`    ${key.padEnd(10)} versions=${item.versions.length} latest=${item.latest} error=${item.error ? String(item.error).slice(0, 40) : 'null'}${key === 'modloader' ? ` available=${item.available} label=${item.label}` : ''}`);
  }
  check(!!lv.babric && !!lv.modloader, '同时包含 babric 与 modloader');
  check(lv.babric.versions.length === 34 && lv.babric.latest === '0.20.1', 'babric：34 个版本、latest=0.20.1');
  check(lv.modloader.versions.length === 0 && lv.modloader.latest === null, 'modloader：versions 为空、latest=null（没有加载器版本概念）');
  check(lv.modloader.available === true && lv.modloader.label === 'ModLoader b1.7.3', "modloader：available=true、label='ModLoader b1.7.3'");
  check(lv.modloader.error === null, 'modloader：error=null');

  const onlyBabric = await loaderversions.listLoaderVersions({ mcVersion: VERSION_ID, loader: 'babric' });
  check(Object.keys(onlyBabric).length === 1 && !!onlyBabric.babric, "loader:'babric' 只查一类");
  const lv11 = await loaderversions.listLoaderVersions({ mcVersion: '1.1' });
  console.log(`  1.1 的 modloader → available=${lv11.modloader.available} error=${String(lv11.modloader.error).slice(0, 60)}…`);
  check(lv11.modloader.available === false && /rar|失效/.test(String(lv11.modloader.error)), '1.1：available=false 且给出中文原因');
  const lvModern = await loaderversions.listLoaderVersions({ mcVersion: '1.12.2' });
  check(lvModern.modloader.available === false, '1.12.2：没有 ModLoader（不会误命中 1.1）');

  /* ------------------------------------------------------------ 收尾 */
  section('结果');
  console.log(`  失败项：${failures}`);
  if (failures === 0) {
    console.log('\n  ✓ 全部检查项通过（ModLoader 真实注入 / Babric 真实 profile / loader:versions 两类）');
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log('  已清理临时目录 build/.verify-modloader-babric（用户 QCL home 全程未触碰）');
  } else {
    console.log('\n  ✗ 有检查项失败（临时目录保留以便排查）');
    console.log(`  临时 home：${HOME}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n脚本本身出错：', err);
  process.exit(2);
});
