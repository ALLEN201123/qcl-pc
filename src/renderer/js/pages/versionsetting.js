/**
 * QCL 电脑版 · 版本设置（单个实例）
 *
 * 数据来源：`instances:list` 里的 Instance + `java:list`（可选 Java）+ `settings:get`（全局默认）。
 * 写入：`instances:update { id, patch }`（实例级）/ `settings:set`（全局启动参数）。
 */

import { call, on } from '../bridge.js';
import { state, loadInstances, loadJava, saveSettings, notify } from '../store.js';
import { html, raw, setHTML, toast, fmtDate, fmtDuration, fmtRelative, fmtBytes, loaderLabel, openModal } from '../ui.js';
import { icon } from '../icons.js';
import { PRESET_ICONS, instanceIconUrl } from '../instanceicon.js';

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
 * 加载器中文名。
 * ★ 不能直接用 ui.js 的 `loaderLabel()` 兜底：它的 LOADER_NAME 里没有 modloader / babric，
 *   会原样显示英文 `modloader`（界面铁律是一个英文单词都不许漏出来）。
 */
const LOADER_TEXT = {
  vanilla: '原版',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  modloader: 'ModLoader',
  babric: 'Babric',
  optifine: 'OptiFine',
  liteloader: 'LiteLoader',
};

/**
 * 当前实例的加载器信息（「模组加载器」卡片 & 补装弹窗默认值都用它）。
 * `inst.loader` 形如 `{ type:'fabric', version:'0.20.1' }`；
 * OptiFine 可能挂在 `loader.optifine`，也可能是实例顶层的 `optifine`，两种都认。
 */
function currentLoaderInfo(inst) {
  const l = (inst && inst.loader) || null;
  const type = l && l.type ? String(l.type) : 'vanilla';
  const version = l && l.version ? String(l.version) : '';
  const optifine = (l && l.optifine) || (inst && inst.optifine) || '';
  const isVanilla = !type || type === 'vanilla';
  const base = isVanilla ? '原版（没有模组加载器）' : `${LOADER_TEXT[type] || type}${version ? ` ${version}` : ''}`;
  return {
    type: isVanilla ? 'vanilla' : type,
    version,
    optifine: optifine ? String(optifine) : '',
    base,
    label: optifine ? `${base} + OptiFine ${optifine}` : base,
  };
}

/** 远古版本 id（ModLoader 时代：pre-classic / classic / indev / infdev / alpha / beta） */
const ANCIENT_VERSION_RE = /^(rd-|pc-|c0\.|in[-d]|inf|a\d+\.\d|b\d+\.\d|pre-?classic|classic|indev|infdev|alpha|beta)/i;

/** 解析主版本号：'1.12.2' → [1,12,2]；快照 / 远古 id → null */
function mcTupleOf(id) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(id || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

/** 1.13 及以后的 OptiFine 必须装在 Forge 上（用户明确要求两者能同时选） */
function optiFineNeedsForge(mcVersion) {
  const t = mcTupleOf(mcVersion);
  if (!t) return !ANCIENT_VERSION_RE.test(String(mcVersion || ''));
  return t[0] > 1 || (t[0] === 1 && t[1] >= 13);
}

/**
 * 推荐加载器（与 download.js 同一套规则，PC 版两处行为必须一致）：
 *   远古 → ModLoader（b1.7.3 也可 Babric） / 1.0~1.13.2 → Forge / 1.14+ → Fabric
 */
function pickRecommendedLoader(mcVersion) {
  const s = String(mcVersion || '');
  if (ANCIENT_VERSION_RE.test(s)) {
    if (/^b1\.7\.3/i.test(s)) return { type: 'babric', why: 'b1.7.3 推荐 Babric（Fabric 分支）；想装老 mod 就选 ModLoader' };
    return { type: 'modloader', why: '远古版本没有 Fabric/Forge，只能装 ModLoader（或 Babric）' };
  }
  const t = mcTupleOf(s);
  if (t && (t[0] < 1 || (t[0] === 1 && t[1] < 14))) return { type: 'forge', why: '1.14 之前 Fabric 支持不全，推荐 Forge' };
  return { type: 'fabric', why: '1.14 起 Fabric 生态最全、启动最快' };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 可选的实例图标（照安卓版 res/drawable/ic_mm_*.png 移植的 24 个 MultiMC 风格图标）。
 * 文件放在 src/renderer/assets/instance-icons/ 下，去掉 ic_mm_ 前缀当 id。
 *
 * ★ 2026-11-07：白名单与显示逻辑统一到 instanceicon.js，
 *   以前这里和版本列表各存一份，容易漂移（而且版本列表根本不读 inst.icon）。
 */
const INSTANCE_ICONS = PRESET_ICONS;

/** 图标 URL */
/** 预置图标的 URL（点选网格里的每一张小图用） */
function iconUrl(name) {
  return `./assets/instance-icons/${name}.png`;
}

/**
 * 「当前图标」大图要显示的地址：优先自定义图片，其次预置，最后兜底。
 * ★ 用共享的 instanceIconUrl，保证和版本列表 / 主页 / 右栏完全一致。
 */
function currentIconUrl(inst) {
  return instanceIconUrl(inst);
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
      // ★ 「当前」用真实生效的图标（自定义图片优先），网格里高亮用预置名
      const currentName = inst.icon || 'grass';
      const isCustom = !!inst.iconUrl;
      setHTML(
        pane,
        html`<div class="vset-sec">
          <div class="vset-sec__title">实例图标</div>
          <div class="vset-sec__desc">
            图标会显示在版本列表、主页「我的实例」和右下角版本行上。选中即时保存。
          </div>

          <div class="icon-current">
            <img class="icon-current__img" src="${currentIconUrl(inst)}" alt="" />
            <div class="icon-current__text">
              <div class="icon-current__name">当前：${isCustom ? '自定义图片' : currentName}</div>
              <div class="icon-current__hint">${isCustom ? '正在使用你选的图片（下面的预置图标可覆盖它）' : '也可以用自己的图片（下面「自定义图标」）'}</div>
            </div>
          </div>

          <div class="icon-grid">
            ${INSTANCE_ICONS.map(
              (n) => raw(`<button class="icon-grid__item ${!isCustom && n === currentName ? 'is-active' : ''}"
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
      // ★ 用「最新」的实例对象：装完加载器后 state.instances 会被整体替换，闭包里的 inst 会过期
      const cur = state.instances.find((x) => x.id === inst.id) || inst;
      const ldr = currentLoaderInfo(cur);
      setHTML(
        pane,
        html`<div class="card">
            <div class="card__title">模组加载器</div>
            <div class="loader-current">
              <span class="loader-current__label">当前</span>
              <span class="loader-current__value" id="vs-loader-value">${ldr.label}</span>
              ${ldr.type === 'vanilla' ? html`<span class="badge">原版</span>` : html`<span class="badge badge--accent">${LOADER_TEXT[ldr.type] || ldr.type}</span>`}
              ${ldr.optifine ? html`<span class="badge badge--ok">OptiFine ${ldr.optifine}</span>` : raw('')}
            </div>
            <div class="sourcetip" style="margin-top:9px">
              游戏版本 <strong>${cur.mcVersion || cur.installedVersion || '未知'}</strong> 已经装好了。
              这里可以<strong>只补装一个加载器（或 OptiFine）</strong>，不会重新下载游戏本体。
            </div>
            <div class="hstack" style="margin-top:10px">
              <button class="btn" id="vs-loader-open" type="button">${raw(icon('bolt', 14))}安装 / 更换加载器</button>
              <span class="page__sub">想玩模组就先装 Fabric / Forge</span>
            </div>
          </div>
          <div class="card">
            <div class="card__title">实例信息</div>
            <div class="kv">
              <div class="kv__k">名称</div>
              <div class="kv__v">${inst.name}</div>
              <div class="kv__k">游戏版本</div>
              <div class="kv__v">${inst.mcVersion}</div>
              <div class="kv__k">加载器</div>
              <div class="kv__v">${ldr.type === 'vanilla' ? '原版' : ldr.label}</div>
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

      /* ---------------- 自动安装加载器（照 HMCL AutoInstallPage） ---------------- */
      const loaderBtn = pane.querySelector('#vs-loader-open');
      if (loaderBtn) {
        loaderBtn.addEventListener('click', () => {
          openAutoInstall(cur, () => draw());
        });
      }

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
          <div class="card" id="vs-legacy-card">
            <div class="card__title">远古版本自动注入的 Java 参数</div>
            <div class="field__hint" id="vs-legacy-hint" style="margin-bottom:8px">正在查询…</div>
            <div id="vs-legacy-lines"></div>
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

      /**
       * ★ 显示启动器**真正会**给这个实例自动注入的两行远古兼容参数。
       *   数据来自主进程的 core/legacyargs.js（与 launch.js 共用同一份），
       *   不是写死的文案 —— 玩家在这里看到什么，启动时就加什么。
       */
      const loadLegacyArgs = async () => {
        const hint = pane.querySelector('#vs-legacy-hint');
        const lines = pane.querySelector('#vs-legacy-lines');
        if (!hint || !lines) return;
        const cur = state.instances.find((x) => x.id === inst.id) || inst;
        const r = await call('versions:legacyArgs', {
          id: cur.id,
          mcVersion: cur.mcVersion || '',
          installedVersion: cur.installedVersion || '',
          extraJvmArgs: pane.querySelector('#vs-jvm').value || '',
        }, { optional: true });
        const d = r && r.ok ? r.data : null;
        const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        if (!d) {
          hint.textContent = '暂时读不到（不影响启动，参数仍会自动注入）';
          return;
        }
        if (!d.legacy) {
          hint.textContent = `当前版本「${esc(d.versionId)}」不是远古版本，不注入这两行参数。`;
          lines.innerHTML = '';
          return;
        }
        if (d.overridden) {
          hint.textContent = '你在上面的 JVM 参数里自己写了代理/排序参数，启动器会跳过自动注入（以你写的为准）。';
        } else {
          hint.textContent = `当前版本「${esc(d.versionId)}」是远古版本，启动游戏时会自动加上下面 ${d.args.length} 行（照 Betacraft 兼容方案）：`;
        }
        lines.innerHTML = (d.allArgs || [])
          .map((a) => {
            const on = !d.overridden && (d.args || []).includes(a);
            return `<div class="legacy-arg ${on ? 'is-on' : 'is-off'}"><code>${esc(a)}</code><span>${on ? '已启用' : '未启用'}</span></div>`;
          })
          .join('');
      };
      loadLegacyArgs();
      // 玩家改了 JVM 参数后实时刷新「是否覆盖」
      pane.querySelector('#vs-jvm').addEventListener('input', loadLegacyArgs);

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

    /* ------------------------------------------------------------------
     * 自动安装 / 更换加载器（照 HMCL 的 AutoInstallPage）
     *
     * 用户原话：「游戏版本设置里面，你也没有加那个自动安装，让玩家安装过的游戏版本
     *           如果是原版，玩家可以去里面（版本设置）加加载器」
     *
     * 所以这里做的是「**已装好的实例，只补装加载器**」：
     *   · 不新建实例、不改名字、不重新下载游戏本体
     *   · 加载器版本从 `loader:versions` 查，默认最新，允许自己挑旧版
     *   · OptiFine 是可叠加项：1.13+ 必须配 Forge（勾了就自动切 Forge，照 download.js 那套）
     *   · 提交 `install:start({ id, mcVersion, loader, optifineVersion? })`，
     *     ★ 没勾 OptiFine 时**不带** optifineVersion 字段（后端用 `!== undefined` 判定）
     *   · 进度订阅 `task:progress`，按 taskId 过滤，装完刷新本页
     * ------------------------------------------------------------------ */
    function openAutoInstall(target, onFinished) {
      const root = document.getElementById('modal-root');
      if (!root) return;

      const mcVersion = String(target.mcVersion || target.installedVersion || '');
      if (!mcVersion) {
        toast('这个实例没有记录游戏版本，查不了加载器版本', 'warn', 5000);
        return;
      }
      const cur = currentLoaderInfo(target);
      const REC = pickRecommendedLoader(mcVersion);
      const needForgeForOF = optiFineNeedsForge(mcVersion);

      const ROWS = [
        {
          type: 'vanilla',
          label: '原版',
          badge: '不带模组',
          desc: '不装加载器。选这个只是把启动方式改回原版，已有的模组文件不会删。',
        },
        {
          type: 'fabric',
          label: 'Fabric',
          badge: '轻量',
          desc: '启动快，Sodium / Iris 这类优化与光影模组都基于它。',
        },
        {
          type: 'forge',
          label: 'Forge',
          badge: '模组最多',
          desc: '老牌加载器，整合包与大型模组生态最全；OptiFine 在 1.13+ 必须配它。',
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
        {
          type: 'modloader',
          label: 'ModLoader',
          badge: '远古',
          desc: '1.6.2 / Beta / Alpha 时代的标配，只在真正支持这个版本时才出现。',
          opt: true,
        },
        {
          type: 'babric',
          label: 'Babric',
          badge: '远古 · Fabric 分支',
          desc: 'b1.7.3 专用的 Fabric 分支，能跑现代性能模组。',
          opt: true,
        },
      ];

      const rowsHTML = ROWS.map(
        (o) => `<div class="loader-item ${o.opt ? 'loader-item--off' : ''}" role="button" tabindex="0" data-loader="${o.type}">
          <span class="loader-item__main">
            <span class="loader-item__title">
              ${escapeHtml(o.label)}
              <span class="badge">${escapeHtml(o.badge)}</span>
              <span class="loader-item__rec" data-rectag="${o.type}" hidden>推荐</span>
              <span class="loader-item__ver" data-ver="${o.type}">${o.type === 'vanilla' ? '' : '查询版本中…'}</span>
            </span>
            <span class="loader-item__desc">${escapeHtml(o.desc)}</span>
          </span>
          <span class="loader-item__side">
            ${
              o.type === 'vanilla'
                ? ''
                : `<label class="loader-item__selwrap" title="想装别的版本就自己挑">
                     <span class="loader-item__sellabel">版本</span>
                     <select class="select loader-item__sel" data-selver="${o.type}" hidden></select>
                   </label>`
            }
            <span class="loader-item__go">选中</span>
          </span>
        </div>`
      ).join('');

      root.hidden = false;
      root.innerHTML = `
        <div class="modal modal--loader">
          <div class="modal__head">
            <div class="modal__title">安装加载器 · ${escapeHtml(target.name || mcVersion)}</div>
            <button class="winbtn" data-close type="button" title="关闭（Esc）">${icon('close', 14)}</button>
          </div>
          <div class="modal__body">
            <div class="loader-intro">
              给<strong>已经装好的实例</strong>补装一个模组加载器 —— 只下载加载器，<strong>不会重新下载游戏本体</strong>。
              <br />
              <span class="loader-intro__rec" id="vs-al-why">Minecraft ${escapeHtml(mcVersion)}：${escapeHtml(REC.why)}</span>
              <br />
              <span class="loader-intro__warn" id="vs-al-warn" hidden></span>
            </div>
            <div class="loader-list" id="vs-al-list">${rowsHTML}</div>
            <div class="loader-extras">
              <div class="loader-extras__title">另外一起装（可选）</div>
              <div class="loader-of">
                <label class="loader-of__check">
                  <input type="checkbox" id="vs-al-of" disabled />
                  <span>OptiFine（高清修复）</span>
                </label>
                <select class="select loader-of__ver" id="vs-al-of-ver" disabled></select>
                <span class="loader-of__hint" id="vs-al-of-hint">查询 OptiFine 版本中…</span>
              </div>
            </div>
            <div class="loader-progress" id="vs-al-lp" hidden>
              <div class="loader-progress__row">
                <span class="loader-progress__stage" id="vs-al-lp-stage">准备中…</span>
                <span class="loader-progress__pct" id="vs-al-lp-pct">0%</span>
              </div>
              <div class="progress"><div class="progress__bar" id="vs-al-lp-bar" style="width:0%"></div></div>
            </div>
            <div class="loader-hint">★ 加载器版本默认挑最新稳定版；想用旧版（比如整合包指定的那个）就在右边的下拉里自己选。</div>
          </div>
          <div class="modal__foot">
            <button class="btn btn--ghost" data-act="cancel" id="vs-al-cancel" type="button">取消</button>
            <button class="btn btn--primary" data-act="go" id="vs-al-go" type="button" disabled>开始安装</button>
          </div>
        </div>`;

      const modal = root.firstElementChild;
      const lp = modal.querySelector('#vs-al-lp');
      const lpStage = modal.querySelector('#vs-al-lp-stage');
      const lpPct = modal.querySelector('#vs-al-lp-pct');
      const lpBar = modal.querySelector('#vs-al-lp-bar');
      const goBtn = modal.querySelector('#vs-al-go');
      const cancelBtn = modal.querySelector('#vs-al-cancel');
      const ofBox = modal.querySelector('#vs-al-of');
      const ofSel = modal.querySelector('#vs-al-of-ver');
      const ofHint = modal.querySelector('#vs-al-of-hint');

      /** verMap[type] = { versions, latest, label? } / null（查不到或不支持）/ undefined（查询中） */
      const verMap = Object.create(null);
      let picked = null;
      let running = false;
      let taskId = '';
      let offProg = null;
      let doneTimer = null;
      let watchdog = null;
      let autoSwitching = false;

      const finish = () => {
        if (doneTimer) clearTimeout(doneTimer);
        if (watchdog) clearTimeout(watchdog);
        doneTimer = null;
        watchdog = null;
        if (typeof offProg === 'function') offProg();
        offProg = null;
        document.removeEventListener('keydown', onKey, true);
        root.hidden = true;
        root.innerHTML = '';
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (running) {
            toast('正在安装，先点「取消安装」再关窗口', 'warn', 3000);
            return;
          }
          finish();
        }
      };
      document.addEventListener('keydown', onKey, true);

      /* ---------------- 版本查询 ---------------- */
      const names = {
        fabric: 'Fabric',
        forge: 'Forge',
        neoforge: 'NeoForge',
        quilt: 'Quilt',
        modloader: 'ModLoader',
        babric: 'Babric',
        optifine: 'OptiFine',
      };

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

      const isAvail = (type) => {
        if (type === 'vanilla') return true;
        const info = verMap[type];
        if (info === undefined) return true;
        return !!info;
      };

      /** 推荐标：等版本查完再标，避免标到「该版本没有 Fabric」的灰行上 */
      const applyRec = () => {
        const want = REC.type;
        modal.querySelectorAll('[data-rectag]').forEach((tag) => {
          tag.hidden = tag.getAttribute('data-rectag') !== want;
        });
        modal.querySelectorAll('[data-loader]').forEach((row) => {
          row.classList.toggle('is-rec', row.getAttribute('data-loader') === want && isAvail(want));
        });
      };

      const loadVer = (type) => {
        return call('loader:versions', { mcVersion, loader: type }, { optional: true })
          .then((res) => {
            const data = res && res.ok !== false ? res.data || res : null;
            const slot = (data && data[type]) || null;
            const arr = (slot && Array.isArray(slot.versions) && slot.versions) || [];
            /**
             * ModLoader 没有「版本号」这个概念（后端只会给 available + label）
             * ⇒ 版本下拉要藏起来；Babric 有版本，走普通分支（与 download.js 保持一致）。
             */
            if (type === 'modloader') {
              verMap[type] = slot && slot.available ? { latest: null, total: 0, label: slot.label || names[type] } : null;
            } else {
              verMap[type] = arr.length ? { versions: arr, latest: slot.latest || arr[0], total: arr.length } : null;
            }
            if (!slot && res && res.error) {
              const warn = modal.querySelector('#vs-al-warn');
              if (warn && warn.hidden) {
                warn.hidden = false;
                warn.textContent = `加载器版本查询失败（${res.error}），下拉里可能没有版本可挑`;
              }
            }

            // 版本下拉：默认最新；如果这个实例已经装过同类加载器，就默认选它装的那个版本
            const sel = modal.querySelector(`[data-selver="${type}"]`);
            if (sel) {
              if (arr.length) {
                sel.innerHTML = arr
                  .slice(0, 500)
                  .map((v, i) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}${i === 0 ? '（最新）' : ''}</option>`)
                  .join('');
                if (cur.type === type && cur.version && arr.includes(cur.version)) sel.value = cur.version;
                sel.hidden = false;
                sel.addEventListener('change', () => {
                  const badge = modal.querySelector(`[data-ver="${type}"]`);
                  if (badge) {
                    badge.textContent = `已选 ${sel.value}`;
                    badge.className = 'loader-item__ver is-ok';
                  }
                });
              } else {
                sel.hidden = true;
              }
            }

            if (type === 'optifine') fillOptiFine();
          })
          .catch(() => {
            verMap[type] = null;
          })
          .then(() => {
            // 远古的两个老加载器初始是隐藏的：查完才知道到底支不支持，这时再决定显示与否
            if (type === 'modloader' || type === 'babric') {
              const row = modal.querySelector(`[data-loader="${type}"]`);
              if (row) row.classList.toggle('loader-item--off', !isAvail(type));
            }
            paintVer(type);
            applyRec();

            /**
             * ★ 任务要求：空数组的加载器要「灰掉」。
             *   查询中不算否定（isAvail 为 true），查完之后 verMap[type] === null 才是真没有
             *   ⇒ 加 .is-unavailable（灰 + 不可点），并且如果它正好是刚才预选中的那个，就取消选中，
             *     免得用户以为「已经选好了」却提交一个没有版本的加载器。
             */
            if (type !== 'vanilla' && verMap[type] === null) {
              const row = modal.querySelector(`[data-loader="${type}"]`);
              if (row) row.classList.add('is-unavailable');
              if (picked === type) {
                picked = null;
                modal.querySelectorAll('[data-loader]').forEach((r) => r.classList.remove('is-picked'));
                if (goBtn) goBtn.disabled = true;
              }
            }
          });
      };

      /* ---------------- OptiFine ---------------- */
      const fillOptiFine = () => {
        const info = verMap.optifine;
        const list = (info && Array.isArray(info.versions) && info.versions) || [];
        if (!list.length) {
          ofSel.innerHTML = '';
          ofSel.disabled = true;
          ofBox.disabled = true;
          ofBox.checked = false;
          ofHint.textContent = `这个版本没有 OptiFine（${mcVersion}）`;
          return;
        }
        ofSel.innerHTML = list
          .map((v, i) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}${i === 0 ? '（最新）' : ''}</option>`)
          .join('');
        ofSel.disabled = false;
        ofBox.disabled = false;
        ofHint.textContent = needForgeForOF
          ? '这个版本要装在 Forge 上，勾选后会自动把加载器切成 Forge'
          : '这个版本用官方补丁模式装，可以单独装，也可以配 ModLoader';
        // 实例本来就带 OptiFine → 默认勾上并选回原来的版本
        if (cur.optifine) {
          ofBox.checked = true;
          if (list.includes(cur.optifine)) ofSel.value = cur.optifine;
          enforceOptiFineLoader();
        }
      };

      /** 勾了 OptiFine 且 1.13+ 却不是 Forge/NeoForge → 自动切 Forge 并提示一次 */
      const enforceOptiFineLoader = () => {
        if (!ofBox || !ofBox.checked) return;
        if (autoSwitching) return;
        if (!needForgeForOF) return;
        if (picked === 'forge' || picked === 'neoforge') return;
        const forgeRow = modal.querySelector('[data-loader="forge"]');
        if (!forgeRow) return;
        autoSwitching = true;
        forgeRow.click();
        autoSwitching = false;
        toast('1.13 及以后的 OptiFine 需要 Forge，已自动把加载器切成 Forge', 'info', 5000);
      };

      /* ---------------- 选中 / 提交 ---------------- */
      modal.querySelectorAll('[data-loader]').forEach((row) => {
        const type0 = row.getAttribute('data-loader');
        const innerSel = modal.querySelector(`[data-selver="${type0}"]`);
        if (innerSel) {
          ['click', 'mousedown'].forEach((ev) => innerSel.addEventListener(ev, (e) => e.stopPropagation()));
        }
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            row.click();
          }
        });
        row.addEventListener('click', () => {
          if (running) return;
          if (row.classList.contains('loader-item--off')) return;
          if (row.classList.contains('is-unavailable')) return;
          picked = row.getAttribute('data-loader');
          modal.querySelectorAll('[data-loader]').forEach((r) => r.classList.toggle('is-picked', r === row));
          if (goBtn) goBtn.disabled = false;
          enforceOptiFineLoader();
        });
      });

      if (ofBox) ofBox.addEventListener('change', () => enforceOptiFineLoader());

      const setProgress = (stage, pct, state) => {
        lp.hidden = false;
        lp.classList.toggle('is-error', state === 'error');
        lp.classList.toggle('is-done', state === 'done');
        lpStage.textContent = stage;
        const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
        lpPct.textContent = `${n}%`;
        lpBar.style.width = `${n}%`;
      };

      const submit = async () => {
        if (running) return;
        const type = picked || 'vanilla';
        let ver;
        if (type !== 'vanilla' && type !== 'modloader') {
          const selEl = modal.querySelector(`[data-selver="${type}"]`);
          ver = (selEl && !selEl.hidden && selEl.value ? String(selEl.value) : '') || (verMap[type] && verMap[type].latest) || undefined;
        }

        const payload = { id: target.id, mcVersion };
        // ★ 选「原版」时 loader 传 null（把实例改回原版启动），不是省略字段
        payload.loader = type === 'vanilla' ? null : { type, ...(ver ? { version: ver } : {}) };

        // ★ 没勾 OptiFine 就**不要**带这个字段：后端用 `!== undefined` 判定
        let optifineVersion;
        if (ofBox && ofBox.checked && !ofBox.disabled) {
          optifineVersion = ofSel && ofSel.value ? String(ofSel.value) : '';
        }
        if (optifineVersion !== undefined) payload.optifineVersion = optifineVersion;

        running = true;
        goBtn.disabled = true;
        goBtn.textContent = '正在安装…';
        cancelBtn.textContent = '取消安装';
        setProgress(`正在安装 ${type === 'vanilla' ? '原版' : names[type] || type}…`, 0);

        const r = await call('install:start', payload, { optional: true });
        if (!r.ok && (!r.data || !r.data.taskId)) {
          running = false;
          goBtn.disabled = false;
          goBtn.textContent = '开始安装';
          cancelBtn.textContent = '取消';
          setProgress(r.error || '安装启动失败', 0, 'error');
          toast(r.error || '安装启动失败', 'error', 6000);
          return;
        }

        taskId = String((r.data && r.data.taskId) || '');
        if (!taskId) {
          // 后端没给 taskId：没法订阅进度，如实告诉用户去看下载页的任务条
          running = false;
          goBtn.disabled = false;
          goBtn.textContent = '重新安装';
          setProgress('已提交安装（没有拿到任务 ID，进度请看「下载」页的安装任务）', 0);
          return;
        }

        offProg = on('task:progress', (p) => {
          if (!p || String(p.taskId) !== taskId) return;
          const pct = Number.isFinite(Number(p.percent))
            ? Number(p.percent)
            : p.total
              ? (Number(p.current) / Number(p.total)) * 100
              : 0;
          const stage = String(p.stage || p.phase || '安装中…');
          setProgress(stage, pct);
          if (p.done !== true) return;

          if (watchdog) {
            clearTimeout(watchdog);
            watchdog = null;
          }

          if (p.error || p.ok === false) {
            running = false;
            goBtn.disabled = false;
            goBtn.textContent = '重试';
            cancelBtn.textContent = '关闭';
            setProgress(String(p.error || stage || '安装失败'), pct, 'error');
            toast(String(p.error || '安装失败'), 'error', 7000);
            if (typeof offProg === 'function') offProg();
            offProg = null;
            return;
          }

          // 成功：**先刷新数据**（用户中途关窗也不会丢），再自动关窗
          setProgress('装好了，可以回首页启动', 100, 'done');
          if (typeof offProg === 'function') offProg();
          offProg = null;
          toast(`加载器安装完成：${target.name || mcVersion} 现在可以装模组了`, 'ok', 5200);
          void (async () => {
            try {
              await loadInstances();
              notify('instances');
              if (typeof onFinished === 'function') onFinished();
            } catch (err) {
              console.warn('[QCL] 刷新实例失败（不影响安装结果）：', err);
            }
          })();
          doneTimer = setTimeout(() => finish(), 1600);
        });

        // 兜底：5 分钟还没收到 done，就别让窗口一直显示「正在安装」
        watchdog = setTimeout(() => {
          if (!running) return;
          running = false;
          goBtn.disabled = false;
          goBtn.textContent = '重新安装';
          cancelBtn.textContent = '关闭';
          setProgress('好久没收到安装进度了（可能已结束或卡住），可以关掉窗口后看实例状态', 0, 'error');
          if (typeof offProg === 'function') offProg();
          offProg = null;
        }, 5 * 60 * 1000);
      };

      if (goBtn) goBtn.addEventListener('click', submit);

      if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
          if (!running) {
            finish();
            return;
          }
          const ok = await call('install:cancel', { taskId }, { optional: true });
          if (!ok.ok) {
            toast(ok.error || '取消失败', 'warn', 4000);
            return;
          }
          running = false;
          goBtn.disabled = false;
          goBtn.textContent = '重新安装';
          cancelBtn.textContent = '关闭';
          setProgress('已请求取消安装', 0, 'error');
          if (typeof offProg === 'function') offProg();
          offProg = null;
        });
      }

      modal.querySelector('[data-close]').addEventListener('click', () => {
        if (running) {
          toast('正在安装，先点「取消安装」再关窗口', 'warn', 3000);
          return;
        }
        finish();
      });
      modal.onmousedown = (e) => {
        if (e.target === modal && !running) finish();
      };

      // 异步查版本：原版不用查；OptiFine 也要查（喂勾选框）
      loadVer('optifine');
      ROWS.forEach((o) => {
        if (o.type === 'vanilla') return;
        loadVer(o.type);
      });

      // 默认选中：已经装了加载器就选它，否则选推荐项
      setTimeout(() => {
        /**
         * ★ 如果这 80ms 内用户（或自测脚本）已经自己点过一行了，**绝不能**再覆盖他的选择
         *   —— 否则刚点完「原版」又被自动选回 Fabric，看起来像点不动。
         */
        if (picked) return;
        const want = cur.type !== 'vanilla' ? cur.type : REC.type;
        const row = modal.querySelector(`[data-loader="${want}"]`);
        if (row && !row.classList.contains('loader-item--off')) row.click();
        else {
          const v = modal.querySelector('[data-loader="vanilla"]');
          if (v) v.click();
        }
        applyRec();
      }, 80);
    }

    draw();
    return {};
  },
};

export default versionSettingPage;
