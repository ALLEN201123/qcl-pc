'use strict';
/*
 * 实测脚本：把 Electron 换成桩，**真的走 IPC 处理器**验证 Modrinth 内容通道
 *
 * 运行：node build/verify-content-ipc.js
 *
 * 为什么需要它：node --check 只能证明语法没错，证明不了
 *   · handlers 表里的通道名是否真的注册上（ipcMain.handle 有没有被调到）；
 *   · content:download 的落盘目录规则对不对；
 *   · task:progress 事件里的 bytes/percent 有没有真的发出去；
 *   · 报错经过 registerIpc 的包装后仍是中文。
 *
 * 手段：用 Module._load 把 require('electron') 换成桩（app/shell/ipcMain/BrowserWindow），
 *       ipcMain.handle 把每个通道的处理函数记下来，脚本直接按 (event, payload) 调用。
 *       BrowserWindow.getAllWindows() 返回一个假窗口，于是 send() 的事件能被抓到。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.verify-ipc');
const HOME = path.join(WORK, 'home');

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/* ------------------------------------------------------------------ electron 桩 */
const handlers = new Map();
const events = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    // send() 的兜底分支会调这两个，缺一个就会被 catch 掉、事件静默丢弃
    isLoading: () => false,
    send: (channel, payload) => events.push({ channel, payload })
  }
};
const fakeElectron = {
  app: {
    getName: () => 'QCL',
    getVersion: () => '1.0.0',
    getPath: () => os.tmpdir()
  },
  shell: { openPath: async () => '', openExternal: async () => {} },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn)
  },
  BrowserWindow: class FakeBrowserWindow {
    static getAllWindows() {
      return [fakeWindow];
    }
  },
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] }
};

const origLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'electron') return fakeElectron;
  // eslint-disable-next-line prefer-rest-params
  return origLoad.apply(this, arguments);
};

const ipc = require(path.join(ROOT, 'src/main/ipc.js'));
ipc.initContext({
  settings: {
    value: (key) => {
      if (key === 'home') return HOME;
      if (key === 'downloader') return { source: 'official', threads: 4 };
      return undefined;
    },
    get: () => ({ home: HOME, downloader: { source: 'official', threads: 4 } })
  }
});
ipc.registerIpc();

/** 按 ipcMain.handle 的真实调用约定执行（_event, payload）。 */
async function call(channel, payload) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`通道没有注册：${channel}`);
  return fn({}, payload || {});
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  section('① 通道注册情况');
  const expected = [
    'content:sources',
    'content:search',
    'content:project',
    'content:versions',
    'content:download',
    'content:favorites',
    'content:addFavorite',
    'content:removeFavorite'
  ];
  console.log(`  ipcMain.handle 注册了 ${handlers.size} 个通道`);
  for (const ch of expected) console.log(`    ${handlers.has(ch) ? '✓' : '✗'} ${ch}`);
  check(expected.every((ch) => handlers.has(ch)), '8 个内容通道全部注册成功');

  const sources = await call('content:sources', {});
  console.log(`  content:sources → ok=${sources.ok}：${sources.sources.map((s) => `${s.id}(${s.name})`).join(' / ')}`);
  check(sources.ok === true && sources.sources.length === 3, 'content:sources 返回 3 个源');
  check(sources.sources[0].id === 'mixed', 'mixed 排在首位（默认源）');
  check(sources.sources.every((s) => s.id && s.name && s.desc), '每项都有 id/name/desc');

  section('② content:search —— 真实搜索整合包（默认 mixed）');
  const searchRes = await call('content:search', { projectType: 'modpack', query: 'fabulously-optimized', limit: 3 });
  console.log(`  total=${searchRes.total} hits=${searchRes.hits.length} source=${searchRes.source}`);
  console.log(`  breakdown=${JSON.stringify(searchRes.breakdown)}`);
  const hit = searchRes.hits.find((h) => h.slug === 'fabulously-optimized') || searchRes.hits[0];
  console.log(`  首条：${hit.title} / ${hit.author} / 下载 ${hit.downloads} / ${hit.projectType} / 来源 ${hit.source}`);
  check(Array.isArray(searchRes.hits) && searchRes.hits.length > 0, 'IPC 返回 hits 数组');
  check(typeof searchRes.total === 'number' && searchRes.total > 0, 'total 是数字', String(searchRes.total));
  check(!!hit.id && !!hit.slug && !!hit.title && !!hit.iconUrl, 'hit 字段齐全（id/slug/title/iconUrl）');
  check(searchRes.source === 'mixed', '不传 source 时默认走 mixed');
  check(searchRes.hits.every((h) => h.source === 'modrinth' || h.source === 'curseforge'), '每条结果都带 source 徽章');
  check(!!searchRes.breakdown, 'mixed 返回两边 breakdown');

  const cfSearch = await call('content:search', { source: 'curseforge', projectType: 'modpack', limit: 3 });
  console.log(`  source=curseforge → hits=${cfSearch.hits.length} 首条=${cfSearch.hits[0] && cfSearch.hits[0].title}（id=${cfSearch.hits[0] && cfSearch.hits[0].id}）`);
  check(cfSearch.hits.length > 0 && cfSearch.hits.every((h) => h.source === 'curseforge'), 'source=curseforge 只返回 CurseForge 结果');

  section('③ content:project / content:versions（含 CurseForge 分流）');
  const project = await call('content:project', { id: 'fabulously-optimized', source: 'modrinth' });
  console.log(`  项目：${project.title}  follow=${project.follows}  版本 id 数=${project.versionIds.length}`);
  check(project.id === hit.id, '项目 id 与搜索结果一致', project.id);
  const versions = await call('content:versions', { id: 'fabulously-optimized', source: 'modrinth', mcVersion: '1.20.1', loader: 'fabric' });
  const v = versions[0];
  console.log(`  版本数=${versions.length}  v0=${v.versionNumber}（${v.name}） 文件=${v.files[0].filename} ${v.files[0].size} 字节`);
  check(versions.length > 0 && !!v.files[0].url, '版本列表非空且有下载地址');

  // CurseForge 分流：纯数字 id + source=curseforge → 走镜像
  const cfVersions = await call('content:versions', { id: '238222', source: 'curseforge', mcVersion: '1.20.1', loader: 'fabric', limit: 3 });
  const cfv = cfVersions[0];
  console.log(`  CurseForge 版本数=${cfVersions.length}  v0=${cfv && cfv.name}  gameVersions=${cfv && cfv.gameVersions.join(',')}  sha1=${cfv && cfv.files[0].sha1}`);
  check(cfVersions.length > 0 && cfVersions.every((x) => x.source === 'curseforge'), 'source=curseforge 的版本来自 CurseForge');
  check(!!cfv && !!cfv.files[0].url && /^[0-9a-f]{40}$/.test(String(cfv.files[0].sha1)), 'CurseForge 版本带下载直链与 40 位 sha1');
  const cfProject = await call('content:project', { id: String(cfSearch.hits[0].id), source: 'curseforge' });
  console.log(`  CurseForge 项目详情：${cfProject.title}（author=${cfProject.author}）`);
  check(cfProject.id === String(cfSearch.hits[0].id) && !!cfProject.title, 'content:project 支持 CurseForge 数字 id');

  section('④ content:download —— 真实下载 + 落盘目录规则 + 进度事件');
  const dl = await call('content:download', { id: 'fabulously-optimized', versionId: v.id, projectType: 'modpack', source: 'modrinth' });
  console.log(`  result.dir  = ${dl.dir}`);
  console.log(`  result.path = ${dl.path}`);
  console.log(`  filename=${dl.filename}  bytes=${dl.bytes}  source=${dl.source}  taskId=${dl.taskId}`);
  check(dl.ok === true && fs.existsSync(dl.path), '文件真实落盘');
  check(dl.source === 'modrinth', '下载结果标了 source=modrinth');
  check(dl.dir === path.join(HOME, 'downloads'), '整合包（无实例 id）落到 <home>/downloads', dl.dir);
  check(dl.bytes === v.files[0].size, '下载字节数与 API 一致', `${dl.bytes} vs ${v.files[0].size}`);

  const progress = events.filter((e) => e.channel === 'task:progress');
  console.log(`  抓到 task:progress 事件 ${progress.length} 条：`);
  for (const e of progress.slice(0, 5)) {
    const p = e.payload;
    console.log(`    taskId=${p.taskId} phase=${p.phase} current=${p.current}/${p.total} bytes=${p.bytes}/${p.bytesTotal} percent=${p.percent} done=${p.done}`);
  }
  const last = progress[progress.length - 1];
  check(progress.length > 0, '下载过程发出了 task:progress');
  check(!!last && last.payload.percent === 100 && last.payload.done === true, '最后一条进度 percent=100 且 done=true');
  check(progress.some((e) => Number.isFinite(e.payload.bytesTotal)), '进度里带上了字节总量 bytesTotal（新加的字段）');

  // 指定实例 + 类型 → 落到实例的 .minecraft 子目录（用真实 mod 验证 mods 目录规则）
  const instances = require(path.join(ROOT, 'src/main/core/instances.js'));
  const inst = await instances.create(HOME, { name: 'IPC 测试实例', mcVersion: '1.20.1' });
  const dl2 = await call('content:download', { id: 'fabulously-optimized', versionId: v.id, instId: inst.id, projectType: 'modpack' });
  console.log(`  带实例（modpack 类型）→ ${dl2.dir}`);
  check(dl2.dir === path.join(HOME, 'downloads'), '整合包仍落 <home>/downloads（不塞进实例）');

  const modSearch = await call('content:search', { source: 'modrinth', projectType: 'mod', query: 'sodium', mcVersion: '1.20.1', loader: 'fabric', limit: 1 });
  const modHit = modSearch.hits[0];
  const modVersions = await call('content:versions', { id: modHit.id, source: 'modrinth', mcVersion: '1.20.1', loader: 'fabric' });
  const modVersion = modVersions[0];
  console.log(`  mod 测试：${modHit.title} 版本 ${modVersion.versionNumber} 文件 ${modVersion.files[0].filename}`);
  const dlMod = await call('content:download', { id: modHit.id, versionId: modVersion.id, instId: inst.id, projectType: 'mod', source: 'modrinth' });
  console.log(`  带实例（mod 类型）→ ${dlMod.dir}`);
  check(
    dlMod.dir === path.join(inst.dir, '.minecraft', 'mods'),
    'mod 落到实例的 .minecraft/mods',
    dlMod.dir
  );
  check(fs.existsSync(dlMod.path), 'mod 文件真实落盘');

  section('⑤ 收藏通道');
  const empty = await call('content:favorites', {});
  const add1 = await call('content:addFavorite', { item: hit });
  const add2 = await call('content:addFavorite', { item: hit });
  const favs = await call('content:favorites', {});
  const file = path.join(HOME, 'favorites.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`  空收藏=${JSON.stringify(empty)}  add1.added=${add1.added}  add2.added=${add2.added}  list=${favs.length}`);
  console.log(`  favorites.json version=${json.version} items=${json.items.length}`);
  check(empty.length === 0, '初始为空');
  check(add1.added === true && add2.added === false, '重复收藏不重复（added 先 true 后 false）');
  check(favs.length === 1 && favs[0].id === hit.id, 'list 返回 items 数组且 id 正确');
  const removed = await call('content:removeFavorite', { id: hit.slug });
  const after = await call('content:favorites', {});
  console.log(`  removeFavorite → removed=${removed.removed}  剩余 ${after.length}`);
  check(removed.removed === true && after.length === 0, '删除后列表为空');

  section('⑥ 报错经过 IPC 包装后仍是中文');
  let err = null;
  try {
    await call('content:project', { id: 'qcl-definitely-missing-2026' });
  } catch (e) {
    err = e;
  }
  console.log(`  抛出：${err && err.message}`);
  check(!!err && /[\u4e00-\u9fa5]/.test(err.message), '错误信息是中文');
  check(!!err && /找不到该内容/.test(err.message), '保留了「Modrinth 上找不到该内容」的说明');

  section('⑦ preload 白名单是否放行这些通道');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/index.js'), 'utf8');
  const m = preloadSrc.match(/const INVOKE_RE = \/\^\(([^)]+)\):\[A-Za-z\]\+\$\/;/);
  check(!!m, '能解析 preload 的 INVOKE_RE');
  if (m) {
    const invokeRe = new RegExp(`^(${m[1]}):[A-Za-z]+$`);
    console.log(`  INVOKE_RE 解析结果：${invokeRe}`);
    for (const ch of expected) {
      console.log(`    ${invokeRe.test(ch) ? '✓' : '✗'} ${ch}`);
      check(invokeRe.test(ch), `preload 放行 ${ch}`);
    }
    check(invokeRe.test('launch:start') && invokeRe.test('mods:list'), '原有通道没被破坏');
  }

  section('结果');
  console.log(`  工作目录：${WORK}`);
  console.log(`  失败项：${failures}`);
  if (failures) {
    console.log('\n  ✗ 有检查项失败');
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ 全部检查项通过（真实 API + 真实 IPC 处理器 + 真实落盘）');
  }
}

main().catch((e) => {
  console.error('脚本本身出错：', e);
  process.exit(2);
});
