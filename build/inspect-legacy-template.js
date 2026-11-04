'use strict';
/** 查看远古版本启动模板的结构（按出现位置替换占位符，保证仍是合法 JSON） */
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'main', 'core', 'data', 'legacy_launch_template.json');
let s = fs.readFileSync(file, 'utf8');

// 数字类占位（size / sha1 用字符串；size 需要数字）
s = s
  .replace(/__LWSIZE__/g, '27583')
  .replace(/__LWSHA1__/g, '4ea0aca9c022a234ebaf14b51fb119055955fc9d')
  .replace(/__LWVER__/g, '1.6')
  // 其余字符串占位
  .replace(/__[A-Z0-9_]+__/g, 'PLACEHOLDER');

let t;
try {
  t = JSON.parse(s);
} catch (err) {
  console.log('解析失败：', err.message);
  const idx = s.indexOf('PLACEHOLDER');
  console.log('片段：', s.slice(Math.max(0, idx - 200), idx + 200));
  process.exit(1);
}

console.log('键：', Object.keys(t).join(', '));
console.log('mainClass 原值：', JSON.stringify(t.mainClass));
console.log('minecraftArguments：', JSON.stringify(t.minecraftArguments));
console.log('libraries 数：', Array.isArray(t.libraries) ? t.libraries.length : typeof t.libraries);
if (Array.isArray(t.libraries)) {
  for (const l of t.libraries.slice(0, 8)) console.log('   ', JSON.stringify(l));
}
console.log('assets：', JSON.stringify(t.assets));
console.log('assetIndex：', JSON.stringify(t.assetIndex));
