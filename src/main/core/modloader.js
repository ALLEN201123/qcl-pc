'use strict';
/*
 * modloader.js —— 给远古版本装 Risugami's ModLoader（下载 + 覆盖进 minecraft.jar）。
 *
 * ★ 逐条照抄安卓版（QCL 1.5.2）：
 *   backup_code_1.5.2/QCL/src/main/java/com/qcl/launcher/launcher/download/modloader/ModLoaderInstallTask.java
 *
 * 【装法是「文件覆盖」】
 * ModLoader 的压缩包里就是一堆 .class（BaseMod / ModLoader / EntityRendererProxy
 * 以及 b1.x 的混淆类名），直接解出来写进 minecraft.jar（同名覆盖）即可。
 * 不需要 tweakClass、不需要往 libraries 里加东西、不需要改版本 JSON ——
 * 这也是它和 Forge / Fabric 那类加载器最本质的区别。
 *
 * 【安全铁律】
 *   · 先写临时文件，再把原 jar 改名成 .mlbak，tmp 改名成原 jar；
 *   · 任一步失败必须把 .mlbak 恢复回原 jar —— **绝不能弄丢玩家的游戏本体**；
 *   · 改过签名的 jar 必须丢掉 META-INF/*.SF / *.RSA / *.DSA / *.EC，
 *     否则 JVM 会抛 `SecurityException: signer information does not match`
 *     （MANIFEST.MF 保留：没有 .SF 时 JVM 不会把它当签名 jar）。
 *
 * 【标记文件】
 * 装在版本目录下的 `.modloader`（四行纯文本：mcVersion / sha256 / injected / time），
 * 供 core/gamecheck.js 判断「这个版本的 jar 被我们改过 → 跳过文件校验」，
 * 也供界面显示「这个版本装了 ModLoader」。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const http = require('./http');
const downloader = require('./downloader');
const zip = require('./zip');
const zipwriter = require('./zipwriter');
const instances = require('./instances');
const paths = require('./paths');
const versions = require('./modloaderversions');

/** 版本目录下的标记文件（gamecheck 靠它跳过校验） */
const MARKER_NAME = '.modloader';

/** 下载超时：ModLoader 包只有几十 KB，2 分钟足够 */
const DOWNLOAD_TIMEOUT_MS = 120000;

/** 签名文件（改 jar 后必然失效，必须丢掉；MANIFEST.MF 不在此列） */
const SIGNATURE_RE = /^META-INF\/[^/]+\.(?:sf|rsa|dsa|ec)$/i;

/** 计算文件 SHA-256（小写十六进制） */
function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });
}

/** 标记文件路径 */
function markerPath(versionDir) {
  return path.join(versionDir, MARKER_NAME);
}

/** 这个版本目录装过 ModLoader 吗（只看标记文件） */
function isInstalled(versionDir) {
  if (!versionDir) return false;
  try {
    return fs.existsSync(markerPath(versionDir));
  } catch (_) {
    return false;
  }
}

/** 读标记内容（解析失败返回 null，不抛错） */
function readMarker(versionDir) {
  try {
    const text = fs.readFileSync(markerPath(versionDir), 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  } catch (_) {
    return null;
  }
}

/** 写标记文件（四行纯文本，方便玩家/人工排查） */
function writeMarker(versionDir, info) {
  const data = info || {};
  const text = [
    `mcVersion=${data.mcVersion || ''}`,
    `sha256=${data.sha256 || ''}`,
    `injected=${Number.isFinite(data.injected) ? data.injected : 0}`,
    `time=${new Date().toISOString()}`,
  ].join('\n');
  fs.mkdirSync(versionDir, { recursive: true });
  const file = markerPath(versionDir);
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  return file;
}

/**
 * 把 ModLoader 包里的所有 .class 覆盖进目标 jar。
 *
 * 步骤（照 Android ModLoaderInstallTask.injectClasses）：
 *   ① 读原 jar 全部条目（丢签名文件）；
 *   ② 用 ModLoader 包里的 .class 覆盖同名项；
 *   ③ 写到临时文件；
 *   ④ 原 jar → .mlbak，临时文件 → 原 jar，成功后删 .mlbak；失败则 .mlbak 恢复回原 jar。
 *
 * @param {string} packagePath 下载下来的 ModLoader 包（zip / jar）
 * @param {string} jarPath     目标 minecraft.jar
 * @returns {{injected:number, stripped:number, entries:number}}
 */
function injectClasses(packagePath, jarPath) {
  if (!fs.existsSync(jarPath)) {
    throw new http.LauncherError(`找不到游戏本体：${jarPath}`, { code: 'E_MODLOADER_NO_JAR' });
  }

  // ① 读原 jar（丢掉签名文件）
  const original = zip.open(jarPath);
  const entries = new Map();
  let stripped = 0;
  for (const entry of original.entries) {
    if (entry.isDirectory) continue;
    if (SIGNATURE_RE.test(entry.name)) {
      stripped += 1;
      continue;
    }
    entries.set(entry.name, original.readEntry(entry));
  }

  // ② 用 ModLoader 的 .class 覆盖
  const pkg = zip.open(packagePath);
  let injected = 0;
  for (const entry of pkg.entries) {
    if (entry.isDirectory) continue;
    if (!/\.class$/i.test(entry.name)) continue;
    entries.set(entry.name, pkg.readEntry(entry));
    injected += 1;
  }
  if (injected === 0) {
    throw new http.LauncherError(
      `这个 ModLoader 包里没有 .class，可能下错文件了：${path.basename(packagePath)}`,
      { code: 'E_MODLOADER_INJECT' }
    );
  }

  // ③ 先写临时文件（绝不在原 jar 上就地改）
  const tmpPath = `${jarPath}.mltmp`;
  const list = Array.from(entries.entries()).map(([name, data]) => ({ name, data }));
  try {
    zipwriter.createZip(tmpPath, list);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (_) {
      /* ignore */
    }
    throw new http.LauncherError(
      `写入临时 jar 失败（原文件未动）：${err && err.message ? err.message : err}`,
      { code: 'E_MODLOADER_INJECT', cause: err }
    );
  }

  // ④ 备份 → 替换 → 删备份（失败必须回滚）
  const backupPath = `${jarPath}.mlbak`;
  try {
    fs.rmSync(backupPath, { force: true });
  } catch (_) {
    /* 旧备份删不掉也不拦着装（下面 rename 会覆盖失败并报错） */
  }
  try {
    fs.renameSync(jarPath, backupPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw new http.LauncherError(
      `无法备份原 jar（原文件未动）：${jarPath}（${err && err.message ? err.message : err}）`,
      { code: 'E_MODLOADER_INJECT', cause: err }
    );
  }
  try {
    fs.renameSync(tmpPath, jarPath);
  } catch (err) {
    // 换不回去就把备份恢复，不能让玩家丢掉游戏本体
    let restored = false;
    try {
      fs.renameSync(backupPath, jarPath);
      restored = true;
    } catch (_) {
      /* 下面统一报错 */
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (_) {
      /* ignore */
    }
    throw new http.LauncherError(
      restored
        ? `写入 jar 失败，已恢复原文件：${jarPath}`
        : `写入 jar 失败，且恢复原文件也失败！请手动把 ${path.basename(backupPath)} 改名回 ${path.basename(jarPath)}`,
      { code: 'E_MODLOADER_INJECT', cause: err }
    );
  }
  try {
    fs.rmSync(backupPath, { force: true });
  } catch (_) {
    /* 备份留在那儿不影响游戏，下次安装会覆盖 */
  }

  return { injected, stripped, entries: entries.size };
}

/**
 * 给某个版本装 ModLoader。
 *
 * ★ 前置条件：这个版本的原版必须**已经装好**（jar 存在）。
 *   所以它永远在 install.js 的「原版安装完成」之后跑（见 install.js ⑤.7）。
 *
 * @param {{home:string, instanceId:string, mcVersion:string, versionId?:string,
 *          signal?:AbortSignal, onProgress?:Function, onLog?:Function}} params
 * @returns {Promise<{injected:number, stripped:number, marker:string, sha256:string|null, mcVersion:string, fileName:string}>}
 */
async function install(params) {
  const opts = params || {};
  const home = paths.homeOf(opts.home);
  const instanceId = String(opts.instanceId || '').trim();
  if (!instanceId) {
    throw new http.LauncherError('安装 ModLoader 失败：没有指定实例', { code: 'E_MODLOADER_PARAMS' });
  }
  const mcVersion = String(opts.mcVersion || '').trim();
  const versionId = String(opts.versionId || mcVersion).trim();
  if (!mcVersion || !versionId) {
    throw new http.LauncherError('安装 ModLoader 失败：没有指定游戏版本', { code: 'E_MODLOADER_PARAMS' });
  }

  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const emit = (patch) => {
    try {
      onProgress(patch || {});
    } catch (_) {
      /* 进度回调异常不影响安装 */
    }
  };
  const checkAborted = () => {
    if (opts.signal && opts.signal.aborted) {
      throw new http.LauncherError('安装 ModLoader 已取消', { code: 'E_CANCELLED' });
    }
  };

  // 1) 版本表里找条目
  const entry = versions.find(mcVersion);
  if (!entry) {
    throw new http.LauncherError(
      `这个版本（${mcVersion}）没有对应的 ModLoader。可到 MCArchive 的 ModLoader 页面手动下载后放进 jar。`,
      { code: 'E_MODLOADER_NO_ENTRY' }
    );
  }
  if (!entry.installable) {
    throw new http.LauncherError(
      `ModLoader ${entry.mcVersion} 官方只发了 .rar 格式的包，启动器现在解不开 rar，暂时装不了。`,
      { code: 'E_MODLOADER_RAR' }
    );
  }
  // ★ 下载源失效（安卓版用的 Gitee 镜像 2026-11-05 实测 404）→ 直接给中文原因，别让玩家等下载失败
  if (entry.available === false) {
    throw new http.LauncherError(
      entry.note || `ModLoader ${entry.mcVersion} 的下载源已失效，暂时装不了。`,
      { code: 'E_MODLOADER_UNAVAILABLE' }
    );
  }

  // 2) 目标版本目录 + 游戏本体
  const versionDir = path.join(paths.versionsDir(home, instanceId), versionId);
  const jarPath = path.join(versionDir, `${versionId}.jar`);
  if (!fs.existsSync(jarPath)) {
    throw new http.LauncherError(
      `这个版本还没有游戏本体（jar）：${jarPath}\n请先装好原版本，再装 ModLoader。`,
      { code: 'E_MODLOADER_NO_JAR' }
    );
  }

  const url = versions.urlOf(entry);
  if (!url) {
    throw new http.LauncherError(`ModLoader ${entry.mcVersion} 没有可用的下载地址（版本表条目缺少 SHA-256）`, {
      code: 'E_MODLOADER_NO_URL',
    });
  }

  onLog(`开始安装 ModLoader ${entry.mcVersion}：${entry.fileName}`);
  onLog(`下载地址：${url}`);

  // 3) 下载到临时目录（失败/取消都不会污染版本目录）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcl-modloader-'));
  const packagePath = path.join(tmpDir, 'modloader-package.zip');
  try {
    checkAborted();
    emit({ stage: '下载 ModLoader', file: entry.fileName, percent: 0 });
    const dl = await downloader.downloadAll(
      [{ url, dest: packagePath, name: entry.fileName }],
      {
        threads: 1,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        signal: opts.signal,
        onProgress: (p) => {
          const total = Number(p && p.bytesTotal) || 0;
          const bytes = Number(p && p.bytes) || 0;
          const percent = total > 0 ? Math.min(55, Math.round((bytes / total) * 55)) : 1;
          emit({ stage: '下载 ModLoader', file: (p && p.file) || entry.fileName, percent });
        },
      }
    );
    if (dl.failed.length) {
      throw new http.LauncherError(`ModLoader 下载失败：${dl.failed[0].error}`, {
        code: 'E_MODLOADER_DOWNLOAD',
      });
    }

    // 4) 校验 SHA-256（不一致删掉坏文件并报中文错误）
    if (entry.hasChecksum) {
      emit({ stage: '校验 ModLoader', file: entry.fileName, percent: 58 });
      const got = await sha256OfFile(packagePath);
      if (got !== entry.sha256) {
        try {
          fs.rmSync(packagePath, { force: true });
        } catch (_) {
          /* ignore */
        }
        throw new http.LauncherError(
          `ModLoader 校验失败（SHA-256 不一致）：期望 ${entry.sha256}，实际 ${got}。已删除下载到的坏文件，请重试。`,
          { code: 'E_MODLOADER_SHA256' }
        );
      }
      onLog(`ModLoader 校验通过（SHA-256 ${got}）`);
    } else {
      onLog('这个 ModLoader 条目没有官方 SHA-256，跳过校验');
    }

    checkAborted();

    // 5) 覆盖进 jar
    emit({ stage: '写入 minecraft.jar', file: path.basename(jarPath), percent: 62 });
    const result = injectClasses(packagePath, jarPath);
    if (result.stripped > 0) {
      onLog(`已移除 ${result.stripped} 个 META-INF 签名条目（改 jar 后签名必然失效）`);
    }
    onLog(`已把 ${result.injected} 个 ModLoader class 写入 ${path.basename(jarPath)}（jar 内共 ${result.entries} 个条目）`);
    emit({ stage: '写入 minecraft.jar', file: path.basename(jarPath), percent: 92 });

    // 6) 写标记
    const marker = writeMarker(versionDir, {
      mcVersion: entry.mcVersion,
      sha256: entry.sha256 || '',
      injected: result.injected,
    });
    onLog(`已写标记文件：${marker}`);

    // 7) 这个版本自动关掉「检查游戏文件」（jar 被改过，sha1 必然对不上）
    //    与安卓版一致：只作用于这一个实例，不动全局设置。
    try {
      await instances.update(home, instanceId, { notCheckGameFiles: true });
      onLog('已关闭该版本的「检查游戏文件」（ModLoader 改了 jar，原版 sha1 必然不符）');
    } catch (err) {
      // 关不掉不影响 ModLoader 已装好
      onLog(`警告：自动关闭「检查游戏文件」失败（不影响 ModLoader）：${err && err.message ? err.message : err}`);
    }

    emit({ stage: '完成', file: entry.fileName, percent: 100, done: true });
    return {
      injected: result.injected,
      stripped: result.stripped,
      marker,
      sha256: entry.sha256 || null,
      mcVersion: entry.mcVersion,
      fileName: entry.fileName,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录清不掉不影响结果 */
    }
  }
}

module.exports = {
  MARKER_NAME,
  DOWNLOAD_TIMEOUT_MS,
  sha256OfFile,
  markerPath,
  isInstalled,
  readMarker,
  writeMarker,
  injectClasses,
  install,
};
