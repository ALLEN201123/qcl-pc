/**
 * QCL 电脑版 · 版本设置（单个实例）
 *
 * 数据来源：`instances:list` 里的 Instance + `java:list`（可选 Java）+ `settings:get`（全局默认）。
 * 写入：`instances:update { id, patch }`（实例级）/ `settings:set`（全局启动参数）。
 */

import { call } from '../bridge.js';
import { state, loadInstances, loadJava, saveSettings, notify } from '../store.js';
import { html, raw, setHTML, toast, fmtDate, fmtDuration, fmtRelative, fmtBytes, loaderLabel, openModal } from '../ui.js';
import { icon } from '../icons.js';

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'icon', label: '图标' },
  { id: 'game', label: '游戏' },
  { id: 'memory', label: '内存' },
  { id: 'java', label: 'Java' },
  { id: 'args', label: '启动参数' },
  { id: 'advanced', label: '高级' },
  { id: 'folder', label: '目录与文件' },
];

/**
 * 可选的实例图标（照安卓版 res/drawable/ic_mm_*.png 移植的 24 个 MultiMC 风格图标）。
 * 文件放在 src/renderer/assets/instance-icons/ 下，去掉 ic_mm_ 前缀当 id。
 */
const INSTANCE_ICONS = [
  'grass', 'dirt', 'stone', 'diamond', 'gold', 'iron', 'brick', 'planks',
  'creeper', 'chicken', 'skeleton', 'steve', 'herobrine', 'squarecreeper',
  'flame', 'tnt', 'enderpearl', 'netherstar', 'gear', 'magitech',
  'meat', 'infinity', 'ftb_logo', 'ftb_glow'
];

/** 图标 URL */
function iconUrl(name) {
  return `./assets/instance-icons/${name}.png`;
}

export const versionSettingPage = {
  id: 'versionsetting',
  title: '版本设置',
  async render(mount, params = {}) {
    const inst = state.instances.find((x) => x.id === params.instanceId) || state.instances[0] || null;

    if (!inst) {
      setHTML(
        mount,
        html`<div class="page page--panel">
          <div class="page__head"><div class="page__title">版本设置</div></div>
          <div class="page__body">
            <div class="empty">
              <div class="empty__title">还没有任何实例</div>
              <div class="empty__desc">先到「下载」页装一个版本，再回来配置它。</div>
              <div style="margin-top:6px"><button class="btn" id="vs-godl" type="button">去下载</button></div>
            </div>
          </div>
        </div>`
      );
      const b = mount.querySelector('#vs-godl');
      if (b)
        b.addEventListener('click', async () => {
          const m = await import('../router.js');
          m.navigate('download');
        });
      return {};
    }

    let tab = 'overview';

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">版本设置</div>
          <div class="page__sub">${inst.name} · ${inst.mcVersion} · ${loaderLabel(inst.loader)}</div>
        </div>
        <div class="vset">
          <div class="vset__side" id="vs-tabs">
            ${TABS.map(
              (t, i) => raw(`<button class="vset__tab ${i === 0 ? 'is-active' : ''}" type="button" data-tab="${t.id}">${t.label}</button>`)
            )}
          </div>
          <div class="vset__pane" id="vs-pane"></div>
        </div>
      </div>`
    );

    const pane = mount.querySelector('#vs-pane');

    mount.querySelector('#vs-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      tab = btn.dataset.tab;
      mount.querySelectorAll('#vs-tabs .vset__tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      draw();
    });

    async function patchInstance(patch) {
      const r = await call('instances:update', { id: inst.id, patch });
      if (!r.ok) {
        toast(r.error || '保存失败', 'error');
        return false;
      }
      Object.assign(inst, r.data && typeof r.data === 'object' ? r.data : patch);
      await loadInstances();
      notify('instances');
      return true;
    }

    function draw() {
      if (tab === 'overview') return drawOverview();
      if (tab === 'icon') return drawIcon();
      if (tab === 'game') return drawGame();
      if (tab === 'memory') return drawMemory();
      if (tab === 'java') return drawJava();
      if (tab === 'args') return drawArgs();
      if (tab === 'advanced') return drawAdvanced();
      return drawFolder();
    }

    /* ------------------------------ 图标 ------------------------------ */

    /**
     * 实例图标选择器。
     *
     * 照安卓版移植：安卓用 res/drawable/ic_mm_*.png 那 24 个 MultiMC 风格图标，
     * 这里已把它们复制到 src/renderer/assets/instance-icons/。
     * 选中后写进 instance.json 的 `icon` 字段。
     */
    function drawIcon() {
      const current = inst.icon || 'grass';
      setHTML(
        pane,
        html`<div class="vset-sec">
          <div class="vset-sec__title">实例图标</div>
          <div class="vset-sec__desc">
            图标会显示在版本列表和主页的版本行上。选中即时保存。
          </div>

          <div class="icon-current">
            <img class="icon-current__img" src="${iconUrl(current)}" alt="" />
            <div class="icon-current__text">
              <div class="icon-current__name">当前：${current}</div>
              <div class="icon-current__hint">也可以用自己的图片（下面「自定义」）</div>
            </div>
          </div>

          <div class="icon-grid">
            ${INSTANCE_ICONS.map(
              (n) => raw(`<button class="icon-grid__item ${n === current ? 'is-active' : ''}"
                type="button" data-icon="${n}" title="${n}">
                <img src="${iconUrl(n)}" alt="${n}" />
              </button>`)
            )}
          </div>

          <div class="vset-sec__title" style="margin-top:18px">自定义图标</div>
          <div class="vset-sec__desc">
            选一张 PNG 图片当图标（建议正方形，会自动缩放显示）。
          </div>
          <div class="row-actions">
            <button class="btn btn--ghost btn--sm" id="vs-icon-pick" type="button">选择图片…</button>
            <button class="btn btn--ghost btn--sm" id="vs-icon-reset" type="button">恢复默认（grass）</button>
          </div>
        </div>`
      );

      // 预置图标：点一下就存
      pane.querySelectorAll('[data-icon]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.icon;
          const ok = await patchInstance({ icon: name, iconFile: null });
          if (ok) {
            toast(`图标已换成「${name}」`, 'ok', 1800);
            drawIcon();
          }
        });
      });

      // 自定义图片
      const pick = pane.querySelector('#vs-icon-pick');
      if (pick) {
        pick.addEventListener('click', async () => {
          const r = await call('instances:pickIcon', { id: inst.id });
          if (!r.ok) {
            if (r.error) toast(r.error, 'error', 5000);
            return;
          }
          const d = r.data || {};
          if (d.canceled) return;
          toast('自定义图标已设置', 'ok');
          await loadInstances();
          drawIcon();
        });
      }

      const reset = pane.querySelector('#vs-icon-reset');
      if (reset) {
        reset.addEventListener('click', async () => {
          const ok = await patchInstance({ icon: 'grass', iconFile: null });
          if (ok) {
            toast('已恢复默认图标', 'ok', 1800);
            drawIcon();
          }
        });
      }
    }

    /* ------------------------------ 游戏 ------------------------------ */

    /**
     * 游戏设置（照安卓版「全局游戏设置」里 PC 适用的部分移植）。
     *
     * ★ 只移植 PC 有意义的项，**手机专属的一律不做**：
     *     ✗ 渲染器（Pojav 的 GL4ES/Zink 之类）  ✗ 触屏控制布局 / 触摸注入
     *     ✗ 运行时位数（PC 直接用系统架构）      ✗ 游戏启动器选择（Pojav 专属）
     *     ✗ 版本隔离（PC 的实例本来就各自独立）
     *   ✓ 游戏窗口分辨率、服务器地址、最低内存、调试选项
     */
    function drawGame() {
      const g = state.settings.game || {};
      const res = g.resolution || {};
      setHTML(
        pane,
        html`<div class="vset-sec">
          <div class="vset-sec__title">游戏窗口</div>
          <div class="vset-sec__desc">游戏启动时的窗口大小（全屏可在全局设置里开）。</div>

          <div class="field">
            <div class="field__label">分辨率</div>
            <div class="field__row">
              <input class="input input--sm" id="vs-res-w" type="number" min="320" max="7680"
                     value="${res.width || 854}" /> ×
              <input class="input input--sm" id="vs-res-h" type="number" min="240" max="4320"
                     value="${res.height || 480}" />
              <button class="btn btn--ghost btn--sm" id="vs-res-apply" type="button">保存</button>
            </div>
            <div class="field__hint">常见：854×480（默认）、1280×720、1920×1080</div>
          </div>

          <div class="field">
            <div class="field__label">服务器地址（启动后自动进入）</div>
            <div class="field__row">
              <input class="input" id="vs-server" placeholder="例如 play.example.com 或留空" value="${g.serverAddress || ''}" />
              <button class="btn btn--ghost btn--sm" id="vs-server-save" type="button">保存</button>
            </div>
            <div class="field__hint">留空就是正常启动到主菜单；填了就自动连这个服务器。</div>
          </div>

          <div class="vset-sec__title" style="margin-top:18px">最低分配内存</div>
          <div class="vset-sec__desc">
            启动时先分配的堆大小（-Xms）。一般 512 MB 就够；如果进世界经常卡顿可以调大。
          </div>
          <div class="field">
            <div class="field__row">
              <input class="input input--sm" id="vs-minmem" type="number" min="256" max="8192" step="256"
                     value="${g.minMemoryMb || 512}" /> MB
              <button class="btn btn--ghost btn--sm" id="vs-minmem-save" type="button">保存</button>
            </div>
          </div>

          <div class="vset-sec__title" style="margin-top:18px">调试选项</div>
          <div class="vset-sec__desc">
            启动时把游戏日志实时写到文件，方便排查崩溃。默认开启。
          </div>
          <div class="vset-sec__title" style="margin-top:18px">版本隔离</div>
          <div class="vset-sec__desc">
            <strong>各版本独立</strong>（默认）：这个实例用自己的游戏目录，
            存档 / mods / 配置互不干扰。<br />
            <strong>跟随全局</strong>：与其它实例共用游戏目录 —— 只有在你确定两个版本不会冲突时才选。
          </div>
          <div class="field">
            <div class="field__row">
              <select class="input" id="vs-isolation">
                <option value="isolated" ${inst.isolation !== 'default' ? 'selected' : ''}>各版本独立（推荐，默认）</option>
                <option value="default" ${inst.isolation === 'default' ? 'selected' : ''}>跟随全局设置</option>
              </select>
              <button class="btn btn--ghost btn--sm" id="vs-isolation-save" type="button">保存</button>
            </div>
            <div class="field__hint">
              当前实例目录：<span class="mono">${inst.dir}</span>
            </div>
          </div>

          <div class="vset-sec__title" style="margin-top:18px">游戏窗口类型</div>
          <div class="field">
            <div class="field__row">
              <select class="input" id="vs-windowtype">
                <option value="windowed" ${inst.windowType === 'windowed' ? 'selected' : ''}>窗口化</option>
                <option value="maximized" ${inst.windowType === 'maximized' ? 'selected' : ''}>最大化</option>
                <option value="fullscreen" ${inst.windowType === 'fullscreen' ? 'selected' : ''}>全屏</option>
              </select>
              <button class="btn btn--ghost btn--sm" id="vs-windowtype-save" type="button">保存</button>
            </div>
            <div class="field__hint">照 HMCL 的「游戏窗口类型」。全屏会忽略上面的分辨率。</div>
          </div>

          <div class="vset-sec__title" style="margin-top:18px">快速游玩</div>
          <div class="vset-sec__desc">启动游戏后直接进入指定世界或服务器（照 HMCL 的「快速游玩」）。</div>
          <div class="field">
            <div class="field__row">
              <select class="input input--sm" id="vs-qp-type">
                <option value="none" ${(inst.quickPlay || {}).type !== 'singleplayer' && (inst.quickPlay || {}).type !== 'multiplayer' ? 'selected' : ''}>无</option>
                <option value="singleplayer" ${(inst.quickPlay || {}).type === 'singleplayer' ? 'selected' : ''}>单人游戏</option>
                <option value="multiplayer" ${(inst.quickPlay || {}).type === 'multiplayer' ? 'selected' : ''}>多人联机</option>
              </select>
              <input class="input" id="vs-qp-target" placeholder="世界名或服务器地址" value="${(inst.quickPlay || {}).target || ''}" />
              <button class="btn btn--ghost btn--sm" id="vs-qp-save" type="button">保存</button>
            </div>
            <div class="field__hint">
              「单人游戏」填存档文件夹名；「多人联机」填 <span class="mono">host:port</span>。
              ★ 需要 1.20+ 才支持快速游玩参数，老版本会自动忽略。
            </div>
          </div>

          <label class="vset-check">
            <input type="checkbox" id="vs-debug-log" ${g.debugLog !== false ? 'checked' : ''} />
            <span>记录完整游戏日志（logs/latest.log）</span>
          </label>
          <label class="vset-check">
            <input type="checkbox" id="vs-keep-alive" ${g.keepLauncherOpen ? 'checked' : ''} />
            <span>游戏启动后保持启动器在前台（不自动收起）</span>
          </label>
        </div>`
      );

      const save = async (patch, msg) => {
        try {
          await saveSettings({ game: { ...g, ...patch } });
          toast(msg || '已保存', 'ok', 1600);
        } catch (err) {
          toast(`保存失败：${err?.message || err}`, 'error');
        }
      };

      const resApply = pane.querySelector('#vs-res-apply');
      if (resApply) {
        resApply.addEventListener('click', () => {
          const w = Number(pane.querySelector('#vs-res-w').value) || 854;
          const h = Number(pane.querySelector('#vs-res-h').value) || 480;
          save({ resolution: { width: Math.max(320, Math.min(7680, w)), height: Math.max(240, Math.min(4320, h)) } }, `分辨率已设为 ${w}×${h}`);
        });
      }

      const srvSave = pane.querySelector('#vs-server-save');
      if (srvSave) {
        srvSave.addEventListener('click', () => {
          const v = String(pane.querySelector('#vs-server').value || '').trim();
          save({ serverAddress: v }, v ? `已设为启动后自动进入 ${v}` : '已清空服务器地址');
        });
      }

      const memSave = pane.querySelector('#vs-minmem-save');
      if (memSave) {
        memSave.addEventListener('click', () => {
          const v = Number(pane.querySelector('#vs-minmem').value) || 512;
          save({ minMemoryMb: Math.max(256, Math.min(8192, v)) }, `最低内存已设为 ${v} MB`);
        });
      }

      const dbg = pane.querySelector('#vs-debug-log');
      if (dbg) dbg.addEventListener('change', () => save({ debugLog: dbg.checked }, '调试日志设置已保存'));

      const keep = pane.querySelector('#vs-keep-alive');
      if (keep) keep.addEventListener('change', () => save({ keepLauncherOpen: keep.checked }, '已保存'));

      /* ---- 版本隔离 / 窗口类型 / 快速游玩（照 HMCL 逐实例设置）---- */
      const isoSave = pane.querySelector('#vs-isolation-save');
      if (isoSave) {
        isoSave.addEventListener('click', async () => {
          const v = pane.querySelector('#vs-isolation').value;
          const ok = await patchInstance({ isolation: v });
          if (ok) {
            toast(
              v === 'isolated'
                ? '已设为「各版本独立」：这个实例用自己的游戏目录'
                : '已设为「跟随全局设置」：与其它实例共用游戏目录',
              'ok',
              2600
            );
          }
        });
      }

      const wtSave = pane.querySelector('#vs-windowtype-save');
      if (wtSave) {
        wtSave.addEventListener('click', async () => {
          const v = pane.querySelector('#vs-windowtype').value;
          const ok = await patchInstance({ windowType: v });
          if (ok) {
            toast(`窗口类型已设为「${v === 'fullscreen' ? '全屏' : v === 'maximized' ? '最大化' : '窗口化'}」`, 'ok');
          }
        });
      }

      const qpSave = pane.querySelector('#vs-qp-save');
      if (qpSave) {
        qpSave.addEventListener('click', async () => {
          const type = pane.querySelector('#vs-qp-type').value;
          const target = String(pane.querySelector('#vs-qp-target').value || '').trim();
          if (type !== 'none' && !target) {
            toast('请填写世界名或服务器地址', 'warn');
            return;
          }
          const ok = await patchInstance({ quickPlay: { type, target } });
          if (ok) toast(type === 'none' ? '已关闭快速游玩' : '保存成功', 'ok');
        });
      }
    }

    /* ------------------------------ 高级 ------------------------------ */

    /**
     * 高级设置（照 HMCL `settings.advanced.*` 移植，2026-11-05 加）。
     *
     * 移植的项：
     *   · 不检查游戏完整性      ← HMCL settings.advanced.dont_check_game_completeness
     *   · 不检查 JVM 兼容性     ← HMCL settings.advanced.dont_check_jvm_validity
     *   · 不尝试自动替换本地库  ← HMCL settings.advanced.dont_patch_natives
     *   · 图形 API              ← HMCL settings.advanced.graphics_backend（26.2+）
     *   · 自动补齐依赖 / 自动装 Java（「自动安装」语义）
     *
     * ★ 不移植的手机专属项照旧：渲染器选择、触屏布局、触摸注入。
     */
    function drawAdvanced() {
      setHTML(
        pane,
        html`<div class="vset-sec">
          <div class="vset-sec__title">自动安装</div>
          <div class="vset-sec__desc">
            启动前自动补齐缺的东西，省得玩家自己去找。<strong>建议都开着。</strong>
          </div>
          <label class="vset-check">
            <input type="checkbox" id="vs-auto-deps" ${inst.autoInstallDependencies !== false ? 'checked' : ''} />
            <span>自动补齐缺失的依赖库与游戏资源（libraries / assets）</span>
          </label>
          <label class="vset-check">
            <input type="checkbox" id="vs-auto-java" ${inst.autoInstallJava !== false ? 'checked' : ''} />
            <span>找不到匹配的 Java 时自动下载（照 HMCL「自动选择合适的 Java」）</span>
          </label>

          <div class="vset-sec__title" style="margin-top:18px">文件校验</div>
          <div class="vset-sec__desc">
            <strong>关闭文件校验</strong> = 这个版本启动前不再比对 libraries / assets / 客户端 jar 的完整性。
            <br />
            什么时候该关：你<strong>手动改过这个版本的文件</strong>
            （装了 ModLoader、替换过 jar、手动打汉化补丁）——
            不关的话启动器会把你的改动当成「损坏」还原掉。
            <br />
            ★ 只影响<strong>这一个版本</strong>。全局开关在「设置 → 游戏 → 文件校验」。
            <strong>这里的设置优先。</strong>
          </div>
          <label class="vset-check">
            <input type="checkbox" id="vs-no-check-files" ${inst.notCheckGameFiles === true ? 'checked' : ''} />
            <span>关闭文件校验（不检查这个版本的游戏文件完整性）</span>
          </label>
          <div class="field__hint" style="margin-left:4px">
            ★ 注入过中文补丁的版本会<strong>自动</strong>跳过校验 ——
            即使这里没勾，启动器也会从文件（<span class="mono">.cnpack_lang</span> / jar 内的点阵图）
            认出补丁并跳过，以免把补丁冲掉。
          </div>

          <div class="vset-sec__title" style="margin-top:18px">检查与兼容性</div>
          <div class="vset-sec__desc">
            其余开关照 HMCL 的高级设置。<strong>改动会影响启动时的行为</strong>，不确定就别动。
          </div>
          <label class="vset-check">
            <input type="checkbox" id="vs-no-check-jvm" ${inst.dontCheckJvmValidity === true ? 'checked' : ''} />
            <span>不检查 Java 虚拟机与游戏的兼容性</span>
          </label>
          <label class="vset-check">
            <input type="checkbox" id="vs-no-patch-natives" ${inst.dontPatchNatives === true ? 'checked' : ''} />
            <span>不尝试自动替换本地库（natives）</span>
          </label>

          <div class="vset-sec__title" style="margin-top:18px">图形 API</div>
          <div class="vset-sec__desc">
            照 HMCL 的图形 API 选项。<strong>仅对 Minecraft 26.2+ 生效</strong>，老版本会忽略。
            Vulkan 在部分显卡上更流畅，但驱动不支持的机器会启动失败 —— 出问题就改回默认。
          </div>
          <div class="field">
            <div class="field__row">
              <select class="input" id="vs-gfx">
                <option value="default" ${inst.graphicsBackend === 'default' ? 'selected' : ''}>默认（遵循游戏设置）</option>
                <option value="opengl" ${inst.graphicsBackend === 'opengl' ? 'selected' : ''}>OpenGL</option>
                <option value="vulkan" ${inst.graphicsBackend === 'vulkan' ? 'selected' : ''}>Vulkan</option>
              </select>
              <button class="btn btn--ghost btn--sm" id="vs-gfx-save" type="button">保存</button>
            </div>
          </div>

          <div class="vset-sec__title" style="margin-top:18px">当前生效状态</div>
          <div class="kv">
            <div class="kv__k">版本隔离</div>
            <div class="kv__v">${inst.isolation === 'default' ? '跟随全局' : '各版本独立'}</div>
            <div class="kv__k">完整性检查</div>
            <div class="kv__v">${inst.notCheckGameFiles ? '已关闭（不检查）' : '开启'}</div>
            <div class="kv__k">中文补丁</div>
            <div class="kv__v">${inst.chinesePack && inst.chinesePack.applied ? `已注入（${inst.chinesePack.lang || 'zh_CN'}）` : '未注入'}</div>
          </div>
        </div>`
      );

      const patch = async (p, msg) => {
        const ok = await patchInstance(p);
        if (ok) toast(msg || '已保存', 'ok', 1600);
      };

      const bind = (sel, key, msg) => {
        const el = pane.querySelector(sel);
        if (el) el.addEventListener('change', () => patch({ [key]: el.checked }, msg));
      };
      bind('#vs-auto-deps', 'autoInstallDependencies', '自动补齐依赖已保存');
      bind('#vs-auto-java', 'autoInstallJava', '自动安装 Java 已保存');
      bind('#vs-no-check-files', 'notCheckGameFiles', '文件校验设置已保存（只影响这个版本）');
      bind('#vs-no-check-jvm', 'dontCheckJvmValidity', 'JVM 兼容性检查设置已保存');
      bind('#vs-no-patch-natives', 'dontPatchNatives', '本地库替换设置已保存');

      const gfxSave = pane.querySelector('#vs-gfx-save');
      if (gfxSave) {
        gfxSave.addEventListener('click', async () => {
          const v = pane.querySelector('#vs-gfx').value;
          const ok = await patchInstance({ graphicsBackend: v });
          if (ok) toast(`图形 API 已设为「${v}」`, 'ok');
        });
      }
    }

    /* ------------------------------ 概览 ------------------------------ */

    function drawOverview() {
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">实例信息</div>
            <div class="kv">
              <div class="kv__k">名称</div>
              <div class="kv__v">${inst.name}</div>
              <div class="kv__k">游戏版本</div>
              <div class="kv__v">${inst.mcVersion}</div>
              <div class="kv__k">加载器</div>
              <div class="kv__v">${loaderLabel(inst.loader)}</div>
              <div class="kv__k">实例 ID</div>
              <div class="kv__v mono">${inst.id}</div>
              <div class="kv__k">创建时间</div>
              <div class="kv__v">${fmtDate(inst.created)}</div>
              <div class="kv__k">上次启动</div>
              <div class="kv__v">${inst.lastPlayed ? `${fmtDate(inst.lastPlayed)}（${fmtRelative(inst.lastPlayed)}）` : '从未启动'}</div>
              <div class="kv__k">累计时长</div>
              <div class="kv__v">${fmtDuration(inst.playTime)}</div>
              <div class="kv__k">实例目录</div>
              <div class="kv__v mono">${inst.dir}</div>
            </div>
          </div>
          <div class="card">
            <div class="card__title">重命名</div>
            <div class="field" style="margin-bottom:8px">
              <div class="field__row">
                <input class="input" id="vs-name" value="${inst.name}" autocomplete="off" />
                <button class="btn" id="vs-rename" type="button">保存名称</button>
              </div>
              <div class="field__hint">名称只影响启动器里的显示，不会改动游戏存档。</div>
            </div>
          </div>
          <div class="card">
            <div class="card__title">导出整合包</div>
            <div class="sourcetip" style="margin-bottom:10px">
              把当前实例打包成一个 .zip，别人用「主页 → 导入整合包」就能一键还原这份配置。
              勾选项会决定哪些内容被打进包里：存档体积可能很大，默认不勾。
            </div>
            <div class="export-opts">
              <label class="vset-check"><input type="checkbox" id="vs-exp-mods" checked /> 包含模组（mods）</label>
              <label class="vset-check"><input type="checkbox" id="vs-exp-config" checked /> 包含配置（config）</label>
              <label class="vset-check"><input type="checkbox" id="vs-exp-packs" checked /> 包含资源包</label>
              <label class="vset-check"><input type="checkbox" id="vs-exp-saves" /> 包含存档（saves）</label>
            </div>
            <div class="hstack" style="margin-top:10px">
              <button class="btn" id="vs-export" type="button">${raw(icon('file', 14))}导出整合包</button>
              <span class="page__sub" id="vs-export-tip">导出位置：QCL 主目录下的 exports 文件夹</span>
            </div>
          </div>`
      );
      pane.querySelector('#vs-rename').addEventListener('click', async () => {
        const v = pane.querySelector('#vs-name').value.trim();
        if (!v) {
          toast('名称不能为空', 'warn');
          return;
        }
        const r = await call('instances:rename', { id: inst.id, name: v });
        if (!r.ok) {
          toast(r.error || '重命名失败', 'error');
          return;
        }
        inst.name = v;
        await loadInstances();
        notify('instances');
        toast('已保存', 'ok');
        draw();
      });

      /* ---------------- 导出整合包（照 HMCL 的 modpack 导出） ---------------- */
      const exportBtn = pane.querySelector('#vs-export');
      if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
          const tip = pane.querySelector('#vs-export-tip');
          const opts = {
            includeMods: !!pane.querySelector('#vs-exp-mods').checked,
            includeConfig: !!pane.querySelector('#vs-exp-config').checked,
            includeResourcePacks: !!pane.querySelector('#vs-exp-packs').checked,
            includeSaves: !!pane.querySelector('#vs-exp-saves').checked,
          };
          const oldHTML = exportBtn.innerHTML;
          exportBtn.disabled = true;
          exportBtn.textContent = '正在打包…';
          if (tip) tip.textContent = '正在压缩文件，实例越大越久，请稍等…';

          const r = await call('modpack:export', Object.assign({ id: inst.id }, opts), { optional: true });

          exportBtn.disabled = false;
          setHTML(exportBtn, raw(oldHTML));
          if (tip) tip.textContent = '导出位置：QCL 主目录下的 exports 文件夹';

          // ★ 主进程失败时把 { ok:false, error } 当 data 返回（外层仍 ok），两种都要判
          const softFail = r.data && r.data.ok === false;
          if (!r.ok || !r.data || softFail) {
            toast((softFail && r.data.error) || r.error || '导出失败：主进程的整合包导出还没就绪', 'warn', 6500);
            return;
          }
          const d = r.data;
          const file = d.file || d.path || '';
          // 契约：file 是**绝对路径**，目录自己从路径里切出来（不再指望后端单独给 dir）
          const dir = file ? file.replace(/[\\/][^\\/]+$/, '') : '';
          const size = d.sizeBytes != null ? d.sizeBytes : d.bytes;
          openModal({
            title: '整合包已导出',
            buttons: [
              { text: '关闭', value: null, kind: 'ghost' },
              { text: '打开所在文件夹', value: 'open', kind: 'primary' },
            ],
            body: html`<div class="kv">
              <div class="kv__k">文件</div>
              <div class="kv__v mono">${file || '（主进程未返回文件名）'}</div>
              <div class="kv__k">大小</div>
              <div class="kv__v">${size ? fmtBytes(size) : '未知'}</div>
              <div class="kv__k">包含</div>
              <div class="kv__v">
                ${[
                  opts.includeMods ? '模组' : '',
                  opts.includeConfig ? '配置' : '',
                  opts.includeResourcePacks ? '资源包' : '',
                  opts.includeSaves ? '存档' : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || '仅版本清单'}
              </div>
            </div>
            <div class="sourcetip" style="margin-top:10px">
              把这个 .zip 发给别人，对方在「主页 → 导入整合包」里选中它就能还原配置。
            </div>`,
          }).then(async (v) => {
            if (v === 'open' && dir) {
              const res = await call('shell:openPath', { path: dir }, { optional: true });
              if (!res.ok) toast(res.error || '打不开文件夹', 'warn', 4000);
            }
          });
        });
      }
    }

    /* ------------------------------ 内存 ------------------------------ */

    function drawMemory() {
      const globalMb = state.settings.memory.mb || 2048;
      const custom = inst.java && inst.java.memoryMb != null;
      const mb = custom ? inst.java.memoryMb : globalMb;

      setHTML(
        pane,
        html`<div class="card">
          <div class="card__title">内存分配</div>
          <div class="field">
            <div class="field__label">分配方式</div>
            <div class="segmented" id="vs-mem-mode">
              <button class="segmented__item ${custom ? '' : 'is-active'}" type="button" data-m="global">跟随全局设置</button>
              <button class="segmented__item ${custom ? 'is-active' : ''}" type="button" data-m="custom">为这个实例单独指定</button>
            </div>
            <div class="field__hint">
              全局当前是 <strong>${globalMb} MB</strong>（可在「设置 → 内存」里改）。
              分配太小会频繁卡顿，太大可能拖慢整个系统；8 GB 内存的机器建议不超过 4096 MB。
            </div>
          </div>
          <div class="field" id="vs-mem-slider-wrap" style="${custom ? '' : 'opacity:.5;pointer-events:none'}">
            <div class="field__label">
              最大内存
              <span class="grow"></span>
              <span class="mono" id="vs-mem-value">${mb} MB</span>
            </div>
            <input class="slider" id="vs-mem-slider" type="range" min="512" max="16384" step="512" value="${mb}" />
            <div class="field__hint">512 MB ~ 16384 MB，步进 512 MB。</div>
          </div>
          <div class="hstack">
            <button class="btn" id="vs-mem-save" type="button">保存</button>
            <span class="page__sub" id="vs-mem-tip"></span>
          </div>
        </div>`
      );

      const slider = pane.querySelector('#vs-mem-slider');
      const valueEl = pane.querySelector('#vs-mem-value');
      const wrap = pane.querySelector('#vs-mem-slider-wrap');
      let mode = custom ? 'custom' : 'global';

      slider.addEventListener('input', () => {
        valueEl.textContent = `${slider.value} MB`;
      });
      pane.querySelector('#vs-mem-mode').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-m]');
        if (!btn) return;
        mode = btn.dataset.m;
        pane.querySelectorAll('#vs-mem-mode .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
        wrap.style.opacity = mode === 'custom' ? '1' : '.5';
        wrap.style.pointerEvents = mode === 'custom' ? 'auto' : 'none';
      });

      pane.querySelector('#vs-mem-save').addEventListener('click', async () => {
        const patch = { java: Object.assign({}, inst.java, { memoryMb: mode === 'custom' ? Number(slider.value) : null }) };
        const ok = await patchInstance(patch);
        if (ok) {
          toast(mode === 'custom' ? `已设为 ${slider.value} MB` : '已改为跟随全局设置', 'ok');
          draw();
        }
      });
    }

    /* ------------------------------ Java ------------------------------ */

    async function drawJava() {
      setHTML(pane, html`<div class="card"><div class="card__title">Java 运行时</div>${html`<div class="skeleton skeleton--row"></div><div class="skeleton skeleton--row"></div>`}</div>`);
      await loadJava();
      const custom = !!(inst.java && inst.java.path);
      const globalPath = state.settings.javaPath;
      const list = state.java;

      const options = list
        .map((j) => {
          const label = `${j.version} · ${j.arch} · ${j.vendor}${j.isJre ? '（JRE）' : '（JDK）'}`;
          return { value: j.path, label, selected: custom ? inst.java.path === j.path : j.path === globalPath };
        })
        .concat([{ value: '', label: '跟随全局设置（自动检测）', selected: !custom }]);

      setHTML(
        pane,
        html`<div class="card">
          <div class="card__title">为这个实例指定 Java</div>
          <div class="field">
            <div class="field__label">Java 可执行文件</div>
            <select class="select" id="vs-java-select">
              ${options.map((o) => raw(`<option value="${o.value}"${o.selected ? ' selected' : ''}>${o.label}</option>`))}
            </select>
            <div class="field__hint">
              版本要求：≤1.16 用 Java 8；1.17~1.20.4 用 Java 17；1.20.5+ 用 Java 21；26.x 用 Java 25。
              留空则跟随全局设置。
            </div>
          </div>
          <div class="hstack">
            <button class="btn" id="vs-java-save" type="button">保存</button>
            <button class="btn btn--ghost" id="vs-java-detect" type="button">${raw(icon('refresh', 14))}重新检测</button>
            <span class="page__sub">全局 Java：${globalPath || '自动检测'}</span>
          </div>
        </div>
        <div class="card">
          <div class="card__title">已发现的 Java（${list.length} 个）</div>
          ${list.length === 0
            ? html`<div class="sourcetip">没有扫描到任何 Java。可以到「设置 → Java」里手动添加路径。</div>`
            : html`<div class="list">
                ${list.map(
                  (j) => html`<div class="row">
                    <div class="row__main">
                      <div class="row__title mono">${j.path}</div>
                      <div class="row__meta">
                        <span class="badge">${j.major}</span>
                        <span>${j.version}</span>
                        <span>${j.arch}</span>
                        <span>${j.vendor}</span>
                        <span>${j.source === 'manual' ? '手动添加' : '自动检测'}</span>
                      </div>
                    </div>
                  </div>`
                )}
              </div>`}
        </div>`
      );

      pane.querySelector('#vs-java-save').addEventListener('click', async () => {
        const v = pane.querySelector('#vs-java-select').value;
        const patch = { java: Object.assign({}, inst.java, { path: v || null }) };
        const ok = await patchInstance(patch);
        if (ok) {
          toast(v ? '已指定该实例使用的 Java' : '已改为跟随全局设置', 'ok');
          draw();
        }
      });
      pane.querySelector('#vs-java-detect').addEventListener('click', async () => {
        const r = await call('java:detect');
        if (!r.ok) {
          toast(r.error || 'Java 检测失败', 'error');
        } else {
          toast(`检测完成，共 ${Array.isArray(r.data) ? r.data.length : 0} 个`, 'ok');
        }
        await loadJava();
        draw();
      });
    }

    /* ------------------------------ 启动参数 ------------------------------ */

    function drawArgs() {
      const L = state.settings.launch;
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">窗口与显示</div>
            <div class="field">
              <div class="field__row">
                <label class="field__label" style="width:88px">窗口宽度</label>
                <input class="input" id="vs-w" type="number" min="320" max="7680" value="${L.width}" style="max-width:130px" />
                <label class="field__label" style="width:88px">窗口高度</label>
                <input class="input" id="vs-h" type="number" min="240" max="4320" value="${L.height}" style="max-width:130px" />
              </div>
            </div>
            <div class="field">
              <div class="field__label">全屏启动</div>
              <div class="switch ${L.fullscreen ? 'is-on' : ''}" id="vs-fs" role="switch" tabindex="0"></div>
            </div>
          </div>
          <div class="card">
            <div class="card__title">JVM 参数（全局，所有实例共用）</div>
            <div class="field">
              <textarea class="textarea" id="vs-jvm" placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8">${L.extraJvmArgs || ''}</textarea>
              <div class="field__hint">在默认参数之后追加。每行一个参数，或用空格分隔。</div>
            </div>
          </div>
          <div class="card">
            <div class="card__title">游戏参数（全局，所有实例共用）</div>
            <div class="field">
              <textarea class="textarea" id="vs-game" placeholder="--demo --width 1280">${L.extraGameArgs || ''}</textarea>
              <div class="field__hint">追加到游戏启动命令末尾，例如 <span class="mono">--fullscreen</span>。</div>
            </div>
          </div>
          <div class="hstack"><button class="btn" id="vs-args-save" type="button">保存参数</button></div>`
      );

      let fs = !!L.fullscreen;
      const fsEl = pane.querySelector('#vs-fs');
      fsEl.addEventListener('click', () => {
        fs = !fs;
        fsEl.classList.toggle('is-on', fs);
      });
      pane.querySelector('#vs-args-save').addEventListener('click', async () => {
        const r = await saveSettings({
          launch: {
            width: Number(pane.querySelector('#vs-w').value) || 1280,
            height: Number(pane.querySelector('#vs-h').value) || 720,
            fullscreen: fs,
            extraJvmArgs: pane.querySelector('#vs-jvm').value,
            extraGameArgs: pane.querySelector('#vs-game').value,
          },
        });
        if (r.ok) toast('启动参数已保存', 'ok');
        else toast(r.error || '保存失败', 'error');
      });
    }

    /* ------------------------------ 目录 ------------------------------ */

    function drawFolder() {
      const gameDir = `${inst.dir}\\.minecraft`;
      const items = [
        { label: '实例目录', path: inst.dir, desc: 'instance.json 与整个游戏目录都在这里' },
        { label: '游戏目录（.minecraft）', path: gameDir, desc: 'mods / saves / resourcepacks / config 都在这' },
        { label: 'mods 目录', path: `${gameDir}\\mods`, desc: '放模组 jar' },
        { label: 'saves 目录', path: `${gameDir}\\saves`, desc: '存档' },
        { label: '日志目录', path: state.settings.home ? `${state.settings.home}\\logs` : '', desc: 'latest.log 在这里' },
      ];
      setHTML(
        pane,
        html`<div class="card">
          <div class="card__title">打开目录 / 文件</div>
          <div class="list">
            ${items.map(
              (it) => html`<div class="row" data-path="${it.path}">
                <div class="row__main">
                  <div class="row__title">${it.label}</div>
                  <div class="row__meta"><span class="mono">${it.path || '未知'}</span></div>
                  <div class="row__meta"><span>${it.desc}</span></div>
                </div>
                <div class="row__actions">
                  <button class="btn btn--ghost btn--sm" data-act="open" type="button">${raw(icon('folder', 14))}打开</button>
                </div>
              </div>`
            )}
          </div>
          <div class="field__hint" style="margin-top:8px">如果目录不存在，主进程会返回中文错误提示，不会静默失败。</div>
        </div>`
      );
      pane.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act="open"]');
        const row = e.target.closest('[data-path]');
        if (!btn || !row) return;
        const p = row.dataset.path;
        if (!p) {
          toast('还没有 QCL 主目录信息', 'warn');
          return;
        }
        const r = await call('shell:openPath', { path: p });
        if (!r.ok) toast(r.error || '打开失败', 'error', 5000);
      });
    }

    draw();
    return {};
  },
};

export default versionSettingPage;
