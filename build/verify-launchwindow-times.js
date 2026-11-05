'use strict';
/** 用法：node build/verify-launchwindow-times.js */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const INNER = path.join(__dirname, '_launchwin-inner.js');
const OUT = path.join(ROOT, '.cache', 'launchwindow-result.json');
try {
  fs.unlinkSync(OUT);
} catch {
  /* ignore */
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-lw');
fs.mkdirSync(userData, { recursive: true });
const child = spawn(require('electron'), [INNER, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], {
  env,
  stdio: 'inherit',
});
child.on('exit', () => {
  let res = null;
  try {
    res = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    /* ignore */
  }
  console.log('\n================ 验收结果 ================');
  if (!res) {
    console.log('没有拿到结果文件');
    process.exitCode = 1;
    return;
  }
  let fail = 0;
  for (const c of res.checks || []) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${(res.checks || []).length} 项，失败 ${fail} 项`);
  if (res.error) console.log('异常：' + res.error);
  process.exitCode = fail === 0 ? 0 : 1;
});
