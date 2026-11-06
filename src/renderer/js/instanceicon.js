/**
 * QCL 电脑版 · 实例图标解析（单一事实来源）
 *
 * ★★★ 2026-11-07 修（用户反馈：版本设置里选的图标完全不生效，
 *   版本列表 / 主页 / 右栏永远显示草方块）。
 *
 * 根因有三处，全在这里统一收口：
 *   ① 版本列表 `ICON_FOR_TYPE` 把所有加载器都映射成 ic_grass，
 *      而且取值表达式写的是 `inst.loader.type || inst.icon` —— 加载器永远有值，
 *      `inst.icon` 永远轮不到，等于**用户选什么都被无视**。
 *   ② shell.js 两处写死 `./assets/icon/ic_grass.png`（右栏版本行 img 与 updateRightPanel）。
 *   ③ 后端 hydrate 不返回 iconFile，自定义图片即使存了也拿不到地址。
 *      （③ 已在 core/instances.js 补上 iconFile + iconUrl）
 *
 * 现在的优先级：
 *   ① 自定义图片（iconUrl）—— 玩家自己选的 PNG，最高优先级
 *   ② 预置图标（icon → assets/instance-icons/<name>.png）
 *   ③ 都没有才回落草方块
 *
 * 用法（渲染层）：
 *   - pages 目录下的页面：从 instanceicon.js 导入 instanceIconUrl / instanceIconAlt
 *   - js 根目录下的文件：同目录直接导入
 *   然后把结果放进 img 的 src 属性即可。
 */

/** 预置图标目录（24 个 MultiMC 风格图标） */
const PRESET_DIR = './assets/instance-icons';
/** 兜底图标 */
export const FALLBACK_ICON = './assets/icon/ic_grass.png';

/** 合法的预置图标名（与 versionsetting.js 的 INSTANCE_ICONS 一致） */
export const PRESET_ICONS = [
  'grass', 'dirt', 'stone', 'diamond', 'gold', 'iron', 'brick', 'planks',
  'creeper', 'chicken', 'skeleton', 'steve', 'herobrine', 'squarecreeper',
  'flame', 'tnt', 'enderpearl', 'netherstar', 'gear', 'magitech',
  'meat', 'infinity', 'ftb_logo', 'ftb_glow',
];

const PRESET_SET = new Set(PRESET_ICONS);

/**
 * 算出一个实例应该显示哪个图标。
 * @param {object|null} inst 实例对象（来自 store.state.instances / instances:list）
 * @returns {string} 可直接放进 <img src> 的地址
 */
export function instanceIconUrl(inst) {
  if (!inst || typeof inst !== 'object') return FALLBACK_ICON;

  // ① 自定义图片：后端 hydrate 给的 iconUrl（qcl://app/__instanceicon__/xxx.png）
  if (inst.iconUrl && typeof inst.iconUrl === 'string') return inst.iconUrl;

  // 兼容：只有 iconFile 没有 iconUrl 时，从文件名推出来
  if (inst.iconFile && typeof inst.iconFile === 'string') {
    const m = /([A-Za-z0-9_-]+)\.png$/i.exec(inst.iconFile);
    if (m) return `qcl://app/__instanceicon__/${m[1]}.png`;
  }

  // ② 预置图标：只认白名单里的名字，防止存了脏值导致 404
  const name = String(inst.icon || '').trim();
  if (name && PRESET_SET.has(name)) return `${PRESET_DIR}/${name}.png`;

  // ③ 兜底
  return FALLBACK_ICON;
}

/** 图标的可读名字（给 alt / title 用） */
export function instanceIconAlt(inst) {
  if (inst && inst.iconUrl) return '自定义图标';
  const name = String((inst && inst.icon) || '').trim();
  if (name && PRESET_SET.has(name)) return name;
  return 'grass';
}
