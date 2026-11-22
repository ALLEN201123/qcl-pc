'use strict';
/**
 * 1.0.8 验收：端口自动递增 + 插件/模组管理 + 路径可见
 *
 * 对应用户提的四件事：
 *   ① 建第二个服务端，端口会不会从 25565 变成 25566？
 *   ② 玩家能否查看服务端部署在哪个文件？
 *   ③ 玩家能否修改服务端配置（端口、人数）？
 *   ④ 插件服要「下载插件」按钮、模组服要「下载模组」按钮，已装的也要能看
 *
 * 用法：node build/verify-server-108.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.tmpdir(), `_qcl_108_${Date.now()}`);

const checks = [];
const P = (n, p, i) => checks.push({ n, p, i });
const section = (t) => console.log(`\n===== ${t} =====`);

(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  for (const d of ['logs', 'meta', 'instances', 'servers']) fs.mkdirSync(path.join(HOME, d), { recursive: true });

  const srv = require(path.join(ROOT, 'src', 'main', 'core', 'server.js'));
  const props = require(path.join(ROOT, 'src', 'main', 'core', 'serverprops.js'));
  const sc = require(path.join(ROOT, 'src', 'main', 'core', 'servercontent.js'));

  /* ---------------- ① 端口自动递增 ---------------- */
  section('① 建多个服务端，端口自动递增');
  {
    const a = await srv.createAuto(HOME, { name: '第一个', kind: 'paper', mcVersion: '1.20.1' });
    P('第 1 个服务端拿到 25565', Number(a.port) === 25565, a.port);

    const b = await srv.createAuto(HOME, { name: '第二个', kind: 'paper', mcVersion: '1.20.1' });
    P('★ 第 2 个自动变 25566', Number(b.port) === 25566, b.port);

    const c = await srv.createAuto(HOME, { name: '第三个', kind: 'fabric', mcVersion: '1.20.1' });
    P('★ 第 3 个自动变 25567', Number(c.port) === 25567, c.port);

    const d = await srv.createAuto(HOME, { name: '指定端口', kind: 'paper', mcVersion: '1.20.1', port: 30000 });
    P('玩家显式指定端口时原样使用', Number(d.port) === 30000, d.port);

    // 端口不重复
    const all = srv.list(HOME).map((s) => Number(s.port));
    const uniq = new Set(all);
    P('所有服务端端口互不重复', all.length === uniq.size, all);

    // 写进 server.properties（★ 只有 IPC 的 server:create 通道会同步写入；
    //   这里直接调 createAuto，所以手动 ensure 一次再验）
    props.ensure(srv.workDir(HOME, b.id), { 'server-port': String(b.port) });
    const props1 = props.read(srv.workDir(HOME, b.id));
    P(
      '端口能写进 server.properties',
      String(props1.values['server-port']) === String(b.port),
      props1.values['server-port']
    );
  }

  /* ---------------- ② 路径可见 ---------------- */
  section('② 部署位置可见');
  {
    const first = srv.list(HOME)[0];
    const work = srv.workDir(HOME, first.id);
    const dir = srv.serverDir(HOME, first.id);
    const root = srv.serversRoot(HOME);
    P('serversRoot 可用', typeof root === 'string' && root.length > 0, path.basename(root));
    P('workDir 存在', fs.existsSync(work), path.basename(work));
    P('serverDir 存在', fs.existsSync(dir), path.basename(dir));
    P('备份目录存在', fs.existsSync(srv.backupsDir(HOME, first.id)));
    P('日志目录存在', fs.existsSync(srv.logsDir(HOME, first.id)));

    // IPC 通道
    const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
    P('有 server:paths 通道', ipc.includes("'server:paths'"));
    const page = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js'), 'utf8');
    P('界面有「部署位置」区块', /srv-path/.test(page) && /部署位置/.test(page));
    P('界面有复制路径按钮', /srv-path-copy/.test(page));
  }

  /* ---------------- ③ 配置可改 ---------------- */
  section('③ 配置可改（端口 / 人数等）');
  {
    const first = srv.list(HOME)[0];
    const work = srv.workDir(HOME, first.id);
    props.ensure(work, { 'server-port': String(first.port) });

    // 改端口 + 人数 + motd
    const before = props.read(work);
    P('46 项配置可读', Object.keys(before.values).length >= 40, Object.keys(before.values).length);

    props.write(work, { 'server-port': '25888', 'max-players': '30', motd: '改过的标语' });
    const after = props.read(work);
    P('★ 能改端口', String(after.values['server-port']) === '25888', after.values['server-port']);
    P('★ 能改人数', String(after.values['max-players']) === '30', after.values['max-players']);
    P('能改标语', String(after.values.motd) === '改过的标语', after.values.motd);

    // 校验：非法值要被拦（★ validate 是 (key, value) 双参数，不是对象）
    P('非法人数被拦（99999 超 1000 上限）', !!props.validate('max-players', 99999), props.validate('max-players', 99999));
    P('非法端口被拦（70000 超 65535）', !!props.validate('server-port', 70000), props.validate('server-port', 70000));
    P('合法值通过校验', props.validate('max-players', 30) === null, props.validate('max-players', 30));

    // 界面有保存按钮
    const page = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js'), 'utf8');
    P('界面有「保存配置」按钮', /srv-props-save/.test(page));
  }

  /* ---------------- ④ 插件 / 模组 ---------------- */
  section('④ 插件 / 模组管理');
  {
    // 核心 → 内容类型
    P('Paper → 插件', sc.contentTypeFor('paper') === 'plugin');
    P('Purpur → 插件', sc.contentTypeFor('purpur') === 'plugin');
    P('Fabric → 模组', sc.contentTypeFor('fabric') === 'mod');
    P('Forge → 模组', sc.contentTypeFor('forge') === 'mod');
    P('NeoForge → 模组', sc.contentTypeFor('neoforge') === 'mod');
    P('原版 → 不支持', sc.contentTypeFor('vanilla') === 'none');
    P('插件目录名是 plugins', sc.targetDirName('plugin') === 'plugins');
    P('模组目录名是 mods', sc.targetDirName('mod') === 'mods');

    // 原版要被明确拒绝
    let rejected = false;
    try {
      await sc.search({ kind: 'vanilla', mcVersion: '1.20.1', query: 'x' });
    } catch (e) {
      rejected = /原版/.test(e.message);
    }
    P('原版搜索被明确拒绝并给建议', rejected === true);

    // 真搜插件
    try {
      const r = await sc.search({ kind: 'paper', mcVersion: '1.20.1', query: 'essentials', limit: 5 });
      P('★ 插件能搜到（CurseForge）', r.total > 0 && r.items.length > 0, { total: r.total, 首个: r.items[0] && r.items[0].title });
      P('插件源标为 curseforge', r.source === 'curseforge', r.source);
    } catch (e) {
      P('★ 插件能搜到（CurseForge）', false, e.message.slice(0, 80));
    }

    // 真搜模组
    try {
      const r = await sc.search({ kind: 'fabric', mcVersion: '1.20.1', query: 'lithium', limit: 5 });
      P('★ 模组能搜到（Modrinth）', r.total > 0 && r.items.length > 0, { total: r.total, 首个: r.items[0] && r.items[0].title });
      P('模组源标为 modrinth', r.source === 'modrinth', r.source);
      P('模组结果带 slug（可用于安装）', !!(r.items[0] && r.items[0].slug), r.items[0] && r.items[0].slug);
    } catch (e) {
      P('★ 模组能搜到（Modrinth）', false, e.message.slice(0, 80));
    }

    // 已安装列表 + 目录
    const paperServer = srv.list(HOME).find((s) => s.kind === 'paper');
    const work = srv.workDir(HOME, paperServer.id);
    const dir = sc.ensureDir(work, 'plugin');
    P('插件目录会被自动创建', fs.existsSync(dir), path.basename(dir));

    // 造两个假插件文件，测列表 / 禁用 / 删除
    fs.writeFileSync(path.join(dir, 'EssentialsX-2.20.jar'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(dir, 'WorldEdit-7.2.jar'), Buffer.alloc(2048));
    const ins = sc.installed(work, 'plugin');
    P('已安装列表能读出 2 个', ins.items.length === 2, ins.items.map((i) => i.name));

    const tg = sc.toggle(work, 'plugin', 'EssentialsX-2.20.jar', true);
    const ins2 = sc.installed(work, 'plugin');
    /**
     * ★ 这里曾是真 bug：installed() 的正则只匹配 `.jar$`，
     *   禁用后文件变成 `xxx.jar.disabled` 就**从列表里消失了**，
     *   玩家没法再启用回来。现在必须仍然列出、且 disabled=true。
     */
    const target = ins2.items.find((i) => i.name === tg.name);
    P('★ 禁用后仍能在列表里看到', !!target, ins2.items.map((i) => i.name));
    P('★ 禁用状态被正确标记', !!target && target.disabled === true, target && target.disabled);
    P('禁用后条目数不变（2 个）', ins2.items.length === 2, ins2.items.length);

    const tg2 = sc.toggle(work, 'plugin', tg.name, false);
    const ins3 = sc.installed(work, 'plugin');
    P('能重新启用', ins3.items.some((i) => i.name === tg2.name && !i.disabled), tg2.name);

    sc.remove(work, 'plugin', 'WorldEdit-7.2.jar');
    const ins4 = sc.installed(work, 'plugin');
    P('能删除插件', ins4.items.length === 1, ins4.items.map((i) => i.name));

    /**
     * 目录穿越防护：
     * ★ remove() 里先 `path.basename()`，所以 `../../../evil.jar` 会被削成 `evil.jar`，
     *   只会在这个目录里找（不存在 → removed:false），出不去。
     *   这里验证的是「削完之后仍然落在 plugins/ 内」，而不是抛异常。
     */
    const outside = path.join(work, 'evil-outside.jar');
    fs.writeFileSync(outside, 'should-not-be-deleted');
    const rTrav = sc.remove(work, 'plugin', '../../../evil-outside.jar');
    P('目录穿越被挡住（外部文件未被删）', fs.existsSync(outside) === true && rTrav.removed === false, rTrav);

    // UI 与通道
    const page = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'server.js'), 'utf8');
    const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
    P('界面有「插件 / 模组」标签页', /data-tab="content"/.test(page));
    P('★ 界面有搜索框与搜索按钮', /cnt-q/.test(page) && /cnt-search/.test(page));
    P('★ 界面有安装按钮', /data-cnt-install/.test(page));
    P('界面有启用/禁用按钮', /data-cnt-toggle/.test(page));
    P('界面有删除按钮', /data-cnt-remove/.test(page));
    P('界面按核心类型给对文案', /插件管理|模组管理|label = isPlugin/.test(page));
    for (const ch of [
      'server:content:info',
      'server:content:installed',
      'server:content:search',
      'server:content:versions',
      'server:content:install',
      'server:content:toggle',
      'server:content:remove',
      'server:content:openDir',
    ]) {
      P(`IPC 有 ${ch}`, ipc.includes(`'${ch}'`));
    }
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.p) fail += 1;
    console.log(`${c.p ? 'PASS' : 'FAIL'}  ${c.n}${c.i !== undefined && c.i !== '' ? '  → ' + JSON.stringify(c.i) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);

  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.log('\nFATAL ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
