'use strict';
/**
 * QCL 电脑版 · 预加载桥
 * 渲染层只能通过 window.qcl 访问主进程：invoke（请求）/ on（事件）/ off。
 * 通道白名单 + 事件白名单，防止渲染层乱调。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * IPC 通道白名单。
 *
 * ★★★ 2026-11-22 修（实测踩到：服务端的「配置」tab 一片空白）。
 *
 * 以前是 `/^(app|...):[A-Za-z]+$/` —— **只允许一段**，即 `server:list` 过、
 * 但 `server:props:read` / `server:backup:create` 这类**两段命令名**会被拒，
 * 渲染层拿到「不允许调用的通道」，界面就静默空白（不报错，最难查）。
 *
 * ⇒ 改成允许 `前缀:段[:段...]` 的多段形式（每段仍是纯字母，避免奇怪字符混入）。
 *   前缀白名单本身没放宽，未知前缀（如 evil:x）照样拦。
 */
const INVOKE_RE = /^(app|win|settings|instances|versions|install|launch|accounts|java|log|shell|tools|mods|modpack|terracotta|skin|authlib|content|loader|worlds|toolbox|server):[A-Za-z]+(?::[A-Za-z]+)*$/;
const EVENT_RE = /^(task:progress|launch:log|launch:state|launch:stage|launch:game-ready|instances:changed|accounts:changed|settings:changed|java:changed|win:state|terracotta:state|server:log|server:state|server:changed|server:tunnel:log|server:tunnel:state)$/;

/** cb -> wrapper，用于 off 时精确移除 */
const wrappers = new Map();

function invoke(channel, payload) {
  if (typeof channel !== 'string' || !INVOKE_RE.test(channel)) {
    return Promise.reject(new Error(`不允许调用的通道：${channel}`));
  }
  return ipcRenderer.invoke(channel, payload ?? {});
}

function on(event, cb) {
  if (typeof event !== 'string' || !EVENT_RE.test(event)) {
    throw new Error(`不允许监听的事件：${event}`);
  }
  if (typeof cb !== 'function') throw new Error('事件回调必须是函数');
  const wrapper = (_e, data) => {
    try {
      cb(data);
    } catch (err) {
      console.error(`[QCL] 事件 ${event} 的回调出错：`, err);
    }
  };
  wrappers.set(cb, { event, wrapper });
  ipcRenderer.on(event, wrapper);
  return () => off(event, cb);
}

function off(event, cb) {
  const entry = wrappers.get(cb);
  if (!entry) return;
  ipcRenderer.removeListener(entry.event, entry.wrapper);
  wrappers.delete(cb);
}

contextBridge.exposeInMainWorld('qcl', {
  invoke,
  on,
  off,
  /** 渲染层用来判断自己是不是跑在 Electron 里 */
  isElectron: true,
  platform: process.platform
});
