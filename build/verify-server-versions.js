'use strict';
/**
 * 服务端「版本覆盖 + 来源」验收
 *
 * ★ 这份脚本是为了回答用户的一个直接质问：
 *   「26.3 测了没？远古版贝塔 1.7.3 / 贝塔 1.9 呢？快照版呢？正式版丢的服务端呢？」
 *
 * 覆盖三层来源：
 *   ① Mojang 官方（还在清单里的）
 *   ② Betacraft server-archive（Mojang 已下架的：Classic/Alpha/Beta/1.0.0/愚人节 2.0/周快照）
 *   ③ 内置远古服务端（Infdev / Beta 1.7.3 插件版 —— 前两者都没有的）
 *
 * 用法：node build/verify-server-versions.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
/**
 * ★ 用真实主目录：versionJson 依赖 meta/version_manifest_v2.json 才能定位下载地址。
 *   临时空目录里没有清单缓存 → 所有现代版本都会报「清单里找不到下载地址」，
 *   那是测试环境问题，不是产品缺陷（踩过一次）。
 */
const HOME = path.join(os.homedir(), 'Documents', 'QCL');

const checks = [];
const P = (name, pass, info) => checks.push({ name, pass, info });
const section = (t) => console.log(`\n===== ${t} =====`);

(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  const srv = require(path.join(ROOT, 'src', 'main', 'core', 'server.js'));
  const sa = require(path.join(ROOT, 'src', 'main', 'core', 'serverarchive.js'));
  const an = require(path.join(ROOT, 'src', 'main', 'core', 'ancientServer.js'));

  /* ---------------- ① 现代版本（Mojang） ---------------- */
  section('① 现代版本 · Mojang 官方');
  const modernCases = [
    ['26.3', '最新正式版'],
    ['26.4-snapshot-10', '最新快照'],
    ['1.21.11', '1.21 末版'],
    ['1.20.1', '最常用'],
    ['1.16.5', '老牌模组版'],
  ];
  for (const [v, note] of modernCases) {
    try {
      const r = await srv.resolveServerJar('vanilla', v, { home: HOME });
      P(`${v}（${note}）能拿到服务端`, !!r.url && !r.fromArchive, {
        from: r.fromArchive ? '归档' : 'Mojang',
        size: r.size ? Math.round(r.size / 1024 / 1024) + 'MB' : '—',
      });
    } catch (e) {
      P(`${v}（${note}）能拿到服务端`, false, e.message.slice(0, 80));
    }
  }

  /* ---------------- ② 老正式版 ---------------- */
  section('② 老正式版 · Mojang 官方（1.2.5 及以后官方仍在）');
  for (const v of ['1.12.2', '1.8.9', '1.7.10', '1.6.4', '1.2.5']) {
    try {
      const r = await srv.resolveServerJar('vanilla', v, { home: HOME });
      P(`${v} 能拿到服务端`, !!r.url, r.fromArchive ? '归档' : 'Mojang');
    } catch (e) {
      P(`${v} 能拿到服务端`, false, e.message.slice(0, 80));
    }
  }

  /* ---------------- ③ 官方已下架的正式版 ---------------- */
  section('③ 官方已下架的正式版 · Betacraft 归档');
  for (const v of ['1.0.0', '1.0.1', '1.1', '1.2']) {
    try {
      const r = await srv.resolveServerJar('vanilla', v, { home: HOME });
      P(`${v}（官方已下架）能从归档拿到`, !!r.url, r.fromArchive ? 'Betacraft 归档' : 'Mojang');
    } catch (e) {
      P(`${v}（官方已下架）能从归档拿到`, false, e.message.slice(0, 80));
    }
  }

  /* ---------------- ④ 快照 ---------------- */
  section('④ 快照 · 含官方已下架的周快照');
  for (const v of ['13w16a', '14w08a', '11w47a']) {
    try {
      const r = await srv.resolveServerJar('vanilla', v, { home: HOME });
      P(`快照 ${v} 能拿到服务端`, !!r.url, r.fromArchive ? '归档' : 'Mojang');
    } catch (e) {
      P(`快照 ${v} 能拿到服务端`, false, e.message.slice(0, 80));
    }
  }

  /* ---------------- ⑤ Beta / Alpha / Classic ---------------- */
  section('⑤ 远古版 · Beta / Alpha / Classic（归档）');
  const ancientCases = ['b1.7.3', 'b1.9-pre1', 'b1.9-pre6', 'b1.8.1', 'b1.7.2', 'a0.2.8', 'c1.4'];
  for (const v of ancientCases) {
    try {
      const r = await srv.resolveServerJar('vanilla', v, { home: HOME });
      P(`${v} 能拿到服务端`, !!r.url, r.fromArchive ? '归档' : 'Mojang');
    } catch (e) {
      P(`${v} 能拿到服务端`, false, e.message.slice(0, 80));
    }
  }

  /* ---------------- ⑥ 愚人节版 ---------------- */
  section('⑥ 愚人节版');
  for (const v of ['2.0_red', '2.0_blue', '2.0_purple']) {
    try {
      const r = await srv.resolveServerJar('vanilla', v, { home: HOME });
      P(`${v} 能拿到服务端`, !!r.url, r.fromArchive ? '归档' : 'Mojang');
    } catch (e) {
      P(`${v} 能拿到服务端`, false, e.message.slice(0, 80));
    }
  }

  /* ---------------- ⑦ 内置社区服务端 ---------------- */
  section('⑦ 内置社区服务端（Mojang 与归档都没有的）');
  {
    const list = an.list();
    P('内置服务端目录可访问', !!an.builtinDir(), an.builtinDir());
    P('内置条目 2 个', list.length === 2, list.map((b) => b.id));
    const infdev = list.find((b) => b.id === 'infdev-ultimate');
    const beta = list.find((b) => b.id === 'beta-173-pemod');
    P('Infdev 服务端文件存在', !!infdev && infdev.exists, infdev && Math.round(infdev.size / 1024) + 'KB');
    P('Beta 1.7.3 插件版文件存在', !!beta && beta.exists, beta && Math.round(beta.size / 1024) + 'KB');
    P('Infdev 覆盖 20+ 个版本', infdev && infdev.covers.length >= 20, infdev && infdev.covers.length);

    // Infdev 走内置
    try {
      const r = await srv.resolveServerJar('vanilla', 'inf-20100630', { home: HOME });
      P('Infdev 版本走内置服务端', !!r.builtin, r.builtin ? r.builtinInfo.label : '未走内置');
    } catch (e) {
      P('Infdev 版本走内置服务端', false, e.message.slice(0, 80));
    }

    // b1.7.3 默认用归档原版
    const normal = await srv.resolveServerJar('vanilla', 'b1.7.3', { home: HOME }).catch(() => null);
    P('b1.7.3 默认用归档原版服务端', !!normal && normal.fromArchive === true, normal && (normal.fromArchive ? '归档' : '其他'));

    // b1.7.3 点名要插件版
    const plugin = await srv.resolveServerJar('vanilla', 'b1.7.3', { home: HOME, preferBuiltin: true }).catch(() => null);
    P('b1.7.3 可选内置插件版', !!plugin && plugin.builtin === true, plugin && plugin.builtinInfo && plugin.builtinInfo.label);
  }

  /* ---------------- ⑧ 归档分类 ---------------- */
  section('⑧ 归档分类（正式版 / 快照 / 愚人节版 / 远古版）');
  {
    const cls = await sa.listByCategory({ home: HOME });
    P('归档清单读取成功', cls.ok === true, cls.error || '');
    P('归档总量 ≥ 200', cls.total >= 200, cls.total);
    const ids = cls.groups.map((g) => g.id);
    const want = ['release', 'snapshot', 'aprilfools', 'ancient'];
    P('四个分类齐全', want.every((w) => ids.includes(w)), ids);
    for (const g of cls.groups) {
      P(`分类「${g.label}」有内容`, g.count > 0, g.count);
    }
    // 关键：快照类里要有周快照
    const snap = cls.groups.find((g) => g.id === 'snapshot');
    P('快照类含周快照（如 13w16a）', !!snap && snap.items.some((i) => /^\d{2}w\d{2}/.test(i.version)), snap && snap.items.slice(0, 5).map((i) => i.version));
    // 远古类要有 beta/alpha/classic
    const anc = cls.groups.find((g) => g.id === 'ancient');
    const ancVers = anc ? anc.items.map((i) => i.version.toLowerCase()) : [];
    P('远古类含 Beta', ancVers.some((v) => v.startsWith('b')), ancVers.filter((v) => v.startsWith('b')).slice(0, 3));
    P('远古类含 Alpha', ancVers.some((v) => v.startsWith('a')), ancVers.filter((v) => v.startsWith('a')).slice(0, 3));
    P('远古类含 Classic', ancVers.some((v) => v.startsWith('c')), ancVers.filter((v) => v.startsWith('c')).slice(0, 3));
    // 愚人节
    const apr = cls.groups.find((g) => g.id === 'aprilfools');
    P('愚人节类含 2.0 三色', !!apr && apr.items.some((i) => /2\.0/.test(i.version)), apr && apr.items.map((i) => i.version));
  }

  /* ---------------- ⑨ 其他核心 ---------------- */
  section('⑨ Paper / Purpur / Fabric');
  {
    for (const v of ['26.3', '1.20.1', '1.7.10']) {
      try {
        const r = await srv.resolveServerJar('paper', v, {});
        P(`Paper ${v} 能拿到`, !!r.url && r.build > 0, `build ${r.build} / ${r.channel}`);
      } catch (e) {
        P(`Paper ${v} 能拿到`, false, e.message.slice(0, 70));
      }
    }
    for (const v of ['26.3', '1.20.1']) {
      try {
        const r = await srv.resolveServerJar('purpur', v, {});
        P(`Purpur ${v} 能拿到`, !!r.url, `build ${r.build}`);
      } catch (e) {
        P(`Purpur ${v} 能拿到`, false, e.message.slice(0, 70));
      }
    }
    try {
      const r = await srv.resolveServerJar('fabric', '26.3', {});
      P('Fabric 26.3 能拿到', !!r.url, `loader ${r.loaderVersion}`);
    } catch (e) {
      P('Fabric 26.3 能拿到', false, e.message.slice(0, 70));
    }
  }

  /* ---------------- ⑩ 已知缺口（诚实报告） ---------------- */
  section('⑩ 已知缺口（客观事实，不是能力缺失）');
  {
    const gaps = [];
    try {
      await srv.resolveServerJar('vanilla', 'a1.2.6', { home: HOME });
    } catch {
      gaps.push('a1.2.6（Alpha 后期）—— Betacraft 归档只到 a0.2.8，Mojang 已下架');
    }
    P('能正确报告 a1.2.6 存缺口', gaps.length === 1, gaps[0] || '意外拿到了');

    // 报错信息必须有指导意义
    let msg = '';
    try {
      await srv.resolveServerJar('vanilla', 'a1.2.6', { home: HOME });
    } catch (e) {
      msg = e.message;
    }
    P('缺口报错含可用建议', /Purpur|Paper|Betacraft|归档/.test(msg), msg.split('\n')[0].slice(0, 60));
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined && c.info !== '' ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);

  /**
   * ★★★ 绝对不要在这里删 HOME —— 它现在是用户真实的 <用户>/Documents/QCL。
   *   这条脚本只用它的 meta 缓存读 version json，本身不写任何东西。
   *   （曾经这里有一句 fs.rmSync(HOME)，换成真实目录后就是删玩家存档，已移除。）
   */
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.log('\nFATAL ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
