'use strict';
/*
 * rules.js —— rules 匹配。
 *
 * 参照 vendor/MultiMC/launcher/minecraft/Rule.cpp + Rule.h：
 *   · rulesFromJsonV4 只认 action 为 "allow" / "disallow" 的规则，其它（含缺 action）直接跳过；
 *   · 没有 os 对象的规则是 ImplicitRule（恒 applies）；
 *   · OsRule 在 os.name 与当前系统相符时 applies；
 *   · Library::isActive()：rules 为空 → 生效；非空 → ruleResult 先取 Disallow，
 *     然后**最后一条 applies 的规则**决定结果，最终 result = (ruleResult == Allow)。
 *
 * 在 MultiMC 基础上按契约 §4 补齐了官方启动器才有的 os.arch / os.version 正则
 * 与 features 条件（is_demo_user / has_custom_resolution / has_quick_plays_support /
 * is_quick_play_singleplayer / is_quick_play_multiplayer / is_quick_play_realms）。
 */

const os = require('node:os');

/** 官方 os.name 取值 → 本平台判定名。 */
const KNOWN_OS = new Set(['windows', 'linux', 'osx', 'macos']);

/** 默认 features 全 false（与官方启动器默认一致）。 */
const DEFAULT_FEATURES = Object.freeze({
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
});

/** process.arch / os.arch() → 官方 os.arch 取值。 */
function normalizeArch(arch) {
  const a = String(arch || '').toLowerCase();
  if (a === 'x64' || a === 'amd64' || a === 'x86_64') return 'x64';
  if (a === 'ia32' || a === 'x86' || a === 'i386' || a === 'i686') return 'x86';
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  if (a === 'arm' || a === 'arm32' || a === 'armv7l') return 'arm32';
  return a || 'x64';
}

/** 当前系统信息（os.name 用官方叫法 windows / linux / osx）。 */
function currentOs(override) {
  const platform = process.platform;
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
  const base = { name, arch: normalizeArch(process.arch), version: os.release() };
  if (!override) return base;
  return {
    name: override.name || base.name,
    arch: override.arch ? normalizeArch(override.arch) : base.arch,
    version: override.version || base.version,
  };
}

/** 取 os.name 的判定名；'macos' 与 'osx' 等价。 */
function canonOsName(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'macos' || n === 'mac' || n === 'darwin') return 'osx';
  return n;
}

function featuresEqual(expected, actual) {
  const want = expected === true || expected === 'true';
  const have = actual === true || actual === 'true';
  return want === have;
}

/**
 * 单条规则是否「命中」（对应 MultiMC Rule::apply 里的 applies）。
 * @param {object} rule
 * @param {{os?:object, features?:object}} ctx
 * @returns {boolean}
 */
function ruleApplies(rule, ctx) {
  if (!rule || typeof rule !== 'object') return false;
  const action = rule.action;
  if (action !== 'allow' && action !== 'disallow') return false;

  const env = ctx || {};
  const osInfo = currentOs(env.os);
  const features = Object.assign({}, DEFAULT_FEATURES, env.features || {});

  // features 条件：列出的每一项都必须与当前 features 一致
  if (rule.features && typeof rule.features === 'object') {
    for (const key of Object.keys(rule.features)) {
      if (!featuresEqual(rule.features[key], features[key])) return false;
    }
  }

  const ruleOs = rule.os;
  if (!ruleOs || typeof ruleOs !== 'object') {
    // 无 os 条件 = ImplicitRule，恒命中
    return true;
  }

  if (ruleOs.name !== undefined) {
    const want = canonOsName(ruleOs.name);
    if (KNOWN_OS.has(want) || KNOWN_OS.has(String(ruleOs.name).toLowerCase())) {
      if (want !== osInfo.name) return false;
    } else {
      // 官方之外的系统名（如 'other'）永不匹配本机
      return false;
    }
  }

  if (ruleOs.arch !== undefined) {
    if (normalizeArch(ruleOs.arch) !== osInfo.arch) return false;
  }

  if (ruleOs.version !== undefined && String(ruleOs.version).trim() !== '') {
    let re;
    try {
      re = new RegExp(String(ruleOs.version));
    } catch (_) {
      // 正则非法时按「不命中」处理，避免整条规则链被一条坏规则污染
      return false;
    }
    if (!re.test(String(osInfo.version || ''))) return false;
  }

  return true;
}

/**
 * 是否允许该元素生效（MultiMC Library::isActive 的规则部分）。
 * 语义：rules 非空时，默认 Disallow，由**最后一条命中的规则**的 action 决定。
 * @param {Array} rules
 * @param {{os?:object, features?:object}} [ctx]
 * @returns {boolean}
 */
function matches(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  let decided = false;
  for (const rule of rules) {
    if (!ruleApplies(rule, ctx)) continue;
    allowed = rule.action === 'allow';
    decided = true;
  }
  return decided ? allowed : false;
}

/** 把 rules 数组规范成布尔判定，方便外部灰显元素。 */
function describe(rules, ctx) {
  return { allowed: matches(rules, ctx), count: Array.isArray(rules) ? rules.length : 0 };
}

module.exports = {
  DEFAULT_FEATURES,
  KNOWN_OS,
  normalizeArch,
  currentOs,
  canonOsName,
  ruleApplies,
  matches,
  describe,
};
