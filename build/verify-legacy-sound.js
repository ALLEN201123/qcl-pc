'use strict';
/**
 * 验证「远古版本没音效」的修复。
 *
 * 修复前：resources/ 有 10 个顶层项但 0 个 .ogg（因为 dirHasFiles 看到 README 就跳过）
 * 修复后：应该铺出几百个资源文件，其中有大量 .ogg
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(ROOT, '.e2e-home');

const assets = require(path.join(CORE, 'assets.js'));
const instances = require(path.join(CORE, 'instances.js'));

function countOgg(dir, limit = 100000) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 6 || n >= limit) return;
    let list;
    try {
      list = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const x of list) {
      const p = path.join(d, x);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(ogg|mus)$/i.test(x)) n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

function countFiles(dir, limit = 100000) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 6 || n >= limit) return;
    let list;
    try {
      list = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const x of list) {
      const p = path.join(d, x);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

async function main() {
  const list = await instances.list(HOME);
  console.log(`实例：${list.map((x) => x.mcVersion).join(', ')}\n`);

  for (const inst of list) {
    // 只测有 legacy 索引的（远古版本）
    const base = path.join(INSTANCE_ASSETS(inst), 'indexes');
    if (!fs.existsSync(base)) continue;

    for (const f of fs.readdirSync(base)) {
      const idxId = f.replace(/\.json$/, '');
      const idx = assets.loadIndex(INSTANCE_ASSETS(inst), idxId);
      if (!idx) continue;
      if (!idx.virtual && !idx.map_to_resources) continue;

      const resDir = path.join(inst.dir, '.minecraft', 'resources');
      const before = fs.existsSync(resDir) ? countFiles(resDir) : 0;
      const beforeOgg = fs.existsSync(resDir) ? countOgg(resDir) : 0;

      console.log(`═══ ${inst.name}（${inst.mcVersion}）索引 ${idxId} ═══`);
      console.log(`  virtual=${!!idx.virtual}  map_to_resources=${!!idx.map_to_resources}  对象=${Object.keys(idx.objects || {}).length}`);
      console.log(`  修复前：resources/ 共 ${before} 个文件，其中 .ogg/.mus ${beforeOgg} 个`);

      const r = await assets.reconstruct(INSTANCE_ASSETS(inst), idxId, idx, {
        onLog: (l) => console.log(`  [log] ${l}`)
      });

      const after = fs.existsSync(resDir) ? countFiles(resDir) : 0;
      const afterOgg = fs.existsSync(resDir) ? countOgg(resDir) : 0;
      console.log(`  复制结果：copied=${r.copied}  missing=${r.missing}  目标=${(r.targets || []).join('、')}`);
      console.log(`  修复后：resources/ 共 ${after} 个文件，其中 .ogg/.mus ${afterOgg} 个`);
      console.log(`  → ${afterOgg > 0 ? '✅ 有音效了' : '❌ 仍然没有音效'}`);
      console.log('');

      // 再跑一次验证幂等（不应重复复制）
      const r2 = await assets.reconstruct(INSTANCE_ASSETS(inst), idxId, idx, {});
      console.log(`  幂等复跑：copied=${r2.copied}（应为 0）`);
      console.log('');
    }
  }
}

function INSTANCE_ASSETS(inst) {
  // 与 launch.js 的 paths.assetsDir(home, instance.id) 保持一致
  const paths = require(path.join(CORE, 'paths.js'));
  return paths.assetsDir(HOME, inst.id);
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
