'use strict';
/**
 * 实测目录迁移：每实例的 libraries/assets → 共享目录
 *
 * 在**副本**上跑，不动真实数据。验证：
 *   ① 文件真的搬到 <home>/.minecraft/{libraries,assets}
 *   ② 重复文件被跳过（不重复占盘）
 *   ③ 旧的每实例目录被清理
 *   ④ 再跑一次是零开销（幂等）
 *   ⑤ 磁盘占用确实下降
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const migrate = require(path.join(CORE, 'migrate.js'));
const paths = require(path.join(CORE, 'paths.js'));

const SRC = path.join(ROOT, '.e2e-home');
const DST = path.join(ROOT, '.migrate-test');

function dirSize(dir) {
  let total = 0;
  let files = 0;
  if (!fs.existsSync(dir)) return { total, files };
  const walk = (d) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
          files += 1;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return { total, files };
}

function buildCopy() {
  fs.rmSync(DST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DST, 'instances'), { recursive: true });

  for (const d of fs.readdirSync(path.join(SRC, 'instances'))) {
    const from = path.join(SRC, 'instances', d);
    const to = path.join(DST, 'instances', d);
    fs.mkdirSync(to, { recursive: true });

    const j = path.join(from, 'instance.json');
    if (fs.existsSync(j)) fs.copyFileSync(j, path.join(to, 'instance.json'));

    // 拷 libraries 与 assets（这是被测对象）
    for (const sub of ['libraries', 'assets']) {
      const p = path.join(from, '.minecraft', sub);
      if (fs.existsSync(p)) {
        fs.cpSync(p, path.join(to, '.minecraft', sub), { recursive: true });
      }
    }
  }
}

async function main() {
  console.log('═══ 建测试副本 ═══');
  buildCopy();

  const before = {
    total: 0,
    oldLibs: 0,
    oldAssets: 0
  };
  const instDirs = fs.readdirSync(path.join(DST, 'instances'));
  for (const d of instDirs) {
    const mc = path.join(DST, 'instances', d, '.minecraft');
    before.oldLibs += dirSize(path.join(mc, 'libraries')).total;
    before.oldAssets += dirSize(path.join(mc, 'assets')).total;
  }
  before.total = before.oldLibs + before.oldAssets;
  console.log(`  旧布局占用：libraries ${(before.oldLibs / 1024 / 1024).toFixed(1)} MB + assets ${(before.oldAssets / 1024 / 1024).toFixed(1)} MB = ${(before.total / 1024 / 1024).toFixed(1)} MB`);

  console.log('\n═══ 执行迁移 ═══');
  const t0 = Date.now();
  const r = await migrate.migrateToSharedLayout({
    home: DST,
    onLog: (l) => console.log(`  [log] ${l}`)
  });
  const ms = Date.now() - t0;

  console.log(`\n  ran=${r.ran}  movedFiles=${r.movedFiles}  释放=${(r.freedBytes / 1024 / 1024).toFixed(1)} MB  用时=${ms} ms`);

  console.log('\n═══ 迁移后各目录 ═══');
  const sharedLib = dirSize(paths.sharedLibrariesDir(DST));
  const sharedAssets = dirSize(paths.sharedAssetsDir(DST));
  console.log(`  共享 libraries：${sharedLib.files} 个文件 / ${(sharedLib.total / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  共享 assets   ：${sharedAssets.files} 个文件 / ${(sharedAssets.total / 1024 / 1024).toFixed(1)} MB`);

  let leftover = 0;
  for (const d of fs.readdirSync(path.join(DST, 'instances'))) {
    const mc = path.join(DST, 'instances', d, '.minecraft');
    const l = dirSize(path.join(mc, 'libraries')).total;
    const a = dirSize(path.join(mc, 'assets')).total;
    leftover += l + a;
    if (l || a) console.log(`  ⚠ ${d} 还留着 libraries=${l} assets=${a}`);
  }
  console.log(`  实例目录残留：${(leftover / 1024 / 1024).toFixed(1)} MB（应为 0）`);

  const after = sharedLib.total + sharedAssets.total + leftover;
  console.log(`\n  迁移前总计：${(before.total / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  迁移后总计：${(after / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  → 节省 ${((before.total - after) / 1024 / 1024).toFixed(1)} MB`);

  console.log('\n═══ 幂等性（再跑一次）═══');
  const t1 = Date.now();
  const r2 = await migrate.migrateToSharedLayout({ home: DST, onLog: (l) => console.log(`  [log2] ${l}`) });
  console.log(`  ran=${r2.ran}  movedFiles=${r2.movedFiles}  用时=${Date.now() - t1} ms（应 <10ms 且 ran=false）`);

  console.log('\n═══ 强制重跑（绕过 marker）═══');
  const r3 = await migrate.migrateToSharedLayout({ home: DST, force: true, onLog: (l) => console.log(`  [log3] ${l}`) });
  console.log(`  movedFiles=${r3.movedFiles}（应为 0，说明没有可搬的了）`);

  console.log(`\n测试副本保留在：${DST}`);
  console.log('（确认无误后可手动删除）');
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
