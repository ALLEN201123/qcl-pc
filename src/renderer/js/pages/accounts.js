/**
 * QCL 电脑版 · 账号管理
 *
 * · `accounts:list`       列出账号
 * · `accounts:addOffline` 添加离线账号
 * · `accounts:addMicrosoft` 微软登录：拿到 userCode + verificationUri 展示给用户，
 *   再用 `accounts:microsoftPoll` 轮询直到 done / error / 超时
 * · `accounts:remove`     删除账号
 */

import { call } from '../bridge.js';
import { state, loadAccounts, setCurrentAccount, currentAccount, notify } from '../store.js';
import { html, raw, setHTML, toast, confirmDialog, promptDialog, emptyState, copyText, fmtDateTime } from '../ui.js';
import { icon } from '../icons.js';
import { faceFromSkin, loadImage, defaultFace } from '../avatar.js';

export const accountsPage = {
  id: 'accounts',
  title: '账号管理',
  async render(mount) {
    let polling = false;
    let pollTimer = null;

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">账号管理</div>
          <div class="page__sub" id="ac-count"></div>
          <div class="page__spacer"></div>
          <button class="btn btn--sm" id="ac-ms" type="button">${raw(icon('microsoft', 14))}添加微软账号</button>
          <button class="btn btn--ghost btn--sm" id="ac-offline" type="button">${raw(icon('person', 14))}添加离线账号</button>
          <button class="btn btn--ghost btn--sm" id="ac-authlib" type="button">${raw(icon('earth', 14))}第三方登录</button>
        </div>
        <div class="page__body">
          <div id="ac-list"></div>
          <div class="divider"></div>
          <div class="card">
            <div class="card__title">关于账号</div>
            <div class="field__hint" style="line-height:1.8">
              · <strong>微软账号</strong>：正版登录，可进正版服务器、可用正版皮肤。走微软官方设备码流程，QCL 不会接触你的密码。<br />
              · <strong>离线账号</strong>：只改一个名字，用于单机或离线服务器，不能登录正版服务器。<br />
              · 如果登录已过期，重新走一次微软登录即可；启动器会在启动时自动尝试刷新令牌。
            </div>
          </div>
        </div>
      </div>`
    );

    const listEl = mount.querySelector('#ac-list');
    const countEl = mount.querySelector('#ac-count');

    function renderList() {
      const cur = currentAccount();
      countEl.textContent = `共 ${state.accounts.length} 个账号`;
      if (state.accounts.length === 0) {
        setHTML(
          listEl,
          emptyState({
            iconName: 'person',
            title: '还没有账号',
            desc: '添加一个离线账号就能立刻开始玩单机；想进正版服务器就添加微软账号。',
            actionHTML:
              '<button class="btn" id="ac-empty-offline" type="button">添加离线账号</button> <button class="btn btn--ghost" id="ac-empty-ms" type="button">添加微软账号</button>',
          })
        );
        const a = listEl.querySelector('#ac-empty-offline');
        const b = listEl.querySelector('#ac-empty-ms');
        if (a) a.addEventListener('click', addOffline);
        if (b) b.addEventListener('click', addMicrosoft);
        return;
      }
      setHTML(
        listEl,
        html`<div class="list">
          ${state.accounts.map((acc) => {
            const active = cur && cur.uuid === acc.uuid;
            const expired = acc.expiresAt && acc.expiresAt < Date.now();
            return html`<div class="row ${active ? 'is-active' : ''}" data-uuid="${acc.uuid}">
              <img class="row__icon" data-avatar-of="${acc.uuid}" src="./assets/icon/ic_steve.png" alt="" />
              <div class="row__main">
                <div class="row__title">${acc.name}${active ? ' · 当前使用' : ''}</div>
                <div class="row__meta">
                  <span class="badge ${acc.type === 'microsoft' ? 'badge--accent' : ''}">${acc.type === 'microsoft' ? '微软正版' : '离线'}</span>
                  ${expired ? html`<span class="badge badge--warn">登录已过期</span>` : raw('')}
                  ${acc.skinFile ? html`<span class="badge badge--accent">自定义皮肤</span>` : raw('')}
                  <span class="mono">${acc.uuid}</span>
                </div>
              </div>
              <div class="row__actions">
                <button class="btn btn--ghost btn--sm" data-act="skin" type="button">设置皮肤</button>
                <button class="btn btn--ghost btn--sm" data-act="skinlib" type="button">皮肤库</button>
                ${acc.skinFile ? raw('<button class="btn btn--ghost btn--sm" data-act="clearskin" type="button">清除皮肤</button>') : raw('')}
                ${active ? raw('') : raw('<button class="btn btn--ghost btn--sm" data-act="use" type="button">设为当前</button>')}
                ${acc.type === 'microsoft'
                  ? raw('<button class="btn btn--ghost btn--sm" data-act="relogin" type="button">重新登录</button>')
                  : raw('')}
                <button class="iconbtn iconbtn--danger" data-act="remove" title="删除账号" type="button">${raw(icon('delete', 16))}</button>
              </div>
            </div>`;
          })}
        </div>`
      );

      /**
       * ★ 头像异步补齐：每个账号都按「本地皮肤 > 账号自带皮肤 > 默认」裁出脸。
       *   用 async 单独刷，避免拖慢列表渲染（裁图要 loadImage + canvas）。
       */
      refreshAvatars(listEl);
    }

    /** 给列表里每个账号头像画「从皮肤裁出的脸」 */
    /**
         * 给列表里每个账号头像画「从皮肤裁出的脸」。
         *
         * ★★★ 2026-11-05 修（用户实测「点账号进去头像还是史蒂夫，不是我的真实皮肤」）。
         *
         * 以前这里是 `await loadImage(acc.avatar)` —— **渲染层直连**。
         * 但微软账号的 avatar 是 `http://textures.minecraft.net/...`，
         * 页面 CSP 的 img-src 只放行 `https:`，http 会被**混合内容策略**拦掉，
         * loadImage 拿到 null → 一路回落到 `defaultFace()`（就是那个史蒂夫图标）。
         * 右栏的头像（shell.js）早就改成走 `skin:readRemote` 主进程代理了，这里漏了。
         * ⇒ 统一改成：本地文件走 accounts:readSkin、远程走 skin:readRemote，都拿 data: URL。
         */
        async function refreshAvatars(listEl) {
          if (!listEl) return;

          /** 主进程读本地皮肤文件 → data URL */
          const readLocal = async (p) => {
            try {
              const r = await call('accounts:readSkin', { path: p });
              return (r && r.data && r.data.dataUrl) || null;
            } catch {
              return null;
            }
          };
          /** 主进程代理下载远程皮肤 → data URL（绕过 CSP 的 http 限制） */
          const readRemote = async (url) => {
            try {
              const r = await call('skin:readRemote', { url });
              return (r && r.data && r.data.dataUrl) || null;
            } catch {
              return null;
            }
          };

          const imgs = Array.from(listEl.querySelectorAll('[data-avatar-of]'));
          for (const img of imgs) {
            const uuid = img.getAttribute('data-avatar-of');
            const acc = state.accounts.find((a) => a.uuid === uuid);
            if (!acc) continue;
            // listEl 可能已被下一次渲染替换，写之前确认还在文档里
            if (!img.isConnected) continue;
            try {
              let dataUrl = null;

              // ① 本地自定义皮肤
              if (acc.skinFile) {
                const skinData = await readLocal(acc.skinFile);
                if (skinData) {
                  const skinImg = await loadImage(skinData);
                  if (skinImg) dataUrl = faceFromSkin(skinImg);
                }
              }

              // ② 账号自带皮肤（微软正版）—— 必须走主进程代理
              if (!dataUrl && acc.avatar) {
                const skinData = await readRemote(acc.avatar);
                if (skinData) {
                  const skinImg = await loadImage(skinData);
                  if (skinImg) dataUrl = faceFromSkin(skinImg);
                }
              }

              // ③ 兜底：内置史蒂夫头像
              if (!dataUrl) dataUrl = defaultFace();
              if (dataUrl && img.isConnected) img.src = dataUrl;
            } catch {
              /* 单个头像失败不影响列表 */
            }
          }
        }

    async function addOffline() {
      const name = await promptDialog({
        title: '添加离线账号',
        label: '玩家名称',
        value: 'Steve',
        placeholder: '2~16 个字符',
        hint: '离线账号只用于单机或离线服务器，不能登录正版服务器。',
        okText: '添加',
      });
      if (name == null || name === '') return;
      if (name.length < 1 || name.length > 16) {
        toast('玩家名称长度需要在 1~16 个字符之间', 'warn');
        return;
      }
      const r = await call('accounts:addOffline', { name });
      if (!r.ok && !r.data) {
        toast(r.error || '添加失败', 'error');
        return;
      }
      toast(`已添加离线账号「${name}」`, 'ok');
      await loadAccounts();
      if (r.data && r.data.uuid) setCurrentAccount(r.data.uuid);
      notify('accounts');
      renderList();
    }

    async function addMicrosoft() {
      if (polling) {
        toast('已经有一个微软登录正在进行中', 'warn');
        return;
      }
      const r = await call('accounts:addMicrosoft');
      const data = r.data;
      if (!data || !data.userCode) {
        toast(r.error || '无法开始微软登录流程', 'error', 6000);
        return;
      }

      polling = true;
      let stopped = false;
      const stopPolling = () => {
        stopped = true;
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
      };

      const body = html`<div class="devicecode">
        <div class="field__hint" style="text-align:center">
          请用浏览器打开下面的网址，输入设备码并完成微软登录：
        </div>
        <div class="devicecode__code" id="dc-code">${data.userCode}</div>
        <div class="devicecode__uri" id="dc-uri">${data.verificationUri}</div>
        <div class="hstack">
          <button class="btn btn--sm" id="dc-open" type="button">${raw(icon('external', 14))}打开登录页面</button>
          <button class="btn btn--ghost btn--sm" id="dc-copy" type="button">复制设备码</button>
        </div>
        <div class="field__hint" id="dc-status">正在等待你在浏览器里完成登录…（${Math.round((data.expiresIn || 900) / 60)} 分钟内有效）</div>
      </div>`;

      const modalPromise = openMicrosoftModal(body, (root) => {
        const openBtn = root.querySelector('#dc-open');
        if (openBtn)
          openBtn.addEventListener('click', async () => {
            const res = await call('shell:openExternal', { url: data.verificationUri });
            if (!res.ok) toast(res.error || '打开浏览器失败，请手动复制网址', 'warn', 5000);
          });
        const copyBtn = root.querySelector('#dc-copy');
        if (copyBtn) copyBtn.addEventListener('click', () => copyText(data.userCode));
      });

      const deadline = Date.now() + Math.max(60, (data.expiresIn || 900)) * 1000;

      const statusEl = () => document.getElementById('dc-status');

      const tick = async () => {
        if (stopped) return;
        if (Date.now() > deadline) {
          stopPolling();
          const s = statusEl();
          if (s) s.textContent = '设备码已过期，请重新发起登录。';
          toast('微软登录超时，请重新发起', 'warn', 5000);
          return;
        }
        const pr = await call('accounts:microsoftPoll', { flowId: data.flowId });
        const st = pr.data && pr.data.status;
        const s = statusEl();
        if (st === 'done') {
          stopPolling();
          toast('微软账号登录成功', 'ok');
          await loadAccounts();
          if (pr.data && pr.data.account && pr.data.account.uuid) setCurrentAccount(pr.data.account.uuid);
          notify('accounts');
          renderList();
          closeMicrosoftModal();
          return;
        }
        if (st === 'error') {
          stopPolling();
          const msg = (pr.data && pr.data.message) || pr.error || '登录失败';
          if (s) s.textContent = msg;
          toast(msg, 'error', 6000);
          return;
        }
        if (s)
          s.textContent = `正在等待你在浏览器里完成登录…${
            pr.data && pr.data.message ? `（${pr.data.message}）` : ''
          }`;
        pollTimer = setTimeout(tick, 2500);
      };
      pollTimer = setTimeout(tick, 1500);

      modalPromise.then(() => {
        if (polling) {
          stopPolling();
          toast('已取消微软登录', 'info');
        }
      });
    }

    /* ---------------- 微软登录模态框（自己实现，支持实时改状态文字） ---------------- */

    function openMicrosoftModal(bodyHTML, onMount) {
      const root = document.getElementById('modal-root');
      return new Promise((resolve) => {
        root.hidden = false;
        setHTML(
          root,
          html`<div class="modal" role="dialog" aria-modal="true">
            <div class="modal__head">
              <div class="modal__title">微软账号登录</div>
              <button class="winbtn" data-close type="button" title="关闭">${raw(icon('close', 14))}</button>
            </div>
            <div class="modal__body">${raw(bodyHTML)}</div>
            <div class="modal__foot">
              <button class="btn btn--ghost" data-close type="button">关闭</button>
            </div>
          </div>`
        );
        const finish = () => {
          root.hidden = true;
          root.textContent = '';
          resolve(null);
        };
        root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', finish));
        root.addEventListener('mousedown', (e) => {
          if (e.target === root) finish();
        });
        onMount(root);
      });
    }

    function closeMicrosoftModal() {
      const root = document.getElementById('modal-root');
      if (root) {
        root.hidden = true;
        root.textContent = '';
      }
    }

    /* ---------------- 行内操作 ---------------- */

    listEl.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-uuid]');
      if (!row) return;
      const uuid = row.dataset.uuid;
      const acc = state.accounts.find((a) => a.uuid === uuid);
      if (!acc) return;
      const btn = e.target.closest('[data-act]');

      if (!btn) {
        setCurrentAccount(uuid);
        renderList();
        return;
      }
      if (btn.dataset.act === 'use') {
        setCurrentAccount(uuid);
        renderList();
        toast(`已切换到「${acc.name}」`, 'ok');
        return;
      }
      if (btn.dataset.act === 'relogin') {
        addMicrosoft();
        return;
      }
      /* ---- 设置本地皮肤 ---- */
      if (btn.dataset.act === 'skin') {
        const picked = await call('accounts:pickSkin', { uuid });
        if (!picked.ok) {
          // 取消不算错误
          if (picked.error) toast(picked.error, 'error', 6000);
          return;
        }
        const data = picked.data || {};
        if (data.canceled) return;
        const saved = await call('accounts:setSkin', { uuid, path: data.path });
        if (!saved.ok) {
          toast(saved.error || '保存皮肤失败', 'error');
          return;
        }
        toast(`已设置皮肤（${data.width}×${data.height}）`, 'ok');
        await loadAccounts();
        notify('accounts');
        renderList();
        return;
      }
      /* ---- 皮肤库（查任意正版玩家皮肤）---- */
      if (btn.dataset.act === 'skinlib') {
        const { openSkinLibrary } = await import('../skinlibrary.js');
        const applied = await openSkinLibrary({
          account: acc,
          onApplied: async () => {
            await loadAccounts();
            notify('accounts');
            renderList();
          }
        });
        if (applied) {
          await loadAccounts();
          notify('accounts');
          renderList();
        }
        return;
      }
      /* ---- 清除本地皮肤 ---- */
      if (btn.dataset.act === 'clearskin') {
        const saved = await call('accounts:clearSkin', { uuid });
        if (!saved.ok) {
          toast(saved.error || '清除失败', 'error');
          return;
        }
        toast('已清除自定义皮肤，改用账号自带皮肤', 'ok');
        await loadAccounts();
        notify('accounts');
        renderList();
        return;
      }
      if (btn.dataset.act === 'remove') {
        const ok = await confirmDialog({
          title: '删除账号',
          message: `确定要删除账号「${acc.name}」吗？删除后需要重新登录才能使用。`,
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        const r = await call('accounts:remove', { uuid });
        if (!r.ok) {
          toast(r.error || '删除失败', 'error');
          return;
        }
        toast('账号已删除', 'ok');
        await loadAccounts();
        notify('accounts');
        renderList();
      }
    });

    mount.querySelector('#ac-ms').addEventListener('click', addMicrosoft);
    mount.querySelector('#ac-offline').addEventListener('click', addOffline);
    // 第三方登录（authlib-injector 皮肤站 / 私服）
    const authlibBtn = mount.querySelector('#ac-authlib');
    if (authlibBtn) {
      authlibBtn.addEventListener('click', async () => {
        const { openAuthlibLogin } = await import('../authliblogin.js');
        const ok = await openAuthlibLogin({
          onDone: async () => {
            await loadAccounts();
            notify('accounts');
            renderList();
          }
        });
        if (ok) {
          await loadAccounts();
          notify('accounts');
          renderList();
        }
      });
    }

    if (!state.ready) await loadAccounts();
    renderList();

    return {
      destroy() {
        if (pollTimer) clearTimeout(pollTimer);
        polling = false;
      },
    };
  },
};

export default accountsPage;
