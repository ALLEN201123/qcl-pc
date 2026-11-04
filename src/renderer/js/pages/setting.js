/**
 * QCL 电脑版 · 设置
 *
 * 外观（主题色取色器 + 昼夜 + 壁纸 + 面板透明度）/ Java / 内存 / 下载源 / 启动 / 关于。
 * 全部通过 `settings:set` 落盘，并即时应用到 CSS 变量（乐观更新，点了立刻有反馈）。
 */

import { call } from '../bridge.js';
import { state, saveSettings, loadJava } from '../store.js';
import { WALLPAPERS, ACCENT_PRESETS, applyTheme, wallpaperLabel } from '../theme.js';
import { html, raw, setHTML, toast, fmtDateTime } from '../ui.js';
import { icon } from '../icons.js';
import * as router from '../router.js';

const TABS = [
  { id: 'appearance', label: '外观' },
  { id: 'game', label: '游戏' },
  { id: 'java', label: 'Java' },
  { id: 'memory', label: '内存' },
  { id: 'download', label: '下载' },
  { id: 'launch', label: '启动' },
  { id: 'about', label: '关于' },
];

export const settingPage = {
  id: 'setting',
  title: '设置',
  async render(mount) {
    let tab = 'appearance';

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">设置</div>
          <div class="page__sub">改动会立即生效并保存</div>
        </div>
        <div class="set">
          <div class="set__side" id="st-tabs">
            ${TABS.map(
              (t, i) => raw(`<button class="vset__tab ${i === 0 ? 'is-active' : ''}" type="button" data-tab="${t.id}">${t.label}</button>`)
            )}
          </div>
          <div class="set__pane" id="st-pane"></div>
        </div>
      </div>`
    );

    const pane = mount.querySelector('#st-pane');
    mount.querySelector('#st-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      tab = btn.dataset.tab;
      mount.querySelectorAll('#st-tabs .vset__tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      draw();
    });

    async function save(partial, okMsg) {
      const r = await saveSettings(partial);
      if (!r.ok && r.error) toast(r.error, 'error', 5000);
      else if (okMsg) toast(okMsg, 'ok', 1800);
      return r;
    }

    function draw() {
      if (tab === 'appearance') return drawAppearance();
      if (tab === 'game') return drawGame();
      if (tab === 'java') return drawJava();
      if (tab === 'memory') return drawMemory();
      if (tab === 'download') return drawDownload();
      if (tab === 'launch') return drawLaunch();
      return drawAbout();
    }

    /* ------------------------------ 游戏 ------------------------------ */

    /**
     * 全局游戏设置（照安卓版「全局游戏设置」里 PC 适用的部分移植，2026-11-05 加）。
     *
     * ★ 有意**不移植**的手机专属项（移植过来在 PC 上毫无意义）：
     *     ✗ PojavRenderer（安卓的 GL4ES/Zink/Vulkan 渲染器）
     *     ✗ 触屏控制布局 / 触摸注入
     *     ✗ 运行时位数（PC 直接跟随系统架构）
     *     ✗ 游戏启动器选择（Pojav 专属）
     *     ✗ 版本隔离（PC 的实例各自独立目录，本来就是隔离的）
     */
    function drawGame() {
      const g = state.settings.game || {};
      const res = g.resolution || {};
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">游戏窗口</div>
            <div class="field">
              <div class="field__label">分辨率</div>
              <div class="field__row">
                <input class="input input--sm" id="st-res-w" type="number" min="320" max="7680" value="${res.width || 854}" /> ×
                <input class="input input--sm" id="st-res-h" type="number" min="240" max="4320" value="${res.height || 480}" />
                <button class="btn" id="st-res-save" type="button">保存</button>
              </div>
              <div class="field__hint">默认 854×480。常用：1280×720、1920×1080。启动时可在启动窗口里临时覆盖。</div>
            </div>

            <div class="field">
              <div class="field__label">服务器地址</div>
              <div class="field__row">
                <input class="input" id="st-server" placeholder="例如 play.example.com:25565（留空则正常进主菜单）" value="${g.serverAddress || ''}" />
                <button class="btn" id="st-server-save" type="button">保存</button>
              </div>
              <div class="field__hint">填了之后每次启动都会自动连这个服务器。1.6 以前的远古版本不支持，会自动忽略。</div>
            </div>

            <div class="field">
              <div class="field__label">游戏窗口类型</div>
              <div class="field__row">
                <select class="input" id="st-windowtype">
                  <option value="windowed" ${(g.windowType || 'windowed') === 'windowed' ? 'selected' : ''}>窗口化</option>
                  <option value="maximized" ${g.windowType === 'maximized' ? 'selected' : ''}>最大化</option>
                  <option value="fullscreen" ${g.windowType === 'fullscreen' ? 'selected' : ''}>全屏</option>
                </select>
                <button class="btn" id="st-windowtype-save" type="button">保存</button>
              </div>
              <div class="field__hint">照 HMCL 的「游戏窗口类型」。全屏会忽略上面的分辨率。版本设置里可以为单个实例覆盖。</div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">默认版本隔离策略</div>
            <div class="field__hint" style="margin-bottom:10px">
              照 HMCL 的「默认版本隔离策略」。决定**新装实例**默认是否隔离游戏目录。<br />
              ★ 当前每个实例都放在 <span class="mono">&lt;QCL主目录&gt;/instances/&lt;id&gt;/.minecraft/</span>，
              连 libraries 和 assets 都是独立的 —— 比 HMCL 的隔离更彻底，但也更占磁盘。
            </div>
            <div class="field">
              <div class="field__row">
                <select class="input" id="st-isolation">
                  <option value="always" ${(g.defaultIsolation || 'always') === 'always' ? 'selected' : ''}>隔离所有实例（推荐，默认）</option>
                  <option value="modded" ${g.defaultIsolation === 'modded' ? 'selected' : ''}>隔离模组实例</option>
                  <option value="never" ${g.defaultIsolation === 'never' ? 'selected' : ''}>不隔离实例</option>
                </select>
                <button class="btn" id="st-isolation-save" type="button">保存</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">文件校验</div>
            <div class="field__hint" style="margin-bottom:10px">
              「关闭文件校验」= 启动前不再比对 libraries / assets / 客户端 jar 的完整性。
              <strong>正常情况下请保持开启</strong> —— 开着才能在文件损坏时自动补回来。
              <br />
              只有在<strong>确定游戏文件被你自己改过</strong>（手动装了 mod、替换过 jar）时才关掉，
              否则启动器会把你的改动当成「损坏」还原掉。
              <br />
              ★ 单个版本要单独关的话，去「版本设置 → 高级」——
              <strong>实例级设置优先于这里</strong>。
            </div>
            <label class="vset-check">
              <input type="checkbox" id="st-no-check-files" ${state.settings.checkGameFiles === false ? 'checked' : ''} />
              <span>关闭文件校验（不检查游戏文件的完整性）</span>
            </label>
            <div class="field__hint" id="st-check-hint" style="margin-left:4px;margin-top:8px">
              ${state.settings.checkGameFiles === false
                ? '⚠ 当前：全局已关闭 —— 所有版本都不会做完整性校验'
                : '当前：全局开启 —— 启动前会校验并自动修复损坏文件'}
            </div>
          </div>

          <div class="card">
            <div class="card__title">游戏语言</div>
            <div class="field__hint" style="margin-bottom:10px;line-height:1.75">
              启动前自动把游戏界面语言设成中文，省得玩家自己进 Options → Language 里翻。<br />
              <strong>大小写会按版本自动判断</strong>（这一步很关键）：
              1.1~1.10 用 <span class="mono">zh_CN</span>，
              1.11 及以后用 <span class="mono">zh_cn</span>；
              <strong>1.0 及更早完全不写</strong>（那两个世代没有这个字段，写了会崩）；
              远古版本靠中文补丁，也不碰。
            </div>
            <label class="vset-check">
              <input type="checkbox" id="st-force-chinese" ${g.forceChinese !== false ? 'checked' : ''} />
              <span>预设游戏语言为中文（简体）</span>
            </label>
          </div>

          <div class="card">
            <div class="card__title">下载内容重复时</div>
            <div class="field__hint" style="margin-bottom:10px;line-height:1.75">
              模组 / 资源包 / 光影下载到实例目录后，如果<strong>同一个项目又下了一次</strong>怎么处理。<br />
              <strong>覆盖（默认）</strong>最省心：换版本时自动删掉旧 jar。
              否则 mods 目录会同时留着两份，游戏会同时加载导致冲突甚至崩溃。<br />
              ★ 重复下<strong>完全相同</strong>的文件（sha1 一致）一律跳过，不会浪费流量。
            </div>
            <div class="field">
              <div class="field__row">
                <select class="input" id="st-content-overwrite">
                  <option value="replace" ${(g.contentOverwrite || 'replace') === 'replace' ? 'selected' : ''}>覆盖（推荐，默认）—— 换版本时删掉旧文件</option>
                  <option value="skip" ${g.contentOverwrite === 'skip' ? 'selected' : ''}>跳过 —— 已存在就不动</option>
                  <option value="keep" ${g.contentOverwrite === 'keep' ? 'selected' : ''}>保留两者 —— 新旧都留着（可能冲突）</option>
                </select>
                <button class="btn" id="st-content-overwrite-save" type="button">保存</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">自动安装</div>
            <div class="vset-check" style="margin-bottom:8px">
              <input type="checkbox" id="st-auto-deps" ${g.autoInstallDependencies !== false ? 'checked' : ''} />
              <span>启动前自动补齐缺失的依赖库与资源（libraries / assets）</span>
            </div>
            <div class="vset-check">
              <input type="checkbox" id="st-auto-java" ${g.autoInstallJava !== false ? 'checked' : ''} />
              <span>找不到匹配的 Java 时自动下载</span>
            </div>
          </div>

          <div class="card">
            <div class="card__title">图形 API</div>
            <div class="field">
              <div class="field__row">
                <select class="input" id="st-gfx">
                  <option value="default" ${(g.graphicsBackend || 'default') === 'default' ? 'selected' : ''}>默认（遵循游戏设置）</option>
                  <option value="opengl" ${g.graphicsBackend === 'opengl' ? 'selected' : ''}>OpenGL</option>
                  <option value="vulkan" ${g.graphicsBackend === 'vulkan' ? 'selected' : ''}>Vulkan</option>
                </select>
                <button class="btn" id="st-gfx-save" type="button">保存</button>
              </div>
              <div class="field__hint">仅对 Minecraft 26.2+ 生效。Vulkan 在部分显卡上更流畅，但驱动不支持会启动失败。</div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">内存分配</div>
            <div class="field">
              <div class="field__label">最低分配（-Xms）</div>
              <div class="field__row">
                <input class="input input--sm" id="st-minmem" type="number" min="256" max="8192" step="256" value="${g.minMemoryMb || 512}" /> MB
                <button class="btn" id="st-minmem-save" type="button">保存</button>
              </div>
              <div class="field__hint">
                游戏一启动就预留的堆大小。512 MB 够用；如果进世界经常卡顿可以调到 1024~2048。
                不能超过「内存」标签里的最大分配。
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">调试</div>
            <label class="vset-check">
              <input type="checkbox" id="st-debug-log" ${g.debugLog !== false ? 'checked' : ''} />
              <span>记录完整游戏日志到 logs/latest.log（排查崩溃用，建议开启）</span>
            </label>
            <label class="vset-check">
              <input type="checkbox" id="st-keep-open" ${g.keepLauncherOpen ? 'checked' : ''} />
              <span>游戏启动后保持启动器窗口在前台</span>
            </label>
          </div>`
      );

      const saveGame = (patch, msg) => save({ game: { ...g, ...patch } }, msg);

      const rs = pane.querySelector('#st-res-save');
      if (rs) {
        rs.addEventListener('click', () => {
          const w = Math.max(320, Math.min(7680, Number(pane.querySelector('#st-res-w').value) || 854));
          const h = Math.max(240, Math.min(4320, Number(pane.querySelector('#st-res-h').value) || 480));
          saveGame({ resolution: { width: w, height: h } }, `分辨率已设为 ${w}×${h}`);
        });
      }

      const ss = pane.querySelector('#st-server-save');
      if (ss) {
        ss.addEventListener('click', () => {
          const v = String(pane.querySelector('#st-server').value || '').trim();
          saveGame({ serverAddress: v }, v ? `启动后会自动进入 ${v}` : '已清空服务器地址');
        });
      }

      const ms = pane.querySelector('#st-minmem-save');
      if (ms) {
        ms.addEventListener('click', () => {
          const v = Math.max(256, Math.min(8192, Number(pane.querySelector('#st-minmem').value) || 512));
          saveGame({ minMemoryMb: v }, `最低分配已设为 ${v} MB`);
        });
      }

      const dl = pane.querySelector('#st-debug-log');
      if (dl) dl.addEventListener('change', () => saveGame({ debugLog: dl.checked }, '已保存'));

      const ko = pane.querySelector('#st-keep-open');
      if (ko) ko.addEventListener('change', () => saveGame({ keepLauncherOpen: ko.checked }, '已保存'));

      /* ---- 窗口类型 / 隔离策略 / 自动安装 / 图形 API（照 HMCL）---- */
      const wt = pane.querySelector('#st-windowtype-save');
      if (wt) {
        wt.addEventListener('click', () => {
          const v = pane.querySelector('#st-windowtype').value;
          saveGame({ windowType: v }, `窗口类型已设为「${v === 'fullscreen' ? '全屏' : v === 'maximized' ? '最大化' : '窗口化'}」`);
        });
      }

      const iso = pane.querySelector('#st-isolation-save');
      if (iso) {
        iso.addEventListener('click', () => {
          const v = pane.querySelector('#st-isolation').value;
          const label = v === 'always' ? '隔离所有实例' : v === 'modded' ? '隔离模组实例' : '不隔离实例';
          saveGame({ defaultIsolation: v }, `默认版本隔离策略已设为「${label}」`);
        });
      }

      const ad = pane.querySelector('#st-auto-deps');
      if (ad) ad.addEventListener('change', () => saveGame({ autoInstallDependencies: ad.checked }, '已保存'));

      /* 预设中文语言开关 */
      const fc = pane.querySelector('#st-force-chinese');
      if (fc) {
        fc.addEventListener('change', () =>
          saveGame(
            { forceChinese: fc.checked },
            fc.checked ? '已开启：下次启动会把游戏语言设成中文（大小写按版本自动判断）' : '已关闭：不再改动游戏语言'
          )
        );
      }

      /* 下载内容重复时的策略 */
      const ow = pane.querySelector('#st-content-overwrite-save');
      if (ow) {
        ow.addEventListener('click', () => {
          const sel = pane.querySelector('#st-content-overwrite');
          const v = sel ? sel.value : 'replace';
          const label =
            v === 'replace' ? '覆盖（换版本时删掉旧文件）' : v === 'skip' ? '跳过已存在' : '保留两者';
          saveGame({ contentOverwrite: v }, `下载重复处理已设为「${label}」`);
        });
      }

      /**
       * 全局「关闭文件校验」。
       * ★ 注意：它写的是**顶层** `checkGameFiles`，不是 game 子对象 ——
       *   后端 gamecheck 读的就是 `settings.checkGameFiles`。
       */
      const ncf = pane.querySelector('#st-no-check-files');
      if (ncf) {
        ncf.addEventListener('change', async () => {
          const r = await save({ checkGameFiles: !ncf.checked });
          if (r && r.ok) {
            toast(
              ncf.checked
                ? '已全局关闭文件校验：所有版本启动前都不再比对文件完整性'
                : '已全局开启文件校验：启动前会校验并自动修复损坏文件',
              ncf.checked ? 'warn' : 'ok',
              3200
            );
            draw();
          }
        });
      }

      const aj = pane.querySelector('#st-auto-java');
      if (aj) aj.addEventListener('change', () => saveGame({ autoInstallJava: aj.checked }, '已保存'));

      const gfx = pane.querySelector('#st-gfx-save');
      if (gfx) {
        gfx.addEventListener('click', () => {
          const v = pane.querySelector('#st-gfx').value;
          saveGame({ graphicsBackend: v }, `图形 API 已设为「${v}」`);
        });
      }
    }

    /* ------------------------------ 外观 ------------------------------ */

    function drawAppearance() {
      const t = state.settings.theme;
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">主题色</div>
            <div class="preview-row">
              <input class="colorpick" type="color" id="st-accent" value="${t.accent}" title="选择主题色" />
              <div class="swatches" id="st-presets">
                ${ACCENT_PRESETS.map(
                  (c) =>
                    html`<button class="swatch ${c.toLowerCase() === String(t.accent).toLowerCase() ? 'is-active' : ''}" type="button" data-color="${c}" style="background:${c}" title="${c}"></button>`
                )}
              </div>
              <span class="mono grow" id="st-accent-text">${t.accent}</span>
              <div class="accent-preview" id="st-accent-preview">启动游戏</div>
            </div>
            <div class="field__hint" style="margin-top:8px">
              默认 <span class="mono">#865D58</span>（苍白花园取色，与安卓版 colorAccent 一致）。
              按钮一律「深底浅字」：底色跟随主题色，文字固定为 <span class="mono">#F2F6FA</span>。
            </div>
          </div>

          <div class="card">
            <div class="card__title">昼夜模式</div>
            <div class="segmented" id="st-mode">
              <button class="segmented__item ${t.mode === 'auto' ? 'is-active' : ''}" type="button" data-m="auto">跟随系统</button>
              <button class="segmented__item ${t.mode === 'light' ? 'is-active' : ''}" type="button" data-m="light">始终浅色</button>
              <button class="segmented__item ${t.mode === 'night' ? 'is-active' : ''}" type="button" data-m="night">始终夜间</button>
            </div>
            <div class="field__hint" style="margin-top:8px">
              浅色 = 近白半透明面板 + 深色文字；夜间 = 深色半透明面板 + 白色文字。两种模式的对比度都经过成对校验。
            </div>
          </div>

          <div class="card">
            <div class="card__title">面板底色</div>
            <div class="preview-row">
              <input class="colorpick" type="color" id="st-panel-color" value="${t.panelColor || (document.documentElement.dataset.mode === 'night' ? '#171C22' : '#EDEDED')}" title="选择面板底色" />
              <span class="mono grow" id="st-panel-color-text">${t.panelColor || '跟随昼夜（推荐）'}</span>
              <button class="btn btn--ghost btn--sm" id="st-panel-reset" type="button">恢复默认</button>
            </div>
            <div class="field__hint" style="margin-top:8px">
              这是左右浮层与卡片的底色，配合下面的「面板透明度」决定壁纸透上来多少。
              留空 = 跟随昼夜自动切换（浅色近白 / 夜间深色），这也是安卓版 1.5.2「重置面板色」的默认行为。
            </div>
          </div>

          <div class="card">
            <div class="card__title">壁纸</div>
            <div class="segmented" id="st-wall-mode" style="margin-bottom:12px">
              <button class="segmented__item ${t.wallpaperRotate ? '' : 'is-active'}" type="button" data-rot="0">固定壁纸</button>
              <button class="segmented__item ${t.wallpaperRotate ? 'is-active' : ''}" type="button" data-rot="1">自动轮换</button>
            </div>
            <div class="wallpaper-grid" id="st-wallpapers">
              ${WALLPAPERS.map(
                (w) =>
                  html`<div class="wallpaper-item ${w.id === t.wallpaperId ? 'is-active' : ''}" data-w="${w.id}">
                    <img src="${w.file}" alt="${w.label}" />
                    <div class="wallpaper-item__label">${w.label}</div>
                  </div>`
              )}
            </div>
            <div class="field" style="margin-top:12px">
              <div class="field__label">自定义图片路径（可选）</div>
              <div class="field__row">
                <input class="input" id="st-wall-file" placeholder="D:\\图片\\壁纸.jpg" value="${String(t.wallpaperId).startsWith('file:') ? String(t.wallpaperId).slice(5) : ''}" />
                <button class="btn btn--ghost" id="st-wall-apply" type="button">使用这张</button>
              </div>
              <div class="field__hint">当前：<strong>${wallpaperLabel(t.wallpaperId)}</strong>。壁纸用 cover 铺满整张卡片，不拉伸变形。</div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">面板透明度</div>
            <div class="field">
              <div class="field__label">
                左右浮层不透明度
                <span class="grow"></span>
                <span class="mono" id="st-alpha-value">${Math.round(t.panelAlpha * 100)}%</span>
              </div>
              <input class="slider" id="st-alpha" type="range" min="0.3" max="1" step="0.05" value="${t.panelAlpha}" />
              <div class="field__hint">越小越透（壁纸更明显），越大面板越实（文字更清晰）。默认 70%。</div>
            </div>
          </div>`
      );

      const accentInput = pane.querySelector('#st-accent');
      const accentText = pane.querySelector('#st-accent-text');
      const preview = pane.querySelector('#st-accent-preview');

      function previewAccent(color) {
        accentText.textContent = color;
        preview.style.background = color;
        applyTheme({ theme: Object.assign({}, state.settings.theme, { accent: color }) });
      }

      accentInput.addEventListener('input', () => previewAccent(accentInput.value));
      accentInput.addEventListener('change', () => save({ theme: { accent: accentInput.value } }, '主题色已保存'));
      pane.querySelector('#st-presets').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-color]');
        if (!btn) return;
        const c = btn.dataset.color;
        accentInput.value = c;
        pane.querySelectorAll('#st-presets .swatch').forEach((s) => s.classList.toggle('is-active', s === btn));
        previewAccent(c);
        save({ theme: { accent: c } }, '主题色已保存');
      });

      pane.querySelector('#st-mode').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-m]');
        if (!btn) return;
        pane.querySelectorAll('#st-mode .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
        save({ theme: { mode: btn.dataset.m } }, '昼夜模式已切换');
      });

      /* ---- 面板底色（照安卓版 1.5.2 的「面板色 + 重置面板色」）---- */
      const panelColorInput = pane.querySelector('#st-panel-color');
      const panelColorText = pane.querySelector('#st-panel-color-text');
      if (panelColorInput) {
        panelColorInput.addEventListener('change', () => {
          const c = panelColorInput.value;
          if (panelColorText) panelColorText.textContent = c;
          save({ theme: { panelColor: c } }, '面板底色已保存');
        });
      }
      const panelReset = pane.querySelector('#st-panel-reset');
      if (panelReset) {
        panelReset.addEventListener('click', () => {
          if (panelColorText) panelColorText.textContent = '跟随昼夜（推荐）';
          save({ theme: { panelColor: '' } }, '面板底色已恢复默认');
        });
      }

      /* ---- 壁纸：固定 / 自动轮换 ---- */
      const wallMode = pane.querySelector('#st-wall-mode');
      if (wallMode) {
        wallMode.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-rot]');
          if (!btn) return;
          wallMode.querySelectorAll('.segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
          save({ theme: { wallpaperRotate: btn.dataset.rot === '1' } }, btn.dataset.rot === '1' ? '已开启壁纸自动轮换' : '已改为固定壁纸');
        });
      }

      pane.querySelector('#st-wallpapers').addEventListener('click', (e) => {
        const item = e.target.closest('[data-w]');
        if (!item) return;
        pane.querySelectorAll('.wallpaper-item').forEach((x) => x.classList.toggle('is-active', x === item));
        save({ theme: { wallpaperId: item.dataset.w } }, '壁纸已更换');
        draw();
      });

      pane.querySelector('#st-wall-apply').addEventListener('click', () => {
        const p = pane.querySelector('#st-wall-file').value.trim();
        if (!p) {
          toast('请先填写图片的完整路径', 'warn');
          return;
        }
        save({ theme: { wallpaperId: `file:${p}` } }, '已切换到自定义壁纸');
        draw();
      });

      const alpha = pane.querySelector('#st-alpha');
      const alphaVal = pane.querySelector('#st-alpha-value');
      alpha.addEventListener('input', () => {
        alphaVal.textContent = `${Math.round(alpha.value * 100)}%`;
        applyTheme({ theme: Object.assign({}, state.settings.theme, { panelAlpha: Number(alpha.value) }) });
      });
      alpha.addEventListener('change', () => save({ theme: { panelAlpha: Number(alpha.value) } }, '透明度已保存'));
    }

    /* ------------------------------ Java ------------------------------ */

    async function drawJava() {
      setHTML(pane, html`<div class="card"><div class="card__title">Java</div><div class="skeleton skeleton--row"></div></div>`);
      await loadJava();
      const cur = state.settings.javaPath;
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">全局 Java</div>
            <div class="field">
              <div class="field__label">选择 Java 可执行文件</div>
              <select class="select" id="st-java">
                <option value=""${!cur ? ' selected' : ''}>自动检测（推荐）</option>
                ${state.java.map(
                  (j) => raw(`<option value="${j.path}"${cur === j.path ? ' selected' : ''}>${j.version} · ${j.arch} · ${j.vendor}${j.isJre ? '（JRE）' : '（JDK）'}</option>`)
                )}
              </select>
              <div class="field__hint">
                单个实例可以在「版本设置 → Java」里单独指定，覆盖这里的全局设置。
              </div>
            </div>
            <div class="hstack">
              <button class="btn" id="st-java-save" type="button">保存</button>
              <button class="btn btn--ghost" id="st-java-detect" type="button">${raw(icon('refresh', 14))}重新检测</button>
            </div>
          </div>

          ${/* ★ 2026-11-05：新玩家一个 Java 都没装时显示这个卡片。
                 解决的问题：下载完游戏 → 点启动 → Java 检测不出来 → 启动失败 →
                 却不知道去哪下；而 Oracle 官网下载要注册登录。 */ ''}
          <div class="card java-none" id="st-java-none" ${state.java.length > 0 ? 'hidden' : ''}>
            <div class="card__title">这台电脑还没有 Java？</div>
            <div class="field__hint" style="margin-bottom:12px;line-height:1.75">
              没装 Java 就启动不了游戏 —— 这不是游戏坏了，只是缺个运行环境。<br />
              下面两种方式<strong>都不需要注册或登录任何账号</strong>，选一个就行。
            </div>

            <div class="java-none__hero">
              <div>
                <div class="java-none__title">① 让启动器帮你下（最简单）</div>
                <div class="java-none__desc">
                  从 Adoptium（Eclipse 基金会）官方接口直接下载，
                  <strong>不跳浏览器、不用登录</strong>，下完自动装好并选中。
                  约 200 MB，视网速几十秒到几分钟。
                </div>
              </div>
              <button class="btn btn--primary" id="st-java-download" data-major="21" type="button">
                一键下载 Java 21
              </button>
            </div>

            <div class="java-none__sub">
              推荐版本会跟着游戏版本走：1.20.5 以上建议 Java 21，1.17~1.20.4 用 Java 17，
              1.16 及更早用 Java 8。不确定就用 Java 21，多数情况能跑。
            </div>

            <div class="java-none__title" style="margin-top:16px">② 自己去下（全部免登录）</div>
            <div class="java-none__list" id="st-java-sources">
              <div class="sourcetip">正在读取下载源…</div>
            </div>

            <div class="java-none__warn">
              ⚠ 不要用 Oracle 官网（oracle.com）下载 —— 那里要注册并登录 Oracle 账号，
              对只想玩游戏的玩家非常麻烦。用上面任一个来源就够了。
            </div>
          </div>

          <div class="card">
            <div class="card__title">手动添加 Java</div>
            <div class="field">
              <div class="field__row">
                <input class="input" id="st-java-path" placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe" />
                <button class="btn btn--ghost" id="st-java-add" type="button">添加</button>
              </div>
              <div class="field__hint">填到 <span class="mono">javaw.exe</span> 或 <span class="mono">java.exe</span> 为止。</div>
            </div>
          </div>

          <div class="card">
            <div class="card__title">已发现的 Java（${state.java.length} 个）</div>
            ${state.java.length === 0
              ? html`<div class="sourcetip">还没有扫描到 Java。点上面的「重新检测」，或者手动添加路径。</div>`
              : html`<div class="list">
                  ${state.java.map(
                    (j) => html`<div class="row">
                      <div class="row__main">
                        <div class="row__title mono">${j.path}</div>
                        <div class="row__meta">
                          <span class="badge">Java ${j.major}</span>
                          <span>${j.version}</span>
                          <span>${j.arch}</span>
                          <span>${j.vendor}</span>
                          <span>${j.isJre ? 'JRE' : 'JDK'}</span>
                          <span>${j.source === 'manual' ? '手动添加' : '自动检测'}</span>
                        </div>
                      </div>
                    </div>`
                  )}
                </div>`}
          </div>`
      );

      pane.querySelector('#st-java-save').addEventListener('click', () => {
        const v = pane.querySelector('#st-java').value;
        save({ javaPath: v || null }, v ? '已指定全局 Java' : '已改为自动检测');
      });
      pane.querySelector('#st-java-detect').addEventListener('click', async () => {
        const r = await call('java:detect');
        if (!r.ok) toast(r.error || '检测失败', 'error');
        else toast(`检测完成，共 ${Array.isArray(r.data) ? r.data.length : 0} 个`, 'ok');
        await loadJava();
        drawJava();
      });
      pane.querySelector('#st-java-add').addEventListener('click', async () => {
        const p = pane.querySelector('#st-java-path').value.trim();
        if (!p) {
          toast('请先填写 Java 路径', 'warn');
          return;
        }
        const r = await call('java:add', { path: p });
        if (!r.ok) {
          toast(r.error || '添加失败', 'error', 5000);
          return;
        }
        toast('已添加 Java', 'ok');
        await loadJava();
        drawJava();
      });

      /* ---------------- 没装 Java？一键下载 + 免登录来源 ----------------
       *
       * 用户提的真实场景：玩家一个 Java 都没装，下载完游戏点启动 →
       * Java 检测不出来 → 启动失败 → 不知道去哪下；
       * 而且 Oracle 官网还要注册登录。
       * 所以这里给出：① 一键下载（免登录）② 5 个免登录官方来源。
       */
      const noJavaBox = pane.querySelector('#st-java-none');
      if (noJavaBox) {
        // 只有真的一个都没检测到时才展开，避免干扰已有 Java 的玩家
        const hasJava = state.java.length > 0;
        noJavaBox.hidden = hasJava;

        /**
         * 读免登录下载源 + 按当前默认版本算推荐 Java 版本。
         * 没选版本时按 21（1.20.5+ 的推荐值，覆盖面最广）。
         */
        const curVer = (state.instances.find((x) => x.id === state.currentInstanceId) || {}).mcVersion || '1.20.5';
        (async () => {
          const r = await call('java:sources', { mcVersion: curVer });
          const d = r && r.data ? r.data : null;
          if (!d) return;

          // 按钮文案跟着推荐版本走
          const dlBtn = pane.querySelector('#st-java-download');
          if (dlBtn && Number.isFinite(Number(d.recommendMajor))) {
            const major = Number(d.recommendMajor);
            dlBtn.dataset.major = String(major);
            dlBtn.textContent = `一键下载 Java ${major}`;
          }

          // 免登录来源列表
          const listEl = pane.querySelector('#st-java-sources');
          if (listEl && Array.isArray(d.sources)) {
            listEl.innerHTML = d.sources
              .map(
                (s) => `<div class="srcrow${s.recommended ? ' is-rec' : ''}">
                  <div class="srcrow__main">
                    <div class="srcrow__name">
                      ${escapeHtml(s.name)}
                      ${s.recommended ? '<span class="badge badge--accent">推荐</span>' : ''}
                    </div>
                    <div class="srcrow__note">${escapeHtml(s.note)}</div>
                  </div>
                  <a class="btn btn--ghost btn--sm" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">打开下载页</a>
                </div>`
              )
              .join('');
          }
        })();

        const dlBtn = pane.querySelector('#st-java-download');
        if (dlBtn) {
          dlBtn.addEventListener('click', async () => {
            const major = Number(dlBtn.dataset.major) || 21;
            dlBtn.disabled = true;
            const old = dlBtn.textContent;
            dlBtn.textContent = `正在下载 Java ${major}…（约 200 MB，请稍候）`;
            const r = await call('java:download', { major });
            const d = r && r.data ? r.data : {};
            dlBtn.disabled = false;
            dlBtn.textContent = old;
            if (!r.ok || !d.ok) {
              toast((d && d.error) || r.error || '下载失败', 'error', 9000);
              return;
            }
            toast(`Java ${major} 已就绪：${d.javaPath}`, 'ok', 6000);
            try {
              await call('java:add', { path: d.javaPath });
            } catch {
              /* 加不上也不影响：重新检测能扫到 */
            }
            await loadJava();
            drawJava();
          });
        }
      }
    }

    /* ------------------------------ 内存 ------------------------------ */

    function drawMemory() {
      const m = state.settings.memory;
      setHTML(
        pane,
        html`<div class="card">
          <div class="card__title">默认内存分配</div>
          <div class="field">
            <div class="field__label">分配方式</div>
            <div class="segmented" id="st-mem-mode">
              <button class="segmented__item ${m.mode === 'auto' ? 'is-active' : ''}" type="button" data-m="auto">自动（按系统剩余内存）</button>
              <button class="segmented__item ${m.mode === 'manual' ? 'is-active' : ''}" type="button" data-m="manual">手动指定</button>
            </div>
            <div class="field__hint">
              自动模式下 QCL 会按当前可用内存动态夹取（参考安卓版：64 位默认 2 GB，32 位默认 1 GB）。
            </div>
          </div>
          <div class="field" id="st-mem-wrap" style="${m.mode === 'manual' ? '' : 'opacity:.5;pointer-events:none'}">
            <div class="field__label">
              最大内存
              <span class="grow"></span>
              <span class="mono" id="st-mem-value">${m.mb} MB</span>
            </div>
            <input class="slider" id="st-mem-slider" type="range" min="512" max="16384" step="512" value="${m.mb}" />
          </div>
          <div class="hstack"><button class="btn" id="st-mem-save" type="button">保存</button></div>
        </div>`
      );
      const slider = pane.querySelector('#st-mem-slider');
      const val = pane.querySelector('#st-mem-value');
      const wrap = pane.querySelector('#st-mem-wrap');
      let mode = m.mode;
      slider.addEventListener('input', () => (val.textContent = `${slider.value} MB`));
      pane.querySelector('#st-mem-mode').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-m]');
        if (!btn) return;
        mode = btn.dataset.m;
        pane.querySelectorAll('#st-mem-mode .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
        wrap.style.opacity = mode === 'manual' ? '1' : '.5';
        wrap.style.pointerEvents = mode === 'manual' ? 'auto' : 'none';
      });
      pane.querySelector('#st-mem-save').addEventListener('click', () => {
        save({ memory: { mode, mb: Number(slider.value) } }, '内存设置已保存');
      });
    }

    /* ------------------------------ 下载 ------------------------------ */

    function drawDownload() {
      const d = state.settings.downloader;
      setHTML(
        pane,
        html`<div class="card">
          <div class="card__title">下载源</div>
          <div class="field">
            <div class="segmented" id="st-source">
              <button class="segmented__item ${d.source === 'official' ? 'is-active' : ''}" type="button" data-s="official">Mojang 官方源</button>
              <button class="segmented__item ${d.source === 'bmclapi' ? 'is-active' : ''}" type="button" data-s="bmclapi">BMCLAPI 镜像</button>
            </div>
            <div class="field__hint">
              国内网络建议用 <strong>BMCLAPI 镜像</strong>：会把 piston-meta / launchermeta / resources / libraries
              四个域名自动换成镜像，速度明显更快。远古版本来自考古社区归档，不受此项影响。
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card__title">并发线程</div>
          <div class="field">
            <div class="field__label">
              同时下载的文件数
              <span class="grow"></span>
              <span class="mono" id="st-threads-value">${d.threads}</span>
            </div>
            <input class="slider" id="st-threads" type="range" min="1" max="64" step="1" value="${d.threads}" />
            <div class="field__hint">默认 16。网络不稳定时降到 4~8 更稳，宽带充足可以调到 32。</div>
          </div>
          <div class="hstack"><button class="btn" id="st-dl-save" type="button">保存</button></div>
        </div>`
      );
      const th = pane.querySelector('#st-threads');
      const thv = pane.querySelector('#st-threads-value');
      let source = d.source;
      th.addEventListener('input', () => (thv.textContent = th.value));
      pane.querySelector('#st-source').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-s]');
        if (!btn) return;
        source = btn.dataset.s;
        pane.querySelectorAll('#st-source .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
      pane.querySelector('#st-dl-save').addEventListener('click', () => {
        save({ downloader: { source, threads: Number(th.value) } }, '下载设置已保存');
      });
    }

    /* ------------------------------ 启动 ------------------------------ */

    function drawLaunch() {
      const L = state.settings.launch;
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">游戏窗口</div>
            <div class="field">
              <div class="field__row">
                <label class="field__label" style="width:88px">宽度</label>
                <input class="input" id="st-w" type="number" min="320" max="7680" value="${L.width}" style="max-width:130px" />
                <label class="field__label" style="width:88px">高度</label>
                <input class="input" id="st-h" type="number" min="240" max="4320" value="${L.height}" style="max-width:130px" />
              </div>
            </div>
            <div class="field">
              <div class="field__label">全屏启动</div>
              <div class="switch ${L.fullscreen ? 'is-on' : ''}" id="st-fs" role="switch" tabindex="0"></div>
            </div>
          </div>
          <div class="card">
            <div class="card__title">JVM 参数（全局）</div>
            <div class="field">
              <textarea class="textarea" id="st-jvm" placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8">${L.extraJvmArgs || ''}</textarea>
            </div>
          </div>
          <div class="card">
            <div class="card__title">游戏参数（全局）</div>
            <div class="field">
              <textarea class="textarea" id="st-game" placeholder="--demo">${L.extraGameArgs || ''}</textarea>
            </div>
          </div>
          <div class="hstack">
            <button class="btn" id="st-launch-save" type="button">保存</button>
            <button class="btn btn--ghost" id="st-goto-vset" type="button">去「版本设置」为单个实例单独配置</button>
          </div>`
      );
      let fs = !!L.fullscreen;
      const fsEl = pane.querySelector('#st-fs');
      fsEl.addEventListener('click', () => {
        fs = !fs;
        fsEl.classList.toggle('is-on', fs);
      });
      pane.querySelector('#st-launch-save').addEventListener('click', () => {
        save(
          {
            launch: {
              width: Number(pane.querySelector('#st-w').value) || 1280,
              height: Number(pane.querySelector('#st-h').value) || 720,
              fullscreen: fs,
              extraJvmArgs: pane.querySelector('#st-jvm').value,
              extraGameArgs: pane.querySelector('#st-game').value,
            },
          },
          '启动设置已保存'
        );
      });
      pane.querySelector('#st-goto-vset').addEventListener('click', () => router.navigate('versionsetting'));
    }

    /* ------------------------------ 关于 ------------------------------ */

    function drawAbout() {
      const a = state.appInfo;
      setHTML(
        pane,
        html`<div class="card">
          <div class="card__title">关于</div>
          <div class="kv">
            <div class="kv__k">版本</div>
            <div class="kv__v">QCL ${a.version}</div>
            <div class="kv__k">平台</div>
            <div class="kv__v">${a.platform} · ${a.arch}</div>
            <div class="kv__k">主目录</div>
            <div class="kv__v mono">${state.settings.home || '未获取'}</div>
            <div class="kv__k">许可</div>
            <div class="kv__v">GNU GPL-3.0</div>
            <div class="kv__k">作者</div>
            <div class="kv__v">Rod123456</div>
            <div class="kv__k">仓库</div>
            <div class="kv__v mono">https://github.com/ALLEN201123/qcl-pc</div>
          </div>
          <div class="hstack" style="margin-top:12px">
            <button class="btn" id="st-openabout" type="button">打开「关于 QCL」页面</button>
            <button class="btn btn--ghost" id="st-opengithub" type="button">${raw(icon('external', 14))}GitHub 仓库</button>
            <button class="btn btn--ghost" id="st-openhome" type="button">${raw(icon('folder', 14))}打开主目录</button>
          </div>
        </div>
        <div class="card">
          <div class="card__title">当前连接状态</div>
          <div class="kv">
            <div class="kv__k">主进程</div>
            <div class="kv__v">${state.connected ? '已连接' : '未连接（正在显示内置示例数据）'}</div>
            <div class="kv__k">实例数</div>
            <div class="kv__v">${state.instances.length}</div>
            <div class="kv__k">账号数</div>
            <div class="kv__v">${state.accounts.length}</div>
            <div class="kv__k">Java 数</div>
            <div class="kv__v">${state.java.length}</div>
          </div>
          <div class="field__hint" style="margin-top:8px">刷新时间：${fmtDateTime(Date.now())}</div>
        </div>`
      );
      pane.querySelector('#st-openabout').addEventListener('click', () => router.navigate('about'));
      pane.querySelector('#st-opengithub').addEventListener('click', async () => {
        const r = await call('shell:openExternal', { url: 'https://github.com/ALLEN201123/qcl-pc' });
        if (!r.ok) toast(r.error || '打开仓库失败', 'error', 5000);
      });
      pane.querySelector('#st-openhome').addEventListener('click', async () => {
        const r = await call('shell:openPath', { path: state.settings.home });
        if (!r.ok) toast(r.error || '打开失败', 'error', 5000);
      });
    }

    draw();
    return {};
  },
};

export default settingPage;

/**
 * HTML 转义（用于把主进程给的下载源名称/链接安全拼进 innerHTML）。
 * 下载源清单来自后端常量，理论上安全，但拼 innerHTML 一律转义是底线。
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
