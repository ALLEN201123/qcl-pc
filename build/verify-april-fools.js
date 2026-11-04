'use strict';
/*
 * 实测脚本：愚人节版本清单（src/main/core/mojang.js 的 aprilFoolsList）
 *
 * 运行：node build/verify-april-fools.js
 *
 * 验证点：
 *   ① 打印全部 12 个（id / foolTitle / releaseTime / source），默认新 → 旧；
 *   ② 9 个官方条目来自 manifest，且 url / sha1 / releaseTime 与原始 manifest 逐条一致 ——
 *      加入归档条目后**一个都没丢**；
 *   ③ 3 个 2.0 系列（red / blue / purple）来自**归档** legacy_version_archive.json，
 *      releaseTime 与归档里的 epoch 毫秒严格一致（1363773600000 / 001 / 002）；
 *   ④ 排序：desc = 26w14a … 2.0_purple，asc = 2.0_purple … 26w14a；
 *   ⑤ 结构归一：每条都有 id / type / url / releaseTime / time / sha1 / foolTitle / source，
 *      归档条目 sha1 为 null 而不是缺字段；
 *   ⑥ 为什么必须白名单：4 月 1 日还有正常版本（26.1.1），按日期筛会误伤；
 *   ⑦ IPC / preload 出口存在（versions:aprilFools）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const mojang = require(path.join(ROOT, 'src', 'main', 'core', 'mojang.js'));

const CACHE = path.join(__dirname, '.verify-aprilfools', 'meta');
const ARCHIVE = require(path.join(ROOT, 'src', 'main', 'core', 'data', 'legacy_version_archive.json'));

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ` — ${extra}` : ''}`);
}
function section(title) {
  console.log(`\n${'-'.repeat(78)}\n${title}\n${'-'.repeat(78)}`);
}

/** 归档里的原始条目（用来逐字段对照）。 */
function archiveEntry(id) {
  return ((ARCHIVE && ARCHIVE.entries) || []).find((e) => e && e.id === id) || null;
}

async function main() {
  console.log('='.repeat(78));
  console.log('愚人节版本清单实测（官方 manifest 9 + 内置归档 3 = 12）');
  console.log(`manifest: ${mojang.MANIFEST_URL}`);
  console.log(`archive : src/main/core/data/legacy_version_archive.json（${(ARCHIVE.entries || []).length} 条）`);
  console.log('='.repeat(78));

  /* ------------------------------------------------ ① 打印全部 12 个 */
  section('① 实际返回的 12 个愚人节版本（按 releaseTime 新 → 旧）');
  const list = await mojang.aprilFoolsList({ cacheDir: CACHE });
  console.log(`  ${'id'.padEnd(22)} ${'source'.padEnd(9)} ${'releaseTime'.padEnd(26)} foolTitle`);
  for (const v of list) {
    console.log(`  ${v.id.padEnd(22)} ${String(v.source).padEnd(9)} ${String(v.releaseTime).padEnd(26)} ${v.foolTitle}`);
  }
  const manifestItems = list.filter((v) => v.source === 'manifest');
  const archiveItems = list.filter((v) => v.source === 'archive');
  console.log(`\n  ★ 总数=${list.length}（manifest ${manifestItems.length} + archive ${archiveItems.length}）`);

  /* -------------------------------------------------- ② 9 个官方没有丢 */
  section('② 9 个官方条目（manifest）逐条与原始 manifest 对照');
  const raw = await fetch(mojang.MANIFEST_URL).then((r) => r.json());
  console.log(`  原始 manifest 共 ${raw.versions.length} 条（快照 ${raw.versions.filter((v) => v.type === 'snapshot').length} 条）`);
  const OFFICIAL_IDS = mojang.APRIL_FOOLS.filter((f) => f.source === 'manifest').map((f) => f.id);
  console.log(`  白名单官方 id：${OFFICIAL_IDS.join(' / ')}`);
  let mismatch = 0;
  for (const v of manifestItems) {
    const origin = raw.versions.find((x) => x.id === v.id);
    if (!origin) {
      mismatch += 1;
      console.log(`    [缺失] ${v.id} 不在原始 manifest 里`);
      continue;
    }
    // releaseTime 字符串格式不同（manifest "+00:00" vs 我们 ".000Z"），按时间戳比
    const sameTime = Date.parse(origin.releaseTime) === Date.parse(v.releaseTime);
    if (origin.url !== v.url || origin.sha1 !== v.sha1 || !sameTime) {
      mismatch += 1;
      console.log(`    [差异] ${v.id}: manifest ${origin.releaseTime}/${origin.sha1} vs 返回 ${v.releaseTime}/${v.sha1}`);
    }
  }
  check(manifestItems.length === 9, '官方条目还是 9 个（没因为加归档而丢失）', `${manifestItems.length} 个`);
  check(
    OFFICIAL_IDS.every((id) => manifestItems.some((v) => v.id === id)),
    '白名单里的 9 个官方 id 全部返回',
  );
  check(mismatch === 0, '9 个官方的 url / sha1 / releaseTime 与原始 manifest 一致', `差异 ${mismatch} 条`);

  /* ---------------------------------------- ③ 3 个 2.0 来自归档且时间正确 */
  section('③ 3 个 Minecraft 2.0 系列（只能来自归档 legacy_version_archive.json）');
  const EXPECTED_ARCHIVE = [
    ['2.0_purple', 1363773600000, '2013 愚人节：Minecraft 2.0（紫色版）'],
    ['2.0_red', 1363773601000, '2013 愚人节：Minecraft 2.0（红色版）'],
    ['2.0_blue', 1363773602000, '2013 愚人节：Minecraft 2.0（蓝色版）'],
  ];
  let archiveBad = 0;
  for (const [id, epoch, title] of EXPECTED_ARCHIVE) {
    const item = archiveItems.find((v) => v.id === id);
    const origin = archiveEntry(id);
    if (!origin) {
      archiveBad += 1;
      console.log(`  ✗ ${id} 归档里没有这条（脚本预期错误）`);
      continue;
    }
    const expectedIso = new Date(origin.releaseTime).toISOString();
    console.log(`  ${id}`);
    console.log(`    返回   ：source=${item && item.source} releaseTime=${item && item.releaseTime} sha1=${item && item.sha1}`);
    console.log(`    归档原始：releaseTime=${origin.releaseTime}（${expectedIso}）category=${origin.category} officialId=${origin.officialId}`);
    console.log(`    url    ：${item && item.url}`);
    console.log(`    foolTitle：${item && item.foolTitle}`);
    const ok =
      !!item &&
      item.source === 'archive' &&
      Date.parse(item.releaseTime) === epoch &&
      Date.parse(item.releaseTime) === Number(origin.releaseTime) &&
      item.url === (origin.url || origin.infoUrl) &&
      item.sha1 === null &&
      item.foolTitle === title;
    if (!ok) archiveBad += 1;
    check(ok, `${id}：来自归档、releaseTime=${epoch}、url/sha1/foolTitle 正确`);
  }
  check(archiveItems.length === 3, '归档条目正好 3 个', `${archiveItems.length} 个`);
  check(new Set(archiveItems.map((v) => v.id)).size === 3, '三个归档 id 互不重复');
  check(archiveItems.every((v) => v.type === 'snapshot'), '归档条目 type 统一归一成 snapshot');
  check(archiveItems.every((v) => v.sha1 === null), '归档条目没有 sha1 → 返回 null（字段存在，不是缺字段）');
  check(archiveBad === 0, '3 个 2.0 系列的检查全部通过');

  /* --------------------------------------------------------- ④ 排序验证 */
  section('④ 排序（默认新 → 旧，order:asc 最早 → 最新）');
  const sortedDesc = list.every((v, i) => i === 0 || Date.parse(list[i - 1].releaseTime) >= Date.parse(v.releaseTime));
  console.log(`  desc 首条=${list[0].id}  末条=${list[list.length - 1].id}`);
  check(sortedDesc, '默认按 releaseTime 降序');
  check(list[0].id === '26w14a', 'desc 首条是最新的 26w14a');
  check(list[list.length - 1].id === '2.0_purple', 'desc 末条是最老的 2.0_purple（2013）');
  const asc = await mojang.aprilFoolsList({ cacheDir: CACHE, order: 'asc' });
  console.log(`  asc  首条=${asc[0].id}  末条=${asc[asc.length - 1].id}`);
  check(asc[0].id === '2.0_purple' && asc[asc.length - 1].id === '26w14a', "order:'asc' 时 2013 → 2026");
  check(asc.length === 12, 'asc 也是 12 条');

  /* ------------------------------------------------- ⑤ 结构归一与完整性 */
  section('⑤ 结构归一：12 条字段齐全');
  const REQUIRED = ['id', 'type', 'url', 'releaseTime', 'time', 'sha1', 'foolTitle', 'source'];
  const missingField = [];
  for (const v of list) {
    for (const key of REQUIRED) {
      if (!(key in v)) missingField.push(`${v.id}.${key}`);
    }
  }
  check(missingField.length === 0, '每条都含 id/type/url/releaseTime/time/sha1/foolTitle/source', missingField.join(','));
  check(list.every((v) => v.id && v.foolTitle && v.releaseTime && v.source), 'id/foolTitle/releaseTime/source 都非空');
  check(list.every((v) => v.source === 'manifest' || v.source === 'archive'), 'source 只有 manifest / archive 两种');
  check(list.every((v) => /[\u4e00-\u9fa5]/.test(v.foolTitle)), '每条 foolTitle 都是中文');
  const THREE_TITLES = ['2013 愚人节：Minecraft 2.0（红色版）', '2013 愚人节：Minecraft 2.0（蓝色版）', '2013 愚人节：Minecraft 2.0（紫色版）'];
  check(THREE_TITLES.every((t) => list.some((v) => v.foolTitle === t)), '2.0 三个 foolTitle 与需求文案完全一致');

  /* --------------------------------------- ⑥ 为什么必须白名单（同日正常版本） */
  section('⑥ 官方 manifest 里同样发布于 4 月 1 日、但不是愚人节版本的条目');
  const ids = new Set(list.map((v) => v.id));
  const sameDay = raw.versions.filter((v) => /-04-01T/.test(v.releaseTime) && !ids.has(v.id));
  for (const v of sameDay) console.log(`  · ${v.id}（${v.type}，${v.releaseTime}）`);
  check(sameDay.length > 0, '确实存在同日正常版本 ⇒ 只能按 id 精确白名单（2.0 系列还得单独走归档）');

  /* ------------------------------------------------------ ⑦ IPC 出口 */
  section('⑦ IPC 出口（versions:aprilFools）');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/index.js'), 'utf8');
  const hasHandler = /'versions:aprilFools':\s*async/.test(ipcSrc) && ipcSrc.includes('aprilFoolsList(');
  console.log(`  ipc.js 注册 'versions:aprilFools' 并调用 aprilFoolsList：${hasHandler}`);
  check(hasHandler, '有 versions:aprilFools 通道');
  const m = preloadSrc.match(/const INVOKE_RE = \/\^\(([^)]+)\):\[A-Za-z\]\+\$\/;/);
  const invokeRe = m ? new RegExp(`^(${m[1]}):[A-Za-z]+$`) : null;
  check(!!invokeRe && invokeRe.test('versions:aprilFools') === true, 'preload 放行 versions:aprilFools');

  /* ------------------------------------------------------------ 收尾 */
  section('结果');
  console.log(`  失败项：${failures}`);
  if (failures) {
    console.log('\n  ✗ 有检查项失败');
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ 全部检查项通过（9 官方 + 3 归档 = 12）');
  }
}

main().catch((err) => {
  console.error('脚本本身出错：', err);
  process.exit(2);
});
