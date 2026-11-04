'use strict';
/*
 * 实测脚本：存档管理（worlds.js）+ 整合包导出导入（modpack.js + IPC）+ 模组更新检查（modupdate.js）
 *
 * 运行：node build/verify-worlds-modupdate.js
 *
 * ★ 纪律：只用临时 home（build/.verify-worlds-modupdate/home），绝不写
 *   C:\Users\123\Documents\QCL。测试成功自动清理临时目录。
 *
 * 覆盖：
 *   ① IPC 契约：通道是否注册、preload 白名单是否放行（静态核对）
 *   ② worlds：合成 gzip+NBT 的 level.dat → list / detail / 降级（坏 level.dat）
 *   ③ worlds：backup → backups 列表 → restore（现存档先进 recycle）→ export → delete → 再 restore
 *   ④ worlds：目录穿越 / 备份文件越界必须有中文错误
 *   ⑤ modpack：export → inspect（契约字段）→ list → import 到新实例；raw zip 识别
 *   ⑥ app:pickFile：用假 dialog 验证 filters/properties 与 canceled 分支
 *   ⑦ modupdate：**真下载** sodium 新旧两个 jar → 真调 Modrinth 批量更新接口
 *      （断言只报旧的那个、latest/downloadUrl/sha1/size/projectId 正确）
 *   ⑧ modupdate：网络失败 → { checked:0, items:[], error:中文 }；空 mods → 不报错
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');

const worlds = require(path.join(CORE, 'worlds.js'));
const modpack = require(path.join(CORE, 'modpack.js'));
const modupdate = require(path.join(CORE, 'modupdate.js'));
const instances = require(path.join(CORE, 'instances.js'));
const contentapi = require(path.join(CORE, 'contentapi.js'));

const WORK = path.join(__dirname, '.verify-worlds-modupdate');
const HOME = path.join(WORK, 'home');

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/* ------------------------------------------------------------ NBT / level.dat */

function nbtString(text) {
  const b = Buffer.from(String(text), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
function tagByte(v) {
  const b = Buffer.alloc(1);
  b.writeInt8(v);
  return b;
}
function tagInt(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
}
function tagLong(v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(v));
  return b;
}
/** 带名字的 tag：type + name + payload */
function named(type, key, payload) {
  return Buffer.concat([Buffer.from([type]), nbtString(key), payload]);
}
/** TAG_Compound 的 payload：子标签 + 结束字节 0 */
function compoundPayload(children) {
  return Buffer.concat([...children, Buffer.from([0])]);
}
/** 生成 gzip 压缩的 level.dat */
function makeLevelDat({ levelName, versionName, lastPlayed, seed, gameType, hardcore }) {
  const children = [
    named(8, 'LevelName', nbtString(levelName)),
    named(10, 'Version', compoundPayload([named(8, 'Name', nbtString(versionName))])),
    named(4, 'LastPlayed', tagLong(lastPlayed)),
    named(4, 'RandomSeed', tagLong(seed)),
    named(3, 'GameType', tagInt(gameType)),
    named(1, 'hardcore', tagByte(hardcore ? 1 : 0)),
  ];
  const data = named(10, 'Data', compoundPayload(children));
  // ★ 根 compound 也需要结束字节 0（漏了会解析失败 —— 第一版就踩了这个坑）
  const root = Buffer.concat([Buffer.from([10]), nbtString(''), compoundPayload([data])]);
  return zlib.gzipSync(root);
}

/* ------------------------------------------------------------------ electron 桩 */

const handlers = new Map();
const events = [];
let shellOpenResult = '';
let pickFileResult = { canceled: false, filePaths: [] };
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isLoading: () => false, send: (channel, payload) => events.push({ channel, payload }) },
};
function makeElectronStub() {
  return {
    app: { getName: () => 'QCL', getVersion: () => '1.0.0', getPath: () => os.tmpdir() },
    shell: {
      openPath: async (p) => {
        shellOpenResult = shellOpenResult === null ? null : '';
        return shellOpenResult;
      },
      openExternal: async () => {},
    },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: class {
      static getAllWindows() {
        return [fakeWindow];
      }
    },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    dialog: {
      showOpenDialog: async (_win, options) => {
        pickFileResult.options = options;
        return pickFileResult;
      },
    },
  };
}
const origLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'electron') return makeElectronStub();
  // eslint-disable-next-line prefer-rest-params
  return origLoad.apply(this, arguments);
};
const ipc = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
ipc.initContext({
  settings: {
    value: (key) => {
      if (key === 'home') return HOME;
      if (key === 'downloader') return { source: 'official', threads: 4 };
      return undefined;
    },
    get: () => ({ home: HOME, downloader: { source: 'official', threads: 4 } }),
  },
});
ipc.registerIpc();
async function call(channel, payload) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道没有注册：${channel}`);
  return fn({}, payload || {});
}

/* ------------------------------------------------------------------ 造存档 */

function writeWorld(instanceId, folder, opts) {
  const saveDir = path.join(HOME, 'instances', instanceId, '.minecraft', 'saves', folder);
  fs.mkdirSync(path.join(saveDir, 'region'), { recursive: true });
  fs.mkdirSync(path.join(saveDir, 'data'), { recursive: true });
  if (opts.levelDat) fs.writeFileSync(path.join(saveDir, 'level.dat'), opts.levelDat);
  fs.writeFileSync(path.join(saveDir, 'region', 'r.0.0.mca'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(saveDir, 'data', 'scoreboard.dat'), Buffer.from('fake-scoreboard'));
  if (opts.icon) fs.writeFileSync(path.join(saveDir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return saveDir;
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  /* -------------------------------------------------------- ① IPC 通道契约 */
  section('① IPC 通道注册 / preload 白名单');
  const expectedChannels = [
    'worlds:list', 'worlds:detail', 'worlds:backup', 'worlds:backups',
    'worlds:restore', 'worlds:export', 'worlds:delete', 'worlds:open',
    'modpack:export', 'modpack:inspect', 'modpack:import', 'modpack:list',
    'mods:checkUpdates', 'app:pickFile',
  ];
  console.log(`  ipcMain.handle 共注册 ${handlers.size} 个通道`);
  for (const ch of expectedChannels) console.log(`    ${handlers.has(ch) ? '✓' : '✗'} ${ch}`);
  check(expectedChannels.every((ch) => handlers.has(ch)), '14 个新通道全部注册');

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  const m = preloadSrc.match(/const INVOKE_RE = \/\^\(([^)]+)\):\[A-Za-z\]\+\$\/;/);
  const invokeRe = m ? new RegExp(`^(${m[1]}):[A-Za-z]+$`) : null;
  check(!!invokeRe, '能解析 preload 的 INVOKE_RE');
  const denied = expectedChannels.filter((ch) => !invokeRe || !invokeRe.test(ch));
  console.log(`  preload 放行：${expectedChannels.filter((ch) => invokeRe && invokeRe.test(ch)).length} / ${expectedChannels.length}`);
  check(denied.length === 0, 'preload 白名单全部放行', denied.join(','));

  /* ---------------------------------------------------------- ② 存档 v1：造数据 */
  section('② 合成长档：gzip+NBT 的 level.dat（list / detail / 降级）');
  const inst = await instances.create(HOME, { name: '存档测试实例', mcVersion: '1.20.1' });
  const INSTANCE_ID = inst.id;
  const folderA = 'My World';
  const folderB = 'Broken World';
  const lastPlayedMs = Date.now() + 60_000; // 保证 A 排最前
  const saveA = writeWorld(INSTANCE_ID, folderA, {
    levelDat: makeLevelDat({
      levelName: '我的世界存档',
      versionName: '1.20.1',
      lastPlayed: lastPlayedMs,
      seed: 123456789,
      gameType: 1,
      hardcore: false,
    }),
    icon: true,
  });
  const saveB = writeWorld(INSTANCE_ID, folderB, {
    levelDat: Buffer.from('这不是 gzip，也不是 NBT —— 用来验证降级'),
    icon: false,
  });
  console.log(`  实例 ${INSTANCE_ID}：worldA=${saveA}`);
  console.log(`  level.dat 解析：${JSON.stringify(worlds.readLevelDat(path.join(saveA, 'level.dat')) && worlds.readLevelDat(path.join(saveA, 'level.dat')).data).slice(0, 160)}`);
  check(fs.existsSync(path.join(saveA, 'level.dat')) && fs.statSync(path.join(saveA, 'level.dat')).size > 0, '合成 level.dat 非空');

  const list = worlds.list(HOME, INSTANCE_ID);
  console.log(`  worlds.list → ${list.length} 个`);
  for (const w of list) console.log(`    · ${w.folder} | name=${w.name} | version=${w.version} | size=${w.sizeBytes} | lastPlayed=${w.lastPlayed} | icon=${w.hasIcon}`);
  const a = list.find((w) => w.folder === folderA);
  const b = list.find((w) => w.folder === folderB);
  check(list.length === 2, '列出 2 个存档');
  check(!!a && a.name === '我的世界存档' && a.version === '1.20.1', '解析出世界名与版本', `${a && a.name} / ${a && a.version}`);
  check(!!a && a.sizeBytes > 2048, 'sizeBytes 是真实目录大小', String(a && a.sizeBytes));
  check(!!a && a.hasIcon === true, 'hasIcon 检出 icon.png');
  check(!!a && a.lastPlayed === new Date(lastPlayedMs).toISOString(), 'lastPlayed 来自 NBT', a && a.lastPlayed);
  check(!!b && b.name === folderB && b.version === null, '坏 level.dat 优雅降级（名字=文件夹名、version=null）', b && `${b.name}/${b.version}`);
  check(!!b && typeof b.lastPlayed === 'string', '降级时 lastPlayed 回落到文件时间', b && b.lastPlayed);
  check(list[0].folder === folderA, '按最近游玩时间排序（A 在前）', list.map((w) => w.folder).join(' > '));

  const detailA = worlds.detail(HOME, INSTANCE_ID, folderA);
  console.log(`  worlds.detail(A) → ${JSON.stringify(detailA)}`);
  check(detailA.seed === 123456789, 'seed 解析正确', String(detailA.seed));
  check(detailA.gameMode === 1 && detailA.gameModeName === '创造', 'gameMode=1（创造）', detailA.gameModeName);
  check(detailA.hardcore === false, 'hardcore=false');
  check(detailA.fileCount === 4 && detailA.sizeBytes > 0, 'fileCount=4（level.dat/icon/region/data）、sizeBytes>0', `${detailA.fileCount} / ${detailA.sizeBytes}`);
  const detailB = worlds.detail(HOME, INSTANCE_ID, folderB);
  check(detailB.seed === null && detailB.gameMode === null && detailB.hardcore === false, '坏 level.dat 的 detail 也优雅降级');
  check(detailB.fileCount === 3, '坏 level.dat 存档仍能数文件（3 个）', String(detailB.fileCount));

  /* -------------------------------------------------- ③ 备份 / 恢复 / 导出 / 删除 */
  section('③ 存档全链路：backup → backups → restore → export → delete → restore');
  const bk = worlds.backup(HOME, INSTANCE_ID, folderA);
  console.log(`  backup → file=${path.basename(bk.file)} sizeBytes=${bk.sizeBytes}`);
  check(fs.existsSync(bk.file), '备份 zip 已生成');
  check(bk.file.startsWith(path.join(HOME, 'backups', 'worlds')), '备份落在 <home>/backups/worlds');
  check(bk.sizeBytes > 0 && bk.sizeBytes === fs.statSync(bk.file).size, 'sizeBytes 与磁盘一致');

  const backups = worlds.listBackups(HOME, INSTANCE_ID, folderA);
  console.log(`  backups → ${backups.length} 条：${backups.map((x) => x.name).join(', ')}`);
  check(backups.length === 1, '备份列表 1 条');
  check(!!backups[0] && !!backups[0].file && !!backups[0].name && backups[0].sizeBytes > 0 && !Number.isNaN(Date.parse(backups[0].time)), '备份项字段齐全（file/name/sizeBytes/time）');

  // 备份后改动存档 → 恢复后应回到备份时的内容
  fs.writeFileSync(path.join(saveA, 'region', 'stale.mca'), Buffer.from('backup 之后才写入的文件'));
  const restored = worlds.restore(HOME, INSTANCE_ID, folderA, bk.file);
  console.log(`  restore → extracted=${restored.extracted} movedTo=${restored.movedTo && path.basename(restored.movedTo)}`);
  check(restored.ok === true && restored.extracted >= 3, '恢复解压了备份里的文件', String(restored.extracted));
  check(!fs.existsSync(path.join(saveA, 'region', 'stale.mca')), '备份之后改的内容被回滚（存档回到备份时状态）');
  check(!!restored.movedTo && fs.existsSync(restored.movedTo), '恢复前把现存档移到 recycle（没有硬删）');
  check(fs.existsSync(path.join(saveA, 'level.dat')), '恢复后 level.dat 在');

  const ex = worlds.exportWorld(HOME, INSTANCE_ID, folderA);
  console.log(`  export → file=${path.basename(ex.file)} sizeBytes=${ex.sizeBytes}`);
  check(fs.existsSync(ex.file) && ex.file.startsWith(path.join(HOME, 'exports')), '导出落在 <home>/exports');

  const del = worlds.remove(HOME, INSTANCE_ID, folderA);
  const afterDelete = worlds.list(HOME, INSTANCE_ID);
  console.log(`  delete → movedTo=${path.basename(del.movedTo)}；剩余 ${afterDelete.map((w) => w.folder).join(',')}`);
  check(del.ok === true && fs.existsSync(del.movedTo), '删除是「移到 recycle」而不是硬删');
  check(!afterDelete.some((w) => w.folder === folderA), '存档已从列表消失');
  check(afterDelete.length === 1, '只剩坏存档 B');

  const restored2 = worlds.restore(HOME, INSTANCE_ID, folderA, bk.file);
  const afterRestore = worlds.list(HOME, INSTANCE_ID);
  console.log(`  再次 restore → extracted=${restored2.extracted}；列表 ${afterRestore.map((w) => w.folder).join(',')}`);
  check(afterRestore.some((w) => w.folder === folderA), '删除后仍能从备份恢复');

  /* ------------------------------------------------------ ④ 安全性（中文错误） */
  section('④ 安全性：目录穿越 / 越界备份必须有中文错误');
  const badCases = [
    ['../escape', () => worlds.detail(HOME, INSTANCE_ID, '../escape'), 'E_WORLD_BAD_FOLDER'],
    ['..\\escape', () => worlds.detail(HOME, INSTANCE_ID, '..\\escape'), 'E_WORLD_BAD_FOLDER'],
    ['不存在的存档', () => worlds.detail(HOME, INSTANCE_ID, 'nope'), 'E_WORLD_NOT_FOUND'],
    ['坏备份路径', () => worlds.restore(HOME, INSTANCE_ID, folderA, path.join(os.tmpdir(), 'evil.zip')), 'E_WORLD_BAD_BACKUP'],
  ];
  for (const [label, fn, code] of badCases) {
    let err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    console.log(`  ${label} → code=${err && err.code}｜${err && err.message}`);
    check(!!err && err.code === code && /[\u4e00-\u9fa5]/.test(err.message), `${label}：${code} + 中文提示`);
  }

  /* --------------------------------------------------------------- ⑤ 整合包 */
  section('⑤ 整合包：export → inspect → list → import 到新实例（含 raw zip）');
  const mcDir = path.join(inst.dir, '.minecraft');
  fs.mkdirSync(path.join(mcDir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'saves'), { recursive: true });
  fs.writeFileSync(path.join(mcDir, 'mods', 'fake-mod.jar'), Buffer.from('PK\u0003\u0004fake-mod-jar'));
  fs.writeFileSync(path.join(mcDir, 'config', 'test.cfg'), Buffer.from('key=value'));
  fs.writeFileSync(path.join(mcDir, 'saves', 'dummy.txt'), Buffer.from('save'));
  fs.writeFileSync(path.join(mcDir, 'options.txt'), Buffer.from('lang:zh_CN'));

  const exportRes = await call('modpack:export', { id: INSTANCE_ID, includeSaves: true });
  console.log(`  modpack:export → file=${exportRes.file} sizeBytes=${exportRes.sizeBytes} mods=${exportRes.mods} overrides=${exportRes.overrides}`);
  check(exportRes.ok === true && fs.existsSync(exportRes.file), '导出成功且文件存在');
  check(exportRes.sizeBytes > 0 && path.isAbsolute(exportRes.file), 'sizeBytes>0、file 是绝对路径');

  const inspectRes = await call('modpack:inspect', { file: exportRes.file });
  console.log(`  modpack:inspect → ${JSON.stringify(inspectRes).slice(0, 220)}`);
  check(inspectRes.ok === true, 'inspect 成功');
  check(inspectRes.format === 'qcl', "format='qcl'");
  check(inspectRes.modCount === 1, 'modCount=1', String(inspectRes.modCount));
  check(inspectRes.fileCount >= 4, 'fileCount ≥ 4', String(inspectRes.fileCount));
  check(inspectRes.version === '1.20.1', 'version=1.20.1', String(inspectRes.version));

  const listRes = await call('modpack:list', {});
  console.log(`  modpack:list → ${Array.isArray(listRes) ? listRes.length : 'not-array'} 条：${Array.isArray(listRes) ? listRes[0] && listRes[0].name : JSON.stringify(listRes)}`);
  check(Array.isArray(listRes) && listRes.length === 1, 'list 返回数组且 1 条');
  check(
    Array.isArray(listRes) && !!listRes[0].file && !!listRes[0].name && listRes[0].sizeBytes > 0 && !Number.isNaN(Date.parse(listRes[0].time)),
    '列表项字段齐全（file/name/sizeBytes/time）'
  );

  const importRes = await call('modpack:import', { file: exportRes.file });
  console.log(`  modpack:import → instanceId=${importRes.instanceId} name=${importRes.instance && importRes.instance.name} extracted=${importRes.extracted}`);
  check(importRes.ok === true && !!importRes.instanceId && importRes.instanceId !== INSTANCE_ID, '导入创建了**新实例**');
  check(importRes.extracted >= 3, '解包写入文件数 ≥3', String(importRes.extracted));
  const importedModsDir = path.join(importRes.instance.dir, '.minecraft', 'mods');
  check(fs.existsSync(path.join(importedModsDir, 'fake-mod.jar')), '新实例 mods 目录里有模组 jar');
  check(fs.existsSync(path.join(importRes.instance.dir, '.minecraft', 'saves', 'dummy.txt')), 'includeSaves=true 时存档也导入了');
  check(importRes.instance.mcVersion === '1.20.1', '新实例记住了游戏版本', importRes.instance.mcVersion);

  // raw zip（没有 manifest、只有 .minecraft 结构）
  const rawZip = path.join(WORK, 'raw-pack.zip');
  const { createZip } = require(path.join(CORE, 'zipwriter.js'));
  createZip(rawZip, [
    { name: 'mods/raw.jar', data: Buffer.from('raw-mod') },
    { name: 'config/raw.cfg', data: Buffer.from('a=b') },
  ]);
  const rawInspect = await call('modpack:inspect', { file: rawZip });
  console.log(`  raw zip inspect → format=${rawInspect.format} modCount=${rawInspect.modCount}`);
  check(rawInspect.ok === true && rawInspect.format === 'raw', "raw zip 识别为 format='raw'");

  /* --------------------------------------------------------- ⑥ app:pickFile */
  section('⑥ app:pickFile（用假 dialog 验证参数与取消分支）');
  const pickTarget = path.join(WORK, 'picked.zip');
  fs.writeFileSync(pickTarget, Buffer.from('x'));
  pickFileResult = { canceled: false, filePaths: [pickTarget] };
  const picked = await call('app:pickFile', {
    title: '选择整合包',
    filters: [{ name: '整合包 (ZIP)', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  console.log(`  pickFile → ${JSON.stringify(picked)}`);
  console.log(`  dialog 收到参数：${JSON.stringify(pickFileResult.options)}`);
  check(picked.ok === true && picked.canceled === false && picked.filePath === pickTarget, '返回选中的绝对路径');
  check(pickFileResult.options.title === '选择整合包', 'title 透传');
  check(pickFileResult.options.properties.includes('openFile'), 'properties 透传');
  check(pickFileResult.options.filters && pickFileResult.options.filters[0].extensions[0] === 'zip', 'filters 透传');
  pickFileResult = { canceled: true, filePaths: [] };
  const canceled = await call('app:pickFile', {});
  check(canceled.ok === true && canceled.canceled === true && canceled.filePath === null, '取消时 canceled=true、filePath=null');

  /* -------------------------------------------------- ⑦ modupdate（真实 API） */
  section('⑦ 模组更新：真下载 sodium 新旧两个 jar → 真调 Modrinth 批量更新接口');
  const updInst = await instances.create(HOME, { name: '模组更新测试', mcVersion: '1.20.1', loader: { type: 'fabric', version: '' } });
  const updModsDir = path.join(updInst.dir, '.minecraft', 'mods');
  fs.mkdirSync(updModsDir, { recursive: true });
  const sodiumVersions = await contentapi.getVersions('sodium', { mcVersion: '1.20.1', loader: 'fabric' });
  const latest = sodiumVersions[0];
  const older = sodiumVersions[sodiumVersions.length - 1];
  console.log(`  准备两个真实 jar：旧 ${older.versionNumber}（${older.files[0].filename}）、新 ${latest.versionNumber}（${latest.files[0].filename}）`);
  /**
   * ★ 这里不走 contentapi.downloadTo：它会按「同一个 project 只保留一个文件」管理 mods 目录
   *   （写 .qcl-content.json 并把同项目的旧文件替换掉），下第二个会把第一个删掉。
   *   本用例要同时存在新旧两个 jar，所以直接用 http.fetchBuffer 落到 mods/。
   */
  const httpMod = require(path.join(CORE, 'http.js'));
  const downloadOne = async (version) => {
    const f = version.files[0];
    const buf = await httpMod.fetchBuffer(f.url, { timeoutMs: 60000 });
    const dest = path.join(updModsDir, f.filename);
    fs.writeFileSync(dest, buf);
    return { filename: f.filename, bytes: buf.length, path: dest };
  };
  const dlOlder = await downloadOne(older);
  const dlLatest = await downloadOne(latest);
  console.log(`  已下载：${dlOlder.filename}（${dlOlder.bytes} B）、${dlLatest.filename}（${dlLatest.bytes} B）`);

  const upd = await call('mods:checkUpdates', { id: updInst.id });
  console.log(`  mods:checkUpdates → checked=${upd.checked} items=${upd.items.length} error=${upd.error}`);
  for (const it of upd.items) {
    console.log(`    · ${it.fileName}`);
    console.log(`      name=${it.name} current=${JSON.stringify(it.current)} latest=${it.latest}`);
    console.log(`      downloadUrl=${it.downloadUrl}`);
    console.log(`      sha1=${it.sha1} size=${it.size} projectId=${it.projectId}`);
  }
  check(upd.checked === 2, 'checked=2（两个 jar 都算了指纹并查询）', String(upd.checked));
  check(upd.error === null, 'error=null');
  check(upd.items.length === 1, '只报「旧版本」那一个（新版本 sha1 相同 → 不算更新）', String(upd.items.length));
  const item = upd.items[0];
  check(!!item && item.fileName === dlOlder.filename, '更新项指向旧 jar', item && item.fileName);
  check(!!item && item.latest === latest.versionNumber, 'latest 是 Modrinth 最新版本号', item && item.latest);
  check(!!item && /^https:\/\/cdn\.modrinth\.com\//.test(item.downloadUrl), 'downloadUrl 是 Modrinth CDN 直链');
  check(!!item && /^[0-9a-f]{40}$/.test(item.sha1), 'sha1 是 40 位十六进制');
  check(!!item && item.sha1 === latest.files[0].sha1, 'sha1 = 最新版主文件的 sha1', item && item.sha1);
  check(!!item && item.size === latest.files[0].size && item.size > 0, 'size = 最新版文件大小', String(item && item.size));
  check(!!item && item.projectId === 'AANobbMI', 'projectId = sodium 的项目 id', item && item.projectId);
  check(!!item && typeof item.current === 'string', 'current 带上了 jar 内元数据版本（可能为空）', JSON.stringify(item && item.current));

  // 只查 fabric 加载器：查询时确实带了 loaders 过滤
  console.log(`  filtersOf → ${JSON.stringify(modupdate.filtersOf({ instance: updInst }))}`);
  check(JSON.stringify(modupdate.filtersOf({ instance: updInst }).loaders) === '["fabric"]', '加载器过滤为 fabric');

  /* ------------------------------------------------------ ⑧ modupdate 容错 */
  section('⑧ 模组更新：网络失败 / 空 mods 都不能炸');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const e = new Error('getaddrinfo ENOTFOUND api.modrinth.com');
    e.code = 'ENOTFOUND';
    throw e;
  };
  let netRes;
  try {
    netRes = await call('mods:checkUpdates', { id: updInst.id });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`  网络故障 → ${JSON.stringify(netRes)}`);
  check(netRes && netRes.checked === 0 && Array.isArray(netRes.items) && netRes.items.length === 0, '网络失败返回 checked:0 / items:[]');
  check(!!netRes && typeof netRes.error === 'string' && /连不上 Modrinth/.test(netRes.error), 'error 是中文且说明网络问题', netRes && netRes.error);

  const emptyInst = await instances.create(HOME, { name: '空模组实例', mcVersion: '1.20.1' });
  fs.mkdirSync(path.join(emptyInst.dir, '.minecraft', 'mods'), { recursive: true });
  const emptyRes = await call('mods:checkUpdates', { id: emptyInst.id });
  console.log(`  空 mods → ${JSON.stringify(emptyRes)}`);
  check(emptyRes.checked === 0 && emptyRes.items.length === 0 && emptyRes.error === null, '空 mods 返回空结果且不报错');
  const noInst = await call('mods:checkUpdates', { id: 'no-such-instance' });
  check(noInst.checked === 0 && !!noInst.error && /实例不存在/.test(noInst.error), '实例不存在时返回中文错误');

  /* ------------------------------------------------------------ 收尾 */
  section('结果');
  console.log(`  失败项：${failures}`);
  if (failures === 0) {
    console.log('\n  ✓ 全部检查项通过（存档全链路 / 整合包导出导入 / 模组更新真实 API）');
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log('  已清理临时目录 build/.verify-worlds-modupdate（用户 QCL home 全程未触碰）');
  } else {
    console.log(`\n  ✗ 有检查项失败（临时目录保留：${WORK}）`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n脚本本身出错：', err);
  process.exit(2);
});
