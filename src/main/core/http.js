'use strict';
/*
 * http.js —— 统一网络层。
 *
 * 约束（契约 §4）：
 *   1) 所有请求带超时（默认 30s）与重试；
 *   2) 抛给上层的错误信息必须是中文，绝不把英文栈丢到界面上；
 *   3) 只用 Node 内置模块（Node 24 自带全局 fetch / AbortSignal）。
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2; // 失败后再试 2 次 = 总共 3 次尝试

/** 带中文信息与错误码的启动器错误。 */
class LauncherError extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'LauncherError';
    const opts = options || {};
    this.code = opts.code || 'E_LAUNCHER';
    this.cause = opts.cause;
    this.detail = opts.detail;
  }
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ABORT_ERR') return true;
  // AbortSignal.timeout 抛的是 TimeoutError，属于「超时」不是「用户取消」
  return false;
}

function isTimeoutError(err) {
  return !!err && (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');
}

/** 把任意底层异常翻译成中文说明。 */
function describeError(err, what) {
  const subject = what || '网络请求';
  if (!err) return `${subject}失败：未知原因`;
  if (isTimeoutError(err)) return `${subject}超时（超过 ${DEFAULT_TIMEOUT_MS / 1000} 秒没有响应），请检查网络或稍后重试`;
  const code = err.code || (err.cause && err.cause.code);
  const map = {
    ENOTFOUND: '域名解析失败，可能是本机没有联网或 DNS 被拦截',
    EAI_AGAIN: '域名解析暂时失败，请稍后重试',
    ECONNREFUSED: '连接被拒绝，对方服务器可能不可达',
    ECONNRESET: '连接被对方重置，请稍后重试',
    ETIMEDOUT: '连接超时，请检查网络',
    EHOSTUNREACH: '网络不可达，请检查网络',
    ENETUNREACH: '网络不可达，请检查网络',
    EPROTO: 'TLS 握手失败，可能是网络中间设备干扰',
    CERT_HAS_EXPIRED: '对方证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链校验失败，可能是网络中间设备干扰',
  };
  if (code && map[code]) return `${subject}失败：${map[code]}`;
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status) {
    if (status === 404) return `${subject}失败：服务器上找不到该文件（HTTP 404）`;
    if (status === 403) return `${subject}失败：服务器拒绝访问（HTTP 403）`;
    if (status === 429) return `${subject}失败：请求过于频繁被限流（HTTP 429），请稍后重试`;
    if (status >= 500) return `${subject}失败：对方服务器出错（HTTP ${status}），请稍后重试`;
    return `${subject}失败：服务器返回 HTTP ${status}`;
  }
  if (err.name === 'AbortError') return `${subject}已取消`;
  const raw = err.message ? String(err.message) : String(err);
  return `${subject}失败：${raw}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 组合「外部取消信号」与「超时信号」。 */
function combineSignals(external, timeoutMs) {
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  if (!external) return timeoutSignal;
  if (!timeoutSignal) return external;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeoutSignal]);
  return external;
}

/**
 * 发起一次带超时的请求，返回 Response。
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:*, signal?:AbortSignal, timeoutMs?:number, redirect?:string}} [options]
 */
async function request(url, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const signal = combineSignals(opts.signal, timeoutMs);
  const init = {
    method: opts.method || 'GET',
    redirect: opts.redirect || 'follow',
    signal,
  };
  if (opts.headers) init.headers = opts.headers;
  if (opts.body !== undefined) init.body = opts.body;
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (isAbortError(err) && opts.signal && opts.signal.aborted) {
      throw new LauncherError('操作已取消', { code: 'E_CANCELLED', cause: err });
    }
    throw new LauncherError(describeError(err, `请求 ${url}`), {
      code: isTimeoutError(err) ? 'E_TIMEOUT' : 'E_NETWORK',
      cause: err,
    });
  }
  if (!response.ok) {
    const err = new LauncherError(describeError({ status: response.status }, `请求 ${url}`), {
      code: 'E_HTTP',
    });
    err.status = response.status;
    throw err;
  }
  return response;
}

/**
 * 带重试的请求；只在网络类错误与非 4xx 上重试。
 */
async function requestWithRetry(url, options) {
  const opts = options || {};
  const retries = Number.isFinite(opts.retries) ? Math.max(0, opts.retries) : DEFAULT_RETRIES;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (opts.signal && opts.signal.aborted) {
      throw new LauncherError('操作已取消', { code: 'E_CANCELLED' });
    }
    try {
      return await request(url, opts);
    } catch (err) {
      lastError = err;
      if (err && err.code === 'E_CANCELLED') throw err;
      // 404 / 403 这类重试没有意义
      if (err && err.code === 'E_HTTP' && err.status && err.status < 500 && err.status !== 429) throw err;
      if (attempt >= retries) break;
      await sleep(Math.min(4000, 600 * Math.pow(2, attempt)));
    }
  }
  throw lastError || new LauncherError(`请求 ${url} 失败：未知原因`);
}

/** 取文本（带重试）。 */
async function fetchText(url, options) {
  const response = await requestWithRetry(url, options);
  try {
    return await response.text();
  } catch (err) {
    throw new LauncherError(describeError(err, `读取 ${url} 的响应内容`), { code: 'E_NETWORK', cause: err });
  }
}

/** 取 JSON（带重试）；解析失败一律转成中文错误。 */
async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LauncherError(`解析 ${url} 返回的 JSON 失败：内容不是合法 JSON`, {
      code: 'E_JSON',
      cause: err,
      detail: text.slice(0, 200),
    });
  }
}

/** 取 Buffer（带重试），用于小文件。 */
async function fetchBuffer(url, options) {
  const response = await requestWithRetry(url, options);
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw new LauncherError(describeError(err, `读取 ${url} 的响应内容`), { code: 'E_NETWORK', cause: err });
  }
}

/** 带重试地打开响应流（下载器用；流本身由调用方消费）。 */
async function openStream(url, options) {
  const response = await requestWithRetry(url, options);
  return response;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  LauncherError,
  describeError,
  isAbortError,
  isTimeoutError,
  sleep,
  request,
  requestWithRetry,
  fetchText,
  fetchJson,
  fetchBuffer,
  openStream,
};
