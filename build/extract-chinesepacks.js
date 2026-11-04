'use strict';
/**
 * 从安卓版 LegacyChinesePack.java 提取完整的中文补丁规则表 → JSON
 *
 * 解析两个表：
 *   · B19_PACKS   （b1.9 各 pre 版，混淆名各不相同）
 *   · EXTRA_PACKS （alpha / beta / infdev / indev / classic 全系）
 *
 * 输出：src/main/core/data/chinese-packs.json
 *
 * Java 正则 → JS 正则的转换：把 `\\.` 还原成 `\.`，更安全。
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = process.argv[2] || 'D:\\QCL-build\\QCL\\src\\main\\java\\com\\qcl\\launcher\\launcher\\download\\game\\LegacyChinesePack.java';
const OUT = path.join(__dirname, '..', 'src', 'main', 'core', 'data', 'chinese-packs.json');

/** 把 Java 源码里的 "..." 字符串反转义成真实值 */
function unescapeJava(s) {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** 从一段 Java 源码里抽出 { "regex", "dir", "class" } 三元组 */
function extractTriples(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 跳过纯注释行
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // 匹配 {"...", "...", "..."}
    const m = trimmed.match(/\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}/);
    if (!m) continue;
    out.push({
      regex: unescapeJava(m[1]),
      dir: unescapeJava(m[2]),
      fontClass: unescapeJava(m[3])
    });
  }
  return out;
}

/** 从源码里截取某个 `static final String[][] NAME = { ... };` 整块 */
function extractTable(src, name) {
  const startRe = new RegExp(`static\\s+final\\s+String\\[\\]\\[\\]\\s+${name}\\s*=\\s*\\{`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  const start = startMatch.index;
  // 从 { 开始做花括号配对，找到结束
  let depth = 0;
  let i = src.indexOf('{', start);
  const begin = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(begin, i + 1);
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到源文件：${SRC}`);
    process.exit(1);
  }
  const src = fs.readFileSync(SRC, 'utf8');

  const b19 = extractTable(src, 'B19_PACKS');
  const extra = extractTable(src, 'EXTRA_PACKS');
  if (!b19) console.warn('⚠ 没找到 B19_PACKS');
  if (!extra) console.warn('⚠ 没找到 EXTRA_PACKS');

  const b19List = b19 ? extractTriples(b19) : [];
  const extraList = extra ? extractTriples(extra) : [];

  // 校验每个 dir 在 assets 里是否真实存在
  const assetsDir = path.join('D:\\QCL-build\\QCL\\src\\main\\assets');
  const missing = [];
  for (const item of [...b19List, ...extraList]) {
    if (!fs.existsSync(path.join(assetsDir, item.dir))) missing.push(item.dir);
  }

  // 去重（同一个 dir 可能被多条规则引用，比如 cn_b13 / cn_b14）
  const dirs = [...new Set([...b19List, ...extraList].map((x) => x.dir))];

  const data = {
    _comment:
      '从安卓版 LegacyChinesePack.java 抽取的中文补丁规则表。' +
      'regex 匹配版本 id；dir 是补丁资源目录（src/main/core/data/<dir>/）；' +
      'fontClass 是该版本自己的 FontRenderer 混淆名（可能是简单名如 sj，也可能是完整路径 com/mojang/minecraft/b/h）。',
    generatedAt: new Date().toISOString(),
    source: SRC,
    b19: b19List,
    extra: extraList,
    dirs
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');

  console.log(`已写出 ${OUT}`);
  console.log(`   B19_PACKS   : ${b19List.length} 条`);
  console.log(`   EXTRA_PACKS : ${extraList.length} 条`);
  console.log(`   合计        : ${b19List.length + extraList.length} 条规则`);
  console.log(`   涉及的资源目录: ${dirs.length} 个`);
  if (missing.length) {
    console.log(`   ⚠ 有 ${missing.length} 个目录在 assets 里不存在：${missing.join(', ')}`);
  } else {
    console.log('   ✅ 所有资源目录都存在');
  }

  // 打印前 6 条样例，方便核对
  console.log('\n样例（前 6 条）：');
  for (const x of [...b19List, ...extraList].slice(0, 6)) {
    console.log(`   /${x.regex}/  →  ${x.dir}  (fontRenderer=${x.fontClass})`);
  }
}

main();
