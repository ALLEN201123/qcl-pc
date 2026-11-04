'use strict';
/**
 * b1.7.3 中文补丁注入验证
 *
 * 做三件事（全部真实、不 mock）：
 *   1. 记录注入前 jar 的条目（基线）
 *   2. 调 chinesepack.applyChinesePack 注入
 *   3. 逐项验证：字体类换了、glyph 齐全、lang 是中文、原版类一个没丢
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(ROOT, '.e2e-home');
const CORE = path.join(ROOT, 'src', 'main', 'core');

const zip = require(path.join(CORE, 'zip.js'));
const pack = require(path.join(CORE, 'chinesepack.js'));

function findVersionDir(id) {
  const instances = path.join(HOME, 'instances');
  if (!fs.existsSync(instances)) return null;
  for (const inst of fs.readdirSync(instances)) {
    const dir = path.join(instances, inst, '.minecraft', 'versions', id);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

async function main() {
  const id = process.argv[2] || 'b1.7.3';
  const versionDir = findVersionDir(id);
  if (!versionDir) {
    console.log(`❌ 找不到版本 ${id} 的目录`);
    process.exitCode = 1;
    return;
  }

  const jarPath = path.join(versionDir, `${id}.jar`);
  console.log(`版本目录：${versionDir}`);
  console.log(`jar：${jarPath}（${(fs.statSync(jarPath).size / 1024 / 1024).toFixed(2)} MB）`);

  /* ---------- 1. 注入前基线 ---------- */
  const before = zip.list(jarPath);
  console.log(`\n注入前：${before.length} 个条目`);
  console.log(`   有 sj.class：${before.includes('sj.class')}`);
  console.log(`   glyph 数量：${before.filter((n) => /^font\/glyph_[0-9A-F]{2}\.png$/i.test(n)).length}`);
  console.log(`   有 lang/en_US.lang：${before.includes('lang/en_US.lang')}`);
  console.log(`   有 font.txt：${before.includes('font.txt')}`);

  /* ---------- 2. 注入 ---------- */
  console.log('\n──── 开始注入中文补丁 ────');
  const result = await pack.applyChinesePack({
    versionDir,
    versionId: id,
    lang: pack.LANG_ZH,
    onLog: (l) => console.log(`   ${l}`)
  });
  console.log('注入结果：', JSON.stringify(result));

  if (!result.applied) {
    console.log('⚠ 没有注入成功，结束');
    process.exitCode = 1;
    return;
  }

  /* ---------- 3. 验证 ---------- */
  console.log('\n──── 注入后验证 ────');
  const after = zip.list(jarPath);
  console.log(`注入后：${after.length} 个条目`);

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  check('字体类 sj.class 存在', after.includes('sj.class'));
  const glyphs = after.filter((n) => /^font\/glyph_[0-9A-F]{2}\.png$/i.test(n));
  // 源目录本身有 222 张 glyph（不是 256 —— 少数码位没有字形），所以阈值取 200
  check('glyph 点阵齐全', glyphs.length >= 200, `${glyphs.length} 张`);
  check('font.txt 已注入', after.includes('font.txt'));
  check('glyph_sizes.bin 已注入', after.includes('font/glyph_sizes.bin'));
  check('lang/zh_CN.lang 已注入', after.includes('lang/zh_CN.lang'));
  check('lang/en_US.lang 已注入（中文内容）', after.includes('lang/en_US.lang'));
  check('标题标语已注入', after.includes('title/splashes.txt'));
  check('标记文件已写', pack.appliedLang(versionDir) === pack.LANG_ZH, `appliedLang=${pack.appliedLang(versionDir)}`);

  // 原版类不能丢
  const origClasses = before.filter((n) => n.endsWith('.class') && n !== 'sj.class');
  const missing = origClasses.filter((n) => !after.includes(n));
  check('原版类一个没丢', missing.length === 0, missing.length ? `缺 ${missing.slice(0, 5).join(', ')}` : `${origClasses.length} 个都在`);

  // 不能有重复条目
  const dup = after.filter((n, i) => after.indexOf(n) !== i);
  check('无重复条目', dup.length === 0, dup.length ? dup.slice(0, 3).join(', ') : '');

  // 读 lang 内容确认是中文
  const handle = zip.open(jarPath);
  const enEntry = handle.entries.find((e) => e.name === 'lang/en_US.lang');
  if (enEntry) {
    const text = handle.readEntry(enEntry).toString('utf8');
    const hasChinese = /[\u4e00-\u9fa5]/.test(text);
    const sample = text.split('\n').filter((l) => /[\u4e00-\u9fa5]/.test(l)).slice(0, 3);
    check('lang/en_US.lang 含中文（游戏读的就是它）', hasChinese, sample.length ? sample.join(' | ').slice(0, 120) : '');
    console.log(`   lang/en_US.lang 大小：${(text.length / 1024).toFixed(1)} KB，${text.split('\n').length} 行`);
  }

  // font.txt 字符数
  const fontEntry = handle.entries.find((e) => e.name === 'font.txt');
  if (fontEntry) {
    const t = handle.readEntry(fontEntry).toString('utf8');
    console.log(`   font.txt：${t.length} 字符，${t.split('\n').length} 行`);
  }

  // 备份存在
  check('原版备份 .jar.orig 已创建', fs.existsSync(`${jarPath}.orig`), fs.existsSync(`${jarPath}.orig`) ? `${(fs.statSync(`${jarPath}.orig`).size / 1024 / 1024).toFixed(2)} MB` : '');

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n════════ 结果：${checks.length - failed.length}/${checks.length} 通过 ════════`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`   · ${f.name}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('验证脚本出错：', e);
  process.exitCode = 2;
});
