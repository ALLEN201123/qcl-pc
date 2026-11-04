'use strict';
/**
 * 检查「打包进 asar 的 home.js」是不是修复后的版本。
 *
 * 为什么需要：源码改对了不等于打包版对了 —— asar 里可能是旧的。
 * 这个脚本用 electron-builder 自带的 @electron/asar 读包，把 home.js 抽出来逐项比对。
 *
 * 用法：node build\check-asar.js
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

function main() {
  if (!fs.existsSync(ASAR)) {
    console.error(`找不到 ${ASAR}\n先跑一次 npm run pack`);
    process.exit(1);
  }

  let asar;
  try {
    asar = require('@electron/asar');
  } catch (err) {
    console.error('需要 @electron/asar（electron-builder 的依赖）:', err.message);
    process.exit(1);
  }

  const target = 'src/renderer/js/pages/home.js';
  let text;
  try {
    text = asar.extractFile(ASAR, target).toString('utf8');
  } catch (err) {
    console.error(`从 asar 抽取 ${target} 失败：`, err.message);
    process.exit(1);
  }

  console.log(`从 asar 读出 home.js：${text.length} 字符\n`);

  const checks = [];
  const check = (name, ok, extra) => {
    checks.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `\n      实际：${extra}` : ''}`);
  };

  // 1. ◀ 的禁用条件：index <= 0
  const prevBtn = /id="announce-prev"[^>]*>/.exec(text);
  check(
    '◀ 在 index<=0（已是最新）时禁用',
    !!prevBtn && /index\s*<=\s*0/.test(prevBtn[0]),
    prevBtn ? prevBtn[0].replace(/\s+/g, ' ').slice(0, 130) : '找不到按钮'
  );

  // 2. ▶ 的禁用条件：index >= total-1
  const nextBtn = /id="announce-next"[^>]*>/.exec(text);
  check(
    '▶ 在 index>=total-1（已是最旧）时禁用',
    !!nextBtn && /index\s*>=\s*total\s*-\s*1/.test(nextBtn[0]),
    nextBtn ? nextBtn[0].replace(/\s+/g, ' ').slice(0, 130) : '找不到按钮'
  );

  // 3. ◀ 点击 = index - 1
  check(
    '◀ 点击执行 index = max(0, index-1)',
    /announce-prev[\s\S]{0,500}?index\s*=\s*Math\.max\(\s*0\s*,\s*index\s*-\s*1\s*\)/.test(text)
  );

  // 4. ▶ 点击 = index + 1
  check(
    '▶ 点击执行 index = min(total-1, index+1)',
    /announce-next[\s\S]{0,500}?index\s*=\s*Math\.min\(\s*total\s*-\s*1\s*,\s*index\s*\+\s*1\s*\)/.test(text)
  );

  // 5. 公告数据有 3 条
  let titles = 0;
  try {
    const mock = asar.extractFile(ASAR, 'src/renderer/js/mock.js').toString('utf8');
    const block = mock.slice(mock.indexOf('export const ANNOUNCEMENTS'));
    titles = (block.slice(0, block.indexOf('\n];')).match(/^\s{4}title: /gm) || []).length;
  } catch {
    titles = -1;
  }
  check(`mock.js 里有 3 条公告`, titles === 3, `实际 ${titles} 条`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n════════ ${checks.length - failed.length}/${checks.length} 通过 ════════`);
  if (failed.length) {
    console.log('❌ 打包进去的不是修复版，需要重新打包');
    process.exitCode = 1;
  } else {
    console.log('✅ 打包版里是修复后的翻页逻辑');
  }
}

main();
