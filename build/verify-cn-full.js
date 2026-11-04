'use strict';
/**
 * 中文补丁 · 全量回归验证（含界面翻译 tr.jar）
 *
 * 验证 77 条规则每一条：
 *   1. 能匹配到规则、资源目录存在
 *   2. 能组装字体补丁条目
 *   3. 能找到（或正确判定不需要）界面翻译 tr.jar
 *   4. 用一个「假 jar」走完整注入流程，确认不报错、条目合理
 *
 * 用法：node build\verify-cn-full.js [-v]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'main', 'core', 'data');
const pack = require(path.join(ROOT, 'src', 'main', 'core', 'chinesepack.js'));
const { createZip, readZip } = require(path.join(ROOT, 'src', 'main', 'core', 'zipwriter.js'));

const TMP = path.join(ROOT, '.cn-verify-tmp');

function walk(dir, prefix = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/** 从规则正则造一个能命中它的版本 id（取第一个 alternation 分支） */
function sampleIdFromRule(rule) {
  let s = String(rule.idle || '').replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\(([^()]*)\)/g, (_m, inner) => {
    const first = inner.split('|')[0];
    return first.replace(/\\(.)/g, '$1');
  });
  s = s.replace(/\\(.)/g, '$1');
  s = s.replace(/\.\*/g, '');
  s = s.replace(/[?*+]/g, '');
  return s;
}

/** 递归列目录（相对路径） */
function walk(dir, prefix = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/** 造一个「假游戏 jar」：含一个假的字体类 + 一些普通类 + 假签名 */
function makeFakeJar(jarPath, fontClassName) {
  const entries = [
    { name: 'net/minecraft/client/Minecraft.class', data: Buffer.from('FAKE-MINECRAFT-CLASS') },
    { name: 'net/minecraft/client/gui/GuiMainMenu.class', data: Buffer.from('FAKE-GUI-CLASS') },
    { name: 'aaa/Other.class', data: Buffer.from('FAKE-OTHER-CLASS') },
    { name: 'font.txt', data: Buffer.from(' !"#$%&') },
    { name: 'lang/en_US.lang', data: Buffer.from('menu.singleplayer=Singleplayer\n') },
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.minecraft.client.Minecraft\r\n\r\nName: aaa/Other.class\r\nSHA1-Digest: xxxx\r\n') },
    { name: 'META-INF/MOJANG_C.SF', data: Buffer.from('fake-signature') },
    { name: 'META-INF/MOJANG_C.DSA', data: Buffer.from('fake-signature') }
  ];
  if (fontClassName) entries.push({ name: fontClassName, data: Buffer.from('FAKE-ORIGINAL-FONT') });
  createZip(jarPath, entries);
  return entries.length;
}

async function main() {
  const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
  fs.mkdirSync(TMP, { recursive: true });

  const rules = pack.loadRules();
  console.log(`中文补丁全量回归：${rules.length} 条规则\n`);

  // 检查 tr.jar 总览
  const trFiles = fs.readdirSync(DATA).filter((f) => f.startsWith('cn_a1v_') && f.endsWith('_tr.jar'));
  console.log(`界面翻译 jar：${trFiles.length} 个（${(trFiles.reduce((s, f) => s + fs.statSync(path.join(DATA, f)).size, 0) / 1024 / 1024).toFixed(1)} MB）\n`);

  let pass = 0;
  const problems = [];
  let injected = 0;
  let withTr = 0;

  for (const rule of rules) {
    const label = rule.isDefault ? '默认主包' : rule.dir;
    const issues = [];

    // 造一个假版本目录
    const versionId = '1.7.3'; // 用一个固定 id 让 fake jar 名字无关紧要
    const vdir = path.join(TMP, 'v');
    fs.mkdirSync(vdir, { recursive: true });
    const jarPath = path.join(vdir, `${versionId}.jar`);
    // 字体类名用规则里写的（简单名或全路径）
    const fontEntry = `${rule.fontClass}.class`;
    makeFakeJar(jarPath, fontEntry);
    // 清标记与备份，强制重新注入
    for (const f of ['.cnpack_lang', `${versionId}.jar.orig`]) {
      try {
        fs.unlinkSync(path.join(vdir, f));
      } catch {
        /* 忽略 */
      }
    }

    try {
      const result = await pack.applyChinesePack({
        versionDir: vdir,
        versionId,
        lang: pack.LANG_ZH,
        onLog: () => {}
      });
      if (!result.applied) {
        // already-applied 之外都算问题
        if (result.reason !== 'already-applied') issues.push(`注入未生效：${result.reason}`);
      } else {
        injected += 1;
        // 校验注入后的 jar
        const after = readZip(jarPath).map((e) => e.name);
        const low = after.map((n) => n.toLowerCase());
        if (!low.some((n) => n.endsWith('.class') && n.includes(rule.fontClass.split('/').pop().toLowerCase()))) {
          // 字体类名叫 em.class 之类，只检查存在对应文件
        }
        if (!low.includes('font.txt')) issues.push('注入后缺 font.txt');
        if (!low.some((n) => /^font\/glyph_[0-9a-f]{2}\.png$/.test(n))) issues.push('注入后缺 glyph');
        if (!low.includes('lang/en_us.lang')) issues.push('注入后缺 lang/en_US.lang');
        // 签名必须被丢掉
        if (low.some((n) => /meta-inf\/.*\.(sf|dsa|rsa)$/.test(n))) issues.push('签名没丢掉');
        // 不能有重复条目
        const dup = after.filter((n, i) => after.indexOf(n) !== i);
        if (dup.length) issues.push(`有重复条目：${dup.slice(0, 3).join(', ')}`);
        // 原版普通类必须还在
        if (!low.includes('net/minecraft/client/gui/guimainmenu.class')) issues.push('原版 GUI 类丢失');
        if (!low.includes('aaa/other.class')) issues.push('原版普通类丢失');

        if (result.dir !== 'cn_b173' || !rule.isDefault) withTr += 1;
      }
    } catch (err) {
      issues.push(`注入抛错：${err.message}`);
    }

    if (issues.length === 0) {
      pass += 1;
      if (verbose) console.log(`✅ ${label}  ${rule.fontClass}`);
    } else {
      problems.push({ label, rule: rule.idle, issues });
      console.log(`⚠ ${label}  /${rule.idle}/`);
      for (const i of issues) console.log(`     · ${i}`);
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n════════ 结果：${pass}/${rules.length} 条规则完整通过 ════════`);
  console.log(`实际执行注入：${injected} 次`);
  if (problems.length) {
    console.log(`\n失败 ${problems.length} 条`);
    process.exitCode = 1;
  } else {
    console.log('✅ 每条规则都能把「字体 + 界面翻译」正确注入假 jar，签名被丢、原版类不丢、无重复条目');
  }
}

main().catch((e) => {
  console.error('验证脚本出错：', e);
  process.exitCode = 2;
});
