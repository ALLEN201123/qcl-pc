'use strict';
/**
 * QCL 电脑版 · 主进程入口
 * QCL = Quanta Craft Launcher（量子方块启动器）电脑版
 * 启动核心逻辑参照 MultiMC（vendor/MultiMC），界面照安卓版 QCL 1.5.9 新排版。
 */

const { app, Menu, dialog, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { Settings } = require('./settings');
const { createMainWindow, getMainWindow } = require('./window');
const { registerIpc, initContext } = require('./ipc');

const DEV = process.argv.includes('--dev') || process.env.QCL_DEV === '1';

/**
 * ★ 自定义协议 qcl://app/*
 *
 * 为什么必须有它：渲染层要加载 glTF 模型与皮肤贴图，而 Chromium **禁止 file:// 页面用
 * fetch/XHR 读本地文件**（three.js 的 GLTFLoader 正是走 fetch），直接 file:// 打开会加载失败。
 * 注册一个 standard+secure 的自定义协议后，页面的相对路径（./assets/...）会自动解析成
 * qcl://app/assets/...，fetch 正常工作，同时仍然只暴露 renderer 目录（防目录穿越）。
 */
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_ORIGIN = 'qcl://app';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qcl',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false
    }
  }
]);

function registerAppProtocol() {
  protocol.handle('qcl', async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname || '');
      if (rel.startsWith('/')) rel = rel.slice(1);
      if (!rel) rel = 'index.html';

      const target = path.normalize(path.join(RENDERER_DIR, rel));
      // 目录穿越防护：必须仍在 renderer 目录内
      if (target !== RENDERER_DIR && !target.startsWith(RENDERER_DIR + path.sep)) {
        return new Response('403 禁止访问该路径', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return await net.fetch(pathToFileURL(target).toString());
    } catch (err) {
      return new Response(`404 找不到资源：${err?.message || err}`, {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }
  });
}

// Windows 任务栏/通知要用它才能正确归组
app.setAppUserModelId('com.qcl.launcher.pc');
app.setName('QCL');

/**
 * 找出一个「真的能写进去」的目录。
 * 光 Test-Path 不够 —— 目录存在但不可写（EPERM/EACCES）时照样会炸，
 * 所以这里实际写一个探针文件来验证。全部失败则返回 null。
 */
function pickWritableDir(candidates, label) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.qcl-write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'probe', 'utf8');
      fs.unlinkSync(probe);
      return dir;
    } catch (err) {
      console.warn(`[QCL] ${label} 候选目录不可用：${dir}（${err?.code || err?.message}）`);
    }
  }
  return null;
}

/**
 * ★ 必须在 app.whenReady() 之前把 userData 指到确定可写的位置。
 *
 * 为什么：默认 userData 是 `%APPDATA%\QCL`，在某些启动环境（从别的进程 job 里拉起、
 * 受限账户、沙箱）下会让 Electron 主进程在 ready 之前直接 0xC0000005 访问违例退出，
 * 表现为「双击没反应」。指到 QCL 主目录下就与启动方式无关了。
 *
 * ★ 主目录（文档\QCL）也可能因为受控文件夹权限（OneDrive/安全软件）建不出来，
 *   所以这里做多级兜底：文档 → AppData → 本地缓存目录 → 程序目录 → 临时目录。
 */
function configureUserData() {
  // 1. 先确定 QCL 主目录（用户数据）
  let home = null;
  try {
    home = resolveHomeDir();
  } catch (err) {
    console.warn('[QCL] 解析主目录失败：', err?.message || err);
  }
  HOME_DIR = home;

  // 2. 再确定 userData（Electron 自己的缓存/配置）
  //    顺序：主目录下的 .appdata → userData 参数指定的位置 → AppData → 程序目录
  const userDataCandidates = [];
  if (home) userDataCandidates.push(path.join(home, '.appdata'));
  // --user-data-dir 指定的位置往往已经是可写的，优先用
  if (process.argv.some((a) => a.startsWith('--user-data-dir'))) {
    const arg = process.argv.find((a) => a.startsWith('--user-data-dir'));
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : process.argv[process.argv.indexOf(arg) + 1];
    if (value) userDataCandidates.unshift(path.resolve(value));
  }
  if (app.getPath('userData')) userDataCandidates.push(app.getPath('userData'));
  userDataCandidates.push(path.join(path.dirname(process.execPath), 'QCL-data', 'appdata'));

  const userData = pickWritableDir(userDataCandidates, 'userData');
  if (!userData) {
    console.warn('[QCL] 没有可写的 userData 目录，沿用 Electron 默认位置');
    return null;
  }

  app.setPath('userData', userData);
  // userData 改了之后，缓存/会话数据也要跟着走，否则又落回 %APPDATA%
  try {
    const cacheDir = path.join(userData, 'Cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    app.setPath('cache', cacheDir);
    app.setPath('sessionData', userData);
  } catch {
    /* 个别 Electron 版本没有这两个键，忽略 */
  }
  return userData;
}

/** QCL 主目录：优先用 settings.json 里已保存的路径，否则依次尝试可写目录 */
function resolveHomeDir() {
  // 用户可能已经在别处存过设置
  const candidatesFromSettings = [];
  for (const base of [app.getPath('documents'), app.getPath('appData'), app.getPath('temp'), process.cwd()]) {
    if (!base) continue;
    try {
      // 先看 base\QCL\settings.json，再看 base\settings.json（用户可能把 QCL 直接放在 base 下）
      for (const file of [path.join(base, 'QCL', 'settings.json'), path.join(base, 'settings.json')]) {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.home === 'string' && parsed.home.trim()) {
          candidatesFromSettings.push(parsed.home.trim());
        }
      }
    } catch {
      /* 这个位置没有设置文件 */
    }
  }
  if (candidatesFromSettings.length) return candidatesFromSettings[0];

  /**
   * ★ 顺序有讲究：
   *   1. 文档\QCL —— 用户能看见、能自己备份，最符合「启动器数据目录」的直觉；
   *   2. 程序目录\QCL-data —— 绿色版放在 D:\ 这类非系统盘时最好用；
   *   3. AppData —— 系统盘用户目录；
   *   4. userData（已经被验证可写的那一层）；
   *   5. 临时目录 —— 最后兜底。
   *
   * 为什么不直接写死文档目录：从受限环境（如被沙箱化的父进程、受控文件夹权限）
   * 启动时，`C:\Users\<用户>\Documents` 会返回 EPERM，而工作目录与程序目录反而可写。
   * 所以一律用「实际写探针文件」的方式判断，而不是假设。
   */
  const candidates = [
    path.join(app.getPath('documents'), 'QCL'),
    path.join(path.dirname(process.execPath), 'QCL-data'),
    path.join(app.getPath('appData'), 'QCL'),
    app.getPath('userData'),
    path.join(app.getPath('temp'), 'QCL')
  ];
  return pickWritableDir(candidates, '主目录');
}

/** 启动早期就探测出来的可写主目录，供 Settings 与 IPC 复用（null = 交给 Settings 自己算） */
let HOME_DIR = null;

const USER_DATA = configureUserData();

// 单实例：第二次启动时把已有窗口拉到前面，不要开两个
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 不要默认菜单栏（Alt 也不弹），界面自己画标题栏
    Menu.setApplicationMenu(null);

    // 先注册 qcl:// 协议，再创建窗口（窗口用 qcl://app/index.html 加载）
    registerAppProtocol();

    // homeOverride 沿用启动早期探测出来的可写主目录，避免这里再算一次又不一致
    const settings = new Settings({
      documentsDir: app.getPath('documents'),
      homeOverride: HOME_DIR || null
    });
    settings.load();

    // 兜底：主目录必须存在
    try {
      fs.mkdirSync(settings.value('home'), { recursive: true });
      fs.mkdirSync(path.join(settings.value('home'), 'logs'), { recursive: true });
    } catch (err) {
      dialog.showErrorBox('QCL 无法创建数据目录', `路径：${settings.value('home')}\n${err.message}`);
    }

    /**
     * ★★★ 2026-11-06（用户反馈「打开程序目录看不到自己的实例」）。
     *
     * 装完之后 `Programs\QCL` 里只有 QCL.exe / resources / QCL-data，
     * 玩家找不到 instances —— 以为数据丢了。真实数据在 `文档\QCL`。
     * ⇒ 在程序目录里建一个目录联接（junction，**不需要管理员权限**）：
     *      Programs\QCL\QCL数据  →  文档\QCL
     * 玩家打开程序目录点进「QCL数据」就能看到 instances / accounts / meta。
     * 失败只写日志，绝不拦启动；便携版（数据本就在程序目录）自动跳过。
     */
    try {
      const visibleLink = require('./core/visiblelink');
      visibleLink.ensureVisibleLink(settings.value('home'), {
        log: (m) => {
          // logger 实例要等 initContext 之后才有，这里直接追加到主目录日志
          try {
            const logFile = path.join(settings.value('home'), 'logs', 'latest.log');
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`, 'utf8');
          } catch {
            /* 日志失败无所谓 */
          }
          if (process.env.QCL_DEBUG) console.log('[QCL]', m);
        },
      });
    } catch (err) {
      if (process.env.QCL_DEBUG) console.warn('[QCL] 建立程序目录数据入口异常：', err && err.message);
    }

    initContext({ settings });

    const win = createMainWindow({
      dev: DEV,
      onBoundsChanged: (bounds) => {
        try {
          settings.set({ windowBounds: bounds });
        } catch {
          /* 记不住窗口位置不是致命问题 */
        }
      }
    });

    registerIpc();

    /**
     * ★ 目录布局迁移（2026-11-05，后台执行）。
     *
     * 把每个实例各一份的 `libraries` / `assets` 合并到共享目录 `<home>/.minecraft/`，
     * 照 HMCL 的隔离语义：各版本只独立**游戏数据**，assets 与 libraries 共享。
     * 实测省磁盘：1140 MB → 593 MB（547 MB）。
     *
     * ★ 为什么放窗口之后、且不 await：
     *   实测迁移 5694 个文件要 15.4 秒 —— 放窗口前 await 会让用户黑屏等十几秒。
     *   ⇒ 窗口秒开，迁移在后台跑；启动游戏/安装前由 migrate.whenIdle() 等它收尾
     *     （见 ipc.js），避免读到「搬了一半」的目录。
     *   迁移幂等：有 marker 就 0ms 返回，第二次启动无开销。
     */
    try {
      const migrate = require('./core/migrate');
      migrate.startBackground({
        home: settings.value('home'),
        onLog: (line) => {
          try {
            console.log(`[QCL] ${line}`);
          } catch {
            /* 忽略 */
          }
        }
      });
    } catch {
      /* 忽略 */
    }

    // 自动化验证：--capture <输出 png>（走的是和正式运行完全一样的路径，含 qcl:// 协议）
    const captureIdx = process.argv.indexOf('--capture');
    if (captureIdx > 0 && process.argv[captureIdx + 1]) {
      const outFile = process.argv[captureIdx + 1];
      const pageArg = process.argv.includes('--capture-page')
        ? process.argv[process.argv.indexOf('--capture-page') + 1]
        : null;
      win.webContents.once('did-finish-load', async () => {
        try {
          // ★ 截图模式必须让窗口真正可见并解除后台节流：
          //   Chromium 对隐藏/后台窗口会把 requestAnimationFrame 降到 0 fps，
          //   而人物渲染是纯 RAF 驱动的 —— 窗口不显示，画布就永远是空的
          //   （capturePage 只能截到最后一次合成的帧）。
          win.show();
          win.webContents.setBackgroundThrottling(false);
          win.webContents.setFrameRate(60);
          // 等首帧动画/字体/glTF 加载完；--capture-logs 时把渲染层错误也打出来
          const wantLogs = process.argv.includes('--capture-logs');
          if (wantLogs) {
            win.webContents.on('console-message', (_e, level, message, line, source) => {
              const tag = ['调试', '信息', '警告', '错误'][level] || `级别${level}`;
              console.log(`[渲染层/${tag}] ${message}${source ? ` (${source}:${line})` : ''}`);
            });
            // 页面如果在卡住，把关键状态也读出来
            setTimeout(async () => {
              try {
                const diag = await win.webContents.executeJavaScript(`
                  (() => {
                    const splash = document.getElementById('splash');
                    return {
                      启动画面还在: !!splash && !splash.classList.contains('is-hidden'),
                      左栏按钮数: document.querySelectorAll('#leftnav button, #leftnav a').length,
                      内容区子节点: document.getElementById('content')?.childElementCount ?? -1,
                      右栏子节点: document.getElementById('rightpanel')?.childElementCount ?? -1,
                      壁纸: getComputedStyle(document.documentElement).getPropertyValue('--wallpaper')?.slice(0, 80)
                    };
                  })()
                `);
                console.log('[QCL] 界面状态：', JSON.stringify(diag, null, 2));
              } catch {
                /* 读不到就算了 */
              }
            }, 6000);
          }
          await new Promise((r) => setTimeout(r, 20000));
          if (pageArg) {
            await win.webContents.executeJavaScript(`
              (() => {
                const nav = document.querySelector('#nav-${pageArg}') ||
                            document.querySelector('[data-route="${pageArg}"]') ||
                            document.querySelector('[data-nav="${pageArg}"]');
                if (nav) { nav.click(); return 'clicked:${pageArg}'; }
                return 'no-nav:${pageArg}';
              })()
            `);
            await new Promise((r) => setTimeout(r, 2000));
          }

          // ★ 截图前强制让渲染层把人物「再画一帧」。
          //   原因：capturePage 截到的是最后一次**合成**结果，而人物是 RAF 驱动的；
          //   在软件渲染（--disable-gpu 时会回落 SwiftShader）下一帧可能要 150ms+，
          //   等待窗口期里可能一次都没轮到。这里显式调一次 render() 再截，结果才稳定。
          await win.webContents.executeJavaScript(`
            (() => {
              const v = window.__qclSkinViewer;
              if (!v || !v.renderer) return 'no-viewer';
              v.pivot.rotation.x = (v.rotationX * Math.PI) / 180;
              v.pivot.rotation.y = (v.rotationY * Math.PI) / 180;
              v.renderer.render(v.scene, v.camera);
              return 'rendered:' + (v._frameCount || 0);
            })()
          `);
          await new Promise((r) => setTimeout(r, 500));

          const img = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.writeFileSync(outFile, img.toPNG());
          console.log(`[QCL] 截图已保存：${outFile}（${img.getSize().width}×${img.getSize().height}）`);
        } catch (err) {
          console.error('[QCL] 截图失败：', err?.message || err);
        } finally {
          app.exit(0);
        }
      });
    }

    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow({ dev: DEV });
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // 渲染层崩了要给用户看得懂的提示，而不是静默白屏
  app.on('render-process-gone', (_e, _wc, details) => {
    dialog.showErrorBox('界面进程异常退出', `原因：${details.reason}\n请重启 QCL，若反复出现请把日志发给作者。`);
  });

  process.on('uncaughtException', (err) => {
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'qcl-crash.log'),
        `[${new Date().toISOString()}] ${err?.stack || err}\n`,
        'utf8'
      );
    } catch {
      /* 忽略 */
    }
    if (!DEV) dialog.showErrorBox('QCL 出现未处理的错误', String(err?.message || err));
  });
}
