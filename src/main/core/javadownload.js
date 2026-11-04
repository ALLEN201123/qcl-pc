'use strict';
/**
 * Quanta Craft Launcher PC · Java 下载（照 HMCL 的「自动下载 Java」移植）
 *
 * ## 为什么需要它（用户提的真实场景）
 *   「玩家连一个 Java 都没下载过 → 下载完游戏版本 → 点启动 → Java 检测不出来 → 启动失败。
 *     此时没给玩家下载 Java 的链接，也没给**不需要登录**的官网链接。」
 *
 * 这个场景在现实里非常常见：Windows 自带不带 Java，新玩家不会自己去装。
 * 而**Oracle 官网下载 JDK 要登录账号**，对玩家是巨大的门槛。
 *
 * ## 解决办法（两件事都做）
 *   ① **一键下载**：从 Adoptium 的公开 API 直接拉 JDK 压缩包并解压到 QCL 主目录，
 *      全程无需登录、无需跳浏览器。HMCL 用的是 Disco API（Azul 提供，同样免鉴权），
 *      这里选 Adoptium 直链 —— 接口最简单，一个 URL 就出包。
 *   ② **免登录下载源清单**：万一自动下载失败（网络/镜像问题），列出 5 个
 *      **全部不需要注册登录**的官方来源，玩家自己点开也能下。
 *
 * ## 明确不推荐的
 *   Oracle 官网（oracle.com/java/technologies/downloads）—— 下载需要 Oracle 账号登录，
 *   对只想玩游戏的玩家太麻烦。清单里**故意不放**它，但会说明原因，
 *   免得玩家自己去搜到 Oracle 然后卡在登录页。
 */

const fs = require('node:fs');
const path = require('node:path');

const http = require('./http');

/**
 * 免登录 Java 下载源。
 * ★ 全部实测过：打开即下载，不需要注册、不需要登录、不需要邮箱。
 */
const NO_LOGIN_SOURCES = [
  {
    id: 'adoptium',
    name: 'Eclipse Temurin（Adoptium）',
    vendor: 'Eclipse 基金会',
    url: 'https://adoptium.net/temurin/releases/',
    note: '最推荐的通用选择。Minecraft 社区事实标准，Windows/macOS/Linux 全平台，免登录直接下。',
    api: 'https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/{image}/hotspot/normal/eclipse',
    recommended: true
  },
  {
    id: 'microsoft',
    name: 'Microsoft Build of OpenJDK',
    vendor: '微软',
    url: 'https://learn.microsoft.com/zh-cn/java/openjdk/download',
    note: 'Windows 上兼容性很好，微软官方维护，点开就是下载表格，免登录。',
    recommended: true
  },
  {
    id: 'zulu',
    name: 'Azul Zulu',
    vendor: 'Azul',
    url: 'https://www.azul.com/downloads/?package=jdk#zulu',
    note: '老版本 Java（8 / 17）覆盖最全，免登录。HMCL 也用它。',
    recommended: false
  },
  {
    id: 'corretto',
    name: 'Amazon Corretto',
    vendor: '亚马逊',
    url: 'https://aws.amazon.com/corretto/',
    note: '长期免费支持，适合服务器/长期使用，免登录。',
    recommended: false
  },
  {
    id: 'liberica',
    name: 'BellSoft Liberica JDK',
    vendor: 'BellSoft',
    url: 'https://bell-sw.com/pages/downloads/',
    note: '提供完整 JDK 与精简版，免登录。',
    recommended: false
  }
];

/** 不推荐的来源及原因（主动告知，免得玩家踩坑） */
const DISCOURAGED = {
  oracle: {
    name: 'Oracle JDK 官网',
    url: 'https://www.oracle.com/java/technologies/downloads/',
    reason: '下载需要注册并登录 Oracle 账号，对只想玩游戏的玩家很麻烦。除非有特殊需求，建议用上面的来源。'
  }
};

/** 当前平台 → Adoptium API 的 os / arch 参数 */
function platformParams() {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x86' : 'x64';
  return { os, arch };
}

/** 组装 Adoptium 直链 */
function adoptiumUrl(major) {
  const { os, arch } = platformParams();
  return `https://api.adoptium.net/v3/binary/latest/${Number(major)}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;
}

/** 该 MC 版本推荐的 Java 主版本（与 core/java.js 的规则一致） */
function recommendMajor(mcVersion) {
  const text = String(mcVersion || '').trim();
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!m) return 8;
  const major = Number.parseInt(m[1], 10);
  const minor = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
  const patch = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;
  if (major >= 26) return 25;
  if (major >= 2) return 21;
  if (major === 1) {
    if (minor <= 16) return 8;
    if (minor <= 19) return 17;
    if (minor === 20 && patch <= 4) return 17;
    return 21;
  }
  return 21;
}

/** Java 装到哪：<home>/java/<major>/ */
function javaInstallDir(home, major) {
  return path.join(String(home || ''), 'java', `jdk-${major}`);
}

/** 在目录里找 java.exe（解压出来的包通常有一层 jdk-xxx 目录） */
function findJavaBinary(root) {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const rel = process.platform === 'win32' ? path.join('bin', exeName) : path.join('bin', exeName);

  // 先看根目录本身
  const direct = path.join(root, rel);
  if (fs.existsSync(direct)) return direct;

  // 再看一层子目录（Adoptium 的包名形如 jdk-21.0.1+12）
  let children = [];
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const c of children) {
    if (!c.isDirectory()) continue;
    const p = path.join(root, c.name, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 下载并解压一个 JDK。
 *
 * @param {object} opts
 * @param {number} opts.major        主版本（8 / 17 / 21 / 25）
 * @param {string} opts.home         QCL 主目录
 * @param {function} [opts.onProgress] (phase, received, total) => void
 * @param {function} [opts.onLog]
 * @returns {Promise<{ok:boolean, javaPath?:string, dir?:string, version?:number, source?:string, error?:string}>}
 */
async function downloadJava(opts = {}) {
  const major = Number(opts.major);
  const home = String(opts.home || '');
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!Number.isFinite(major) || major < 8) return { ok: false, error: 'Java 主版本不正确' };
  if (!home) return { ok: false, error: '缺少 QCL 主目录' };

  const destDir = javaInstallDir(home, major);

  // 已经装过就直接返回（幂等）
  const existing = findJavaBinary(destDir);
  if (existing) {
    return { ok: true, javaPath: existing, dir: destDir, version: major, source: '已存在（跳过下载）' };
  }

  const url = adoptiumUrl(major);
  log(`开始下载 Java ${major}：${url}`);

  let buf;
  try {
    buf = await http.fetchBuffer(url, { timeoutMs: 600000 });
  } catch (err) {
    return {
      ok: false,
      error:
        `下载 Java ${major} 失败：${err?.message || err}。` +
        `可以改用下面的免登录来源手动下载：${NO_LOGIN_SOURCES.map((s) => s.name).join('、')}`
    };
  }
  if (!buf || buf.length < 1024 * 1024) {
    return { ok: false, error: `下载到的文件太小（${buf ? buf.length : 0} 字节），可能不是有效的 JDK 包` };
  }
  log(`下载完成：${(buf.length / 1024 / 1024).toFixed(1)} MB，准备解压…`);

  // 校验是 zip（Adoptium Windows 给的是 .zip）
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
  if (!isZip && !isGz) {
    return { ok: false, error: '下载到的不是压缩包（可能被网络中间页替换了），请改用免登录来源手动下载' };
  }

  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `创建目录失败：${err?.message || err}` };
  }

  const tmp = path.join(destDir, isZip ? '_jdk.zip' : '_jdk.tar.gz');
  try {
    fs.writeFileSync(tmp, buf);
  } catch (err) {
    return { ok: false, error: `写入临时文件失败：${err?.message || err}` };
  }

  // 解压：Windows 上用系统自带 tar（Win10 1803+ 自带 bsdtar，能解 zip 和 tar.gz）
  //        这样不用额外依赖，也不吃内存。
  try {
    const { execFileSync } = require('node:child_process');
    log('正在解压…（这一步可能要几十秒）');
    if (isZip) {
      // tar 在 Windows 上可以直接解 zip
      execFileSync('tar', ['-xf', tmp, '-C', destDir], { windowsHide: true, stdio: 'ignore', timeout: 600000 });
    } else {
      execFileSync('tar', ['-xzf', tmp, '-C', destDir], { windowsHide: true, stdio: 'ignore', timeout: 600000 });
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      error:
        `解压失败：${err?.message || err}。` +
        `包已经下到 ${tmp}，你也可以手动解压。或改用免登录来源手动下载。`
    };
  }

  try {
    fs.unlinkSync(tmp);
  } catch {
    /* 忽略 */
  }

  const bin = findJavaBinary(destDir);
  if (!bin) {
    return { ok: false, error: `解压完成但没找到 java 可执行文件（${destDir}），可能压缩包结构异常` };
  }

  log(`Java ${major} 已就绪：${bin}`);
  return { ok: true, javaPath: bin, dir: destDir, version: major, source: 'Adoptium（Eclipse Temurin）' };
}

/** 给界面的完整信息：推荐版本 + 免登录来源 + 不推荐来源说明 */
function sourcesFor(mcVersion) {
  return {
    recommendMajor: recommendMajor(mcVersion),
    sources: NO_LOGIN_SOURCES.map((s) => ({ ...s })),
    discouraged: { ...DISCOURAGED },
    platform: platformParams(),
    note:
      '这些来源**都不需要注册或登录**，点开即可下载。' +
      '装好后回到「设置 → Java」，点「添加 Java」选到 bin\\java.exe 即可。'
  };
}

module.exports = {
  NO_LOGIN_SOURCES,
  DISCOURAGED,
  sourcesFor,
  downloadJava,
  adoptiumUrl,
  recommendMajor,
  javaInstallDir,
  findJavaBinary,
  platformParams
};
