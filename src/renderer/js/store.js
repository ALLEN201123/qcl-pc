/**
 * QCL 电脑版 · 全局状态
 *
 * 单一数据源：settings / instances / accounts / java / appInfo。
 * 所有页面通过 store 读写，避免各自去 invoke。
 */

import { call, on } from './bridge.js';
import { DEFAULT_SETTINGS, SAMPLE_INSTANCES, SAMPLE_ACCOUNTS, SAMPLE_JAVA } from './mock.js';
import { applyTheme, watchSystemTheme } from './theme.js';

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export const state = {
  appInfo: { name: 'QCL', version: '1.0.0', platform: 'win32', home: '', arch: 'x64' },
  settings: clone(DEFAULT_SETTINGS),
  instances: [],
  accounts: [],
  java: [],
  currentInstanceId: null,
  currentAccountUuid: null,
  /** 主进程是否可用（false = 正在显示内置示例数据） */
  connected: false,
  /** 最近一次降级原因（中文） */
  degradedReason: '',
  ready: false,
};

const subscribers = new Set();

export function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function notify(reason = '') {
  for (const cb of Array.from(subscribers)) {
    try {
      cb(state, reason);
    } catch (err) {
      console.error('[QCL] 状态订阅者异常：', err);
    }
  }
}

/* ------------------------------ 读取 ------------------------------ */

export async function loadAppInfo() {
  const r = await call('app:info');
  if (r.data && typeof r.data === 'object') {
    state.appInfo = Object.assign(state.appInfo, r.data);
  }
  return state.appInfo;
}

export async function loadSettings() {
  const r = await call('settings:get');
  if (r.data && typeof r.data === 'object') {
    state.settings = Object.assign(clone(DEFAULT_SETTINGS), r.data, {
      theme: Object.assign(clone(DEFAULT_SETTINGS.theme), r.data.theme),
      memory: Object.assign(clone(DEFAULT_SETTINGS.memory), r.data.memory),
      launch: Object.assign(clone(DEFAULT_SETTINGS.launch), r.data.launch),
      downloader: Object.assign(clone(DEFAULT_SETTINGS.downloader), r.data.downloader),
    });
  }
  applyTheme(state.settings);
  return state.settings;
}

export async function loadInstances() {
  const r = await call('instances:list');
  state.instances = Array.isArray(r.data) ? r.data : [];
  if (state.instances.length === 0 && !r.ok) state.instances = clone(SAMPLE_INSTANCES);
  ensureCurrentInstance();
  return state.instances;
}

export async function loadAccounts() {
  const r = await call('accounts:list');
  state.accounts = Array.isArray(r.data) ? r.data : [];
  if (state.accounts.length === 0 && !r.ok) state.accounts = clone(SAMPLE_ACCOUNTS);
  ensureCurrentAccount();
  return state.accounts;
}

export async function loadJava() {
  const r = await call('java:list');
  state.java = Array.isArray(r.data) ? r.data : [];
  if (state.java.length === 0 && !r.ok) state.java = clone(SAMPLE_JAVA);
  return state.java;
}

/* ------------------------------ 当前实例 ------------------------------ */

const LS_KEY = 'qcl.currentInstanceId';
const LS_ACCOUNT = 'qcl.currentAccountUuid';

function readStoredInstance() {
  try {
    return window.localStorage.getItem(LS_KEY);
  } catch (err) {
    return null;
  }
}

function writeStoredInstance(id) {
  try {
    window.localStorage.setItem(LS_KEY, id);
  } catch (err) {
    /* 忽略：file:// 下 localStorage 可能不可用，内存态已足够 */
  }
}

export function ensureCurrentInstance() {
  const known = state.instances.some((x) => x.id === state.currentInstanceId);
  if (known) return state.currentInstanceId;
  const stored = readStoredInstance();
  if (stored && state.instances.some((x) => x.id === stored)) {
    state.currentInstanceId = stored;
    return stored;
  }
  state.currentInstanceId = state.instances.length > 0 ? state.instances[0].id : null;
  return state.currentInstanceId;
}

export function currentInstance() {
  return state.instances.find((x) => x.id === state.currentInstanceId) || null;
}

export function currentAccount() {
  const uuid = state.currentAccountUuid;
  const found = uuid ? state.accounts.find((a) => a.uuid === uuid) : null;
  return found || state.accounts[0] || null;
}

/** 切换当前使用的账号（契约里没有「选账号」通道，所以这个选择只存在渲染层） */
export function setCurrentAccount(uuid) {
  state.currentAccountUuid = uuid;
  try {
    window.localStorage.setItem(LS_ACCOUNT, uuid);
  } catch (err) {
    /* 忽略 */
  }
  notify('accounts');
}

export function ensureCurrentAccount() {
  const known = state.accounts.some((a) => a.uuid === state.currentAccountUuid);
  if (known) return state.currentAccountUuid;
  let stored = null;
  try {
    stored = window.localStorage.getItem(LS_ACCOUNT);
  } catch (err) {
    stored = null;
  }
  if (stored && state.accounts.some((a) => a.uuid === stored)) {
    state.currentAccountUuid = stored;
  } else {
    state.currentAccountUuid = state.accounts.length > 0 ? state.accounts[0].uuid : null;
  }
  return state.currentAccountUuid;
}

export function setCurrentInstance(id) {
  state.currentInstanceId = id;
  writeStoredInstance(id);
  call('instances:select', { id }).catch(() => {});
  notify('current-instance');
}

/* ------------------------------ 写设置 ------------------------------ */

export async function saveSettings(partial, { silent = false } = {}) {
  const merged = Object.assign({}, state.settings, partial, {
    theme: Object.assign({}, state.settings.theme, partial && partial.theme),
    memory: Object.assign({}, state.settings.memory, partial && partial.memory),
    launch: Object.assign({}, state.settings.launch, partial && partial.launch),
    downloader: Object.assign({}, state.settings.downloader, partial && partial.downloader),
    // ★ 2026-11-05：game 也要深度合并，否则只改「分辨率」会把「服务器地址」冲掉
    game: Object.assign({}, state.settings.game, partial && partial.game),
  });
  // 乐观更新：先本地生效，界面立刻有反馈，再回写主进程
  state.settings = merged;
  applyTheme(state.settings);
  notify('settings');
  const r = await call('settings:set', partial);
  if (r.data && typeof r.data === 'object') {
    state.settings = Object.assign(merged, r.data, {
      theme: Object.assign(merged.theme, r.data.theme),
      memory: Object.assign(merged.memory, r.data.memory),
      launch: Object.assign(merged.launch, r.data.launch),
      downloader: Object.assign(merged.downloader, r.data.downloader),
    });
  }
  applyTheme(state.settings);
  notify('settings');
  return { ok: r.ok, error: r.error, settings: state.settings };
}

/* ------------------------------ 启动 ------------------------------ */

export async function bootstrap() {
  await loadSettings();
  await Promise.all([loadAppInfo(), loadInstances(), loadAccounts(), loadJava()]);
  state.ready = true;
  notify('bootstrap');
  return state;
}

/** 订阅主进程推来的变更事件 */
export function wireStoreEvents() {
  on('instances:changed', async () => {
    const before = state.currentInstanceId;
    await loadInstances();
    if (before !== state.currentInstanceId) notify('current-instance');
    notify('instances');
  });
  on('accounts:changed', async () => {
    await loadAccounts();
    notify('accounts');
  });
  on('settings:changed', (payload) => {
    if (payload && typeof payload === 'object') {
      state.settings = Object.assign(state.settings, payload, {
        theme: Object.assign(state.settings.theme, payload.theme),
        memory: Object.assign(state.settings.memory, payload.memory),
        launch: Object.assign(state.settings.launch, payload.launch),
        downloader: Object.assign(state.settings.downloader, payload.downloader),
      });
    }
    applyTheme(state.settings);
    notify('settings');
  });
  watchSystemTheme(
    () => state.settings.theme && state.settings.theme.mode,
    () => {
      applyTheme(state.settings);
      notify('system-theme');
    }
  );
}

export function setConnected(ok, reason = '') {
  state.connected = ok;
  if (reason) state.degradedReason = reason;
  notify('connection');
}
