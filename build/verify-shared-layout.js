'use strict';
/**
 * 验证「迁移到共享布局后」完整性检查不会误报库/资源缺失。
 *
 * 场景：
 *   <test-home>/.minecraft/libraries   ← 共享
 *   <test-home>/.minecraft/assets      ← 共享
 *   <test-home>/instances/<id>/.minecraft/versions/<v>/{v.jar,v.json}   ← 实例私有
 *
 * 期望：checkGameFiles({..., home}) 报的 library / asset-index 缺失数应接近 0
 *      （迁移测试副本只拷了部分文件，所以允许少量缺失，但绝不能是「全部缺失」）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const gc = require(path.join(CORE, 'gamecheck.js'));
const paths = require(path.join(CORE, 'paths.js'));

const SRC = path.join(ROOT, '.e2e-home');
const DST = path.join(ROOT, '.migrate-test');

function copyVersionInto(instanceId, mcVersion) {
  const srcV = path.join(SRC, 'instances', instanceId, '.minecraft', 'versions', mcVersion);
  if (!fs.existsSync(srcV)) return false;
  const dstV = path.join(DST, 'instances', instanceId, '.minecraft', 'versions', mcVersion);
  fs.mkdirSync(path.dirname(dstV), { recursive: true });
  fs.cpSync(srcV, dstV, { recursive: true });
  return true;
}

async function main() {
  if (!fs.existsSync(DST)) {
    console.log('先跑 node build\\verify-migrate.js 建出测试副本');
    return;
  }

  console.log(`共享 libraries：${paths.sharedLibrariesDir(DST)}`);
  console.log(`共享 assets   ：${paths.sharedAssetsDir(DST)}`);
  console.log(`  存在吗：libraries=${fs.existsSync(paths.sharedLibrariesDir(DST))} assets=${fs.existsSync(paths.sharedAssetsDir(DST))}\n`);

  const instRoot = path.join(DST, 'instances');
  let tested = 0;

  for (const d of fs.readdirSync(instRoot)) {
    const ij = path.join(instRoot, d, 'instance.json');
    if (!fs.existsSync(ij)) continue;
    let instJson;
    try {
      instJson = JSON.parse(fs.readFileSync(ij, 'utf8'));
    } catch {
      continue;
    }
    const mc = String(instJson.mcVersion || '');
    if (!mc) continue;

    if (!copyVersionInto(d, mc)) continue;

    const vdir = path.join(instRoot, d, '.minecraft', 'versions', mc);
    const jf = path.join(vdir, `${mc}.json`);
    if (!fs.existsSync(jf)) continue;

    const raw = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const r = await gc.checkGameFiles({
      versionDir: vdir,
      versionId: mc,
      minecraftDir: path.join(instRoot, d, '.minecraft'),
      home: DST,
      resolved: raw,
      instance: instJson,
      settings: {}
    });

    const libMissing = r.missing.filter((m) => m.kind === 'library').length;
    const aiMissing = r.missing.filter((m) => m.kind === 'asset-index').length;
    const totalLibs = (raw.libraries || []).length;

    console.log(`═══ ${instJson.name || d}（${mc}）═══`);
    console.log(`  版本 JSON 声明库：${totalLibs} 个`);
    console.log(`  检查结果：library 缺失=${libMissing}  asset-index 缺失=${aiMissing}  corrupted=${r.corrupted.length}`);
    console.log(
      `  → ${
        libMissing === 0
          ? '✅ 一个都不缺（共享目录被正确读到）'
          : libMissing >= totalLibs && totalLibs > 0
            ? '❌ 全部报缺失（说明还在找旧路径）'
            : `⚠ 缺 ${libMissing} 个（迁移测试副本只拷了部分文件，正常）`
      }`
    );
    console.log('');
    tested += 1;
  }

  if (!tested) console.log('没有可测的版本');
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
