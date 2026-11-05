'use strict';
/**
 * Quanta Craft Launcher PC · Forge / NeoForge / OptiFine / LiteLoader 安装
 *
 * ## 这些加载器为什么特殊
 * Fabric / Quilt 只要一份 profile JSON 就能装；
 * 但 Forge / NeoForge / OptiFine / LiteLoader **必须运行它们自己的安装器 jar** 来改写客户端 jar、
 * 生成 `versions/<id>/<id>.json` 与大量库文件。没有捷径。
 *
 * ## PC 端的做法（参照安卓版 ForgeInstallTask + HMCL 的 ModpackInstallTask）
 *   1. 下载官方 installation jar
 *   2. `java -jar forge-installer.jar --installClient <游戏目录>` 静默安装
 *   3. 安装器会在 `versions/<forge-version>/` 下生成 JSON
 *   4. 从那份 JSON 里读出该加载器版本，写进实例元数据
 *
 * ## 为什么在 PC 上比安卓可靠
 * 安卓版要处理「安装器跑在 Android 的 JVM 里、缺 awt 之类的坑」；
 * PC 上就是普通 java -jar，标准环境下基本一次过。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const http = require('./http');

/** 各加载器的安装器下载地址模板 */
function installerUrls(loader, mcVersion) {
  const type = String(loader.type || '').toLowerCase();
  const ver = loader.version ? String(loader.version).trim() : '';

  if (type === 'forge') {
    // Forge 版本号带 MC 前缀，例如 1.20.1-47.2.0
    const build = ver.includes('-') ? ver : `${mcVersion}-${ver || 'recommended'}`;
    const base = build.replace(`${mcVersion}-`, '');
    return {
      id: `${mcVersion}-forge-${base}`,
      urls: [
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`,
        `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`
      ],
      args: ['--installClient']
    };
  }

  if (type === 'neoforge') {
    // NeoForge 从 1.20.2 起独立版本号
    const build = ver;
    return {
      id: `neoforge-${build}`,
      urls: [
        `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`,
        `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`
      ],
      args: ['--installClient']
    };
  }

  if (type === 'optifine') {
    // OptiFine 没有稳定公开直链，走官方下载页说明
    return {
      id: `${mcVersion}-OptiFine_${ver}`,
      urls: [],
      args: [],
      manual: 'https://optifine.net/downloads',
      manualHint:
        'OptiFine 官方没有稳定的自动下载直链（要过广告页）。' +
        '请到 optifine.net 下载对应版本的 jar，然后在「版本列表 → 安装本地文件」里选它。'
    };
  }

  if (type === 'liteloader') {
    return {
      id: `${mcVersion}-LiteLoader-${ver}`,
      urls: [`https://dl.liteloader.com/versions/com/mumfrey/liteloader/${mcVersion}/liteloader-${ver}.jar`],
      args: [],
      manual: 'https://www.liteloader.com/download',
      manualHint: 'LiteLoader 安装器需要图形界面，请手动运行后把生成的版本目录复制到 instances 下。'
    };
  }

  return null;
}

/** 下载安装器（带镜像回落） */
async function downloadInstaller({ urls, dest, onLog = () => {}, onProgress = () => {} }) {
  let lastErr = null;
  for (const url of urls) {
    try {
      onLog(`下载安装器：${new URL(url).host}`);
      const buf = await http.fetchBuffer(url, {
        timeoutMs: 180000,
        onProgress: (p) => onProgress(p)
      });
      if (!buf || buf.length < 4096) throw new Error('下载内容过小');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      onLog(`下载完成（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
      return true;
    } catch (err) {
      lastErr = err;
      onLog(`该源失败：${err?.message || err}`);
    }
  }
  throw new Error(`安装器下载失败（所有镜像都不可用）${lastErr ? `：${lastErr.message}` : ''}`);
}

/**
 * ★★★ 官方安装器要求游戏目录里有 `launcher_profiles.json`，否则直接罢工：
 *     `There is no Minecraft launcher profile in "<dir>", you need to run the launcher first!`
 *     然后退出码 1、一个版本目录都不生成 —— 2026-11-05 用户装 Forge 26.3 就是这么失败的。
 *
 *   QCL 的实例目录是自己在 `instances/<id>/.minecraft` 建出来的，从来没有这个文件。
 *   ⇒ 跑任何官方安装器（Forge / NeoForge）之前先补一个最小可用的。
 *     已存在就不动（玩家可能自己改过）。
 */
function ensureLauncherProfiles(gameDir, onLog = () => {}) {
  const file = path.join(gameDir, 'launcher_profiles.json');
  if (fs.existsSync(file)) return false;
  const body = {
    profiles: {},
    settings: { enableSnapshots: false, keepLauncherOpen: false },
    version: 3
  };
  try {
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
    onLog('已补 launcher_profiles.json（官方安装器必需，否则会报 “no launcher profile”）');
    return true;
  } catch (err) {
    onLog(`警告：launcher_profiles.json 写入失败（安装器可能会拒绝安装）：${err?.message || err}`);
    return false;
  }
}

/**
 * ★★★ 2026-11-05 新增：把安装器写出来的库并进「共享库目录」。
 *
 * 官方安装器只认 `--installClient <gameDir>`，所以它把 Forge 的库全部写进
 * `<实例>/.minecraft/libraries/`。但 QCL 现在的布局是 **libraries 全实例共享**
 * （`<QCL_HOME>/.minecraft/libraries`），启动时也只从共享目录取。
 *
 * 不合并的后果（实测）：Forge 明明装好了，启动前检查报「缺
 * net/minecraftforge/forge/...-universal.jar」等一堆库，得靠自动补全再下一遍。
 * ⇒ 安装成功后把实例内的库合并到共享目录（已存在且大小相同就跳过）。
 */
function mergeLibrariesIntoShared(home, mcDir, onLog = () => {}) {
  if (!home) return 0;
  const from = path.join(mcDir, 'libraries');
  let to;
  try {
    const paths = require('./paths');
    to = paths.sharedLibrariesDir(home);
  } catch {
    to = path.join(home, '.minecraft', 'libraries');
  }
  if (!fs.existsSync(from) || path.resolve(from) === path.resolve(to)) return 0;
  let copied = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const src = path.join(dir, e.name);
      const rel = path.relative(from, src);
      const dest = path.join(to, rel);
      if (e.isDirectory()) {
        walk(src);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const sst = fs.statSync(src);
        if (fs.existsSync(dest)) {
          const dst = fs.statSync(dest);
          if (dst.size === sst.size) continue; // 已经有一份一样的
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied += 1;
      } catch {
        /* 单个文件失败不影响整体 */
      }
    }
  };
  walk(from);
  if (copied) onLog(`已把安装器写出的 ${copied} 个库合并到共享 libraries 目录`);
  return copied;
}

/**
 * 运行安装器。
 *
 * @returns {Promise<{code:number, output:string[]}>}
 */
function runInstaller({ javaPath, jarPath, args, gameDir, onLog = () => {}, timeoutMs = 600000 }) {
  return new Promise((resolve, reject) => {
    // ★ 必须补 launcher_profiles.json，否则 Forge/NeoForge 安装器直接退出码 1
    ensureLauncherProfiles(gameDir, onLog);
    onLog(`运行安装器：java -jar ${path.basename(jarPath)} ${args.join(' ')} ${gameDir}`);
    const child = spawn(javaPath, ['-jar', jarPath, ...args, gameDir], {
      cwd: gameDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const output = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error('安装器运行超时（10 分钟），请检查网络或手动安装'));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        output.push(line);
        onLog(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动安装器：${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

/** 在 versions/ 下找安装器生成的新目录（按修改时间取最新） */
function findGeneratedVersion(versionsDir, before) {
  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  const candidates = [];
  for (const e of entries) {
    const json = path.join(versionsDir, e.name, `${e.name}.json`);
    if (!fs.existsSync(json)) continue;
    try {
      const st = fs.statSync(json);
      if (before && st.mtimeMs <= before) continue;
      candidates.push({ id: e.name, json, mtime: st.mtimeMs });
    } catch {
      /* 忽略 */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}

/**
 * 安装一个需要运行安装器的加载器。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} opts.instanceDir
 * @param {string} opts.mcVersion
 * @param {object} opts.loader  {type, version}
 * @param {string} opts.javaPath
 * @param {function} [opts.onLog]
 * @param {function} [opts.onProgress]
 * @returns {Promise<{installed:boolean, versionId?:string, manual?:string, hint?:string}>}
 */
async function installLoader({ home, instanceDir, mcVersion, loader, javaPath, onLog = () => {}, onProgress = () => {} }) {
  const plan = installerUrls(loader, mcVersion);
  if (!plan) throw new Error(`不支持的加载器类型：${loader.type}`);

  // OptiFine / LiteLoader 只能手动 —— 明确告诉用户，不假装能装
  if (!plan.urls.length) {
    return { installed: false, manual: plan.manual, hint: plan.manualHint, versionId: plan.id };
  }

  const installDir = path.join(String(home || ''), 'dependencies', 'installers');
  const jarPath = path.join(installDir, `${plan.id}-installer.jar`);

  onLog(`准备安装 ${loader.type}：${plan.id}`);
  if (!fs.existsSync(jarPath) || fs.statSync(jarPath).size < 4096) {
    await downloadInstaller({ urls: plan.urls, dest: jarPath, onLog, onProgress });
  } else {
    onLog('安装器已缓存，跳过下载');
  }

  const mcDir = path.join(instanceDir, '.minecraft');
  const versionsDir = path.join(mcDir, 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  const before = Date.now();

  const result = await runInstaller({
    javaPath,
    jarPath,
    args: plan.args,
    gameDir: mcDir,
    onLog
  });

  if (result.code !== 0) {
    // 有些安装器即使成功也返回非 0，先看有没有产物
    const generated = findGeneratedVersion(versionsDir, before);
    if (!generated) {
      throw new Error(
        `安装器退出码 ${result.code}，且没有生成版本目录。` +
          `最后几行输出：${result.output.slice(-5).join(' | ')}`
      );
    }
    onLog(`安装器返回 ${result.code}，但已生成版本 ${generated.id}，按成功处理`);
    mergeLibrariesIntoShared(home, mcDir, onLog);
    return { installed: true, versionId: generated.id };
  }

  const generated = findGeneratedVersion(versionsDir, before);
  if (!generated) {
    throw new Error('安装器运行完毕，但 versions/ 下没有发现新版本目录');
  }
  mergeLibrariesIntoShared(home, mcDir, onLog);
  onLog(`安装完成：${generated.id}`);
  return { installed: true, versionId: generated.id };
}

/** 这个加载器是否需要运行安装器 */
function needsInstaller(type) {
  return ['forge', 'neoforge', 'optifine', 'liteloader'].includes(String(type || '').toLowerCase());
}

module.exports = { installLoader, installerUrls, needsInstaller, findGeneratedVersion, mergeLibrariesIntoShared };
