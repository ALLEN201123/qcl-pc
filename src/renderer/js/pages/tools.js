/**
 * Quanta Craft Launcher PC · 工具页
 *
 * ★ 这一页取代安卓版的「实验室」。
 *
 * 为什么换：安卓的实验室是手机上的实验小工具（合成表/配方查询等），
 * PC 上有更好用的外部方案，照搬没有意义。这里换成 **PC 用户真正需要的三件事**：
 *
 *   1. **实例文件夹** —— 一键打开 `.minecraft`、`mods`、`saves`、`logs`，
 *      不用自己在磁盘里翻。这是 PC 启动器最常被用到的入口。
 *   2. **崩溃日志分析** —— 扫描 `crash-reports/` 与 `logs/latest.log`，
 *      把最常见的崩溃原因（Java 版本不对、内存不足、模组冲突、OpenGL 问题）
 *      用中文讲给用户听，而不是让他自己去看满屏 at xxx。
 *   3. **实例备份** —— 把整个实例打包成 zip（含存档与配置），换电脑时带走。
 */

import { html, setHTML, raw, toast, emptyState, fmtBytes, confirmDialog, promptDialog } from '../ui.js';
import { call, hasMain } from '../bridge.js';
import { state } from '../store.js';
import { icon } from '../icons.js';

export const toolsPage = {
  id: 'tools',
  title: '工具',
  render(mount) {
    const inst = state.instances.find((x) => x.id === state.settings.selectedInstance) || state.instances[0];

    setHTML(
      mount,
      html`<div class="page page--tools">
        <div class="page__head">
          <div class="page__title">工具</div>
          <div class="page__sub">实例文件夹 · 崩溃分析 · 实例备份</div>
        </div>

        ${inst
          ? html`<div class="tool-instance-bar">
              <span class="tool-instance-bar__label">当前实例</span>
              <span class="tool-instance-bar__name">${inst.name}</span>
              <span class="badge">${inst.mcVersion}</span>
            </div>`
          : raw('')}

        <div class="tool-grid">
          <!-- 1. 实例文件夹 -->
          <section class="card tool-card">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('folder', 18))}</span>
              <div>
                <div class="tool-card__title">实例文件夹</div>
                <div class="tool-card__desc">直接打开游戏目录，免去在磁盘里翻找</div>
              </div>
            </div>
            ${renderFolderButtons(inst)}
          </section>

          <!-- 2. 崩溃日志分析 -->
          <section class="card tool-card">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('warning', 18))}</span>
              <div>
                <div class="tool-card__title">崩溃日志分析</div>
                <div class="tool-card__desc">用中文告诉你为什么崩，不用自己看堆栈</div>
              </div>
            </div>
            <div class="tool-actions">
              <button class="btn btn--sm" id="tool-analyze" type="button" ${inst ? '' : 'disabled'}>分析最近一次崩溃</button>
              <button class="btn btn--ghost btn--sm" id="tool-open-logs" type="button" ${inst ? '' : 'disabled'}>打开日志目录</button>
            </div>
            <div class="tool-result" id="tool-analyze-result"></div>
          </section>

          <!-- 3. 实例备份 -->
          <section class="card tool-card">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('pack', 18))}</span>
              <div>
                <div class="tool-card__title">实例备份</div>
                <div class="tool-card__desc">把整个实例（含存档与配置）打包带走</div>
              </div>
            </div>
            <div class="tool-actions">
              <button class="btn btn--sm" id="tool-backup" type="button" ${inst ? '' : 'disabled'}>备份这个实例</button>
            </div>
            <div class="tool-result" id="tool-backup-result"></div>
          </section>

          <!-- 4. 启动日志（原侧边栏「上次启动日志」并入此处） -->
          <section class="card tool-card tool-card--wide">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('file', 18))}</span>
              <div>
                <div class="tool-card__title">启动日志</div>
                <div class="tool-card__desc">实时输出 + 上次启动日志（原侧边栏入口已并入这里）</div>
              </div>
            </div>
            <div class="tool-actions">
              <button class="btn btn--ghost btn--sm" id="tool-log-recent" type="button">读取上次日志</button>
              <button class="btn btn--ghost btn--sm" id="tool-log-copy" type="button">复制全部</button>
              <button class="btn btn--ghost btn--sm" id="tool-log-clear" type="button">清屏</button>
            </div>
            <pre class="tool-log" id="tool-log-view">（点上面的「读取上次日志」查看最近一次启动/安装的完整输出）</pre>
          </section>

          <!-- 5. 整合包导入导出 -->
          <section class="card tool-card">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('pack', 18))}</span>
              <div>
                <div class="tool-card__title">整合包</div>
                <div class="tool-card__desc">把实例导出成整合包，或从 zip 导入</div>
              </div>
            </div>
            <div class="tool-actions">
              <button class="btn btn--sm" id="tool-export-pack" type="button" ${inst ? '' : 'disabled'}>导出为整合包</button>
              <button class="btn btn--ghost btn--sm" id="tool-import-pack" type="button" ${inst ? '' : 'disabled'}>导入整合包</button>
            </div>
            <div class="tool-result" id="tool-pack-result"></div>
          </section>

          <!-- 6. 快捷键与使用提示 -->
          <section class="card tool-card tool-card--wide">
            <div class="tool-card__head">
              <span class="tool-card__icon">${raw(icon('info', 18))}</span>
              <div>
                <div class="tool-card__title">快捷键与提示</div>
                <div class="tool-card__desc">PC 版专属的一些小便利</div>
              </div>
            </div>
            <ul class="tool-hints">
              <li><kbd>Ctrl</kbd> + <kbd>,</kbd> 打开设置</li>
              <li><kbd>F5</kbd> 刷新版本列表与实例</li>
              <li><kbd>Esc</kbd> 关闭弹窗 / 返回上一层</li>
              <li>主页人物：拖拽旋转、滚轮缩放、双击复位</li>
              <li>启动器关闭后游戏<strong>不会</strong>跟着退出（与手机不同）</li>
            </ul>
          </section>
        </div>
      </div>`
    );

    bindTools(mount, inst);
  }
};

function renderFolderButtons(inst) {
  if (!inst) return html`<div class="tool-empty">还没有实例，先去「下载」装一个版本</div>`;
  const base = inst.dir;
  const buttons = [
    ['游戏目录', `${base}\\.minecraft`],
    ['模组目录', `${base}\\.minecraft\\mods`],
    ['存档目录', `${base}\\.minecraft\\saves`],
    ['日志目录', `${base}\\.minecraft\\logs`]
  ];
  return html`<div class="tool-actions">
    ${buttons.map(
      ([label, p]) =>
        html`<button class="btn btn--ghost btn--sm" type="button" data-open-path="${p}" title="${p}">${label}</button>`
    )}
  </div>`;
}

function bindTools(mount, inst) {
  // 打开文件夹
  mount.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-open-path]');
    if (!btn) return;
    const p = btn.dataset.openPath;
    const r = await call('shell:openPath', { path: p });
    if (!r.ok) toast(r.error || `打不开：${p}`, 'warn');
  });

  const analyzeBtn = mount.querySelector('#tool-analyze');
  if (analyzeBtn && inst) {
    analyzeBtn.addEventListener('click', async () => {
      const box = mount.querySelector('#tool-analyze-result');
      setHTML(box, html`<div class="skeleton skeleton--row"></div>`);
      // ★ bridge.call 返回 { ok, data, error }，数据在 .data
      const res = await call('tools:analyzeCrash', { id: inst.id });
      if (!res.ok) {
        setHTML(box, html`<div class="tool-warn">${res.error || '分析失败'}</div>`);
        return;
      }
      const r = res.data || {};
      if (!r.found) {
        setHTML(box, html`<div class="tool-ok">没找到崩溃报告 —— 说明最近一次启动是正常的。</div>`);
        return;
      }
      setHTML(
        box,
        html`<div class="tool-crash">
          <div class="tool-crash__file">${r.file}</div>
          ${r.reasons.length
            ? html`<ul class="tool-crash__list">
                ${r.reasons.map((x) => html`<li><strong>${x.title}</strong><span>${x.detail}</span></li>`)}
              </ul>`
            : html`<div class="tool-warn">报告里没有匹配到已知的崩溃模式，下面是原始片段：</div>`}
          <details class="tool-crash__raw">
            <summary>查看原始日志片段</summary>
            <pre>${r.excerpt || ''}</pre>
          </details>
        </div>`
      );
    });
  }

  const openLogs = mount.querySelector('#tool-open-logs');
  if (openLogs && inst) {
    openLogs.addEventListener('click', async () => {
      const r = await call('shell:openPath', { path: `${inst.dir}\\.minecraft\\logs` });
      if (!r.ok) toast(r.error || '打不开日志目录', 'warn');
    });
  }

  const backupBtn = mount.querySelector('#tool-backup');
  if (backupBtn && inst) {
    backupBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '备份实例',
        message: `将把「${inst.name}」整个目录打包成 zip，存到 QCL 的 backups 目录。存档与配置都会包含在内。`,
        confirmText: '开始备份'
      });
      if (!ok) return;
      const box = mount.querySelector('#tool-backup-result');
      setHTML(box, html`<div class="skeleton skeleton--row"></div>`);
      const res = await call('tools:backupInstance', { id: inst.id });
      if (!res.ok) {
        setHTML(box, html`<div class="tool-warn">${res.error || '备份失败'}</div>`);
        return;
      }
      const r = res.data || {};
      setHTML(
        box,
        html`<div class="tool-ok">
          备份完成：<span class="mono">${r.file}</span>（${fmtBytes(r.bytes)}）
          <button class="btn btn--ghost btn--sm" type="button" data-open-path="${r.dir}">打开所在目录</button>
        </div>`
      );
    });
  }

  /* ---- 启动日志（原侧边栏「上次启动日志」并入）---- */
  const logView = mount.querySelector('#tool-log-view');
  const recentBtn = mount.querySelector('#tool-log-recent');
  const copyBtn = mount.querySelector('#tool-log-copy');
  const clearBtn = mount.querySelector('#tool-log-clear');

  const renderLogLines = (lines) => {
    if (!logView) return;
    logView.textContent = lines.length ? lines.join('\n') : '（日志是空的）';
    logView.scrollTop = logView.scrollHeight;
  };

  if (recentBtn && logView) {
    recentBtn.addEventListener('click', async () => {
      logView.textContent = '正在读取…';
      const res = await call('log:recent', { limit: 2000 });
      const lines = Array.isArray(res && res.data) ? res.data : null;
      if (!lines) {
        logView.textContent = '读取失败（主进程未就绪）';
        return;
      }
      renderLogLines(lines);
      if (!lines.length) logView.textContent = '还没有日志 —— 先启动一次游戏或安装一个版本。';
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = logView ? logView.textContent || '' : '';
      if (!text.trim()) {
        toast('没有可复制的内容', 'warn');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast('日志已复制到剪贴板', 'ok', 1800);
      } catch {
        toast('复制失败，请手动选中复制', 'warn');
      }
    });
  }
  if (clearBtn && logView) {
    clearBtn.addEventListener('click', () => {
      logView.textContent = '（已清屏）';
    });
  }

  /* ---- 整合包导出 / 导入 ---- */
  const packBox = mount.querySelector('#tool-pack-result');

  const exportBtn = mount.querySelector('#tool-export-pack');
  if (exportBtn && inst) {
    exportBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '导出整合包',
        message: `把「${inst.name}」导出成整合包 zip（含模组 + 配置 + 资源包）。\n存档默认不打包，需要的话先备份实例。`,
        confirmText: '导出'
      });
      if (!ok) return;
      exportBtn.disabled = true;
      setHTML(packBox, html`<div class="skeleton skeleton--row"></div>`);
      const res = await call('modpack:export', { id: inst.id, includeSaves: false });
      exportBtn.disabled = false;
      if (!res.ok) {
        setHTML(packBox, html`<div class="tool-warn">${res.error || '导出失败'}</div>`);
        return;
      }
      const r = res.data || {};
      setHTML(
        packBox,
        html`<div class="tool-ok">
          整合包已导出：<span class="mono">${r.file}</span>
          （${fmtBytes(r.bytes)}，模组 ${r.mods} 个）
          <button class="btn btn--ghost btn--sm" type="button" data-open-path="${r.dir}">打开所在目录</button>
        </div>`
      );
    });
  }

  const importBtn = mount.querySelector('#tool-import-pack');
  if (importBtn && inst) {
    importBtn.addEventListener('click', async () => {
      const p = await promptDialog({
        title: '导入整合包',
        message: '填写整合包 zip 的完整路径（支持 QCL 导出的格式，也支持人工打包的 .minecraft 文件夹 zip）。',
        placeholder: 'D:\\下载\\整合包.zip',
        confirmText: '导入'
      });
      if (!p) return;
      const zipPath = String(p).trim();
      if (!zipPath) return;

      setHTML(packBox, html`<div class="skeleton skeleton--row"></div>`);
      // 先检查这个 zip 是什么
      const inspectRes = await call('modpack:inspect', { path: zipPath });
      if (!inspectRes.ok) {
        setHTML(packBox, html`<div class="tool-warn">${inspectRes.error || '无法识别这个文件'}</div>`);
        return;
      }
      const meta = inspectRes.data || {};
      if (!meta.isModpack) {
        setHTML(
          packBox,
          html`<div class="tool-warn">
            这个 zip 里没有 mods/、config/、saves/ 这些目录，不像是整合包。
          </div>`
        );
        return;
      }

      // 人工打包的整合包要提醒（照安卓版的做法）
      const warning = meta.ours
        ? `检测到 QCL 整合包「${meta.name}」，将导入到「${inst.name}」。`
        : `这个整合包不是 QCL 导出的（${meta.rawPack ? '看起来是人工打包的 .minecraft 文件夹' : '来自其他启动器'}）。\n` +
          `导入会把其中的文件直接覆盖到当前实例，可能与现有模组冲突。是否继续？`;
      const ok = await confirmDialog({
        title: '确认导入',
        message: warning,
        confirmText: '开始导入'
      });
      if (!ok) return;

      importBtn.disabled = true;
      setHTML(packBox, html`<div class="skeleton skeleton--row"></div>`);
      const res = await call('modpack:import', { id: inst.id, path: zipPath, overwrite: true });
      importBtn.disabled = false;
      if (!res.ok) {
        setHTML(packBox, html`<div class="tool-warn">${res.error || '导入失败'}</div>`);
        return;
      }
      const r = res.data || {};
      setHTML(
        packBox,
        html`<div class="tool-ok">
          导入完成：写入 ${r.extracted} 个文件${r.skipped ? `，跳过 ${r.skipped} 个` : ''}。
          到「模组管理」看看装进来了什么。
        </div>`
      );
    });
  }
}
