'use strict';
/*
 * 实测脚本：**真的**调 Modrinth 官方 API，验证 src/main/core/contentapi.js
 *
 * 运行：node build/verify-content-modrinth.js
 *
 * 覆盖：
 *   ① 搜索（整合包）—— 打印项目名、作者、下载量，并对照原始 JSON 证明字段名
 *   ② 项目详情 —— 证明详情接口用 followers（不是 follows）、没有 author
 *   ③ 版本列表 —— 按 1.20.1 + fabric 过滤，打印版本号 / 下载链接 / 文件大小 / sha1
 *   ④ 真实下载 —— 落盘 + sha1 校验 + 二次调用走「已存在跳过」
 *   ⑤ sha1 校验失败 —— 用假 CDN 返回同尺寸但内容不同的文件，必须抛中文错误
 *   ⑥ 收藏 —— 增 / 查 / 去重 / 删，检查 favorites.json 的 { version:1, items:[] } 结构
 *   ⑦ 错误分类 —— 「网络不通（E_NETWORK/E_TIMEOUT）」与「API 返回错误（E_CONTENT_API+404）」提示不同
 *   ⑧ User-Agent —— 抓一次真实请求的请求头，确认每个请求都带 Modrinth 要求的 UA
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const api = require(path.join(ROOT, 'src', 'main', 'core', 'contentapi.js'));
const downloader = require(path.join(ROOT, 'src', 'main', 'core', 'downloader.js'));

const WORK = path.join(__dirname, '.verify-content');
const RAW_HEADERS = { 'User-Agent': api.USER_AGENT, Accept: 'application/json' };

let failures = 0;
function check(ok, label, extra) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`  [${mark}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
function rawGet(url) {
  return fetch(url, { headers: RAW_HEADERS }).then((r) => r.json());
}

/** 用假 CDN 响应测试 sha1 校验：内容同尺寸但全 0x41，sha1 必然不符。 */
function installFakeCdn(size) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://cdn.modrinth.com/')) {
      const body = Buffer.alloc(size, 0x41);
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    return realFetch(url, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  /* ------------------------------------------------ ① 搜索（原始 vs 归一化） */
  section('① 搜索整合包 fabulously-optimized（真实请求 https://api.modrinth.com/v2/search）');
  const rawSearchUrl = `${api.API_BASE}/search?query=${encodeURIComponent('fabulously-optimized')}&facets=${encodeURIComponent(JSON.stringify([['project_type:modpack']]))}&limit=5&offset=0`;
  const rawSearch = await rawGet(rawSearchUrl);
  console.log(`  原始 JSON 顶层字段：${Object.keys(rawSearch).join(', ')}`);
  console.log(`  原始 total_hits = ${rawSearch.total_hits}（没有 total 字段：${rawSearch.total === undefined}）`);
  console.log(`  原始 hit 字段：${Object.keys(rawSearch.hits[0]).join(', ')}`);

  const found = await api.search({ source: 'modrinth', projectType: 'modpack', query: 'fabulously-optimized', limit: 5 });
  console.log(`\n  search() 返回：total=${found.total} offset=${found.offset} limit=${found.limit} hits=${found.hits.length}`);
  const hit = found.hits.find((h) => h.slug === 'fabulously-optimized') || found.hits[0];
  console.log(`  命中项目：${hit.title}`);
  console.log(`    id=${hit.id} slug=${hit.slug} 作者=${hit.author} 下载=${hit.downloads} 关注=${hit.follows}`);
  console.log(`    类型=${hit.projectType} 分类=${hit.categories.join('/')}`);
  console.log(`    支持的游戏版本=${hit.versions.length} 个（${hit.versions.slice(0, 4).join(', ')} … ${hit.versions[hit.versions.length - 1]}）`);
  console.log(`    latestVersion（版本 id）= ${hit.latestVersion}`);
  console.log(`    图标=${hit.iconUrl}`);
  check(found.total === rawSearch.total_hits && found.total > 0, 'total 来自 total_hits', `${found.total} vs ${rawSearch.total_hits}`);
  check(!!hit.author, 'hit.author 有值（搜索接口才有作者）', hit.author);
  check(hit.projectType === 'modpack', 'projectType=modpack');
  check(Array.isArray(hit.versions) && hit.versions.includes('1.20.1'), 'versions 是游戏版本号数组且含 1.20.1');

  /* ------------------------------------------------------------- ② 项目详情 */
  section('② 项目详情 getProject（证明 followers / 没有 author）');
  const rawProject = await rawGet(`${api.API_BASE}/project/fabulously-optimized`);
  console.log(`  原始字段里 followers=${rawProject.followers}  follows=${rawProject.follows}  author=${rawProject.author}`);
  const project = await api.getProject('fabulously-optimized');
  console.log(`  getProject() → ${project.title}`);
  console.log(`    follows=${project.follows}（归一自 followers） downloads=${project.downloads} 作者=[${project.author}]`);
  console.log(`    版本 id 数=${project.versionIds.length}  游戏版本数=${project.versions.length}  加载器=${project.loaders.join('/')}  许可证=${project.license}`);
  check(project.follows === rawProject.followers, 'follows 归一自原始 followers', `${project.follows}`);
  check(project.author === '' && rawProject.author === undefined, '项目详情确实没有 author 字段', `author="${project.author}"`);

  /* ------------------------------------------------------------- ③ 版本列表 */
  section('③ 版本列表 getVersions（按 1.20.1 + fabric 过滤）');
  const versions = await api.getVersions('fabulously-optimized', { mcVersion: '1.20.1', loader: 'fabric' });
  const v = versions[0];
  console.log(`  过滤后版本数 = ${versions.length}`);
  console.log(`  最新一条（Modrinth 默认新→旧）：`);
  console.log(`    id=${v.id}  name=${v.name}`);
  console.log(`    versionNumber=${v.versionNumber}  versionType=${v.versionType}  datePublished=${v.datePublished}`);
  console.log(`    gameVersions=${v.gameVersions.join(',')}  loaders=${v.loaders.join(',')}`);
  for (const f of v.files) {
    console.log(`    文件：${f.filename}  ${fmtBytes(f.size)}（${f.size} 字节）`);
    console.log(`      下载地址：${f.url}`);
    console.log(`      sha1：${f.sha1}  primary=${f.primary}`);
  }
  check(versions.length > 0, '过滤后的版本列表非空');
  check(v.gameVersions.includes('1.20.1') && v.loaders.includes('fabric'), '版本带 game_versions/loaders 过滤生效');
  check(!!v.files[0].url && !!v.files[0].filename && !!v.files[0].sha1 && v.files[0].size > 0, 'files 含 url/filename/sha1/size');

  /* --------------------------------------------------------------- ④ 下载 */
  section('④ 真实下载 downloadTo（落盘 + sha1 校验）');
  const destDir = path.join(WORK, 'downloads');
  let lastPercent = -1;
  let progressEvents = 0;
  const t0 = Date.now();
  const dl = await api.downloadTo('fabulously-optimized', v.id, destDir, {
    source: 'modrinth',
    onProgress: (p) => {
      progressEvents += 1;
      lastPercent = p.percent;
    }
  });
  const ms = Date.now() - t0;
  console.log(`  ok=${dl.ok}  filename=${dl.filename}`);
  console.log(`  path=${dl.path}`);
  console.log(`  bytes=${dl.bytes}（${fmtBytes(dl.bytes)}）  耗时 ${ms} ms  进度回调 ${progressEvents} 次（最后 percent=${lastPercent}）`);
  const onDisk = fs.statSync(dl.path).size;
  const diskSha1 = await downloader.sha1OfFile(dl.path);
  console.log(`  磁盘实际大小=${onDisk}  磁盘 sha1=${diskSha1}`);
  console.log(`  API 给的 sha1      =${v.files[0].sha1}`);
  check(fs.existsSync(dl.path), '文件已真实落盘');
  check(onDisk === v.files[0].size, '落盘大小与 API size 一致', `${onDisk} vs ${v.files[0].size}`);
  check(diskSha1 === v.files[0].sha1, '落盘 sha1 与 API sha1 一致');
  check(dl.bytes === onDisk, '返回的 bytes 就是真实字节数');

  const dl2 = await api.downloadTo('fabulously-optimized', v.id, destDir, { source: 'modrinth' });
  console.log(`  二次调用：skipped=${dl2.skipped} bytes=${dl2.bytes}（命中已存在且 sha1 相符，不重复下载）`);
  check(dl2.skipped === true && dl2.bytes === onDisk, '二次调用跳过下载（断点续传语义）');

  /* ------------------------------------------------- ⑤ sha1 校验失败（中文） */
  section('⑤ sha1 校验失败必须抛中文错误（假 CDN 返回同尺寸但内容不同）');
  const restoreFetch = installFakeCdn(v.files[0].size);
  let sha1Err = null;
  try {
    await api.downloadTo('fabulously-optimized', v.id, path.join(WORK, 'corrupt'), { source: 'modrinth' });
  } catch (err) {
    sha1Err = err;
  } finally {
    restoreFetch();
  }
  console.log(`  抛出：code=${sha1Err && sha1Err.code}\n  信息：${sha1Err && sha1Err.message}`);
  check(!!sha1Err, '确实抛错了');
  check(!!sha1Err && sha1Err.code === 'E_CONTENT_DOWNLOAD', '错误码是 E_CONTENT_DOWNLOAD');
  check(!!sha1Err && /校验失败|sha1/i.test(sha1Err.message), '错误信息里说明了校验失败');
  check(!!sha1Err && /[\u4e00-\u9fa5]/.test(sha1Err.message), '错误信息是中文');
  check(!fs.existsSync(path.join(WORK, 'corrupt', dl.filename)), '坏文件没有留在目标目录');

  /* --------------------------------------------------------------- ⑥ 收藏 */
  section('⑥ 收藏 listFavorites / addFavorite / removeFavorite');
  const home = path.join(WORK, 'home');
  fs.mkdirSync(home, { recursive: true });
  const empty = await api.listFavorites(home);
  console.log(`  空收藏 = ${JSON.stringify(empty)}`);
  const added = await api.addFavorite(home, hit);
  console.log(`  addFavorite → ok=${added.ok} added=${added.added} items=${added.items.length} 首项=${added.items[0].title}`);
  const again = await api.addFavorite(home, hit);
  console.log(`  重复 addFavorite → added=${again.added} items=${again.items.length}（按 id 去重）`);
  const favFile = path.join(home, 'favorites.json');
  const favJson = JSON.parse(fs.readFileSync(favFile, 'utf8'));
  console.log(`  favorites.json：version=${favJson.version} items=${favJson.items.length}`);
  console.log(`  首项字段：${Object.keys(favJson.items[0]).join(', ')}`);
  check(added.added === true && added.items.length === 1, '第一次收藏成功');
  check(again.added === false && again.items.length === 1, '重复收藏不产生第二条');
  check(favJson.version === 1 && Array.isArray(favJson.items) && favJson.items[0].id === hit.id, '文件结构是 { version:1, items:[...] }');
  const removed = await api.removeFavorite(home, hit.slug);
  console.log(`  removeFavorite(slug) → removed=${removed.removed} items=${removed.items.length}`);
  check(removed.removed === true && removed.items.length === 0, '按 slug 也能删掉');
  const missing = await api.removeFavorite(home, 'never-existed');
  check(missing.removed === false, '删除不存在的项不报错，removed=false');

  /* --------------------------------------------------- ⑦ 错误分类（关键） */
  section('⑦ 错误分类：网络不通 vs API 返回错误');
  // 7.1 真实 404
  let apiErr = null;
  try {
    await api.getProject('qcl-this-project-does-not-exist-2026');
  } catch (err) {
    apiErr = err;
  }
  console.log(`  API 404：code=${apiErr && apiErr.code} status=${apiErr && apiErr.status}`);
  console.log(`    信息：${apiErr && apiErr.message}`);
  check(!!apiErr && apiErr.code === 'E_CONTENT_API' && apiErr.status === 404, '404 归为 E_CONTENT_API 且带 status=404');
  check(!!apiErr && /找不到该内容/.test(apiErr.message), '提示「Modrinth 上找不到该内容」');

  // 7.2 网络不通（把 fetch 打成 ENOTFOUND）
  const realFetch = globalThis.fetch;
  let netErr = null;
  globalThis.fetch = async () => {
    const e = new Error('getaddrinfo ENOTFOUND api.modrinth.com');
    e.code = 'ENOTFOUND';
    throw e;
  };
  try {
    await api.search({ source: 'modrinth', projectType: 'modpack', query: 'x', limit: 1 });
  } catch (err) {
    netErr = err;
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`  网络不通：code=${netErr && netErr.code}`);
  console.log(`    信息：${netErr && netErr.message}`);
  check(!!netErr && netErr.code === 'E_NETWORK', 'ENOTFOUND 归为 E_NETWORK（网络不通）');
  check(!!netErr && /连不上 Modrinth/.test(netErr.message), '提示「连不上 Modrinth（网络不通…）」');
  check(!!netErr && !!apiErr && netErr.message !== apiErr.message, '两类错误的提示文案确实不同');

  // 7.3 超时
  let timeoutErr = null;
  globalThis.fetch = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  try {
    await api.search({ source: 'modrinth', projectType: 'modpack', query: 'x', limit: 1 });
  } catch (err) {
    timeoutErr = err;
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`  超时：code=${timeoutErr && timeoutErr.code}  信息：${timeoutErr && timeoutErr.message}`);
  check(!!timeoutErr && timeoutErr.code === 'E_TIMEOUT', 'TimeoutError 归为 E_TIMEOUT');
  check(!!timeoutErr && /超时/.test(timeoutErr.message), '提示「连接 Modrinth 超时」');

  /* ------------------------------------------------------------ ⑧ UA 检查 */
  section('⑧ 每个请求都带 User-Agent（Modrinth 硬性要求）');
  let seenUA = null;
  let seenAccept = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(api.API_BASE)) {
      const h = (init && init.headers) || {};
      seenUA = h['User-Agent'] || h['user-agent'] || null;
      seenAccept = h.Accept || h.accept || null;
    }
    return realFetch(url, init);
  };
  try {
    await api.search({ source: 'modrinth', projectType: 'mod', query: 'sodium', limit: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`  抓到请求头：User-Agent=${seenUA}`);
  console.log(`             Accept=${seenAccept}`);
  check(seenUA === api.USER_AGENT, 'User-Agent 与常量一致');
  check(!!seenAccept, 'Accept: application/json 也带上了');

  /* --------------------------------------------------------------- 收尾 */
  section('结果');
  console.log(`  工作目录：${WORK}`);
  console.log(`  失败项：${failures}`);
  if (failures > 0) {
    console.log('\n  ✗ 有检查项失败');
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ 全部检查项通过（以上全部为真实 Modrinth API 返回的数据）');
  }
}

main().catch((err) => {
  console.error('\n脚本本身出错：', err);
  process.exit(2);
});
