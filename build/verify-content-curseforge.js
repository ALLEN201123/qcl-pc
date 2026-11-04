'use strict';
/*
 * 实测脚本：CurseForge（镜像）+ 混合下载源
 *
 * 运行：node build/verify-content-curseforge.js
 *
 * 覆盖（对应需求 5 条验收）：
 *   ① 真实搜 CurseForge 整合包（classId=4471），打印前 3 条的 name / downloadCount / slug
 *   ② 真实拿文件列表，打印 fileName / downloadUrl / sha1（并**真的下载**一个小文件校验 sha1）
 *   ③ source:'mixed' 搜同一关键词，打印两边各命中多少、合并后多少、去重掉多少
 *   ④ CurseForge 的 mod / resourcepack / shader / world（+ datapack）五个 classId 都能返回数据
 *   ⑤ 镜像挂掉：把 base 换成不存在的域名，确认抛 E_NETWORK 中文错误而不是崩
 *   ＋ content:sources 清单、mixed 单边挂掉时的降级、mixed 下载自动回退 CurseForge
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const api = require(path.join(ROOT, 'src', 'main', 'core', 'contentapi.js'));
const downloader = require(path.join(ROOT, 'src', 'main', 'core', 'downloader.js'));

const WORK = path.join(__dirname, '.verify-curseforge');
const BAD_BASE = 'https://mod.mcimirror.invalid/curseforge';

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  /* ---------------------------------------------- ① CurseForge 搜索整合包 */
  section('① CurseForge 搜整合包（classId=4471，镜像 https://mod.mcimirror.top/curseforge）');
  const cfPacks = await api.searchCurseForge({ projectType: 'modpack', limit: 3 });
  console.log(`  返回 hits=${cfPacks.hits.length} total=${cfPacks.total}（镜像分页上限 10000，totalCapped=${cfPacks.totalCapped}）`);
  for (const h of cfPacks.hits) {
    console.log(`  · ${h.title}`);
    console.log(`      slug=${h.slug}  downloadCount=${h.downloads}  author=${h.author}  收藏=${h.follows}`);
    console.log(`      id=${h.id}  projectType=${h.projectType}  source=${h.source}  latestVersion(文件 id)=${h.latestVersion}`);
    console.log(`      iconUrl=${h.iconUrl}`);
    console.log(`      支持版本=${h.versions.join(', ')}`);
    console.log(`      websiteUrl=${h.websiteUrl}`);
  }
  check(cfPacks.hits.length === 3, '返回 3 条整合包');
  check(cfPacks.hits.every((h) => h.source === 'curseforge'), '每条都带 source=curseforge');
  check(cfPacks.hits.every((h) => h.id && h.slug && h.title && h.downloads > 0), 'id/slug/title/downloads 都非空');
  check(cfPacks.hits.every((h) => /^https:\/\/media\.forgecdn\.net\//.test(h.iconUrl)), 'iconUrl 来自 forgecdn 真实图片');
  check(cfPacks.hits.every((h) => h.projectType === 'modpack'), 'projectType 归一成 modpack');
  const atm = cfPacks.hits.find((h) => h.slug === 'all-the-mods-10') || cfPacks.hits[0];
  console.log(`\n  首条（用于后续测试）：${atm.title}  id=${atm.id}`);

  /* ------------------------------------------------- ② 文件列表 + 真实下载 */
  section('② CurseForge 文件列表（归一化成 Modrinth version 结构）+ 真实下载');
  const jeiModId = '238222'; // Just Enough Items（文件小、更新频繁，适合做下载测试）
  const files = await api.getCurseForgeFiles(jeiModId, { limit: 5 });
  console.log(`  getCurseForgeFiles('${jeiModId}') 返回 ${files.length} 条：`);
  for (const f of files) {
    console.log(`  · id=${f.id}  name=${f.name}`);
    console.log(`      versionNumber=${f.versionNumber}  gameVersions=${f.gameVersions.join(',')}  loaders=${f.loaders.join(',')}  type=${f.versionType}`);
    console.log(`      fileName=${f.files[0].filename}`);
    console.log(`      downloadUrl=${f.files[0].url}`);
    console.log(`      size=${f.files[0].size}（${fmtBytes(f.files[0].size)}）  sha1=${f.files[0].sha1}`);
    console.log(`      datePublished=${f.datePublished}`);
  }
  check(files.length > 0, '文件列表非空');
  check(files.every((f) => f.files[0].filename && f.files[0].url && f.files[0].sha1), '每个文件都有 fileName/downloadUrl/sha1');
  check(files.every((f) => /^[0-9a-f]{40}$/.test(f.files[0].sha1)), 'sha1 是 40 位（algo=1）');
  check(files.every((f) => /^https:\/\/edge\.forgecdn\.net\//.test(f.files[0].url)), 'downloadUrl 是 forgecdn 直链');
  check(files.every((f) => f.files[0].size > 0), 'size 非空（fileLength）');
  check(files.every((f) => f.gameVersions.length > 0 && !f.gameVersions.includes('Client')), 'gameVersions 已剔除 Client/Server，只留游戏版本');
  check(files.every((f) => f.loaders.every((l) => ['forge', 'fabric', 'quilt', 'neoforge', 'liteloader'].includes(l))), 'loaders 是正常的加载器名');

  // 真的下一个 CurseForge 文件（挑最小的那个，避免下 200MB 整合包）
  const smallest = files.slice().sort((a, b) => a.files[0].size - b.files[0].size)[0];
  console.log(`\n  真实下载最小文件：${smallest.files[0].filename}（${fmtBytes(smallest.files[0].size)}）…`);
  const t0 = Date.now();
  let lastPercent = -1;
  const dl = await api.downloadTo(jeiModId, smallest.id, path.join(WORK, 'downloads'), {
    source: 'curseforge',
    onProgress: (p) => {
      lastPercent = p.percent;
    }
  });
  const ms = Date.now() - t0;
  console.log(`  下载结果：ok=${dl.ok} source=${dl.source} filename=${dl.filename} bytes=${dl.bytes}`);
  console.log(`  path=${dl.path}`);
  console.log(`  耗时 ${ms} ms，最后进度 percent=${lastPercent}`);
  const diskSha1 = await downloader.sha1OfFile(dl.path);
  const onDisk = fs.statSync(dl.path).size;
  console.log(`  磁盘大小=${onDisk}  磁盘 sha1=${diskSha1}`);
  console.log(`  API sha1    =${smallest.files[0].sha1}`);
  check(dl.ok === true && fs.existsSync(dl.path), 'CurseForge 文件真实落盘');
  check(onDisk === smallest.files[0].size, '落盘大小与 API fileLength 一致');
  check(diskSha1 === smallest.files[0].sha1, '落盘 sha1 与 CurseForge hashes.algo=1 一致');
  check(dl.source === 'curseforge', '下载结果标了 source=curseforge');

  /* ----------------------------------------------------------- ③ 混合搜索 */
  section("③ source:'mixed' 搜索（fabulously optimized / modpack）");
  const keyword = 'fabulously optimized';
  const onlyCf = await api.search({ source: 'curseforge', projectType: 'modpack', query: keyword, limit: 10 });
  const onlyMr = await api.search({ source: 'modrinth', projectType: 'modpack', query: keyword, limit: 10 });
  const mixed = await api.search({ source: 'mixed', projectType: 'modpack', query: keyword, limit: 10 });
  console.log(`  只查 Modrinth  ：hits=${onlyMr.hits.length}  total=${onlyMr.total}`);
  console.log(`  只查 CurseForge：hits=${onlyCf.hits.length}  total=${onlyCf.total}`);
  console.log(`  混合（mixed）  ：hits=${mixed.hits.length}  total=${mixed.total}（两边 total 之和，近似值）`);
  console.log(`  去重掉         ：${mixed.deduped} 条（${onlyMr.hits.length} + ${onlyCf.hits.length} - ${mixed.hits.length}）`);
  console.log(`  两边都有「Fabulously Optimized」：Modrinth=${onlyMr.hits.some((h) => h.title === 'Fabulously Optimized')}  CurseForge=${onlyCf.hits.some((h) => h.title === 'Fabulously Optimized')}`);
  console.log('  合并后前 5 条（按 downloads 降序，带来源徽章）：');
  for (const h of mixed.hits.slice(0, 5)) {
    console.log(`    [${h.source.padEnd(10)}] ${String(h.downloads).padStart(10)}  ${h.title}`);
  }
  const dupTitles = mixed.hits.filter((h) => h.title === 'Fabulously Optimized');
  console.log(`  合并后「Fabulously Optimized」条数=${dupTitles.length}，保留来源=${dupTitles.map((d) => d.source).join(',')}`);
  check(mixed.source === 'mixed', '返回 source=mixed');
  check(mixed.deduped >= 1, '确实去重了（同名项目只留一条）', `deduped=${mixed.deduped}`);
  check(dupTitles.length === 1, '「Fabulously Optimized」只剩一条');
  check(dupTitles[0] && dupTitles[0].source === 'modrinth', '保留了下载量更高的那个（Modrinth 19,003,331 > CurseForge 8,150,090）');
  check(mixed.hits.every((h) => h.source === 'modrinth' || h.source === 'curseforge'), '每条都带 source 字段');
  const sortedDesc = mixed.hits.every((h, i) => i === 0 || mixed.hits[i - 1].downloads >= h.downloads);
  check(sortedDesc, '合并结果按 downloads 降序');
  check(
    !!mixed.breakdown && mixed.breakdown.modrinth.ok === true && mixed.breakdown.curseforge.ok === true,
    'breakdown 里两个源都 ok',
    JSON.stringify({ mr: mixed.breakdown.modrinth.total, cf: mixed.breakdown.curseforge.total })
  );

  /* -------------------------------------------------- ④ 五个 classId 都能用 */
  section('④ CurseForge 各分类 classId 实测（mod / modpack / resourcepack / shader / world / datapack）');
  const expectations = [
    ['mod', 6],
    ['modpack', 4471],
    ['resourcepack', 12],
    ['shader', 6552],
    ['world', 17],
    ['datapack', 6945],
  ];
  for (const [type, classId] of expectations) {
    const r = await api.searchCurseForge({ projectType: type, limit: 3 });
    const mapped = api.curseForgeClassId(type);
    console.log(`  ${type.padEnd(13)} classId=${String(classId).padStart(4)}（映射=${mapped}） hits=${r.hits.length} total=${r.total}`);
    if (r.hits[0]) console.log(`      示例：${r.hits[0].title}（id=${r.hits[0].id}，type=${r.hits[0].projectType}）`);
    check(mapped === classId, `${type} 的 classId 映射正确`);
    check(r.hits.length > 0, `${type} 能返回数据`, `${r.hits.length} 条`);
    check(r.hits.every((h) => h.title && h.id), `${type} 每条都有 title/id`);
  }

  /* ---------------------------------------------------- ⑤ 镜像挂掉的降级 */
  section('⑤ 镜像挂掉（base 换成不存在的域名 mod.mcimirror.invalid）');
  let netErr = null;
  try {
    await api.searchCurseForge({ projectType: 'modpack', limit: 2, curseforgeBase: BAD_BASE });
  } catch (err) {
    netErr = err;
  }
  console.log(`  searchCurseForge 抛出：code=${netErr && netErr.code}`);
  console.log(`  信息：${netErr && netErr.message}`);
  check(!!netErr, '确实抛错（不是静默返回空）');
  check(!!netErr && netErr.code === 'E_NETWORK', '错误码是 E_NETWORK（网络不通，不是 E_CONTENT_API）');
  check(!!netErr && /连不上 CurseForge 镜像/.test(netErr.message), '提示里点名「CurseForge 镜像」');
  check(!!netErr && /[\u4e00-\u9fa5]/.test(netErr.message), '错误信息是中文');

  let fileErr = null;
  try {
    await api.getCurseForgeFiles(atm.id, { curseforgeBase: BAD_BASE });
  } catch (err) {
    fileErr = err;
  }
  console.log(`  getCurseForgeFiles 抛出：code=${fileErr && fileErr.code}｜${fileErr && fileErr.message}`);
  check(!!fileErr && fileErr.code === 'E_NETWORK', '文件列表接口同样抛 E_NETWORK');

  // mixed 单边挂掉 → 保留另一边结果 + warning
  const degraded = await api.search({
    source: 'mixed',
    projectType: 'modpack',
    query: keyword,
    limit: 5,
    curseforgeBase: BAD_BASE,
  });
  console.log(`\n  mixed 单边挂掉：hits=${degraded.hits.length}（全部来自 ${degraded.hits[0] && degraded.hits[0].source}）`);
  console.log(`  breakdown.curseforge=${JSON.stringify(degraded.breakdown.curseforge).slice(0, 130)}`);
  console.log(`  warning=${String(degraded.warning).slice(0, 110)}…`);
  check(degraded.hits.length > 0, 'mixed 仍返回 Modrinth 结果（不整体失败）');
  check(degraded.breakdown.curseforge.ok === false && degraded.breakdown.curseforge.code === 'E_NETWORK', 'breakdown 标出 CurseForge 失败原因');
  check(/CurseForge 镜像暂时不可用/.test(String(degraded.warning)), '有中文 warning 提示');

  /* ------------------------------------------- ＋ 下载源清单 / mixed 下载回退 */
  section('＋ 杂项：content:sources 清单、mixed 下载自动回退 CurseForge');
  const sources = api.listSources();
  console.log(`  listSources() = ${JSON.stringify(sources)}`);
  check(sources.length === 3 && sources[0].id === 'mixed' && sources[1].id === 'modrinth' && sources[2].id === 'curseforge', '三个源且 mixed 在首位');
  check(sources.every((s) => s.name && s.desc), '每项都有中文 name/desc');

  // Modrinth 上不存在这个纯数字 id/版本 → mixed 应自动回退 CurseForge
  const mixedDl = await api.downloadTo(jeiModId, smallest.id, path.join(WORK, 'downloads-mixed'), { source: 'mixed' });
  console.log(`  mixed 下载（数字 id ${jeiModId} + 文件 ${smallest.id}）→ source=${mixedDl.source} bytes=${mixedDl.bytes}`);
  check(mixedDl.source === 'curseforge' && mixedDl.bytes === smallest.files[0].size, 'mixed 下载自动回退到 CurseForge 并成功');

  // 收藏要记住来源
  const home = path.join(WORK, 'home');
  fs.mkdirSync(home, { recursive: true });
  const fav = await api.addFavorite(home, atm);
  console.log(`  收藏 CurseForge 项目 → source=${fav.items[0].source}  title=${fav.items[0].title}`);
  check(fav.items[0].source === 'curseforge', '收藏项记住了 source=curseforge');

  /* ------------------------------------------------------------------ 收尾 */
  section('结果');
  console.log(`  失败项：${failures}`);
  if (failures > 0) {
    console.log('\n  ✗ 有检查项失败');
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ 全部检查项通过（全部为真实镜像 / 真实下载数据）');
  }
  // 清掉本次下载的大文件（保留目录结构无意义，实测输出已在上面）
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log('  已清理临时目录 build/.verify-curseforge');
  } catch (_) {
    /* 清理失败不影响结果 */
  }
}

main().catch((err) => {
  console.error('\n脚本本身出错：', err);
  process.exit(2);
});
