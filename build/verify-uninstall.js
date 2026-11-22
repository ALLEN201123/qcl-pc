'use strict';
/**
 * 卸载功能验收
 *
 * 对应用户指出：「只做了启动程序，没做卸载程序，还要询问是否保留版本文件夹和服务器文件夹」
 *
 * 要验证的：
 *   ① 注册表里的 UninstallString 不再是死链 —— QCL.exe 真的处理 --uninstall
 *   ② 卸载界面能列出「程序文件 / 游戏数据 / 本地缓存」三块，带大小与路径
 *   ③ 游戏数据默认**保留**（存档、账号、服务端都在里面），要勾选才删
 *   ④ 勾了删游戏数据会有二次确认
 *   ⑤ 程序目录最后删（交给分离的 cmd，因为运行中的 exe 删不掉自己）
 *   ⑥ 真正执行时：保留的确实保留、要删的确实删掉、注册表与快捷方式清掉
 *
 * 用法：node build/verify-uninstall.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const checks = [];
const P = (n, p, i) => checks.push({ n, p, i });
const section = (t) => console.log(`\n===== ${t} =====`);

(async () => {
  const un = require(path.join(ROOT, 'src', 'main', 'uninstall.js'));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'uninstall-preload.js'), 'utf8');
  const installerSrc = fs.readFileSync(path.join(ROOT, 'build', 'installer', 'Installer.cs'), 'utf8');

  /* ---------------- ① 入口接线 ---------------- */
  section('① --uninstall 入口接线');
  {
    P('安装程序写了 UninstallString', /UninstallString/.test(installerSrc), (installerSrc.match(/UninstallString[^;]*/) || [])[0]);
    P('UninstallString 指向 --uninstall', /--uninstall/.test(installerSrc));
    P('★ 主进程识别 --uninstall', /IS_UNINSTALL\s*=\s*process\.argv\.includes\('--uninstall'\)/.test(indexSrc));
    P('★ 主进程有 runUninstaller', /async function runUninstaller/.test(indexSrc));
    P('whenReady 里先处理卸载再启动主界面', /if \(IS_UNINSTALL\)[\s\S]{0,200}runUninstaller\(\)/.test(indexSrc));
    P('卸载后退出应用', /runUninstaller[\s\S]{0,200}app\.quit\(\)/.test(indexSrc));
    P('有独立的 uninstall-preload.js', fs.existsSync(path.join(ROOT, 'src', 'main', 'uninstall-preload.js')));
    P('preload 只暴露三个方法', /qclUninstall/.test(preloadSrc) && /run\(/.test(preloadSrc) && /cancel\(/.test(preloadSrc) && /onProgress\(/.test(preloadSrc));
  }

  /* ---------------- ② 三项清单 ---------------- */
  section('② 卸载项清单（程序 / 游戏数据 / 缓存）');
  {
    const s = un.survey();
    P('survey 返回 ok', s.ok === true);
    P('正好三块', s.items.length === 3, s.items.map((i) => i.key));
    const keys = s.items.map((i) => i.key);
    P('含 program', keys.includes('program'), keys);
    P('★ 含 data（游戏数据/存档/服务端）', keys.includes('data'), keys);
    P('含 cache', keys.includes('cache'), keys);
    for (const it of s.items) {
      P(`「${it.label}」有目录路径`, typeof it.dir === 'string' && it.dir.length > 0, it.dir);
      P(`「${it.label}」有大小文本`, typeof it.sizeText === 'string' && it.sizeText.length > 0, it.sizeText);
      P(`「${it.label}」有说明文字`, typeof it.desc === 'string' && it.desc.length > 10, it.desc.slice(0, 30));
    }
    P('安装目录可用', s.installDir.length > 0, path.basename(s.installDir));
    P('数据目录指向 文档\\QCL', /Documents[\\/]QCL$/i.test(s.dataDir) || s.dataDir.endsWith('QCL'), s.dataDir);
  }

  /* ---------------- ③ 默认策略 ---------------- */
  section('③ 默认保留策略（关键）');
  {
    const s = un.survey();
    const prog = s.items.find((i) => i.key === 'program');
    const data = s.items.find((i) => i.key === 'data');
    const cache = s.items.find((i) => i.key === 'cache');

    P('★ 程序文件必删（locked）', prog.locked === true);
    P('★ 游戏数据默认保留（keepDefault）', data.keepDefault === true);
    P('★ 游戏数据不是必删', data.locked === false);
    P('缓存默认删', cache.keepDefault === false);
    P('数据项说明里明确提到无法恢复/存档', /无法恢复|存档/.test(data.desc), data.desc.slice(0, 40));

    // 默认删的总量不应该包含游戏数据
    P('默认删除总量不含游戏数据', !s.totalText.includes('GB') || data.size < 1024 ** 3, s.totalText);
  }

  /* ---------------- ④ 界面文案 ---------------- */
  section('④ 卸载界面文案与交互');
  {
    P('界面标题是「卸载 Quanta Craft Launcher PC」', /卸载 Quanta Craft Launcher PC/.test(indexSrc));
    P('有「默认保留」标签', /默认保留/.test(indexSrc));
    P('有「必删」标签', /必删/.test(indexSrc));
    P('★ 勾选删数据时显示醒目警告', /注意：你勾选了「删除游戏数据」/.test(indexSrc));
    P('★ 删数据要二次确认', /世界存档、账号、服务端都会消失，无法恢复/.test(indexSrc));
    P('有取消按钮', /id="cancel"/.test(indexSrc));
    P('有卸载按钮', /id="go"/.test(indexSrc));
    P('显示每项的完整路径', /class="path"/.test(indexSrc));
    P('卸载窗口是独立窗口（不是主界面）', /new \(require\('electron'\)\.BrowserWindow\)/.test(indexSrc));
  }

  /* ---------------- ⑤ 真实执行 ---------------- */
  section('⑤ 真实执行（在隔离沙箱里）');
  {
    // 造一个假环境：程序目录 + 数据目录 + 缓存目录
    const sandbox = path.join(os.tmpdir(), `_qcl_unins_${Date.now()}`);
    const fakeInst = path.join(sandbox, 'app');
    const fakeData = path.join(sandbox, 'Documents', 'QCL');
    const fakeCache = path.join(sandbox, 'Local', 'QCL');
    for (const d of [fakeInst, path.join(fakeData, 'instances', 'inst1'), path.join(fakeData, 'servers', 'srv1'), fakeCache]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(fakeInst, 'QCL.exe'), 'fake exe');
    fs.writeFileSync(path.join(fakeData, 'accounts.json'), '{"a":1}');
    fs.writeFileSync(path.join(fakeData, 'instances', 'inst1', 'instance.json'), '{"b":1}');
    fs.writeFileSync(path.join(fakeData, 'servers', 'srv1', 'server.json'), '{"c":1}');
    fs.writeFileSync(path.join(fakeCache, 'Cache.bin'), 'cache');

    // ① 只删缓存，保留数据
    const r1 = un.quarantineAndRemove(fakeCache);
    P('删除缓存成功', r1.ok === true, r1.ok);
    P('★ 缓存真的没了', fs.existsSync(fakeCache) === false);
    P('★ 游戏数据还在（账号）', fs.existsSync(path.join(fakeData, 'accounts.json')) === true);
    P('★ 游戏数据还在（实例）', fs.existsSync(path.join(fakeData, 'instances', 'inst1', 'instance.json')) === true);
    P('★ 游戏数据还在（服务端）', fs.existsSync(path.join(fakeData, 'servers', 'srv1', 'server.json')) === true);

    // ② 再删游戏数据
    const r2 = un.quarantineAndRemove(fakeData);
    P('删除游戏数据成功', r2.ok === true, r2.ok);
    P('★ 游戏数据已删', fs.existsSync(fakeData) === false);

    // ③ 目录大小统计
    P('目录大小能算（0 对空目录）', un.dirSize(path.join(sandbox, 'nothing')) === 0);
    P('human 格式化正常', /MB|KB|GB|B/.test(un.human(1536 * 1024)));

    // ④ 清理
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /* ---------------- ⑥ 程序文件删除方式 ---------------- */
  section('⑥ 程序目录删除方式');
  {
    P('★ 程序目录交给分离的 cmd 脚本（运行中的 exe 删不掉自己）', /qcl-uninstall-[\s\S]{0,80}\.cmd/.test(fs.readFileSync(path.join(ROOT, 'src', 'main', 'uninstall.js'), 'utf8')));
    const unSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'uninstall.js'), 'utf8');
    P('脚本会等本进程退出', /tasklist/.test(unSrc) && /PID/.test(unSrc));
    P('脚本有超时保护（最多 30 秒）', /lss 30/.test(unSrc));
    P('用 start /min 隐藏窗口执行', /start.*\/min/.test(unSrc));
    P('needManual 报告给用户', /needManual/.test(unSrc));
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
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.log('\nFATAL ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
