'use strict';
/** 从 asar 里抽关键文件，确认内容是真的新版 */

const path = require('node:path');
const asar = require('@electron/asar');

const ASAR = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');

/** asar 里统一用 \ 分隔 */
function pick(rel) {
  const p = rel.split('/').join(path.sep);
  try {
    return asar.extractFile(ASAR, p).toString('utf8');
  } catch (err) {
    return `__MISSING__ (${err.message})`;
  }
}

const CHECKS = [
  {
    file: 'src/main/core/javadownload.js',
    needles: ['async function downloadJava', 'NO_LOGIN_SOURCES', 'adoptiumUrl', 'sourcesFor', 'DISCOURAGED', 'DISCOURAGED']
  },
  { file: 'src/main/core/migrate.js', needles: ['migrateToSharedLayout', 'startBackground', 'whenIdle', 'mergeDir'] },
  { file: 'src/main/core/gamecheck.js', needles: ['detectAppliedChinesePack', 'repairFiles', 'sharedLibrariesDir'] },
  { file: 'src/main/core/paths.js', needles: ['sharedLibrariesDir', 'sharedAssetsDir', 'legacyLibrariesDir'] },
  { file: 'src/main/core/prelaunch.js', needles: ['buildChecks', 'recommendMajor'] },
  { file: 'src/main/core/authlib.js', needles: ['loginWithPassword', 'probeServer', 'buildJavaAgent'] },
  { file: 'src/main/core/skinlookup.js', needles: ['lookupPlayerSkin', 'downloadSkinAsDataUrl'] },
  { file: 'src/renderer/js/launchwindow.js', needles: ['openLaunchWindow', 'markStage', 'finishLaunch'] },
  { file: 'src/renderer/js/skinlibrary.js', needles: ['openSkinLibrary'] },
  { file: 'src/renderer/js/authliblogin.js', needles: ['openAuthlibLogin'] },
  { file: 'src/renderer/js/avatar.js', needles: ['faceFromSkin', 'loadImage'] },
  { file: 'src/renderer/js/router.js', needles: ['renderToken', 'isStale'] },
  { file: 'src/renderer/js/pages/setting.js', needles: ['drawGame', 'st-java-none', 'st-no-check-files', 'st-java-download'] },
  { file: 'src/renderer/js/pages/versionsetting.js', needles: ['drawIcon', 'drawAdvanced', 'INSTANCE_ICONS', 'vs-no-check-files'] },
  { file: 'src/renderer/js/pages/accounts.js', needles: ['data-act="skinlib"', 'ac-authlib'] },
  { file: 'src/renderer/js/pages/home.js', needles: ['setSkinFromDataUrl', 'skin:readRemote'] },
  { file: 'src/main/core/launch.js', needles: ['onStage', 'supportsQuickPlay', 'graphicsBackend', 'paths.librariesDir(home, instance.id)'] }
];

let total = 0;
let pass = 0;
const fails = [];

for (const c of CHECKS) {
  const content = pick(c.file);
  if (content.startsWith('__MISSING__')) {
    console.log(`❌ ${c.file} —— 不在包里`);
    fails.push(c.file);
    total += c.needles.length;
    continue;
  }
  const hitList = c.needles.filter((n) => content.includes(n));
  const missList = c.needles.filter((n) => !content.includes(n));
  total += c.needles.length;
  pass += hitList.length;

  if (missList.length === 0) {
    console.log(`✅ ${c.file}  (${hitList.length}/${c.needles.length})`);
  } else {
    console.log(`⚠ ${c.file}  (${hitList.length}/${c.needles.length})  缺: ${missList.join(', ')}`);
    fails.push(`${c.file}: ${missList.join(', ')}`);
  }
}

console.log(`\n═══ 合计：${pass}/${total} 个关键标识命中 ═══`);
if (fails.length) {
  console.log('未命中项：');
  for (const f of fails) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('✅ 打包产物内容与源码一致');
}
