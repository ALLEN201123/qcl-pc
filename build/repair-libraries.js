'use strict';
/**
 * 扫描并修复一个实例里所有「sha1 与官方不符 / 缺失」的库文件。
 *
 * 为什么需要它：用户实测 26.3 启动崩溃
 *   ① NoClassDefFoundError: net/minecraft/util/Unit  ← 26.3.jar 损坏
 *   ② NoClassDefFoundError: it/unimi/dsi/fastutil/objects/Object2LongMap ← fastutil 损坏
 * 两次都是「文件存在、大小甚至一致，但内容被改过/截断」，普通的「存在即跳过」检查抓不出来。
 *
 * 用法：
 *   node build\repair-libraries.js [版本号]
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

function sha1OfFile(file) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

async function downloadVerified(url, expectedSha1, dest) {
  const buf = await http.fetchBuffer(url, { timeoutMs: 300000 });
  const actual = crypto.createHash('sha1').update(buf).digest('hex');
  if (expectedSha1 && actual.toLowerCase() !== String(expectedSha1).toLowerCase()) {
    throw new Error(`下载后校验不符（${actual}）`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  const target = process.argv[2] || null;
  const list = await instances.list(HOME);
  if (!list.length) {
    console.log('没有实例');
    return;
  }

  for (const inst of list) {
    if (target && inst.mcVersion !== target) continue;
    const mcDir = path.join(inst.dir, '.minecraft');
    const versionsDir = path.join(mcDir, 'versions');
    const libDir = path.join(mcDir, 'libraries');
    if (!fs.existsSync(versionsDir)) continue;

    for (const verName of fs.readdirSync(versionsDir)) {
      const vdir = path.join(versionsDir, verName);
      const jsonPath = path.join(vdir, `${verName}.json`);
      if (!fs.existsSync(jsonPath)) continue;

      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch {
        continue;
      }

      console.log(`\n═══ ${inst.name} / ${verName} ═══`);
      let fixed = 0;
      let okCount = 0;
      const failures = [];

      for (const lib of raw.libraries || []) {
        // 只处理当前平台适用的（rules 过滤交给上层，这里简单跳过明显不匹配的）
        const art = lib.downloads && lib.downloads.artifact;
        if (!art || !art.path || !art.url) continue;

        const dest = path.join(libDir, art.path.split('/').join(path.sep));
        const exists = fs.existsSync(dest) && fs.statSync(dest).size > 0;

        if (exists) {
          const actual = sha1OfFile(dest);
          if (!art.sha1 || actual.toLowerCase() === String(art.sha1).toLowerCase()) {
            okCount += 1;
            continue;
          }
          console.log(`  ❌ 损坏：${lib.name}`);
          console.log(`     实际 ${actual}`);
          console.log(`     期望 ${art.sha1}`);
        } else {
          console.log(`  ⚠ 缺失：${lib.name}`);
        }

        // 修复
        try {
          const sw = Date.now();
          const bytes = await downloadVerified(art.url, art.sha1, dest);
          console.log(`     ✅ 已修复（${(bytes / 1024).toFixed(0)}KB，${((Date.now() - sw) / 1000).toFixed(1)}s）`);
          fixed += 1;
        } catch (err) {
          const msg = err?.message || String(err);
          console.log(`     ❌ 失败：${msg}`);
          failures.push({ name: lib.name, error: msg });
        }
      }

      console.log(`\n  正常 ${okCount} 个，修复 ${fixed} 个，失败 ${failures.length} 个`);
    }
  }
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
