'use strict';
/**
 * Quanta Craft Launcher PC · 崩溃日志分析
 *
 * 目标：把「满屏 at xxx」翻译成人话，直接告诉用户**为什么崩、怎么修**。
 *
 * 参照 HMCL 的 CrashReportAnalyzer（20.7KB，业界最全的一份规则集），
 * 抽取 PC 上最常见、最容易命中的那些崩溃模式。
 *
 * 优先级：先看 crash-reports/ 最新一份（游戏自己写的报告最完整），
 * 没有再回落到 logs/latest.log（有时崩得太早，连报告都来不及写）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 崩溃模式表：正则 + 中文解释 + 修复建议 */
const PATTERNS = [
  {
    id: 'java-version',
    // 老版本用新 Java 跑（Java 8 之后移除了 Nashorn / 老版 ASM 不认新 class 版本）
    test: /UnsupportedClassVersionError|class file version (\d+\.\d+)|has been compiled by a more recent version/i,
    title: 'Java 版本不匹配',
    detail:
      '游戏要求的 Java 版本和当前选择的不一致。' +
      '1.16.5 及更早请用 Java 8；1.17~1.20.4 用 Java 17；1.20.5 及以后用 Java 21。' +
      '到「设置 → Java」里改成对应的版本。'
  },
  {
    id: 'java-too-new-mod',
    test: /NoSuchMethodError|NoClassDefFoundError.*(java\/|javax\/)|A JNI error has occurred/i,
    title: 'Java 版本过新（老模组不兼容）',
    detail:
      '这个版本的模组是按更老的 Java 编译的，新 Java 会找不到旧方法。' +
      '把该实例的 Java 降到 Java 8（远古版本建议统一用 8）。'
  },
  {
    id: 'out-of-memory',
    test: /OutOfMemoryError|Java heap space|GC overhead limit exceeded/i,
    title: '内存不足',
    detail:
      '分配的内存不够用。到「设置 → 内存」把上限调大（建议 4GB 起，装大整合包给 6~8GB），' +
      '同时确认电脑本身还有空闲内存。'
  },
  {
    id: 'oom-direct',
    test: /OutOfMemoryError: Direct buffer memory|Unable to allocate (direct )?buffer/i,
    title: '显存 / 直接内存不足',
    detail:
      '不是堆内存不够，而是直接内存（显存映射）不够。' +
      '1) 降低游戏内的渲染距离与画质；2) 关掉光影；3) 不要给 -XX:MaxDirectMemorySize 设太小。'
  },
  {
    id: 'gpu-driver',
    test: /Pixel format not accelerated|GLX|Could not create (window|context)|WGL|Failed to create (a )?window|OpenGL.*(not supported|too old)|LWJGL Exception/i,
    title: '显卡 / OpenGL 初始化失败',
    detail:
      '显卡驱动太旧，或者没有可用 OpenGL 上下文。' +
      '1) 更新显卡驱动；2) 笔记本确认游戏用的是独显而不是集显；' +
      '3) 远程桌面 / 虚拟机里通常无法启动，需要在物理机桌面运行。'
  },
  {
    id: 'natives-missing',
    test: /UnsatisfiedLinkError|no .* in java\.library\.path|Failed to load native|liblwjgl/i,
    title: 'natives 原生库缺失',
    detail:
      '游戏需要的 .dll 没解压出来（natives 目录不完整）。' +
      '到「版本列表 → 该版本 → 重新安装/修复」重装一次，会重新解压 natives。'
  },
  {
    id: 'asset-missing',
    test: /java\.io\.FileNotFoundException.*assets|Missing asset|Unable to find asset/i,
    title: '游戏资源（assets）缺失',
    detail:
      '声音或语言资源没下全。重新安装该版本即可补齐；网速差时会漏，多试一次。'
  },
  {
    id: 'jar-corrupt',
    test: /invalid LOC header|zip END header not found|error in opening zip file|ZipException/i,
    title: '游戏 jar 损坏',
    detail:
      '版本 jar 下载不完整或被杀软破坏。到「版本列表 → 该版本 → 重新安装」覆盖一遍。' +
      '（如果你装的是远古版本中文补丁，注意别用「检查游戏文件完整性」把它还原掉。）'
  },
  {
    id: 'mod-conflict',
    test: /DuplicateModsFoundException|ModResolutionException|Incompatible mod set|Missing or unsupported mandatory dependencies|net\.fabricmc\.loader\.discovery|Mod file .* is not valid/i,
    title: '模组冲突或依赖缺失',
    detail:
      '有两个模组互相冲突，或者少了前置模组。' +
      '看报告里 "Missing or unsupported mandatory dependencies" 后面列的模组名，' +
      '按提示补前置，或禁用冲突的那一个。'
  },
  {
    id: 'mixin-fail',
    test: /Mixin apply failed|MixinTransformerError|org\.spongepowered\.asm.*Mixin|InvalidInjectionException/i,
    title: 'Mixin 注入失败（模组与版本不匹配）',
    detail:
      '某个模组的 Mixin 和当前游戏版本对不上。' +
      '确认模组支持这个 MC 版本；Forge/Fabric 版本要与模组要求一致。'
  },
  {
    id: 'launchwrapper-tweak',
    test: /ClassNotFoundException: net\.minecraft\.client\.Minecraft|tweakClass|TweakClass|LaunchWrapper/i,
    title: '远古版本启动器参数不对',
    detail:
      '这个远古版本的主类/启动参数不匹配（典型是 RubyDung 时代被当成 Classic 启动）。' +
      'QCL PC 已按 jar 内容自动判断；若仍报错，到「版本列表 → 重新安装」重建版本 JSON。'
  },
  {
    id: 'signature',
    test: /SecurityException.*(SHA1|digest|signature)|JarVerifier|invalid signature file digest/i,
    title: 'jar 签名校验失败',
    detail:
      '游戏 jar 被改过（例如注入中文补丁）但 Mojang 签名还在。' +
      'QCL PC 注入补丁时会自动移除签名；若看到这条，说明 jar 被别的工具改过，' +
      '重新安装该版本并让 QCL 重新注入即可。'
  },
  {
    id: 'glfw',
    test: /GLFW error|Failed to initialize GLFW|Cannot create window/i,
    title: 'GLFW 窗口创建失败',
    detail: '显示器/驱动问题，或远程桌面环境。更新驱动、确认在本地桌面运行。'
  },
  {
    id: 'permission',
    test: /AccessDeniedException|Permission denied|Access is denied|java\.io\.FileNotFoundException.*(logs|saves|config)/i,
    title: '文件权限不足',
    detail:
      '游戏目录被占用或没有写权限。' +
      '1) 把启动器与游戏装在非系统盘（如 D:\\）；2) 关掉杀软的「文件夹保护」；' +
      '3) 别把实例放在 OneDrive 同步目录里。'
  },
  {
    id: 'encoding',
    test: /MalformedInputException|Input length = 1|Unmappable character/i,
    title: '编码问题（中文路径/文件名）',
    detail:
      '路径里有特殊字符或编码不一致。把实例移到纯英文路径（如 D:\\QCL\\instances）再试。'
  },
  {
    id: 'forge-installer',
    test: /installer.*failed|Failed to download|Forge installer|library.*not found/i,
    title: 'Forge/NeoForge 安装不完整',
    detail: '安装器中途失败导致库不全。重新安装该版本；网络差就换到「设置 → 下载 → BMCLAPI 镜像」。'
  }
];

/** 读目录里最新的一个匹配文件 */
function newestFile(dir, filter) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hits = names
    .filter((n) => filter.test(n))
    .map((n) => {
      const p = path.join(dir, n);
      try {
        return { path: p, name: n, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return hits[0] || null;
}

/** 读文本，限制大小 */
function readLimited(file, maxBytes = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) {
      // 太大就读尾巴（崩溃堆栈通常在末尾）
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, Math.max(0, st.size - maxBytes));
      fs.closeSync(fd);
      return buf.toString('utf8');
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 对一段文本做规则匹配 */
function matchPatterns(text) {
  const reasons = [];
  for (const p of PATTERNS) {
    let m = null;
    try {
      m = p.test.exec(text);
    } catch {
      m = null;
    }
    if (m) reasons.push({ id: p.id, title: p.title, detail: p.detail, hit: String(m[0]).slice(0, 160) });
  }
  // 去重（同一个原因可能被多条正则命中）
  const seen = new Set();
  return reasons.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/**
 * 分析一个实例的崩溃。
 *
 * @param {object} opts
 * @param {string} opts.instanceDir 实例根目录（含 .minecraft）
 * @returns {{found:boolean, file?:string, reasons:object[], excerpt?:string}}
 */
function analyzeCrash({ instanceDir }) {
  const mc = path.join(String(instanceDir || ''), '.minecraft');

  // 1. 优先 crash-reports（最完整）
  const crashDir = path.join(mc, 'crash-reports');
  const crash = newestFile(crashDir, /^crash-.*\.txt$/i);
  if (crash) {
    const text = readLimited(crash.path);
    const reasons = matchPatterns(text);
    return {
      found: true,
      file: crash.name,
      reasons,
      excerpt: buildExcerpt(text)
    };
  }

  // 2. 回落到 logs/latest.log
  const logDir = path.join(mc, 'logs');
  const log = newestFile(logDir, /^(latest|debug)\.log$/i);
  if (log) {
    const text = readLimited(log.path);
    // 只有真的出现异常才认为「崩过」
    const crashed = /Exception|Error|FAILED|Caused by:/i.test(text);
    if (crashed) {
      const reasons = matchPatterns(text);
      return {
        found: true,
        file: `${log.name}（没有 crash-reports，用最近日志分析）`,
        reasons,
        excerpt: buildExcerpt(text)
      };
    }
  }

  return { found: false, reasons: [] };
}

/** 抽取关键片段：从第一个 Exception/Caused by 开始，最多 40 行 */
function buildExcerpt(text) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/Exception|Error|Caused by:/i.test(lines[i])) {
      start = Math.max(0, i - 3);
      break;
    }
  }
  if (start < 0) start = Math.max(0, lines.length - 40);
  return lines.slice(start, start + 40).join('\n');
}

module.exports = { analyzeCrash, matchPatterns, PATTERNS };
