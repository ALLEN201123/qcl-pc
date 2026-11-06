/**
 * QCL 电脑版 · 主页
 *
 * 照安卓版 1.5.9 新排版的中间内容区：**公告卡（约 40%）+ 3D 人物（约 48%）左右并排**。
 * 公告卡：标题「公告」/ 正文默认 6 行 / 「展开 · 收起」/ ◀ 日期 ▶ 翻页 / 「隐藏」。
 * 3D 人物：canvas 手绘皮肤模型，可拖动旋转、滚轮缩放、双击复位。
 */

import { ANNOUNCEMENTS } from '../mock.js';
import { state, currentAccount, currentInstance, loadInstances, notify, setCurrentInstance } from '../store.js';
import { SkinViewer, createSteveSkin } from '../skin.js';
import { html, raw, setHTML, toast, promptDialog, openModal, confirmDialog } from '../ui.js';
import { call } from '../bridge.js';
import { icon } from '../icons.js';
import * as router from '../router.js';
import { instanceIconUrl, instanceIconAlt } from '../instanceicon.js';

/* HTML 转义（主页「我的实例」卡片用） */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/\s+/g, ' ').trim();
}

const LS_HIDDEN = 'qcl.announcement.hidden';

function readHidden() {
  try {
    return window.localStorage.getItem(LS_HIDDEN) === '1';
  } catch (err) {
    return false;
  }
}

function writeHidden(v) {
  try {
    window.localStorage.setItem(LS_HIDDEN, v ? '1' : '0');
  } catch (err) {
    /* 忽略 */
  }
}

export const homePage = {
  id: 'home',
  title: '主页',
  async render(mount) {
    let index = Math.min(ANNOUNCEMENTS.length - 1, 0);
    let collapsed = true;
    let hidden = readHidden();

    setHTML(
      mount,
      html`<div class="page page--bare">
        <div class="home-update" id="home-update" hidden></div>
        <div class="home-tools">
          <button class="btn btn--ghost btn--sm" id="home-import-pack" type="button">${raw(icon('pack', 14))}导入整合包</button>
          <button class="btn btn--ghost btn--sm" id="home-repo" type="button">${raw(icon('external', 14))}GitHub 仓库</button>
          <span class="page__sub">支持 QCL 导出的 .zip 与 Modrinth 的 .mrpack —— 导入后自动新建一个实例</span>
        </div>
        <div class="home" id="home-grid">
          <div id="announce-slot" class="announce"></div>
          <div class="skinview" id="skinview">
            <canvas class="skinview__canvas" id="skin-canvas"></canvas>
            <div class="skinview__name" id="skin-name">默认皮肤 · Steve</div>
            <div class="skinview__toolbar">
              <button class="btn btn--ghost btn--sm" id="skin-reset" type="button">复位视角</button>
              <button class="btn btn--ghost btn--sm" id="skin-reload" type="button">重新加载皮肤</button>
            </div>
            <div class="skinview__hint" id="skin-hint">拖动旋转 · 滚轮缩放 · 双击复位</div>
          </div>
        </div>
        <!-- ★ 我的实例：玩家一进主页就能看到自己有哪些版本、当前用的是哪个 -->
        <div class="home-instances" id="home-instances">
          <div class="home-instances__head">
            <span class="home-instances__title">我的实例</span>
            <span class="home-instances__count" id="home-inst-count"></span>
            <span class="grow"></span>
            <button class="btn btn--ghost btn--sm" id="home-open-data" type="button">${raw(icon('folder', 13))}打开数据目录</button>
            <button class="btn btn--ghost btn--sm" id="home-more-inst" type="button">管理实例</button>
          </div>
          <div class="home-instances__grid" id="home-inst-grid"></div>
        </div>
      </div>`
    );

    const slot = mount.querySelector('#announce-slot');
    const grid = mount.querySelector('#home-grid');

    /* ---------------- 更新提示（未来发布新版时自动推送） ---------------- */
    /**
     * 启动时静默查一次 GitHub Releases（主进程 6 小时缓存，离线/失败不打扰玩家）。
     * 有新版才在页面顶部显示一条中文提示 + 「查看更新」按钮；
     * 纯提示、不自动下载不自动安装，安装包交给玩家自己双击。
     */
    (async () => {
      const box = mount.querySelector('#home-update');
      if (!box) return;
      const r = await call('app:checkUpdate', {}, { optional: true });
      const d = r && r.ok ? r.data : null;
      if (!d || !d.hasUpdate) return;
      box.hidden = false;
      setHTML(box, html`<div class="home-update__inner">
        <span class="home-update__dot"></span>
        <span class="home-update__text">发现新版本 <strong>QCL ${d.latest}</strong>（当前 ${d.current}）—— ${d.releaseName || '点右边看更新内容'}</span>
        <button class="btn btn--sm" id="home-update-open" type="button">${raw(icon('external', 13))}查看更新</button>
        <button class="btn btn--ghost btn--sm" id="home-update-close" type="button">稍后</button>
      </div>`);
      box.querySelector('#home-update-open').addEventListener('click', () => {
        call('app:openReleases', {}, { optional: true });
      });
      box.querySelector('#home-update-close').addEventListener('click', () => {
        box.hidden = true;
      });
    })();

    /* ---------------- 公告卡 ---------------- */

    function renderAnnounce() {
      if (hidden) {
        setHTML(
          slot,
          html`<button class="announce-hidden-hint" id="announce-show" type="button">
            ${raw(icon('info', 14))}<span>公告已隐藏，点这里重新显示</span>
          </button>`
        );
        grid.style.gridTemplateColumns = 'auto 1fr';
        const btn = slot.querySelector('#announce-show');
        if (btn)
          btn.addEventListener('click', () => {
            hidden = false;
            writeHidden(false);
            renderAnnounce();
          });
        return;
      }
      grid.style.gridTemplateColumns = '';

      const item = ANNOUNCEMENTS[index];
      const total = ANNOUNCEMENTS.length;
      setHTML(
        slot,
        html`<div class="announce__card ${collapsed ? '' : 'is-expanded'}">
            <div class="announce__head">
              <span class="announce__title">公告</span>
            </div>
            <div class="announce__sep"></div>
            <div class="announce__body ${collapsed ? 'is-collapsed' : ''}" id="announce-body">
              <span class="announce__head-title">${item.title}</span>
              <span class="announce__text" id="announce-text"></span>
            </div>
            <div class="announce__sep"></div>
            <button class="announce__expand" id="announce-toggle" type="button">
              ${collapsed ? '展开全文' : '收起'}
            </button>
            <div class="announce__pager">
              <!--
                ★ 翻页语义（2026-11-05 第二次修正 —— 这次按用户直觉来）：
                  · 列表按「从新到旧」排列：index 0 = 最新一条（第 1 条）
                  · 「第 1 / 3 条」时，用户最自然的动作是点 ▶ 看下一条
                  ⇒ 所以：
                      ▶ = 下一条（往更旧走）= index + 1
                      ◀ = 上一条（往更新走）= index - 1
                    禁用条件：
                      · ▶ 在已经是最旧（index >= total-1）时禁用
                      · ◀ 在已经是最新（index <= 0）时禁用
                  上一版把 ▶ 在 index 0 就禁用了，导致「第 1 / 3 条但点不动」，
                  看起来就像只有一条公告。这是那次修正的方向错误。
              -->
              <button class="announce__nav" id="announce-prev" type="button" title="上一条公告（更新）" ${total <= 1 || index <= 0 ? 'disabled' : ''}>◀</button>
              <span class="announce__date" id="announce-date">${item.date} · 第 ${index + 1} / ${total} 条</span>
              <button class="announce__nav" id="announce-next" type="button" title="下一条公告（更早）" ${total <= 1 || index >= total - 1 ? 'disabled' : ''}>▶</button>
            </div>
          </div>
          <button class="announce__hide" id="announce-hide" type="button">隐藏公告</button>`
      );

      // 正文里有换行，用 textContent 保证不被当成 HTML；
      // 但公告文本带 Markdown 的 `**强调**`，直接显示会让玩家看到一堆星号 —— 这里剥掉星号
      const textEl = slot.querySelector('#announce-text');
      if (textEl) {
        textEl.textContent = String(item.text || '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/__([^_]+)__/g, '$1');
      }

      const toggle = slot.querySelector('#announce-toggle');
      if (toggle)
        toggle.addEventListener('click', () => {
          collapsed = !collapsed;
          renderAnnounce();
        });
      // ◀ = 上一条（往更新走）= index - 1
      const prev = slot.querySelector('#announce-prev');
      if (prev)
        prev.addEventListener('click', () => {
          index = Math.max(0, index - 1);
          collapsed = true;
          renderAnnounce();
        });
      // ▶ = 下一条（往更旧走）= index + 1
      const next = slot.querySelector('#announce-next');
      if (next)
        next.addEventListener('click', () => {
          index = Math.min(total - 1, index + 1);
          collapsed = true;
          renderAnnounce();
        });
      const hide = slot.querySelector('#announce-hide');
      if (hide)
        hide.addEventListener('click', () => {
          hidden = true;
          writeHidden(true);
          renderAnnounce();
        });
    }

    renderAnnounce();

    /* ---------------- 3D 人物 ---------------- */

    const canvas = mount.querySelector('#skin-canvas');
    const viewer = new SkinViewer(canvas, { yaw: -20, pitch: 5 });
    // 调试钩子：自测脚本用它检查人物渲染的运行时状态（不暴露主进程能力）
    if (typeof window !== 'undefined') window.__qclSkinViewer = viewer;

    const account = currentAccount();
    const skinUrl = account && account.avatar ? account.avatar : '';
    let skinSource = '默认皮肤 · Steve';

    async function loadSkin() {
      const acct = currentAccount();
      // 先无条件套上默认皮肤，保证首帧就有人
      try {
        await viewer.useDefaultSkin();
      } catch (err) {
        console.error('[QCL] 默认皮肤加载失败：', err);
      }
      skinSource = '默认皮肤 · Steve';

      /**
       * ★★★ 皮肤优先级（与安卓版一致）：
       *   ① 自定义皮肤文件（账号里存了 skinFile）—— 用户明确指定的，最高优先
       *   ② 账号自带皮肤（微软正版账号从皮肤站拿到的 avatar URL）
       *   ③ 内置默认（steve.png）
       *
       * ★★ 关键：Mojang 皮肤站返回的是 `http://textures.minecraft.net/...`，
       *    而页面的 CSP 里 img-src 只放了 `https:` —— http 会被**混合内容策略**拦掉，
       *    表现就是「账号皮肤加载失败，已用默认 Steve」（实测抓到）。
       *    ⇒ 统一走 `skin:readRemote` 让主进程下载并转成 data: URL，
       *      渲染层只吃 data:，不受 CSP 限制，也不放开 CSP 降低安全性。
       */
      let used = null;

      /** 把任意皮肤地址（本地文件 / http / data:）统一变成 data URL */
      async function toSkinDataUrl(acct) {
        // ★ 没有账号时 acct 是 null（新装的启动器就是这种状态），必须先挡一下，
        //   否则 `acct.skinFile` 直接抛 TypeError（控制台里会刷一条「皮肤加载失败」）
        if (!acct) return null;
        // 本地文件
        if (acct.skinFile) {
          const res = await call('accounts:readSkin', { path: acct.skinFile });
          const d = res && res.data && res.data.dataUrl;
          if (d) return d;
        }
        // 远程 http(s) → 主进程代理下载
        if (acct.avatar) {
          const res = await call('skin:readRemote', { url: acct.avatar });
          const d = res && res.data && res.data.dataUrl;
          if (d) return d;
        }
        return null;
      }

      try {
        const dataUrl = await toSkinDataUrl(acct);
        if (dataUrl) {
          const ok = await viewer.setSkinFromDataUrl(dataUrl);
          if (ok) {
            used = true;
            skinSource = acct.skinFile ? `${acct.name} 的自定义皮肤` : `${acct.name} 的账号皮肤`;
            // slim 皮肤（Alex）要用细手臂模型
            if (acct.skinModel === 'slim') {
              try {
                await viewer._switchStyle('slim');
              } catch {
                /* 切模型失败不影响贴图 */
              }
            }
          }
        }
      } catch (err) {
        console.error('[QCL] 皮肤加载失败：', err);
      }

      if (!used && acct) {
        skinSource = acct.skinFile || acct.avatar ? '账号皮肤读取失败，已用默认 Steve' : '默认皮肤 · Steve';
      }

      /**
       * ★★★ 披风（2026-11-05 新增）。
       *
       * 用户实测「主界面人物没有同步背后的披风」——查证是两处断链：
       *   ① accounts.js 从来没保存 capeUrl（只取了皮肤，把同一数组里的 cape 丢了）；
       *   ② skin.js 把披风网格**硬编码隐藏**（`obj.visible = false`，注释「披风没有对应贴图」）。
       * 现在两处都补上了，这里负责把披风贴图真正加载进来。
       *
       * ★ 披风地址是 `http://textures.minecraft.net/...`，页面 CSP 只放行 https，
       *   所以必须走主进程代理（skin:readRemote）拿 data: URL，不能直连。
       */
      let capeApplied = false;
      if (acct && acct.capeUrl) {
        try {
          const r = await call('skin:readRemote', { url: acct.capeUrl });
          const dataUrl = r && r.data && r.data.dataUrl;
          if (dataUrl) {
            capeApplied = await viewer.setCapeFromUrl(dataUrl);
          }
        } catch (err) {
          console.warn('[QCL] 披风加载失败（不影响人物）：', err);
        }
      }
      if (!capeApplied) {
        // 没有披风 / 加载失败：确保网格是隐藏的，别留一块白板
        try {
          viewer.setCapeImage(null);
        } catch {
          /* 忽略 */
        }
      }
      if (acct && acct.capeUrl && capeApplied) {
        skinSource = `${skinSource}（含披风）`;
      }

      const nameEl = mount.querySelector('#skin-name');
      if (nameEl) setHTML(nameEl, html`${skinSource}${acct ? ` · ${acct.name}` : ''}`);
    }

    // 先立刻显示程序化 Steve（绝不留空白），再异步换成账号皮肤
    const nameEl0 = mount.querySelector('#skin-name');
    if (nameEl0)
      setHTML(
        nameEl0,
        html`${account ? `${account.name} · 默认皮肤` : '默认皮肤 · Steve'}${state.connected ? '' : '（示例模式）'}`
      );

    viewer.start();
    loadSkin();

    const resetBtn = mount.querySelector('#skin-reset');
    if (resetBtn)
      resetBtn.addEventListener('click', () => {
        viewer.yaw = -20;
        viewer.pitch = 5;
        viewer.zoom = 1;
        toast('已复位视角', 'ok', 1500);
      });
    const reloadBtn = mount.querySelector('#skin-reload');
    if (reloadBtn)
      reloadBtn.addEventListener('click', () => {
        loadSkin();
        toast('正在重新加载皮肤…', 'info', 1600);
      });

    // 首次进入 5 秒后淡出提示
    const hint = mount.querySelector('#skin-hint');
    if (hint) setTimeout(() => (hint.style.opacity = '0'), 5000);

    /* ---------------- 导入整合包（照 HMCL 的 modpack 导入） ---------------- */

    const importBtn = mount.querySelector('#home-import-pack');
    if (importBtn) importBtn.addEventListener('click', () => importModpackFlow(importBtn));

    /** ★ 主页直达本项目的 GitHub 仓库（外链一律走主进程 shell:openExternal） */
    const repoBtn = mount.querySelector('#home-repo');
    if (repoBtn) {
      repoBtn.addEventListener('click', async () => {
        const r = await call('shell:openExternal', { url: 'https://github.com/ALLEN201123/qcl-pc' });
        if (!r.ok) toast(r.error || '打开仓库失败', 'error', 5000);
      });
    }

    /* ---------------- 我的实例（玩家一进主页就能看到自己的实例） ---------------- */
    /**
     * 用户反馈「打开程序目录看不到自己的实例」。
     * 除了在程序目录建数据入口，主页也必须**直接列出实例** ——
     * 否则玩家只能靠左栏「版本列表」自己找，很容易以为数据丢了。
     */
    const instGrid = mount.querySelector('#home-inst-grid');
    const instCount = mount.querySelector('#home-inst-count');

    /** 加载器中文名（与版本设置页保持一致） */
    function loaderLabel(inst) {
      const l = inst && inst.loader;
      if (!l || !l.type || l.type === 'vanilla') return '原版';
      const map = {
        fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge',
        quilt: 'Quilt', modloader: 'ModLoader', babric: 'Babric', optifine: 'OptiFine',
      };
      const name = map[String(l.type).toLowerCase()] || String(l.type);
      return l.version ? `${name} ${l.version}` : name;
    }

    function renderInstances() {
      if (!instGrid) return;
      const list = (state.instances || []).slice();
      const cur = currentInstance();
      if (instCount) instCount.textContent = list.length ? `（${list.length} 个）` : '';
      if (!list.length) {
        setHTML(
          instGrid,
          html`<div class="home-instances__empty">
             还没有任何实例。去「下载」装一个游戏版本，或在上面导入整合包。
           </div>`
        );
        return;
      }
      setHTML(
        instGrid,
        html`${list.map((i) => {
          const active = cur && cur.id === i.id;
          const ver = i.installedVersion || i.mcVersion || '未指定版本';
          return raw(`<button class="home-inst ${active ? 'is-active' : ''}" type="button" data-inst="${escapeAttr(i.id)}" title="点击切换到该实例">
            <span class="home-inst__icon"><img src="${escapeAttr(instanceIconUrl(i))}" alt="${escapeAttr(instanceIconAlt(i))}" /></span>
            <span class="home-inst__main">
              <span class="home-inst__name">${escapeHtml(i.name || i.id)}</span>
              <span class="home-inst__meta">${escapeHtml(ver)} · ${escapeHtml(loaderLabel(i))}</span>
            </span>
            <span class="home-inst__badge">${active ? '当前' : '切换'}</span>
          </button>`);
        })}`
      );
      instGrid.querySelectorAll('[data-inst]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-inst');
          const inst = (state.instances || []).find((x) => x.id === id);
          if (!inst) return;
          // ★ setCurrentInstance 收的是 **id 字符串**（不是对象），内部会写存储 + notify
          setCurrentInstance(id);
          renderInstances();
          // 右栏「版本行 + 启动按钮」跟着换。
          // 用动态 import 而不是顶层 import，避免 home ↔ shell 的模块循环依赖。
          import('../shell.js')
            .then((m) => {
              if (typeof m.updateRightPanel === 'function') m.updateRightPanel();
            })
            .catch(() => {
              /* 刷新失败不影响切换 */
            });
          toast(`已切换到「${inst.name || id}」`, 'ok', 2200);
        });
      });
    }

    if (instGrid) renderInstances();

    // 「打开数据目录」：主进程 shell:openPath 打开真实主目录（不是程序目录）
    const openDataBtn = mount.querySelector('#home-open-data');
    if (openDataBtn) {
      openDataBtn.addEventListener('click', async () => {
        const h = state.settings && state.settings.home;
        if (!h) {
          toast('还没拿到数据目录路径', 'error', 4000);
          return;
        }
        const r = await call('shell:openPath', { path: h });
        if (!r.ok) toast(r.error || `打开失败：${h}`, 'error', 6000);
      });
    }

    // 「管理实例」→ 版本列表页
    const moreBtn = mount.querySelector('#home-more-inst');
    if (moreBtn) moreBtn.addEventListener('click', () => router.navigate('versionlist'));

    /**
     * 选整合包文件。
     * ① 优先用主进程的通用文件选择器 `app:pickFile`（返回 `{canceled, filePath}`）；
     * ② 后端还没接上时降级成「手动粘贴路径」——和「JAR 启动」页同一套做法，
     *    绝不因为缺一个对话框就让功能整个不可用。
     */
    async function pickModpack() {
      const picked = await call(
        'app:pickFile',
        { title: '选择整合包', filters: [{ name: '整合包', extensions: ['zip', 'mrpack'] }] },
        { optional: true }
      );
      if (picked.ok && picked.data) {
        if (picked.data.canceled) return '';
        return picked.data.filePath || picked.data.path || '';
      }
      const typed = await promptDialog({
        title: '导入整合包',
        label: '整合包文件的完整路径',
        placeholder: '例如 D:\\下载\\我的整合包.zip',
        hint: '系统文件选择器还没接入，先手动粘贴 .zip / .mrpack 的完整路径。',
        okText: '下一步',
      });
      return typed ? String(typed).trim() : '';
    }

    async function importModpackFlow(btn) {
      const file = await pickModpack();
      if (!file) return;

      btn.disabled = true;
      const insp = await call('modpack:inspect', { path: file, file }, { optional: true });
      btn.disabled = false;
      // ★ 主进程失败时把 { ok:false, error } 当 data 返回，外层 r.ok 仍为 true
      const inspFail = insp.data && insp.data.ok === false;
      if (!insp.ok || !insp.data || inspFail) {
        toast((inspFail && insp.data.error) || insp.error || '读不出这个文件：可能不是整合包，或者路径不对', 'warn', 6500);
        return;
      }
      const info = insp.data || {};
      const loaderText = info.loader
        ? typeof info.loader === 'string'
          ? info.loader
          : [info.loader.type, info.loader.version].filter(Boolean).join(' ')
        : '未标注';
      // 契约字段：{ name, version, mcVersion, loader, modCount, fileCount, format, isModpack }
      const modCount = info.modCount != null ? info.modCount : info.mods;
      const fileCount = info.fileCount != null ? info.fileCount : info.files;

      const confirmed = await openModal({
        title: '确认导入整合包',
        wide: true,
        buttons: [
          { text: '取消', value: null, kind: 'ghost' },
          { text: '开始导入', value: true, kind: 'primary', autofocus: true },
        ],
        body: html`<div class="kv">
            <div class="kv__k">整合包名</div>
            <div class="kv__v">${info.name || '未命名'}</div>
            <div class="kv__k">游戏版本</div>
            <div class="kv__v">${info.mcVersion || info.version || '未标注'}</div>
            <div class="kv__k">加载器</div>
            <div class="kv__v">${loaderText}</div>
            <div class="kv__k">模组数</div>
            <div class="kv__v">${modCount != null ? `${modCount} 个` : '未标注'}</div>
            <div class="kv__k">压缩包条目</div>
            <div class="kv__v">${fileCount != null ? `${fileCount} 个` : '—'}</div>
            <div class="kv__k">格式</div>
            <div class="kv__v">${info.format || (info.ours ? 'QCL 整合包' : '其它启动器 / 手工打包')}</div>
            <div class="kv__k">路径</div>
            <div class="kv__v mono">${file}</div>
          </div>
          <div class="sourcetip" style="margin-top:10px">
            导入会新建一个独立实例，不会改动你现有的实例。<br />
            <strong>注意：整合包不含游戏本体</strong>，导入后还要在版本设置里装对应版本（${info.mcVersion || '同版本'}），否则启动不了。
          </div>`,
      });
      if (!confirmed) return;

      btn.disabled = true;
      toast('正在导入整合包…', 'info', 3200);
      /** 主进程失败时把 `{ok:false,error}` 当 data 返回（外层仍 ok）⇒ 统一归一化 */
      const norm = (x) =>
        x && x.data && x.data.ok === false
          ? { ok: false, error: x.data.error || '', data: x.data }
          : { ok: !!(x && x.ok), error: (x && x.error) || '', data: x && x.data };
      let r = norm(await call('modpack:import', { file, path: file, name: info.name || '' }, { optional: true }));
      let importedTo = '';

      /**
       * ★ 旧版主进程的 `modpack:import` 只能「导入到已有实例」（参数是 id + path）。
       *   新契约是 `{file}` 自动建实例。这里两步走：新契约失败时才问用户要不要导进当前实例 ——
       *   绝不偷偷覆盖别人的实例。
       */
      if (!r.ok) {
        const inst = currentInstance();
        if (!inst) {
          btn.disabled = false;
          toast(r.error || '导入失败：主进程的整合包导入还没就绪', 'warn', 6500);
          return;
        }
        const ok = await confirmDialog({
          title: '导入到已有实例？',
          message: `当前主进程还不支持直接新建实例。要把这个整合包导入到当前实例「${inst.name}」吗？同名文件会被覆盖。`,
          okText: '导入到当前实例',
          danger: true,
        });
        if (!ok) {
          btn.disabled = false;
          return;
        }
        r = norm(await call('modpack:import', { id: inst.id, path: file, overwrite: true }, { optional: true }));
        importedTo = inst.id;
      }
      btn.disabled = false;

      if (!r.ok) {
        toast(r.error || '导入失败', 'warn', 6500);
        return;
      }

      const d = r.data || {};
      await loadInstances();
      notify('instances');
      // 契约：modpack:import → { instanceId, instance }（instance 是对象，不能直接当 id 用）
      const newId = typeof d.instanceId === 'string' ? d.instanceId : typeof d.id === 'string' ? d.id : importedTo;
      if (newId) {
        setCurrentInstance(newId);
        notify('current-instance');
      }
      const parts = [];
      if (d.extracted != null) parts.push(`${d.extracted} 个文件`);
      if (d.skipped) parts.push(`跳过 ${d.skipped} 个已存在文件`);
      toast(
        `整合包导入完成${parts.length ? `：${parts.join('，')}` : ''}。注意还要给这个实例装 ${info.mcVersion || '对应版本'} 的游戏本体才能启动`,
        'ok',
        7000
      );
      if (newId) router.navigate('versionsetting', { instanceId: newId });
      else router.navigate('versionlist');
    }

    return {
      destroy() {
        viewer.destroy();
      },
    };
  },
};

export default homePage;
