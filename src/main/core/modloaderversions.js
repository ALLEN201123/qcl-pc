'use strict';
/*
 * modloaderversions.js —— Risugami's ModLoader 版本表与下载地址。
 *
 * ★ 逐条照抄安卓版（QCL 1.5.2）：
 *   backup_code_1.5.2/QCL/src/main/java/com/qcl/launcher/launcher/download/modloader/ModLoaderVersions.java
 *   （那份表本身是照着 MCArchive 官方清单逐条核对 SHA-256 得来的，别自己改哈希）
 *
 * 【为什么可以直接下】
 * MCArchive 的直链规律（安卓版 2026-09-21 实测确认）：
 *     https://b2.mcarchive.net/file/mcarchive/<SHA256>/<URLEncoder(文件名)>
 * 实测 1.6.2 / b1.8.1 / b1.7.3 / b1.3_01v5 全部 HTTP 200 ——
 * **包括页面上标着「无直链、只有 MediaFire」的 b1.7.3**：文件本来就在它自家 CDN 上，
 * URL 由 SHA-256 决定。所以不需要 MediaFire，也不需要第三方镜像。
 * 每个文件下载后都要校验 SHA-256。
 *
 * 【装法】
 * 下载下来是个 zip（.jar 也可以，jar 本身就是 zip），里面是一堆 .class：
 *   1.6.2  → BaseMod.class / ModLoader.class / EntityRendererProxy.class …（26 个）
 *   b1.7.3 → yv.class / BaseMod.class / hl.class …（15 个，含混淆名）
 * 直接覆盖进 minecraft.jar 即可（见 core/modloader.js），不需要 tweakClass、不需要依赖库。
 *
 * 【b1.7.3 为什么用社区修复版】
 * 官方 Risugami ModLoader 在 b1.7.3 + 现代 Java 下会抛 `URI is not hierarchical`，
 * 然后卡死在 `ModLoader Beta 1.7.3 Initializing...`（用户实机验证过）。
 * 修复版 coffeenotfound/ModloaderFix-b1.7.3 是**完整版**，不用先装坏的再覆盖。
 *
 * ★★★ 2026-11-05 实测修正（安卓版的 Gitee 镜像已失效，别照抄 URL）：
 *   安卓版里 7 条 putCustom 的地址是 `gitee.com/allne201123/qcl-repo/raw/master/modloader/…`，
 *   实测现在**全部 404**（Gitee 返回 "Repository or file not found"；该仓库还在，
 *   但 git tree 里根本没有 modloader/ 这个目录，所有分支都没有）。
 *   ⇒ 处理方式（哈希全部实测核对过）：
 *     · b1.7.3 修复版 → 改用**官方 GitHub Release 资产**（coffeenotfound/ModloaderFix-b1.7.3
 *       v1.0.0 的 ModLoader.Fix.b1.7.3-1.0.0.jar）。实测下载 74,686 字节，
 *       SHA-256 = 725591f1…f4f1e8c **与安卓版表里的值完全一致**（Gitee 那份就是它的副本）。
 *     · a1.2.3_04 → 改回 **MCArchive 官方 zip**（安卓版表里本来就有这条 put，
 *       后面被 putCustom 用失效的 Gitee 地址覆盖了；实测 zip 直链 200、SHA-256 与表内一致）。
 *     · a1.2.6 / a1.2.2 / a1.2.1_01 / a1.2.0_02 / 1.1 → MCArchive 上**只有 .rar**
 *       （启动器解不开），Gitee 重打包 zip 又已失效 ⇒ 登记为「暂时不可安装」，
 *       并在 entry.note 里写清原因（界面据此显示灰掉 + 原因，install 会直接抛中文提示）。
 */

/** MCArchive 基础地址：下载地址 = BASE + sha256 + '/' + 文件名 */
const BASE = 'https://b2.mcarchive.net/file/mcarchive/';

/**
 * b1.7.3 社区修复版（官方 GitHub Release 资产；Gitee 镜像已失效）
 * 实测 SHA-256 = 725591f1e27624f210206e057f9a38b85f28b955bb7ff25bf2ee2449994f1e8c
 */
const B173_FIX_URL = 'https://github.com/coffeenotfound/ModloaderFix-b1.7.3/releases/download/v1.0.0/ModLoader.Fix.b1.7.3-1.0.0.jar';

/** 安卓版用过的 Gitee 镜像前缀（★ 已失效，仅作记录，不要再拿来下载） */
const GITEE_MODLOADER_DEAD = 'https://gitee.com/allne201123/qcl-repo/raw/master/modloader/';

/** 5 个「只有 .rar / Gitee 镜像已失效」条目的统一说明 */
const RAR_ONLY_NOTE =
  '这个版本的 ModLoader 官方只提供 .rar 压缩包（启动器解不开 rar），' +
  'Gitee 上的 .zip 重打包镜像已失效（实测 404），所以暂时装不了。';

/** 键 = 对应的 Minecraft 版本 id（要和版本目录名对得上），值 = 条目 */
const TABLE = new Map();

/**
 * 造一个条目。
 * @param {string} mcVersion
 * @param {string} fileName
 * @param {string|null} sha256 小写 SHA-256；为空表示这个条目不做校验
 * @param {string|null} customUrl 非空时直接用这个地址（社区修复版 / Gitee 重打包）
 */
function makeEntry(mcVersion, fileName, sha256, customUrl) {
  const lower = String(fileName || '').toLowerCase();
  const archiveType = lower.endsWith('.rar') ? 'rar' : 'zip';
  return {
    mcVersion,
    fileName,
    sha256: sha256 ? String(sha256).toLowerCase() : null,
    archiveType,
    customUrl: customUrl || null,
    // zip / jar 都能用内置解压；rar 解不开
    installable: archiveType === 'zip',
    hasChecksum: !!(sha256 && String(sha256).length),
    // 下载源是否还活着（2026-11-05：Gitee 镜像失效的 5 条标 false）
    available: true,
    note: null,
  };
}

function put(mcVersion, fileName, sha256) {
  TABLE.set(mcVersion, makeEntry(mcVersion, fileName, sha256, null));
}

function putCustom(mcVersion, fileName, sha256, customUrl) {
  TABLE.set(mcVersion, makeEntry(mcVersion, fileName, sha256, customUrl));
}

/** 登记一个「源已失效 / 只有 rar」的条目：仍然保留信息，但标记不可安装。 */
function putUnavailable(mcVersion, fileName, sha256, customUrl, note) {
  const entry = makeEntry(mcVersion, fileName, sha256, customUrl);
  entry.available = false;
  entry.note = note || RAR_ONLY_NOTE;
  TABLE.set(mcVersion, entry);
}

/**
 * 文件名 URL 编码：照 Java 的 `URLEncoder.encode(name, "UTF-8").replace("+", "%20")`。
 * （文件名里有空格，Java 会先编成 '+' 再换成 %20；Node 的 encodeURIComponent 直接给 %20，
 *   但不会编码 ! ' ( ) *，这里补上以严格对齐。）
 */
function encodeFileName(name) {
  return encodeURIComponent(String(name || ''))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 某个条目的下载地址。 */
function urlOf(entry) {
  if (!entry) return null;
  if (entry.customUrl) return entry.customUrl;
  if (!entry.sha256) return null; // 没有 sha256 就拼不出 MCArchive 直链
  return `${BASE}${entry.sha256}/${encodeFileName(entry.fileName)}`;
}

/* ------------------------------------------------------------------ 版本表
 * 顺序与安卓版一致：新的在前（UI 直接顺序展示）。
 * ★ 哈希逐条照抄，不要改（改了就会校验失败）。
 * ------------------------------------------------------------------------- */
// ---- 正式版（全部 .zip）----
put('1.6.2', 'ModLoader 1.6.2.zip', '0b14f5e261c9862989aa74313b59188cce10bea6724bae31130ce1e8e6a1c060');
put('1.6.1', 'ModLoader 1.6.1.zip', '95fc5afdd9cc14d85cb41225fb689d7994f5994287ed9595e192026c06e7b536');
put('1.5.2', 'ModLoader 1.5.2.zip', '0c355696c2f3ba405bb1f0f845dc51a6613c121eac25a6c7bc9d8046f2c941df');
put('1.5.0', 'ModLoader 1.5.0.zip', 'af7d7bca70b8bc08c75e96ec90a25432682dfc825aa4fe35485dcb390b1f7014');
put('1.5', 'ModLoader 1.5.zip', '597d4d437a250986da84a9c7aee3ea653739608caf1d4a208f2006d8cbdfbc3d');
put('1.4.7', 'ModLoader 1.4.7.zip', '685ead73c19531cf24062c7536737663421ed4170cfa582baddbbf6cba1544d2');
put('1.4.6', 'ModLoader 1.4.6.zip', 'f69b1f99b76c23cc1e076197375996e3b79feb369952ac692630f7b063709d5f');
put('1.4.5', 'ModLoader 1.4.5.zip', '885b62bde6231b04d0189a06b082edfa48ea1474f22a5502ab40288563036b42');
put('1.4.4', 'ModLoader 1.4.4.zip', '7d39b6d5e41bcd77edabd0aca3b43a10861a65ee9c2f9b358cedf8382d69c14e');
put('1.4.2', 'ModLoader 1.4.2.zip', '861324b55c40e4af622e2a987c3c20ed4eb869ea89a004c93222058e394baec4');
put('1.3.2', 'ModLoader 1.3.2.zip', '01a28a0a3d05634ce8745d34738b0617ddb285ad1584fb668874892c61e489eb');
put('1.3.1', 'ModLoader 1.3.1.zip', '511881d7432cf740b753180a645ca6abb7cd63d09813e0089485c125d52c09a0');
put('1.2.5', 'ModLoader 1.2.5.zip', '219370a86a15bfef8ff91f51fdd151e99391b771759183b19f72197452a28b79');

// ---- Beta（.zip 的那批）----
put('b1.9p5', 'ModLoader B1.9p5.zip', '666e9f28927db986a92be437335add82ccd0a1b4c111703d4950b075944e92f8');
put('b1.8.1', 'ModLoader B1.8.1.zip', '4135de0b0fddf6f9b39761a5261b82dae278b311237ec1cd936911b0b133919e');
// ★ b1.7.3 必须用社区修复版（官方版会卡死在 "ModLoader Beta 1.7.3 Initializing..."）
putCustom(
  'b1.7.3',
  'ModLoader.Fix.b1.7.3-1.0.0.jar',
  '725591f1e27624f210206e057f9a38b85f28b955bb7ff25bf2ee2449994f1e8c',
  B173_FIX_URL
);
put('b1.7.2', 'ModLoader B1.7.2.zip', '2b4e0e19b817a464ef32042a12f3ba1d8e4db25a01a1bb19efe8a5d9713a003c');
put('b1.5_01v4', 'ModLoader B1.5_01v4.zip', 'c20df06b803903de5f7768107c27c80bbdbeb896003a93391432cf29bb7110cd');
put('b1.4_01', 'ModLoader B1.4_01.zip', 'a1fdf3b4698bfe1d29c8b9ec9f40905d9b436f19d9d630b4ace6b133cbf3560f');
put('b1.3_01v5', 'ModLoader B1.3_01v5.zip', 'b628f9fa608888f4d3c47c360a9c40c5b7a32eba52e9679f717f613548edc2c0');
put('b1.3_01', 'ModLoader B1.3_01.zip', '7f6ce7bb223cb28690d65864f786d212f1bf3ff5cf9853c8ea86f5233dc2e0e1');
put('b1.2_02v4', 'ModLoader B1.2_02v4.zip', 'c5b3a4d72da03fcee9f8359c4c37f79f8a574d8b5987a849c35cbd4f79c9a87b');

// ---- Alpha（.zip 的）----
// ★ 安卓版这里先 put 了 MCArchive 的 zip，后面又被 putCustom 用 Gitee 重打包地址覆盖；
//   但那个 Gitee 地址已失效（实测 404），而 MCArchive 的 zip 仍然可用
//   （实测 HTTP 200、20,653 字节、SHA-256 与下面这个值一致）⇒ 用回 MCArchive 官方 zip。
put('a1.2.3_04', 'ModLoader A1.2.3_04.zip', '5c44c13470829c304a84823af4547362065f5252c070510eea2e5f4580ac09b2');

// ---- 只有 .rar（MCArchive）/ Gitee 重打包 zip 已失效的条目 ----
// ★ 这些条目**暂时装不了**：MCArchive 原文件是 .rar（内置解压解不开），
//   安卓版当年用 7-Zip 解开重打成 zip 传到 Gitee —— 那个 Gitee 目录现在不存在了（实测全 404）。
//   保留 customUrl 仅作记录；install() 会直接抛 entry.note 里的中文原因。
putUnavailable('a1.2.6', 'ModLoader-a1.2.6.zip', '6a7a1a7baff97e6011c789b8e9caa2c55560b6cf4fa9a717cedac31ead59a4e0', `${GITEE_MODLOADER_DEAD}ModLoader-a1.2.6.zip`);
putUnavailable('a1.2.2', 'ModLoader-a1.2.2.zip', 'a0292bda7c3554b35f244a51277a4bfd7985414e974814b37ac41a355d960147', `${GITEE_MODLOADER_DEAD}ModLoader-a1.2.2.zip`);
putUnavailable('a1.2.1_01', 'ModLoader-a1.2.1_01.zip', '52b2683776cd516f3d9194727450ce4f026c31d58cbf1c42341c32b4b8fb4cfa', `${GITEE_MODLOADER_DEAD}ModLoader-a1.2.1_01.zip`);
putUnavailable('a1.2.0_02', 'ModLoader-a1.2.0_02.zip', '3ae688492df3564e4d0aa3bc2140d1991456c254c68be6d62f5f6182d9882a71', `${GITEE_MODLOADER_DEAD}ModLoader-a1.2.0_02.zip`);
putUnavailable('1.1', 'ModLoader-1.1.zip', 'eeafb39390bb9da56a4ed108d82ab2e96344b2aac68668096c9a83e8f1147e0e', `${GITEE_MODLOADER_DEAD}ModLoader-1.1.zip`);

/* --------------------------------------------------------------- 查询接口 */

/**
 * 查某个 MC 版本有没有 ModLoader。
 *
 * 精确命中优先；找不到再做一次「版本 id 带后缀」的宽松匹配
 * （例如 `b1.7.3-modded` / `b1.7.3-forge` 能匹配到 `b1.7.3`）。
 *
 * ★ 比安卓版多一道「版本边界」检查：安卓版是无脑 `mcVersion.startsWith(key)`，
 *   结果 `1.12.2` 会命中 `1.1`（因为 "1.12.2".startsWith("1.1") 为真），
 *   把一个 1.1 时代的 ModLoader 装进 1.12.2 的 jar 里 —— 直接毁版本。
 *   这里要求命中位置的下一个字符**不是数字也不是点**（`-` / `_` / 字母都可以），
 *   并且在多个候选里取最长匹配。
 *
 * @param {string} mcVersion
 * @returns {object|null}
 */
function find(mcVersion) {
  const key = String(mcVersion == null ? '' : mcVersion).trim();
  if (!key) return null;
  if (TABLE.has(key)) return TABLE.get(key);

  let bestKey = null;
  for (const candidate of TABLE.keys()) {
    if (candidate === key) continue;
    if (!key.startsWith(candidate)) continue;
    const next = key.charAt(candidate.length);
    // 命中的是「前缀」：后面必须结束或接分隔符/字母，不能接数字或点
    if (/[0-9.]/.test(next)) continue;
    if (!next) continue; // 空串已经走精确分支了
    if (!bestKey || candidate.length > bestKey.length) bestKey = candidate;
  }
  return bestKey ? TABLE.get(bestKey) : null;
}

/** 全部条目（新的在前，与安卓版顺序一致）。 */
function all() {
  return Array.from(TABLE.values());
}

/** 现在**真的能装**的条目（zip/jar 且下载源没失效）。 */
function installable() {
  return all().filter((entry) => entry.installable && entry.available);
}

/** 只登记了、但暂时装不了的条目（rar / 源失效），带 note 说明原因。 */
function unavailable() {
  return all().filter((entry) => !entry.installable || !entry.available);
}

/** 给 UI 用的简短说明，例如 `ModLoader b1.7.3`。 */
function labelOf(entry) {
  return entry ? `ModLoader ${entry.mcVersion}` : null;
}

module.exports = {
  BASE,
  B173_FIX_URL,
  RAR_ONLY_NOTE,
  find,
  all,
  installable,
  unavailable,
  urlOf,
  encodeFileName,
  labelOf,
};
