'use strict';
/*
 * downloader.js —— 并发下载器。
 *
 * 契约要求：默认 16 线程、sha1/size 校验、失败重试 3 次、断点（已存在且校验通过就跳过）、
 * AbortController 取消、按字节推进度；source='bmclapi' 时替换域名。
 *
 * 校验策略（照 MultiMC Library::getDownloads + AssetObject::getDownloadAction）：
 *   · 有 sha1 → 必须 sha1 相符才算「已存在」，否则重下；
 *   · 只有 size → 大小相符才算「已存在」；
 *   · 都没有 → 只要文件存在且非空就跳过。
 * 写盘策略：先写 <dest>.part，校验通过后再 rename —— 半截文件永远不会被当成已下好。
 *
 * 进度口径（必须真实，不能重复计数）：
 *   current = done + skipped          ← 每个任务只计一次
 *   bytes   = 已落盘字节 + 正在写入的字节（liveBytes）
 * 失败重试时 liveBytes 归零，避免把重试的字节算进总进度。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const http = require('./http');
const { LauncherError } = http;

const DEFAULT_THREADS = 16;
const DEFAULT_ATTEMPTS = 3; // 总共 3 次尝试（1 次 + 2 次重试）

/**
 * BMCLAPI 镜像域名改写。
 * 官方源：piston-meta / launchermeta / launcher / piston-data / resources / libraries
 * 镜像源：bmclapi2.bangbang93.com（资源与 maven 有各自的前缀）
 */
const MIRROR_HOST = 'https://bmclapi2.bangbang93.com';

function rewriteUrl(url, source) {
  const raw = String(url || '');
  if (source !== 'bmclapi' || !raw) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'bmclapi2.bangbang93.com' || host === 'bmclapi.bangbang93.com') return raw;
    if (host === 'resources.download.minecraft.net') {
      return `${MIRROR_HOST}/assets${u.pathname}${u.search}`;
    }
    if (host === 'libraries.minecraft.net') {
      return `${MIRROR_HOST}/maven${u.pathname}${u.search}`;
    }
    if (host === 'piston-meta.mojang.com' || host === 'launchermeta.mojang.com' || host === 'launcher.mojang.com') {
      return `${MIRROR_HOST}${u.pathname}${u.search}`;
    }
    if (host === 'piston-data.mojang.com') {
      // 1.12.2+ 的客户端 jar 在 piston-data 上；install.js 会额外把
      // /version/<id>/client 作为备用地址，所以这里照路径改写即可。
      return `${MIRROR_HOST}${u.pathname}${u.search}`;
    }
    return raw;
  } catch (_) {
    return raw;
  }
}

/** 是否走镜像（给上层拼镜像专用路径用）。 */
function mirrorBase(source, fallback) {
  return source === 'bmclapi' ? MIRROR_HOST : fallback;
}

function sha1OfFile(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 已存在的文件是否可用（校验通过 → 跳过下载）。 */
async function isUpToDate(task) {
  let stat;
  try {
    stat = await fsp.stat(task.dest);
  } catch (_) {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  if (task.size && Number(task.size) > 0 && stat.size !== Number(task.size)) return false;
  if (task.sha1) {
    const actual = await sha1OfFile(task.dest);
    if (!actual) return false;
    return actual.toLowerCase() === String(task.sha1).toLowerCase();
  }
  return true;
}

/**
 * 单文件下载（含校验与重试），返回实际写入的字节数。
 * 职责边界：本函数**不**推进 done 计数，只上报「正在写入」的字节；done 由调度层计一次。
 */
async function downloadOne(task, ctx) {
  const dest = task.dest;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  // 候选地址：主地址 + 备用地址（镜像回退用），每个都按 source 改写一次
  const candidates = [task.url]
    .concat(Array.isArray(task.fallbackUrls) ? task.fallbackUrls : [])
    .filter(Boolean)
    .map((u) => rewriteUrl(u, ctx.source));

  const maxAttempts = Number.isFinite(task.attempts) ? Math.max(1, task.attempts) : ctx.attempts;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (ctx.signal && ctx.signal.aborted) throw new LauncherError('操作已取消', { code: 'E_CANCELLED' });
    for (const url of candidates) {
      ctx.resetLive();
      try {
        const response = await http.openStream(url, {
          signal: ctx.signal,
          timeoutMs: ctx.timeoutMs,
          retries: 0, // 重试由本函数负责，避免嵌套重试放大等待
        });

        const declared = Number(response.headers.get('content-length') || 0);
        const hash = crypto.createHash('sha1');
        let written = 0;
        let lastEmit = 0;

        const source = Readable.fromWeb(response.body);
        source.on('data', (chunk) => {
          hash.update(chunk);
          written += chunk.length;
          ctx.addLive(chunk.length);
          const now = Date.now();
          if (now - lastEmit > 120) {
            lastEmit = now;
            ctx.emitProgress(task);
          }
        });

        await pipeline(source, fs.createWriteStream(part));

        if (declared > 0 && written !== declared) {
          throw new LauncherError(`文件 ${path.basename(dest)} 下载不完整（收到 ${written} 字节，应有 ${declared} 字节）`, {
            code: 'E_INCOMPLETE',
          });
        }
        if (task.size && Number(task.size) > 0 && written !== Number(task.size)) {
          throw new LauncherError(`文件 ${path.basename(dest)} 大小不符（收到 ${written} 字节，应为 ${task.size} 字节）`, {
            code: 'E_SIZE',
          });
        }
        if (task.sha1) {
          const actual = hash.digest('hex');
          if (actual.toLowerCase() !== String(task.sha1).toLowerCase()) {
            throw new LauncherError(`文件 ${path.basename(dest)} 校验失败（sha1 不符），可能下载到了错误内容`, {
              code: 'E_SHA1',
            });
          }
        }
        await fsp.rename(part, dest);
        ctx.commitLive(written);
        return written;
      } catch (err) {
        ctx.resetLive();
        if (ctx.signal && ctx.signal.aborted) throw new LauncherError('操作已取消', { code: 'E_CANCELLED' });
        lastError = err;
        try {
          await fsp.rm(part, { force: true });
        } catch (_) {
          /* 半截文件清理失败不影响后续重试 */
        }
        if (err && err.code === 'E_CANCELLED') throw err;
        // 换下一个候选地址继续试
      }
    }
    if (attempt < maxAttempts - 1) await http.sleep(500 * Math.pow(2, attempt));
  }
  throw lastError || new LauncherError(`下载 ${path.basename(dest)} 失败`);
}

/**
 * 并发下载一批文件。
 * @param {Array<{url:string,dest:string,sha1?:string,size?:number,optional?:boolean,fallbackUrls?:string[],name?:string}>} tasks
 * @param {{threads?:number,source?:'official'|'bmclapi',onProgress?:Function,signal?:AbortSignal,timeoutMs?:number,attempts?:number}} [options]
 * @returns {Promise<{done:number,skipped:number,failed:Array<{task:object,error:string}>}>}
 */
async function downloadAll(tasks, options) {
  const opts = options || {};
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.dest && t.url);
  const threads = Math.max(1, Number(opts.threads) || DEFAULT_THREADS);

  const state = {
    total: list.length,
    done: 0,
    skipped: 0,
    failed: [],
    file: '',
    bytes: 0, // 已落盘字节
    liveBytes: 0, // 正在写入的字节（重试时归零）
    bytesTotal: 0,
    speed: 0,
    _speedBytes: 0,
    _speedAt: Date.now(),
  };

  const emit = (task, finished) => {
    const now = Date.now();
    const elapsed = now - state._speedAt;
    if (elapsed >= 500) {
      state.speed = Math.round((state._speedBytes / elapsed) * 1000);
      state._speedBytes = 0;
      state._speedAt = now;
    }
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({
        current: state.done + state.skipped,
        total: state.total,
        file: (task && (task.name || task.dest)) || state.file,
        speed: state.speed,
        bytes: state.bytes + state.liveBytes,
        bytesTotal: state.bytesTotal,
        done: state.done,
        skipped: state.skipped,
        failed: state.failed.length,
      });
    }
    // ★ 计数只在这里加一次 —— downloadOne 内部绝不能再加
    if (finished) state.done += 1;
  };

  // 先判「能不能跳过」，并把总字节数算出来（进度条分母要真实）
  const pending = [];
  for (const task of list) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isUpToDate(task);
    if (ok) {
      state.skipped += 1;
      if (task.size) state.bytesTotal += Number(task.size);
    } else {
      pending.push(task);
      if (task.size) state.bytesTotal += Number(task.size);
    }
  }

  if (pending.length === 0) {
    emit(null, false);
    return { done: state.done, skipped: state.skipped, failed: state.failed };
  }

  const ctx = {
    source: opts.source === 'bmclapi' ? 'bmclapi' : 'official',
    signal: opts.signal,
    timeoutMs: Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : http.DEFAULT_TIMEOUT_MS,
    attempts: Number.isFinite(opts.attempts) ? Math.max(1, opts.attempts) : DEFAULT_ATTEMPTS,
    addLive(n) {
      state.liveBytes += n;
      state._speedBytes += n;
    },
    commitLive(n) {
      state.liveBytes = 0;
      state.bytes += n;
    },
    resetLive() {
      state.liveBytes = 0;
    },
    emitProgress(task) {
      state.file = (task && (task.name || task.dest)) || state.file;
      emit(task, false);
    },
  };

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (opts.signal && opts.signal.aborted) throw new LauncherError('操作已取消', { code: 'E_CANCELLED' });
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const task = pending[index];
      try {
        const written = await downloadOne(task, ctx);
        if (!task.size && written) state.bytesTotal += written;
        emit(task, true);
      } catch (err) {
        if (err && err.code === 'E_CANCELLED') throw err;
        const message = err instanceof LauncherError
          ? err.message
          : http.describeError(err, `下载 ${task.name || task.dest}`);
        if (task.optional) {
          state.skipped += 1;
          emit(task, false);
          continue;
        }
        state.failed.push({ task, error: message });
        emit(task, true);
      }
    }
  };

  const workers = [];
  const workerCount = Math.min(threads, pending.length);
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  const results = await Promise.allSettled(workers);

  const cancelled = results.find((r) => r.status === 'rejected' && r.reason && r.reason.code === 'E_CANCELLED');
  if (cancelled) throw cancelled.reason;
  const fatal = results.find((r) => r.status === 'rejected');
  if (fatal) throw fatal.reason instanceof Error ? fatal.reason : new LauncherError(String(fatal.reason));

  return { done: state.done, skipped: state.skipped, failed: state.failed };
}

module.exports = {
  DEFAULT_THREADS,
  DEFAULT_ATTEMPTS,
  MIRROR_HOST,
  rewriteUrl,
  mirrorBase,
  sha1OfFile,
  isUpToDate,
  downloadAll,
};
