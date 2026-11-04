'use strict';
/** 测 launch:precheck 各步骤耗时，找出「点完半天才响应」的元凶 */

const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const instances = require(path.join(CORE, 'instances.js'));
const java = require(path.join(CORE, 'java.js'));
const prelaunch = require(path.join(CORE, 'prelaunch.js'));
const accounts = require(path.join(CORE, 'accounts.js'));

async function main() {
  const t = () => Date.now();

  let s = t();
  const list = await instances.list(HOME);
  console.log(`instances.list()      ${t() - s} ms`);

  s = t();
  const javaList = await java.detect({ home: HOME });
  console.log(`java.detect()         ${t() - s} ms   ← 扫描所有 Java，通常最慢`);

  s = t();
  const best = java.pickBest(javaList, '26.3');
  console.log(`java.pickBest()       ${t() - s} ms`);

  s = t();
  const acc = await accounts.list(HOME);
  console.log(`accounts.list()       ${t() - s} ms`);

  s = t();
  prelaunch.buildChecks({
    instance: list[0],
    javaInfo: best,
    memoryMb: 2048,
    settings: {},
    resolved: { id: '26.3' }
  });
  console.log(`prelaunch.buildChecks ${t() - s} ms`);
}

main().catch((e) => console.error(e));
