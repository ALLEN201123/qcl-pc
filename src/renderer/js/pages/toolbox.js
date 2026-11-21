/**
 * Quanta Craft Launcher PC · 百宝箱（Toolbox）
 *
 * 功能清单照 PCL 官方开源仓库（`PageOtherTest.xaml.vb` + `Modules/ModEvent.vb`）：
 *   今日人品 / 内存优化 / 清理游戏垃圾 / 磁盘占用 / 回声洞 / 下载自定义文件 / 千万别点
 *
 * ★ 三条必须遵守的原则（页面文案与行为都要体现）：
 *   ① 内存优化**不是加速**。文案必须写清它只是把内存页刷到页面文件，
 *      系统显示的可用内存变大，但刚切回的程序可能短暂卡顿。
 *   ② 清理垃圾**先扫描、列出清单、玩家确认再删**，且走回收站；
 *      绝不静默删除，绝不触碰 saves / mods / config / resourcepacks。
 *   ③ 磁盘占用**只统计不删除**，让玩家自己看清谁占地方。
 */

import { html, raw, setHTML, toast, fmtBytes, fmtSpeed, emptyState, confirmDialog } from '../ui.js';
import { call, on } from '../bridge.js';
import { state, currentAccount, currentInstance } from '../store.js';
import { icon } from '../icons.js';

/** 下载进度（toolbox-download）最近一次快照 */
let downloadSnap = null;
/** 正在下载中（防止重复点击） */
let downloading = false;

export const toolboxPage = {
  id: 'toolbox',
  title: '百宝箱',

  render(mount) {
    const inst = currentInstance();
    const acc = currentAccount();

    setHTML(
      mount,
      html`<div class="page page--tools">
        <div class="page__head">
          <div class="page__title">
            <span class="tbx-title-icon">${raw(icon('toolbox', 20))}</span>百宝箱
          </div>
          <div class="page__sub">今日人品 · 内存优化 · 清理垃圾 · 磁盘占用 · 回声洞 · 自定义下载</div>
        </div>

        ${inst
          ? html`<div class="tool-instance-bar">
              <span class="tool-instance-bar__label">当前实例</span>
              <span class="tool-instance-bar__name">${inst.name}</span>
              <span class="badge">${inst.mcVersion || '—'}</span>
              <span class="grow"></span>
              <span class="tool-instance-bar__hint">清理与统计作用于此实例的游戏目录</span>
            </div>`
          : html`<div class="tool-instance-bar">
              <span class="tool-instance-bar__label">还没有实例</span>
              <span class="tool-instance-bar__hint">清理与统计需要先安装一个游戏版本</span>
            </div>`}

        <!-- 快捷四连：照 PCL 顶部那一排 -->
        <div class="tbx-quick">
          <button class="btn btn--sm" id="tbx-jrrp" type="button">${raw(icon('star', 14))}今日人品</button>
          <button class="btn btn--ghost btn--sm" id="tbx-mem" type="button">${raw(icon('memory', 14))}内存优化</button>
          <button class="btn btn--ghost btn--sm" id="tbx-clean" type="button">${raw(icon('delete', 14))}清理游戏垃圾</button>
          <button class="btn btn--ghost btn--sm" id="tbx-nope" type="button">${raw(icon('warning', 14))}千万别点</button>
        </div>

        <div class="tool-grid">
          <!-- 今日人品 -->
          <section class="card tool-card" id="tbx-card-jrrp">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('star', 18))}</span>
              <div>
                <div class="tool-card__title">今日人品</div>
                <div class="tool-card__desc">同一天同一账号结果固定，跨天才会变</div>
              </div>
            </div>
            <div class="tbx-jrrp" id="tbx-jrrp-body">
              <div class="tbx-jrrp__hint">点上面的「今日人品」看看今天的欧气。</div>
            </div>
          </section>

          <!-- 内存优化 -->
          <section class="card tool-card" id="tbx-card-mem">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('memory', 18))}</span>
              <div>
                <div class="tool-card__title">内存优化</div>
                <div class="tool-card__desc">把内存页刷到页面文件，不是加速</div>
              </div>
            </div>
            <div class="tbx-mem" id="tbx-mem-body">
              <div class="tbx-warn">
                这条<strong>不会让电脑变快</strong>。它只是把进程的工作集页刷到页面文件里，
                系统显示的「可用内存」会变大；代价是这些页面下次访问要从磁盘读回来，
                <strong>刚切回的程序可能短暂卡一下</strong>。真正的内存不足请关掉不用的程序。
              </div>
              <div class="tbx-mem__result" id="tbx-mem-result"></div>
            </div>
          </section>

          <!-- 清理游戏垃圾 -->
          <section class="card tool-card tool-card--wide" id="tbx-card-clean">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('delete', 18))}</span>
              <div>
                <div class="tool-card__title">清理游戏垃圾</div>
                <div class="tool-card__desc">只清日志 / 崩溃报告 / 下载残骸，删前会列清单，走回收站</div>
              </div>
            </div>
            <div class="tbx-clean" id="tbx-clean-body">
              <div class="tbx-clean__hint">点「开始扫描」看看能清出多少空间（只扫描，不删除）。</div>
            </div>
          </section>

          <!-- 磁盘占用 -->
          <section class="card tool-card tool-card--wide" id="tbx-card-disk">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('folder', 18))}</span>
              <div>
                <div class="tool-card__title">磁盘占用</div>
                <div class="tool-card__desc">按目录统计体积，只统计不删除</div>
              </div>
              <span class="grow"></span>
              <button class="btn btn--ghost btn--sm" id="tbx-disk-refresh" type="button">刷新</button>
            </div>
            <div class="tbx-disk" id="tbx-disk-body">
              <div class="tbx-clean__hint">正在统计…</div>
            </div>
          </section>

          <!-- 回声洞 -->
          <section class="card tool-card" id="tbx-card-cave">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('info', 18))}</span>
              <div>
                <div class="tool-card__title">回声洞</div>
                <div class="tool-card__desc">反复点击这里，看看洞里还留了什么</div>
              </div>
            </div>
            <button class="tbx-cave" id="tbx-cave" type="button">
              <span class="tbx-cave__text" id="tbx-cave-text">点一下，听听回声…</span>
            </button>
            <div class="tbx-cave__hint" id="tbx-cave-hint"></div>
          </section>

          <!-- 下载自定义文件 -->
          <section class="card tool-card tool-card--wide" id="tbx-card-dl">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('download', 18))}</span>
              <div>
                <div class="tool-card__title">下载自定义文件</div>
                <div class="tool-card__desc">用 QCL 的下载引擎下载任意 http/https 文件</div>
              </div>
            </div>
            <div class="tbx-dl">
              <div class="field">
                <div class="field__label">下载地址</div>
                <input class="input" id="tbx-dl-url" type="text" placeholder="https://example.com/file.jar" autocomplete="off" spellcheck="false" />
              </div>
              <div class="field">
                <div class="field__label">保存到</div>
                <div class="hstack">
                  <input class="input" id="tbx-dl-folder" type="text" placeholder="留空 = QCL 主目录下的 MyDownload" autocomplete="off" spellcheck="false" />
                  <button class="btn btn--ghost btn--sm" id="tbx-dl-pick" type="button">选择</button>
                  <button class="btn btn--ghost btn--sm" id="tbx-dl-open" type="button">打开</button>
                </div>
              </div>
              <div class="field">
                <div class="field__label">文件名</div>
                <input class="input" id="tbx-dl-name" type="text" placeholder="留空 = 从地址自动推断" autocomplete="off" spellcheck="false" />
              </div>
              <div class="hstack">
                <button class="btn btn--sm" id="tbx-dl-start" type="button">${raw(icon('download', 14))}开始下载</button>
                <span class="tbx-dl__state" id="tbx-dl-state"></span>
              </div>
              <div class="tbx-dl__bar" id="tbx-dl-bar" hidden>
                <div class="tbx-dl__bar-fill" id="tbx-dl-fill"></div>
              </div>
            </div>
          </section>
        </div>
      </div>`
    );

    /* ---------------- 今日人品 ---------------- */
    const accName = (acc && (acc.name || acc.username)) || 'QCL';
    const runJrrp = async () => {
      const body = mount.querySelector('#tbx-jrrp-body');
      if (!body) return;
      const r = await call('toolbox:jrrp', { userName: accName });
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok) {
        setHTML(body, html`<div class="tbx-warn">算不出来：${(r && r.error) || '未知错误'}</div>`);
        return;
      }
      const score = Number(d.score) || 0;
      setHTML(
        body,
        html`<div class="tbx-jrrp__score">
            <span class="tbx-jrrp__num">${score}</span>
            <span class="tbx-jrrp__unit">/ 100</span>
          </div>
          <div class="tbx-jrrp__bar"><div class="tbx-jrrp__fill" style="width:${score}%"></div></div>
          <div class="tbx-jrrp__text">${d.text || ''}</div>
          <div class="tbx-jrrp__meta">${d.user || accName} · ${d.date || ''}（当天固定，明天会变）</div>`
      );
    };

    /* ---------------- 内存优化 ---------------- */
    const runMem = async () => {
      const box = mount.querySelector('#tbx-mem-result');
      const btn = mount.querySelector('#tbx-mem');
      if (!box) return;
      if (btn) btn.disabled = true;
      setHTML(box, html`<div class="tbx-mem__running">正在刷出工作集…（可能要几秒）</div>`);
      const r = await call('toolbox:memoryOptimize', {});
      const d = r && r.ok ? r.data : null;
      if (btn) btn.disabled = false;
      if (!d || !d.ok) {
        setHTML(box, html`<div class="tbx-warn">没做成：${(d && d.error) || (r && r.error) || '未知错误'}</div>`);
        return;
      }
      if (!d.supported) {
        setHTML(box, html`<div class="tbx-warn">${d.error || '当前系统不支持这个操作。'}</div>`);
        return;
      }
      setHTML(
        box,
        html`<div class="tbx-mem__ok">
            可用内存约 +<strong>${d.freedMb}</strong> MB
            <span class="tbx-dim">（处理 ${d.processes} 个进程${d.failed ? `，${d.failed} 个无权限跳过` : ''}）</span>
          </div>
          <div class="tbx-jrrp__meta">${d.note || ''}</div>`
      );
      toast(`内存优化完成，可用内存约 +${d.freedMb} MB`, 'ok', 4000);
    };

    /* ---------------- 清理垃圾 ---------------- */
    const cleanBody = mount.querySelector('#tbx-clean-body');
    const instId = inst && inst.id;

    const runScan = async () => {
      if (!cleanBody) return;
      if (!instId) {
        setHTML(cleanBody, html`<div class="tbx-warn">还没有实例，先去「下载」装一个游戏版本。</div>`);
        return;
      }
      setHTML(cleanBody, html`<div class="tbx-clean__hint">正在扫描…</div>`);
      const r = await call('toolbox:scanRubbish', { instanceId: instId });
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok) {
        setHTML(cleanBody, html`<div class="tbx-warn">扫描失败：${(d && d.error) || (r && r.error) || '未知错误'}</div>`);
        return;
      }
      if (!d.totalCount) {
        setHTML(cleanBody, html`<div class="tbx-clean__hint">很干净，没有可清理的日志或残骸。</div>`);
        return;
      }
      const rows = d.items
        .slice(0, 60)
        .map(
          (it) => `<li class="tbx-file">
            <span class="tbx-file__name" title="${escAttr(it.rel)}">${escHtml(it.rel)}</span>
            <span class="tbx-file__tag">${escHtml(it.label || '')}</span>
            <span class="tbx-file__size">${fmtBytes(it.size)}</span>
          </li>`
        )
        .join('');
      setHTML(
        cleanBody,
        html`<div class="tbx-clean__sum">
            可清理 <strong>${d.totalCount}</strong> 个文件，共 <strong>${fmtBytes(d.totalBytes)}</strong>
            ${d.items.length > 60 ? html`<span class="tbx-dim">（下面只显示最大的 60 个）</span>` : raw('')}
          </div>
          <ul class="tbx-files">${raw(rows)}</ul>
          <div class="hstack">
            <button class="btn btn--sm" id="tbx-clean-go" type="button">清理这些（移到回收站）</button>
            <button class="btn btn--ghost btn--sm" id="tbx-clean-again" type="button">重新扫描</button>
          </div>
          <div class="tbx-jrrp__meta">只清日志 / 崩溃报告 / 下载残骸；存档、模组、配置、资源包一律不动。删除走回收站，可以还原。</div>`
      );

      const go = cleanBody.querySelector('#tbx-clean-go');
      if (go) {
        go.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '确认清理',
            message: `将把 ${d.totalCount} 个文件（${fmtBytes(d.totalBytes)}）移到回收站。\n\n存档、模组、配置、资源包不会被动。`,
            okText: '移到回收站',
          });
          if (!ok) return;
          go.disabled = true;
          const r2 = await call('toolbox:cleanRubbish', { instanceId: instId, files: d.items.map((x) => x.path) });
          const d2 = r2 && r2.ok ? r2.data : null;
          if (!d2 || !d2.ok) {
            toast(`清理失败：${(d2 && d2.error) || (r2 && r2.error) || '未知错误'}`, 'error', 5000);
            go.disabled = false;
            return;
          }
          const blocked = (d2.blocked || []).length;
          toast(
            `已清理 ${d2.removed} 个文件，释放 ${fmtBytes(d2.bytes)}${blocked ? `（${blocked} 个因安全校验被跳过）` : ''}`,
            'ok',
            5000
          );
          await runScan();
        });
      }
      const again = cleanBody.querySelector('#tbx-clean-again');
      if (again) again.addEventListener('click', () => runScan());
    };

    /* ---------------- 磁盘占用 ---------------- */
    const diskBody = mount.querySelector('#tbx-disk-body');
    const runDisk = async () => {
      if (!diskBody) return;
      if (!instId) {
        setHTML(diskBody, html`<div class="tbx-warn">还没有实例。</div>`);
        return;
      }
      setHTML(diskBody, html`<div class="tbx-clean__hint">正在统计…</div>`);
      const r = await call('toolbox:diskUsage', { instanceId: instId });
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok) {
        setHTML(diskBody, html`<div class="tbx-warn">统计失败：${(d && d.error) || (r && r.error) || '未知错误'}</div>`);
        return;
      }
      if (!d.dirs.length) {
        setHTML(diskBody, html`<div class="tbx-clean__hint">游戏目录还是空的。</div>`);
        return;
      }
      const max = Math.max(1, d.dirs[0].size);
      const rows = d.dirs
        .map((x) => {
          const pct = Math.max(2, Math.round((x.size / max) * 100));
          return `<li class="tbx-disk-row">
            <span class="tbx-disk-row__name">${escHtml(x.name)}</span>
            <span class="tbx-disk-row__bar"><span style="width:${pct}%"></span></span>
            <span class="tbx-disk-row__size">${fmtBytes(x.size)}</span>
            <span class="tbx-disk-row__files">${x.files} 个文件</span>
            <button class="btn btn--ghost btn--xs" type="button" data-open="${escAttr(x.path)}">打开</button>
          </li>`;
        })
        .join('');
      setHTML(
        diskBody,
        html`<div class="tbx-clean__sum">
            合计 <strong>${fmtBytes(d.total.size)}</strong>
            <span class="tbx-dim">（${d.total.files} 个文件，只统计上面这些目录）</span>
          </div>
          <ul class="tbx-disk">${raw(rows)}</ul>`
      );
      diskBody.querySelectorAll('[data-open]').forEach((b) => {
        b.addEventListener('click', async () => {
          const p = b.getAttribute('data-open');
          const rr = await call('shell:openPath', { path: p });
          if (!rr.ok) toast(rr.error || '打不开这个目录', 'error', 4000);
        });
      });
    };

    /* ---------------- 回声洞 ---------------- */
    let caveClicks = 0;
    const runCave = async () => {
      const t = mount.querySelector('#tbx-cave-text');
      const h = mount.querySelector('#tbx-cave-hint');
      const r = await call('toolbox:cave', {});
      const d = r && r.ok ? r.data : null;
      caveClicks += 1;
      if (t) t.textContent = (d && d.cave) || '洞里什么也没有。';
      if (h && caveClicks % 3 === 0) h.textContent = `顺便一提：${(d && d.hint) || ''}`;
    };

    /* ---------------- 下载自定义文件 ---------------- */
    const dlUrl = mount.querySelector('#tbx-dl-url');
    const dlFolder = mount.querySelector('#tbx-dl-folder');
    const dlName = mount.querySelector('#tbx-dl-name');
    const dlState = mount.querySelector('#tbx-dl-state');
    const dlBar = mount.querySelector('#tbx-dl-bar');
    const dlFill = mount.querySelector('#tbx-dl-fill');
    const dlStart = mount.querySelector('#tbx-dl-start');

    let offProgress = null;
    if (typeof on === 'function') {
      offProgress = on('task:progress', (p) => {
        if (!p || p.kind !== 'toolbox-download') return;
        downloadSnap = p;
        if (!dlState || !dlBar || !dlFill) return;
        dlBar.hidden = false;
        const pct = Number.isFinite(p.percent) ? p.percent : 0;
        dlFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        if (p.phase === 'done') {
          dlState.textContent = `完成：${p.name || ''}（${fmtBytes(p.done || 0)}）`;
        } else {
          const sp = p.speed ? ` · ${fmtSpeed(p.speed)}` : '';
          const tot = p.total ? ` / ${fmtBytes(p.total)}` : '';
          dlState.textContent = `${pct.toFixed(1)}% · ${fmtBytes(p.done || 0)}${tot}${sp}`;
        }
      });
    }

    const startDownload = async () => {
      if (downloading) return;
      const url = String((dlUrl && dlUrl.value) || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        toast('请填一个 http/https 下载地址', 'error', 4000);
        if (dlUrl) dlUrl.focus();
        return;
      }
      downloading = true;
      if (dlStart) dlStart.disabled = true;
      if (dlBar) dlBar.hidden = false;
      if (dlFill) dlFill.style.width = '0%';
      if (dlState) dlState.textContent = '准备下载…';
      const r = await call('toolbox:download', {
        url,
        fileName: String((dlName && dlName.value) || '').trim() || undefined,
        folder: String((dlFolder && dlFolder.value) || '').trim() || undefined,
      });
      downloading = false;
      if (dlStart) dlStart.disabled = false;
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok) {
        toast(`下载失败：${(d && d.error) || (r && r.error) || '未知错误'}`, 'error', 6000);
        if (dlState) dlState.textContent = '下载失败';
        return;
      }
      if (dlState) dlState.textContent = `已保存：${d.name}（${fmtBytes(d.bytes)}）`;
      toast(`下载完成：${d.name}`, 'ok', 4500);
    };

    /* ---------------- 千万别点 ---------------- */
    let nopeCount = 0;
    const NOPE_TEXTS = [
      '都说了别点。',
      '你还真点了。',
      '再点就真的会出事……（其实不会）',
      '好吧，这里什么都没有，只有一个无聊的按钮。',
      '你的手是不是比脑子快。',
      '点了也没奖励，最多给你一句：去备份存档吧。',
      '这个按钮的存在意义就是让你点。',
      '嗯，你赢了。要不去玩会儿游戏？',
    ];
    const runNope = () => {
      nopeCount += 1;
      const btn = mount.querySelector('#tbx-nope');
      const t = NOPE_TEXTS[Math.min(nopeCount - 1, NOPE_TEXTS.length - 1)];
      toast(t, 'info', 3000);
      if (btn && nopeCount === 10) btn.textContent = '你还点？（真的没事）';
    };

    /* ---------------- 绑定 ---------------- */
    const bind = (sel, fn) => {
      const el = mount.querySelector(sel);
      if (el) el.addEventListener('click', fn);
    };
    bind('#tbx-jrrp', runJrrp);
    bind('#tbx-mem', runMem);
    bind('#tbx-clean', runScan);
    bind('#tbx-cave', runCave);
    bind('#tbx-nope', runNope);
    bind('#tbx-dl-start', startDownload);
    bind('#tbx-disk-refresh', runDisk);
    bind('#tbx-dl-open', async () => {
      const r = await call('toolbox:openDownloadDir', { folder: String((dlFolder && dlFolder.value) || '').trim() || undefined });
      if (!r.ok) toast(r.error || '打不开下载目录', 'error', 4000);
    });
    bind('#tbx-dl-pick', async () => {
      const r = await call('toolbox:pickFolder', { current: String((dlFolder && dlFolder.value) || '').trim() || undefined });
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok || d.canceled) return;
      if (dlFolder) dlFolder.value = d.dir;
    });

    // 进页面就先算一次人品 + 统计一次磁盘（都很快）
    runJrrp();
    runDisk();

    // 页面卸载时解绑进度订阅
    return {
      destroy() {
        if (typeof offProgress === 'function') offProgress();
      },
    };
  },
};

/* ---------------- 小工具 ---------------- */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) {
  return escHtml(s).replace(/\s+/g, ' ').trim();
}
