'use strict';
/**
 * QCL 电脑版 · 远古版本中文补丁（完整移植安卓版 LegacyChinesePack）
 *
 * 覆盖范围：**76 条规则 / 70 个补丁目录**（照搬安卓版 B19_PACKS + EXTRA_PACKS），
 * 涵盖 alpha / beta / infdev / indev / classic / pre-classic 全系。
 *
 * ## 它解决什么问题
 * 远古版本的字体是**固定 256 个 ASCII 字模**，一个汉字都没有 —— 不换字体，中文全是方框。
 *
 * ## 怎么解决
 * 把补丁文件写进**游戏 jar 并重建**：换掉该版本自己的 FontRenderer 类，
 * 注入中文点阵（glyph_*.png）、font.txt、lang 文件。
 *
 * ## 三条铁律（都是踩坑换来的，见 docs/CHINESE_PACK.md）
 *   1. **只能跳过「本版本自己那个 FontRenderer」** —— 同名类在不同版本可能是完全不同的东西
 *      （`sj` 在 b1.7.3 是字体、在 b1.6 是别的类），乱跳会让游戏崩。
 *   2. **必须丢弃 Mojang 签名**（`META-INF/*.SF|DSA|RSA`）并清理 MANIFEST 摘要，
 *      否则 JVM 的 JarVerifier 抛 `SHA1 digest error`，游戏在建主界面时就崩。
 *   3. **输入以当前 jar 为准**，不要用 `.orig` 重建，否则会把玩家后加的 mod class 覆盖掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');

/** 语言常量 */
const LANG_ZH = 'zh_CN';
const LANG_EN = 'en_US';

/** 语言标记文件 */
const MARKER = '.cnpack_lang';

/* ------------------------------------------------------- 规则表（数据驱动） */

let RULES = null;

/**
 * 载入规则表（chinese-packs.json，由 build/extract-chinesepacks.js 从安卓版抽取）。
 * 每条规则编译成 { regex, dir, fontClass, extraClasses, isFullPath }。
 */
function loadRules() {
  if (RULES) return RULES;
  const file = path.join(DATA_DIR, 'chinese-packs.json');
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[QCL] 中文补丁规则表读取失败：${err?.message || err}`);
    RULES = [];
    return RULES;
  }

  const compile = (list) =>
    list.map((item) => {
      let regex = null;
      try {
        regex = new RegExp(item.regex);
      } catch (err) {
        console.warn(`[QCL] 中文补丁规则正则非法（${item.regex}）：${err?.message || err}`);
        return null;
      }
      return {
        regex,
        idle: item.regex,
        dir: item.dir,
        fontClass: item.fontClass,
        // 类名带包路径的（classic / indev / infdev）在 jar 里就要保持目录结构
        isFullPath: item.fontClass.includes('/'),
        // 该目录下有哪些额外类文件（运行时探测，缓存）
        extraClasses: null
      };
    }).filter(Boolean);

  RULES = [...compile(raw.b19 || []), ...compile(raw.extra || [])];

  /**
   * ★★★ 补一条「默认兜底规则」：b1.7.3 本身。
   *
   * 安卓版里 b1.7.3 **不在 EXTRA_PACKS 表里**，它走的是另一条路：
   *     private static final String[] SUPPORTED_PREFIXES = {"b1.7.3"};
   *     ...
   *     for (String p : SUPPORTED_PREFIXES) if (low.contains(p)) return true;
   * 命中后使用默认主包 `ASSET_DIR = "cn_b173"`（字体类 sj + co + QclLangScreen）。
   *
   * 而 EXTRA_PACKS 里的 `b1\.7(_01|\.2)?$` 只匹配 `b1.7` / `b1.7_01` / `b1.7.2`，
   * **不匹配 `b1.7.3`** —— 我第一版只搬了 EXTRA_PACKS，于是 b1.7.3 反过来失效了（已复现）。
   * ⇒ 这里显式补上，用 contains 语义（改过名的版本如「b1.7.3东上」也能命中）。
   */
  try {
    RULES.push({
      regex: /b1\.7\.3/i, // 用 test 时等价于 contains
      idle: 'b1.7.3（默认主包）',
      dir: 'cn_b173',
      fontClass: 'sj',
      isFullPath: false,
      extraClasses: null,
      isDefault: true
    });
  } catch {
    /* 正则不可能非法 */
  }

  // 默认规则放最前面，避免被更宽泛的规则抢走
  RULES.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));

  return RULES;
}

/** 找出某个版本对应的补丁规则（没有则 null） */
function ruleFor(versionId) {
  const id = String(versionId || '');
  for (const rule of loadRules()) {
    if (rule.regex.test(id)) return rule;
  }
  return null;
}

/** 这个版本是否由中文包支持 */
function isSupported(versionId) {
  return !!ruleFor(versionId);
}

/** 支持的全部版本正则（给界面显示用） */
function supportedPatterns() {
  return loadRules().map((r) => ({ regex: r.idle, dir: r.dir }));
}

/* ------------------------------------------------------------------ 工具 */

function readFileSafe(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** 递归读目录下全部文件 → [{ name:'a/b.png', data:Buffer }] */
function readDirFiles(rootDir, subPath = '') {
  const out = [];
  const dir = subPath ? path.join(rootDir, subPath) : rootDir;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = subPath ? `${subPath}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...readDirFiles(rootDir, rel));
    else out.push({ name: rel, data: fs.readFileSync(path.join(dir, e.name)) });
  }
  return out;
}

/** 解析 lang 的 `键=值` */
function parseLang(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq > 0) map.set(s.slice(0, eq).trim(), s.slice(eq + 1));
  }
  return map;
}

/** overlay 叠加：主 lang 已有的键用 overlay 值替换，overlay 独有的键追加 */
function overlayLang(mainBytes, overlayBytes) {
  if (!overlayBytes) return mainBytes;
  const text = mainBytes.toString('utf8');
  const ov = parseLang(overlayBytes.toString('utf8'));
  if (ov.size === 0) return mainBytes;
  const out = [];
  for (const line of text.split('\n')) {
    const hasCR = line.endsWith('\r');
    const raw = hasCR ? line.slice(0, -1) : line;
    if (!raw.startsWith('#')) {
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const key = raw.slice(0, eq).trim();
        if (ov.has(key)) {
          out.push(`${key}=${ov.get(key)}${hasCR ? '\r' : ''}`);
          ov.delete(key);
          continue;
        }
      }
    }
    out.push(line);
  }
  for (const [k, v] of ov) out.push(`${k}=${v}`);
  return Buffer.from(out.join('\n'), 'utf8');
}

/* ------------------------------------------------------------- 签名处理 */

/**
 * ★★★ 丢掉 Mojang 签名块。
 * 原版 jar 带 `META-INF/MOJANG_C.SF` + `MOJANG_C.DSA`，每个条目在 MANIFEST 里都有 SHA1 摘要。
 * 我们改过文件内容后，JVM 的 JarVerifier 会抛：
 *     java.lang.SecurityException: SHA1 digest error for lang/en_US.lang
 * 游戏在 `Minecraft.<init>` 阶段直接崩，连主界面都进不去（实测）。
 */
function isSignatureFile(name) {
  return /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i.test(name);
}

/** 清掉 MANIFEST.MF 里的逐条目摘要，只保留主属性段 */
function stripManifestEntries(manifestBuf) {
  const lines = manifestBuf.toString('utf8').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line) break; // 空行 = 主属性段结束，后面全是条目摘要
    out.push(line);
  }
  return Buffer.from(`${out.join('\r\n')}\r\n\r\n`, 'utf8');
}

/* ------------------------------------------------------- 条目跳过判定 */

/** 这个 jar 条目是否要被补丁替换 */
function shouldSkipEntry(name, rule) {
  if (!name || !rule) return false;
  const low = name.toLowerCase();

  // 1. 本版本自己的 FontRenderer（可能是 sj.class，也可能是 com/mojang/minecraft/b/h.class）
  const fontEntry = rule.isFullPath ? `${rule.fontClass}.class` : `${rule.fontClass}.class`;
  if (low === fontEntry.toLowerCase()) return true;

  // 2. 字体资源与语言文件：一律由补丁提供
  if (/^font\/glyph_[0-9a-f]{2}\.png$/i.test(name)) return true;
  if (low === 'font.txt') return true;
  if (low === 'font/glyph_sizes.bin') return true;
  if (low === 'lang/en_us.lang') return true;
  if (low === 'lang/stats_us.lang') return true;
  if (low === 'lang/zh_cn.lang') return true;
  if (low === 'lang/stats_zh_cn.lang') return true;
  if (low === 'title/splashes.txt') return true;

  return false;
}

/* ---------------------------------------------------------- 补丁条目组装 */

/**
 * 找出该版本对应的界面翻译 jar（`cn_a1v_<版本>_tr.jar`）。
 *
 * ★ 这是「界面文字变中文」的关键，和「字体能显示中文」是两件事：
 *   字体补丁负责让游戏能画出汉字；tr.jar 负责把界面上的英文短语换成中文
 *   （用 ASM 替换 LDC 字符串常量，见记忆 topics/10「界面翻译」）。
 *
 * ★ 安卓版的触发条件（LegacyChinesePack.java:455）：
 *     trJarName = (extra != null || v10v) ? "cn_a1v_<id去符号>_tr.jar" : null;
 *   也就是「命中 EXTRA_PACKS 的版本」或「1.0 正式版」才有 tr.jar。
 *   b1.7.3 走默认主包（不在 EXTRA_PACKS），它靠 lang/zh_CN.lang 做界面翻译，不需要 tr.jar。
 *
 * @returns {string|null} 文件名（在 DATA_DIR 下），没有则 null
 */
function findTranslationJar(versionId, rule) {
  const id = String(versionId || '');
  // 与安卓版同样的命名规则：非字母数字全换成下划线
  const normalized = id.replace(/[^A-Za-z0-9]/g, '_');
  const candidates = [
    `cn_a1v_${normalized}_tr.jar`,
    // 有些版本的归档 id 与下载到的名字不完全一致，再试几个变体
    `cn_a1v_${normalized.toLowerCase()}_tr.jar`
  ];
  // 1.0 正式版：安卓版用 cn_a1v_1_0_tr.jar
  if (/^1\.0(\.0)?$/i.test(id)) candidates.unshift('cn_a1v_1_0_tr.jar');

  for (const name of candidates) {
    const file = path.join(DATA_DIR, name);
    if (fs.existsSync(file)) return name;
  }

  // 兜底：在 data 目录里找一找有没有「去掉分隔符后能对上」的 tr.jar
  try {
    const all = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('cn_a1v_') && f.endsWith('_tr.jar'));
    const key = normalized.toLowerCase().replace(/_/g, '');
    const hit = all.find((f) => f.replace(/^cn_a1v_/, '').replace(/_tr\.jar$/, '').replace(/_/g, '').toLowerCase() === key);
    if (hit) return hit;
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * 读一个 tr.jar 里的全部条目（含内部路径，如 `net/minecraft/client/gui/GuiMainMenu.class`）。
 * @returns {{name:string, data:Buffer}[]}
 */
function readTranslationJar(jarName) {
  const file = path.join(DATA_DIR, jarName);
  if (!fs.existsSync(file)) return [];
  try {
    const { readZip } = require('./zipwriter');
    return readZip(file)
      .filter((e) => !e.isDirectory)
      .map((e) => ({ name: e.name, data: e.data }));
  } catch (err) {
    console.warn(`[QCL] 读取界面翻译 jar 失败（${jarName}）：${err?.message || err}`);
    return [];
  }
}

/**
 * 读补丁目录，组装要写进 jar 的条目。
 *
 * ★★★ 关键结构（照安卓版 LegacyChinesePack 的真实做法，我核对过源码）：
 *   每个 `cn_*` 目录**只放该版本自己的 FontRenderer 类**（通常就 1 个 .class，如
 *   `cn_a1g01/em.class`、`cn_classic_g1/h.class`），
 *   而 `font.txt` / `glyph_*.png` / `lang/*` / `title/splashes.txt`
 *   全部来自**主包 `cn_b173`** —— 安卓版代码里 `ASSET_DIR = "cn_b173"` 是写死的，
 *   第 529/530/552-561 行都是从 ASSET_DIR 取这些资源。
 *
 *   ⇒ 所以这里分两处取材：
 *      · 字体类：该规则自己的目录（rule.dir）
 *      · 字体资源与语言：主包 cn_b173（若某目录自己也带了，优先用它自己的）
 */
const BASE_PACK_DIR = 'cn_b173';

function buildPatchEntries(packDir, rule, lang) {
  const entries = [];

  // 1. 本版本自己的字体类（来自 rule.dir）
  const ownFiles = readDirFiles(packDir);
  const ownClassFiles = ownFiles.filter((f) => f.name.toLowerCase().endsWith('.class'));
  for (const f of ownClassFiles) entries.push(f);

  // 2. 字体资源与语言：优先用自己目录里的，缺的从主包补
  const baseDir = path.join(DATA_DIR, BASE_PACK_DIR);
  const baseFiles = fs.existsSync(baseDir) ? readDirFiles(baseDir) : [];
  const pick = (predicate) => ownFiles.find(predicate) || baseFiles.find(predicate) || null;

  // font.txt
  const fontTxt = pick((f) => /^font\.txt$/i.test(f.name));
  if (fontTxt) entries.push({ name: 'font.txt', data: fontTxt.data });

  // 字体点阵：整套都从主包取（Mojang 官方中文点阵，各版本通用）
  const glyphSource = ownFiles.some((f) => /glyph_[0-9a-f]{2}\.png$/i.test(f.name)) ? ownFiles : baseFiles;
  for (const f of glyphSource) {
    const m = f.name.match(/^(?:font\/)?(glyph_[0-9A-Fa-f]{2}\.png|glyph_sizes\.bin)$/);
    if (m) entries.push({ name: `font/${m[1]}`, data: f.data });
  }

  // 3. 语言文件
  const byOwn = new Map(ownFiles.map((f) => [f.name.toLowerCase(), f]));
  const byBase = new Map(baseFiles.map((f) => [f.name.toLowerCase(), f]));
  const pickFile = (name) => byOwn.get(name) || byBase.get(name) || null;

  const zhMain = pickFile('lang/zh_cn.lang') || pickFile('lang/en_us.lang');
  const enOrig = pickFile('lang/en_us_orig.lang');
  const zhStats = pickFile('lang/stats_zh_cn.lang');
  const enStats = pickFile('lang/stats_us_orig.lang') || pickFile('lang/stats_us.lang');

  if (!zhMain) {
    throw new Error(`中文包缺少 lang 文件（${packDir} 与主包 ${BASE_PACK_DIR} 里都没有）`);
  }

  // 语言叠加（个别版本需要，比如 b1.6/b1.8 的界面文本差异）
  let zhText = zhMain.data;
  for (const f of [...ownFiles, ...baseFiles]) {
    const m = f.name.match(/^lang_over\/over_b(\d+)\.lang$/i);
    if (m) zhText = overlayLang(zhText, f.data);
  }

  if (lang === LANG_EN) {
    // 英文界面 + 新字体（中文仍能显示，但不翻译界面）
    if (enOrig) entries.push({ name: 'lang/en_US.lang', data: enOrig.data });
    if (enStats) entries.push({ name: 'lang/stats_US.lang', data: enStats.data });
    entries.push({ name: 'lang/zh_CN.lang', data: zhText });
    if (zhStats) entries.push({ name: 'lang/stats_zh_CN.lang', data: zhStats.data });
  } else {
    // ★ 中文：把中文文本同时写成 en_US.lang —— 远古版本没有语言选择界面，
    //   游戏永远读 en_US.lang，不这么做中文不会生效。
    entries.push({ name: 'lang/en_US.lang', data: zhText });
    if (zhStats) entries.push({ name: 'lang/stats_US.lang', data: zhStats.data });
    entries.push({ name: 'lang/zh_CN.lang', data: zhText });
    if (zhStats) entries.push({ name: 'lang/stats_zh_CN.lang', data: zhStats.data });
    if (enOrig) entries.push({ name: 'lang/en_US_orig.lang', data: enOrig.data });
    if (enStats) entries.push({ name: 'lang/stats_US_orig.lang', data: enStats.data });
  }

  // 4. 标题标语
  const splashes = pick((f) => /^title\/splashes\.txt$/i.test(f.name));
  if (splashes) entries.push({ name: 'title/splashes.txt', data: splashes.data });

  return entries;
}

/**
 * 反查一个 jar 里真正的 FontRenderer 类。
 *
 * ★ 为什么需要它：规则表里写的是「安卓版当时的混淆名」，但部分补丁目录里的
 *   类文件名与规则表可能不一致（历史演进）。以**补丁目录里实际存在的类文件**为准更稳。
 */
function resolveFontRenderer(rule, packClassFiles) {
  const want = rule.isFullPath ? `${rule.fontClass}.class` : `${rule.fontClass}.class`;
  const hit = packClassFiles.find((n) => n.toLowerCase() === want.toLowerCase());
  if (hit) return want;
  // 兜底：补丁目录里第一个 .class（安卓版每个目录通常就一个字体类）
  return packClassFiles[0] || want;
}

/* ------------------------------------------------------------ 对外流程 */

/** 读标记：已按哪种语言打过补丁（null = 没打过） */
function appliedLang(versionDir) {
  const buf = readFileSafe(path.join(versionDir, MARKER));
  if (!buf) return null;
  return buf.toString('utf8').trim() || null;
}

function writeMarker(versionDir, lang) {
  try {
    fs.writeFileSync(path.join(versionDir, MARKER), String(lang), 'utf8');
  } catch (err) {
    console.warn(`[QCL] 中文包标记写入失败：${err?.message || err}`);
  }
}

/**
 * 给一个已安装版本注入中文补丁。
 *
 * @param {object} opts
 * @param {string} opts.versionDir 版本目录
 * @param {string} opts.versionId  版本 id
 * @param {string} [opts.lang]     'zh_CN'（默认）| 'en_US'
 * @param {function} [opts.onLog]
 * @returns {Promise<{applied:boolean, reason?:string, lang?:string, entries?:number, dir?:string}>}
 */
async function applyChinesePack({ versionDir, versionId, lang = LANG_ZH, onLog = () => {} }) {
  const id = String(versionId || '');
  const dir = String(versionDir || '');
  if (!id || !dir) return { applied: false, reason: '参数不完整' };

  const rule = ruleFor(id);
  if (!rule) return { applied: false, reason: `该版本（${id}）暂不提供中文补丁` };

  const jarPath = path.join(dir, `${id}.jar`);
  const origPath = `${jarPath}.orig`;
  if (!fs.existsSync(jarPath) || fs.statSync(jarPath).size < 1024) {
    return { applied: false, reason: '找不到游戏本体 jar' };
  }

  const already = appliedLang(dir);
  if (already === lang) {
    onLog(`中文补丁已是最新（${lang}），跳过`);
    return { applied: false, reason: 'already-applied', lang, dir: rule.dir };
  }

  const packDir = path.join(DATA_DIR, rule.dir);
  if (!fs.existsSync(packDir)) {
    return { applied: false, reason: `中文包资源缺失：${rule.dir}` };
  }

  const { createZip, readZip } = require('./zipwriter');

  // 首次注入前备份原版
  if (!fs.existsSync(origPath)) {
    try {
      fs.copyFileSync(jarPath, origPath);
      onLog(`已备份原版 jar：${path.basename(origPath)}`);
    } catch (err) {
      onLog(`警告：原版备份失败（${err?.message || err}），继续注入`);
    }
  }

  const patchEntries = buildPatchEntries(packDir, rule, lang);
  onLog(`准备注入 ${patchEntries.length} 个补丁条目（${rule.dir}，语言 ${lang}）`);

  /**
   * ★★ 界面翻译 jar（tr.jar）—— 「字体能显示中文」之外的另一半。
   *
   * 安卓版只对「命中 EXTRA_PACKS 的版本」和「1.0 正式版」注入 tr.jar
   * （见 LegacyChinesePack.java:455：`extra != null || v10v`）。
   * b1.7.3 走默认主包，靠 lang/zh_CN.lang 翻译界面，不需要 tr.jar。
   * ⇒ 这里按同样的触发条件：规则不是「默认主包」时才找 tr.jar。
   */
  let translationEntries = [];
  let translationJar = null;
  if (!rule.isDefault) {
    translationJar = findTranslationJar(id, rule);
    if (translationJar) {
      translationEntries = readTranslationJar(translationJar);
      onLog(`界面翻译：${translationJar}（${translationEntries.length} 个条目）`);
    } else if (lang === LANG_ZH) {
      onLog(`该版本没有界面翻译 jar（字体仍会注入，界面保持英文）`);
    }
  }
  // ★ 英文模式不注入 tr.jar（它里面全是中文界面文本）
  if (lang === LANG_EN) {
    translationEntries = [];
    translationJar = null;
  }

  // 补丁目录里实际有哪些字体类，用于精确跳过原版同名条目
  const packClassNames = patchEntries.filter((e) => e.name.endsWith('.class')).map((e) => e.name);
  const fontEntryName = resolveFontRenderer(rule, packClassNames);
  const skipSet = new Set(patchEntries.map((e) => e.name.toLowerCase()));
  skipSet.add(fontEntryName.toLowerCase());
  // tr.jar 里的条目也要覆盖原版同名条目，否则 zip 出现重复
  const trSet = new Set(translationEntries.map((e) => e.name.toLowerCase()));

  const srcEntries = readZip(jarPath);
  const kept = [];
  let skipped = 0;
  let droppedSigs = 0;
  let coveredByTr = 0;
  for (const e of srcEntries) {
    if (e.isDirectory) {
      kept.push(e);
      continue;
    }
    // ★ 丢签名（否则 SHA1 digest error）
    if (isSignatureFile(e.name)) {
      droppedSigs += 1;
      continue;
    }
    // ★ 清 MANIFEST 摘要
    if (/^META-INF\/MANIFEST\.MF$/i.test(e.name)) {
      kept.push({ ...e, data: stripManifestEntries(e.data) });
      continue;
    }
    // tr.jar 覆盖的条目：跳过原版，由 tr.jar 提供
    if (trSet.has(e.name.toLowerCase())) {
      coveredByTr += 1;
      continue;
    }
    if (skipSet.has(e.name.toLowerCase()) || shouldSkipEntry(e.name, rule)) {
      skipped += 1;
      continue;
    }
    kept.push(e);
  }
  onLog(
    `原 jar ${srcEntries.length} 个条目：跳过 ${skipped} 个（字体补丁替换）、` +
      `${coveredByTr} 个（界面翻译替换），丢弃签名 ${droppedSigs} 个，保留 ${kept.length} 个`
  );

  const tmpPath = `${jarPath}.cnpatch`;
  createZip(tmpPath, [
    ...kept,
    ...patchEntries.map((e) => ({ ...e, isDirectory: false })),
    ...translationEntries.map((e) => ({ ...e, isDirectory: false }))
  ]);
  fs.renameSync(tmpPath, jarPath);
  writeMarker(dir, lang);
  onLog(
    `中文补丁注入完成：${id}（${rule.dir}，语言 ${lang}，字体 ${patchEntries.length} 项` +
      `${translationJar ? `，界面翻译 ${translationEntries.length} 项` : ''}）`
  );

  return { applied: true, lang, entries: patchEntries.length, dir: rule.dir, skipped, droppedSigs };
}

/** 语言切换 */
async function switchLanguage({ versionDir, versionId, lang, onLog = () => {} }) {
  return applyChinesePack({ versionDir, versionId, lang, onLog });
}

/** 统计：支持多少个版本 / 多少个目录 */
function stats() {
  const rules = loadRules();
  const dirs = [...new Set(rules.map((r) => r.dir))];
  const dirsOnDisk = dirs.filter((d) => fs.existsSync(path.join(DATA_DIR, d)));
  return { rules: rules.length, dirs: dirs.length, dirsAvailable: dirsOnDisk.length };
}

module.exports = {
  LANG_ZH,
  LANG_EN,
  isSupported,
  ruleFor,
  supportedPatterns,
  appliedLang,
  applyChinesePack,
  switchLanguage,
  stats,
  // 便于单测
  shouldSkipEntry,
  buildPatchEntries,
  overlayLang,
  stripManifestEntries,
  isSignatureFile,
  loadRules
};
