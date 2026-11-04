'use strict';
/**
 * 修复损坏的 26.3.jar：按版本 JSON 里的官方 sha1 重新下载。
 *
 * 背景：用户真实数据里的 26.3.jar 大小正确（41483720）但 sha1 不符，
 *       Java 读它时报 `ZipFile invalid LOC header (bad signature)`，
 *       游戏启动 4 秒后以 0xFFFFFFF9(-7) 退出，
 *       表现为「NoClassDefFoundError: net/minecraft/util/Unit」——
 *       而那个类明明就在 jar 里（只是读不出来）。
 *
 * 用法：node build\fix-broken-jar.js [版本号]
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const http = require(path.join(CORE, 'http.js'));
const instances = require(path.join(CORE, 'instances.js'));

function sha1Of(file) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

async function main() {
  const wanted = process.argv[2] || '26.3';
  const list = await instances.list(HOME);

  console.log(`QCL 主目录：${HOME}`);
  console.log(`实例：${list.map((x) => `${x.name}(${x.mcVersion})`).join(', ') || '(无)'}\n`);

  let fixedCount = 0;
  let checkedCount = 0;

  for (const inst of list) {
    const mcDir = path.join(inst.dir, '.minecraft');
    const versionsDir = path.join(mcDir, 'versions');
    if (!fs.existsSync(versionsDir)) continue;

    for (const verName of fs.readdirSync(versionsDir)) {
      const vdir = path.join(versionsDir, verName);
      const jsonPath = path.join(vdir, `${verName}.json`);
      const jarPath = path.join(vdir, `${verName}.jar`);
      if (!fs.existsSync(jsonPath) || !fs.existsSync(jarPath)) continue;

      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch {
        continue;
      }
      const dl = raw.downloads && raw.downloads.client;
      if (!dl || !dl.sha1) continue;

      checkedCount += 1;
      const st = fs.statSync(jarPath);
      const actual = sha1Of(jarPath);
      const sizeOk = !dl.size || st.size === dl.size;
      const shaOk = actual.toLowerCase() === String(dl.sha1).toLowerCase();

      if (shaOk) {
        console.log(`✅ ${verName}: jar 校验通过（${(st.size / 1024 / 1024).toFixed(1)}MB）`);
        continue;
      }

      console.log(`❌ ${verName}: jar 损坏`);
      console.log(`   大小 ${st.size} ${sizeOk ? '（与官方一致）' : `（官方 ${dl.size}）`}`);
      console.log(`   实际 sha1 ${actual}`);
      console.log(`   期望 sha1 ${dl.sha1}`);

      if (wanted && verName !== wanted && !verName.includes(wanted)) {
        console.log('   （不是目标版本，跳过；用参数指定版本号可修）');
        continue;
      }

      console.log('   → 重新下载中…');
      const sw = Date.now();
      try {
        const buf = await http.fetchBuffer(dl.url, { timeoutMs: 300000 });
        const newSha = crypto.createHash('sha1').update(buf).digest('hex');
        if (newSha.toLowerCase() !== String(dl.sha1).toLowerCase()) {
          console.log(`   ❌ 下载后校验仍不通过（${newSha}），放弃写入`);
          continue;
        }
        fs.writeFileSync(jarPath, buf);
        console.log(`   ✅ 已修复（${(buf.length / 1024 / 1024).toFixed(1)}MB，用时 ${((Date.now() - sw) / 1000).toFixed(1)}s）`);
        fixedCount += 1;
      } catch (err) {
        console.log(`   ❌ 下载失败：${err?.message || err}`);
      }
    }
  }

  console.log(`\n检查 ${checkedCount} 个客户端 jar，修复 ${fixedCount} 个`);
}

main().catch((e) => {
  console.error('失败：', e?.message || e);
  process.exit(1);
});
