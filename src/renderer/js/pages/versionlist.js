/**
 * QCL 电脑版 · 版本列表
 *
 * 数据全部来自主进程：`instances:list`（实例）+ `versions:local`（该实例已装版本）。
 * 每一行都能：启动 / 进版本设置 / 重命名 / 删除 / 打开实例文件夹。
 */

import { call } from '../bridge.js';
import { state, currentInstance, setCurrentInstance, loadInstances, notify } from '../store.js';
import { html, raw, setHTML, toast, confirmDialog, promptDialog, emptyState, skeletonRows, fmtBytes, fmtRelative, loaderLabel, esc } from '../ui.js';
import { icon } from '../icons.js';
import * as router from '../router.js';
import { launchCurrent } from '../shell.js';

import { instanceIconUrl, instanceIconAlt } from '../instanceicon.js';

export const versionListPage = {
  id: 'versionlist',
  title: '版本列表',
  async render(mount) {
    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">版本列表</div>
          <div class="page__sub" id="vl-count"></div>
          <div class="page__spacer"></div>
          <button class="btn btn--ghost btn--sm" id="vl-refresh" type="button">${raw(icon('refresh', 14))}刷新</button>
          <button class="btn btn--sm" id="vl-new" type="button">${raw(icon('add', 14))}新建实例</button>
        </div>
        <div class="vlist-toolbar">
          <input class="input" id="vl-search" placeholder="搜索版本名或版本号" style="max-width:240px" autocomplete="off" />
          <div class="segmented" id="vl-filter">
            <button class="segmented__item is-active" type="button" data-f="all">全部</button>
            <button class="segmented__item" type="button" data-f="vanilla">原版</button>
            <button class="segmented__item" type="button" data-f="modded">带模组加载器</button>
            <button class="segmented__item" type="button" data-f="ancient">远古版本</button>
          </div>
          <div class="grow"></div>
          <button class="btn btn--ghost btn--sm" id="vl-openhome" type="button">${raw(icon('folder', 14))}打开主目录</button>
        </div>
        <div class="vlist" id="vl-list">${skeletonRows(5, true)}</div>
      </div>`
    );

    let keyword = '';
    let filter = 'all';

    const listEl = mount.querySelector('#vl-list');
    const countEl = mount.querySelector('#vl-count');

    function isAncient(v) {
      return /^(rd-|c0\.|in-|inf-|a1\.|b1\.|1\.0\.0-rc)/i.test(v) || /ancient/i.test(v);
    }

    function visible() {
      const kw = keyword.trim().toLowerCase();
      return state.instances.filter((inst) => {
        if (kw && !`${inst.name} ${inst.mcVersion}`.toLowerCase().includes(kw)) return false;
        const ancient = isAncient(inst.mcVersion);
        if (filter === 'ancient') return ancient;
        if (filter === 'vanilla') return !inst.loader && !ancient;
        if (filter === 'modded') return !!inst.loader && inst.loader.type !== 'vanilla';
        return true;
      });
    }

    function renderList() {
      const items = visible();
      countEl.textContent = state.instances.length > 0 ? `共 ${items.length} 个实例` : '';
      if (state.instances.length === 0) {
        setHTML(
          listEl,
          emptyState({
            maskKey: 'grass',
            title: '还没有安装任何版本',
            desc: '点右上角「新建实例」，或者去「下载」页装一个原版 / 远古版本。QCL 的看家本领是考古社区归档的远古版本（pre-classic / classic / indev / infdev / alpha / beta / RC）。',
            actionHTML: '<button class="btn" id="vl-godownload" type="button">去下载</button>',
          })
        );
        const go = listEl.querySelector('#vl-godownload');
        if (go) go.addEventListener('click', () => router.navigate('download'));
        return;
      }
      if (items.length === 0) {
        setHTML(listEl, emptyState({ iconName: 'search', title: '没有匹配的实例', desc: '换个关键词或筛选条件试试。' }));
        return;
      }

      setHTML(
        listEl,
        html`<div class="list">
          ${items.map((inst) => {
            const active = inst.id === state.currentInstanceId;
            const localCount = inst.localVersionCount || 0;
            void localCount;
            return html`<div class="row ${active ? 'is-active' : ''}" data-id="${inst.id}">
              <img class="row__icon" src="${instanceIconUrl(inst)}" alt="${instanceIconAlt(inst)}" />
              <div class="row__main">
                <div class="row__title">${inst.name}</div>
                <div class="row__meta">
                  <span>${inst.mcVersion}</span>
                  <span>${loaderLabel(inst.loader)}</span>
                  ${inst.lastPlayed ? html`<span>上次启动：${fmtRelative(inst.lastPlayed)}</span>` : html`<span>从未启动</span>`}
                  ${active ? html`<span class="badge badge--accent">当前实例</span>` : raw('')}
                </div>
              </div>
              <div class="row__actions">
                <button class="iconbtn" data-act="launch" title="启动这个实例" type="button">${raw(icon('play', 16))}</button>
                <button class="iconbtn" data-act="setting" title="版本设置" type="button">${raw(icon('setting', 16))}</button>
                <button class="iconbtn" data-act="rename" title="重命名" type="button">${raw(icon('copy', 16))}</button>
                <button class="iconbtn" data-act="folder" title="打开实例文件夹" type="button">${raw(icon('folder', 16))}</button>
                <button class="iconbtn iconbtn--danger" data-act="delete" title="删除实例" type="button">${raw(icon('delete', 16))}</button>
              </div>
            </div>`;
          })}
        </div>`
      );
    }

    renderList();

    // 搜索 / 筛选
    mount.querySelector('#vl-search').addEventListener(
      'input',
      (e) => {
        keyword = e.target.value;
        renderList();
      },
      { passive: true }
    );
    mount.querySelector('#vl-filter').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-f]');
      if (!btn) return;
      filter = btn.dataset.f;
      mount.querySelectorAll('#vl-filter .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderList();
    });

    // 刷新
    mount.querySelector('#vl-refresh').addEventListener('click', async () => {
      toast('正在刷新实例列表…', 'info', 1600);
      await loadInstances();
      renderList();
      toast('实例列表已刷新', 'ok', 1800);
    });

    // 打开主目录
    mount.querySelector('#vl-openhome').addEventListener('click', async () => {
      const home = state.settings.home;
      if (!home) {
        toast('还不知道 QCL 主目录在哪，请先到「设置」里确认', 'warn');
        return;
      }
      const r = await call('shell:openPath', { path: home });
      if (!r.ok) toast(r.error || '打开目录失败', 'error');
    });

    // 新建实例
    mount.querySelector('#vl-new').addEventListener('click', () => {
      router.navigate('download');
      toast('请在「下载」页选择要安装的版本', 'info', 2600);
    });

    // 行内操作（事件委托）
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const inst = state.instances.find((x) => x.id === row.dataset.id);
      if (!inst) return;

      if (!btn) {
        setCurrentInstance(inst.id);
        renderList();
        return;
      }
      const act = btn.dataset.act;

      if (act === 'launch') {
        await launchCurrent(inst.id);
        return;
      }
      if (act === 'setting') {
        setCurrentInstance(inst.id);
        router.navigate('versionsetting', { instanceId: inst.id });
        return;
      }
      if (act === 'rename') {
        const name = await promptDialog({
          title: '重命名实例',
          label: '新的实例名称',
          value: inst.name,
          okText: '保存',
        });
        if (name == null || name === '') return;
        const r = await call('instances:rename', { id: inst.id, name });
        if (!r.ok) {
          toast(r.error || '重命名失败', 'error');
          return;
        }
        toast('已重命名', 'ok');
        await loadInstances();
        notify('instances');
        renderList();
        return;
      }
      if (act === 'folder') {
        const r = await call('shell:openPath', { path: inst.dir });
        if (!r.ok) toast(r.error || '打开文件夹失败', 'error', 5000);
        return;
      }
      if (act === 'delete') {
        const ok = await confirmDialog({
          title: '删除实例',
          message: `确定要删除「${esc(inst.name)}」吗？<br /><br />实例目录 <span class="mono">${esc(inst.dir)}</span> 会被一并删除，此操作不可撤销。`,
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        const r = await call('instances:delete', { id: inst.id });
        if (!r.ok) {
          toast(r.error || '删除失败', 'error');
          return;
        }
        toast('实例已删除', 'ok');
        await loadInstances();
        notify('instances');
        renderList();
      }
    });

    // 侧栏显示当前实例已装版本（真实数据）
    const inst = currentInstance();
    if (inst) {
      const r = await call('versions:local', { id: inst.id });
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
        const box = document.createElement('div');
        box.className = 'vlist-toolbar';
        setHTML(
          box,
          html`<span class="page__sub">「${inst.name}」已装版本：</span>
            ${r.data.map(
              (v) =>
                html`<span class="badge ${v.jsonExists ? 'badge--ok' : 'badge--warn'}" title="${v.jarExists ? 'jar 就绪' : '缺少 jar'}">
                  ${v.id}${v.loader && v.loader.type && v.loader.type !== 'vanilla' ? ` · ${v.loader.type}` : ''} · ${fmtBytes(v.sizeBytes)}
                </span>`
            )}`
        );
        listEl.parentElement.insertBefore(box, listEl);
      } else if (r.ok && Array.isArray(r.data) && r.data.length === 0) {
        void 0;
      }
    }
    return {};
  },
};

export default versionListPage;
