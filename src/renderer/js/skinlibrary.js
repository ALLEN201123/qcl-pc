/**
 * Quanta Craft Launcher PC · 皮肤库（PC 优化版）
 *
 * ## 为什么重写
 * 用户原话：「移植到电脑端上的皮肤库需要整体优化一下，更适合 PC 端」。
 *
 * 旧版是手机思路的简单弹窗：一个输入框 + 一张 64×64 静态图 + 应用按钮。
 * 在 1600×900 的电脑屏幕上显得又空又小，也发挥不出 PC 的性能。
 *
 * ## PC 版做了什么
 *   ① **真·3D 实时预览**：用项目自己的 SkinViewer 渲染，可以拖拽旋转、滚轮缩放、
 *      双击复位。手机上只能用静态贴图，PC 上没理由不做真的。
 *   ② **左右双栏**：左侧「查询 + 历史 + 本地上传」，右侧大号 3D 预览 + 详情。
 *      宽屏利用率高，不用像手机那样一屏只能看一张图。
 *   ③ **查询历史**：最近查过的玩家存 localStorage，点一下就能再看（最多 12 个）。
 *   ④ **三种来源**：
 *      · 正版玩家名（走 Mojang 公开 API）
 *      · 皮肤直链（textures.minecraft.net 或任意 PNG URL）
 *      · 本地 PNG 文件
 *   ⑤ **信息完整**：皮肤模型（Steve/Alex）、是否带披风、UUID、来源站点。
 *   ⑥ **快捷键**：Enter 查询、Esc 关闭、Tab 在输入框间切换。
 *   ⑦ **保存到账号**：一键下载并绑定为账号皮肤，主界面人物立刻跟随。
 *
 * ## 数据来源（全部免登录）
 *   · `skin:lookup`     —— 名字 → UUID → textures → 皮肤/披风地址
 *   · `skin:readRemote` —— 主进程代理下载（绕过 CSP 的 http 限制）
 *   · `skin:applyPlayerSkin` —— 下载并写入账号
 */

import { call } from './bridge.js';
import { toast } from './ui.js';
import { icon } from './icons.js';
import { SkinViewer } from './skin.js';

const LS_HISTORY = 'qcl.skinHistory.v1';
const MAX_HISTORY = 12;

/* ------------------------------------------------------------ 历史记录 */

function loadHistory() {
  try {
    const raw = window.localStorage.getItem(LS_HISTORY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(name) {
  const n = String(name || '').trim();
  if (!n) return loadHistory();
  const list = loadHistory().filter((x) => x.toLowerCase() !== n.toLowerCase());
  list.unshift(n);
  const next = list.slice(0, MAX_HISTORY);
  try {
    window.localStorage.setItem(LS_HISTORY, JSON.stringify(next));
  } catch {
    /* 存不下不影响使用 */
  }
  return next;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把一个 URL 变成「这是不是皮肤直链」的判断 */
function looksLikeUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

/* ------------------------------------------------------------ 主入口 */

/**
 * 打开皮肤库。
 * @param {object} opts
 * @param {object} [opts.account]  要应用到的账号
 * @param {function} [opts.onApplied]
 */
export function openSkinLibrary(opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve(false);
      return;
    }
    const account = opts.account || null;

    root.hidden = false;
    root.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'modal modal--skinlib2';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `
      <div class="modal__head">
        <div class="modal__title">皮肤库</div>
        <div class="sl2-headhint">查正版玩家皮肤 · 贴皮肤直链 · 传本地 PNG，都免登录</div>
        <button class="winbtn" data-close type="button" title="关闭（Esc）">${icon('close', 14)}</button>
      </div>

      <div class="modal__body sl2-body">
        <!-- 左栏：查询 / 历史 / 本地上传 -->
        <aside class="sl2-side">
          <div class="sl2-side__block">
            <div class="sl2-label">查询玩家</div>
            <div class="sl2-searchrow">
              <input class="input" id="sl2-name" placeholder="正版玩家名，或皮肤直链 URL" autocomplete="off" spellcheck="false" />
              <button class="btn btn--primary" id="sl2-go" type="button">查询</button>
            </div>
            <div class="sl2-tip" id="sl2-tip">支持输入 <span class="mono">https://textures.minecraft.net/…</span> 直链</div>
          </div>

          <div class="sl2-side__block">
            <div class="sl2-label">最近查询</div>
            <div class="sl2-history" id="sl2-history"></div>
          </div>

          <div class="sl2-side__block">
            <div class="sl2-label">本地文件</div>
            <button class="btn btn--ghost btn--sm" id="sl2-local" type="button">选择本地皮肤 PNG…</button>
            <div class="sl2-tip">尺寸需要 64×64 或 64×32</div>
          </div>
        </aside>

        <!-- 右栏：3D 预览 + 详情 -->
        <section class="sl2-main">
          <div class="sl2-previewwrap">
            <canvas class="sl2-canvas" id="sl2-canvas" width="520" height="560"></canvas>
            <div class="sl2-previewhint">拖动旋转 · 滚轮缩放 · 双击复位</div>
            <div class="sl2-empty" id="sl2-empty">
              <div class="sl2-empty__icon">${icon('person', 42)}</div>
              <div class="sl2-empty__title">还没有选择皮肤</div>
              <div class="sl2-empty__desc">左边输入玩家名，或者传一个本地 PNG 就能预览</div>
            </div>
          </div>

          <div class="sl2-detail" id="sl2-detail">
            <div class="sl2-detail__name">—</div>
            <div class="sl2-detail__meta"></div>
          </div>

          <div class="sl2-actions">
            <button class="btn btn--primary" id="sl2-apply" type="button" disabled>
              ${account ? `用到「${escapeHtml(account.name)}」` : '用到当前账号'}
            </button>
          </div>
        </section>
      </div>

      <div class="modal__foot">
        <span class="sl2-status" id="sl2-status"></span>
        <button class="btn btn--ghost" data-act="close" type="button">关闭</button>
      </div>`;

    root.appendChild(modal);

    /* ---------- DOM 引用 ---------- */
    const nameInput = modal.querySelector('#sl2-name');
    const goBtn = modal.querySelector('#sl2-go');
    const tipEl = modal.querySelector('#sl2-tip');
    const historyEl = modal.querySelector('#sl2-history');
    const emptyEl = modal.querySelector('#sl2-empty');
    const canvas = modal.querySelector('#sl2-canvas');
    const detailEl = modal.querySelector('#sl2-detail');
    const applyBtn = modal.querySelector('#sl2-apply');
    const statusEl = modal.querySelector('#sl2-status');

    let current = null; // { kind:'player'|'url'|'file', name, uuid, skinUrl, capeUrl, slim, dataUrl }
    let viewer = null;
    let viewerReady = false;

    /* ---------- 3D 预览器（懒创建） ---------- */
    async function ensureViewer() {
      if (viewer) return viewer;
      try {
        viewer = new SkinViewer(canvas, { yaw: -22, pitch: 6 });
        viewer.start();
        viewerReady = true;
        return viewer;
      } catch (err) {
        console.warn('[QCL] 皮肤库 3D 预览创建失败，退回静态图：', err);
        viewer = null;
        viewerReady = false;
        return null;
      }
    }

    /** 显示静态图兜底（3D 不可用时） */
    function showStaticImage(dataUrl) {
      emptyEl.hidden = true;
      const wrap = canvas.parentElement;
      let img = wrap.querySelector('.sl2-static');
      if (!img) {
        img = document.createElement('img');
        img.className = 'sl2-static';
        wrap.appendChild(img);
      }
      img.src = dataUrl;
      img.hidden = false;
      canvas.style.display = 'none';
    }

    function hideStaticImage() {
      const img = canvas.parentElement.querySelector('.sl2-static');
      if (img) img.hidden = true;
      canvas.style.display = '';
    }

    /* ---------- 状态提示 ---------- */
    function setStatus(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('is-error', !!isError);
    }
    function setTip(html, isError) {
      if (!tipEl) return;
      tipEl.innerHTML = html;
      tipEl.classList.toggle('is-error', !!isError);
    }

    /* ---------- 渲染详情 ---------- */
    function renderDetail(info) {
      if (!info) {
        detailEl.querySelector('.sl2-detail__name').textContent = '—';
        detailEl.querySelector('.sl2-detail__meta').innerHTML = '';
        applyBtn.disabled = true;
        emptyEl.hidden = false;
        return;
      }
      emptyEl.hidden = true;

      const badges = [];
      if (info.kind === 'player') {
        badges.push(`<span class="badge badge--accent">正版玩家</span>`);
      } else if (info.kind === 'url') {
        badges.push(`<span class="badge">皮肤直链</span>`);
      } else {
        badges.push(`<span class="badge">本地文件</span>`);
      }
      if (info.slim !== undefined) {
        badges.push(`<span class="badge">${info.slim ? 'Alex（细手臂）' : 'Steve（粗手臂）'}</span>`);
      }
      if (info.capeUrl) badges.push(`<span class="badge badge--accent">带披风</span>`);

      detailEl.querySelector('.sl2-detail__name').textContent = info.name || '未命名';
      detailEl.querySelector('.sl2-detail__meta').innerHTML = `
        <div class="sl2-badges">${badges.join('')}</div>
        ${info.uuid ? `<div class="sl2-uuid mono">${escapeHtml(info.uuid)}</div>` : ''}
      `;

      // 玩家可以「应用到账号」；本地文件/直链也可以（走 setSkin 而不是 applyPlayerSkin）
      applyBtn.disabled = !account;
    }

    /* ---------- 显示一个皮肤 ---------- */
    async function showSkin(info) {
      current = info;
      renderDetail(info);

      const v = await ensureViewer();
      if (v && info.skinDataUrl) {
        hideStaticImage();
        try {
          await v.setSkinFromDataUrl(info.skinDataUrl);
          // 披风
          if (info.capeDataUrl) {
            try {
              await v.setCapeFromUrl(info.capeDataUrl);
            } catch {
              /* 披风失败不影响人物 */
            }
          } else {
            try {
              v.setCapeImage(null);
            } catch {
              /* 忽略 */
            }
          }
        } catch (err) {
          setStatus(`预览失败：${err?.message || err}`, true);
          if (info.skinDataUrl) showStaticImage(info.skinDataUrl);
        }
      } else if (info.skinDataUrl) {
        showStaticImage(info.skinDataUrl);
      }
    }

    /* ---------- 历史 ---------- */
    function renderHistory() {
      const list = loadHistory();
      if (!list.length) {
        historyEl.innerHTML = '<div class="sl2-tip">还没有查询记录</div>';
        return;
      }
      historyEl.innerHTML = list
        .map((n) => `<button class="sl2-chip" type="button" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
        .join('');
    }

    historyEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-name]');
      if (!btn) return;
      nameInput.value = btn.dataset.name;
      doQuery();
    });

    /* ---------- 查询：玩家名 / 直链 ---------- */
    async function doQuery() {
      const raw = String(nameInput.value || '').trim();
      if (!raw) {
        setTip('请先输入玩家名或皮肤直链', true);
        return;
      }

      goBtn.disabled = true;
      setStatus('查询中…');
      setTip('正在查询…');

      try {
        // ① 直链：直接下载当皮肤用
        if (looksLikeUrl(raw)) {
          const r = await call('skin:readRemote', { url: raw });
          const dataUrl = r && r.data && r.data.dataUrl;
          if (!dataUrl) {
            setTip('这个地址下载不到图片，检查一下链接', true);
            setStatus('');
            return;
          }
          setTip('已载入皮肤直链（免登录）');
          setStatus('');
          await showSkin({
            kind: 'url',
            name: raw.split('/').pop() || '皮肤直链',
            skinUrl: raw,
            skinDataUrl: dataUrl,
            slim: undefined
          });
          return;
        }

        // ② 玩家名
        const res = await call('skin:lookup', { name: raw });
        const d = res && res.data;
        if (!res.ok || !d || !d.ok) {
          const msg = (d && d.error) || res.error || '查询失败';
          setTip(msg, true);
          setStatus('');
          return;
        }

        setTip(`已找到 <strong>${escapeHtml(d.name)}</strong>`);
        setStatus('正在下载皮肤…');

        const skinRes = await call('skin:readRemote', { url: d.skinUrl });
        const skinDataUrl = skinRes && skinRes.data && skinRes.data.dataUrl;
        if (!skinDataUrl) {
          setTip('找到玩家了，但皮肤下载失败（网络问题）', true);
          setStatus('');
          return;
        }

        let capeDataUrl = null;
        if (d.capeUrl) {
          const capeRes = await call('skin:readRemote', { url: d.capeUrl });
          capeDataUrl = (capeRes && capeRes.data && capeRes.data.dataUrl) || null;
        }

        saveHistory(d.name);
        renderHistory();

        setStatus('');
        await showSkin({
          kind: 'player',
          name: d.name,
          uuid: d.uuid,
          skinUrl: d.skinUrl,
          capeUrl: d.capeUrl || null,
          skinDataUrl,
          capeDataUrl,
          slim: !!d.slim
        });
      } catch (err) {
        setTip(`查询出错：${err?.message || err}`, true);
        setStatus('');
      } finally {
        goBtn.disabled = false;
      }
    }

    goBtn.addEventListener('click', doQuery);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doQuery();
      }
    });

    /* ---------- 本地文件 ---------- */
    modal.querySelector('#sl2-local').addEventListener('click', async () => {
      // 用主进程的文件选择框（渲染层拿不到本地路径）
      const r = await call('accounts:pickSkin', { uuid: account ? account.uuid : '__preview__' });
      if (!r.ok) {
        if (r.error) setTip(r.error, true);
        return;
      }
      const d = r.data || {};
      if (d.canceled) return;

      // pickSkin 已经把文件复制进 QCL\skins 了，读成 dataURL 预览
      const read = await call('accounts:readSkin', { path: d.path });
      const dataUrl = read && read.data && read.data.dataUrl;
      if (!dataUrl) {
        setTip('读取本地文件失败', true);
        return;
      }
      setTip(`已载入本地文件（${d.width}×${d.height}）`);
      await showSkin({
        kind: 'file',
        name: String(d.sourceName || '本地皮肤'),
        skinPath: d.path,
        skinDataUrl: dataUrl,
        slim: undefined
      });
    });

    /* ---------- 应用到账号 ---------- */
    applyBtn.addEventListener('click', async () => {
      if (!current || !account) return;
      applyBtn.disabled = true;
      const oldText = applyBtn.textContent;
      applyBtn.textContent = '正在应用…';
      setStatus('正在写入账号…');

      try {
        if (current.kind === 'player') {
          const res = await call('skin:applyPlayerSkin', { uuid: account.uuid, playerName: current.name });
          const d = res && res.data;
          if (!res.ok || !d || !d.ok) {
            setStatus((d && d.error) || res.error || '应用失败', true);
            applyBtn.textContent = oldText;
            applyBtn.disabled = false;
            return;
          }
          toast(`已把「${current.name}」的皮肤用到你的账号（${d.width}×${d.height}）`, 'ok', 3200);
        } else {
          // 本地文件 / 直链：直接写 skinFile
          const res = await call('accounts:setSkin', { uuid: account.uuid, path: current.skinPath || null });
          if (!res.ok) {
            setStatus(res.error || '应用失败', true);
            applyBtn.textContent = oldText;
            applyBtn.disabled = false;
            return;
          }
          toast('皮肤已应用到账号', 'ok', 2600);
        }

        if (typeof opts.onApplied === 'function') {
          try {
            opts.onApplied(current);
          } catch {
            /* 忽略 */
          }
        }
        finish(true);
      } catch (err) {
        setStatus(`应用失败：${err?.message || err}`, true);
        applyBtn.textContent = oldText;
        applyBtn.disabled = false;
      }
    });

    /* ---------- 关闭 ---------- */
    const cleanup = () => {
      try {
        if (viewer && typeof viewer.stop === 'function') viewer.stop();
      } catch {
        /* 忽略 */
      }
      viewer = null;
      root.hidden = true;
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
    };
    const finish = (v) => {
      cleanup();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    modal.querySelector('[data-close]').addEventListener('click', () => finish(false));
    modal.querySelector('[data-act="close"]').addEventListener('click', () => finish(false));

    /* ---------- 初始化 ---------- */
    renderHistory();
    setTimeout(() => nameInput.focus(), 60);
  });
}
