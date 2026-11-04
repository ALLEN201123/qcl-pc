'use strict';
/**
 * 验证打包产物里是否包含本会话所有新增/修改的代码。
 * asar 内部路径是 `\src\main\core\xxx.js` 这种反斜杠格式。
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

const asar = require('@electron/asar');
const files = asar.listPackage(ASAR);
// 统一成小写 + 正斜杠，方便匹配
const norm = files.map((f) => f.replace(/\\/g, '/').toLowerCase());

const MUST_HAVE = [
  // 本会话新增的模块
  ['src/main/core/javadownload.js', 'Java 一键下载'],
  ['src/main/core/migrate.js', '目录迁移到共享布局'],
  ['src/main/core/prelaunch.js', '启动前检查'],
  ['src/main/core/authlib.js', '第三方登录（authlib）'],
  ['src/main/core/skinlookup.js', '皮肤库后端'],
  ['src/main/core/skin.js', '皮肤校验与导入'],
  // 新增的渲染层
  ['src/renderer/js/launchwindow.js', '正在启动窗口'],
  ['src/renderer/js/skinlibrary.js', '皮肤库界面'],
  ['src/renderer/js/authliblogin.js', '第三方登录界面'],
  ['src/renderer/js/avatar.js', '头像裁脸'],
  // 资源
  ['src/renderer/assets/instance-icons', '实例图标目录'],
  ['src/renderer/assets/instance-icons/brick.png', '图标样例'],
  ['src/renderer/assets/icon/ic_steve.png', 'Steve 头像'],
  ['src/main/core/data/chinese-packs.json', '中文补丁规则'],
  // 关键改动文件
  ['src/main/core/gamecheck.js', '完整性检查（含补丁保护）'],
  ['src/main/core/paths.js', '路径（共享布局）'],
  ['src/main/core/launch.js', '启动核心'],
  ['src/main/ipc.js', 'IPC'],
  ['src/main/settings.js', '设置默认值'],
  ['src/renderer/js/pages/setting.js', '全局设置页'],
  ['src/renderer/js/pages/versionsetting.js', '版本设置页'],
  ['src/renderer/js/pages/accounts.js', '账号页'],
  ['src/renderer/js/pages/home.js', '主页'],
  ['src/renderer/js/router.js', '路由（渲染代次）'],
  ['src/renderer/js/bridge.js', 'bridge（事件转发）'],
  ['src/renderer/css/components.css', '样式'],
];

console.log(`asar 内文件总数：${files.length}\n`);
console.log('═══ 本会话改动是否都在包里 ═══');

let missing = 0;
for (const [p, label] of MUST_HAVE) {
  const target = p.toLowerCase();
  const hit = norm.some((f) => f === `/${target}` || f.startsWith(`/${target}/`));
  console.log(`  ${hit ? '✅' : '❌'} ${label.padEnd(22)} ${p}`);
  if (!hit) missing += 1;
}

console.log(`\n结果：${MUST_HAVE.length - missing}/${MUST_HAVE.length} 命中，缺失 ${missing}`);

// 额外：确认关键新函数名存在于打包后的源码里（防「文件在但内容是旧的」）
console.log('\n═══ 关键函数是否真的在新文件里 ═══');
const checks = [
  ['src/main/core/javadownload.js', 'downloadJavaScript', 'Java 下载函数'],
  ['src/main/core/javadownload.js', 'NO_LOGIN_SOURCES', '免登录来源表'],
  ['src/main/core/migrate.js', 'migrateToSharedLayout', '迁移函数'],
  ['src/main/core/gamecheck.js', 'detectAppliedChinesePack', '中文补丁检测'],
  ['src/main/core/paths.js', 'sharedLibrariesDir', '共享库目录'],
];

for (const [p, needle, label] of checks) {
  let content = '';
  try {
    content = asar.extractFile(ASAR, p.replace(/\//g, path.sep)).toString('utf8');
  } catch {
    content = '';
  }
  const hit = content.includes(needle);
  console.log(`  ${hit ? '✅' : '❌'} ${label.padEnd(18)} ${needle}`);
  if (!hit) missing += 1;
}

process.exitCode = missing === 0 ? 0 : 1;
