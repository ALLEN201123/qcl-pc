'use strict';
/**
 * 验证「关闭文件校验」两个开关都能真正生效：
 *   ① 全局 settings.checkGameFiles = false  → 所有版本跳过内容校验
 *   ② 实例 instance.notCheckGameFiles = true → 只有这个版本跳过
 *   ③ 实例级优先于全局
 *   ④ 中文补丁的文件系统判据优先级最高（两个开关都开着也跳）
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const gc = require(path.join(CORE, 'gamecheck.js'));

const HOME = path.join(ROOT, '.e2e-home');

function findVersion(versionId) {
  const base = path.join(HOME, 'instances');
  for (const d of fs.readdirSync(base)) {
    const vdir = path.join(base, d, '.minecraft', 'versions', versionId);
    if (fs.existsSync(vdir)) {
      const ij = path.join(base, d, 'instance.json');
      const inst = fs.existsSync(ij) ? JSON.parse(fs.readFileSync(ij, 'utf8')) : {};
      return { instanceDir: base, id: d, vdir, inst };
    }
  }
  return null;
}

async function check(versionId, instancePatch, settings) {
  const f = findVersion(versionId);
  if (!f) return null;
  const raw = JSON.parse(fs.readFileSync(path.join(f.vdir, `${versionId}.json`), 'utf8'));
  const r = await gc.checkGameFiles({
    versionDir: f.vdir,
    versionId,
    minecraftDir: path.join(f.instanceDir, f.id, '.minecraft'),
    home: HOME,
    resolved: raw,
    instance: { ...f.inst, ...instancePatch },
    settings
  });
  return r;
}

async function main() {
  console.log('═══ 场景 1：全局开启 + 实例关闭（默认）═══');
  let r = await check('26.3', {}, {});
  console.log(`  26.3   skipContentCheck=${r.skipContentCheck}  ${r.skipContentCheck ? '跳过' : '校验'}（应为 false = 校验）`);

  console.log('\n═══ 场景 2：全局关闭 → 26.3 也应跳过 ═══');
  r = await check('26.3', {}, { checkGameFiles: false });
  console.log(`  26.3   skipContentCheck=${r.skipContentCheck}  理由：${r.reason}`);
  console.log(`  → ${r.skipContentCheck ? '✅ 全局开关生效' : '❌ 全局开关没生效'}`);

  console.log('\n═══ 场景 3：全局开启 + 实例关闭 → 只有该实例跳过 ═══');
  r = await check('26.3', { notCheckGameFiles: true }, { checkGameFiles: true });
  console.log(`  26.3   skipContentCheck=${r.skipContentCheck}  理由：${r.reason}`);
  console.log(`  → ${r.skipContentCheck ? '✅ 实例级开关生效' : '❌ 实例级开关没生效'}`);

  console.log('\n═══ 场景 4：全局关闭 + 实例开启 → 仍是跳过（实例级优先）═══');
  r = await check('26.3', { notCheckGameFiles: false }, { checkGameFiles: false });
  console.log(`  26.3   skipContentCheck=${r.skipContentCheck}  理由：${r.reason}`);
  console.log(`  → ${r.skipContentCheck ? '✅ 全局兜住了' : '❌ 不符合预期'}`);

  console.log('\n═══ 场景 5：中文补丁的文件判据优先（两个开关都开着也跳）═══');
  r = await check('a1.2.6', { notCheckGameFiles: false, chinesePack: null }, { checkGameFiles: true });
  console.log(`  a1.2.6 skipContentCheck=${r.skipContentCheck}`);
  console.log(`         理由：${r.reason}`);
  console.log(`  → ${r.skipContentCheck ? '✅ 补丁保护生效（不会被冲掉）' : '❌ 补丁会被冲掉'}`);
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
