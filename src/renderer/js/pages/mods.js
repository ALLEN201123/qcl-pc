/**
 * QCL 电脑版 · 模组管理（模组 / 资源包 / 光影 / 数据包 / 世界）
 *
 * ## 为什么这么写
 * 用户要求「HMCL 有的、我们缺的，全部移过来」。手机版和旧 PC 版只做了
 * 模组 / 资源包 / 世界三个清单，缺：
 *   · **光影**（`shaderpacks/`）与 **数据包**（`datapacks/`）两个 tab
 *   · **真正能用的存档管理**（HMCL 的 WorldListPage：备份 / 恢复 / 导出 / 删除 / 打开目录 / 详情）
 *   · **模组更新检查**
 *
 * ## 启用 / 禁用 / 删除 的规则（照 HMCL）
 *   · 启用 ⇄ 禁用：只改文件名后缀 `.zip` / `.jar` ⇄ `.zip.disabled` / `.jar.disabled`，不动内容
 *   · 删除：移到 `<QCL_HOME>/recycle/`，可找回，不直接删
 *
 * ## 事件只绑一次
 * ★ 旧实现每次切 tab 都 `mount.addEventListener(...)` 一遍，切 5 次后点一次「删除」会弹 5 个确认框。
 *   现在所有点击统一委托到 `#mods-content` 的父容器 `mount`，**只在页面渲染时绑一次**。
 *
 * ## 后端契约（backend-dev 并行实现）
 *   `worlds:list({id})` / `worlds:detail` / `worlds:backup` / `worlds:backups` /
 *   `worlds:restore` / `worlds:export` / `worlds:delete` / `worlds:open`
 *   `mods:shaderPacks({id})` / `mods:dataPacks({id})`（与已有 `mods:resourcePacks` 同构）
 *   `mods:checkUpdates({id})` → `{ checked, items:[{fileName,name,current,latest,downloadUrl,sha1,size}] }`
 *
 * ★ 这些通道**全部**走 `call(channel, payload, { optional: true })`：
 *   后端没就绪时只在页面里显示中文空状态，绝不弹「主进程暂不可用」横幅。
 *   万一 `worlds:list` 还没接上，会退回旧的 `mods:worlds`，存档页仍然可用。
 */

import {
  html,
  setHTML,
  raw,
  toast,
  emptyState,
  fmtBytes,
  fmtRelative,
  confirmDialog,
  openModal,
  skeletonRows,
} from '../ui.js';
import { call } from '../bridge.js';
import { state } from '../store.js';
import { icon } from '../icons.js';

/** 五个标签页 */
const TABS = [
  { id: 'mods', label: '模组', icon: 'pack' },
  { id: 'packs', label: '资源包', icon: 'palette' },
  { id: 'shaders', label: '光影', icon: 'bolt' },
  { id: 'datapacks', label: '数据包', icon: 'file' },
  { id: 'worlds', label: '世界', icon: 'earth' },
];

/** 当前选中的标签（跨页面切换记忆） */
let activeTab = 'mods';

/** 页面上下文：只在页面渲染时设置一次，事件处理里读它 */
const ctx = { mount: null, instanceId: '' };

/** 游戏模式数字 → 中文 */
const GAME_MODE = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' };

function gameModeLabel(v) {
  if (v == null || v === '') return '未知';
  if (typeof v === 'number') return GAME_MODE[v] || `未知（${v}）`;
  const s = String(v);
  if (/^\d+$/.test(s)) return GAME_MODE[Number(s)] || `未知（${s}）`;
  return s;
}

/** 时间戳 / ISO → 「3 天前」；没有就「未知」 */
function relTime(ts) {
  if (!ts) return '未知';
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return String(ts);
  return fmtRelative(n);
}

/** 把旧版 `mods:worlds` 返回的存档映射成 `worlds:list` 的形状 */
function mapLegacyWorlds(list) {
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return (list || []).map((w) => {
    const folder = w.folder || base(w.path) || String(w.name || '');
    return {
      folder,
      name: w.name || folder || '未命名存档',
      version: w.version || '',
      sizeBytes: w.sizeBytes || 0,
      lastPlayed: w.lastPlayed || null,
      hasIcon: !!w.hasIcon,
      _legacy: true,
    };
  });
}

export const modsPage = {
  id: 'mods',
  title: '模组管理',
  render(mount) {
    const instances = state.instances || [];
    if (!instances.length) {
      setHTML(
        mount,
        html`<div class="page page--mods">
          <div class="page__head"><div class="page__title">模组管理</div></div>
          ${emptyState({
            iconName: 'pack',
            title: '还没有实例',
            desc: '先去「下载」装一个版本，再回来管理模组、光影、数据包与存档。',
          })}
        </div>`
      );
      return;
    }

    const currentId = state.settings.selectedInstance || instances[0].id;
    const inst = instances.find((x) => x.id === currentId) || instances[0];
    ctx.mount = mount;
    ctx.instanceId = inst.id;

    setHTML(
      mount,
      html`<div class="page page--mods">
        <div class="page__head">
          <div class="page__title">模组管理</div>
          <div class="page__sub">模组 / 资源包 / 光影 / 数据包 / 世界 —— 从文件里读真实名称与图标，不是只显示文件名</div>
        </div>

        <div class="mods-bar">
          <label class="field__label" for="mods-instance">实例</label>
          <select class="select" id="mods-instance">
            ${instances.map(
              (x) => html`<option value="${x.id}" ${x.id === inst.id ? 'selected' : ''}>${x.name}（${x.mcVersion}）</option>`
            )}
          </select>
          <div class="mods-tabs" id="mods-tabs">
            ${TABS.map(
              (t) =>
                raw(`<button class="segmented__item ${activeTab === t.id ? 'is-active' : ''}" type="button" data-tab="${t.id}">${t.label}</button>`)
            )}
          </div>
        </div>

        <div id="mods-content"></div>
      </div>`
    );

    const selectEl = mount.querySelector('#mods-instance');
    if (selectEl) {
      selectEl.addEventListener('change', () => {
        ctx.instanceId = selectEl.value;
        loadTab();
      });
    }
    mount.querySelector('#mods-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn || !TABS.some((t) => t.id === btn.dataset.tab)) return;
      activeTab = btn.dataset.tab;
      mount.querySelectorAll('#mods-tabs .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      loadTab();
    });

    // ★ 点击统一委托，且**只绑这一次**（旧实现每切一次 tab 就多叠一层监听）
    mount.addEventListener('click', onActionClick);

    loadTab();
  },
};

/* ============================ 内容渲染 ============================ */

async function loadTab() {
  const mount = ctx.mount;
  if (!mount) return;
  const box = mount.querySelector('#mods-content');
  if (!box) return;
  setHTML(box, html`<div>${skeletonRows(4, true)}</div>`);

  if (activeTab === 'packs') return loadAddons(box, 'packs');
  if (activeTab === 'shaders') return loadAddons(box, 'shaders');
  if (activeTab === 'datapacks') return loadAddons(box, 'datapacks');
  if (activeTab === 'worlds') return loadWorlds(box);
  return loadMods(box);
}

/* ------------------------------ 模组 ------------------------------ */

async function loadMods(box) {
  // mods:list 失败时也把 {ok:false,error} 当 data 返回，统一归一化
  const r = normCall(await call('mods:list', { id: ctx.instanceId }, { optional: true }));
  const data = (r && r.data) || { mods: [], dir: '' };
  if (!r.ok) {
    setHTML(
      box,
      emptyState({
        iconName: 'pack',
        title: '模组列表读不出来',
        desc: r.error || '主进程暂时取不到模组清单。稍后切回本页再试。',
      })
    );
    return;
  }

  const mods = Array.isArray(data.mods) ? data.mods : [];
  if (!mods.length) {
    setHTML(
      box,
      emptyState({
        iconName: 'pack',
        title: '没有模组',
        desc: '这个实例还没有装任何模组。把 jar 放进 mods 目录，或用「下载」页装一个整合包。',
        actionHTML: data.dir ? '<button class="btn btn--sm" data-act="open" data-path="' + escapeAttr(data.dir) + '" type="button">打开 mods 目录</button>' : '',
      })
    );
    return;
  }

  const enabledCount = mods.filter((m) => m.enabled).length;
  setHTML(
    box,
    html`<div class="mods-summary">
        <span>共 ${mods.length} 个，启用 ${enabledCount} 个</span>
        <span class="grow"></span>
        <button class="btn btn--ghost btn--sm" data-act="check-updates" type="button">
          ${raw(icon('refresh', 14))}检查更新
        </button>
      </div>
      <div class="mods-list">
        ${mods.map(
          (m) => html`<div class="mod-row ${m.enabled ? '' : 'is-disabled'}" data-file="${m.file}">
            <div class="mod-row__icon">
              ${m.iconDataUrl ? html`<img src="${m.iconDataUrl}" alt="" />` : raw(icon(m.loader === 'fabric' ? 'pack' : 'gamepad', 20))}
            </div>
            <div class="mod-row__main">
              <div class="mod-row__name" title="${m.file}">${m.name}</div>
              <div class="mod-row__meta">
                ${m.version ? html`<span class="badge badge--sm">v${m.version}</span>` : raw('')}
                ${m.loader && m.loader !== 'unknown' ? html`<span class="badge badge--sm">${m.loader}</span>` : raw('')}
                ${m.id ? html`<span class="mono">${m.id}</span>` : raw('')}
                <span>${fmtBytes(m.bytes)}</span>
                ${m.enabled ? raw('') : html`<span class="badge badge--sm badge--warn">已禁用</span>`}
              </div>
            </div>
            <div class="mod-row__actions">
              <button class="btn btn--ghost btn--sm" type="button" data-act="toggle" data-kind="mods" data-file="${m.file}" data-enabled="${m.enabled ? '1' : '0'}">
                ${m.enabled ? '禁用' : '启用'}
              </button>
              <button class="btn btn--ghost btn--sm" type="button" data-act="remove" data-kind="mods" data-file="${m.file}" data-name="${m.name || m.file}">删除</button>
            </div>
          </div>`
        )}
      </div>`
  );
}

/* ---------------------- 资源包 / 光影 / 数据包 ---------------------- */

const ADDON_META = {
  packs: {
    label: '资源包',
    channels: ['mods:resourcePacks'],
    kind: 'resourcepacks',
    icon: 'palette',
    dir: 'resourcepacks',
    empty: '把资源包 .zip 放进 resourcepacks 目录就会出现在这里。',
    unsupported: '资源包清单还没接上',
  },
  shaders: {
    label: '光影',
    channels: ['mods:shaderPacks'],
    kind: 'shaderpacks',
    icon: 'bolt',
    dir: 'shaderpacks',
    empty: '把光影包 .zip 放进 shaderpacks 目录就会出现在这里（需要装 Iris / OptiFine 才生效）。',
    unsupported: '光影功能正在接入',
  },
  datapacks: {
    label: '数据包',
    channels: ['mods:dataPacks'],
    kind: 'datapacks',
    icon: 'file',
    dir: 'datapacks',
    empty: '把数据包 .zip 放进 datapacks 目录就会出现在这里（也可以放在存档自己的 datapacks 目录里）。',
    unsupported: '数据包功能正在接入',
  },
};

/** 依次尝试候选通道，返回第一个能用的（都不行就 { ok:false }） */
async function fetchAddons(meta) {
  let lastError = '';
  for (const channel of meta.channels) {
    const r = await call(channel, { id: ctx.instanceId }, { optional: true });
    if (!r.ok) {
      lastError = r.error || lastError;
      continue;
    }
    const d = r.data;
    if (d && d.ok === false) return { ok: false, list: [], error: d.error || '', channel };
    const list = Array.isArray(d)
      ? d
      : Array.isArray(d && d.items)
        ? d.items
        : Array.isArray(d && d.list)
          ? d.list
          : Array.isArray(d && d.packs)
            ? d.packs
            : [];
    return { ok: true, list, channel };
  }
  return { ok: false, list: [], error: lastError };
}

async function loadAddons(box, which) {
  const meta = ADDON_META[which];
  const { ok, list, error } = await fetchAddons(meta);

  if (!ok) {
    // 后端还没接这条通道 ⇒ 中文空状态（不弹横幅、不白屏）
    setHTML(
      box,
      emptyState({
        iconName: meta.icon,
        title: meta.unsupported,
        desc:
          error ||
          `${meta.label}清单来自主进程（${meta.channels[0]}）。后端接好之后这里会自动出现内容，不需要更新启动器。`,
      })
    );
    return;
  }

  if (!list.length) {
    setHTML(box, emptyState({ iconName: meta.icon, title: `没有${meta.label}`, desc: meta.empty }));
    return;
  }

  const enabledCount = list.filter((x) => x.enabled !== false).length;
  setHTML(
    box,
    html`<div class="mods-summary">共 ${list.length} 个，启用 ${enabledCount} 个</div>
      <div class="mods-list">
        ${list.map((p) => {
          /**
           * 契约（2026-11-05 与 backend 确认）：`mods:shaderPacks` / `mods:dataPacks` /
           * `mods:resourcePacks` 都返回 `{ file, path, bytes, mtime, isDir, enabled }`，
           * `enabled=false` 表示文件名带 `.disabled`；`mods:setEnabled` 支持 `kind`。
           * ⇒ 四类都可以放心显示启用/禁用开关。
           */
          const enabled = p.enabled !== false;
          return html`<div class="mod-row ${enabled ? '' : 'is-disabled'}" data-file="${p.file}">
            <div class="mod-row__icon">${raw(icon(p.isDir ? 'folder' : meta.icon, 20))}</div>
            <div class="mod-row__main">
              <div class="mod-row__name" title="${p.file}">${p.file}</div>
              <div class="mod-row__meta">
                <span>${p.isDir ? '文件夹' : fmtBytes(p.bytes)}</span>
                ${!enabled ? html`<span class="badge badge--sm badge--warn">已禁用</span>` : raw('')}
                <span class="mono">${meta.dir}/</span>
              </div>
            </div>
            <div class="mod-row__actions">
              <button class="btn btn--ghost btn--sm" type="button" data-act="toggle" data-kind="${meta.kind}" data-file="${p.file}" data-enabled="${enabled ? '1' : '0'}">
                ${enabled ? '禁用' : '启用'}
              </button>
              <button class="btn btn--ghost btn--sm" type="button" data-act="remove" data-kind="${meta.kind}" data-file="${p.file}" data-name="${p.file}">删除</button>
            </div>
          </div>`;
        })}
      </div>`
  );
}

/* ------------------------------ 世界 ------------------------------ */

async function fetchWorlds() {
  const r = await call('worlds:list', { id: ctx.instanceId }, { optional: true });
  /**
   * ★ 主进程的失败形状是**「调用成功、数据里带 ok:false」**：
   *   `worlds:list` 内部 catch 后 return `{ ok:false, error, items:[] }` —— 也就是说
   *   bridge 那边 `r.ok === true`。所以不能只看 r.ok，必须再看 `data.ok === false`。
   *   成功时返回的是**裸数组**（契约里写的「列表通道就是数组」）。
   */
  if (r.ok) {
    const d = r.data;
    if (Array.isArray(d)) return { ok: true, list: d, legacy: false };
    if (d && d.ok === false) return { ok: false, list: [], error: d.error || '存档清单读取失败' };
    if (d && Array.isArray(d.items)) return { ok: true, list: d.items, legacy: false };
    if (d && Array.isArray(d.worlds)) return { ok: true, list: d.worlds, legacy: false };
  }

  // ★ 通道整个不存在（后端还没接）时才退回旧的 mods:worlds，存档页仍然可用
  const legacy = await call('mods:worlds', { id: ctx.instanceId }, { optional: true });
  if (legacy.ok && Array.isArray(legacy.data)) return { ok: true, list: mapLegacyWorlds(legacy.data), legacy: true };
  return { ok: false, list: [], error: r.error || legacy.error || '存档清单取不到' };
}

async function loadWorlds(box) {
  const { ok, list, legacy, error } = await fetchWorlds();
  if (!ok) {
    setHTML(
      box,
      emptyState({
        iconName: 'earth',
        title: '存档管理正在接入',
        desc: error || '主进程的 worlds:list 还没就绪。接好之后这里会自动出现存档，不需要更新启动器。',
      })
    );
    return;
  }

  if (!list.length) {
    setHTML(
      box,
      emptyState({
        iconName: 'earth',
        title: '还没有存档',
        desc: '进入游戏创建一个世界，或者用「导入整合包」把别人的存档带进来，就会出现在这里。',
      })
    );
    return;
  }

  setHTML(
    box,
    html`<div class="mods-summary">
        <span>共 ${list.length} 个存档</span>
        ${legacy ? html`<span class="badge badge--sm badge--warn">部分功能未接入</span>` : raw('')}
      </div>
      <div class="world-grid">
        ${list.map(
          (w) => html`<article class="world-card" data-folder="${w.folder}">
            <div class="world-card__icon" data-icon-for="${w.folder}">
              ${w.hasIcon ? html`<img alt="" data-world-icon="${w.folder}" />` : raw(icon('earth', 30))}
            </div>
            <div class="world-card__main">
              <button class="world-card__name" type="button" data-act="world-detail" data-folder="${w.folder}" data-name="${w.name || w.folder}" title="查看详情">${w.name || w.folder}</button>
              <div class="world-card__meta">
                ${w.version ? html`<span class="badge badge--sm">${w.version}</span>` : raw('')}
                <span>${w.sizeBytes ? fmtBytes(w.sizeBytes) : '大小未知'}</span>
                <span>最后游玩 ${relTime(w.lastPlayed)}</span>
              </div>
              <div class="world-card__actions">
                <button class="btn btn--ghost btn--sm" type="button" data-act="world-backup" data-folder="${w.folder}" data-name="${w.name || w.folder}">${raw(icon('copy', 14))}备份</button>
                <button class="btn btn--ghost btn--sm" type="button" data-act="world-backups" data-folder="${w.folder}" data-name="${w.name || w.folder}">备份列表</button>
                <button class="btn btn--ghost btn--sm" type="button" data-act="world-export" data-folder="${w.folder}" data-name="${w.name || w.folder}">导出</button>
                <button class="btn btn--ghost btn--sm" type="button" data-act="world-open" data-folder="${w.folder}">打开文件夹</button>
                <button class="btn btn--ghost btn--sm btn--danger-text" type="button" data-act="world-delete" data-folder="${w.folder}" data-name="${w.name || w.folder}">删除</button>
              </div>
            </div>
          </article>`
        )}
      </div>`
  );

  paintWorldIcons(list);
}

/**
 * 存档图标：`saves/<folder>/icon.png` 由主进程读成 data URL。
 * 这里借用 `accounts:readSkin`（本质就是「本地 PNG → data URL」的通用通道），
 * 失败就保留地球图标，不影响列表。
 */
async function paintWorldIcons(list) {
  const mount = ctx.mount;
  if (!mount) return;
  const inst = (state.instances || []).find((x) => x.id === ctx.instanceId);
  if (!inst || !inst.dir) return;
  for (const w of list) {
    if (!w.hasIcon) continue;
    const img = mount.querySelector(`img[data-world-icon="${cssEscape(w.folder)}"]`);
    if (!img) continue;
    const p = `${inst.dir}\\.minecraft\\saves\\${w.folder}\\icon.png`;
    const r = await call('accounts:readSkin', { path: p }, { optional: true });
    const dataUrl = r.ok && r.data && r.data.dataUrl;
    if (dataUrl) img.src = dataUrl;
    else img.remove();
  }
}

/* ============================ 交互 ============================ */

async function onActionClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const instanceId = ctx.instanceId;

  /* ---- 模组 / 资源包 / 光影 / 数据包 ---- */
  if (act === 'toggle') {
    const file = btn.dataset.file;
    const kind = btn.dataset.kind || 'mods';
    const enabled = btn.dataset.enabled === '1';
    const r = normCall(await call('mods:setEnabled', { id: instanceId, file, enabled: !enabled, kind }, { optional: true }));
    if (!r.ok) {
      toast(r.error || '操作失败（主进程可能还不支持这一分类）', 'warn', 5000);
      return;
    }
    toast(enabled ? '已禁用（改后缀，随时可恢复）' : '已启用', 'ok', 2000);
    loadTab();
    return;
  }

  if (act === 'remove') {
    const file = btn.dataset.file;
    const kind = btn.dataset.kind || 'mods';
    const name = btn.dataset.name || file;
    const ok = await confirmDialog({
      title: '移到回收目录',
      message: `确定要移除「${name}」吗？文件会被移到 QCL 的 recycle 目录，不会直接删除，需要时可以找回。`,
      okText: '移到回收目录',
      danger: true,
    });
    if (!ok) return;
    const r = normCall(await call('mods:remove', { id: instanceId, file, kind }, { optional: true }));
    if (!r.ok) {
      toast(r.error || '删除失败', 'warn', 5000);
      return;
    }
    toast('已移到回收目录', 'ok', 2200);
    loadTab();
    return;
  }

  if (act === 'open') {
    const p = btn.dataset.path;
    if (!p) return;
    const r = await call('shell:openPath', { path: p }, { optional: true });
    if (!r.ok) toast(r.error || '打不开', 'warn');
    return;
  }

  if (act === 'check-updates') {
    await checkModUpdates(btn, instanceId);
    return;
  }

  /* ---- 存档 ---- */
  const folder = btn.dataset.folder;
  if (!folder) return;
  const name = btn.dataset.name || folder;

  if (act === 'world-backup') {
    btn.disabled = true;
    toast(`正在备份「${name}」…`, 'info', 1600);
    const r = normCall(await call('worlds:backup', { id: instanceId, folder }, { optional: true }));
    btn.disabled = false;
    if (!r.ok) {
      toast(r.error || '备份失败（主进程可能还没实现 worlds:backup）', 'warn', 5000);
      return;
    }
    const d = r.data || {};
    toast(`已备份「${name}」${d.file ? `：${d.file}` : ''}${d.sizeBytes ? `（${fmtBytes(d.sizeBytes)}）` : ''}`, 'ok', 5200);
    return;
  }

  if (act === 'world-export') {
    btn.disabled = true;
    toast(`正在导出「${name}」…`, 'info', 1600);
    const r = normCall(await call('worlds:export', { id: instanceId, folder }, { optional: true }));
    btn.disabled = false;
    if (!r.ok) {
      toast(r.error || '导出失败（主进程可能还没实现 worlds:export）', 'warn', 5000);
      return;
    }
    const d = r.data || {};
    toast(`已导出：${d.file || '（未返回文件名）'}${d.sizeBytes ? `（${fmtBytes(d.sizeBytes)}）` : ''}`, 'ok', 7000);
    return;
  }

  if (act === 'world-open') {
    const r = normCall(await call('worlds:open', { id: instanceId, folder }, { optional: true }));
    if (!r.ok) toast(r.error || '打开失败（主进程可能还没实现 worlds:open）', 'warn', 4000);
    return;
  }

  if (act === 'world-delete') {
    const ok = await confirmDialog({
      title: '删除存档',
      message: `确定要删除「${name}」吗？存档目录会被移到回收目录，不会直接删除，但游戏里就看不到它了。`,
      okText: '删除存档',
      danger: true,
    });
    if (!ok) return;
    const r = normCall(await call('worlds:delete', { id: instanceId, folder }, { optional: true }));
    if (!r.ok) {
      toast(r.error || '删除失败', 'warn', 5000);
      return;
    }
    toast('存档已移到回收目录', 'ok', 2400);
    loadTab();
    return;
  }

  if (act === 'world-detail') {
    await showWorldDetail(folder, name);
    return;
  }

  if (act === 'world-backups') {
    await showWorldBackups(folder, name);
    return;
  }
}

/* -------------------------- 存档详情弹窗 -------------------------- */

async function showWorldDetail(folder, name) {
  const r = normCall(await call('worlds:detail', { id: ctx.instanceId, folder }, { optional: true }));
  if (!r.ok || !r.data) {
    toast(r.error || '存档详情读取失败', 'warn', 4200);
    return;
  }
  const d = r.data;
  openModal({
    title: `存档详情 · ${d.name || name}`,
    buttons: [{ text: '关闭', value: null, kind: 'ghost' }],
    body: html`<div class="kv">
      <div class="kv__k">存档名</div>
      <div class="kv__v">${d.name || name}</div>
      <div class="kv__k">文件夹</div>
      <div class="kv__v mono">${d.folder || folder}</div>
      <div class="kv__k">游戏版本</div>
      <div class="kv__v">${d.version || '未知'}</div>
      <div class="kv__k">游戏模式</div>
      <div class="kv__v">${d.gameModeName || gameModeLabel(d.gameMode)}${d.hardcore ? '（极限模式）' : ''}</div>
      <div class="kv__k">种子</div>
      <div class="kv__v mono">${d.seed == null ? '未知' : String(d.seed)}</div>
      <div class="kv__k">大小</div>
      <div class="kv__v">${d.sizeBytes ? fmtBytes(d.sizeBytes) : '未知'}${d.fileCount ? ` · ${d.fileCount} 个文件` : ''}</div>
      <div class="kv__k">最后游玩</div>
      <div class="kv__v">${relTime(d.lastPlayed)}</div>
    </div>`,
  });
}

/* -------------------------- 备份列表弹窗 -------------------------- */

async function showWorldBackups(folder, name) {
  const r = await call('worlds:backups', { id: ctx.instanceId, folder }, { optional: true });
  if (!r.ok || (r.data && r.data.ok === false)) {
    toast((r.data && r.data.error) || r.error || '备份列表读取失败', 'warn', 4200);
    return;
  }
  const list = Array.isArray(r.data)
    ? r.data
    : Array.isArray(r.data && r.data.items)
      ? r.data.items
      : Array.isArray(r.data && r.data.backups)
        ? r.data.backups
        : [];

  const body = list.length
    ? html`<div class="mods-list">
        ${list.map(
          (b) => html`<div class="mod-row" data-node="backup">
            <div class="mod-row__icon">${raw(icon('clock', 20))}</div>
            <div class="mod-row__main">
              <div class="mod-row__name" title="${b.file}">${b.name || b.file}</div>
              <div class="mod-row__meta">
                <span>${b.sizeBytes ? fmtBytes(b.sizeBytes) : '大小未知'}</span>
                <span>${relTime(b.time)}</span>
                <span class="mono">${b.file || ''}</span>
              </div>
            </div>
            <div class="mod-row__actions">
              <button class="btn btn--sm" type="button" data-restore="${b.file || ''}">恢复</button>
            </div>
          </div>`
        )}
      </div>`
    : html`<div class="sourcetip">这个存档还没有备份。点存档卡上的「备份」就会生成一个，之后能在这里一键恢复。</div>`;

  openModal({
    title: `备份列表 · ${name}`,
    wide: true,
    body,
    buttons: [{ text: '关闭', value: null, kind: 'ghost' }],
    onMount: (root, finish) => {
      root.querySelectorAll('[data-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const file = btn.dataset.restore;
          if (!file) return;
          const ok = await confirmDialog({
            title: '恢复备份',
            message: `确定用「${file}」覆盖当前存档吗？当前存档里的进度会被这个备份替换掉，建议先点一次「备份」再恢复。`,
            okText: '覆盖恢复',
            danger: true,
          });
          if (!ok) return;
          const res = normCall(await call('worlds:restore', { id: ctx.instanceId, folder, file }, { optional: true }));
          if (!res.ok) {
            toast(res.error || '恢复失败', 'warn', 5000);
            return;
          }
          toast('已恢复备份，进游戏前请先关闭游戏', 'ok', 4200);
          finish(null);
          if (ctx.mount) loadTab();
        });
      });
    },
  });
}

/* -------------------------- 模组更新检查 -------------------------- */

async function checkModUpdates(btn, instanceId) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '正在检查…';
  const r = await call('mods:checkUpdates', { id: instanceId }, { optional: true });
  btn.disabled = false;
  setHTML(btn, raw(old));
  if (!r.ok || !r.data) {
    toast(r.error || '更新检查正在接入', 'warn', 5000);
    return;
  }

  const checked = Number(r.data.checked) || 0;
  const items = Array.isArray(r.data.items) ? r.data.items : [];
  /**
   * ★ 契约里「网络失败不抛异常」，而是返回 `{checked:0, items:[], error:'中文原因'}` ——
   *   这时 bridge 的 r.ok 仍是 true。不判断这个 soft error 就会把失败说成
   *   「全部已是最新（检查了 0 个）」，属于骗用户。
   */
  const softError = r.data.error ? String(r.data.error) : '';
  if (!items.length) {
    if (softError) {
      toast(softError, 'warn', 6000);
      return;
    }
    toast(`全部已是最新（检查了 ${checked} 个）`, 'ok', 3600);
    return;
  }

  openModal({
    title: `发现 ${items.length} 个可更新的模组`,
    wide: true,
    buttons: [{ text: '关闭', value: null, kind: 'ghost' }],
    body: html`<div class="sourcetip" style="margin-bottom:10px">
        检查了 ${checked} 个模组。「更新」会把这个 jar 换成新版本，旧文件会留在回收目录里。
      </div>
      <div class="mods-list">
        ${items.map(
          (it) => html`<div class="mod-row">
            <div class="mod-row__icon">${raw(icon('pack', 20))}</div>
            <div class="mod-row__main">
              <div class="mod-row__name" title="${it.fileName}">${it.name || it.fileName}</div>
              <div class="mod-row__meta">
                <span class="badge badge--sm">${it.current || '?'}</span>
                <span>→</span>
                <span class="badge badge--sm badge--accent">${it.latest || '?'}</span>
                <span class="mono">${it.fileName || ''}</span>
                ${it.size ? html`<span>${fmtBytes(it.size)}</span>` : raw('')}
              </div>
            </div>
            <div class="mod-row__actions">
              <button class="btn btn--sm" type="button" data-update="${it.fileName}" data-url="${it.downloadUrl || ''}" data-sha1="${it.sha1 || ''}" data-latest="${it.latest || ''}">更新</button>
            </div>
          </div>`
        )}
      </div>`,
    onMount: (root, finish) => {
      root.querySelectorAll('[data-update]').forEach((b) => {
        b.addEventListener('click', async () => {
          const item = items.find((x) => (x.fileName || '') === b.dataset.update) || {};
          b.disabled = true;
          b.textContent = '更新中…';
          const ok = await applyModUpdate(instanceId, {
            ...item,
            fileName: b.dataset.update,
            downloadUrl: b.dataset.url || item.downloadUrl || '',
            sha1: b.dataset.sha1 || item.sha1 || '',
            latest: b.dataset.latest || item.latest || '',
          });
          if (!ok) {
            b.disabled = false;
            b.textContent = '更新';
            return;
          }
          b.textContent = '已更新';
          loadTab();
        });
      });
    },
  });
}

/**
 * 应用一条更新。
 * 契约只锁了「检查」，没锁「下载」，所以按可用性依次尝试，最后兜底到「复制下载链接」：
 *   ① `content:download`（**已有且可用**：更新项带了 `projectId` 就直接下最新文件到 mods/）
 *   ② `mods:update`（backend-dev 若实现，能顺手把旧 jar 挪走，最理想）
 *   ③ 复制 downloadUrl，让用户手动替换 —— 绝不假装成功
 */
async function applyModUpdate(instanceId, it) {
  if (it.projectId) {
    const r0 = await call(
      'content:download',
      { id: it.projectId, versionId: it.versionId || null, instId: instanceId, projectType: 'mod' },
      { optional: true }
    );
    if (r0.ok && r0.data) {
      /**
       * 后端说明：contentapi 按「同一个 project 只保留一个文件」处理，下载新版会**替换旧 jar**，
       * 所以这里不需要提示用户手动删旧文件；成功后刷新列表让新版本出现在界面上。
       */
      toast(`已更新「${it.name || it.fileName}」→ ${it.latest || '新版'}`, 'ok', 5000);
      return true;
    }
  }

  const r1 = await call(
    'mods:update',
    { id: instanceId, fileName: it.fileName, downloadUrl: it.downloadUrl, sha1: it.sha1, latest: it.latest, projectId: it.projectId },
    { optional: true }
  );
  if (r1.ok && r1.data) {
    toast(`已更新「${it.name || it.fileName}」`, 'ok', 3400);
    return true;
  }

  if (it.downloadUrl) {
    try {
      await navigator.clipboard.writeText(it.downloadUrl);
      toast('自动更新还没接上，已复制下载链接，可手动替换 mods 里的文件', 'warn', 7000);
    } catch {
      toast(`自动更新还没接上，请手动打开：${it.downloadUrl}`, 'warn', 9000);
    }
    return false;
  }

  toast('自动更新还没接上，暂时只能手动更新这个模组', 'warn', 5000);
  return false;
}

/* ============================ 小工具 ============================ */

/**
 * ★ 主进程有一部分通道（worlds:* / modpack:*）把失败写成
 *   **`return { ok:false, error:'中文' }` 当作 data 返回**，此时 bridge 的 `r.ok` 仍是 true。
 *   只看 `r.ok` 会把「备份失败」当成「备份成功（未返回文件名）」——必须两边都看。
 */
function normCall(r) {
  const d = r && r.data;
  if (d && d.ok === false) return { ok: false, error: d.error || '', data: d };
  return { ok: !!(r && r.ok), error: (r && r.error) || '', data: d };
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 用于 CSS 属性选择器的转义（存档文件夹名可能带空格/引号） */
function cssEscape(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export default modsPage;
