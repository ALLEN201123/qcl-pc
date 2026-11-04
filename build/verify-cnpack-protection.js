'use strict';
/**
 * 验证「中文补丁保护」：能否从文件系统识别出已打补丁的版本。
 *
 * 背景：instance.json 里的 chinesePack / notCheckGameFiles 可能为空（旧版装的、手动打的），
 * 那时新的客户端 jar sha1 校验会把补丁 jar 判成损坏并重下覆盖 → 补丁被抹。
 * 所以必须能直接看文件判断。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const gc = require(path.join(CORE, 'gamecheck.js'));
const instances = require(path.join(CORE, 'instances.js'));

const HOMES = ['.e2e-home', '.skin-test-home', '.skin-btn-test'].map((h) => path.join(ROOT, h));

async function main() {
  for (const HOME of HOMES) {
    if (!fs.existsSync(HOME)) continue;
    let list = [];
    try {
      list = await instances.list(HOME);
    } catch {
      continue;
    }
    console.log(`\n═══ ${path.basename(HOME)} ═══`);

    for (const inst of list) {
      const vdir = path.join(inst.dir, '.minecraft', 'versions');
      if (!fs.existsSync(vdir)) continue;
      for (const v of fs.readdirSync(vdir)) {
        const dir = path.join(vdir, v);
        if (!fs.statSync(dir).isDirectory()) continue;

        const det = gc.detectAppliedChinesePack(dir, v);
        // 交叉验证：instance.json 里记了什么
        const byField = !!(inst.chinesePack && inst.chinesePack.applied) || inst.notCheckGameFiles === true;

        const verdict =
          det.patched && !byField
            ? '★ 只有文件判据能救（字段是空的）'
            : det.patched && byField
              ? '字段 + 文件都命中'
              : !det.patched && !byField
                ? '未打补丁'
                : '⚠ 字段说有、文件说没有';

        console.log(
          `  ${String(v).padEnd(14)} 文件判据=${det.patched ? '是' : '否'}  instance字段=${byField ? '是' : '否'}  → ${verdict}`
        );
        if (det.reason) console.log(`                 理由：${det.reason}`);
      }
    }
  }
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
