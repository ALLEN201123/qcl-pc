'use strict';
/**
 * 中文补丁 · 批量验证（76 条规则全覆盖）
 *
 * 按安卓版的**真实结构**校验：
 *   · 每个 cn_* 目录只放该版本自己的 FontRenderer 类
 *   · font.txt / glyph_*.png / lang / splashes 来自主包 cn_b173
 *
 * 对每条规则验证：
 *   1. 正则可编译
 *   2. 补丁目录存在且有 .class
 *   3. 规则写的 FontRenderer 能在目录里找到（找不到就报）
 *   4. buildPatchEntries 能组装出完整条目（含字体类 + font.txt + glyph + lang）
 *   5. 组装出的条目里类名与规则一致
 *
 * 用法：node build\verify-chinesepacks-all.js [-v]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'main', 'core', 'data');
const BASE_PACK = 'cn_b173';
const pack = require(path.join(ROOT, 'src', 'main', 'core', 'chinesepack.js'));

/** 列出目录下全部文件（相对路径） */
function walk(dir, prefix = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function main() {
  const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'chinese-packs.json'), 'utf8'));
  const all = [
    ...(raw.b19 || []).map((x) => ({ ...x, group: 'b1.9' })),
    ...(raw.extra || []).map((x) => ({ ...x, group: 'extra' }))
  ];

  console.log(`中文补丁批量验证：${all.length} 条规则\n`);

  // 主包自检
  const baseDir = path.join(DATA, BASE_PACK);
  const baseFiles = walk(baseDir);
  console.log(`主包 ${BASE_PACK}：${baseFiles.length} 个文件`);
  const baseHas = {
    lang: baseFiles.some((f) => /^lang\/zh_cn\.lang$/i.test(f)),
    fontTxt: baseFiles.some((f) => /^font\.txt$/i.test(f)),
    glyph: baseFiles.filter((f) => /glyph_[0-9a-f]{2}\.png$/i.test(f)).length,
    splashes: baseFiles.some((f) => /^title\/splashes\.txt$/i.test(f))
  };
  console.log(`   lang/zh_CN.lang: ${baseHas.lang ? '✅' : '❌'}`);
  console.log(`   font.txt: ${baseHas.fontTxt ? '✅' : '❌'}`);
  console.log(`   glyph 点阵: ${baseHas.glyph} 张 ${baseHas.glyph > 200 ? '✅' : '❌'}`);
  console.log(`   title/splashes.txt: ${baseHas.splashes ? '✅' : '❌'}\n`);

  if (!baseHas.lang || !baseHas.fontTxt || baseHas.glyph < 200) {
    console.log('❌ 主包资源不完整，后续验证没有意义');
    process.exitCode = 1;
    return;
  }

  let pass = 0;
  const problems = [];

  for (const r of all) {
    const label = `${r.group}/${r.dir}`;
    const issues = [];

    // 1. 正则
    let regex = null;
    try {
      regex = new RegExp(r.regex);
    } catch (err) {
      issues.push(`正则编译失败：${err.message}`);
    }

    // 2. 目录与类文件
    const dir = path.join(DATA, r.dir);
    if (!fs.existsSync(dir)) {
      issues.push('补丁目录不存在');
    } else {
      const files = walk(dir);
      const classes = files.filter((f) => f.endsWith('.class'));
      if (classes.length === 0) issues.push('补丁目录里没有 .class');

      // 3. FontRenderer 名字对得上吗
      const wantFull = `${r.fontClass}.class`;
      const wantSimple = `${r.fontClass.split('/').pop()}.class`;
      const hit =
        classes.find((c) => c.toLowerCase() === wantFull.toLowerCase()) ||
        classes.find((c) => c.toLowerCase() === wantSimple.toLowerCase()) ||
        classes.find((c) => c.toLowerCase().endsWith(`/${wantSimple.toLowerCase()}`));
      if (!hit && classes.length) {
        issues.push(`规则写 ${r.fontClass}，但目录里是 ${classes.join(', ')}`);
      }

      // 4. 能否组装（真实调用 buildPatchEntries）
      if (regex) {
        try {
          const rule = {
            regex,
            idle: r.regex,
            dir: r.dir,
            fontClass: r.fontClass,
            isFullPath: r.fontClass.includes('/')
          };
          const entries = pack.buildPatchEntries(dir, rule, pack.LANG_ZH);
          const names = entries.map((e) => e.name.toLowerCase());
          if (!names.some((n) => n.endsWith('.class'))) issues.push('组装结果里没有类文件');
          if (!names.includes('font.txt')) issues.push('组装结果缺 font.txt');
          if (!names.some((n) => /^font\/glyph_[0-9a-f]{2}\.png$/.test(n))) issues.push('组装结果缺 glyph');
          if (!names.includes('lang/en_us.lang')) issues.push('组装结果缺 lang/en_US.lang');
          // 类名必须是规则指定的那个
          const clsEntry = entries.find((e) => e.name.toLowerCase() === wantSimple.toLowerCase() ||
                                                e.name.toLowerCase() === wantFull.toLowerCase());
          if (!clsEntry) issues.push(`组装结果里没有字体类 ${r.fontClass}`);
          if (verbose && issues.length === 0) {
            console.log(`✅ ${label}  类=${clsEntry ? clsEntry.name : '?'}  条目=${entries.length}`);
          }
        } catch (err) {
          issues.push(`组装失败：${err.message}`);
        }
      }
    }

    if (issues.length === 0) pass += 1;
    else {
      problems.push({ label, dir: r.dir, issues, regex: r.regex });
      console.log(`⚠ ${label}  /${r.regex}/`);
      for (const i of issues) console.log(`     · ${i}`);
    }
  }

  console.log(`\n════════ 结果：${pass}/${all.length} 条规则完全通过 ════════`);
  if (problems.length) {
    const byType = new Map();
    for (const p of problems) {
      for (const i of p.issues) {
        const k = i.split('：')[0].split('，')[0];
        if (!byType.has(k)) byType.set(k, []);
        byType.get(k).push(p.dir);
      }
    }
    console.log('\n按问题类型汇总：');
    for (const [k, v] of byType) {
      console.log(`   ${k}：${v.length} 个（${v.slice(0, 8).join(', ')}${v.length > 8 ? '…' : ''}）`);
    }
    process.exitCode = 1;
  } else {
    console.log('✅ 全部规则都有完整可用的补丁资源');
  }
}

main();
