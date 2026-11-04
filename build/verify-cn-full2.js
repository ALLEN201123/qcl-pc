'use strict';
/**
 * 中文补丁 · 全量回归验证（字体补丁 + 界面翻译 tr.jar）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'main', 'core', 'data');
const pack = require(path.join(ROOT, 'src', 'main', 'core', 'chinesepack.js'));
const { createZip, readZip } = require(path.join(ROOT, 'src', 'main', 'core', 'zipwriter.js'));

const TMP = path.join(ROOT, '.cn-verify-tmp');

/** 从规则正则造一个能命中它的版本 id */
function sampleIdFromRule(rule) {
  let s = String(rule.idle || '').replace(/^\^/, '').replace(/\$$/, '');
  // 先展开 (a|b|c) 取第一个分支
  s = s.replace(/\(([^()]*)\)/g, function (_m, inner) {
    return inner.split('|')[0].replace(/\\(.)/g, '$1');
  });
  // 展开字符类 [12] → 1
  s = s.replace(/\[([^\]]*)\](\?|)/g, function (_m, inner) {
    return inner.charAt(0);
  });
  s = s.replace(/\\(.)/g, '$1');
  s = s.replace(/\.\*/g, '');
  s = s.replace(/[?*+]/g, '');
  return s;
}

/** 造一个假游戏 jar */
function makeFakeJar(jarPath, fontClassName) {
  const entries = [
    { name: 'net/minecraft/client/Minecraft.class', data: Buffer.from('FAKE-MINECRAFT') },
    { name: 'net/minecraft/client/gui/GuiMainMenu.class', data: Buffer.from('FAKE-GUIMAINMENU') },
    { name: 'aaa/Other.class', data: Buffer.from('FAKE-OTHER') },
    { name: 'font.txt', data: Buffer.from(' !"#$%&') },
    { name: 'lang/en_US.lang', data: Buffer.from('menu.singleplayer=Singleplayer\n') },
    {
      name: 'META-INF/MANIFEST.MF',
      data: Buffer.from(
        'Manifest-Version: 1.0\r\nMain-Class: net.minecraft.client.Minecraft\r\n\r\nName: aaa/Other.class\r\nSHA1-Digest: xxxx\r\n'
      )
    },
    { name: 'META-INF/MOJANG_C.SF', data: Buffer.from('fake-stat') },
    { name: 'META-INF/MOJANG_C.DSA', data: Buffer.from('fake-block') }
  ];
  if (fontClassName) entries.push({ name: fontClassName, data: Buffer.from('FAKE-ORIGINAL-FONT') });
  createZip(jarPath, entries);
}

async function main() {
  const verbose = process.argv.indexOf('-v') >= 0;
  fs.mkdirSync(TMP, { recursive: true });

  const rules = pack.loadRules();
  const trFiles = fs.readdirSync(DATA).filter(function (f) {
    return f.indexOf('cn_a1v_') === 0 && f.slice(-7) === '_tr.jar';
  });
  let trSize = 0;
  for (const f of trFiles) trSize += fs.statSync(path.join(DATA, f)).size;

  console.log('中文补丁全量回归：' + rules.length + ' 条规则');
  console.log('界面翻译 jar：' + trFiles.length + ' 个（' + (trSize / 1048576).toFixed(1) + ' MB）\n');

  let pass = 0;
  let fail = 0;
  const failedLabels = [];

  for (const rule of rules) {
    const label = rule.isDefault ? '默认主包(b1.7.3)' : rule.dir;
    const versionId = rule.isDefault ? 'b1.7.3' : sampleIdFromRule(rule);
    const issues = [];

    const vdir = path.join(TMP, label.replace(/[^\w.-]/g, '_'));
    fs.rmSync(vdir, { recursive: true, force: true });
    fs.mkdirSync(vdir, { recursive: true });

    const jarPath = path.join(vdir, versionId + '.jar');
    makeFakeJar(jarPath, rule.fontClass + '.class');

    try {
      const result = await pack.applyChinesePack({
        versionDir: vdir,
        versionId: versionId,
        lang: pack.LANG_ZH,
        onLog: function () {}
      });

      if (!result.applied) {
        issues.push('注入未生效（' + result.reason + '）');
      } else {
        const all = readZip(jarPath);
        const names = all.map(function (e) {
          return e.name;
        });
        const low = names.map(function (n) {
          return n.toLowerCase();
        });

        if (low.indexOf('font.txt') < 0) issues.push('缺 font.txt');
        let hasGlyph = false;
        for (const n of low) {
          if (/^font\/glyph_[0-9a-f]{2}\.png$/.test(n)) {
            hasGlyph = true;
            break;
          }
        }
        if (!hasGlyph) issues.push('缺 glyph');
        if (low.indexOf('lang/en_us.lang') < 0) issues.push('缺 lang/en_US.lang');
        for (const n of low) {
          if (/meta-inf\/.*\.(sf|dsa|rsa)$/.test(n)) {
            issues.push('签名没丢掉');
            break;
          }
        }
        if (low.indexOf('net/minecraft/client/gui/guimainmenu.class') < 0) issues.push('原版 GUI 类丢失');
        if (low.indexOf('aaa/other.class') < 0) issues.push('原版普通类丢失');

        const dup = names.filter(function (n, i) {
          return names.indexOf(n) !== i;
        });
        if (dup.length) issues.push('重复条目：' + dup.slice(0, 3).join(', '));

        const mf = all.find(function (e) {
          return e.name === 'META-INF/MANIFEST.MF';
        });
        if (mf && /SHA1-Digest/i.test(mf.data.toString('utf8'))) {
          issues.push('MANIFEST 里仍有条目摘要');
        }

        if (verbose) {
          console.log(
            '✅ ' + label.padEnd(24) + String(versionId).padEnd(20) +
            ' 字体=' + result.entries + ' 项  jar=' + all.length + ' 条目'
          );
        }
      }
    } catch (err) {
      issues.push('抛错：' + err.message);
    }

    if (issues.length === 0) {
      pass += 1;
    } else {
      fail += 1;
      failedLabels.push(label);
      console.log('⚠ ' + label + '  (' + versionId + ')');
      for (const i of issues) console.log('     · ' + i);
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n════════ 结果：' + pass + '/' + rules.length + ' 通过，' + fail + ' 失败 ════════');
  if (fail === 0) {
    console.log('✅ 每条规则都能正确注入「字体 + 界面翻译」，签名被丢、原版类不丢、无重复条目');
  } else {
    console.log('失败项：' + failedLabels.slice(0, 12).join(', ') + (failedLabels.length > 12 ? '…' : ''));
    process.exitCode = 1;
  }
}

main().catch(function (e) {
  console.error('验证脚本出错：', e);
  process.exitCode = 2;
});
