'use strict';
/**
 * 卸载窗口的 preload（与主界面的 preload 完全独立）
 *
 * 只暴露三个方法，不给页面任何多余能力：
 *   window.qclUninstall.run(opts)        执行卸载
 *   window.qclUninstall.cancel()         取消
 *   window.qclUninstall.onProgress(fn)   订阅进度文本
 */

const { contextBridge, ipcRenderer } = require('electron');

const CH = 'qcl-uninstall';
const RUN_RE = new RegExp(`^${CH}:(run|cancel|progress)$`);

contextBridge.exposeInMainWorld('qclUninstall', {
  run(opts) {
    const safe = opts && typeof opts === 'object' ? opts : {};
    return ipcRenderer.invoke(`${CH}:run`, {
      removeProgram: !!safe.removeProgram,
      removeData: !!safe.removeData,
      removeCache: !!safe.removeCache,
    });
  },
  cancel() {
    return ipcRenderer.invoke(`${CH}:cancel`);
  },
  onProgress(fn) {
    if (typeof fn !== 'function') return () => {};
    const handler = (_e, msg) => {
      try {
        fn(String(msg || ''));
      } catch {
        /* 页面自己的异常不影响主进程 */
      }
    };
    ipcRenderer.on(`${CH}:progress`, handler);
    return () => ipcRenderer.removeListener(`${CH}:progress`, handler);
  },
  /** 供测试断言用 */
  _channels: RUN_RE.source,
});
