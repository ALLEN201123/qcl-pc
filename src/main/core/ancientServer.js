'use strict';
/**
 * 内置远古服务端（本地资源，随启动器一起分发）
 *
 * ★★★ 为什么需要这个（2026-11-22）：
 *
 * 实测结论 —— 上古时代的服务端有三类来源，缺一不可：
 *
 *   ① **Mojang 官方清单里还在的**：1.2.5 / 1.6.4 / 1.7.10 / 1.8.9 … 直接下
 *   ② **Mojang 官方已下架、Betacraft 归档保存的**：
 *      Classic 全系、Alpha 0.1~0.2、Beta 全系（含 b1.9-pre1~pre6）、1.0.0 / 1.0.1、愚人节 2.0
 *      → 走 core/serverarchive.js 在线拉
 *   ③ **上面两个都没有、只有社区实现才有的**：
 *      · **Infdev**（Mojang 当年根本没发过 Infdev 服务端）→ 用社区做的
 *        「Infdev Ultimate Server」，本质是把 Infdev 客户端改造出的专用服务端
 *      · **Beta 的插件化服务端**（原版 b1.7.3 服务端不支持插件）→ 用
 *        「Beta 1.7.3 PEMod」，它是 Beta 时代的 Bukkit 前身
 *
 * ② 覆盖不到的（比如 Alpha 1.2.6），③ 里也没有 —— 这是客观事实，
 * 报告缺口比编造能力更负责。
 *
 * 这两个文件放在 `<项目>/assets/ancient-servers/`，由 electron-builder 打进包
 * （见 electron-builder.config.js 的 extraResources）。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 内置服务端清单。
 *
 * `covers` 是它能开服的 MC 版本（多个），`kind` 说明它是什么。
 */
const BUILTIN = [
  {
    id: 'infdev-ultimate',
    file: 'infdev-ultimate-server-1.0.2_03.jar',
    /** 能开哪些版本服（Infdev 全系都是同一个服务端内核） */
    covers: [
      'inf-20100227', 'inf-20100313', 'inf-20100316', 'inf-20100320', 'inf-20100321',
      'inf-20100325', 'inf-20100327', 'inf-20100330', 'inf-20100409', 'inf-20100413',
      'inf-20100415', 'inf-20100420', 'inf-20100607', 'inf-20100608', 'inf-20100611',
      'inf-20100615', 'inf-20100616', 'inf-20100617', 'inf-20100618', 'inf-20100624',
      'inf-20100625', 'inf-20100629', 'inf-20100630',
    ],
    name: 'Infdev Ultimate Server',
    version: '1.0.2_03',
    kind: 'infdev',
    label: 'Infdev 专用服务端',
    desc:
      'Mojang 从来没发布过 Infdev 的服务端，这是社区把 Infdev 客户端改造出的专用服务端。' +
      '实测可正常启动（会自己生成 world / server.properties）。',
    runArgs: ['nogui'],
    javaMajor: 8,
    license: '社区制作，随包分发仅用于个人游玩',
  },
  {
    id: 'beta-173-pemod',
    file: 'beta-1.7.3-pemod060-server.zip',
    covers: ['b1.7.3'],
    name: 'Beta 1.7.3 PEMod Server',
    version: '060',
    kind: 'beta-plugin',
    label: 'Beta 1.7.3 插件化服务端',
    desc:
      '原版 b1.7.3 服务端不支持插件。这是 Beta 时代的插件化服务端（Bukkit 前身 PE = Plugin Enabled），' +
      '可以装 Beta 时期的插件。',
    /** 是 zip，需要先解压出里面的 jar */
    isZip: true,
    runArgs: [],
    javaMajor: 8,
    license: '社区制作，随包分发仅用于个人游玩',
  },
];

/** 内置资源目录（开发时在项目里，打包后在 resources 下） */
function builtinDir() {
  // 开发：<project>/assets/ancient-servers
  const devDir = path.join(__dirname, '..', '..', '..', 'assets', 'ancient-servers');
  if (fs.existsSync(devDir)) return devDir;
  // 打包后：electron-builder 的 extraResources → <resources>/ancient-servers
  try {
    const resDir = path.join(process.resourcesPath || '', 'ancient-servers');
    if (fs.existsSync(resDir)) return resDir;
  } catch {
    /* ignore */
  }
  return devDir;
}

/** 列出内置服务端（含文件是否真的在） */
function list() {
  const dir = builtinDir();
  return BUILTIN.map((b) => {
    const p = path.join(dir, b.file);
    let exists = false;
    let size = 0;
    try {
      const st = fs.statSync(p);
      exists = st.isFile();
      size = st.size;
    } catch {
      exists = false;
    }
    return { ...b, path: p, exists, size, dir };
  });
}

/**
 * 找能覆盖某个 MC 版本的内置服务端。
 * @param {string} mcVersion
 * @returns {object|null}
 */
function findFor(mcVersion) {
  const want = String(mcVersion || '').trim().toLowerCase();
  if (!want) return null;
  const all = list();
  // ① 精确命中
  for (const b of all) {
    if (b.covers.some((v) => v.toLowerCase() === want)) return b;
  }
  // ② Infdev 是「一个内核覆盖全部 Infdev」，用前缀兜
  if (/^inf/i.test(want)) {
    const inf = all.find((b) => b.kind === 'infdev');
    if (inf) return inf;
  }
  return null;
}

/**
 * 把内置服务端准备到目标工作目录，返回可用 jar 路径。
 * 是 zip 的会解压出里面的 jar。
 *
 * @param {string} mcVersion
 * @param {string} destDir 服务端工作目录
 * @returns {Promise<{ok:boolean, jar?:string, builtin?:object, error?:string}>}
 */
async function installTo(mcVersion, destDir) {
  const b = findFor(mcVersion);
  if (!b) return { ok: false, error: `内置服务端里没有能开 ${mcVersion} 的` };
  if (!b.exists) {
    return { ok: false, error: `内置服务端文件缺失：${b.file}（可能在打包时漏了 assets/ancient-servers）` };
  }

  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(b.file));

  if (!b.isZip) {
    fs.copyFileSync(b.path, dest);
    return { ok: true, jar: path.basename(dest), builtin: b };
  }

  // zip：解出里面的 jar
  fs.copyFileSync(b.path, dest);
  const ExtractZip = require('extract-zip');
  const outDir = path.join(destDir, '_extract_' + Date.now());
  await ExtractZip(dest, { dir: outDir });
  // 找 jar
  let found = null;
  const stack = [outDir];
  let guard = 0;
  while (stack.length && guard < 2000 && !found) {
    const cur = stack.pop();
    guard += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /\.jar$/i.test(e.name)) {
        found = full;
        break;
      }
    }
  }
  if (!found) {
    return { ok: false, error: `内置服务端 zip 里没有找到 jar：${b.file}` };
  }
  const jarName = path.basename(found);
  fs.copyFileSync(found, path.join(destDir, jarName));
  fs.rmSync(outDir, { recursive: true, force: true });
  try {
    fs.unlinkSync(dest);
  } catch {
    /* 删除原始 zip 失败就留着 */
  }
  return { ok: true, jar: jarName, builtin: b };
}

module.exports = {
  BUILTIN,
  builtinDir,
  list,
  findFor,
  installTo,
};
