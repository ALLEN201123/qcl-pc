'use strict';
/**
 * 完整验证「一键下载 Java」：
 *   真下 196 MB → 真解压 → 找到 java.exe → 用 -version 验证能跑
 *
 * 用 Java 21（你的 JAVA_HOME 就是 21，验证完不影响系统）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'main', 'core');
const jd = require(path.join(CORE, 'javadownload.js'));

const HOME = path.join(ROOT, '.java-download-test');

async function main() {
  const major = Number(process.argv[2]) || 21;

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  console.log(`═══ 一键下载 Java ${major} ═══`);
  console.log(`目标目录：${jd.javaInstallDir(HOME, major)}`);
  console.log(`直链：${jd.adoptiumUrl(major)}\n`);

  const t0 = Date.now();
  let lastLog = '';

  const r = await jd.downloadJava({
    major,
    home: HOME,
    onLog: (line) => {
      // 只打关键节点，避免刷屏
      if (line && line !== lastLog) {
        console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
        lastLog = line;
      }
    }
  });

  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(`\n═══ 结果（用时 ${sec} 秒）═══`);
  if (!r.ok) {
    console.log(`❌ 失败：${r.error}`);
    process.exit(1);
  }

  console.log(`✅ ok=${r.ok}`);
  console.log(`   javaPath: ${r.javaPath}`);
  console.log(`   目录    : ${r.dir}`);
  console.log(`   来源    : ${r.source}`);

  // 校验文件真的存在、大小合理
  try {
    const st = fs.statSync(r.javaPath);
    console.log(`   java.exe 大小：${(st.size / 1024 / 1024).toFixed(2)} MB`);
  } catch (e) {
    console.log(`   ❌ 文件不存在：${e.message}`);
    process.exit(1);
  }

  // 用 -version 真跑一次，确认是可用的 JVM
  console.log('\n═══ 实际执行 java -version ═══');
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync(r.javaPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log(out.trim());
  } catch (err) {
    // java -version 把版本打到 stderr，exit code 仍为 0；这里兜底打印
    const out = String((err && (err.stdout || err.stderr)) || '');
    if (out.trim()) {
      console.log(out.trim());
    } else {
      console.log(`   ❌ 执行失败：${err && err.message}`);
      process.exit(1);
    }
  }

  // 再用项目自己的 probe 校验（走的就是启动器实际用的那条路径）
  console.log('\n═══ 用 QCL 自己的 java.probe 校验 ═══');
  const javaMod = require(path.join(CORE, 'java.js'));
  const probed = await javaMod.probe(r.javaPath);
  if (probed) {
    console.log(`   ✅ 识别为 Java ${probed.version}（主版本 ${probed.major}，${probed.arch}，${probed.vendor}）`);
  } else {
    console.log('   ❌ probe 认不出来');
    process.exit(1);
  }

  // 幂等：再调一次应该直接跳过下载
  console.log('\n═══ 幂等性（再调一次）═══');
  const t2 = Date.now();
  const r2 = await jd.downloadJava({ major, home: HOME, onLog: () => {} });
  console.log(`   ok=${r2.ok}  来源=${r2.source}  用时=${Date.now() - t2} ms（应 <100ms）`);

  console.log(`\n测试目录保留在：${HOME}`);
  console.log('（确认无误后可删除，约 300 MB）');
}

main().catch((e) => {
  console.error('失败：', e?.stack || e);
  process.exit(1);
});
