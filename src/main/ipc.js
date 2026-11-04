'use strict';
/**
 * QCL 电脑版 · IPC 路由
 *
 * 约定：通道名 <域>:<动作>，与 docs/CONTRACT.md §3 一一对应。
 * 核心逻辑全部在 src/main/core/**（core-dev 负责）；这里只做「参数校验 → 调核心 → 事件回推」。
 * 核心模块缺失时返回中文可读错误，绝不让界面白屏。
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, shell, ipcMain } = require('electron');
const { getMainWindow, isMaximized, pushWindowState } = require('./window');
const { LaunchLog } = require('./logger');

/** 上下文（index.js 注入） */
const ctx = {
  settings: null,
  log: new LaunchLog()
};

/** 正在跑的安装任务：taskId -> {controller, info} */
const installTasks = new Map();
/** 正在跑的游戏：instanceId -> {child, pid} */
const runningGames = new Map();
/** 微软登录流程：flowId -> 核心侧 flow 对象 */
const msFlows = new Map();

const coreCache = new Map();
function core(name) {
  if (coreCache.has(name)) return coreCache.get(name);
  let mod = null;
  try {
    // eslint-disable-next-line global-require
    mod = require(path.join(__dirname, 'core', `${name}.js`));
  } catch {
    mod = null;
  }
  if (mod) coreCache.set(name, mod); // 只在成功时缓存；核心写好后再点一次就能生效
  return mod;
}

function need(name) {
  const mod = core(name);
  if (!mod) throw new Error(`启动核心模块 src/main/core/${name}.js 尚未就绪`);
  return mod;
}

function home() {
  const h = ctx.settings?.value('home');
  if (!h) throw new Error('QCL 主目录尚未确定');
  fs.mkdirSync(h, { recursive: true });
  return h;
}

/**
 * 向渲染层推事件。
 *
 * ★★★ 2026-11-05 修：以前这里只有 `getMainWindow()`，它读的是 window.js 里的单例。
 *   一旦主窗口不是通过 `createMainWindow()` 创建的（自动化测试、多窗口、窗口重开），
 *   `getMainWindow()` 返回 null ⇒ **所有事件被静默丢弃**，
 *   表现就是「启动窗口出来了但步骤一个都不亮」「联机状态不刷新」这类查不出原因的怪现象。
 *   ⇒ 现在加两层兜底：
 *       ① 单例拿不到时，用 BrowserWindow.getAllWindows() 里第一个未销毁的主窗口；
 *       ② 再不行就记一条警告（只在 debug 模式下打，避免刷屏）。
 */
function send(channel, payload) {
  let win = getMainWindow();
  if (!win) {
    try {
      const { BrowserWindow } = require('electron');
      const all = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed());
      // 优先选「有 webContents 且已加载页面」的窗口
      win = all.find((w) => w.webContents && !w.webContents.isLoading()) || all[0] || null;
    } catch {
      win = null;
    }
  }
  if (!win) {
    if (process.env.QCL_DEBUG) console.warn(`[QCL] send(${channel}) 找不到窗口，事件丢弃`);
    return;
  }
  win.webContents.send(channel, payload);
}

/** 把核心侧的进度回调转成 task:progress 事件 */
function makeProgress(taskId) {
  let last = 0;
  return (p = {}) => {
    const now = Date.now();
    const isFinal = p.done === true || p.error;
    if (!isFinal && now - last < 120) return; // 限流，别把渲染层刷爆
    last = now;
    const payload = {
      taskId,
      phase: p.phase || 'download',
      stage: p.stage || '',
      current: p.current ?? 0,
      total: p.total ?? 0,
      file: p.file || '',
      speed: p.speed ?? 0,
      done: !!p.done,
      error: p.error ? String(p.error) : null
    };
    /**
     * ★ 2026-11-05：把字节进度透传给界面。
     *   contentapi.js 的下载（Modrinth）只下**单个文件**，current/total 永远是 1/1，
     *   真正有意义的进度是 bytes/bytesTotal/percent —— 以前这几个字段被丢掉，
     *   界面只能显示「1/1 个文件」看不出下了多少。
     */
    if (Number.isFinite(p.bytes)) payload.bytes = p.bytes;
    if (Number.isFinite(p.bytesTotal)) payload.bytesTotal = p.bytesTotal;
    if (Number.isFinite(p.percent)) payload.percent = p.percent;
    if (p.skipped) payload.skipped = true;
    send('task:progress', payload);
  };
}

/** 扫描实例的游戏目录，列出已安装版本（真实读盘，不算缓存） */
function scanLocalVersions(instanceDir) {
  const versionsDir = path.join(instanceDir, '.minecraft', 'versions');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(versionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = path.join(versionsDir, name);
    const jsonFile = path.join(dir, `${name}.json`);
    const jarFile = path.join(dir, `${name}.jar`);
    const hasJson = fs.existsSync(jsonFile);
    const hasJar = fs.existsSync(jarFile);
    if (!hasJson && !hasJar) continue;
    let loader = { type: 'vanilla', version: name };
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(instanceDir, 'loader.json'), 'utf8'));
      if (meta && meta.id === name) loader = { type: meta.type || 'vanilla', version: meta.loaderVersion || name };
    } catch {
      /* 没有 loader.json 就是原版 */
    }
    let size = 0;
    let installedAt = 0;
    try {
      const st = fs.statSync(hasJar ? jarFile : jsonFile);
      size = hasJar ? st.size : 0;
      installedAt = st.mtimeMs;
    } catch {
      /* 忽略 */
    }
    out.push({ id: name, jarExists: hasJar, jsonExists: hasJson, loader, installedAt, sizeBytes: size });
  }
  out.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
  return out;
}

/** 安装一个版本（后台跑，进度走事件） */
async function runInstall({ id, mcVersion, loader }) {
  const inst = need('instances');
  const installer = need('install');
  const h = home();

  /**
   * ★ 迁移闸门（2026-11-05）：安装会把依赖库写进共享目录。
   *   如果后台迁移还在搬文件，同时写入会互相打架（同一路径一边搬一边下）。
   *   ⇒ 先等迁移收尾。
   */
  try {
    await need('migrate').whenIdle();
  } catch {
    /* 闸门异常不拦安装 */
  }

  const instance = inst.get(h, id);
  if (!instance) throw new Error(`实例不存在：${id}`);

  const taskId = `install-${id}-${Date.now()}`;
  const controller = new AbortController();
  installTasks.set(taskId, { controller, instanceId: id, mcVersion });

  ctx.log.open(h, 'install');
  ctx.log.write(`开始安装：实例=${instance.name} 版本=${mcVersion} 加载器=${loader ? `${loader.type} ${loader.version || ''}` : '原版'}`);
  const progress = makeProgress(taskId);
  progress({ phase: 'prepare', stage: '准备中', current: 0, total: 1 });

  // 不 await：立刻把 taskId 还给界面，进度靠事件
  (async () => {
    try {
      const result = await installer.install({
        home: h,
        instanceId: id,
        mcVersion,
        loader: loader || null,
        source: ctx.settings.value('downloader').source,
        threads: ctx.settings.value('downloader').threads,
        onProgress: progress,
        onLog: (line) => {
          ctx.log.write(line);
          send('launch:log', { id, line: String(line), stream: 'stdout' });
        },
        signal: controller.signal
      });
      progress({ phase: 'done', stage: '安装完成', current: 1, total: 1, done: true });
      ctx.log.write(`安装完成：${JSON.stringify(result || {})}`);
      inst.update(h, id, { installedVersion: mcVersion, loader: loader || null });
      send('instances:changed', {});
    } catch (err) {
      const message = err && err.name === 'AbortError' ? '安装已取消' : `安装失败：${err?.message || err}`;
      ctx.log.write(message);
      progress({ phase: 'error', stage: message, done: true, error: message });
      send('instances:changed', {});
    } finally {
      installTasks.delete(taskId);
    }
  })();

  return { taskId, mcVersion, instanceId: id };
}

/* --------------------------------------------------- Modrinth 内容下载落盘目录 */

/** 内容类型 → 实例 .minecraft 下的子目录（照 HMCL / 安卓版的放置规则）。 */
const CONTENT_SUBDIRS = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks'
};

/**
 * 决定 content:download 把文件存到哪。
 *   ① 传了 destDir → 用它（相对路径按 QCL 主目录解析）
 *   ② 传了实例 id + 认识的类型 → 实例的 .minecraft/<对应子目录>
 *   ③ 其它（整合包 .mrpack / 未知类型）→ <home>/downloads，交给界面决定导入哪个实例
 */
async function resolveContentDestDir({ instId, projectType, destDir } = {}) {
  const explicit = String(destDir || '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(home(), explicit);

  const type = String(projectType || '').trim().toLowerCase();
  if (instId && CONTENT_SUBDIRS[type]) {
    const inst = await need('instances').get(home(), instId);
    if (!inst) throw new Error(`实例不存在：${instId}`);
    return path.join(inst.dir, '.minecraft', CONTENT_SUBDIRS[type]);
  }

  const dir = path.join(home(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 处理器表 */
const handlers = {
  // ---------- 应用 ----------
  'app:info': async () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    home: home(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }),

  // ---------- 窗口 ----------
  'win:minimize': async () => {
    getMainWindow()?.minimize();
    return { ok: true };
  },
  'win:toggleMaximize': async () => {
    const win = getMainWindow();
    if (!win) return { maximized: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    pushWindowState(win);
    return { maximized: isMaximized(win) };
  },
  'win:close': async () => {
    getMainWindow()?.close();
    return { ok: true };
  },
  /**
   * ★ 2026-11-05 新增：把启动器窗口**收起来**（不是退出进程）。
   *
   * 用户需求原话：「启动玩游戏之后，应该把启动器关了，不占用游戏资源」，
   * 同时又抱怨「连游戏窗口都没出现就把启动器关了」——所以时机必须在**游戏真正就绪之后**。
   *
   * 为什么用 hide 而不是 close/quit：
   *   游戏是我们 spawn 出来的子进程，stdio 是管道。父进程一退出，
   *   管道断掉，Minecraft 往 stdout 写日志时可能抛 IOException 直接崩。
   *   ⇒ 收起窗口（hide）已经能释放 GPU/CPU（渲染停止），
   *     进程还在，既不影响游戏，又能等游戏退出后把窗口显示回来。
   */
  'win:hide': async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口不存在' };
    try {
      win.hide();
      // 从任务栏也去掉，像真的"关了"；游戏退出时会再显示回来
      if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  /** 把启动器窗口重新显示出来（游戏退出后调用） */
  'win:show': async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口不存在' };
    try {
      if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(false);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  /** 当前窗口是否被收起（界面用来决定要不要显示"启动器已收起"提示） */
  'win:isHidden': async () => {
    const win = getMainWindow();
    return { hidden: !win || win.isDestroyed() ? false : !win.isVisible() };
  },
  'win:state': async () => {
    const win = getMainWindow();
    return { maximized: isMaximized(win), inset: isMaximized(win) ? 0 : 18 };
  },

  // ---------- 设置 ----------
  'settings:get': async () => ctx.settings.get(),
  'settings:set': async (patch) => {
    const next = ctx.settings.set(patch || {});
    send('settings:changed', next);
    return next;
  },

  // ---------- 实例 ----------
  'instances:list': async () => {
    const mod = core('instances');
    if (!mod) return [];
    const list = await mod.list(home());
    const selected = ctx.settings.value('selectedInstance');
    return list.map((it) => ({ ...it, selected: it.id === selected }));
  },
  'instances:create': async ({ name, mcVersion, loader }) => {
    const mod = need('instances');
    const created = await mod.create(home(), { name, mcVersion, loader: loader || null });
    send('instances:changed', {});
    return created;
  },
  'instances:delete': async ({ id }) => {
    const mod = need('instances');
    await mod.remove(home(), id);
    if (ctx.settings.value('selectedInstance') === id) ctx.settings.set({ selectedInstance: null });
    send('instances:changed', {});
    return { ok: true };
  },
  'instances:rename': async ({ id, name }) => {
    const mod = need('instances');
    const updated = await mod.rename(home(), id, name);
    send('instances:changed', {});
    return updated;
  },
  /**
   * 给实例选一张自定义图标（照安卓版「自定义图标」移植）。
   * 弹系统文件框 → 校验是 PNG → 复制到 <QCL_HOME>/icons/<id>.png → 写进 instance.json。
   */
  'instances:pickIcon': async ({ id }) => {
    const { dialog } = require('electron');
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win || undefined, {
      title: '选择实例图标',
      properties: ['openFile'],
      filters: [{ name: '图片 (PNG)', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };

    const picked = result.filePaths[0];
    const skinMod = need('skin');
    const size = skinMod.readPngSize(picked);
    if (!size) return { ok: false, error: '这个文件不是有效的 PNG 图片' };

    try {
      const dir = path.join(home(), 'icons');
      fs.mkdirSync(dir, { recursive: true });
      const safeId = String(id || 'instance').replace(/[^A-Za-z0-9-]/g, '');
      const dest = path.join(dir, `${safeId}.png`);
      fs.copyFileSync(picked, dest);

      const mod = need('instances');
      const updated = await mod.update(home(), id, { iconFile: dest });
      send('instances:changed', {});
      return { ok: true, canceled: false, path: dest, instance: updated, width: size.width, height: size.height };
    } catch (err) {
      return { ok: false, error: `设置图标失败：${err?.message || err}` };
    }
  },
  'instances:select': async ({ id }) => {
    ctx.settings.set({ selectedInstance: id });
    send('instances:changed', {});
    return { ok: true };
  },
  'instances:update': async ({ id, patch }) => {
    const mod = need('instances');
    const updated = await mod.update(home(), id, patch || {});
    send('instances:changed', {});
    return updated;
  },

  // ---------- 版本 ----------
  'versions:manifest': async () => {
    const mod = need('mojang');
    const h = home();
    const metaDir = path.join(h, 'meta');
    const data = await mod.manifest({
      cacheDir: metaDir,
      source: ctx.settings.value('downloader').source,
      timeoutMs: 20000
    });
    return { latest: data.latest, versions: data.versions, cached: !!data.cached };
  },
  'versions:ancient': async () => {
    const mod = need('mojang');
    const h = home();
    const list = await mod.ancientList({ cacheDir: path.join(h, 'meta'), timeoutMs: 20000 });
    return list;
  },
  /**
   * 愚人节版本（2015 爱的抱抱 → 2026 牧群更新，共 9 个）。
   * 官方 manifest 把它们标成普通 snapshot，混在 758 条快照里，
   * 所以 core/mojang.js 用 id 精确白名单（含 `3D Shareware v1.34` 这种带空格的 id）。
   */
  'versions:aprilFools': async () => {
    const mod = need('mojang');
    const h = home();
    return mod.aprilFoolsList({ cacheDir: path.join(h, 'meta'), timeoutMs: 20000 });
  },
  'versions:local': async ({ id }) => {
    const mod = need('instances');
    const inst = await mod.get(home(), id);
    if (!inst) return [];
    return scanLocalVersions(inst.dir);
  },

  // ---------- 安装 ----------
  'install:start': async (payload) => runInstall(payload || {}),
  'install:cancel': async ({ taskId }) => {
    const task = installTasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在或已结束' };
    task.controller.abort();
    return { ok: true };
  },

  // ---------- 启动 ----------
  'launch:start': async ({ id }) => {
    const mod = need('launch');
    const instMod = need('instances');
    const h = home();

    /**
     * ★ 迁移闸门（2026-11-05）：目录布局迁移（每实例 libraries/assets → 共享目录）
     *   在后台跑，可能还没结束。这时读 classpath 会拿到「搬了一半」的库，报依赖缺失。
     *   ⇒ 启动前等它收尾；没启动过迁移则立即返回。
     */
    try {
      await need('migrate').whenIdle();
    } catch {
      /* 闸门异常不拦启动 */
    }

    const instance = await instMod.get(h, id);
    if (!instance) throw new Error(`实例不存在：${id}`);

    const accounts = core('accounts');
    const accountList = accounts ? await accounts.list(h) : [];
    const account = accountList.find((a) => a.selected) || accountList[0] || {
      uuid: '00000000000000000000000000000000',
      name: 'Player',
      type: 'offline'
    };

    ctx.log.open(h, 'launch');
    ctx.log.write(`启动实例：${instance.name}（${instance.mcVersion}）账号：${account.name}(${account.type})`);
    send('launch:state', { id, state: 'starting' });

    const existing = runningGames.get(id);
    if (existing) throw new Error('这个实例已经在运行了');

    /**
     * ★★★ 关键改动（2026-11-05）：`launch()` 不再被 await。
     *
     * 以前是 `const handle = await mod.launch({...})` —— IPC 要等**整个启动流程**
     * 跑完（解析版本 → 查 Java → 校验文件 → 组装参数 → spawn）才返回，
     * 用户看到的就是「点了启动，启动窗口半天才响应」。
     *
     * ⇒ 现在：
     *   · 立刻返回 `{ starting: true }`，界面马上能画「正在启动」窗口；
     *   · 阶段进度通过 `launch:stage` 事件实时推送，逐步打勾；
     *   · spawn 成功补发 `launch:state: running`（带真实 pid）；
     *   · 失败通过 `launch:state: error` 推回去。
     */
    const taskId = `launch-${id}-${Date.now()}`;
    runningGames.set(id, { starting: true, taskId });

    (async () => {
      try {
        const handle = await mod.launch({
          home: h,
          instance,
          account,
          settings: ctx.settings.get(),
          onStage: (st) => {
            /**
             * ★★★ 只发**纯字符串字段**。
             *
             * 踩过的坑：直接 `send('launch:stage', { id, taskId, ...st })`，
             * 一旦 st 里混进任何非可克隆对象（进程对象、Symbol 回调、Buffer 之外的类实例），
             * Electron 的结构化克隆会抛
             *   `Error: An object could not be cloned.`
             * 而这个异常发生在 IPC 内部，**事件静默丢失** ——
             * 表现就是「启动窗口出现了，但 6 个步骤全都是灰的、一个都不点亮」。
             * ⇒ 这里显式只挑 string 字段，杜绝不可克隆对象混进来。
             */
            const payload = {
              id: String(id),
              taskId: String(taskId),
              key: String(st && st.key != null ? st.key : ''),
              label: String(st && st.label != null ? st.label : ''),
              detail: String(st && st.detail != null ? st.detail : '')
            };
            send('launch:stage', payload);
            ctx.log.write(`[阶段] ${payload.label}${payload.detail ? ` — ${payload.detail}` : ''}`);
          },
          onLog: (line, stream = 'stdout') => {
            ctx.log.write(line);
            send('launch:log', { id, line: String(line), stream });
          },
          /**
           * ★★★ 2026-11-05 新增：游戏**真的**就绪（唯一可信的「启动完成」信号）。
           *
           * 以前界面把 `launch:state: running`（进程刚 spawn 出来）当成启动完成，
           * 于是立刻关掉启动窗口 —— 但那时游戏画面还没出来，
           * 用户原话：「游戏屁都没启动，窗口就消失了」。
           *
           * launch.js 现在监听游戏日志，命中主循环标志（Sound engine started /
           * Backend library / Using LWJGL / Setting user …）后**只回调一次**，
           * 这里转成 `launch:game-ready` 事件。界面收到它才关启动窗口。
           *
           * ★ 同一套事件要改三处（本项目反复踩的坑）：
           *   ① src/main/ipc.js —— 这里的 send
           *   ② src/preload/index.js 的 EVENT_RE 正则
           *   ③ src/renderer/js/bridge.js 的 initBridge 转发列表（由 frontend-dev 负责）
           */
          onGameReady: (info) => {
            ctx.log.write('游戏已就绪（收到主循环标志），通知界面关闭启动窗口');
            const elapsedMs = info && Number.isFinite(info.elapsedMs) ? info.elapsedMs : undefined;
            // elapsedMs 可选：界面有就显示「游戏已就绪（用时 X 秒）」，没有也不影响
            send('launch:game-ready', elapsedMs === undefined ? { id } : { id, elapsedMs });
          },
          onExit: (code) => {
            runningGames.delete(id);
            instMod.update(h, id, { lastPlayed: Date.now() }).catch(() => {});
            /**
             * ★ 2026-11-05：**归一成纯数字再发**。
             *
             * launch.js 的 onExit 回调拿到的是 `{ code, signal, state }` 对象
             * （child.on('exit') 的原样参数）。以前直接透传给渲染层，
             * 渲染层拿它和 0 比较永远 false，还插值成 `[object Object]` ——
             * 用户看到「退出码 1 / [object Object]」这种看不懂的提示。
             * ⇒ 这里只发数字 + 单独的 signal 字段，语义清晰。
             */
            const codeNum =
              typeof code === 'number'
                ? code
                : code && typeof code === 'object' && typeof code.code === 'number'
                  ? code.code
                  : null;
            const signal = code && typeof code === 'object' ? code.signal || null : null;
            send('launch:state', { id, state: 'exited', code: codeNum, signal });
            send('instances:changed', {});
          }
        });
        runningGames.set(id, handle);
        send('launch:state', { id, state: 'running', pid: handle.pid });
      } catch (err) {
        runningGames.delete(id);
        const message = err?.message || String(err);
        ctx.log.write(`启动失败：${message}`);
        send('launch:state', { id, state: 'error', message });
      }
    })();

    return { starting: true, taskId };
  },
  'launch:kill': async ({ id }) => {
    const entry = runningGames.get(id);
    if (!entry) return { ok: false, error: '该实例没有正在运行的游戏' };
    entry.kill();
    return { ok: true };
  },

  // ---------- 账号 ----------
  'accounts:list': async () => {
    const mod = core('accounts');
    if (!mod) return [];
    return mod.list(home());
  },
  'accounts:addOffline': async ({ name }) => {
    const mod = need('accounts');
    const account = await mod.addOffline(home(), String(name || '').trim());
    send('accounts:changed', {});
    return account;
  },
  'accounts:addMicrosoft': async () => {
    const mod = need('accounts');
    const flow = await mod.startMicrosoft();
    msFlows.set(flow.flowId, flow);
    return {
      flowId: flow.flowId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresIn: flow.expiresIn,
      message: flow.message
    };
  },
  'accounts:microsoftPoll': async ({ flowId }) => {
    const mod = need('accounts');
    const flow = msFlows.get(flowId);
    if (!flow) return { status: 'error', message: '登录流程已失效，请重新获取设备码' };
    const result = await mod.pollMicrosoft(flowId, home());
    if (result.status === 'done' || result.status === 'error') msFlows.delete(flowId);
    if (result.status === 'done') send('accounts:changed', {});
    return result;
  },
  'accounts:remove': async ({ uuid }) => {
    const mod = need('accounts');
    await mod.remove(home(), uuid);
    send('accounts:changed', {});
    return { ok: true };
  },

  // ---------- 皮肤 ----------
  'accounts:pickSkin': async ({ uuid }) => {
    // 弹系统文件选择框（主进程有 dialog 权限，渲染层没有）
    const { dialog } = require('electron');
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win || undefined, {
      title: '选择 Minecraft 皮肤文件',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft 皮肤 (PNG)', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: true, canceled: true };
    }
    const picked = result.filePaths[0];
    const skinMod = need('skin');
    const check = skinMod.validateSkinFile(picked);
    if (!check.ok) return { ok: false, error: check.error };

    // 复制到 QCL 主目录统一存放，避免原文件被移动/删除后失效
    const imported = skinMod.importSkin(home(), picked, uuid);
    if (!imported.ok) return { ok: false, error: imported.error };

    return {
      ok: true,
      canceled: false,
      path: imported.path,
      width: imported.width,
      height: imported.height,
      sourceName: path.basename(picked)
    };
  },
  'accounts:setSkin': async ({ uuid, path: skinPath }) => {
    const mod = need('accounts');
    const updated = await mod.updateAccount(home(), uuid, { skinFile: skinPath || null });
    if (!updated) return { ok: false, error: `账号不存在：${uuid}` };
    send('accounts:changed', {});
    return { ok: true, account: updated };
  },
  'accounts:clearSkin': async ({ uuid }) => {
    const mod = need('accounts');
    const updated = await mod.updateAccount(home(), uuid, { skinFile: null, avatar: null });
    if (!updated) return { ok: false, error: `账号不存在：${uuid}` };
    send('accounts:changed', {});
    return { ok: true, account: updated };
  },
  /**
   * 读一个皮肤文件的内容（data URL）。
   * ★ 渲染层要用它当 three.js 贴图 —— 走 file:// 在 qcl:// 页面里会被浏览器拦，
   *   所以由主进程读成 base64 传过去，最稳。
   */
  'accounts:readSkin': async ({ path: skinPath }) => {
    if (!skinPath) return { ok: false, error: '路径为空' };
    const skinMod = need('skin');
    const dataUrl = skinMod.skinDataUrl(skinPath);
    if (!dataUrl) return { ok: false, error: `读取皮肤失败：${skinPath}` };
    return { ok: true, dataUrl };
  },

  // ---------- 皮肤库（查任意正版玩家皮肤，照安卓版 SkinLibraryDialog）----------
  'skin:lookup': async ({ name }) => {
    try {
      return { ok: true, ...(await need('skinlookup').lookupPlayerSkin({ name })) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'skin:fetch': async ({ url }) => {
    try {
      return await need('skinlookup').downloadSkinAsDataUrl({ url });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  /**
   * 把一个 http(s) 皮肤地址读成 data URL。
   *
   * ★ 为什么需要它：微软账号的 `avatar` 是 `http://textures.minecraft.net/...`。
   *   qcl:// 页面的 CSP 里 img-src 虽然放了 https，但**http 会被混内容策略拦掉**，
   *   结果头像裁不出来 → 用户看到的就是「头像显示不出来」。
   *   ⇒ 统一由主进程下载并转 base64，渲染层只吃 data: URL，不受 CSP 影响。
   */
  'skin:readRemote': async ({ url }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '地址无效' };
    try {
      const r = await need('skinlookup').downloadSkinAsDataUrl({ url });
      return r;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  /**
   * 把「某个正版玩家的皮肤」应用到账号（下载后存到 QCL\skins\<uuid>.png）。
   * 这样主界面人物与右栏头像都会跟着变。
   */  'skin:applyPlayerSkin': async ({ uuid, playerName }) => {
    const accounts = need('accounts');
    const lookup = need('skinlookup');
    const skinMod = need('skin');

    const info = await lookup.lookupPlayerSkin({ name: playerName });
    if (!info.ok) return { ok: false, error: info.error };

    const dl = await lookup.downloadSkinAsDataUrl({ url: info.skinUrl });
    if (!dl.ok) return { ok: false, error: dl.error };

    // 存成文件（dataURL → Buffer）
    const dir = path.join(home(), 'skins');
    fs.mkdirSync(dir, { recursive: true });
    const safeUuid = String(uuid || '').replace(/[^A-Za-z0-9-]/g, '') || 'default';
    const dest = path.join(dir, `${safeUuid}.png`);
    const b64 = String(dl.dataUrl).split(',')[1] || '';
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));

    // 校验尺寸
    const check = skinMod.validateSkinFile(dest);
    if (!check.ok) return { ok: false, error: check.error };

    const updated = await accounts.updateAccount(home(), uuid, {
      skinFile: dest,
      skinModel: info.slim ? 'slim' : 'classic',
      skinSourceName: info.name
    });
    if (!updated) return { ok: false, error: `账号不存在：${uuid}` };

    send('accounts:changed', {});
    return { ok: true, path: dest, name: info.name, slim: info.slim, width: check.width, height: check.height };
  },
  /** 把皮肤应用到当前选中账号（主界面人物立刻跟随） */
  'skin:applyToCurrent': async ({ playerName }) => {
    const accounts = need('accounts');
    const list = await accounts.list(home());
    const cur = list.find((a) => a.selected) || list[0];
    if (!cur) return { ok: false, error: '还没有账号，请先添加一个账号' };
    const handlers2 = handlers['skin:applyPlayerSkin'];
    return handlers2({ uuid: cur.uuid, playerName });
  },

  // ---------- Java ----------
  'java:list': async () => {
    const mod = core('java');
    const detected = mod ? await mod.detectCached({ home: home() }) : [];
    const manual = ctx.settings.value('javaPath');
    if (manual && !detected.some((j) => path.resolve(j.path) === path.resolve(manual))) {
      const probed = mod ? await mod.probe(manual) : null;
      if (probed) detected.unshift({ ...probed, source: 'manual' });
    }
    return detected;
  },
  'java:add': async ({ path: javaPath }) => {
    const mod = need('java');
    const probed = await mod.probe(javaPath);
    if (!probed) throw new Error(`这个路径不是一个可用的 Java：${javaPath}`);
    ctx.settings.set({ javaPath: probed.path });
    return probed;
  },
  /**
   * ★ 查某个 MC 版本可用的加载器版本（2026-11-05 新增）。
   *
   * 用户要求：「推荐当前玩家版本的时候，能否正确推荐这个版本的
   *           Fabric / Forge / NeoForge 最新版本」。
   * 安装弹窗据此显示「最新可用版本」，而不是只让玩家选个类型、背后瞎猜。
   */
  'loader:versions': async ({ mcVersion, loader }) => {
    try {
      return await need('loaderversions').listLoaderVersions({ mcVersion, loader });
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  },

  'java:detect': async () => {
    const mod = need('java');
    return mod.detectCached({ home: home() });
  },

  /* ---------- Java 下载（照 HMCL 的「自动下载 Java」）----------
   *
   * 解决的问题：新玩家机器上一个 Java 都没有 → 启动失败 → 不知道怎么装，
   * 而 Oracle 官网下载要登录注册。
   */
  /** 免登录下载源清单 + 该 MC 版本推荐的 Java 主版本 */
  'java:sources': async ({ mcVersion }) => {
    try {
      return await need('javadownload').sourcesFor(mcVersion);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  /** 一键下载并解压 JDK 到 <home>/java/<major>/ */
  'java:download': async ({ major }) => {
    try {
      const jd = need('javadownload');
      const r = await jd.downloadJava({
        major,
        home: home(),
        onLog: (line) => {
          ctx.log.write(line);
          send('launch:log', { id: '__java', line: String(line), stream: 'stdout' });
        }
      });
      if (r.ok) {
        // 下载成功后让 Java 缓存失效，界面能立刻看到新的
        try {
          need('java').invalidateCache();
        } catch {
          /* 忽略 */
        }
        send('java:changed', {});
      }
      return r;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },

  // ---------- 多人联机（Terracotta）----------
  'terracotta:info': async () => {
    const tc = need('terracotta');
    return { ok: true, ...tc.platformInfo(), installed: tc.isInstalled(home()) };
  },
  'terracotta:prepare': async () => {
    const tc = need('terracotta');
    try {
      ctx.log.open(home(), 'terracotta');
      const r = await tc.ensureInstalled({
        home: home(),
        onProgress: (p) => {
          send('task:progress', {
            taskId: 'terracotta',
            phase: p.phase || 'download',
            stage: '下载联机组件',
            current: p.current ?? 0,
            total: p.total ?? 0,
            file: p.file || '',
            speed: p.speed ?? 0,
            done: false,
            error: null
          });
        },
        onLog: (line) => {
          ctx.log.write(line);
          send('launch:log', { id: '__terracotta', line: String(line), stream: 'stdout' });
        }
      });
      send('task:progress', {
        taskId: 'terracotta',
        phase: 'done',
        stage: '联机组件就绪',
        current: 1,
        total: 1,
        done: true,
        error: null
      });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'terracotta:start': async ({ portTransfer }) => {
    const tc = need('terracotta');
    try {
      const r = await tc.start({
        home: home(),
        portTransfer: Number(portTransfer) || 0,
        onState: (st) => send('terracotta:state', st),
        onLog: (line) => {
          ctx.log.write(line);
          send('launch:log', { id: '__terracotta', line: String(line), stream: 'stdout' });
        }
      });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'terracotta:host': async () => {
    try {
      return { ok: true, sent: need('terracotta').startHost() };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'terracotta:join': async ({ code }) => {
    try {
      return { ok: true, sent: need('terracotta').joinRoom(code) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'terracotta:status': async () => need('terracotta').status(),
  'terracotta:stop': async () => need('terracotta').stop(),

  // ---------- 模组 / 资源包 / 世界 ----------
  'mods:list': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}`, mods: [] };
    const mods = need('mods');
    return { ok: true, mods: mods.listMods(inst.dir), dir: path.join(inst.dir, '.minecraft', 'mods') };
  },
  'mods:setEnabled': async ({ id, file, enabled, kind }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}` };
    const mods = need('mods');
    const dir = mods.addonDir(inst.dir, kind || 'mods');
    const target = path.join(dir, path.basename(String(file || '')));
    if (!fs.existsSync(target)) return { ok: false, error: `文件不存在：${file}` };
    const r = mods.setModEnabled(target, Boolean(enabled));
    return { ok: true, enabled: Boolean(enabled), ...r };
  },
  'mods:remove': async ({ id, file, kind }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}` };
    const mods = need('mods');
    const dir = mods.addonDir(inst.dir, kind || 'mods');
    const target = path.join(dir, path.basename(String(file || '')));
    if (!fs.existsSync(target)) return { ok: false, error: `文件不存在：${file}` };
    const r = mods.moveToTrash(home(), target);
    return { ok: true, ...r };
  },
  'mods:resourcePacks': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return [];
    return need('mods').listAddonDir(inst.dir, 'resourcepacks');
  },
  /** 光影（shaderpacks/）：.zip 文件或目录，`.disabled` 视为停用 */
  'mods:shaderPacks': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return [];
    return need('mods').listAddonDir(inst.dir, 'shaderpacks');
  },
  /** 数据包（datapacks/） */
  'mods:dataPacks': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return [];
    return need('mods').listAddonDir(inst.dir, 'datapacks');
  },
  'mods:worlds': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return [];
    return need('mods').listWorlds(inst.dir);
  },
  /**
   * ★ 2026-11-05 新增：模组更新检查（照 HMCL 的 AddonUpdatesPage）。
   *
   * 契约（frontend-dev 按这个写界面）：
   *   'mods:checkUpdates' ({ id }) -> { checked, items:[{ fileName, name, current, latest,
   *                                    downloadUrl, sha1, size, projectId }] }
   * ★ 只查 Modrinth（CurseForge 需要 key）；网络失败**不抛异常**，返回
   *   `{ checked:0, items:[], error:'中文原因' }`，界面照常渲染空列表。
   */
  'mods:checkUpdates': async ({ id }) => {
    try {
      const instMod = need('instances');
      const inst = await instMod.get(home(), id);
      if (!inst) return { checked: 0, items: [], error: `实例不存在：${id}` };
      return await need('modupdate').checkUpdates({
        home: home(),
        instance: inst,
        onLog: (line) => ctx.log.write(line)
      });
    } catch (err) {
      return { checked: 0, items: [], error: `检查模组更新失败：${err?.message || String(err)}` };
    }
  },

  // ---------- 存档（照 HMCL WorldListPage / WorldManagePage / WorldBackupsPage / WorldExportPage） ----------
  /**
   * 契约（frontend-dev 按这个写界面）：
   *   worlds:list    ({ id })               -> [{ folder, name, version, sizeBytes, lastPlayed, hasIcon }]
   *   worlds:detail  ({ id, folder })       -> { folder, name, version, lastPlayed, sizeBytes, seed, gameMode, hardcore, fileCount }
   *   worlds:backup  ({ id, folder })       -> { file, sizeBytes }
   *   worlds:backups ({ id, folder })       -> [{ file, name, sizeBytes, time }]
   *   worlds:restore ({ id, folder, file }) -> { ok }
   *   worlds:export  ({ id, folder })       -> { file, sizeBytes }
   *   worlds:delete  ({ id, folder })       -> { ok }
   *   worlds:open    ({ id, folder })       -> { ok }
   * ★ 成功时按上面原样返回（列表通道就是数组）；失败统一 `{ ok:false, error:'中文' }`
   *   （列表通道额外带 `items: []`），不让页面白屏。
   */
  'worlds:list': async ({ id }) => {
    try {
      return need('worlds').list(home(), id);
    } catch (err) {
      return { ok: false, error: err?.message || String(err), items: [] };
    }
  },
  'worlds:detail': async ({ id, folder }) => {
    try {
      return { ok: true, ...need('worlds').detail(home(), id, folder) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'worlds:backup': async ({ id, folder }) => {
    try {
      const r = need('worlds').backup(home(), id, folder);
      return { ok: true, file: r.file, sizeBytes: r.sizeBytes, name: r.name };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'worlds:backups': async ({ id, folder }) => {
    try {
      return need('worlds').listBackups(home(), id, folder);
    } catch (err) {
      return { ok: false, error: err?.message || String(err), items: [] };
    }
  },
  'worlds:restore': async ({ id, folder, file }) => {
    try {
      const r = need('worlds').restore(home(), id, folder, file);
      return { ok: true, folder: r.folder, extracted: r.extracted, movedTo: r.movedTo || null };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'worlds:export': async ({ id, folder }) => {
    try {
      const r = need('worlds').exportWorld(home(), id, folder);
      return { ok: true, file: r.file, sizeBytes: r.sizeBytes, name: r.name };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'worlds:delete': async ({ id, folder }) => {
    try {
      const r = need('worlds').remove(home(), id, folder);
      return { ok: true, folder: r.folder, movedTo: r.movedTo };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'worlds:open': async ({ id, folder }) => {
    try {
      const dir = need('worlds').worldDir(home(), id, folder);
      const openErr = await shell.openPath(dir);
      if (openErr) return { ok: false, error: `打开存档目录失败：${openErr}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },

  // ---------- 整合包 ----------
  /**
   * 契约（frontend-dev 按这个写界面）：
   *   modpack:export  ({ id, includeSaves, includeConfig, includeResourcePacks, includeMods }) -> { file, sizeBytes }
   *   modpack:import  ({ file })        -> { instanceId, instance }
   *   modpack:inspect ({ file })        -> { name, version, modCount, fileCount, format }
   *   modpack:list    ()                -> [{ file, name, sizeBytes, time }]
   *   app:pickFile    ({ title, filters, properties }) -> { canceled, filePath }
   * ★ `file` 一律给**绝对路径**（列表项、导出结果、import/pickFile 的入参都是它）。
   */
  'modpack:export': async ({ id, includeSaves, includeConfig, includeResourcePacks, includeMods }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}` };
    try {
      const r = await need('modpack').exportModpack({
        home: home(),
        instance: inst,
        includeSaves: Boolean(includeSaves),
        includeConfig: includeConfig !== false,
        includeResourcePacks: includeResourcePacks !== false,
        includeMods: includeMods !== false,
        onLog: (line) => ctx.log.write(line)
      });
      // file 给绝对路径（导出到 <home>/modpacks/ 下）
      return { ok: true, file: path.join(r.dir, r.file), name: r.file, sizeBytes: r.sizeBytes, mods: r.mods, overrides: r.overrides };
    } catch (err) {
      return { ok: false, error: `导出整合包失败：${err?.message || String(err)}` };
    }
  },
  'modpack:inspect': async ({ file }) => {
    if (!file || !fs.existsSync(file)) return { ok: false, error: '整合包文件不存在' };
    try {
      const info = need('modpack').inspectModpack(file);
      // 契约字段在前，另外带几个有用的（mcVersion / loader / isModpack）
      return {
        ok: true,
        name: info.name || '',
        version: info.version || null,
        modCount: info.modCount || 0,
        fileCount: info.fileCount || 0,
        format: info.format || 'raw',
        isModpack: !!info.isModpack,
        mcVersion: info.mcVersion || null,
        loader: info.loader || null
      };
    } catch (err) {
      return { ok: false, error: `读取整合包失败：${err?.message || String(err)}` };
    }
  },
  'modpack:import': async ({ file }) => {
    if (!file || !fs.existsSync(file)) return { ok: false, error: '整合包文件不存在' };
    try {
      const r = await need('modpack').importToNewInstance({
        home: home(),
        zipPath: file,
        onLog: (line) => ctx.log.write(line)
      });
      send('instances:changed', {});
      return { ok: true, instanceId: r.instanceId, instance: r.instance, extracted: r.extracted, skipped: r.skipped };
    } catch (err) {
      return { ok: false, error: `导入整合包失败：${err?.message || String(err)}` };
    }
  },
  'modpack:list': async () => {
    try {
      return need('modpack').listModpacks(home());
    } catch (err) {
      return { ok: false, error: err?.message || String(err), items: [] };
    }
  },

  // ---------- 通用文件选择（契约：app:pickFile） ----------
  /**
   * 弹系统文件选择框（主进程有 dialog 权限，渲染层没有）。
   * @param {{title?:string, filters?:Array<{name:string,extensions:string[]}>, properties?:string[]}} payload
   * @returns {{ok:boolean, canceled:boolean, filePath:string|null, error?:string}}
   */
  'app:pickFile': async (payload) => {
    const { title, filters, properties } = payload || {};
    try {
      const { dialog } = require('electron');
      const win = getMainWindow();
      const allowedProps = ['openFile', 'openDirectory', 'multiSelections', 'showHiddenFiles', 'createDirectory'];
      let props = Array.isArray(properties) ? properties.filter((p) => allowedProps.includes(p)) : [];
      if (!props.length) props = ['openFile'];
      const options = { title: String(title || '选择文件'), properties: props };
      if (Array.isArray(filters) && filters.length) {
        options.filters = filters
          .map((f) => ({
            name: String((f && f.name) || '文件'),
            extensions: Array.isArray(f && f.extensions) ? f.extensions.map((x) => String(x)) : ['*']
          }))
          .filter((f) => f.extensions.length);
      }
      const result = await dialog.showOpenDialog(win || undefined, options);
      if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true, filePath: null };
      return { ok: true, canceled: false, filePath: result.filePaths[0] };
    } catch (err) {
      return { ok: false, canceled: true, filePath: null, error: `打开文件选择框失败：${err?.message || String(err)}` };
    }
  },

  // ---------- 说明页（设置 → 关于 → 使用说明）----------
  /**
   * 通道：app:help
   *
   * 给渲染层的「使用说明」页提供**真实数字**，别在页面上写死：
   *   · 中文补丁：规则数 / 实际可用的包目录数（安卓版移植过来 77 组）
   *   · Betacraft 归档清单：内置 JSON 的条数
   * 任何一段取不到都不抛异常，对应字段返回 null，页面自己降级。
   */
  'app:help': async () => {
    const out = {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      chinesePack: null,
      archive: null
    };
    try {
      const cp = require('./core/chinesepack');
      const st = cp.stats();
      out.chinesePack = { rules: st.rules, dirs: st.dirsAvailable, patterns: cp.supportedPatterns().length };
    } catch {
      /* 中文补丁模块异常不影响说明页 */
    }
    try {
      const arc = require('./core/data/legacy_version_archive.json');
      out.archive = {
        count: Number(arc && arc.count) || (Array.isArray(arc && arc.entries) ? arc.entries.length : 0),
        source: (arc && arc.source) || ''
      };
    } catch {
      /* 归档清单缺失也不影响 */
    }
    return out;
  },

  // ---------- 内容下载（Modrinth + CurseForge 镜像，core/contentapi.js） ----------
  /**
   * 通道：content:sources / content:search / content:project / content:versions /
   *       content:download / content:favorites / content:addFavorite / content:removeFavorite
   *
   * ★ 下载源（source）维度（2026-11-05 追加）：
   *   · 'mixed'（默认）—— 同时搜 Modrinth 与 CurseForge，按标题去重合并，结果带 source 字段
   *   · 'modrinth'     —— 只查 Modrinth（免费、无需登录）
   *   · 'curseforge'   —— 只查 CurseForge（官方 API 无 key 会 403，走镜像 mod.mcimirror.top）
   *   所有错误都是中文，并区分「网络不通（E_NETWORK / E_TIMEOUT）」与
   *   「服务返回错误（E_CONTENT_API + status）」。
   */
  'content:sources': async () => ({ ok: true, sources: need('contentapi').listSources() }),
  'content:search': async ({ source, projectType, query, mcVersion, loader, limit, offset }) =>
    need('contentapi').search({ source, projectType, query, mcVersion, loader, limit, offset }),
  'content:project': async ({ id, source }) => need('contentapi').getProject(String(id || ''), { source }),
  'content:versions': async ({ id, source, mcVersion, loader }) =>
    need('contentapi').getVersions(String(id || ''), { source, mcVersion, loader }),

  /**
   * ★★★ 查询某个版本的前置依赖（2026-11-05 新增，用户要求）。
   *
   * 用户原话：「检测到这个模组有可安装前置和必须安装前置，都要提醒一下。
   *          如果是必须安装前置，提醒是否一起安装；玩家点不一起安装就再确认一次
   *          缺少依赖可能导致游戏崩溃」。
   *
   * 前端拿到结果后自己弹窗，这里只负责把「前置是谁、要不要装、装哪个版本」查清楚。
   */
  'content:dependencies': async ({ dependencies, mcVersion, loader, timeoutMs }) => {
    try {
      const api = need('contentapi');
      const r = await api.resolveDependencies({
        dependencies: Array.isArray(dependencies) ? dependencies : [],
        mcVersion,
        loader,
        timeoutMs
      });
      return r;
    } catch (err) {
      return {
        required: [],
        optional: [],
        incompatible: [],
        embedded: 0,
        error: err?.message || String(err)
      };
    }
  },

  /**
   * 批量安装（主文件 + 选中的前置），一次下完。
   * 前端把「是否一起装前置」的选择结果传进来，这里逐个下载到同一个目标目录。
   */
  'content:downloadMany': async ({ items, instId, projectType, destDir, source, overwrite }) => {
    const api = need('contentapi');
    const target = await resolveContentDestDir({ instId, projectType, destDir });
    /**
     * ★ 重复下载策略（2026-11-05）：调用方没传就用设置里的全局值，默认 'replace'。
     *   见 settings.js 的 game.contentOverwrite 说明。
     */
    const mode = overwrite || (ctx.settings.get().game || {}).contentOverwrite || 'replace';
    const list = Array.isArray(items) ? items : [];
    const taskId = `content-many-${Date.now()}`;
    const progress = makeProgress(taskId);
    const results = [];
    let done = 0;

    for (const it of list) {
      if (!it || !it.id) continue;
      progress({
        phase: 'download',
        stage: `下载 ${it.label || it.id}（${done + 1}/${list.length}）`,
        current: done,
        total: list.length,
        percent: Math.round((done / list.length) * 100)
      });
      try {
        const r = await api.downloadTo(String(it.id), it.versionId || null, target, { source, overwrite: mode });
        results.push({ ok: true, id: it.id, label: it.label, ...r });
      } catch (err) {
        results.push({ ok: false, id: it.id, label: it.label, error: err?.message || String(err) });
      }
      done += 1;
    }

    progress({
      phase: 'done',
      stage: '全部完成',
      current: list.length,
      total: list.length,
      percent: 100,
      done: true
    });

    return {
      target,
      total: list.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results
    };
  },

  'content:download': async ({ id, versionId, instId, projectType, destDir, source, overwrite }) => {
    const api = need('contentapi');
    const target = await resolveContentDestDir({ instId, projectType, destDir });
    const mode2 = overwrite || (ctx.settings.get().game || {}).contentOverwrite || 'replace';
    const taskId = `content-${Date.now()}`;
    const progress = makeProgress(taskId);
    progress({ phase: 'download', stage: '准备下载', current: 0, total: 1, percent: 0 });
    const result = await api.downloadTo(String(id || ''), versionId || null, target, {
      onProgress: progress,
      source: source,
      overwrite: mode2
    });
    progress({
      phase: 'done',
      stage: '下载完成',
      current: 1,
      total: 1,
      file: result.filename,
      bytes: result.bytes,
      bytesTotal: result.bytes,
      percent: 100,
      done: true
    });
    ctx.log.write(
      `内容下载完成（${result.source || source || 'mixed'}）：${result.filename} → ${result.path}（${result.bytes} 字节）`
    );
    return { ...result, dir: target, taskId };
  },
  'content:favorites': async () => need('contentapi').listFavorites(home()),
  'content:addFavorite': async ({ item }) => need('contentapi').addFavorite(home(), item),
  'content:removeFavorite': async ({ id }) => need('contentapi').removeFavorite(home(), id),

  // ---------- 启动前检查 ----------
  /**
   * 返回「点击启动后」要显示在确认弹窗里的信息：
   *   · 检查结果（Java 版本、内存、文件完整性等）
   *   · 本次启动参数（Java / 内存 / 窗口大小 / 账号）
   *
   * 参照 HMCL 的 launch.advice.* 系列检查，但合并成一次弹窗（HMCL 是分次弹）。
   */
  'launch:precheck': async ({ id }) => {
    const instMod = need('instances');
    const javaMod = need('java');
    const prelaunch = need('prelaunch');

    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}` };

    // Java：实例级 > 全局 > 自动挑
    const settings = ctx.settings.get();
    const javaList = await javaMod.detectCached({ home: home() });
    let javaInfo = null;
    let javaSource = 'auto';
    if (inst.java && inst.java.path) {
      javaInfo = await javaMod.probe(inst.java.path).catch(() => null);
      javaSource = 'instance';
    }
    if (!javaInfo && settings.javaPath) {
      javaInfo = await javaMod.probe(settings.javaPath).catch(() => null);
      javaSource = 'global';
    }
    if (!javaInfo) {
      javaInfo = javaMod.pickBest(javaList, inst.mcVersion);
      javaSource = 'auto';
    }

    // 内存
    const memCfg = settings.memory || { mode: 'auto', mb: 2048 };
    const memMb = (inst.java && inst.java.memoryMb) || (memCfg.mode === 'manual' ? memCfg.mb : 2048);

    // 账号
    const accountsMod = core('accounts');
    const accountList = accountsMod ? await accountsMod.list(home()) : [];
    const account = accountList.find((a) => a.selected) || accountList[0] || null;

    // 检查
    const issues = prelaunch.buildChecks({
      instance: inst,
      javaInfo,
      memoryMb: memMb,
      settings,
      resolved: { id: inst.installedVersion || inst.mcVersion }
    });

    return {
      ok: true,
      instance: {
        id: inst.id,
        name: inst.name,
        mcVersion: inst.mcVersion,
        loader: inst.loader || null,
        dir: inst.dir
      },
      java: javaInfo
        ? {
            path: javaInfo.path,
            version: javaInfo.version,
            major: javaInfo.major,
            arch: javaInfo.arch,
            vendor: javaInfo.vendor,
            source: javaSource
          }
        : null,
      recommendJavaMajor: prelaunch.recommendMajor(inst.mcVersion),
      memoryMb: memMb,
      account: account ? { name: account.name, type: account.type } : null,
      launch: {
        width: (settings.launch && settings.launch.width) || 854,
        height: (settings.launch && settings.launch.height) || 480
      },
      issues
    };
  },

  // ---------- 第三方账号（authlib-injector）----------
  'authlib:probe': async ({ apiRoot }) => {
    try {
      return await need('authlib').probeServer(apiRoot);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'authlib:login': async ({ apiRoot, username, password }) => {
    try {
      const authlib = need('authlib');
      const accounts = need('accounts');
      const r = await authlib.loginWithPassword({ apiRoot, username, password });
      if (!r.ok) return r;

      // 存进 accounts.json（type='authlib'，带 apiRoot 与令牌）
      const stored = accounts.upsert(home(), r.account);
      send('accounts:changed', {});
      return { ok: true, account: stored, profiles: r.profiles, apiRoot: r.apiRoot };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'authlib:prepare': async () => {
    try {
      const authlib = need('authlib');
      return await authlib.ensureJar({
        home: home(),
        onLog: (line) => {
          ctx.log.write(line);
          send('launch:log', { id: '__authlib', line: String(line), stream: 'stdout' });
        }
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'authlib:status': async () => {
    const authlib = core('authlib');
    if (!authlib) return { installed: false };
    return { installed: authlib.isJarInstalled(home()), jar: authlib.findLocalJar(home()) };
  },

  // ---------- 工具（崩溃分析 / 实例备份）----------
  'tools:analyzeCrash': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}` };
    const analyzer = need('crashanalyzer');
    const result = analyzer.analyzeCrash({ instanceDir: inst.dir });
    return { ok: true, ...result };
  },
  'tools:backupInstance': async ({ id }) => {
    const instMod = need('instances');
    const inst = await instMod.get(home(), id);
    if (!inst) return { ok: false, error: `实例不存在：${id}` };
    const backup = need('backup');
    try {
      const result = await backup.backupInstance({
        home: home(),
        instance: inst,
        onLog: (line) => ctx.log.write(line)
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
  'tools:listBackups': async () => {
    const backup = need('backup');
    return backup.listBackups(home());
  },

  // ---------- 日志 / 外壳 ----------
  'log:recent': async ({ limit }) => ctx.log.recent(home(), Math.max(50, Math.min(5000, limit || 2000))),
  'shell:openPath': async ({ path: target }) => {
    if (!target) return { ok: false, error: '路径为空' };
    if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  },
  'shell:openExternal': async ({ url }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '只允许打开 http/https 链接' };
    await shell.openExternal(url);
    return { ok: true };
  }
};

function registerIpc() {
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return await fn(payload || {});
      } catch (err) {
        // 中文可读错误 + 完整栈写日志，界面拿到的是人话
        const message = err?.message || String(err);
        ctx.log.write(`[错误] ${channel}：${message}`);
        if (process.env.QCL_DEBUG) console.error(`[QCL] ${channel} 失败：`, err);
        throw new Error(message);
      }
    });
  }
}

function initContext({ settings }) {
  ctx.settings = settings;
}

module.exports = { registerIpc, initContext, ctx };
