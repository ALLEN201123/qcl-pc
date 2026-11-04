'use strict';
/**
 * 诊断 26.3 的 classpath：到底缺哪个 jar 导致 NoClassDefFoundError: net/minecraft/util/Unit
 *
 * 思路：
 *   1. 把 26.3 解析出的 classpath 全列出来
 *   2. 检查每个文件是否存在
 *   3. 在 26.3.jar 里找 Unit（应该在客户端 jar 里）
 *   4. 找齐所有「版本 JSON 里声明了但磁盘上没有」的库
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const HOME = path.join(os.homedir(), 'Documents', 'QCL');
const CORE = path.join(__dirname, '..', 'src', 'main', 'core');

const version = require(path.join(CORE, 'version.js'));
const libraries = require(path.join(CORE, 'libraries.js'));
const rules = require(path.join(CORE, 'rules.js'));
const zip = require(path.join(CORE, 'zip.js'));

const instDir = path.join(HOME, 'instances', 'mw2ee5w7-88c11ad3');
const mcDir = path.join(instDir, '.minecraft');
const vdir = path.join(mcDir, 'versions', '26.3');

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(vdir, '26.3.json'), 'utf8'));
  console.log(`版本 JSON：id=${raw.id}  mainClass=${raw.mainClass}`);
  console.log(`libraries 声明 ${(raw.libraries || []).length} 个\n`);

  const resolved = await version.resolve(raw, {
    fetchJson: async () => {
      throw new Error('不需要父版本');
    },
    features: {}
  });

  const osInfo = rules.currentOs();
  const libEntries = libraries.resolveLibraries(resolved, { osInfo, source: 'official' });

  console.log(`rules 过滤后 effective 库：${libEntries.length} 个\n`);

  const librariesDir = path.join(mcDir, 'libraries');
  let missing = 0;
  let present = 0;
  const missingList = [];

  for (const e of libEntries) {
    if (!e.hasArtifact && !e.isNative) continue;
    const rel = e.artifactPath;
    if (!rel) continue;
    const file = path.join(librariesDir, rel.split('/').join(path.sep));
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      present += 1;
    } else {
      missing += 1;
      missingList.push({ name: e.name || rel, rel });
    }
  }

  console.log(`磁盘上存在：${present} 个`);
  console.log(`缺失：${missing} 个`);
  if (missingList.length) {
    console.log('\n缺失清单（前 20）：');
    missingList.slice(0, 20).forEach((m, i) => console.log(`  ${i + 1}. ${m.name}`));
  }

  // 在客户端 jar 里找 Unit
  const jarPath = path.join(vdir, '26.3.jar');
  console.log(`\n在 26.3.jar 里找 net/minecraft/util/Unit.class …`);
  try {
    const entries = zip.list(jarPath);
    const hasUnit = entries.some((n) => n === 'net/minecraft/util/Unit.class');
    console.log(`  含 Unit.class：${hasUnit ? '✅ 是' : '❌ 否'}`);
    const mcClasses = entries.filter((n) => n.startsWith('net/minecraft/'));
    console.log(`  jar 里 net/minecraft/* 条目数：${mcClasses.length}`);
    if (!hasUnit && mcClasses.length > 0) {
      console.log('  样例：', mcClasses.slice(0, 5).join(', '));
    }
  } catch (err) {
    console.log(`  读 jar 失败：${err.message}`);
  }

  // classpath 实际拼出来是什么
  const cp = libraries.classpathList(resolved, { librariesDir, osInfo, source: 'official' });
  console.log(`\nclasspath 条目：${cp.length} 个`);
  console.log('  前 8 条：');
  cp.slice(0, 8).forEach((p) => console.log(`    ${path.basename(p)}`));

  // 客户端 jar 有没有进 classpath
  const hasClientJar = cp.some((p) => p.includes('26.3.jar'));
  console.log(`\nclasspath 里包含 26.3.jar：${hasClientJar ? '✅' : '❌（这就是 Unit 找不到的原因）'}`);
}

main().catch((e) => console.error('诊断失败：', e));
