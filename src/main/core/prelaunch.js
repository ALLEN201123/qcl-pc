'use strict';
/**
 * Quanta Craft Launcher PC · 启动前检查与建议
 *
 * ## 为什么要做
 * 用户要求：「HMCL 点击启动游戏之后第一个出现什么？你去翻它的代码看看它出现的那些文字提示，
 *            然后我们也做一个类似的显示，但不要和他的窗口显示一模一样。」
 *
 * ## HMCL 的实际做法（读源码得到）
 *   `LauncherHelper.launch()` 先 `Controllers.dialog(launchingStepsPane)` 弹进度窗，
 *   同时在 `checkGameState()` 里做一堆检查，发现问题就用 `Controllers.confirm()` 弹**建议框**：
 *     · launch.advice.multi  ——「检测到以下问题…仍要继续启动吗？」（**这个是核心**）
 *     · launch.advice.java.auto —— Java 不兼容，可自动换
 *     · launch.advice.not_enough_space —— 分配内存超过物理内存
 *     · launch.advice.too_large_memory_for_32bit —— 32 位 Java 内存上限
 *     · launch.advice.different_platform —— 推荐 64 位 Java
 *     · launch.advice.java9 / java8_51_1_13 / modded_java —— 版本与 Java 的兼容性
 *     · launch.advice.lwjgl_3_4_1 —— LWJGL 3.4.1 性能问题，问是否允许打补丁
 *     · launch.advice.deprecated —— 旧版本提示
 *
 * ## 我们的做法（不同点）
 *   HMCL 是「先弹进度窗、检查过程中再插建议框」，会闪两下。
 *   我们改成**一次弹窗把检查结果 + 启动选项放在一起**：
 *     · 顶部：检查结论（有问题的列出来，可继续/取消）
 *     · 中间：本次启动的关键参数（Java / 内存 / 窗口大小 / 账号）—— 可以直接改
 *     · 底部：「记住这些选择」「启动」「取消」
 *   这样既是 HMCL 那种「启动前确认」，又多了一个「启动设置」的作用，
 *   不用像 HMCL 那样再进设置页改内存。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 检查项定义。
 * 每项返回 { level: 'error'|'warn'|'info', title, detail, fix? }
 *   level=error → 默认阻止启动（用户可强制继续）
 *   level=warn  → 提示但默认可继续
 *   level=info  → 纯信息
 */
function buildChecks({ instance, javaInfo, memoryMb, settings, resolved }) {
  const issues = [];
  const mcVersion = String(instance.mcVersion || '');

  // ---------- 1. Java 版本是否匹配 ----------
  if (javaInfo && javaInfo.major) {
    const want = recommendMajor(mcVersion);
    const got = Number(javaInfo.major);
    if (got < want) {
      issues.push({
        level: 'error',
        code: 'java-too-old',
        title: `Java 版本过旧（当前 ${got}，需要 ${want}）`,
        detail:
          `${mcVersion} 需要 Java ${want} 或更高。当前选的是 Java ${javaInfo.version || got}。` +
          `低于要求的版本会在启动时报 UnsupportedClassVersionError。`,
        fix: `把该实例的 Java 换成 Java ${want}`
      });
    } else if (got > want && want <= 8) {
      // 远古/Beta 版本用新 Java 会崩
      issues.push({
        level: 'error',
        code: 'java-too-new',
        title: `Java 版本过新（当前 ${got}，${mcVersion} 建议 ${want}）`,
        detail:
          `${mcVersion} 这类老版本用 Java ${got} 会缺方法（NoSuchMethodError）或直接崩。` +
          `建议改用 Java ${want}。`,
        fix: `把该实例的 Java 换成 Java ${want}`
      });
    }
  }

  // ---------- 2. 内存是否超过物理内存 ----------
  const totalMb = Math.round(require('node:os').totalmem() / 1024 / 1024);
  const freeMb = Math.round(require('node:os').freemem() / 1024 / 1024);
  if (memoryMb > totalMb) {
    issues.push({
      level: 'error',
      code: 'memory-exceeds-total',
      title: `分配内存（${memoryMb} MB）超过本机物理内存（${totalMb} MB）`,
      detail: '这样设置开不起来，或者会疯狂用页面文件导致极卡。请把内存调小。',
      fix: `建议不超过 ${Math.floor((totalMb * 0.6) / 512) * 512} MB`
    });
  } else if (memoryMb > freeMb + 1024) {
    issues.push({
      level: 'warn',
      code: 'memory-tight',
      title: `当前可用内存偏少（可用 ${freeMb} MB，要分配 ${memoryMb} MB）`,
      detail:
        '启动时可能因为系统内存不足导致 JVM 初始化失败或游戏中途被杀。' +
        '建议先关掉一些程序，或把分配内存调小。',
      fix: `建议 ${Math.min(memoryMb, Math.max(2048, Math.floor((freeMb * 0.6) / 512) * 512))} MB`
    });
  }

  // ---------- 3. 32 位 Java 的内存上限 ----------
  if (javaInfo && javaInfo.arch === 'x86' && memoryMb > 1024) {
    issues.push({
      level: 'warn',
      code: 'memory-32bit',
      title: '32 位 Java 最多只能用到约 1.5 GB 内存',
      detail: `当前分配 ${memoryMb} MB，32 位 JVM 通常会在 1.5 GB 附近失败。建议换 64 位 Java 或把内存降到 1024 MB。`,
      fix: '换 64 位 Java'
    });
  }

  // ---------- 4. 是否用了 32 位 Java 但机器是 64 位 ----------
  if (javaInfo && javaInfo.arch === 'x86' && process.arch === 'x64') {
    issues.push({
      level: 'info',
      code: 'java-32bit-on-64',
      title: '建议使用 64 位 Java',
      detail: '你的电脑是 64 位，但选的是 32 位 Java。64 位能分配更多内存、性能更好。',
      fix: '换 64 位 Java'
    });
  }

  // ---------- 5. 该版本是否已注入中文补丁（改过 jar） ----------
  if (instance.chinesePack && instance.chinesePack.applied) {
    issues.push({
      level: 'info',
      code: 'chinesepack',
      title: '该版本已注入中文补丁',
      detail:
        '游戏 jar 被改写过（替换字体类 + 注入中文点阵 + 界面翻译）。' +
        '所以这个版本的「检查游戏文件」会自动跳过，避免把补丁还原成原版。',
      fix: ''
    });
  }

  // ---------- 6. 远古版本的兼容参数是否生效 ----------
  const low = mcVersion.toLowerCase();
  const isLegacy =
    low.startsWith('inf') ||
    low.startsWith('in-') ||
    low.startsWith('a') ||
    low.startsWith('b') ||
    low.startsWith('c0.') ||
    low.startsWith('pc-') ||
    low.startsWith('rd') ||
    low.includes('infdev');
  if (isLegacy) {
    issues.push({
      level: 'info',
      code: 'legacy-args',
      title: '远古版本兼容参数已就绪',
      detail:
        '启动时会自动附加 -Dhttp.proxyHost=betacraft.uk 与 ' +
        '-Djava.util.Arrays.useLegacyMergeSort=true（可在版本设置的 JVM 参数里覆盖）。',
      fix: ''
    });
  }

  // ---------- 7. 游戏文件是否明显缺失 ----------
  try {
    const mcDir = path.join(instance.dir, '.minecraft');
    const versionsDir = path.join(mcDir, 'versions');
    const vid = resolved && resolved.id ? resolved.id : instance.installedVersion || mcVersion;
    const jar = path.join(versionsDir, vid, `${vid}.jar`);
    if (!fs.existsSync(jar)) {
      issues.push({
        level: 'error',
        code: 'missing-client-jar',
        title: '客户端 jar 缺失',
        detail: `找不到 ${vid}.jar。请到「版本列表 → 该版本 → 重新安装」补齐。`,
        fix: ''
      });
    }
  } catch {
    /* 忽略 */
  }

  return issues;
}

/** 该 MC 版本推荐的 Java 主版本（与 core/java.js 保持一致的规则） */
function recommendMajor(mcVersion) {
  const text = String(mcVersion || '').trim();
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!m) return 8; // 远古版本
  const major = Number.parseInt(m[1], 10);
  const minor = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
  const patch = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;

  // 26.x（2026 年改历年命名）→ Java 25
  if (major >= 26) return 25;
  if (major >= 2) return 21; // 以防将来出现 27.x 之外的编号
  // 1.x 系列
  if (major === 1) {
    if (minor <= 16) return 8;
    if (minor === 17) return 17;
    if (minor === 18) return 17;
    if (minor === 19) return 17;
    if (minor === 20 && patch <= 4) return 17;
    if (minor === 20) return 21;
    return 21;
  }
  return 21;
}

module.exports = { buildChecks, recommendMajor };
