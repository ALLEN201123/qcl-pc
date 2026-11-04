'use strict';
/**
 * QCL 电脑版 · 无边框融合窗口
 *
 * 「窗口边缘与界面完美融合」的实现要点：
 *  1. frame:false —— 没有系统标题栏、没有灰色边框。
 *  2. transparent:true —— 窗口底色全透明，圆角以外是真透明，不是白色方块。
 *  3. 窗口比「卡片」大一圈（SHADOW_MARGIN），卡片用 CSS 做外阴影与圆角，
 *     于是窗口物理边缘外就是柔和阴影渐隐到桌面 —— 边缘彻底消失。
 *  4. 最大化/全屏时把 inset 归零，卡片铺满，不露出透明缝。
 */

const { BrowserWindow, screen, app } = require('electron');
const path = require('node:path');

/** 卡片四周留出的阴影像素（渲染层用同一个值做 padding） */
const SHADOW_MARGIN = 18;

let mainWindow = null;

function isMaximized(win) {
  return !!(win && (win.isMaximized() || win.isFullScreen()));
}

/** 通知渲染层当前窗口状态：最大化时把阴影边距收掉 */
function pushWindowState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('win:state', {
    maximized: isMaximized(win),
    fullscreen: win.isFullScreen(),
    inset: isMaximized(win) ? 0 : SHADOW_MARGIN
  });
}

/**
 * 计算初始窗口位置与大小：默认占工作区 82%，居中；有历史记录则沿用。
 */
function resolveBounds(state, workArea) {
  const saved = state && state.windowBounds;
  if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    // 校验历史位置还在可见范围内（换显示器后不会跑到屏幕外）
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        saved.x + saved.width > a.x + 80 &&
        saved.x < a.x + a.width - 80 &&
        saved.y + saved.height > a.y + 40 &&
        saved.y < a.y + a.height - 40
      );
    });
    if (visible) return saved;
    return {
      width: saved.width,
      height: saved.height,
      x: Math.round(workArea.x + (workArea.width - saved.width) / 2),
      y: Math.round(workArea.y + (workArea.height - saved.height) / 2)
    };
  }
  const width = Math.max(1100, Math.round(workArea.width * 0.82));
  const height = Math.max(700, Math.round(workArea.height * 0.82));
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2)
  };
}

function createMainWindow({ dev = false, onBoundsChanged = null } = {}) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const bounds = resolveBounds(null, workArea);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // 阴影由渲染层 CSS 画，Windows 上透明窗口的系统阴影会变成黑边
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    roundedCorners: false,
    show: false,
    autoHideMenuBar: true,
    title: 'Quanta Craft Launcher PC',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  // 用自定义协议加载：file:// 下 fetch 会被 Chromium 拦掉，glTF/贴图就加载不了
  mainWindow.loadURL('qcl://app/index.html');

  // 先隐藏再显示，避免白屏闪一下（透明窗口尤其明显）
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    pushWindowState(mainWindow);
  });

  const emitState = () => pushWindowState(mainWindow);
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'resize', 'move']) {
    mainWindow.on(ev, emitState);
  }

  let saveTimer = null;
  mainWindow.on('resize', () => {
    if (typeof onBoundsChanged !== 'function') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
      onBoundsChanged(mainWindow.getBounds());
    }, 400);
  });

  mainWindow.webContents.on('did-finish-load', () => pushWindowState(mainWindow));

  // 渲染层不许自己跳外链（一律走 shell:openExternal）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  if (dev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

module.exports = {
  SHADOW_MARGIN,
  createMainWindow,
  getMainWindow,
  pushWindowState,
  isMaximized
};
