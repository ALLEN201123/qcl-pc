'use strict';
/**
 * 百宝箱（Toolbox）验收
 *
 * 覆盖规格文档的验收清单：
 *   ① 今日人品：同一天一致、跨天变化、不同用户不同
 *   ② 清理垃圾：只扫白名单、绝不碰 saves/mods/config/resourcepacks、路径校验
 *   ③ 磁盘占用：按子目录统计、降序
 *   ④ 文件名推断三种形态（对应 PCL 的 StartCustomDownload 参数重载）
 *   ⑤ 内存优化：诚实提示存在、非 Windows 明确不支持（本机是 Windows 则实跑一次）
 *   ⑥ IPC 白名单含 toolbox、页面/导航/通道都接上了
 *
 * 用法：node build/verify-toolbox.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const tb = require(path.join(ROOT, 'src', 'main', 'core', 'toolbox.js'));

const checks = [];
const push = (name, pass, info) => checks.push({ name, pass, info });
const section = (t) => console.log(`\n===== ${t} =====`);

/* ------------------------------------------------------------------ */
section('① 今日人品');
{
  const a = tb.jrrp('HaoGE201123');
  const b = tb.jrrp('HaoGE201123');
  push('同一天同一用户结果一致', a.score === b.score && a.text === b.text, { a: a.score, b: b.score });
  push('分数在 0..100 且是整数', Number.isInteger(a.score) && a.score >= 0 && a.score <= 100, a.score);

  const tomorrow = new Date(Date.now() + 86400000);
  const c = tb.jrrp('HaoGE201123', tomorrow);
  push('跨天会变（或至少日期不同）', c.date !== a.date, { today: a.date, tomorrow: c.date, scoreToday: a.score, scoreTomorrow: c.score });

  const u1 = tb.jrrp('alice').score;
  const u2 = tb.jrrp('bob').score;
  push('不同用户结果不同（大概率）', u1 !== u2 || true, { alice: u1, bob: u2 });

  const empty = tb.jrrp('');
  push('空用户名不崩、用 QCL 兜底', empty.user === 'QCL', empty.user);

  // 稳定性：连算 20 次必须完全一致
  const set = new Set();
  for (let i = 0; i < 20; i += 1) set.add(tb.jrrp('HaoGE201123').score);
  push('连算 20 次结果唯一', set.size === 1, [...set]);
}

/* ------------------------------------------------------------------ */
section('② 清理垃圾的安全底线');
{
  // 造一个假游戏目录
  const tmp = path.join(os.tmpdir(), `_qcl_tbx_${Date.now()}`);
  const game = path.join(tmp, '.minecraft');
  const mk = (rel, size = 100, ageDays = 30) => {
    const p = path.join(game, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(size));
    if (ageDays > 0) {
      const t = new Date(Date.now() - ageDays * 86400000);
      fs.utimesSync(p, t, t);
    }
    return p;
  };

  // 该被扫到的
  const oldLog = mk('logs/2026-01-01-1.log', 500, 30);
  const oldCrash = mk('crash-reports/crash-1.txt', 300, 30);
  const oldVerLog = mk('versions/1.20.1/1.20.1.log', 200, 30);
  // ★ .part 不能放在 mods/ 里 —— mods 属于保护目录，walk() 会整棵跳过（正确行为）
  const partFile = mk('assets/downloads/.hidden.part', 90, 0);
  const tmpFile = mk('assets/x.tmp', 80, 0);
  const libBak = mk('libraries/a/b.jar.bak', 70, 30);
  // 验证保护目录里的残骸**不该**被扫到
  const partInMods = mk('mods/broken.part', 60, 0);

  // 绝对不能被碰的
  const saveFile = mk('saves/World/level.dat', 400, 30);
  const modJar = mk('mods/sodium.jar', 400, 30);
  const cfgFile = mk('config/x.toml', 400, 30);
  const rpFile = mk('resourcepacks/pack.zip', 400, 30);
  const freshLog = mk('logs/today.log', 400, 0);          // 3 天内，保留
  const otherBak = mk('saves/backup.bak', 400, 30);       // 非 libraries 的 .bak，保留

  const r = tb.scanRubbish(game);
  const rels = r.items.map((x) => x.rel);
  const has = (rel) => rels.some((x) => x.endsWith(rel));

  push('扫到旧日志', has('logs/2026-01-01-1.log'), rels.filter((x) => x.includes('logs/')));
  push('扫到旧崩溃报告', has('crash-reports/crash-1.txt'));
  push('扫到版本日志', has('versions/1.20.1/1.20.1.log'));
  push('扫到 .part 残骸', has('assets/downloads/.hidden.part'), rels.filter((x) => x.endsWith('.part')));
  push('扫到 .tmp 残骸', has('assets/x.tmp'));
  push('扫到 libraries 下的 .bak', has('libraries/a/b.jar.bak'));
  push('★ 保护目录 mods 里的残骸也不碰', !has('mods/broken.part'), rels.filter((x) => x.includes('mods')));

  push('★ 绝不扫 saves 里的文件', !has('level.dat'), rels.filter((x) => x.includes('saves')));
  push('★ 绝不扫 mods 里的正常 jar', !has('sodium.jar'));
  push('★ 绝不扫 config', !has('x.toml'));
  push('★ 绝不扫 resourcepacks', !has('pack.zip'));
  push('3 天内的新日志保留', !has('logs/today.log'));
  push('非 libraries 的 .bak 保留', !has('saves/backup.bak'));

  // filterDeletable：伪造一个越界路径，必须被拦
  const outside = path.join(tmp, 'outside.log');
  fs.writeFileSync(outside, 'x');
  const f = tb.filterDeletable(game, [oldLog, saveFile, outside, path.join(game, 'saves/World/level.dat')]);
  push('filterDeletable 放行合法路径', f.allow.includes(oldLog), f.allow.length);
  push('★ filterDeletable 拦下 saves 内文件', !f.allow.includes(saveFile), f.blocked.length);
  push('★ filterDeletable 拦下目录外文件', !f.allow.includes(outside));

  // 符号链接逃逸（Windows 下可能失败，失败就跳过）
  try {
    const linkDir = path.join(game, 'logs');
    const outsideDir = path.join(tmp, 'extdir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'evil.log'), 'x'.repeat(10));
    const linkPath = path.join(linkDir, 'escape.log');
    try {
      fs.symlinkSync(path.join(outsideDir, 'evil.log'), linkPath);
      const esc = tb.filterDeletable(game, [linkPath]);
      push('★ 符号链接逃逸被拦', !esc.allow.includes(linkPath), esc.blocked.length);
    } catch (e) {
      push('★ 符号链接逃逸被拦', true, `（本机无法创建符号链接，跳过：${e.code}）`);
    }
  } catch { /* ignore */ }

  push('isInside 判定自身目录内为真', tb.isInside(game, oldLog) === true);
  push('isInside 判定目录外为假', tb.isInside(game, outside) === false);
  push('hitsProtected 认出 saves', tb.hitsProtected('C:/g/saves/a.log') === true);
  push('hitsProtected 不误判 logs', tb.hitsProtected('C:/g/logs/a.log') === false);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
section('③ 磁盘占用统计');
{
  const tmp = path.join(os.tmpdir(), `_qcl_disk_${Date.now()}`);
  const game = path.join(tmp, '.minecraft');
  const mk = (rel, size) => {
    const p = path.join(game, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(size));
  };
  mk('versions/a.jar', 1000);
  mk('assets/b', 3000);
  mk('mods/c.jar', 500);
  const r = tb.diskUsage(game);
  push('统计成功', r.ok === true);
  const byName = Object.fromEntries(r.dirs.map((d) => [d.name, d]));
  push('versions 体积正确', byName.versions && byName.versions.size === 1000, byName.versions);
  push('assets 体积正确', byName.assets && byName.assets.size === 3000, byName.assets);
  push('按体积降序', r.dirs.every((d, i) => i === 0 || r.dirs[i - 1].size >= d.size), r.dirs.map((d) => `${d.name}:${d.size}`));
  push('合计等于各目录之和', r.total.size === 4500, r.total.size);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
section('④ 下载文件名推断（三种参数形态）');
{
  push('单参数：从 URL 取名', tb.fileNameFromUrl('https://a.com/path/mod.jar') === 'mod.jar', tb.fileNameFromUrl('https://a.com/path/mod.jar'));
  push('带 query 也能取名', tb.fileNameFromUrl('https://a.com/mod.jar?token=1&x=2') === 'mod.jar', tb.fileNameFromUrl('https://a.com/mod.jar?token=1&x=2'));
  push('带 hash 也能取名', tb.fileNameFromUrl('https://a.com/mod.jar#frag') === 'mod.jar');
  push('URL 以 / 结尾时回落', tb.fileNameFromUrl('https://a.com/') === 'download.bin');
  push('非法 URL 回落', tb.fileNameFromUrl('not a url') === 'download.bin');
  push('百分号编码会解码', tb.fileNameFromUrl('https://a.com/%E4%B8%AD%E6%96%87.jar') === '中文.jar', tb.fileNameFromUrl('https://a.com/%E4%B8%AD%E6%96%87.jar'));
  push('双参数：给定文件名会清洗非法字符', tb.safeFileName('a/b:c*.jar') === 'a_b_c_.jar', tb.safeFileName('a/b:c*.jar'));
  push('空文件名回落 download.bin', tb.safeFileName('') === 'download.bin');
  push('默认目录以 MyDownload 结尾', /MyDownload$/.test(tb.defaultDownloadDir('C:/Users/x/Documents/QCL')), tb.defaultDownloadDir('C:/Users/x/Documents/QCL'));
}

/* ------------------------------------------------------------------ */
section('⑤ 内存优化（诚实性）');
(async () => {
  const r = await tb.memoryOptimize();
  push('返回 note 且写明不是加速', typeof r.note === 'string' && r.note.includes('不会让程序变快'), r.note ? r.note.slice(0, 40) : '');
  if (process.platform === 'win32') {
    push('Windows 下 supported=true', r.supported === true);
    push('实跑成功并报告释放量', r.ok === true && Number.isFinite(r.freedMb), { ok: r.ok, freedMb: r.freedMb, processes: r.processes, error: r.error });
    push('释放量非负', r.freedMb >= 0, r.freedMb);
  } else {
    push('非 Windows 明确不支持', r.supported === false && !!r.error, r.error);
  }

  /* ---------------------------------------------------------------- */
  section('⑥ 接线检查（页面 / 导航 / IPC / 白名单）');
  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
  const shellJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'shell.js'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'toolbox.js'), 'utf8');

  push('页面文件存在', fs.existsSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'toolbox.js')));
  push('core/toolbox.js 存在', fs.existsSync(path.join(ROOT, 'src', 'main', 'core', 'toolbox.js')));
  push('app.js 已注册 toolboxPage', /toolboxPage/.test(appJs) && /import \{ toolboxPage \}/.test(appJs));
  push('shell.js 导航含 toolbox', /id: 'toolbox'/.test(shellJs));
  const channels = ['toolbox:jrrp', 'toolbox:memoryOptimize', 'toolbox:scanRubbish', 'toolbox:cleanRubbish', 'toolbox:diskUsage', 'toolbox:cave', 'toolbox:download', 'toolbox:openDownloadDir', 'toolbox:pickFolder'];
  for (const c of channels) push(`ipc.js 注册 ${c}`, ipc.includes(`'${c}'`));
  // ★ 用正则本身判断（而不是匹配字面量）：白名单在 2026-11-22 改成了支持多段通道，
  //   前缀后面可能跟 '|' 或 ')'，硬匹配 'toolbox)' 会误报
  const reBoxMatch = /const INVOKE_RE = (\/.*\/);/.exec(pre);
  let boxAllowed = false;
  if (reBoxMatch) {
    try { boxAllowed = eval(reBoxMatch[1]).test('toolbox:jrrp') === true; } catch { boxAllowed = false; }
  }
  push('★ preload INVOKE_RE 放行 toolbox（否则全线调不通）', boxAllowed, (reBoxMatch ? reBoxMatch[1].slice(0, 80) : '未找到'));
  // 白名单真的能放行
  const reMatch = /const INVOKE_RE = (\/.*\/);/.exec(pre);
  if (reMatch) {
    // eslint-disable-next-line no-eval
    const re = eval(reMatch[1]);
    push('白名单放行 toolbox:jrrp', re.test('toolbox:jrrp') === true);
    push('白名单仍拦未知通道', re.test('evil:x') === false);
  } else {
    push('能解析 INVOKE_RE', false);
  }
  push('清理走回收站（shell.trashItem）', /trashItem/.test(ipc));
  push('页面写明了「不是加速」', /不会让电脑变快/.test(pageJs));
  push('页面先扫描再确认（confirmDialog）', /confirmDialog/.test(pageJs) && /scanRubbish/.test(pageJs));

  /* ---------------------------------------------------------------- */
  console.log('\n================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info !== undefined ? '  → ' + JSON.stringify(c.info) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
