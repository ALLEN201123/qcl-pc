'use strict';
/**
 * QCL 电脑版 · electron-builder 配置
 *
 * 为什么要单独一个配置文件：Windows 打包时 electron-builder 需要 rcedit 去改
 * exe 的图标与版本信息，但它自带的 winCodeSign 压缩包里含有 macOS 的符号链接，
 * 在普通 Windows 账户下解压会报「无法创建符号链接」（不影响 exe 生成，但 rcedit 会不执行，
 * 结果打出来的 QCL.exe 显示成「Electron / GitHub, Inc.」）。
 * ⇒ 这里用 afterPack 钩子自己找 rcedit 补上图标和版本信息。
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const ICON_ICO = path.join(ROOT, 'build', 'icon.ico');

/** 在若干缓存位置里找 rcedit-x64.exe */
function findRcedit() {
  const bases = [
    process.env.ELECTRON_BUILDER_CACHE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache') : null,
    path.join(ROOT, '.cache', 'builder')
  ].filter(Boolean);

  for (const base of bases) {
    const parent = path.join(base, 'winCodeSign');
    if (!fs.existsSync(parent)) continue;
    for (const sub of fs.readdirSync(parent)) {
      const exe = path.join(parent, sub, 'rcedit-x64.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function applyWindowsMetadata(appOutDir) {
  const exe = path.join(appOutDir, 'QCL.exe');
  if (!fs.existsSync(exe)) return;
  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('[QCL] 没找到 rcedit，跳过图标/版本信息写入');
    return;
  }
  /**
   * ★ 版本号必须跟 package.json 走，别写死。
   *   以前写死 1.0.0.0 —— package.json 升到 1.0.1 之后，
   *   程序里「关于」显示 1.0.1、右键属性却还是 1.0.0，玩家会以为装错了。
   */
  const pkgVersion = String(require('./package.json').version || '0.0.0');
  // 文件版本要 4 段：1.0.1 → 1.0.1.0
  const parts = pkgVersion.split('.').slice(0, 3);
  while (parts.length < 4) parts.push('0');
  const fileVersion = parts.slice(0, 4).join('.');
  const args = [
    exe,
    '--set-version-string', 'ProductName', 'Quanta Craft Launcher PC',
    '--set-version-string', 'FileDescription', 'Quanta Craft Launcher PC',
    '--set-version-string', 'CompanyName', 'Rod123456',
    '--set-version-string', 'LegalCopyright', 'GPL-3.0 · Quanta Craft Launcher',
    '--set-version-string', 'OriginalFilename', 'QCL.exe',
    '--set-version-string', 'InternalName', 'QCL',
    '--set-file-version', fileVersion,
    '--set-product-version', pkgVersion
  ];
  if (fs.existsSync(ICON_ICO)) args.push('--set-icon', ICON_ICO);
  else console.warn('[QCL] 没找到 build/icon.ico，只改版本信息');

  try {
    execFileSync(rcedit, args, { stdio: 'inherit' });
    console.log('[QCL] 已写入图标与版本信息：', exe);
  } catch (err) {
    console.warn('[QCL] rcedit 执行失败（不影响程序运行）：', err.message);
  }
}

module.exports = {
  appId: 'com.qcl.launcher.pc',
  productName: 'Quanta Craft Launcher PC',
  copyright: 'Copyright © 2026 Rod123456 · GPL-3.0',

  directories: {
    output: 'dist',
    buildResources: 'build'
  },

  // 只打包运行需要的东西：src（主进程 + 预加载 + 界面）与 package.json
  files: [
    'src/**/*',
    '!src/renderer/_devtest/**',
    '!**/*.map',
    '!**/.DS_Store',
    'package.json'
  ],

  // 复用已经装好的 electron 发行版，避免打包时再下 115MB（本机缓存目录权限异常）
  electronDist: 'node_modules/electron/dist',

  asar: true,
  compression: 'maximum',

  win: {
    // ★ exe 文件名固定为 QCL.exe：productName 是全称（显示在属性里），
    //   但文件名带空格会让 SFX 脚本、快捷方式、命令行都变麻烦。
    executableName: 'QCL',
    target: [{ target: 'portable', arch: ['x64'] }],
    icon: ICON_ICO,
    // 我们自己用 afterPack 写元数据，跳过内置的签名/改属性步骤（它依赖解压失败的 winCodeSign）
    signAndEditExecutable: false
  },

  portable: {
    artifactName: 'QCL-${version}-win-x64.exe',
    requestExecutionLevel: 'user',
    // 绿色版：解压到临时目录运行，用户数据仍写在「文档\QCL」
    unpackDirName: 'QCL'
  },

  afterPack: async (context) => {
    applyWindowsMetadata(context.appOutDir);
  },

  afterAllArtifactBuild: async (buildResult) => {
    console.log('[QCL] 产物：');
    for (const f of buildResult.artifactPaths) console.log('   ', f);
    return [];
  }
};
