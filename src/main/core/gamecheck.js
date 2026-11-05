'use strict';
/**
 * Quanta Craft Launcher PC · 游戏文件完整性检查
 *
 * ## 为什么需要它
 * 启动前检查「jar / 库 / 资源索引 / assets」有没有缺失或损坏，缺的就补下 ——
 * 这是启动器的常规能力（FCL 的 checkGameCompletionAsync、HMCL 的完整性检查都这么做）。
 *
 * ## 为什么必须能关掉（QCL 的关键差异）
 * QCL 会给远古版本**改写游戏 jar**（注入中文字体类 + 点阵 + lang + 界面翻译）。
 * 一旦做全量 SHA1 校验：
 *   1. 被我们改过的条目（字体类、font.txt、lang、glyph）必然对不上原版 sha1；
 *   2. 检查器会判定「文件损坏」→ 重新下载原版 jar / 还原条目；
 *   3. 中文补丁被冲掉，而且 Mojang 签名会被补回来 → 下次注入又要重新删签名。
 *
 * ⇒ 安卓版的做法（LegacyChinesePack / QclVersionConfig）：
 *    **远古版本装完就把「不检查游戏文件」打开**（`notCheckGameFile`），
 *    并且这个开关是**逐版本**的（只影响当前版本，不动全局）。
 *
 * ⇒ PC 版照做：
 *   · `settings.checkGameFiles`（全局默认，默认 true）
 *   · 实例级 `instance.notCheckGameFiles`（远古版本安装时自动置 true）
 *   · 两者任一要求「不检查」就跳过校验，但仍会补「完全缺失」的关键文件
 *     （jar 没有就一定要下，否则根本起不来 —— 安卓版 1.2.5 修的就是这个语义）。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const jsonstore = require('./jsonstore');
// ★ 用于直接读 jar 判断有没有注入中文补丁（点阵图 font/glyph_*.png 是补丁独有的）
const zip = require('./zip');

/** 计算文件 sha1（流式，避免大文件占内存） */
function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 文件是否存在且非空 */
function existsNonEmpty(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * 直接从**文件系统**判断某个版本有没有注入过中文补丁。
 *
 * ★★★ 为什么不能只看 instance.json（2026-11-05 修，用户实测踩到）。
 *
 * `shouldSkipIntegrity()` 原先只检查 `instance.chinesePack.applied` / `instance.notCheckGameFiles`。
 * 但实测发现：`a1.2.6` 实例**目录里明明有 `.cnpack_lang` 标记和 `a1.2.6.jar.orig` 备份**
 * （补丁确实打过了），可 instance.json 里：
 *     notCheckGameFiles = false
 *     chinesePack       = null
 * ⇒ 两个保护字段都是空的！于是新加的 **客户端 jar sha1 校验会把打补丁的 jar 判成「损坏」**，
 *   接着自动重下原版覆盖 —— **中文补丁被静默抹掉**。
 *
 * 字段为空的原因很多：旧版启动器装的、测试脚本装的、手动拷进来的、手动打补丁的。
 * ⇒ 可靠的做法是**直接看文件**（三重判据，任一命中即认定已打补丁）：
 *     ① `<versionDir>/.cnpack_lang`  —— 补丁自己写的语言标记
 *     ② `<versionDir>/<id>.jar.orig` —— 补丁留的原版备份
 *     ③ jar 内有 `font/glyph_*.png`  —— 点阵图是补丁独有的（原版绝无此文件）
 *
 * @param {string} versionDir
 * @param {string} [versionId]
 * @returns {{patched:boolean, reason:string}}
 */
function detectAppliedChinesePack(versionDir, versionId) {
  if (!versionDir) return { patched: false, reason: '' };

  // ① 语言标记文件
  try {
    const marker = path.join(versionDir, '.cnpack_lang');
    if (fs.existsSync(marker)) {
      let lang = '';
      try {
        lang = fs.readFileSync(marker, 'utf8').trim();
      } catch {
        /* 读不了也算命中 */
      }
      return { patched: true, reason: `发现中文补丁标记 .cnpack_lang${lang ? `（${lang}）` : ''}` };
    }
  } catch {
    /* 忽略 */
  }

  // ② 原版 jar 备份
  try {
    const id = versionId || path.basename(versionDir);
    if (fs.existsSync(path.join(versionDir, `${id}.jar.orig`))) {
      return { patched: true, reason: '发现原版 jar 备份（.jar.orig），说明已注入补丁' };
    }
  } catch {
    /* 忽略 */
  }

  // ③ jar 内的点阵图
  try {
    const id = versionId || path.basename(versionDir);
    const jar = path.join(versionDir, `${id}.jar`);
    if (fs.existsSync(jar)) {
      const entries = zip.list(jar) || [];
      const hasGlyph = entries.some((n) => /^font\/glyph_[0-9a-f]{2}\.png$/i.test(n) || /^glyph_[0-9a-f]{2}\.png$/i.test(n));
      if (hasGlyph) {
        return { patched: true, reason: 'jar 内有中文点阵图（font/glyph_*.png），说明已注入补丁' };
      }
    }
  } catch {
    /* 读不了 jar 就当没打补丁（宁可多校验一次，也不要误抹补丁 —— 所以这里返回 false 时
       仍然会走 sha1 校验，但下面的 checkGameFiles 会把「疑似补丁」的情况一并考虑） */
  }

  return { patched: false, reason: '' };
}

/**
 * ★ 从**文件系统**判断版本目录里有没有「加载器改过 jar / 版本」的标记（2026-11-05 新增）。
 *
 * 为什么需要：
 *   · **ModLoader** 是覆盖式注入 —— 把 .class 直接写进 minecraft.jar、还删了 META-INF 签名，
 *     原版 sha1 必然对不上；不跳过校验的话，一次「修复这个版本」就会拿原版把 jar 盖掉，
 *     ModLoader 白装（和中文补丁被冲掉是同一类事故）。
 *   · **Babric** 会在版本目录写 `.babric` 标记（加载器重写了版本，原版校验同样无意义）。
 *
 * 判据与安卓版 ModLoaderDetector 一致：只看版本目录下的标记文件。
 *
 * @param {string} versionDir 版本目录，例如 `.minecraft/versions/b1.7.3`
 * @returns {{modified:boolean, loader:string, reason:string}}
 */
function detectLoaderModifiedJar(versionDir) {
  if (!versionDir) return { modified: false, loader: '', reason: '' };
  const checks = [
    ['.modloader', 'modloader', '发现 ModLoader 标记 .modloader，jar 已被注入，跳过内容校验'],
    ['.babric', 'babric', '发现 Babric 标记 .babric，加载器已重写版本，跳过内容校验'],
  ];
  for (const [marker, loader, reason] of checks) {
    try {
      if (fs.existsSync(path.join(versionDir, marker))) return { modified: true, loader, reason };
    } catch {
      /* 读不了就继续查下一个 */
    }
  }
  return { modified: false, loader: '', reason: '' };
}

/**
 * 判断是否应该跳过「内容校验」（只做存在性检查）。
 *
 * @param {object} opts
 * @param {object} opts.instance  实例对象
 * @param {object} opts.settings  全局设置
 * @returns {{skip:boolean, reason:string}}
 */
function shouldSkipIntegrity(opts = {}) {
  const instance = opts.instance || {};
  const settings = opts.settings || {};

  // 1. 实例级开关优先（远古版本安装时自动打开）
  if (instance.notCheckGameFiles === true) {
    return { skip: true, reason: '该版本已开启「不检查游戏文件」（远古版本中文补丁需要）' };
  }
  // 2. 全局开关
  if (settings.checkGameFiles === false) {
    return { skip: true, reason: '设置里关闭了游戏文件完整性检查' };
  }
  // 3. 装了中文补丁的版本必须跳过内容校验（jar 被我们改过，sha1 必然不符）
  if (instance.chinesePack && instance.chinesePack.applied) {
    return { skip: true, reason: '该版本已注入中文补丁，jar 被改写，跳过内容校验' };
  }
  return { skip: false, reason: '' };
}

/**
 * 检查一个已安装版本的游戏文件。
 *
 * ★ 语义（照安卓版 CheckLibTask 1.2.5 的修法）：
 *   · **关键文件缺失**（client jar / 版本 json）→ 必须报出来，让上层去补；
 *   · **开了「不检查」时**：只查存在性，不查 sha1，缺失也**不拦启动**（离线也能进）；
 *   · **没开「不检查」时**：做 sha1 校验，损坏的报出来。
 *
 * @param {object} opts
 * @param {string} opts.versionDir  版本目录（含 <id>.jar/.json）
 * @param {string} opts.versionId
 * @param {string} opts.minecraftDir  实例的 .minecraft 目录（查 libraries/assets）
 * @param {object} opts.resolved  已解析的版本 JSON（含 libraries / assetIndex）
 * @param {object} opts.instance
 * @param {object} opts.settings
 * @returns {Promise<{ok:boolean, skipContentCheck:boolean, reason:string, missing:object[], corrupted:object[]}>}
 */
async function checkGameFiles(opts = {}) {
  const versionDir = String(opts.versionDir || '');
  const versionId = String(opts.versionId || '');
  const minecraftDir = String(opts.minecraftDir || '');
  const resolved = opts.resolved || {};

  let { skip, reason } = shouldSkipIntegrity(opts);

  /**
   * ★★★ 兜底：直接从文件系统再查一次有没有中文补丁（2026-11-05）。
   *
   * `shouldSkipIntegrity()` 只看 instance.json 的字段，而实测发现这些字段**可能是空的**
   * （旧版启动器装的、测试脚本装的、手动打补丁的）：
   *   a1.2.6 目录里明明有 `.cnpack_lang` 和 `a1.2.6.jar.orig`，但 instance.json 里
   *   `chinesePack = null`、`notCheckGameFiles = false`。
   * 那时新的客户端 jar sha1 校验会把**打了补丁的 jar 判成损坏** → 自动重下原版覆盖 →
   * **中文补丁被静默抹掉**（用户担心的正是这个）。
   *
   * ⇒ 字段说不用跳，但文件说打过补丁时，以文件为准，强制跳过内容校验。
   */
  if (!skip) {
    const det = detectAppliedChinesePack(versionDir, versionId);
    if (det.patched) {
      skip = true;
      reason = `${det.reason}（按文件判定，跳过内容校验以免冲掉补丁）`;
    }
  }

  /**
   * ★ 兜底之二：版本目录里有 `.modloader` / `.babric` 标记时也必须跳过。
   *   这两种加载器都会让 jar 与官方 sha1 对不上（ModLoader 是直接注入 class 并删签名），
   *   不跳过的话「修复版本」会把加载器冲掉。
   */
  if (!skip) {
    const loaderMark = detectLoaderModifiedJar(versionDir);
    if (loaderMark.modified) {
      skip = true;
      reason = loaderMark.reason;
    }
  }

  const missing = [];
  const corrupted = [];

  // ---- 1. 关键文件：版本 jar / json ----
  /**
   * ★★★ 2026-11-05 修（用户实例报「游戏文件缺失：fabric-loader-0.20.1-26.3.jar」）。
   *
   * Fabric / Quilt / Forge 这些加载器版本都是 `inheritsFrom` 的**空壳**：
   * 它们的版本目录里只有一个 json，**根本没有自己的 jar** —— 客户端 jar 在父版本目录里
   * （`resolved.clientJarId` 就是父版本 id）。
   *
   * 以前这里一律找 `<当前版本id>.jar`，于是任何一个加载器版本启动前都会被判「缺 jar」，
   * 报一句「请到版本列表重新安装」，玩家重装一百次也没用。
   * ⇒ 现在按 clientJarId 找父版本的 jar。
   */
  const clientJarId = resolved.clientJarId || resolved.jar || versionId;
  const jarPath =
    clientJarId === versionId
      ? path.join(versionDir, `${versionId}.jar`)
      : path.join(minecraftDir, 'versions', clientJarId, `${clientJarId}.jar`);
  const jarName = `${clientJarId}.jar`;
  const jsonPath = path.join(versionDir, `${versionId}.json`);
  const clientDl0 = resolved.downloads && resolved.downloads.client;
  if (!existsNonEmpty(jarPath)) {
    missing.push({
      kind: 'client-jar',
      path: jarPath,
      name: jarName,
      critical: true,
      // ★ 带上下载地址：启动前就能自动补下，别再让玩家去「重新安装」
      url: (clientDl0 && clientDl0.url) || resolved.archiveJarUrl || null,
      sha1: (clientDl0 && clientDl0.sha1) || null
    });
  }
  if (!existsNonEmpty(jsonPath)) {
    missing.push({ kind: 'version-json', path: jsonPath, name: `${versionId}.json`, critical: true });
  }

  // ---- 2. 开了「不检查」就到此为止（照安卓版语义：只查存在性，不拦启动）----
  if (skip) {
    return { ok: true, skipContentCheck: true, reason, missing, corrupted };
  }

  /**
   * ★★★ 客户端 jar 的 sha1 校验（2026-11-05 新增）。
   *
   * 用户实测踩到的坑：26.3.jar **大小完全正确**（41483720 字节，与官方一致），
   * 但 sha1 不符（内容被改坏/截断），Java 读它时报
   *   `ZipFile invalid LOC header (bad signature)`
   * 进而 `NoClassDefFoundError: net/minecraft/util/Unit`，游戏 4 秒后崩溃退出。
   *
   * 而这里以前**只查存在性**（`existsNonEmpty`）—— 坏文件照样通过，
   * 用户看到的就是「明明装好了却启动不了」，且日志里只有一句含糊的提示。
   * ⇒ 现在补上 sha1 校验；只有「被我们改过」（中文补丁）的版本才跳过，理由与库文件一致。
   */
  if (existsNonEmpty(jarPath) && !skip) {
    const clientDl = resolved.downloads && resolved.downloads.client;
    if (clientDl && clientDl.sha1) {
      try {
        const actual = await sha1File(jarPath);
        if (actual.toLowerCase() !== String(clientDl.sha1).toLowerCase()) {
          corrupted.push({
            kind: 'client-jar',
            path: jarPath,
            name: jarName,
            expected: clientDl.sha1,
            actual,
            url: clientDl.url,
            size: clientDl.size,
            critical: true,
            // 说明清楚：这不是「你装了模组」，而是文件真的坏了
            reason: '客户端 jar 内容与官方记录不一致（可能下载中断或被改动）'
          });
        }
      } catch {
        /* 读不了文件就当没校验成功，不误报 */
      }
    }
  }

  /**
   * ---- 3. 库文件（存在性 + sha1）----
   *
   * ★★★ 2026-11-05：改用**共享目录**。
   *   以前这里是 `path.join(minecraftDir, 'libraries')`（实例内路径），
   *   但目录布局已改成「libraries / assets 多实例共享」（照 HMCL）：
   *       旧：<home>/instances/<id>/.minecraft/libraries
   *       新：<home>/.minecraft/libraries
   *   不改的话，这里会去旧路径找 → 明明库都在却报「缺失」→ 疯狂重下。
   *   传入 `home` 时走 paths 的共享路径；没传（老调用方）才退回 minecraftDir 兼容。
   */
  const pathsMod = require('./paths');
  const librariesDir = opts.home ? pathsMod.sharedLibrariesDir(opts.home) : path.join(minecraftDir, 'libraries');

  /**
   * ★ 只检查**当前平台适用**的库（2026-11-05）。
   *
   * 以前直接遍历 `resolved.libraries` 全量列表 —— 里面包含
   * `lwjgl-xxx:natives-linux` / `natives-macos` / `natives-macos-arm64` 这些
   * **别的平台**的原生库。它们本来就不该下载，却每次都被算成「缺失」，
   * 于是日志里固定出现一句「有 40 个非关键文件缺失」，
   * 让用户以为装坏了（实测 26.3 稳定报 40 个）。
   *
   * ⇒ 用 libraries.resolveLibraries() 先按 rules 过滤出当前平台的库，只查这些。
   *   过滤失败时退回全量（宁可多报，不可漏报关键库）。
   */
  let libs = Array.isArray(resolved.libraries) ? resolved.libraries : [];
  try {
    // eslint-disable-next-line global-require
    const librariesMod = require('./libraries');
    // eslint-disable-next-line global-require
    const rulesMod = require('./rules');
    const applicable = librariesMod.resolveLibraries(resolved, {
      osInfo: rulesMod.currentOs(),
      source: opts.source || 'official'
    });
    if (Array.isArray(applicable) && applicable.length) {
      const keepPaths = new Set(
        applicable.map((e) => e && e.artifactPath).filter((p) => typeof p === 'string' && p)
      );
      const filtered = libs.filter((lib) => {
        const p = lib && lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path;
        return p ? keepPaths.has(p) : false;
      });
      // 过滤后不能为空（否则说明规则解析出了问题，保守起见用全量）
      if (filtered.length) libs = filtered;
    }
  } catch {
    /* 过滤失败就用全量，不影响正确性（只是多几句提示） */
  }

  for (const lib of libs) {
    const artifact = lib && lib.downloads && lib.downloads.artifact;
    if (!artifact || !artifact.path) continue;
    const file = path.join(librariesDir, artifact.path.split('/').join(path.sep));
    if (!existsNonEmpty(file)) {
      missing.push({ kind: 'library', path: file, name: artifact.path, critical: false, url: artifact.url, sha1: artifact.sha1 });
      continue;
    }
    if (artifact.sha1) {
      const actual = await sha1File(file);
      if (actual.toLowerCase() !== String(artifact.sha1).toLowerCase()) {
        corrupted.push({ kind: 'library', path: file, name: artifact.path, expected: artifact.sha1, actual });
      }
    }
  }

  // ---- 4. 资源索引（缺了就没法补音频，但游戏照样进 —— 不拦）----
  const ai = resolved.assetIndex;
  if (ai && ai.id) {
    // ★ 同样改用共享 assets 目录（见上面 libraries 的说明）
    const assetsRoot = opts.home ? pathsMod.sharedAssetsDir(opts.home) : path.join(minecraftDir, 'assets');
    const indexFile = path.join(assetsRoot, 'indexes', `${ai.id}.json`);
    if (!existsNonEmpty(indexFile)) {
      missing.push({ kind: 'asset-index', path: indexFile, name: `${ai.id}.json`, critical: false, url: ai.url, sha1: ai.sha1 });
    } else if (ai.sha1) {
      const actual = await sha1File(indexFile);
      if (actual.toLowerCase() !== String(ai.sha1).toLowerCase()) {
        corrupted.push({ kind: 'asset-index', path: indexFile, name: `${ai.id}.json`, expected: ai.sha1, actual });
      }
    }
  }

  return {
    ok: missing.filter((m) => m.critical).length === 0,
    skipContentCheck: false,
    reason: '',
    missing,
    corrupted
  };
}

/**
 * 只补「关键文件缺失」（jar / json），其余交给安装流程。
 * 给「不检查游戏文件」模式下的启动前兜底用。
 *
 * @returns {Promise<{repaired:string[], failed:string[]}>}
 */
async function repairCriticalFiles(opts = {}) {
  const { versionDir, versionId, downloader, source } = opts;
  const repaired = [];
  const failed = [];
  if (!downloader) return { repaired, failed };

  const jarPath = path.join(versionDir, `${versionId}.jar`);
  if (!existsNonEmpty(jarPath) && opts.clientUrl) {
    try {
      await downloader.downloadAll(
        [{ url: opts.clientUrl, dest: jarPath, name: `${versionId}.jar`, sha1: opts.clientSha1 }],
        { threads: 1, source: source || 'official' }
      );
      repaired.push(`${versionId}.jar`);
    } catch (err) {
      failed.push(`${versionId}.jar：${err?.message || err}`);
    }
  }
  return { repaired, failed };
}

/**
 * ★★★ 自动修复损坏/缺失的文件（2026-11-05 新增）。
 *
 * 为什么需要：`checkGameFiles()` 早就**能检测**出损坏（它会报「N 个文件内容与官方记录不一致」），
 * 但以前**只警告不修复** —— 用户看到提示却不知道怎么办，
 * 结果就是 26.3.jar / fastutil / icu4j 坏了之后一直启动不了。
 *
 * ⇒ 现在把它做成一次真正的修复：按 sha1 重新下载，下完再校验一遍，校验不过就报失败（不写坏文件）。
 *
 * @param {object} opts
 * @param {Array} opts.corrupted  checkGameFiles 返回的 corrupted 数组
 * @param {Array} [opts.missing]  checkGameFiles 返回的 missing 数组（只有带 url 的能修）
 * @param {object} opts.downloader
 * @param {string} [opts.source]
 * @param {function} [opts.onProgress]  (done, total, name) => void
 * @returns {Promise<{repaired:Array, failed:Array}>}
 */
async function repairFiles(opts = {}) {
  const { downloader } = opts;
  const repaired = [];
  const failed = [];
  if (!downloader) return { repaired, failed: [{ name: '(内部错误)', error: '没有传 downloader' }] };

  // 待修列表：损坏的 + 缺失但有下载地址的
  const tasks = [];
  for (const c of opts.corrupted || []) {
    if (c.url) tasks.push({ kind: c.kind, name: c.name, path: c.path, url: c.url, sha1: c.expected });
  }
  for (const m of opts.missing || []) {
    if (m.url) tasks.push({ kind: m.kind, name: m.name, path: m.path, url: m.url, sha1: m.sha1 });
  }
  if (!tasks.length) return { repaired, failed };

  const total = tasks.length;
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    if (typeof opts.onProgress === 'function') {
      try {
        opts.onProgress(i, total, t.name);
      } catch {
        /* 进度回调异常不影响修复 */
      }
    }
    try {
      await downloader.downloadAll(
        [{ url: t.url, dest: t.path, name: t.name, sha1: t.sha1 }],
        { threads: 1, source: opts.source || 'official' }
      );
      // 下完再校验一遍，确认真的修好了
      if (t.sha1 && fs.existsSync(t.path)) {
        const actual = await sha1File(t.path);
        if (actual.toLowerCase() !== String(t.sha1).toLowerCase()) {
          failed.push({ name: t.name, error: `下载后校验仍不符（${actual}）` });
          continue;
        }
      }
      repaired.push({ kind: t.kind, name: t.name });
    } catch (err) {
      failed.push({ name: t.name, error: err?.message || String(err) });
    }
  }

  if (typeof opts.onProgress === 'function') {
    try {
      opts.onProgress(total, total, '');
    } catch {
      /* 忽略 */
    }
  }

  return { repaired, failed };
}

module.exports = {
  checkGameFiles,
  repairFiles,
  detectAppliedChinesePack,
  detectLoaderModifiedJar,
  shouldSkipIntegrity,
  repairCriticalFiles,
  sha1File,
  existsNonEmpty
};
