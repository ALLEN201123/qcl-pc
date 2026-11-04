'use strict';
/** 测试启动前检查逻辑（用真实数据） */

const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const prelaunch = require(path.join(CORE, 'prelaunch.js'));
const instances = require(path.join(CORE, 'instances.js'));
const java = require(path.join(CORE, 'java.js'));

async function main() {
  const list = await instances.list(HOME);
  if (!list.length) {
    console.log('没有实例');
    return;
  }

  const javaList = await java.detect();

  for (const inst of list) {
    console.log(`\n═══ ${inst.name}（MC ${inst.mcVersion}）═══`);
    const javaInfo = java.pickBest(javaList, inst.mcVersion);
    console.log(`Java：${javaInfo ? `${javaInfo.version} (${javaInfo.arch})` : '未找到'}`);
    console.log(`推荐主版本：${prelaunch.recommendMajor(inst.mcVersion)}`);

    const issues = prelaunch.buildChecks({
      instance: inst,
      javaInfo,
      memoryMb: 2048,
      settings: {},
      resolved: { id: inst.installedVersion || inst.mcVersion }
    });

    console.log(`\n检查出 ${issues.length} 项：`);
    for (const it of issues) {
      console.log(`  [${it.level.toUpperCase()}] ${it.title}`);
      if (it.detail) console.log(`         ${it.detail.slice(0, 100)}`);
      if (it.fix) console.log(`         💡 ${it.fix}`);
    }
  }
}

main().catch((e) => console.error('失败：', e?.stack || e));
