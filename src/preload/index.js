'use strict';
/**
 * QCL 电脑版 · 预加载桥
 * 渲染层只能通过 window.qcl 访问主进程：invoke（请求）/ on（事件）/ off。
 * 通道白名单 + 事件白名单，防止渲染层乱调。
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_RE = /^(app|win|settings|instances|versions|install|launch|accounts|java|log|shell|tools|mods|modpack|terracotta|skin|authlib|content|loader|worlds):[A-Za-z]+$/;
const EVENT_RE = /^(task:progress|launch:log|launch:state|launch:stage|launch:game-ready|instances:changed|accounts:changed|settings:changed|java:changed|win:state|terracotta:state)$/;

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
