/**
 * Quanta Craft Launcher PC · 第三方账号登录（authlib-injector）
 *
 * ## 这是什么
 * 让玩家用「皮肤站 / 私服」的账号登录（LittleSkin、Blessing Skin 等），
 * 而不是微软正版。登录后游戏里显示的是那个站上的皮肤。
 *
 * ## 界面流程
 *   ① 填认证服务器地址（如 `https://littleskin.cn/api/yggdrasil`）
 *      → 点「检测」显示站点名（能识别出 LittleSkin 这类）
 *   ② 填邮箱/用户名 + 密码 → 登录
 *   ③ 登录成功后：账号存进列表，自动选中
 *   ④ 提示「需要下载 authlib-injector 组件」并提供一键下载
 *
 * ## 安全说明（必须明说）
 *   密码只发给**你自己填的那个认证服务器**，不经过 QCL、不发给 Mojang。
 *   界面里要把这句写清楚 —— 否则用户不敢填密码。
 */

import { html, raw, toast } from './ui.js';
import { call } from './bridge.js';
import { icon } from './icons.js';

/**
 * 打开第三方登录对话框。
 * @param {object} opts { onDone: (account)=>void }
 */
export function openAuthlibLogin(opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve(false);
      return;
    }

    root.hidden = false;
    root.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'modal modal--authlib';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `
      <div class="modal__head">
        <div class="modal__title">第三方账号登录（皮肤站 / 私服）</div>
        <button class="winbtn" data-close type="button" title="关闭">${icon('close', 14)}</button>
      </div>
      <div class="modal__body">
        <div class="al-note">
          <strong>密码只发给你填的这个认证服务器</strong>，不经过 QCL、也不发给 Mojang。
          不放心的话，请先在浏览器里登录该站点确认它是你要用的那个。
        </div>

        <div class="field">
          <div class="field__label">① 认证服务器地址</div>
          <div class="field__row">
            <input class="input" id="al-root" placeholder="https://littleskin.cn/api/yggdrasil" autocomplete="off" />
            <button class="btn btn--ghost" id="al-probe" type="button">检测</button>
          </div>
          <div class="field__hint" id="al-probe-hint">
            常见填法：LittleSkin → <span class="mono">https://littleskin.cn/api/yggdrasil</span>
          </div>
        </div>

        <div class="field">
          <div class="field__label">② 账号</div>
          <input class="input" id="al-user" placeholder="邮箱或用户名" autocomplete="off" />
        </div>

        <div class="field">
          <div class="field__label">③ 密码</div>
          <input class="input" id="al-pass" type="password" placeholder="该站的登录密码" autocomplete="off" />
        </div>

        <div class="al-component" id="al-component">
          <span class="al-component__text">游戏内验证还需要 authlib-injector 组件</span>
          <button class="btn btn--ghost btn--sm" id="al-prepare" type="button">下载组件</button>
        </div>

        <div class="al-result" id="al-result"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-act="close" type="button">取消</button>
        <button class="btn btn--primary" id="al-login" type="button">登录</button>
      </div>`;

    root.appendChild(modal);

    const rootInput = modal.querySelector('#al-root');
    const userInput = modal.querySelector('#al-user');
    const passInput = modal.querySelector('#al-pass');
    const hintEl = modal.querySelector('#al-probe-hint');
    const resultEl = modal.querySelector('#al-result');
    const loginBtn = modal.querySelector('#al-login');

    const cleanup = () => {
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

    /* ---- 检测服务器 ---- */
    modal.querySelector('#al-probe').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const apiRoot = String(rootInput.value || '').trim();
      if (!apiRoot) {
        toast('请先填写认证服务器地址', 'warn');
        return;
      }
      btn.disabled = true;
      hintEl.textContent = '正在检测…';
      const res = await call('authlib:probe', { apiRoot });
      btn.disabled = false;
      if (!res.ok) {
        hintEl.innerHTML = `<span class="al-bad">${escapeHtml(res.error || '检测失败')}</span>`;
        return;
      }
      const d = res.data || {};
      if (!d.ok) {
        hintEl.innerHTML = `<span class="al-bad">${escapeHtml(d.error || '这不是一个可用的认证服务器')}</span>`;
        return;
      }
      hintEl.innerHTML = `<span class="al-good">✓ 已识别：<strong>${escapeHtml(d.serverName)}</strong></span>`;
      // 记住规范化后的地址
      rootInput.value = d.apiRoot;
    });

    /* ---- 下载 authlib 组件 ---- */
    modal.querySelector('#al-prepare').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '下载中…';
      const res = await call('authlib:prepare');
      btn.disabled = false;
      if (!res.ok) {
        btn.textContent = '下载失败，重试';
        toast((res.data && res.data.error) || res.error || '下载失败', 'error', 6000);
        return;
      }
      const d = res.data || {};
      btn.textContent = '已安装';
      toast(`authlib-injector 已就绪（${d.version || '已安装'}）`, 'ok', 2600);
      refreshStatus();
    });

    /* ---- 登录 ---- */
    const doLogin = async () => {
      const apiRoot = String(rootInput.value || '').trim();
      const username = String(userInput.value || '').trim();
      const password = String(passInput.value || '');
      if (!apiRoot) {
        toast('请填写认证服务器地址', 'warn');
        return;
      }
      if (!username || !password) {
        toast('请填写账号和密码', 'warn');
        return;
      }

      loginBtn.disabled = true;
      loginBtn.textContent = '登录中…';
      resultEl.innerHTML = '<div class="sl-loading"><div class="sl-ring"></div><span>正在登录…</span></div>';

      const res = await call('authlib:login', { apiRoot, username, password });
      loginBtn.disabled = false;
      loginBtn.textContent = '登录';

      // 注意：res 是 bridge 包装，真实数据在 res.data
      const d = res && res.data;
      if (!res.ok) {
        resultEl.innerHTML = `<div class="sl-error">${escapeHtml(res.error || '登录失败')}</div>`;
        return;
      }
      if (!d || !d.ok) {
        resultEl.innerHTML = `<div class="sl-error">${escapeHtml((d && d.error) || '登录失败')}</div>`;
        return;
      }

      const acc = d.account || {};
      resultEl.innerHTML = `
        <div class="tool-ok">
          登录成功：<strong>${escapeHtml(acc.name)}</strong>
          （${escapeHtml(d.apiRoot || '')}）
          ${d.profiles && d.profiles.length > 1 ? `· 该账号下有 ${d.profiles.length} 个角色` : ''}
        </div>`;
      toast(`已添加第三方账号「${acc.name}」`, 'ok', 3000);

      if (typeof opts.onDone === 'function') {
        try {
          opts.onDone(acc);
        } catch {
          /* 忽略 */
        }
      }
      // 清空密码
      passInput.value = '';
      setTimeout(() => finish(true), 900);
    };

    loginBtn.addEventListener('click', doLogin);
    passInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doLogin();
      }
    });

    /* ---- 组件状态 ---- */
    async function refreshStatus() {
      const comp = modal.querySelector('#al-component');
      if (!comp) return;
      const res = await call('authlib:status');
      const installed = res && res.data && res.data.installed;
      comp.classList.toggle('is-ready', !!installed);
      const textEl = comp.querySelector('.al-component__text');
      const btn = comp.querySelector('#al-prepare');
      if (installed) {
        if (textEl) textEl.textContent = '✓ authlib-injector 组件已就绪';
        if (btn) btn.style.display = 'none';
      }
    }
    refreshStatus();

    setTimeout(() => rootInput.focus(), 60);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
