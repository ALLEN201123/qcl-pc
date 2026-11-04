/**
 * QCL 电脑版 · 下载（PC 两级结构）
 *
 * ## 结构（用户要求「不能再用手机的美观界面了」）
 *
 *   左侧竖排 7 大分类：游戏 / 整合包 / 模组 / 资源包 / 光影 / 世界 / 收藏
 *   「游戏」下面四个二级分页：正式版 / 快照 / **愚人节版本** / 远古版本
 *   右侧内容区：卡片网格 `repeat(auto-fill, minmax(280px, 1fr))`，
 *   每张卡片 = 左侧 64×64 图标 + 右侧标题/作者/下载量/版本标签，hover 抬升 + 边框高亮。
 *
 * ## 数据来源
 *   · 游戏：`versions:manifest`（正式版/快照） / `versions:ancient`（远古） /
 *           `versions:aprilFools`（愚人节版本，后端新加）
 *   · 内容类：`content:search` / `content:project` / `content:versions` / `content:install` /
 *           `content:favorites` / `content:addFavorite` / `content:removeFavorite`
 *
 * ## 铁律：优雅降级
 *   `content:*` 这一批 IPC 后端**正在做**。任何一条返回 `!ok` 或没有 data，
 *   界面一律显示「该功能正在接入」的空状态 —— 绝不白屏、绝不抛错、绝不弹英文。
 *
 * ## 任务表放在模块级
 *   切到别的页面再回来，安装进度不会丢（`task:progress` 事件也只订阅一次）。
 */

import { call, on } from '../bridge.js';
import { state, currentInstance, loadInstances, notify } from '../store.js';
import {
  html,
  raw,
  setHTML,
  toast,
  fmtSpeed,
  emptyState,
  skeletonRows,
  versionTypeLabel,
  debounce,
  confirmDialog,
} from '../ui.js';
import { icon } from '../icons.js';

/** taskId -> { taskId, versionId, instanceName, phase, stage, current, total, file, speed, done, error, startedAt } */
const TASKS = new Map();
let taskWired = false;

function wireTasks() {
  if (taskWired) return;
  taskWired = true;
  on('task:progress', (p) => {
    if (!p || !p.taskId) return;
    const prev = TASKS.get(p.taskId) || { taskId: p.taskId, startedAt: Date.now() };
    TASKS.set(p.taskId, Object.assign(prev, p, { updatedAt: Date.now() }));
    document.dispatchEvent(new CustomEvent('qcl:tasks'));
  });
}

function pct(t) {
  if (!t) return 0;
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  /**
   * ★ 进度优先级（后端 task:progress 的三种形态都要吃得下）：
   *   ① `percent` —— 内容类单文件下载只有 1/1，current/total 永远是 100%，**必须**用它；
   *   ② `bytes/bytesTotal` —— 有字节数时更真实；
   *   ③ `current/total` —— 老的多文件安装任务。
   */
  if (Number.isFinite(Number(t.percent)) && Number(t.percent) > 0) return clamp(Number(t.percent));
  if (Number(t.bytesTotal) > 0) return clamp((Number(t.bytes) / Number(t.bytesTotal)) * 100);
  if (!t.total) return 0;
  return clamp((t.current / t.total) * 100);
}

const LOADERS = [
  { id: 'vanilla', label: '原版' },
  { id: 'forge', label: 'Forge' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'optifine', label: 'OptiFine' },
];

/**
 * 一级分类。
 * `projectType` 是传给 `content:search` 的值；「游戏」「收藏」不是内容类，没有这个字段。
 */
const CATEGORIES = [
  { id: 'game', label: '游戏', icon: 'play', desc: '安装 Minecraft 本体' },
  { id: 'modpack', label: '整合包', icon: 'pack', projectType: 'modpack', desc: '带模组与配置的一体化整合包' },
  { id: 'mod', label: '模组', icon: 'gamepad', projectType: 'mod', desc: '给游戏加功能的模组' },
  { id: 'resourcepack', label: '资源包', icon: 'palette', projectType: 'resourcepack', desc: '替换材质与音效' },
  { id: 'shader', label: '光影', icon: 'bolt', projectType: 'shader', desc: '真实光照与水面反射' },
  { id: 'world', label: '世界', icon: 'earth', projectType: 'world', desc: '地图与存档' },
  { id: 'datapack', label: '数据包', icon: 'file', projectType: 'datapack', desc: '给原版加配方、结构、地形（服务端 / 单人档都能用）' },
  { id: 'favorites', label: '收藏', icon: 'star', desc: '你收藏的项目' },
];

/** 「游戏」的二级分页 */
const GAME_TABS = [
  { id: 'release', label: '正式版' },
  { id: 'snapshot', label: '快照' },
  { id: 'april', label: '愚人节版本' },
  { id: 'ancient', label: '远古版本' },
];

/** 内容类分类里，加载器筛选有意义的只有整合包与模组 */
const LOADER_CATEGORIES = new Set(['modpack', 'mod']);

const PAGE_SIZE = 40;

/**
 * 内容来源（下载源）。
 *
 * `content:sources` 拿不到时（后端还没接、或离线）按用户要求：
 * **默认用「混合」并且隐藏切换器**，绝不报错、绝不白屏。
 * 服务端返回的每一项是 `{ id, name, desc }`。
 */
const SOURCE_FALLBACK = [
  { id: 'mixed', name: '混合（推荐）', desc: '同时搜索 Modrinth 与 CurseForge' },
];

/** 每个结果卡片右上角的来源徽章：Modrinth 蓝 / CurseForge 橙；没有 source 字段就不显示 */
function sourceBadge(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'modrinth') return html`<span class="badge badge--modrinth">Modrinth</span>`;
  if (s === 'curseforge') return html`<span class="badge badge--curseforge">CurseForge</span>`;
  return raw('');
}

/* ------------------------------ 小工具 ------------------------------ */

function asList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['versions', 'items', 'list', 'hits', 'projects', 'results', 'data']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

/** 下载量：1234567 → 123.5 万 */
function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)} 万`;
  return String(Math.round(v));
}

/** 项目字段归一化：后端字段名可能有好几种写法，全部兼容，缺的给中文兜底 */
function normProject(p) {
  if (!p) return null;
  if (typeof p === 'string') return { id: p, name: p, author: '作者未知', downloads: 0, iconUrl: '', summary: '' };
  const author =
    p.author ||
    p.owner ||
    p.authorName ||
    (Array.isArray(p.authors) && p.authors.length
      ? typeof p.authors[0] === 'string'
        ? p.authors[0]
        : p.authors[0].name || p.authors[0].userName
      : '') ||
    '作者未知';
  return {
    id: p.id != null ? p.id : p.projectId != null ? p.projectId : p.slug || p.project_id || '',
    name: p.name || p.title || p.slug || '未命名项目',
    author: String(author),
    downloads: p.downloads != null ? p.downloads : p.downloadCount != null ? p.downloadCount : p.download && p.download.count,
    iconUrl: p.iconUrl || p.icon_url || p.icon || p.logo || p.avatarUrl || '',
    summary: p.summary || p.description || p.desc || '',
    // 内容来源（'modrinth' | 'curseforge'），后端给了才画徽章
    source: p.source || p.platform || '',
    gameVersions: Array.isArray(p.gameVersions) ? p.gameVersions : Array.isArray(p.versions) ? p.versions : [],
    categories: Array.isArray(p.categories) ? p.categories : [],
  };
}

/** 版本字段归一化（`content:versions` 的返回、愚人节版本都用它） */
function normVersion(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    return { id: v, name: v, versionNumber: v, gameVersions: [], loaders: [], dependencies: [] };
  }
  return {
    id: v.id != null ? v.id : v.versionId != null ? v.versionId : v.version_id || v.name || '',
    name: v.name || v.versionNumber || v.version_name || v.id || '未命名版本',
    versionNumber: v.versionNumber || v.version_number || v.name || '',
    gameVersions: Array.isArray(v.gameVersions)
      ? v.gameVersions
      : Array.isArray(v.game_versions)
        ? v.game_versions
        : [],
    loaders: Array.isArray(v.loaders) ? v.loaders : Array.isArray(v.loader) ? v.loader : [],
    date: v.datePublished || v.date || v.releaseTime || '',
    downloadUrl: v.downloadUrl || v.url || '',
    /**
     * ★★★ 2026-11-05 修（用户质疑「有没有可能你下载的根本就是没有前置的模组」）。
     *
     * 之前这里**漏了 dependencies 字段** —— 于是 `pickDependenciesFor()` 里
     * `v.dependencies` 永远是 undefined，前置检测代码根本没机会执行，
     * 表现就是「点安装从来不弹前置提醒」。
     * 现在原样带上（后端 shapeVersion 已经给的是
     * `[{ projectId, versionId, fileName, type }]`）。
     */
    dependencies: Array.isArray(v.dependencies) ? v.dependencies : [],
    files: Array.isArray(v.files) ? v.files : [],
  };
}

/** 图标盒子：有图标地址就贴图，否则用矢量图标兜底（绝不出现 404 白块） */
function iconBox(src, glyph, cls = '') {
  const safe = typeof src === 'string' && /^(https:|data:|\.\/)/i.test(src) ? src : '';
  if (safe) {
    return html`<span class="dlcard__icon ${cls}"><img src="${safe}" alt="" loading="lazy" data-fallback="${glyph}" /></span>`;
  }
  return html`<span class="dlcard__icon ${cls}">${raw(icon(glyph, 28))}</span>`;
}

/** 图片加载失败时换回矢量图标（委托在容器上做，渲染多少次都有效） */
function wireIconFallback(root) {
  if (!root || root._qclIconFallback) return;
  root._qclIconFallback = true;
  root.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.closest('.dlcard__icon')) return;
      const box = img.closest('.dlcard__icon');
      box.innerHTML = icon(img.dataset.fallback || 'pack', 28);
    },
    true
  );
}

export const downloadPage = {
  id: 'download',
  title: '下载',
  async render(mount) {
    wireTasks();

    /* ---------------- 页面状态 ---------------- */
    let category = 'game';
    let gameTab = 'release';
    let keyword = '';

    /**
     * ★★★ 默认跟随「当前实例」的版本与加载器（2026-11-05，用户要求）。
     *
     * 用户原话：「模组那块是不是也一样能够推荐当前实例版本的最新版本？
     *           资源包、世界、光影同理」。
     *
     * 以前这里是 `mcVersion = ''` / `loader = 'vanilla'` ——
     * 于是进「模组」分类看到的是**全网热门**，跟自己装的版本毫无关系，
     * 点进去发现不兼容还要自己回去改筛选。
     *
     * ⇒ 现在开页就用当前实例的 mcVersion + 加载器预填：
     *     · 玩家装的是 1.20.1 + Fabric → 模组列表直接就是这个版本能用的
     *     · 没有实例时才留空（回退全网热门）
     *   `followInstance` 记录「是否还在跟随」，玩家一手动改筛选就置 false，
     *   避免他改完又被自动覆盖回去。
     */
    const bootInst = currentInstance();
    let mcVersion = (bootInst && bootInst.mcVersion) || '';
    let loader = (bootInst && bootInst.loader && bootInst.loader.type) || 'vanilla';
    let followInstance = !!(bootInst && bootInst.mcVersion);

    let manifest = null;
    let ancient = null;
    let april = null;
    let aprilLoaded = false;
    let aprilDegraded = false;
    let gameLoading = true;
    let contentItems = [];
    let contentLoading = false;
    let contentError = '';
    let contentOffset = 0;
    let contentHasMore = false;
    let mixedHint = false;
    let contentLoaded = false;
    let contentQuery = ''; // 实际发出请求时用的关键词（避免输入框抖动导致状态错乱）
    let favIds = new Set();
    /** 内容来源：默认「混合」；拿不到 content:sources 时只有它一个且切换器隐藏 */
    let source = 'mixed';
    let sources = SOURCE_FALLBACK.slice();
    let sourcesDegraded = true;

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">下载</div>
          <div class="page__sub" id="dl-count"></div>
          <div class="page__spacer"></div>
          <button class="btn btn--ghost btn--sm" id="dl-reload" type="button">${raw(icon('refresh', 14))}重新拉取</button>
        </div>

        <div class="dl">
          <aside class="dl__side" id="dl-cats" aria-label="下载分类"></aside>

          <div class="dl__pane">
            <div class="dl__toolbar" id="dl-toolbar"></div>
            <div class="dl__subtabs" id="dl-subtabs"></div>
            <div class="dl__scroll" id="dl-scroll">
              <div class="dlgrid" id="dl-list"></div>
              <div class="dl__more" id="dl-more"></div>
            </div>
            <div class="dl__tasksbar" id="dl-tasksbar">
              <div class="dl__side-title">安装任务</div>
              <div class="dl__tasks" id="dl-tasks"></div>
            </div>
          </div>
        </div>
      </div>`
    );

    const listEl = mount.querySelector('#dl-list');
    const moreEl = mount.querySelector('#dl-more');
    const countEl = mount.querySelector('#dl-count');
    const tasksEl = mount.querySelector('#dl-tasks');
    const catsEl = mount.querySelector('#dl-cats');
    const toolbarEl = mount.querySelector('#dl-toolbar');
    const subtabsEl = mount.querySelector('#dl-subtabs');
    const scrollEl = mount.querySelector('#dl-scroll');
    const tasksBarEl = mount.querySelector('#dl-tasksbar');
    wireIconFallback(listEl);

    const catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];

    /* ============================ 左侧分类 ============================ */

    function renderCats() {
      setHTML(
        catsEl,
        html`${CATEGORIES.map(
          (c) => html`<button class="dlcat ${c.id === category ? 'is-active' : ''}" type="button" data-cat="${c.id}" title="${c.desc || ''}">
            <span class="dlcat__icon">${raw(icon(c.icon, 20))}</span>
            <span class="dlcat__label">${c.label}</span>
          </button>`
        )}`
      );
    }

    /* ============================ 工具条 ============================ */

    function renderToolbar() {
      const isGame = category === 'game';
      const isFav = category === 'favorites';
      const parts = [];

      if (!isFav) {
        parts.push(html`<input class="input dl__search" id="dl-search" placeholder="${isGame ? '搜索版本号，例如 1.20' : '搜索项目名称'}" autocomplete="off" value="${keyword}" />`);
      }
      if (!isGame && !isFav) {
        parts.push(html`<input class="input dl__mcver" id="dl-mcver" placeholder="游戏版本，例如 1.20.1" autocomplete="off" value="${mcVersion}" />`);
        /**
         * ★ 跟随当前实例的提示 / 一键跟随按钮（2026-11-05）。
         *   玩家进模组/资源包/光影/世界时，默认就是这个版本能用的内容；
         *   一旦手动改了筛选，这里变成「跟随当前实例」按钮，点一下恢复。
         */
        const inst = currentInstance();
        if (inst && inst.mcVersion) {
          if (followInstance) {
            parts.push(
              html`<span class="dl__follow is-on" title="当前列表已按这个实例的版本与加载器筛选">
                ${raw(icon('done', 12))} 跟随：${inst.mcVersion}${inst.loader && inst.loader.type !== 'vanilla' ? ` · ${inst.loader.type}` : ''}
              </span>`
            );
          } else {
            parts.push(
              html`<button class="dl__follow" id="dl-follow" type="button" title="按当前实例的 ${inst.mcVersion} 重新筛选">
                跟随 ${inst.mcVersion}
              </button>`
            );
          }
        }
      }
      if (isGame || LOADER_CATEGORIES.has(category)) {
        parts.push(html`<span class="page__sub nowrap">加载器</span>
          <select class="select" id="dl-loader" style="max-width:120px">
            ${LOADERS.map((l) => raw(`<option value="${l.id}"${loader === l.id ? ' selected' : ''}>${l.label}</option>`))}
          </select>`);
      }
      if (isGame) {
        parts.push(
          html`<span class="page__sub nowrap">安装到</span>
            <select class="select" id="dl-target" style="max-width:190px"></select>`
        );
      }
      if (!isGame && !isFav) {
        parts.push(html`<button class="btn btn--sm" id="dl-do-search" type="button">${raw(icon('search', 14))}搜索</button>`);
        /**
         * 下载源切换器（胶囊按钮组）。
         * ★ `content:sources` 拿不到时按约定**隐藏切换器**并默认「混合」，
         *   所以这里只在真的拿到多个来源时才画。
         */
        if (!sourcesDegraded && sources.length > 1) {
          parts.push(
            html`<span class="dl__sep"></span><span class="page__sub nowrap">来源</span>
              <div class="segmented dl__sources" id="dl-sources" role="group" aria-label="内容来源">
                ${sources.map(
                  (s) => raw(`<button class="segmented__item ${s.id === source ? 'is-active' : ''}" type="button" data-src="${s.id}" title="${s.desc || ''}">${s.name}</button>`)
                )}
              </div>`
          );
        }
      }
      parts.push(html`<span class="page__spacer"></span><span class="page__sub nowrap" id="dl-hint">${catOf(category).desc || ''}</span>`);

      setHTML(toolbarEl, html`${parts}`);
      wireToolbar();
      if (isGame) renderTargets();
    }

    function wireToolbar() {
      const search = toolbarEl.querySelector('#dl-search');
      if (search) {
        search.addEventListener(
          'input',
          debounce((e) => {
            keyword = e.target.value;
            if (category === 'game') renderBody();
          }, 220)
        );
        search.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            keyword = e.target.value;
            if (category === 'game') renderBody();
            else loadContent(true);
          }
        });
      }
      const mcver = toolbarEl.querySelector('#dl-mcver');
      if (mcver) {
        mcver.addEventListener(
          'input',
          debounce((e) => {
            mcVersion = e.target.value.trim();
            // ★ 玩家手动改了版本 → 不再跟随当前实例（否则会被自动值覆盖回去）
            followInstance = false;
          }, 260)
        );
        mcver.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            mcVersion = e.target.value.trim();
            loadContent(true);
          }
        });
      }
      const ld = toolbarEl.querySelector('#dl-loader');
      if (ld) {
        ld.addEventListener('change', (e) => {
          loader = e.target.value;
          followInstance = false; // 手动改加载器 → 不再跟随实例
          if (category !== 'game') loadContent(true);
        });
      }
      /* 一键恢复「跟随当前实例」（玩家改过筛选后想切回来） */
      const followBtn = toolbarEl.querySelector('#dl-follow');
      if (followBtn) {
        followBtn.addEventListener('click', () => {
          const inst = currentInstance();
          if (!inst) return;
          mcVersion = inst.mcVersion || '';
          loader = (inst.loader && inst.loader.type) || 'vanilla';
          followInstance = true;
          renderToolbar();
          loadContent(true);
        });
      }
      const doSearch = toolbarEl.querySelector('#dl-do-search');
      if (doSearch) {
        doSearch.addEventListener('click', () => {
          const s = toolbarEl.querySelector('#dl-search');
          const m = toolbarEl.querySelector('#dl-mcver');
          keyword = s ? s.value : keyword;
          mcVersion = m ? m.value.trim() : mcVersion;
          loadContent(true);
        });
      }
      // 下载源切换：换源后立刻重新搜索（从第一页开始）
      const srcGroup = toolbarEl.querySelector('#dl-sources');
      if (srcGroup) {
        srcGroup.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-src]');
          if (!btn || btn.dataset.src === source) return;
          source = btn.dataset.src;
          const s = toolbarEl.querySelector('#dl-search');
          const m = toolbarEl.querySelector('#dl-mcver');
          if (s) keyword = s.value;
          if (m) mcVersion = m.value.trim();
          renderToolbar();
          loadContent(true);
        });
      }
    }

    /* ---------------- 目标实例下拉 ---------------- */
    function renderTargets() {
      const targetSel = toolbarEl.querySelector('#dl-target');
      if (!targetSel) return;
      const cur = currentInstance();
      if (state.instances.length === 0) {
        setHTML(targetSel, html`<option value="">（还没有实例，安装时会自动新建）</option>`);
        return;
      }
      setHTML(
        targetSel,
        html`${state.instances.map(
          (i) => raw(`<option value="${i.id}"${cur && cur.id === i.id ? ' selected' : ''}>${i.name}</option>`)
        )}`
      );
    }

    /* ============================ 二级分页 ============================ */

    function renderSubtabs() {
      if (category !== 'game') {
        setHTML(subtabsEl, raw(''));
        subtabsEl.hidden = true;
        return;
      }
      subtabsEl.hidden = false;
      setHTML(
        subtabsEl,
        html`<div class="segmented" id="dl-game-tabs">
          ${GAME_TABS.map(
            (t) => raw(`<button class="segmented__item ${t.id === gameTab ? 'is-active' : ''}" type="button" data-t="${t.id}">${t.label}</button>`)
          )}
        </div>`
      );
    }

    /* ============================ 卡片 ============================ */

    /** 游戏版本卡片（正式版 / 快照 / 愚人节 / 远古 通用） */
    function gameCard(v, extraBadge) {
      const typeLabel = v.type ? versionTypeLabel(v.type) : '';
      const badge = extraBadge || typeLabel;
      // 愚人节版本的 foolTitle 是后端给的中文彩蛋名（例如「15w14a · 爱与拥抱」），有就显示
      const fool = v.foolTitle ? String(v.foolTitle) : '';
      /**
       * 愚人节清单有两个来源（后端字段 `source`）：
       *   · 'manifest' —— 在官方版本清单里能找到的（有 sha1）→ 标「官方」
       *   · 'archive'  —— 只在内置归档里的（如 2013 的 Minecraft 2.0 三色版，sha1 为 null）→ 标「归档」
       * ★ 不要按 releaseTime 硬编码过滤（归档那 3 条写的是 2013-03-20），直接显示后端给的日期。
       */
      const srcTag =
        extraBadge === '愚人节版本' && (v.source === 'manifest' || v.source === 'archive')
          ? v.source === 'archive'
            ? '归档'
            : '官方'
          : '';
      return html`<article class="dlcard dlcard--version" data-id="${v.id}">
        ${iconBox('./assets/icon/ic_grass.png', 'grass')}
        <div class="dlcard__main">
          <div class="dlcard__title" title="${v.id}${fool ? ' · ' + fool : ''}">${v.id}</div>
          ${fool ? html`<div class="dlcard__author" title="${fool}">${fool}</div>` : raw('')}
          <div class="dlcard__meta">
            ${badge ? html`<span class="badge badge--accent">${badge}</span>` : raw('')}
            ${srcTag ? html`<span class="badge">${srcTag}</span>` : raw('')}
            <span>${v.releaseTime ? String(v.releaseTime).slice(0, 10) : '时间未知'}</span>
            ${extraBadge && typeLabel ? html`<span class="badge">${typeLabel}</span>` : raw('')}
          </div>
        </div>
        <div class="dlcard__actions">
          <button class="btn btn--sm" data-act="install" type="button">${raw(icon('install', 14))}安装</button>
        </div>
      </article>`;
    }

    /** 内容项目卡片（整合包 / 模组 / 资源包 / 光影 / 世界 / 收藏 通用） */
    function projectCard(p) {
      const cat = catOf(category);
      const glyph = cat.icon || 'pack';
      const dl = fmtCount(p.downloads);
      const isFav = favIds.has(String(p.id));
      const tags = (p.gameVersions || []).slice(0, 2).map((g) => `<span class="badge">${g}</span>`).join('');
      return html`<article class="dlcard dlcard--project" data-id="${p.id}" title="${p.summary || p.name}">
        ${iconBox(p.iconUrl, glyph)}
        <div class="dlcard__main">
          <div class="dlcard__title">${p.name}</div>
          <div class="dlcard__author">${p.author}</div>
          <div class="dlcard__meta">
            ${sourceBadge(p.source)}
            ${raw(tags)}
            ${dl ? html`<span>${dl} 次下载</span>` : raw('')}
          </div>
        </div>
        <div class="dlcard__actions">
          <button class="btn btn--ghost btn--sm dlcard__fav ${isFav ? 'is-on' : ''}" data-act="fav" type="button" title="${isFav ? '取消收藏' : '收藏'}">
            ${raw(icon('star', 14))}
          </button>
          <button class="btn btn--sm" data-act="install" type="button">${raw(icon('install', 14))}安装</button>
        </div>
      </article>`;
    }

    /* ============================ 列表渲染 ============================ */

    function gameEntries() {
      if (gameTab === 'ancient') return (ancient || []).slice();
      if (gameTab === 'april') return (april || []).slice();
      const all = (manifest && manifest.versions) || [];
      return all.filter((v) => (gameTab === 'snapshot' ? v.type === 'snapshot' : v.type === 'release'));
    }

    function renderGameBody() {
      const all = gameEntries();
      const kw = keyword.trim().toLowerCase();
      const items = (kw ? all.filter((v) => String(v.id).toLowerCase().includes(kw)) : all).slice(0, 400);

      if (gameLoading) {
        countEl.textContent = '正在拉取版本清单…';
        setHTML(listEl, skeletonRows(6, true));
        setHTML(moreEl, raw(''));
        return;
      }

      const tabLabel = (GAME_TABS.find((t) => t.id === gameTab) || {}).label || '';
      if (gameTab === 'april' && aprilLoaded && all.length === 0) {
        countEl.textContent = '';
        /**
         * ★ 两种「空」要分开说，否则会骗用户：
         *   · aprilDegraded → 接口根本还没接上（后端在做）⇒「该功能正在接入」
         *   · 否则          → 接口通了但确实没有版本        ⇒「暂时没有愚人节版本」
         */
        setHTML(
          listEl,
          emptyState({
            iconName: 'clock',
            title: aprilDegraded ? '愚人节版本正在接入' : '暂时没有愚人节版本',
            desc: aprilDegraded
              ? '「愚人节版本」需要主进程的 versions:aprilFools 接口，后端正在接入。接好之后这里会自动出现清单，不用更新启动器。'
              : '接口已经能查到清单，但这次没有返回任何愚人节版本。稍后点右上角「重新拉取」再试。',
            actionHTML: '<button class="btn btn--sm" id="dl-retry" type="button">重新拉取</button>',
          })
        );
        const retry = listEl.querySelector('#dl-retry');
        if (retry)
          retry.addEventListener('click', () => {
            aprilLoaded = false;
            loadApril().then(() => renderBody());
          });
        setHTML(moreEl, raw(''));
        return;
      }

      if (all.length === 0) {
        countEl.textContent = '';
        setHTML(
          listEl,
          emptyState({
            iconName: gameTab === 'april' ? 'clock' : 'install',
            title: gameTab === 'april' ? '没有拿到愚人节版本清单' : '没有拿到版本清单',
            desc:
              gameTab === 'april'
                ? '「愚人节版本」这一栏需要主进程的 versions:aprilFools 接口。若刚更新完启动器，请稍后点「重新拉取」。'
                : gameTab === 'ancient'
                  ? '远古版本清单暂时取不到。主进程在无法访问网络时会回落到内置清单，请稍后重试。'
                  : '版本清单暂时取不到，请检查网络或切换下载源后重试。',
            actionHTML: '<button class="btn btn--sm" id="dl-retry" type="button">重新拉取</button>',
          })
        );
        const retry = listEl.querySelector('#dl-retry');
        if (retry) retry.addEventListener('click', () => loadGame(true));
        setHTML(moreEl, raw(''));
        return;
      }

      countEl.textContent = `共 ${all.length} 个${tabLabel}，显示 ${items.length} 个`;
      const badge = gameTab === 'ancient' ? '考古归档' : gameTab === 'april' ? '愚人节版本' : '';
      setHTML(listEl, html`${items.map((v) => gameCard(v, badge))}`);
      setHTML(moreEl, raw(''));
    }

    function renderContentBody() {
      const cat = catOf(category);
      if (category === 'favorites' && !contentLoaded) {
        setHTML(listEl, skeletonRows(4, true));
        return;
      }
      if (contentLoading && contentItems.length === 0) {
        countEl.textContent = '正在查询…';
        setHTML(listEl, skeletonRows(6, true));
        setHTML(moreEl, raw(''));
        return;
      }
      // ★ 优雅降级：接口没接上 / 出错 / 没数据，都显示「正在接入」，绝不留白、绝不抛错
      if (contentError || (!contentLoading && contentItems.length === 0)) {
        countEl.textContent = '';
        const isFav = category === 'favorites';
        setHTML(
          listEl,
          emptyState({
            iconName: cat.icon || 'pack',
            title: contentError || (isFav ? '还没有收藏任何项目' : `「${cat.label}」暂时没有内容`),
            desc: isFav
              ? '在「模组 / 整合包 / 资源包 / 光影 / 世界」里点卡片右侧的星星就能收藏，之后在这里统一查看。'
              : `${cat.desc || ''}这一类内容来自在线资源站，离线或资源站不可用时会查不到结果。`,
            actionHTML:
              '<button class="btn btn--sm" id="dl-retry-content" type="button">重新查询</button>',
          })
        );
        const retry = listEl.querySelector('#dl-retry-content');
        if (retry) retry.addEventListener('click', () => loadContent(true));
        setHTML(moreEl, raw(''));
        return;
      }

      countEl.textContent = `共 ${contentItems.length} 个项目${contentHasMore ? '（还有更多）' : ''}${
        mixedHint ? ' · 混合源只显示第一页，切换单一来源可继续翻页' : ''
      }`;
      setHTML(listEl, html`${contentItems.map((p) => projectCard(p))}`);
      setHTML(
        moreEl,
        contentHasMore
          ? html`<button class="btn btn--ghost btn--sm" id="dl-loadmore" type="button">加载更多</button>`
          : raw('')
      );
      const more = moreEl.querySelector('#dl-loadmore');
      if (more) more.addEventListener('click', () => loadContent(false));
    }

    function renderBody() {
      if (category === 'game') renderGameBody();
      else renderContentBody();
    }

    /* ============================ 数据加载 ============================ */

    async function loadGame(force = false) {
      gameLoading = true;
      renderBody();
      const [m, a] = await Promise.all([call('versions:manifest'), call('versions:ancient')]);
      if (m.ok && m.data && Array.isArray(m.data.versions)) manifest = m.data;
      if (a.ok && Array.isArray(a.data)) ancient = a.data;
      aprilLoaded = false;
      april = null;
      aprilDegraded = false;
      gameLoading = false;
      if (!m.ok && !force) toast(m.error || '版本清单拉取失败', 'warn', 5000);
      if (category === 'game') {
        if (gameTab === 'april') await loadApril();
        renderBody();
      }
    }

    /** 愚人节版本（后端新接口，失败只显示「正在接入」，不弹错） */
    async function loadApril() {
      if (aprilLoaded) return;
      aprilLoaded = true;
      // optional：后端还没接这个通道时只在页面里降级，不触发全局「主进程暂不可用」横幅
      const r = await call('versions:aprilFools', {}, { optional: true });
      if (!r.ok || !r.data) {
        april = [];
        aprilDegraded = true;
        // 不 toast 报错：这是「还没接上」而不是用户的错，界面里已有中文说明
        return;
      }
      aprilDegraded = false;
      april = asList(r.data)
        .map((v) => (typeof v === 'string' ? { id: v, type: 'april' } : v))
        .filter((v) => v && v.id);
    }

    /**
     * 拉取可用的下载源。
     * ★ 失败就悄悄退回只有「混合」的列表 + 隐藏切换器（用户要求：不要报错）。
     */
    async function loadSources() {
      const r = await call('content:sources', {}, { optional: true });
      const data = r.ok && r.data ? r.data : null;
      const raw = data ? (Array.isArray(data) ? data : Array.isArray(data.sources) ? data.sources : []) : [];
      const normalized = raw
        .map((s) =>
          typeof s === 'string'
            ? { id: s, name: s, desc: '' }
            : { id: String((s && s.id) || ''), name: (s && s.name) || String((s && s.id) || ''), desc: (s && s.desc) || '' }
        )
        .filter((s) => s.id);
      if (normalized.length > 0) {
        sources = normalized;
        sourcesDegraded = normalized.length <= 1;
      } else {
        sources = SOURCE_FALLBACK.slice();
        sourcesDegraded = true;
      }
      if (!sources.some((s) => s.id === source)) source = sources[0] ? sources[0].id : 'mixed';
      // 只重画工具条（不重新搜索，避免首屏多打一次请求）
      renderToolbar();
    }

    async function loadContent(reset = true) {
      if (reset) {
        contentOffset = 0;
        contentItems = [];
        contentError = '';
        contentQuery = keyword.trim();
        mixedHint = false;
      }
      contentLoading = true;
      renderBody();

      let r;
      if (category === 'favorites') {
        r = await call('content:favorites', {}, { optional: true });
        contentLoading = false;
        contentLoaded = true;
        if (!r.ok || !r.data) {
          contentError = '收藏功能正在接入';
          renderBody();
          return;
        }
        const list = asList(r.data).map(normProject).filter((p) => p && p.id);
        favIds = new Set(list.map((p) => String(p.id)));
        contentItems = list;
        contentHasMore = false;
        renderBody();
        return;
      }

      r = await call(
        'content:search',
        {
          projectType: catOf(category).projectType,
          query: contentQuery,
          mcVersion: mcVersion || '',
          loader: loader !== 'vanilla' ? loader : '',
          // ★ 下载源：'mixed' | 'modrinth' | 'curseforge'。后端还没支持时多传一个参数也无害
          source,
          limit: PAGE_SIZE,
          offset: contentOffset,
        },
        // 内容搜索走外网：网络不通时只在页面上降级，不要把整个启动器标成「主进程暂不可用」
        { optional: true }
      );
      contentLoading = false;
      contentLoaded = true;
      if (!r.ok || !r.data) {
        /**
         * 首次查询失败 → 整页中文降级说明；
         * 「加载更多」失败 → 只弹一条提示，**别把已经拿到的结果清掉**（否则用户看到列表突然消失）。
         */
        if (reset || contentItems.length === 0) {
          contentError = '该功能正在接入';
        } else {
          toast(`加载更多失败：${r.error || '请稍后重试'}`, 'warn', 4000);
        }
        renderBody();
        return;
      }
      const list = asList(r.data).map(normProject).filter((p) => p && p.id);
      contentItems = reset ? list : contentItems.concat(list);
      contentOffset += list.length;
      /**
       * ★ 混合源（mixed）是「两个源各自分页后合并去重」，offset 翻页会重复/漏（后端明确提醒），
       *   所以混合模式只给第一页、不提供「加载更多」；用户切到单一来源后才能继续翻页。
       */
      mixedHint = source === 'mixed' && list.length >= PAGE_SIZE;
      contentHasMore = source === 'mixed' ? false : list.length >= PAGE_SIZE;
      // 混合模式下单源挂掉不算整体失败，但要把后端给的 warning 透出来（仍然渲染已拿到的结果）
      if (reset && r.data && r.data.warning) toast(String(r.data.warning), 'warn', 7000);
      renderBody();
    }

      /* ============================ 安装 ============================ */

    /**
     * ★★★ 前置依赖：查出来 → 让玩家确认 → 返回要下载的清单（2026-11-05 新增）。
     *
     * 用户需求（原话）：
     *   「如果检测到这个模组有可安装前置和必须安装前置，都要提醒一下。
     *     如果是必须安装前置，提醒是否一起安装；
     *     如果玩家点不一起安装，然后会弹出你确定吗？
     *     这个模组缺少这个依赖可能会导致游戏无法正常运行或崩溃」
     *
     * @param {object} version   选中的版本（含 dependencies）
     * @param {object} project   项目
     * @param {object|null} inst 目标实例（取 mcVersion / loader）
     * @returns {Promise<Array|null>} 要下载的 items；玩家取消返回 null
     */
    async function pickDependenciesFor(version, project, inst) {
      const base = {
        id: project.id,
        versionId: version.id,
        label: `${project.name} ${version.versionNumber || ''}`.trim(),
      };

      const declared = Array.isArray(version.dependencies) ? version.dependencies : [];
      if (!declared.length) return [base];

      const mcVersion = (inst && inst.mcVersion) || '';
      const loader = (inst && inst.loader && inst.loader.type) || '';

      const r = await call('content:dependencies', { dependencies: declared, mcVersion, loader }, { optional: true });
      const dep = (r && r.data) || null;
      if (!dep) return [base];

      const required = Array.isArray(dep.required) ? dep.required : [];
      const optional = Array.isArray(dep.optional) ? dep.optional : [];
      const incompatible = Array.isArray(dep.incompatible) ? dep.incompatible : [];

      if (!required.length && !optional.length) {
        if (incompatible.length) {
          toast(`提示：这个版本与 ${incompatible.length} 个模组互斥，同时装可能冲突`, 'warn', 6000);
        }
        return [base];
      }

      const picked = await showDependencyDialog({ project, version, required, optional, mcVersion });
      if (picked === null) return null;

      // 玩家取消了「必须前置」→ 再确认一次
      const missingRequired = required.filter((d) => d.version && !picked.includes(depKey(d)));
      if (missingRequired.length) {
        const names = missingRequired.map((d) => d.title).join('、');
        const ok = await confirmDialog({
          title: '确定不装前置吗？',
          message:
            `你取消了 ${missingRequired.length} 个必须前置：\n\n${names}\n\n` +
            `这个模组缺少依赖可能会导致游戏无法正常运行或崩溃。\n确定还要继续安装吗？`,
          okText: '仍然安装',
          cancelText: '返回勾选',
          danger: true,
        });
        if (!ok) return pickDependenciesFor(version, project, inst);
      }

      const items = [base];
      for (const d of [...required, ...optional]) {
        if (!picked.includes(depKey(d))) continue;
        if (!d.version || !d.version.id) continue;
        items.push({
          id: d.projectId || d.version.id,
          versionId: d.version.id,
          label: `${d.title} ${d.version.versionNumber || ''}`.trim(),
        });
      }
      return items;
    }

    /** 依赖的唯一键 */
    function depKey(d) {
      return String((d && (d.projectId || (d.version && d.version.id))) || '');
    }

    /** 依赖选择弹窗 */
    function showDependencyDialog({ project, version, required, optional, mcVersion }) {
      return new Promise((resolve) => {
        const root = document.getElementById('modal-root');
        if (!root) {
          resolve(null);
          return;
        }
        root.hidden = false;
        root.innerHTML = '';

        const row = (d, kind) => {
          const key = depKey(d);
          const hasVer = !!(d.version && d.version.id);
          const file = hasVer && d.version.files && d.version.files[0] ? d.version.files[0].filename : '';
          const badge =
            kind === 'required' ? '<span class="badge badge--warn">必须安装</span>' : '<span class="badge">可选</span>';
          return `<label class="dep-row ${hasVer ? '' : 'is-missing'}">
            <input type="checkbox" data-dep="${escapeHtml(key)}" ${hasVer ? 'checked' : ''} ${hasVer ? '' : 'disabled'} />
            <span class="dep-row__icon">${d.iconUrl ? `<img src="${escapeHtml(d.iconUrl)}" alt="" />` : ''}</span>
            <span class="dep-row__main">
              <span class="dep-row__title">${escapeHtml(d.title)} ${badge}</span>
              <span class="dep-row__sub">${
                hasVer
                  ? escapeHtml(`${d.version.versionNumber || ''}${file ? ` · ${file}` : ''}`)
                  : escapeHtml(d.error || '找不到兼容版本')
              }</span>
            </span>
          </label>`;
        };

        const modal = document.createElement('div');
        modal.className = 'modal modal--deps';
        modal.innerHTML = `
          <div class="modal__head">
            <div class="modal__title">这个内容需要前置</div>
            <button class="winbtn" data-close type="button" title="关闭">${icon('close', 14)}</button>
          </div>
          <div class="modal__body">
            <div class="dep-intro">
              要安装 <strong>${escapeHtml(project.name)} ${escapeHtml(version.versionNumber || '')}</strong>
              ${mcVersion ? `（${escapeHtml(mcVersion)}）` : ''}，
              它依赖下面这些内容。<strong>建议全部一起装上</strong>，否则游戏可能报错或崩溃。
            </div>
            ${required.length ? `<div class="dep-group"><div class="dep-group__title">必须安装（${required.length}）</div>${required.map((d) => row(d, 'required')).join('')}</div>` : ''}
            ${optional.length ? `<div class="dep-group"><div class="dep-group__title">可选（${optional.length}）</div>${optional.map((d) => row(d, 'optional')).join('')}</div>` : ''}
          </div>
          <div class="modal__foot">
            <button class="btn btn--ghost" data-act="cancel" type="button">取消安装</button>
            <button class="btn btn--primary" data-act="ok" type="button">一起安装</button>
          </div>`;
        root.appendChild(modal);

        const finish = (val) => {
          root.hidden = true;
          root.innerHTML = '';
          resolve(val);
        };

        modal.querySelector('[data-close]').addEventListener('click', () => finish(null));
        modal.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
        modal.querySelector('[data-act="ok"]').addEventListener('click', () => {
          const checked = Array.from(modal.querySelectorAll('input[data-dep]:checked')).map((x) =>
            x.getAttribute('data-dep')
          );
          finish(checked);
        });
        modal.onmousedown = (e) => {
          if (e.target === modal) finish(null);
        };
      });
    }

    /** 游戏版本安装（原有流程，保持不动） */
    /**
     * ★★★ 安装前的加载器选择弹窗（2026-11-05 新增，用户要求）。
     *
     * 用户原话：「点那个安装是直接安装原版游戏，根本不会弹出让我们是否选择一个模组加载器？
     *          等于前面折腾的一堆模组之类的全白费」
     *
     * 确实如此：以前直接读工具栏的 `loader`（默认 vanilla），点安装就装原版，
     * 玩家根本不知道原来可以选加载器 —— 装了原版再想装模组就得重装。
     *
     * ⇒ 现在点「安装」先弹这个框，明确让玩家选：原版 / Fabric / Forge / NeoForge / OptiFine。
     *
     * @param {string} versionId  要安装的 MC 版本
     * @returns {Promise<{type:string, version?:string}|null>} null = 玩家取消
     */
    /** 解析主版本号：'1.12.2' → [1,12,2]；快照 / 远古 id → null */
    function mcTupleOf(id) {
      const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(id || ''));
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
    }

    /** 远古版本 id（ModLoader 时代：pre-classic / classic / indev / infdev / alpha / beta） */
    const ANCIENT_VERSION_RE = /^(rd-|pc-|c0\.|in[-d]|inf|a\d+\.\d|b\d+\.\d|pre-?classic|classic|indev|infdev|alpha|beta)/i;

    /**
     * ★★★ 按 MC 版本决定「推荐哪个加载器」（2026-11-05 用户明确要求）：
     *   用户原话：「1.14以下的就不能 Fabric 标推荐了，应该标 Forge。
     *             远古版本 ModLoader 和 Babric —— QCL 接入过他们两个」
     *
     *   · 远古（alpha/beta 那批）→ ModLoader；b1.7.3 另有 Babric（Fabric 分支）
     *   · 1.0 ~ 1.13.2          → Forge（Fabric 对老版本支持不全）
     *   · 1.14 及以后           → Fabric
     *
     * @returns {{primary:string, fallback:string, why:string}}
     */
    function pickRecommendedLoader(id) {
      const s = String(id || '');
      if (ANCIENT_VERSION_RE.test(s)) {
        if (/^b1\.7\.3/i.test(s)) {
          return {
            primary: 'babric',
            fallback: 'modloader',
            why: 'b1.7.3 推荐 Babric（Fabric 分支，能跑现代性能模组）；想装老 mod 就选 ModLoader',
          };
        }
        return {
          primary: 'modloader',
          fallback: 'babric',
          why: '远古版本没有 Fabric/Forge，只能装 ModLoader（或 Babric）',
        };
      }
      const t = mcTupleOf(s);
      if (t && (t[0] < 1 || (t[0] === 1 && t[1] < 14))) {
        return {
          primary: 'forge',
          fallback: 'fabric',
          why: '1.14 之前 Fabric 支持不全，推荐 Forge',
        };
      }
      return {
        primary: 'fabric',
        fallback: 'neoforge',
        why: '1.14 起 Fabric 生态最全、启动最快',
      };
    }

    function pickLoaderFor(versionId) {
      return new Promise((resolve) => {
        const root = document.getElementById('modal-root');
        if (!root) {
          resolve({ type: 'vanilla' });
          return;
        }
        root.hidden = false;
        root.innerHTML = '';

        /**
         * ★★★ 先异步查「这个 MC 版本能装哪个加载器版本」（2026-11-05）。
         *   查之前先渲染骨架（显示「查询中…」），拿到结果再补上版本号，
         *   避免玩家点开弹窗后半天看不到东西。
         */
        const REC = pickRecommendedLoader(versionId);
        const tup = mcTupleOf(versionId);
        const oldMc = !!(tup && tup[0] === 1 && tup[1] < 14);
        const isAncient = ANCIENT_VERSION_RE.test(String(versionId || ''));

        const OPTIONS = [
          {
            type: 'vanilla',
            label: '原版',
            badge: '不带模组',
            desc: '纯净的 Minecraft。想用模组就选下面某个加载器 —— 装完原版再换需要重装。',
          },
          {
            type: 'fabric',
            label: 'Fabric',
            badge: oldMc || isAncient ? '老版本支持不全' : '轻量',
            desc: oldMc || isAncient
              ? '启动快，但对 1.14 之前的版本覆盖很差，老版本基本没有对应的 Fabric 模组。'
              : '启动快、更新快，绝大多数优化模组（Sodium / Iris）都基于它。',
          },
          {
            type: 'forge',
            label: 'Forge',
            badge: oldMc || isAncient ? '老版本首选' : '模组最多',
            desc: '老牌加载器，整合包和大型模组生态最全。1.14 之前的版本几乎都靠它。',
          },
          {
            type: 'neoforge',
            label: 'NeoForge',
            badge: '新一代',
            desc: 'Forge 的分支，1.20.1 之后的主流选择，兼容大部分新模组。',
          },
          {
            type: 'quilt',
            label: 'Quilt',
            badge: '小众',
            desc: 'Fabric 的分支，兼容部分 Fabric 模组，生态较小。',
          },
          /* ---- 下面两个只在真支持时显示（远古版本专用，照安卓版 QCL 移植） ---- */
          {
            type: 'modloader',
            label: 'ModLoader',
            badge: '远古',
            desc: 'Risugami 的 ModLoader：把 class 直接注入游戏本体 jar。1.6.2 / Beta / Alpha 时代的标配。',
            opt: true,
          },
          {
            type: 'babric',
            label: 'Babric',
            badge: '远古 · Fabric 分支',
            desc: 'b1.7.3 专用的 Fabric 分支，能跑现代性能模组与 Mixin。',
            opt: true,
          },
          {
            type: 'optifine',
            label: 'OptiFine',
            badge: '光影优化',
            desc: '经典光影/优化模组。安装需要手动下载对应版本文件，启动器会给出指引。',
          },
        ];

        const modal = document.createElement('div');
        modal.className = 'modal modal--loader';
        modal.innerHTML = `
          <div class="modal__head">
            <div class="modal__title">安装 Minecraft ${escapeHtml(versionId)}</div>
            <button class="winbtn" data-close type="button" title="关闭（Esc）">${icon('close', 14)}</button>
          </div>
          <div class="modal__body">
            <div class="loader-intro">
              选一个<strong>模组加载器</strong>。<br />
              <span class="loader-intro__rec" data-rec-why>${escapeHtml(REC.why)}</span>
              <br />
              <span class="loader-intro__warn">
                ⚠ 装成「原版」之后想用模组，需要重新安装这个版本 —— 请先想好。
              </span>
            </div>
            <div class="loader-list">
              ${OPTIONS.map(
                (o) => `<button class="loader-item ${o.opt ? 'loader-item--off' : ''}" type="button" data-loader="${o.type}">
                  <span class="loader-item__main">
                    <span class="loader-item__title">
                      ${escapeHtml(o.label)}
                      <span class="badge" data-badge="${o.type}">${escapeHtml(o.badge)}</span>
                      <span class="loader-item__rec" data-rectag="${o.type}" hidden>推荐</span>
                      <span class="loader-item__ver" data-ver="${o.type}">${
                        o.type === 'vanilla' ? '' : '查询版本中…'
                      }</span>
                    </span>
                    <span class="loader-item__desc">${escapeHtml(o.desc)}</span>
                  </span>
                  <span class="loader-item__go">选择</span>
                </button>`
              ).join('')}
            </div>
            <div class="loader-hint">
              ★ 加载器版本会由启动器自动挑最新稳定版，一般不用管。
            </div>
          </div>
          <div class="modal__foot">
            <button class="btn btn--ghost" data-act="cancel" type="button">取消</button>
          </div>`;
        root.appendChild(modal);

        const finish = (val) => {
          root.hidden = true;
          root.innerHTML = '';
          document.removeEventListener('keydown', onKey, true);
          resolve(val);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            finish(null);
          }
        };
        document.addEventListener('keydown', onKey, true);

        /**
         * ★ 每个加载器列出该 Minecraft 版本能用的最新稳定版本号。
         *   玩家以前只能选「Fabric」不知道会装哪个版本，现在直接告诉他。
         *   verMap[type] = { latest, total } / null（查不到/不支持）/ undefined（查询中）
         */
        const verMap = Object.create(null);
        const verWait = Object.create(null);

        const paintVer = (type) => {
          const el = modal.querySelector(`[data-ver="${type}"]`);
          if (!el) return;
          const info = verMap[type];
          if (info === undefined) {
            el.textContent = '查询版本中…';
            el.className = 'loader-item__ver is-loading';
            return;
          }
          if (!info || (!info.latest && !info.label)) {
            const names = {
              neoforge: 'NeoForge',
              fabric: 'Fabric',
              forge: 'Forge',
              quilt: 'Quilt',
              babric: 'Babric',
              modloader: 'ModLoader',
            };
            el.textContent = `该版本没有 ${names[type] || '可用版本'}`;
            el.className = 'loader-item__ver is-none';
            return;
          }
          if (info.label) {
            el.textContent = info.label;
            el.className = 'loader-item__ver is-ok';
            return;
          }
          el.textContent = `最新 ${info.latest}${info.total > 1 ? ` · 共 ${info.total} 个` : ''}`;
          el.className = 'loader-item__ver is-ok';
        };

        /** 真正可用的加载器（没查到 / 查不到都算不可用，但查询中不算否定） */
        const isAvail = (type) => {
          if (type === 'vanilla') return true;
          const info = verMap[type];
          if (info === undefined) return true;
          return !!info;
        };

        const isShown = (type) => {
          const row = modal.querySelector(`[data-loader="${type}"]`);
          return !!row && !row.classList.contains('loader-item--off');
        };

        /** ⭐ 把「推荐」标在当前最合适的那个上 */
        const setRec = (type) => {
          modal.querySelectorAll('[data-rectag]').forEach((tag) => {
            const on = tag.getAttribute('data-rectag') === type;
            tag.hidden = !on;
          });
          modal.querySelectorAll('[data-badge]').forEach((b) => {
            const on = b.getAttribute('data-badge') === type;
            b.classList.toggle('badge--accent', on);
          });
          modal.querySelectorAll('[data-loader]').forEach((row) => {
            row.classList.toggle('is-rec', row.getAttribute('data-loader') === type);
          });
        };

        const applyRec = () => {
          const cands = [REC.primary, REC.fallback].filter(Boolean);
          for (const t of cands) {
            if (isShown(t) && isAvail(t)) {
              setRec(t);
              return;
            }
          }
          setRec('vanilla');
          // 远古版本两个老加载器都没有（ModLoader 只发了 .rar 的那些）→ 如实告诉玩家
          if (REC.primary !== 'vanilla') {
            const whyEl = modal.querySelector('[data-rec-why]');
            if (whyEl) {
              whyEl.textContent = '这个版本没有可用的 ModLoader / Babric 包，只能装原版。';
              whyEl.classList.add('is-warn');
            }
          }
        };

        const loadVer = (type) => {
          // 后端返回 { [type]: { versions, latest, error } }；modloader 多 available/label
          const p = call('loader:versions', { mcVersion: versionId, loader: type }, { optional: true })
            .then((res) => {
              const data = res && res.ok !== false ? res.data || res : null;
              const slot = (data && data[type]) || null;
              const arr = (slot && Array.isArray(slot.versions) && slot.versions) || [];
              if (type === 'modloader') {
                verMap[type] = slot && slot.available
                  ? { latest: null, total: 0, label: slot.label || 'ModLoader' }
                  : null;
              } else {
                verMap[type] = arr.length ? { latest: slot.latest || arr[0], total: arr.length } : null;
              }
            })
            .catch(() => {
              verMap[type] = null;
            })
            .then(() => {
              // ★ 查完才知道远古版本到底有没有 ModLoader / Babric → 这时才决定显示与否
              const row = modal.querySelector(`[data-loader="${type}"]`);
              if (row && (type === 'modloader' || type === 'babric')) {
                row.classList.toggle('loader-item--off', !isAvail(type));
              }
              paintVer(type);
              applyRec();
            });
          verWait[type] = p;
          return p;
        };

        setRec(''); // 先清空，等查完再标
        OPTIONS.forEach((o) => {
          if (o.type === 'vanilla') return;
          // OptiFine 没有公开版本 API，跳过查询
          if (o.type === 'optifine') {
            verMap[o.type] = null;
            paintVer(o.type);
            return;
          }
          loadVer(o.type);
        });

        modal.querySelectorAll('[data-loader]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const type = btn.getAttribute('data-loader');
            if (type === 'vanilla') {
              finish({ type: 'vanilla' });
              return;
            }
            // 还在查版本就等一下，别让玩家选了个没有版本号的加载器
            if (verWait[type]) {
              btn.classList.add('is-busy');
              try {
                await verWait[type];
              } catch (e) {
                /* 查询失败也用 undefined 继续，后端会自己挑 */
              }
              btn.classList.remove('is-busy');
            }
            const info = verMap[type];
            // ModLoader 没有「加载器版本」这个概念（它自己就一个包），只回类型
            const ver = type === 'modloader' ? undefined : (info && info.latest) || undefined;
            finish({ type, version: ver });
          });
        });
        modal.querySelector('[data-close]').addEventListener('click', () => finish(null));
        modal.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
        modal.onmousedown = (e) => {
          if (e.target === modal) finish(null);
        };
      });
    }

    async function installGameVersion(versionId) {
      /**
       * ★ 先让玩家选加载器（原版 / Fabric / Forge / NeoForge / …）。
       *   以前直接用工具栏的值（默认 vanilla），点安装就装原版 —— 用户明确反对。
       */
      const chosen = await pickLoaderFor(versionId);
      if (!chosen) return; // 玩家取消

      // 玩家在弹窗里看到的加载器版本号，原样交给后端（没查到就不传，后端自己挑最新）
      const loaderObj =
        chosen.type && chosen.type !== 'vanilla'
          ? { type: chosen.type, ...(chosen.version ? { version: chosen.version } : {}) }
          : null;

      const targetSel = toolbarEl.querySelector('#dl-target');
      let targetId = (targetSel && targetSel.value) || (currentInstance() && currentInstance().id) || '';
      let targetName = '';
      if (!targetId) {
        // 还没有实例：先建一个（用版本号当实例名），再装
        const instName = chosen.type === 'vanilla' ? versionId : `${versionId}-${chosen.type}`;
        const created = await call('instances:create', {
          name: instName,
          mcVersion: versionId,
          loader: loaderObj
        });
        if (!created.ok && !created.data) {
          toast(created.error || '创建实例失败', 'error', 6000);
          return;
        }
        const inst = created.data;
        targetId = inst && inst.id ? inst.id : '';
        targetName = (inst && inst.name) || instName;
        await loadInstances();
        notify('instances');
        renderTargets();
      } else {
        const inst = state.instances.find((x) => x.id === targetId);
        targetName = (inst && inst.name) || targetId;
      }

      // ★ loader 必须是对象 { type, version }：主进程 install.js 读 loader.version
      const payload = { id: targetId, mcVersion: versionId };
      if (loaderObj) payload.loader = loaderObj;

      const r = await call('install:start', payload);
      if (!r.ok && (!r.data || !r.data.taskId)) {
        toast(r.error || '安装启动失败', 'error', 6000);
        return;
      }
      const taskId = (r.data && r.data.taskId) || `本地-${Date.now()}`;
      TASKS.set(taskId, {
        taskId,
        versionId,
        instanceName: targetName,
        stage: '已提交安装请求',
        current: 0,
        total: 0,
        startedAt: Date.now(),
      });
      renderTasks();
      toast(`已开始安装 ${versionId} → 「${targetName}」`, 'ok', 3200);
    }

    /** 内容项目安装：先选版本，再提交下载安装 */
    async function openProjectInstall(project) {
      const r = await call('content:versions', {
        id: project.id,
        mcVersion: mcVersion || '',
        loader: loader !== 'vanilla' ? loader : '',
        source,
      }, { optional: true });

      const modal = document.getElementById('modal-root');
      const versions = r.ok && r.data ? asList(r.data).map(normVersion).filter(Boolean) : [];
      const degraded = !r.ok || !r.data;

      const listHTML = degraded
        ? `<div class="dlmodal__tip">该功能正在接入 —— 主进程的 content:versions 还没就绪。</div>`
        : versions.length === 0
          ? `<div class="dlmodal__tip">这个项目在当前筛选条件下没有可用版本。</div>`
          : versions
              .slice(0, 60)
              .map(
                (v, i) => `<button class="dlmodal__ver" type="button" data-vidx="${i}">
                  <span class="dlmodal__vername">${escapeHtml(v.name)}</span>
                  <span class="dlmodal__vermeta">${escapeHtml((v.gameVersions || []).slice(0, 2).join(' · ') || '版本未知')}</span>
                  <span class="btn btn--sm">安装</span>
                </button>`
              )
              .join('');

      // 复用 ui 的 openModal 会丢掉自定义交互，这里直接往 #modal-root 里画（与启动窗口同套路）
      if (!modal) return;
      modal.hidden = false;
      modal.innerHTML = `<div class="modal modal--wide">
        <div class="modal__head">
          <div class="modal__title">安装「${escapeHtml(project.name)}」</div>
          <button class="winbtn" data-close type="button" title="关闭">✕</button>
        </div>
        <div class="modal__body">
          <div class="dlmodal__head">
            ${project.iconUrl ? `<span class="dlcard__icon"><img src="${escapeHtml(project.iconUrl)}" alt="" /></span>` : ''}
            <div class="dlcard__main">
              <div class="dlcard__title">${escapeHtml(project.name)}</div>
              <div class="dlcard__author">${escapeHtml(project.author || '作者未知')}</div>
              <div class="sourcetip">${escapeHtml(String(project.summary || '').slice(0, 200))}</div>
            </div>
          </div>
          <div class="dlmodal__vers">${listHTML}</div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close type="button">关闭</button>
        </div>
      </div>`;

      const close = () => {
        modal.hidden = true;
        modal.innerHTML = '';
      };
      modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      // 用 onmousedown 赋值而不是 addEventListener：modal-root 是常驻节点，
      // 每开一次详情就 addEventListener 会叠加一堆一次性监听（内存泄漏 + 重复 close）
      modal.onmousedown = (e) => {
        if (e.target === modal) close();
      };
      modal.querySelectorAll('[data-vidx]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const v = versions[Number(btn.dataset.vidx)];
          if (!v) return;

          /**
           * ★★★ 前置依赖检测与提醒（2026-11-05 新增，用户明确要求）。
           *
           * 用户原话：
           *   「如果检测到这个模组有可安装前置和必须安装前置，都要提醒一下。
           *     如果是必须安装前置，提醒是否一起安装；
           *     如果玩家点不一起安装，然后会弹出你确定吗？
           *     这个模组缺少这个依赖可能会导致游戏无法正常运行或崩溃」
           *
           * 流程：① 查前置 → ② 弹勾选窗（默认全勾）→
           *       ③ 若玩家取消必须前置，再确认一次 → ④ 一起下载；没前置则直接下。
           */
          const cur = currentInstance();
          const chosen = await pickDependenciesFor(v, project, cur);
          if (chosen === null) return; // 玩家取消

          let inst = await call('content:downloadMany', {
            items: chosen,
            instId: cur ? cur.id : '',
            projectType: catOf(category).projectType || '',
            source,
          }, { optional: true });
          if (!inst.ok || !inst.data) {
            // 兜底：老通道，只装主文件
            inst = await call('content:download', {
              id: project.id,
              versionId: v.id,
              instId: cur ? cur.id : '',
              projectType: catOf(category).projectType || '',
              source,
            }, { optional: true });
          }
          if (!inst.ok || !inst.data) {
            toast('安装接口暂时不可用，请稍后重试', 'warn', 5000);
            return;
          }
          /**
           * ★ 进度事件的 taskId 由主进程生成，可能**在返回之前**就已经推了几条 task:progress；
           *   直接覆盖会把这些进度抹掉，所以先合并已有记录。
           */
          const taskId = String((inst.data && (inst.data.taskId || inst.data.id)) || `内容-${Date.now()}`);
          const prev = TASKS.get(taskId);
          TASKS.set(taskId, {
            ...(prev || {}),
            taskId,
            versionId: `${project.name} · ${v.name}`,
            instanceName: cur ? cur.name : '',
            file: (inst.data && inst.data.filename) || (prev && prev.file) || '',
            stage: (prev && prev.stage) || '已提交安装请求',
            current: (prev && prev.current) || 0,
            total: (prev && prev.total) || 0,
            startedAt: (prev && prev.startedAt) || Date.now(),
          });
          renderTasks();
          toast(
            inst.data && inst.data.filename
              ? `已下载「${inst.data.filename}」`
              : `已开始安装「${project.name}」`,
            'ok',
            3600
          );
          close();
        });
      });
    }

    /* ============================ 收藏 ============================ */

    async function toggleFavorite(project) {
      const id = String(project.id);
      const on_ = favIds.has(id);
      /**
       * ★ 主进程 `content:addFavorite` 的入参是 `{ item }`（不是散开的字段），
       *   而且它只挑 id / title / slug / author / projectType / iconUrl / downloads / versions，
       *   所以这里按它的字段名打包一份，别指望它认识 name/summary。
       */
      const item = {
        id: project.id,
        slug: project.slug || '',
        title: project.name,
        name: project.name,
        author: project.author,
        projectType: catOf(category).projectType || '',
        iconUrl: project.iconUrl,
        downloads: project.downloads,
        versions: project.gameVersions || [],
      };
      const r = on_
        ? await call('content:removeFavorite', { id: project.id })
        : await call('content:addFavorite', { item });
      if (!r.ok || r.data === false) {
        toast('收藏功能正在接入，暂时无法保存', 'warn', 4000);
        return;
      }
      if (on_) favIds.delete(id);
      else favIds.add(id);
      if (category === 'favorites') {
        contentItems = contentItems.filter((p) => String(p.id) !== id);
        renderBody();
      } else {
        renderBody();
      }
      toast(on_ ? '已取消收藏' : `已收藏「${project.name}」`, 'ok', 2200);
    }

    /* ============================ 任务列表 ============================ */

    function renderTasks() {
      const list = Array.from(TASKS.values()).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
      tasksBarEl.classList.toggle('is-empty', list.length === 0);
      if (list.length === 0) {
        setHTML(
          tasksEl,
          html`<div class="sourcetip">还没有安装任务。点卡片右侧「安装」后，这里会显示真实进度（可取消）。</div>`
        );
        return;
      }
      setHTML(
        tasksEl,
        html`${list.map((t) => {
          const p = pct(t);
          const done = !!t.done;
          return html`<div class="taskline" data-task="${t.taskId}">
            <div class="taskline__top">
              <span class="taskline__name">${t.versionId || '安装任务'}</span>
              <span class="taskline__stage">${t.error ? t.error : done ? '已完成' : t.stage || '准备中'}</span>
              <span class="taskline__pct">${done && !t.error ? '100%' : `${p}%`}</span>
            </div>
            <div class="progress ${t.total ? '' : 'progress--indeterminate'}">
              <div class="progress__bar" style="width:${done && !t.error ? 100 : p}%"></div>
            </div>
            <div class="taskline__bottom">
              <span class="taskline__file">${t.file || ''}</span>
              <span>${t.total ? `${t.current || 0} / ${t.total}` : ''}</span>
              <span>${fmtSpeed(t.speed)}</span>
              ${done
                ? html`<button class="btn btn--ghost btn--sm" data-act="clear" type="button">移除</button>`
                : html`<button class="btn btn--ghost btn--sm" data-act="cancel" type="button">取消</button>`}
            </div>
          </div>`;
        })}`
      );
    }

    tasksEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('[data-task]');
      if (!btn || !row) return;
      const taskId = row.dataset.task;
      if (btn.dataset.act === 'clear') {
        TASKS.delete(taskId);
        renderTasks();
        return;
      }
      const r = await call('install:cancel', { taskId });
      if (!r.ok) {
        toast(r.error || '取消失败', 'error');
        return;
      }
      toast('已请求取消该安装任务', 'info');
      const t = TASKS.get(taskId);
      if (t) {
        t.done = true;
        t.stage = '已取消';
        renderTasks();
      }
    });

    const onTasks = () => renderTasks();
    document.addEventListener('qcl:tasks', onTasks);

    /* ============================ 交互绑定 ============================ */

    catsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn || !catsEl.contains(btn)) return;
      const next = btn.dataset.cat;
      if (next === category) return;
      category = next;
      keyword = '';
      contentLoaded = false;
      contentItems = [];
      contentError = '';
      contentHasMore = false;
      renderCats();
      renderToolbar();
      renderSubtabs();
      if (scrollEl) scrollEl.scrollTop = 0;
      if (category === 'game') {
        renderBody();
        if (!manifest && !ancient) loadGame(false);
      } else {
        loadContent(true);
      }
    });

    subtabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-t]');
      if (!btn) return;
      gameTab = btn.dataset.t;
      renderSubtabs();
      if (gameTab === 'april') {
        /**
         * ★ 愚人节清单是单独一次 IPC，不能等它回来再重画 ——
         *   否则点下去之后列表还挂着上一栏（正式版 103 条）的卡片，用户以为切失败了。
         *   ⇒ 先无条件清成骨架屏，拉回来再渲染。
         */
        setHTML(listEl, skeletonRows(6, true));
        setHTML(moreEl, raw(''));
        countEl.textContent = '正在拉取愚人节版本…';
        loadApril().then(() => renderBody());
      } else {
        renderBody();
      }
    });

    listEl.addEventListener('click', (e) => {
      const favBtn = e.target.closest('[data-act="fav"]');
      const installBtn = e.target.closest('[data-act="install"]');
      const card = e.target.closest('[data-id]');
      if (!card) return;
      const id = card.dataset.id;

      if (favBtn) {
        const project =
          contentItems.find((p) => String(p.id) === String(id)) || normProject({ id, name: id });
        toggleFavorite(project);
        return;
      }
      if (!installBtn) return;

      if (category === 'game') {
        installGameVersion(id);
        return;
      }
      const project =
        contentItems.find((p) => String(p.id) === String(id)) || normProject({ id, name: id });
      openProjectInstall(project);
    });

    mount.querySelector('#dl-reload').addEventListener('click', () => {
      TASKS.clear();
      renderTasks();
      manifest = null;
      ancient = null;
      april = null;
      aprilLoaded = false;
      aprilDegraded = false;
      contentLoaded = false;
      contentItems = [];
      contentError = '';
      if (category === 'game') {
        loadGame(true);
        toast('正在重新拉取版本清单…', 'info', 2000);
      } else {
        loadContent(true);
        toast('正在重新查询…', 'info', 2000);
      }
    });

    /* ============================ 首屏 ============================ */

    renderCats();
    renderToolbar();
    renderSubtabs();
    renderTasks();
    // 下载源清单（拿不到就保持「只有混合」并隐藏切换器，不打扰用户）
    void loadSources();
    await loadGame();

    return {
      destroy() {
        document.removeEventListener('qcl:tasks', onTasks);
      },
    };
  },
};

/** 模态框里拼字符串用的转义（不走 ui.esc 是为了避免再 import 一个名字进来） */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default downloadPage;
