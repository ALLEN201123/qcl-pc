/**
 * QCL 电脑版 · 主进程通信桥
 *
 * 契约：渲染层只用 window.qcl.invoke / on / off（见 docs/CONTRACT.md §3）。
 *
 * 本模块的三条硬要求：
 *  1. window.qcl 不存在（或 invoke 抛错）时，**绝不白屏** —— 降级为内置示例数据，
 *     并在顶部挂一条「未连接到主进程」提示。
 *  2. 主进程 core 还没就绪时抛的是中文错误（如「启动核心模块 xxx 尚未就绪」），
 *     必须原样把这条中文提示透出给用户，同时仍给出示例数据让界面有内容。
 *  3. 事件订阅要幂等：同一回调重复 on 不会重复触发。
 */

import { mockInvoke } from './mock.js';

/** window.qcl 是否真的存在 */
let hasBridge = false;
/** 是否已经成功调用过一次主进程（用于区分「完全没连上」和「刚启动还没连上」） */
let liveOK = false;
/** 最近一次的错误信息，避免同一条错误反复弹 */
let lastDegradedMsg = '';
/** 降级提示的回调（由 ui 层注册，避免 bridge 依赖 DOM） */
let onDegraded = null;
const listeners = new Map();

/** 自定义事件总线：bridge 自身也会用它派发示例进度 */
function localOn(evt, cb) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(cb);
  return () => localOff(evt, cb);
}
function localOff(evt, cb) {
  const set = listeners.get(evt);
  if (!set) return;
  if (cb) set.delete(cb);
  else set.clear();
}
export function emitLocal(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const cb of Array.from(set)) {
    try {
      cb(payload);
    } catch (err) {
      // 订阅者自己的异常不许影响其它订阅者
      console.error('[QCL] 事件回调异常：', evt, err);
    }
  }
}

export function initBridge() {
  hasBridge = !!(window.qcl && typeof window.qcl.invoke === 'function');
  if (hasBridge && typeof window.qcl.on === 'function') {
    // 把主进程事件转成同一套本地总线，页面只订阅本地总线即可
    //
    // ★★★ 新增事件必须登记在这里，否则页面的 on() 永远收不到（踩过两次）：
    //   · launch:stage       —— 「正在启动」窗口的 6 个阶段进度
    //   · launch:game-ready  —— 游戏真正进入主界面（启动窗口**只**在收到它时才关）
    //   · terracotta:state   —— 陶瓦联机的房间状态
    for (const evt of [
      'task:progress',
      'launch:log',
      'launch:state',
      'launch:stage',
      'launch:game-ready',
      'terracotta:state',
      'instances:changed',
      'accounts:changed',
      'settings:changed',
      'java:changed',
      'win:state',
    ]) {
      try {
        window.qcl.on(evt, (payload) => emitLocal(evt, payload));
      } catch (err) {
        console.warn('[QCL] 订阅主进程事件失败：', evt, err);
      }
    }
  }
  return hasBridge;
}

export function isConnected() {
  return hasBridge && liveOK;
}
export function hasMain() {
  return hasBridge;
}

export function setDegradedHandler(fn) {
  onDegraded = fn;
}

/**
 * 把主进程抛来的错误转成**简体中文**。
 * 界面铁律是「一个英文单词都不许漏在界面上」，所以 Electron/IPC 的英文原文
 * 必须在这里翻译掉；无法识别的再原样透出（便于排查），但不会留空。
 */
const ERROR_PATTERNS = [
  [/No handler registered for '([^']+)'/i, (m, ch) => `主进程还没有注册「${ch}」通道（core 可能尚未就绪）`],
  [/Error invoking remote method '[^']*':\s*/i, () => ''],
  [/Object has been destroyed/i, () => '窗口已关闭'],
  [/Cannot read properties of undefined/i, () => '主进程内部数据缺失，该功能暂不可用'],
  [/ENOENT[^]*?no such file or directory[^']*'?([^']*)'?/i, (m, p) => `找不到文件或目录${p ? `：${p}` : ''}`],
  [/EACCES[^]*/i, () => '没有权限访问该文件或目录'],
  [/ETIMEDOUT|timeout/i, () => '请求超时，请检查网络后重试'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, () => '无法解析服务器地址，请检查网络或下载源'],
  [/ECONNREFUSED|ECONNRESET|socket hang up/i, () => '连接被拒绝或中断，请检查网络或下载源'],
];

function normalizeError(err) {
  if (!err) return '未知错误';
  let raw = err.message || String(err);
  for (const [re, fn] of ERROR_PATTERNS) {
    const m = raw.match(re);
    if (m) {
      raw = fn.apply(null, m);
      if (!raw) {
        // 整条都是前缀，取剩余部分继续走后面的规则
        raw = (err.message || '').replace(re, '').trim();
      }
      break;
    }
  }
  // 还残留英文 Error 前缀就剥掉
  return raw.replace(/^Error:\s*/, '').trim() || '未知错误';
}

function reportDegraded(channel, msg) {
  if (msg === lastDegradedMsg) return;
  lastDegradedMsg = msg;
  if (typeof onDegraded === 'function') onDegraded(msg, channel);
}

/**
 * 调用主进程。永远不抛异常，永远返回一个对象：
 *   { ok: boolean, data: any, error?: string, source: 'main' | 'mock' }
 *
 * ★ 第三个参数 `opts.optional = true` 用于「后端可能还没接入」的可选通道
 *   （下载页的 content:* / versions:aprilFools 就是这种）：
 *   失败时**不触发全局降级**（不弹「主进程暂不可用」横幅、不把 state.connected 置 false），
 *   页面自己显示中文空状态即可。否则用户只是点一下「模组」分类，整个启动器就会被标成「示例模式」。
 */
export async function call(channel, payload = {}, opts = {}) {
  const optional = !!(opts && opts.optional);
  if (!hasBridge) {
    if (!optional) reportDegraded(channel, '未连接到主进程');
    let fallback = null;
    if (!optional) {
      try {
        fallback = mockInvoke(channel, payload);
      } catch (e) {
        fallback = null;
      }
    }
    return { ok: false, source: 'mock', data: fallback, error: '未连接到主进程' };
  }
  try {
    const data = await window.qcl.invoke(channel, payload);
    liveOK = true;
    lastDegradedMsg = '';
    return { ok: true, source: 'main', data };
  } catch (err) {
    const msg = normalizeError(err);
    if (!optional) reportDegraded(channel, msg);
    let fallback = null;
    if (!optional) {
      try {
        fallback = mockInvoke(channel, payload);
      } catch (e) {
        fallback = null;
      }
    }
    return { ok: false, source: 'mock', data: fallback, error: msg };
  }
}

/** 只要数据（拿不到就返回 fallback），用于不关心错误的场景 */
export async function callData(channel, payload = {}, fallback = null) {
  const r = await call(channel, payload);
  return r.data == null ? fallback : r.data;
}

export function on(evt, cb) {
  return localOn(evt, cb);
}
export function off(evt, cb) {
  localOff(evt, cb);
}

/** 窗口控制快捷方法 */
export const win = {
  minimize: () => call('win:minimize'),
  toggleMaximize: () => call('win:toggleMaximize'),
  close: () => call('win:close'),
  state: () => callData('win:state', {}, { maximized: false, fullscreen: false, inset: 18 }),
};
