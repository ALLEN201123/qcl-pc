'use strict';
/**
 * 验收：安装前选加载器弹窗
 *   ① 点「安装」真的弹加载器选择（不再直接装原版）
 *   ② 每个加载器异步显示「最新 x.y.z」
 *   ③ 选 Fabric 后 install:start 收到 { loader: { type:'fabric', version:'0.20.1' } }
 *   ④ Esc 取消不会发起安装
 *   ⑤ 模组安装的前置依赖弹窗真的会弹
 *
 * 用法：node build/verify-loader-picker.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const INNER = path.join(__dirname, '_loader-inner.js');
const OUT = path.join(ROOT, '.cache', 'loader-picker-result.json');

if (!fs.existsSync(INNER)) {
  console.error('缺少 build/_loader-inner.js');
  process.exit(1);
}
try {
  fs.unlinkSync(OUT);
} catch {
  /* ignore */
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = path.join(ROOT, '.cache', 'userdata-loader');
fs.mkdirSync(userData, { recursive: true });

const child = spawn(require('electron'), [INNER, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`], {
  env,
  stdio: 'inherit',
});

let code = null;
child.on('exit', (c) => {
  code = c;
  let res = null;
  try {
    res = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    /* ignore */
  }
  console.log('\n================ 验收结果 ================');
  if (!res) {
    console.log('没有拿到结果文件（内层进程可能崩溃）');
    process.exitCode = 1;
    return;
  }
  let fail = 0;
  for (const c of res.checks || []) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) fail += 1;
    console.log(`${mark}  ${c.name}${c.info !== undefined ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${(res.checks || []).length} 项，失败 ${fail} 项`);
  if (res.allVers) console.log('版本标签：' + JSON.stringify(res.allVers));
  if (res.error) console.log('异常：' + res.error);
  process.exitCode = fail === 0 ? 0 : 1;
});
