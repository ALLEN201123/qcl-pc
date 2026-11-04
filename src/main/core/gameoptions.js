'use strict';
/**
 * Quanta Craft Launcher PC · options.txt 读写（游戏语言预置）
 *
 * ## 为什么需要它
 * 用户要求：「给游戏预设中文」—— 让玩家装完游戏第一次进去就是中文界面，
 * 不用自己去 Options → Language 里翻半天。
 *
 * ## ★★★ 为什么不能简单写 `lang=zh_CN`
 * 这里有个**版本相关的大小写陷阱**，写错会让游戏直接崩：
 *   · **1.1 ~ 1.10**：语言代码是 `zh_CN`（**区域部分大写**）
 *   · **1.11 及以后**（含 26.x）：改成 `zh_cn`（**区域部分小写**）
 *   · **1.0 及更早**：**根本不能写** —— 那两个时代的 options.txt 还没有 `lang` 字段，
 *     写进去会让 1.1 那批版本在解析语言表时抛异常崩掉。
 *     （安卓版 QCL 踩过这个坑，`MCOptionUtils.fixLang()` 里的 `isOlderThan1_1` 判断就是那次修复）
 *
 * 本模块照安卓版 `MCOptionUtils.java` 的逻辑移植：
 *   · `normalizeLangCase()`  —— 按版本决定大小写；
 *   · `fixLangCase()`        —— 修正已经被写错大小写的 options.txt（老存档/老启动器留下的）；
 *   · `applyLanguage()`      —— 在启动前把语言设成指定值。
 *
 * ## 远古版本（pre-classic / beta / alpha）另外处理
 * 那些版本根本没有官方中文，中文是靠我们注入的**中文补丁包**（chinesepack）提供的，
 * 改 `lang` 反而可能导致语言表加载失败。所以远古版本一律**跳过**，不写 lang。
 */

const fs = require('node:fs');
const path = require('node:path');

/** options.txt 的位置（游戏目录下） */
function optionsFile(gameDir) {
  return path.join(String(gameDir || ''), 'options.txt');
}

/**
 * 解析 "key:value" 行到 Map。
 * ★ 只按**第一个冒号**切分 —— 值里可能有冒号（比如资源包路径、服务器地址）。
 */
function parseOptions(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

/** Map → options.txt 文本（保持原有行序由调用方负责，这里只做序列化） */
function serializeOptions(map) {
  const out = [];
  for (const [k, v] of map) out.push(`${k}:${v}`);
  return out.join('\n') + '\n';
}

/** 读 options.txt（不存在返回 { exists:false }） */
function readOptions(gameDir) {
  const file = optionsFile(gameDir);
  try {
    if (!fs.existsSync(file)) return { file, exists: false, map: new Map(), raw: '' };
    const raw = fs.readFileSync(file, 'utf8');
    return { file, exists: true, map: parseOptions(raw), raw };
  } catch (err) {
    return { file, exists: false, map: new Map(), raw: '', error: err?.message || String(err) };
  }
}

/**
 * 写 options.txt。
 * ★ 采用「按原始行改写、只替换目标键」的策略，**不重排、不丢行** ——
 *   玩家的按键绑定、资源包列表都在同一个文件里，整文件重写风险太大。
 */
function writeOptions(gameDir, key, value) {
  const file = optionsFile(gameDir);
  let lines = [];
  let found = false;
  try {
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      // 末尾空行会被 split 出来，记一下保留
    }
  } catch {
    lines = [];
  }

  const newLine = `${key}:${value}`;
  const next = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx >= 0 && line.slice(0, idx) === key) {
      next.push(newLine);
      found = true;
    } else {
      next.push(line);
    }
  }
  if (!found) {
    // 文件末尾如果是空元素（结尾换行造成），插到它前面
    if (next.length && next[next.length - 1] === '') next.splice(next.length - 1, 0, newLine);
    else next.push(newLine);
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ★ 保留结尾换行，且不写 BOM（Minecraft 用 UTF-8 无 BOM 读）
    let text = next.join('\n');
    if (!text.endsWith('\n')) text += '\n';
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, error: err?.message || String(err) };
  }
}

/* ------------------------------------------------------------ 版本判定 */

/** 从版本 id 里抠 [major, minor]（"1.10.2" → [1,10]，"26.3" → [26,3]） */
function parseVersion(mcVersion) {
  const m = /(\d+)\.(\d+)/.exec(String(mcVersion || ''));
  if (!m) return null;
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)];
}

/**
 * 远古版本（没有官方中文、靠我们注入中文补丁的那些）——
 * 一律不碰 lang，否则语言表可能加载失败。
 */
function isAncientVersion(mcVersion) {
  const v = String(mcVersion || '').trim().toLowerCase();
  if (!v) return false;
  return (
    v.startsWith('rd-') ||
    v.startsWith('pc-') ||
    v.startsWith('c0.') ||
    v.startsWith('in-') ||
    v.startsWith('inf') ||
    /^a\d/.test(v) || // alpha a1.x
    /^b\d/.test(v) // beta b1.x
  );
}

/**
 * 1.0 及更早 → true（照安卓版 `isOlderThan1_1`）。
 * 这类版本**不能写 lang**，这是 1.1 崩溃 BUG 的规避点。
 */
function isOlderThan1_1(mcVersion) {
  const p = parseVersion(mcVersion);
  if (!p) return false;
  return p[0] < 1 || (p[0] === 1 && p[1] === 0);
}

/** 1.11 之前 → true（照安卓版 `isOlderThan1_11`） */
function isOlderThan1_11(mcVersion) {
  const p = parseVersion(mcVersion);
  if (!p) return false;
  return p[0] !== 1 ? p[0] < 1 : p[1] < 11;
}

/**
 * 按版本决定语言代码的**正确大小写**。
 *
 * @param {string} lang 例如 'zh_CN' / 'zh_cn' / 'zh-Hans-CN'
 * @param {string} mcVersion 例如 '1.7.10' / '1.20.1' / '26.3'
 * @returns {{lang:string, skip:boolean, reason:string}}
 *   skip=true 表示「这个版本不该写 lang」
 */
function normalizeLangCase(lang, mcVersion) {
  const raw = String(lang || '').trim();
  if (!raw) return { lang: raw, skip: true, reason: '语言代码为空' };

  // 远古版本：靠中文补丁，不碰 lang
  if (isAncientVersion(mcVersion)) {
    return { lang: raw, skip: true, reason: '远古版本靠中文补丁注入，不写 lang（避免语言表加载失败）' };
  }

  // ★ 1.0 及更早：绝对不能写，否则 1.1 那批会崩
  if (isOlderThan1_1(mcVersion)) {
    return { lang: raw, skip: true, reason: `${mcVersion} 的 options.txt 不支持 lang 字段，跳过（避免崩溃）` };
  }

  // 语言代码统一成 "语言_地区" 形式（Minecraft 只认下划线）
  const normalizedSep = raw.replace(/-/g, '_');
  const parts = normalizedSep.split('_');
  if (parts.length < 2) {
    // 只有语言没有地区（如 "zh"）——补齐成 zh_CN / zh_cn
    parts.push('CN');
  }
  const head = parts[0].toLowerCase();
  let tail = parts.slice(1).join('_');

  // ★ 大小写规则：1.1~1.10 用大写地区（zh_CN），1.11+ 用小写（zh_cn）
  tail = isOlderThan1_11(mcVersion) ? tail.toUpperCase() : tail.toLowerCase();

  return {
    lang: `${head}_${tail}`,
    skip: false,
    reason: isOlderThan1_11(mcVersion) ? '1.1~1.10：地区部分大写' : '1.11+：地区部分小写'
  };
}

/* ------------------------------------------------------------ 对外操作 */

/**
 * 修正已有 options.txt 里写错大小写的 lang。
 *
 * 场景：玩家之前用别的启动器（或我们的旧版本）把 `lang` 写成了错误的写法，
 * 导致游戏要么显示英文、要么直接崩。这里按版本纠正回来。
 *
 * 照安卓版 `fixLang()`：
 *   · 没写 lang → 不动（由 applyLanguage 负责首次写入）
 *   · 远古版本 / 1.0 及更早 → 不动
 *   · 大小写不对 → 改
 *
 * @returns {{fixed:boolean, from?:string, to?:string, reason?:string}}
 */
function fixLangCase(gameDir, mcVersion) {
  const { exists, map } = readOptions(gameDir);
  if (!exists) return { fixed: false, reason: 'options.txt 不存在' };

  const cur = map.get('lang');
  if (cur == null || cur === '') return { fixed: false, reason: '没有 lang 字段' };
  if (!cur.includes('_')) return { fixed: false, reason: `lang=${cur} 没有地区部分，保持原样` };

  const norm = normalizeLangCase(cur, mcVersion);
  if (norm.skip) return { fixed: false, reason: norm.reason };
  if (norm.lang === cur) return { fixed: false, reason: '大小写已经正确' };

  const r = writeOptions(gameDir, 'lang', norm.lang);
  return r.ok
    ? { fixed: true, from: cur, to: norm.lang, reason: norm.reason }
    : { fixed: false, reason: r.error || '写入失败' };
}

/**
 * 预设游戏语言（启动前调用）。
 *
 * @param {object} opts
 * @param {string} opts.gameDir   实例的 .minecraft 目录
 * @param {string} opts.mcVersion 版本号（决定大小写）
 * @param {string} [opts.lang='zh_CN']
 * @returns {{applied:boolean, lang?:string, skipped?:string, error?:string}}
 */
function applyLanguage(opts = {}) {
  const gameDir = String(opts.gameDir || '');
  const mcVersion = String(opts.mcVersion || '');
  const want = String(opts.lang || 'zh_CN');
  if (!gameDir) return { applied: false, skipped: '缺少游戏目录' };

  const norm = normalizeLangCase(want, mcVersion);
  if (norm.skip) return { applied: false, skipped: norm.reason };

  // 已经是对的就不重复写（减少磁盘写入，也避免改坏玩家的其他设置）
  const { map } = readOptions(gameDir);
  if (map.get('lang') === norm.lang) {
    return { applied: false, lang: norm.lang, skipped: '已经是目标语言' };
  }

  const r = writeOptions(gameDir, 'lang', norm.lang);
  if (!r.ok) return { applied: false, error: r.error || '写入 options.txt 失败' };
  return { applied: true, lang: norm.lang };
}

module.exports = {
  optionsFile,
  parseOptions,
  serializeOptions,
  readOptions,
  writeOptions,
  parseVersion,
  isAncientVersion,
  isOlderThan1_1,
  isOlderThan1_11,
  normalizeLangCase,
  fixLangCase,
  applyLanguage,
};
