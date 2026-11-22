'use strict';
/**
 * server.properties 读写（完整版）
 *
 * ★ 安卓 1.6.6 只暴露了 15 项（motd/port/gamemode/difficulty/pvp/max-players/
 *   view-distance/online-mode/white-list/enable-command-block/level-name/enable-rcon），
 *   而服务端实际有 60+ 项。这里全部覆盖，并按「常用 / 进阶 / 世界生成」分组，
 *   让 PC 玩家不用手改文本。
 *
 * ★ 三条设计原则：
 *   ① **保留原文件的注释与顺序** —— 玩家手改过的内容不能被覆盖掉
 *   ② 值类型明确（boolean / number / string），写回时按 Java Properties 规则转义
 *   ③ 未知键原样保留（服务端加新键时不会丢）
 */

const fs = require('node:fs');
const path = require('node:path');

/* ============================================================
 * 字段定义
 * ============================================================
 * type: boolean | number | string | enum
 * group: basic | gameplay | world | network | advanced
 * 每项都带中文标签与说明，界面直接照着渲染即可。
 */
const FIELDS = [
  // ---------- 基础 ----------
  {
    key: 'motd',
    type: 'string',
    group: 'basic',
    label: '服务器标语',
    desc: '多人游戏列表里显示的名字，支持 § 颜色代码',
    def: 'A Minecraft Server',
  },
  {
    key: 'server-port',
    type: 'number',
    group: 'basic',
    label: '端口',
    desc: '默认 25565；同一台机器开多个服务端要改成不同端口',
    def: 25565,
    min: 1,
    max: 65535,
  },
  {
    key: 'max-players',
    type: 'number',
    group: 'basic',
    label: '最大玩家数',
    desc: '同时在线人数上限',
    def: 20,
    min: 1,
    max: 1000,
  },
  {
    key: 'gamemode',
    type: 'enum',
    group: 'basic',
    label: '默认游戏模式',
    desc: '新玩家进服的模式',
    def: 'survival',
    options: ['survival', 'creative', 'adventure', 'spectator'],
  },
  {
    key: 'difficulty',
    type: 'enum',
    group: 'basic',
    label: '难度',
    desc: 'peaceful 不掉血；hardcore 需要在硬核模式另设',
    def: 'easy',
    options: ['peaceful', 'easy', 'normal', 'hard'],
  },
  {
    key: 'online-mode',
    type: 'boolean',
    group: 'basic',
    label: '正版验证',
    desc: '开启后只允许正版账号进服；离线（盗版）服要关掉',
    def: true,
  },
  {
    key: 'white-list',
    type: 'boolean',
    group: 'basic',
    label: '启用白名单',
    desc: '开启后只有白名单里的玩家能进',
    def: false,
  },
  {
    key: 'level-name',
    type: 'string',
    group: 'basic',
    label: '世界文件夹名',
    desc: '存档目录名，默认 world',
    def: 'world',
  },

  // ---------- 玩法 ----------
  { key: 'pvp', type: 'boolean', group: 'gameplay', label: '允许 PVP', desc: '玩家之间能否互相伤害', def: true },
  { key: 'hardcore', type: 'boolean', group: 'gameplay', label: '硬核模式', desc: '死亡即封禁（需 difficulty=hard）', def: false },
  { key: 'allow-flight', type: 'boolean', group: 'gameplay', label: '允许飞行', desc: '关闭时玩家用飞行会被踢（装了飞行类模组要开）', def: false },
  { key: 'allow-nether', type: 'boolean', group: 'gameplay', label: '允许下界', desc: '能否进入下界', def: true },
  { key: 'spawn-animals', type: 'boolean', group: 'gameplay', label: '生成动物', desc: '和平难度下无效', def: true },
  { key: 'spawn-monsters', type: 'boolean', group: 'gameplay', label: '生成怪物', desc: '和平难度下无效', def: true },
  { key: 'spawn-npcs', type: 'boolean', group: 'gameplay', label: '生成村民', desc: '村庄里的 NPC', def: true },
  { key: 'enable-command-block', type: 'boolean', group: 'gameplay', label: '启用命令方块', desc: '关闭时命令方块不执行', def: false },
  { key: 'force-gamemode', type: 'boolean', group: 'gameplay', label: '强制游戏模式', desc: '玩家每次进服都重置为默认模式', def: false },
  { key: 'player-idle-timeout', type: 'number', group: 'gameplay', label: '挂机踢出（分钟）', desc: '0 = 不踢', def: 0, min: 0, max: 1440 },
  { key: 'max-world-size', type: 'number', group: 'gameplay', label: '世界边界半径', desc: '单位方块，默认 29999984', def: 29999984, min: 1 },

  // ---------- 世界生成 ----------
  {
    key: 'level-type',
    type: 'enum',
    group: 'world',
    label: '世界类型',
    desc: '新世界生效；已有世界改这里不会重建',
    def: 'minecraft:normal',
    options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'],
  },
  { key: 'level-seed', type: 'string', group: 'world', label: '世界种子', desc: '留空随机；只在新建世界时生效', def: '' },
  { key: 'generate-structures', type: 'boolean', group: 'world', label: '生成结构', desc: '村庄/神殿/要塞等', def: true },
  { key: 'view-distance', type: 'number', group: 'world', label: '视距（区块）', desc: '越小越省性能，默认 10', def: 10, min: 3, max: 32 },
  { key: 'simulation-distance', type: 'number', group: 'world', label: '模拟距离', desc: '实体/红石活跃范围，1.18+ 才有', def: 10, min: 3, max: 32 },
  { key: 'max-tick-time', type: 'number', group: 'world', label: '单 tick 超时（毫秒）', desc: '-1 = 禁用看门狗（卡服时不会自杀）', def: 60000, min: -1 },
  { key: 'spawn-protection', type: 'number', group: 'world', label: '出生点保护半径', desc: '0 = 关闭（允许在出生点建造）', def: 16, min: 0 },

  // ---------- 网络 ----------
  { key: 'server-ip', type: 'string', group: 'network', label: '绑定 IP', desc: '留空 = 所有网卡；一般不用填', def: '' },
  { key: 'network-compression-threshold', type: 'number', group: 'network', label: '压缩阈值（字节）', desc: '-1 关闭，0 全压缩，默认 256', def: 256, min: -1 },
  { key: 'prevent-proxy-connections', type: 'boolean', group: 'network', label: '阻止代理连接', desc: '开正版验证时建议开', def: false },
  { key: 'enforce-secure-profile', type: 'boolean', group: 'network', label: '强制安全签名', desc: '1.19+ 才有；关掉可让离线客户端进', def: true },
  { key: 'enable-status', type: 'boolean', group: 'network', label: '响应服务器列表', desc: '关闭后多人列表看不到在线状态', def: true },
  { key: 'hide-online-players', type: 'boolean', group: 'network', label: '隐藏在线玩家', desc: '列表里不显示玩家名', def: false },

  // ---------- 进阶 / RCON ----------
  { key: 'enable-rcon', type: 'boolean', group: 'advanced', label: '启用 RCON', desc: '开启后可用 QCL 远程发命令、查在线玩家', def: false },
  { key: 'rcon.port', type: 'number', group: 'advanced', label: 'RCON 端口', desc: '默认 25575', def: 25575, min: 1, max: 65535 },
  { key: 'rcon.password', type: 'string', group: 'advanced', label: 'RCON 密码', desc: '必填；泄露等于把服务器控制权给出去', def: '' },
  { key: 'broadcast-rcon-to-ops', type: 'boolean', group: 'advanced', label: 'RCON 命令广播给 OP', desc: '', def: true },
  { key: 'enable-query', type: 'boolean', group: 'advanced', label: '启用 Query', desc: '第三方工具查服务器信息用', def: false },
  { key: 'query.port', type: 'number', group: 'advanced', label: 'Query 端口', desc: '默认与服务器端口相同', def: 25565, min: 1, max: 65535 },
  { key: 'op-permission-level', type: 'number', group: 'advanced', label: 'OP 权限等级', desc: '1~4，4 最高', def: 4, min: 1, max: 4 },
  { key: 'function-permission-level', type: 'number', group: 'advanced', label: '函数权限等级', desc: '1~4', def: 2, min: 1, max: 4 },
  { key: 'entity-broadcast-range-percentage', type: 'number', group: 'advanced', label: '实体同步范围 %', desc: '默认 100', def: 100, min: 10, max: 1000 },
  { key: 'max-chained-neighbor-updates', type: 'number', group: 'advanced', label: '连锁更新上限', desc: '-1 不限制（红石机器多时别调太小）', def: 1000000, min: -1 },
  { key: 'rate-limit', type: 'number', group: 'advanced', label: '速率限制', desc: '0 = 关闭', def: 0, min: 0 },
  { key: 'sync-chunk-writes', type: 'boolean', group: 'advanced', label: '同步写区块', desc: '关掉能提升性能，但断电可能丢进度', def: true },
  { key: 'log-ips', type: 'boolean', group: 'advanced', label: '日志记录 IP', desc: '', def: true },
  { key: 'text-filtering-config', type: 'string', group: 'advanced', label: '文本过滤配置', desc: '一般留空', def: '' },
];

const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]));

/** 分组中文名（界面用） */
const GROUPS = [
  { id: 'basic', label: '基础', desc: '标语、端口、人数、模式' },
  { id: 'gameplay', label: '玩法', desc: 'PVP、刷怪、命令方块、挂机' },
  { id: 'world', label: '世界生成', desc: '类型、种子、视距、出生点保护' },
  { id: 'network', label: '网络', desc: '绑定地址、压缩、正版签名' },
  { id: 'advanced', label: '进阶 / RCON', desc: '远程命令、Query、权限等级' },
];

/* ============================================================
 * 解析 / 序列化（保持注释与顺序）
 * ============================================================ */

/** Java Properties 的转义（值侧） */
function escapeValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** 反转义 */
function unescapeValue(v) {
  let out = '';
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i];
    if (c === '\\' && i + 1 < v.length) {
      const n = v[i + 1];
      if (n === 'n') { out += '\n'; i += 1; continue; }
      if (n === 'r') { out += '\r'; i += 1; continue; }
      if (n === 't') { out += '\t'; i += 1; continue; }
      if (n === '\\') { out += '\\'; i += 1; continue; }
      if (n === 'u' && i + 5 < v.length) {
        const hex = v.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue; }
      }
      out += n;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 解析 server.properties 文本。
 * @returns {{entries:Array<{key:string,value:string,raw:string,isComment:boolean}>, map:Object}}
 */
function parse(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const entries = [];
  const map = {};
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      entries.push({ key: '', value: '', raw, isComment: false, isBlank: true });
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) {
      entries.push({ key: '', value: '', raw, isComment: true });
      continue;
    }
    // key=value 或 key:value
    const m = /^([^=:\s]+)\s*[=:]\s?(.*)$/.exec(raw);
    if (!m) {
      entries.push({ key: '', value: '', raw, isComment: true });
      continue;
    }
    const key = m[1].trim();
    const value = unescapeValue(m[2]);
    entries.push({ key, value, raw, isComment: false });
    map[key] = value;
  }
  return { entries, map };
}

/**
 * 序列化回文本：**按原 entries 顺序输出**，值被改过的行就地替换，
 * 新增的键追加到末尾。这样玩家手写的注释不会丢。
 */
function serialize(entries, nextMap) {
  const out = [];
  const written = new Set();
  for (const e of entries) {
    if (e.isBlank || e.isComment) {
      out.push(e.raw);
      continue;
    }
    const key = e.key;
    if (Object.prototype.hasOwnProperty.call(nextMap, key) && !written.has(key)) {
      out.push(`${key}=${escapeValue(nextMap[key])}`);
      written.add(key);
    } else if (written.has(key)) {
      // 重复键：丢掉后面的
      continue;
    } else {
      // 本次没提供这个键 → 原样保留
      out.push(e.raw);
      written.add(key);
    }
  }
  // 追加新键
  for (const [k, v] of Object.entries(nextMap)) {
    if (!written.has(k)) out.push(`${k}=${escapeValue(v)}`);
  }
  return out.join('\n');
}

/* ============================================================
 * 类型转换
 * ============================================================ */

/** 按字段定义把字符串转成合适的 JS 值（界面显示用） */
function coerce(key, raw) {
  const f = FIELD_MAP.get(key);
  if (!f) return raw;
  if (f.type === 'boolean') return String(raw).trim().toLowerCase() === 'true';
  if (f.type === 'number') {
    const n = Number(String(raw).trim());
    return Number.isFinite(n) ? n : f.def;
  }
  return raw;
}

/** 把 JS 值转成要写进文件的字符串 */
function toRaw(key, value) {
  const f = FIELD_MAP.get(key);
  if (f && f.type === 'boolean') return value ? 'true' : 'false';
  if (f && f.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : String(f.def);
  }
  return String(value == null ? '' : value);
}

/** 校验一个值是否合法，返回错误文案或 null */
function validate(key, value) {
  const f = FIELD_MAP.get(key);
  if (!f) return null; // 未知键不校验
  if (f.type === 'boolean') {
    return typeof value === 'boolean' ? null : `${f.label} 必须是 true/false`;
  }
  if (f.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${f.label} 必须是数字`;
    if (Number.isFinite(f.min) && n < f.min) return `${f.label} 不能小于 ${f.min}`;
    if (Number.isFinite(f.max) && n > f.max) return `${f.label} 不能大于 ${f.max}`;
    return null;
  }
  if (f.type === 'enum') {
    return (f.options || []).includes(String(value)) ? null : `${f.label} 只能是：${(f.options || []).join(' / ')}`;
  }
  return null;
}

/* ============================================================
 * 文件级 API
 * ============================================================ */

function propsPath(workDir) {
  return path.join(workDir, 'server.properties');
}

/** 读：文件不存在时返回默认值集合（不写盘） */
function read(workDir) {
  const p = propsPath(workDir);
  let text = '';
  let exists = false;
  try {
    text = fs.readFileSync(p, 'utf8');
    exists = true;
  } catch {
    exists = false;
  }
  const parsed = exists ? parse(text) : { entries: [], map: {} };

  // 以字段定义为准，缺的用默认值补齐（方便界面渲染）
  const values = {};
  for (const f of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed.map, f.key)) {
      values[f.key] = coerce(f.key, parsed.map[f.key]);
    } else {
      values[f.key] = f.def;
    }
  }
  // 未知键也带上（原样展示，别丢）
  const unknown = {};
  for (const [k, v] of Object.entries(parsed.map)) {
    if (!FIELD_MAP.has(k)) unknown[k] = v;
  }
  return { exists, path: p, values, unknown, entries: parsed.entries };
}

/** 写：只写传入的键，其余保持原样（含注释） */
function write(workDir, patch = {}) {
  const p = propsPath(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    text = '';
  }
  const parsed = text ? parse(text) : { entries: [], map: {} };

  // 校验
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    const err = validate(k, v);
    if (err) errors.push(err);
  }
  if (errors.length) {
    const e = new Error(errors.join('；'));
    e.code = 'E_PROPS_INVALID';
    throw e;
  }

  // 合并：已有值 + 本次改动
  const nextMap = Object.assign({}, parsed.map);
  for (const [k, v] of Object.entries(patch)) nextMap[k] = toRaw(k, v);

  const outText = serialize(parsed.entries, nextMap);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, outText, 'utf8');
  fs.renameSync(tmp, p);
  return read(workDir);
}

/**
 * 确保文件存在并补齐已知字段（首次开服前调用）。
 * ★ 服务端第一次启动自己会生成 server.properties，但那时玩家还没配过；
 *   我们在启动前先写一份，玩家就能在界面上先配好再开服。
 */
function ensure(workDir, initial = {}) {
  const p = propsPath(workDir);
  if (fs.existsSync(p)) return read(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const map = {};
  for (const f of FIELDS) map[f.key] = toRaw(f.key, Object.prototype.hasOwnProperty.call(initial, f.key) ? initial[f.key] : f.def);
  fs.writeFileSync(p, serialize([], map), 'utf8');
  return read(workDir);
}

/* ============================================================
 * 预设（一键套用，安卓那边没有）
 * ============================================================ */

const PRESETS = [
  {
    id: 'friends',
    label: '好友联机（宽松）',
    desc: '关闭正版验证、开白名单、难度普通、允许飞行',
    values: {
      'online-mode': false,
      'white-list': true,
      'enforce-secure-profile': false,
      difficulty: 'normal',
      'allow-flight': true,
      'max-players': 10,
      pvp: true,
      'spawn-protection': 0,
    },
  },
  {
    id: 'public',
    label: '公开服（严格）',
    desc: '开正版验证、开白名单、阻止代理、记录 IP',
    values: {
      'online-mode': true,
      'white-list': true,
      'enforce-secure-profile': true,
      'prevent-proxy-connections': true,
      'log-ips': true,
      'spawn-protection': 16,
      'max-players': 50,
    },
  },
  {
    id: 'creative',
    label: '创造建筑服',
    desc: '创造模式、允许飞行、关闭怪物、关闭出生点保护',
    values: {
      gamemode: 'creative',
      'force-gamemode': true,
      'allow-flight': true,
      'spawn-monsters': false,
      difficulty: 'peaceful',
      'spawn-protection': 0,
      'max-players': 20,
    },
  },
  {
    id: 'hardcore',
    label: '硬核生存',
    desc: '硬核模式、困难难度、开启 PVP',
    values: {
      gamemode: 'survival',
      difficulty: 'hard',
      hardcore: true,
      pvp: true,
      'spawn-monsters': true,
    },
  },
  {
    id: 'lowend',
    label: '低配省性能',
    desc: '视距/模拟距离调到 4，关同步写区块',
    values: {
      'view-distance': 4,
      'simulation-distance': 4,
      'sync-chunk-writes': false,
      'max-players': 10,
      'network-compression-threshold': 128,
    },
  },
];

module.exports = {
  FIELDS,
  FIELD_MAP,
  GROUPS,
  PRESETS,
  parse,
  serialize,
  coerce,
  toRaw,
  validate,
  escapeValue,
  unescapeValue,
  propsPath,
  read,
  write,
  ensure,
};
